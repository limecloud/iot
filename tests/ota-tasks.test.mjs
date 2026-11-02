import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, startStack, stop, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { verifyOtaOperation, verifyOtaTask } from '../packages/protocol/ota-tasks.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
test('真实MQTT设备报告到耐久OTA计划/CLI批准，撤销与网关重启恢复，批准不发送安装', { timeout: 60000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  await stop(stack.lamp);
  const device = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'device-lamp', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => device.close());
  const topic = 'limeiot/v1/space-demo/device-lamp'; await device.subscribe(topic + '/down/+');
  let seq, boot, session;
  const revision = vector.request.device.model_revision;
  async function publish(kind, body) {
    return device.publish(topic + '/up/' + kind, JSON.stringify({ v: 1, kind, message_id: randomUUID(), device_id: 'device-lamp', model_revision: revision, boot_id: boot, session_id: session, seq: ++seq, body }));
  }
  async function handshake() {
    seq = 0; boot = randomUUID(); session = null;
    await publish('hello', { challenge: 'ota-fixture-challenge' });
    const welcome = JSON.parse((await device.message()).payload); assert.equal(welcome.kind, 'welcome'); session = welcome.session_id;
    await publish('state', { type: 'snapshot', revision: 1, properties: [
      { path: 'light.power', value: false, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-fixture' },
      { path: 'light.brightness', value: 0, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-fixture' },
    ] });
    await publish('device_info', vector.request.device);
    await until(async () => { const value = (await stack.request(base + '/devices/device-lamp')).value; return value.ready && value.device_info?.fresh; });
  }
  await handshake();
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/ota-tasks.schema.json'), 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  const validateOperation = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/operation' });
  const validateTask = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/task' });
  const input = path.join(stack.directory, 'ota-change.json'), state = path.join(stack.directory, 'cli-state');
  async function cli(args, code = 0) {
    let result; try { result = await exec(process.execPath, ['packages/cli/src/main.mjs', ...args, '--space-id', 'space-demo', '--state-dir', state], { cwd: root, env: stack.env, timeout: 16000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, code, result.stderr); return JSON.parse(result.stdout);
  }
  async function change(body, key, code = 0) {
    await writeFile(input, JSON.stringify(body));
    const value = await cli(['invoke', 'ota-changes.create', '--input', input, '--idempotency-key', key], code);
    const { cli: original, ...operation } = value;
    assert.equal(validateOperation(operation), true, JSON.stringify(validateOperation.errors));
    await verifyOtaOperation(operation, { space_id: 'space-demo', idempotency_key: key, change: body });
    assert.equal((await stat(original.record_file)).mode & 0o777, 0o600);
    return operation;
  }
  const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid' }, body });
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT + base + '/ota-tasks')).status, 401);
  assert.equal((await stack.request('/api/v1/spaces/other/ota-tasks')).status, 403);
  assert.equal((await stack.request(base + '/ota-operations', post('{"type":"tasks.approve","type":"trust.add"}'))).status, 422);
  const trusted = await change({ type: 'trust.add', trust: vector.request.trust, expected_signing_key_id: vector.request.trust.signing_key_id }, 'firmware-trust');
  const trustID = trusted.resource.id;
  assert.equal((await cli(['firmware-trusts', 'list'])).items.length, 1);
  const planBody = { type: 'tasks.plan', device_id: 'device-lamp', trust_id: trustID, manifest: vector.request.manifest, expires_at: new Date(Date.now() + 600000).toISOString() };
  const planned = await change(planBody, 'ota-plan'); const taskID = planned.resource.id;
  assert.equal((await change(planBody, 'ota-plan')).operation_id, planned.operation_id);
  let task = await cli(['ota-tasks', 'get', taskID]); await verifyOtaTask(task); assert.equal(validateTask(task), true, JSON.stringify(validateTask.errors));
  const approveBody = { type: 'tasks.approve', task_id: taskID, expected_revision: task.revision };
  await publish('device_info', vector.request.device);
  const approved = await change(approveBody, 'ota-approve');
  task = await cli(['ota-tasks', 'get', taskID]); assert.equal(task.status, 'approved'); assert.equal(validateTask(task), true, JSON.stringify(validateTask.errors));
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  const control = { device_id: 'device-lamp', model_revision: revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } };
  assert.equal((await stack.request(base + '/commands', post(JSON.stringify(control)))).value.error.code, 'ota_task_conflict');
  const approvedRevision = task.revision;
  await stack.restartGateway();
  task = await cli(['ota-tasks', 'get', taskID]); assert.equal(task.status, 'planned'); assert.equal(task.reason, 'gateway_restarted'); assert.equal(task.approval, null); assert.notEqual(task.revision, approvedRevision);
  assert.equal((await change(approveBody, 'ota-approve')).operation_id, approved.operation_id);
  assert.equal((await cli(['ota-tasks', 'get', taskID])).status, 'planned');
  await handshake();
  await change({ ...approveBody, expected_revision: task.revision }, 'ota-reapprove');
  const trust = await cli(['firmware-trusts', 'get', trustID]);
  await change({ type: 'trust.revoke', trust_id: trustID, expected_revision: trust.revision }, 'ota-revoke');
  task = await cli(['ota-tasks', 'get', taskID]); assert.equal(task.status, 'invalidated'); assert.equal(task.approval, null);
  await stack.restartGateway();
  assert.equal((await cli(['ota-tasks', 'get', taskID])).status, 'invalidated');
  assert.equal((await cli(['firmware-trusts', 'get', trustID])).active, false);
  assert.equal((await cli(['ota-tasks', 'list'])).items.length, 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await writeFile(path.join(stack.directory, 'ota-tasks-result.json'), JSON.stringify({ passed: true, explicit_firmware_trust: true, cli: true, current_mqtt_report: true, sqlite_restart: true, reapproval_required: true, revocation_restored: true, no_device_commands: true, hardware: false, device_installation: false }));
});
test('真实MQTT安装意图先提交，CLI执行仅一次，重启未知只查询，重启健康证据完成原任务', { timeout: 60000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  await stop(stack.lamp);
  const device = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'device-lamp', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => device.close());
  const topic = 'limeiot/v1/space-demo/device-lamp', revision = vector.request.device.model_revision;
  await device.subscribe(topic + '/down/+');
  let seq = 0, boot, session;
  async function publish(kind, body) {
    await device.publish(topic + '/up/' + kind, JSON.stringify({ v: 1, kind, message_id: randomUUID(), device_id: 'device-lamp', model_revision: revision, boot_id: boot, session_id: session, seq: ++seq, body }));
  }
  async function handshake() {
    seq = 0; boot = randomUUID(); session = null;
    await publish('hello', { challenge: 'ota-execution-challenge' });
    const welcome = JSON.parse((await device.message()).payload); assert.equal(welcome.kind, 'welcome'); session = welcome.session_id;
    await publish('state', { type: 'snapshot', revision: 1, properties: [
      { path: 'light.power', value: false, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-fixture' },
      { path: 'light.brightness', value: 0, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-fixture' },
    ] });
    await publish('device_info', vector.request.device);
    await until(async () => (await stack.request(base + '/devices/device-lamp')).value.device_info?.fresh);
  }
  await handshake();
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/ota-tasks.schema.json'), 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  const taskSchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/task' });
  const installSchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/install-envelope' });
  const querySchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/query-envelope' });
  const receiptSchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/receipt-envelope' });
  const input = path.join(stack.directory, 'execute.json'), state = path.join(stack.directory, 'execution-cli');
  async function change(body, key, cli = false) {
    let value;
    if (cli) {
      await writeFile(input, JSON.stringify(body));
      const output = await exec(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'ota-changes.create', '--space-id', 'space-demo', '--idempotency-key', key, '--state-dir', state, '--input', input], { cwd: root, env: stack.env, timeout: 12000 });
      const { cli: record, ...operation } = JSON.parse(output.stdout); assert.ok(record.record_file); value = operation;
    } else {
      const response = await stack.request(base + '/ota-operations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, JSON.stringify(response.value)); value = response.value;
    }
    await verifyOtaOperation(value, { space_id: 'space-demo', idempotency_key: key, change: body });
    return value;
  }
  const trusted = await change({ type: 'trust.add', trust: vector.request.trust, expected_signing_key_id: vector.request.trust.signing_key_id }, 'exec-trust');
  const planned = await change({ type: 'tasks.plan', device_id: 'device-lamp', trust_id: trusted.resource.id, manifest: vector.request.manifest, expires_at: new Date(Date.now() + 600000).toISOString() }, 'exec-plan');
  const taskID = planned.resource.id;
  async function task() {
    const result = (await stack.request(base + '/ota-tasks/' + taskID)).value;
    assert.equal(taskSchema(result), true, JSON.stringify(taskSchema.errors)); await verifyOtaTask(result); return result;
  }
  await change({ type: 'tasks.approve', task_id: taskID, expected_revision: (await task()).revision }, 'exec-approve');
  await assert.rejects(device.message(100), /mqtt_packet_timeout/);
  await publish('device_info', vector.request.device);
  const executeBody = { type: 'tasks.execute', task_id: taskID, expected_revision: (await task()).revision };
  const executed = await change(executeBody, 'exec-install', true);
  const installation = await device.message(); assert.equal(installation.topic, topic + '/down/ota_install');
  const message = JSON.parse(installation.payload);
  assert.equal(installSchema(message), true, JSON.stringify(installSchema.errors));
  assert.equal(message.body.manifest.signing_key_id, vector.request.trust.signing_key_id);
  assert.equal(message.body.trust, undefined);
  const requestDigest = await documentDigest(message);
  // 在设备回执前直接检查独立SQLite连接，证明发送意图已经耐久提交。
  const disk = await exec('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); v,b=c.execute("SELECT version,body FROM snapshot").fetchone(); print(json.dumps({"version":v,"task":json.loads(b)["ota_registry"]["tasks"][sys.argv[2]]}))', stack.env.LIMEIOT_DB, taskID]);
  const saved = JSON.parse(disk.stdout); assert.equal(saved.version, 7); assert.ok(saved.task.execution.attempted_at); assert.equal(saved.task.execution.request_digest, requestDigest);
  assert.equal((await change(executeBody, 'exec-install', true)).operation_id, executed.operation_id);
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  await stack.restartGateway();
  let current = await task(); assert.equal(current.status, 'unknown'); assert.ok(current.approval); assert.equal(current.execution.request_digest, requestDigest);
  assert.equal((await change(executeBody, 'exec-install', true)).operation_id, executed.operation_id);
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  await handshake();
  const control = { device_id: 'device-lamp', model_revision: revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } };
  assert.equal((await stack.request(base + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'during-ota' }, body: JSON.stringify(control) })).value.error.code, 'ota_task_conflict');
  const reconcile = { type: 'tasks.reconcile', task_id: taskID, expected_revision: (await task()).revision };
  await change(reconcile, 'exec-query', true);
  const query = await device.message(); assert.equal(query.topic, topic + '/down/ota_query');
  const queryMessage = JSON.parse(query.payload); assert.equal(querySchema(queryMessage), true, JSON.stringify(querySchema.errors));
  assert.equal(queryMessage.body.request_digest, requestDigest); assert.equal(queryMessage.body.manifest, undefined);
  const body = { task_id: taskID, execution_id: message.body.execution_id, request_digest: requestDigest, manifest_digest: message.body.manifest_digest, status: 'succeeded', firmware_version: vector.request.manifest.statement.version, security_epoch: vector.request.manifest.statement.security_epoch, image_sha256: vector.request.manifest.statement.sha256, pending_update: false, error: null };
  const evidence = { v: 1, kind: 'ota_result', message_id: randomUUID(), device_id: 'device-lamp', model_revision: revision, boot_id: boot, session_id: session, seq: ++seq, body };
  assert.equal(receiptSchema(evidence), true, JSON.stringify(receiptSchema.errors));
  await device.publish(topic + '/up/ota_result', JSON.stringify(evidence));
  await until(async () => (await task()).status === 'succeeded');
  current = await task(); assert.equal(current.execution.receipt.envelope.body.request_digest, requestDigest);
  for (const edit of [value => { value.execution.receipt = null; }, value => { value.execution.request_digest = 'sha256:' + '0'.repeat(64); }, value => { value.execution.receipt.envelope.body.pending_update = true; }, value => { value.execution.receipt.envelope.boot_id = message.boot_id; }]) {
    const forged = structuredClone(current); edit(forged); await assert.rejects(verifyOtaTask(forged));
  }
  await stack.restartGateway();
  assert.equal((await task()).status, 'succeeded');
  assert.equal((await change(executeBody, 'exec-install', true)).operation_id, executed.operation_id);
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await writeFile(path.join(stack.directory, 'ota-execution-result.json'), JSON.stringify({ passed: true, durable_before_publish: true, install_messages: 1, query_messages: 1, cli_original_recovery: true, sqlite_restart_unknown: true, terminal_receipt_restored: true, snapshot_version: 7, hardware: false, device_installation: false }));
});

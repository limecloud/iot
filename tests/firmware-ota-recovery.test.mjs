import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { cloneHost, commands, hash, json, persistentSnapshot, publishFixture } from './support/firmware-recovery.mjs';

const base = '/api/v1/spaces/space-demo', topic = 'limeiot/v1/space-demo/device-lamp';
const binary = process.env.LIMEIOT_ESP_RUNTIME_BINARY;
assert(binary && process.env.LIMEIOT_OTA_RECOVERY_SOURCE, '使用test:firmware:ota-recovery生成本轮维护身份');
const source = await json(process.env.LIMEIOT_OTA_RECOVERY_SOURCE);
const sourceReport = await readFile(path.join(source.directory, 'report.json'));
assert.equal(hash(sourceReport), source.report_sha256);
const proof = JSON.parse(sourceReport);
assert.equal(proof.status, 'passed'); assert.equal(proof.with_ota, false);
assert.equal(proof.real_nas_maintenance, true); assert.equal(proof.after.identity_generation, 1);
const sourceSnapshot = await persistentSnapshot(source.host);
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json')));
const points = [
  ['prepare', 1, null, 'intent'], ['installing', 2, 'intent', 'installing'],
  ['awaiting_boot', 3, 'installing', 'awaiting_boot'], ['bind_boot', 4, 'awaiting_boot', 'awaiting_boot'],
  ['rejected', 2, 'intent', 'rejected'], ['failed', 3, 'installing', 'failed'],
  ['succeeded', 5, 'awaiting_boot', 'succeeded'], ['rolled_back', 5, 'awaiting_boot', 'rolled_back'],
];
let context;
after(async () => { if (context) { context.probe?.close(); await context.stack.close(); } });

async function setup() {
  if (context) return context;
  const directory = await mkdtemp(path.join(root, '.dev/esp-ota-recovery-')), port = await freePort();
  const stack = await startStack({ directory, brokerTls: { port, ca: source.ca, certificate: path.join(source.directory, 'broker-tls/server.crt'), key: path.join(source.directory, 'broker-tls/server.key') } });
  context = { directory, port, stack, cases: [] };
  await stop(stack.lamp);
  context.probe = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'gateway', password: stack.env.LIMEIOT_MQTT_PASSWORD });
  return context;
}

async function launch(folder, phase, mode, workers) {
  const { stack, port } = context;
  const previous = (await stack.request(base + '/devices/device-lamp')).value;
  const child = stack.launch(mode + '-' + phase, binary, [folder, String(port), phase, ...(phase === 'ota-fault' ? [mode] : [])]);
  workers.push(child);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); done.catch(() => {});
  const device = await until(async () => { const value = (await stack.request(base + '/devices/device-lamp')).value; return value.ready && value.boot_id !== previous.boot_id && value; }, 8000);
  return { child, done, device };
}

function noInstallation(value) {
  for (const key of ['ota_stage_calls', 'ota_activate_calls', 'ota_restart_calls', 'ota_results', 'identity_writes']) assert.equal(value[key], 0, key);
}

async function exercise(folder, original, device, blocked) {
  const { probe } = context, before = await json(path.join(folder, 'ota-observed.json'));
  const later = structuredClone(original);
  later.boot_id = device.boot_id; later.session_id = device.session_id;
  later.message_id += '-different'; later.body.execution_id += '-different'; later.body.task_id += '-different';
  await probe.publish(topic + '/down/ota_install', JSON.stringify(original));
  await probe.publish(topic + '/down/ota_install', JSON.stringify(later));
  const query = { v: 1, kind: 'ota_query', message_id: 'original-query', device_id: 'device-lamp', model_revision: device.model_revision, boot_id: device.boot_id, session_id: device.session_id,
    body: { task_id: original.body.task_id, execution_id: original.body.execution_id, manifest_digest: original.body.manifest_digest, request_digest: await documentDigest(original), expires_at: new Date(Date.now() + 20000).toISOString() } };
  await probe.publish(topic + '/down/ota_query', JSON.stringify(query));
  if (blocked) {
    const control = await json(path.join(source.host, 'old-command.json'));
    control.session_id = device.session_id; control.message_id = control.body.command_id = 'ota-conflicting-control';
    control.body.issued_at = new Date().toISOString();
    control.body.expires_at = new Date(Date.now() + 20000).toISOString();
    await probe.publish(topic + '/down/command', JSON.stringify(control));
  }
  const observed = await until(async () => { const value = await json(path.join(folder, 'ota-observed.json')); return value.pending_messages === 0 && value.ota_installs_received === before.ota_installs_received + 2 && value.ota_queries_received === before.ota_queries_received + 1 && value.commands_received === before.commands_received + Number(blocked) && value; });
  noInstallation(observed); assert.equal(observed.process_effects, 0); assert.equal(observed.receipt_writes, 0);
  assert.equal(observed.ota_commit_attempts, before.ota_commit_attempts); assert.equal(observed.ota_writes, before.ota_writes);
  return observed;
}

async function runCase([point, count, previousStage, committedStage], afterWrite) {
  const { directory, stack } = await setup(), mode = `ota-${point}-${afterWrite ? 'after' : 'before'}`;
  const workers = [];
  try {
  const folder = path.join(directory, mode); await cloneHost(source.host, folder);
  const before = await persistentSnapshot(folder), worker = await launch(folder, 'ota-fault', mode, workers);
  const manifest = structuredClone(vector.request.manifest), d = worker.device;
  const original = { v: 1, kind: 'ota_install', message_id: mode, device_id: 'device-lamp', model_revision: d.model_revision, boot_id: d.boot_id, session_id: d.session_id,
    body: { task_id: 'ota-' + point, execution_id: 'execution-' + point, manifest_digest: await documentDigest(manifest), manifest, expires_at: new Date(Date.now() + 60000).toISOString() } };
  await publishFixture(folder, 'ota-request.json', original);
  const fault = await until(async () => json(path.join(folder, 'ota-observed.json')));
  assert.equal(fault.ota_commit_attempts, count); assert.equal(fault.ota_commit_failures, 1);
  assert.equal(fault.ota_writes, count - 1 + Number(afterWrite)); assert.equal(fault.ota_blocked, true); noInstallation(fault);
  const durable = await persistentSnapshot(folder), stage = afterWrite ? committedStage : previousStage;
  for (const [name, digest] of Object.entries(before)) assert.equal(durable[name], digest, mode + '/' + name);
  const persisted = stage && await json(path.join(folder, 'nvs-2-state.json'));
  if (stage) {
    assert.deepEqual(persisted.records[0].request, original); assert.equal(persisted.records[0].stage, stage);
    assert.deepEqual(persisted.records[0].baseline, { firmware_version: '0.2.0', security_epoch: 0, image_sha256: 'sha256:' + 'a'.repeat(64) });
    assert.equal(persisted.records[0].boot_binding, (point === 'bind_boot' && afterWrite) || ['succeeded', 'rolled_back'].includes(point) ? 'fixture-boot-binding' : null);
  } else assert(!('nvs-2-state.json' in durable));
  const beforeError = await json(path.join(folder, 'ota-before-error.json'));
  if (previousStage) { assert.equal(beforeError.records[0].stage, previousStage); assert.deepEqual(beforeError.records[0].request, original); }
  else assert.equal(beforeError, null);
  if (!afterWrite && stage) assert.deepEqual(beforeError, persisted);
  if (afterWrite) assert.notDeepEqual(beforeError, persisted);
  const duplicate = await exercise(folder, original, d, true);
  await writeFile(path.join(folder, 'disconnect'), 'disconnect\n');
  const reconnected = await until(async () => { const value = await json(path.join(folder, 'ota-observed.json')); return value.ready && value.connects === 2 && value; }, 9000);
  const current = (await stack.request(base + '/devices/device-lamp')).value;
  assert.notEqual(current.session_id, d.session_id);
  const afterReconnect = await exercise(folder, original, current, true);
  assert.equal(afterReconnect.ota_commit_failures, 1); assert.deepEqual(await persistentSnapshot(folder), durable);
  await stop(worker.child); assert.deepEqual(await worker.done, { code: 0, signal: null });
  const reopened = folder + '-reopen'; await cloneHost(folder, reopened); await cp(path.join(folder, 'ota-request.json'), path.join(reopened, 'ota-request.json'));
  const next = await launch(reopened, 'ota-check', mode, workers);
  const recovery = await until(async () => json(path.join(reopened, 'ota-recovery-check.json')));
  const blocked = ['intent', 'installing', 'awaiting_boot'].includes(stage);
  assert.equal(recovery.code, stage ? 'ok' : 'ignored'); assert.equal(recovery.blocked, blocked);
  if (stage) {
    assert.equal(recovery.stage, stage); assert.equal(recovery.recovered, blocked);
    assert.equal(recovery.request_digest, await documentDigest(original));
    assert.equal(recovery.boot_binding, persisted.records[0].boot_binding ?? '');
  }
  await until(() => json(path.join(reopened, 'ota-observed.json')));
  const queries = await exercise(reopened, original, next.device, blocked);
  assert.deepEqual(await persistentSnapshot(reopened), durable);
  await context.probe.publish(topic + '/down/command', await readFile(path.join(source.host, 'old-command.json'), 'utf8'));
  const stale = await until(async () => { const value = await json(path.join(reopened, 'ota-observed.json')); return value.pending_messages === 0 && value.commands_received === queries.commands_received + 1 && value; });
  assert.equal(stale.process_effects, 0); assert.equal(stale.receipt_writes, 0);
  if (!blocked) {
    const fresh = await commands(stack, reopened)(mode + '-new-control', 'applied', true);
    await until(async () => (await stack.request(base + '/commands/' + fresh.command_id)).value.status === 'confirmed');
  }
  await stop(next.child); assert.deepEqual(await next.done, { code: 0, signal: null });
  const final = await json(path.join(reopened, 'ota-observed.json')); noInstallation(final);
  assert.equal(final.process_effects, Number(!blocked)); assert.equal(final.ota_writes, 0); assert.equal(final.ota_commit_attempts, 0);
  assert.equal((await persistentSnapshot(reopened))['nvs-2-state.json'], durable['nvs-2-state.json']);
  assert.deepEqual(await persistentSnapshot(source.host), sourceSnapshot);
  context.cases.push({ mode, stage, fault, duplicate, reconnected, after_reconnect: afterReconnect, recovery, queries, final, original_request_sha256: await documentDigest(original), durable_sha256: durable, gateway_sqlite_reopened: false, actual_installation: false });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: context.cases.length === 16 ? 'passed' : 'in_progress', scope: 'post-maintenance-ota-commit-failures', source_report: path.relative(root, path.join(source.directory, 'report.json')), source_report_sha256: source.report_sha256, cases: context.cases, same_process_identity_tls: true, fixtures: ['file-nvs', 'freertos', 'running-baseline', 'terminal-outcome', 'unavailable-installation-ports'], actual_installation: false, esp_mqtt_runtime: false, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  } finally {
    await Promise.all(workers.map(stop));
  }
}

for (let group = 0; group < 4; group++) {
  const pair = points.slice(group * 2, group * 2 + 2);
  test(`换证后OTA日志提交故障：${pair.map(p => p[0]).join(' / ')}`, { timeout: 60000 }, async t => {
    for (const point of pair) for (const afterWrite of [false, true]) await runCase(point, afterWrite);
    t.diagnostic('证据目录：' + context.directory);
  });
}

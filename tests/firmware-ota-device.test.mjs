import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { createHash, createPrivateKey, sign, randomUUID } from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vector.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
const schema = JSON.parse(await readFile(path.join(root, 'contracts/ota-tasks.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
const receiptSchema = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/receipt-envelope' });
const base = '/api/v1/spaces/space-demo', topic = 'limeiot/v1/space-demo/device-lamp';
const runningHash = 'sha256:' + createHash('sha256').update('LimeIoT host running image fixture\n').digest('hex');
function manifest(statement = {}) {
  const value = structuredClone(vector.request.manifest);
  value.statement.target = { product_id: 'desk-node-lamp-host', architecture: 'native', chip: 'host', board: 'host-fixture', hardware_revisions: ['host-fixture'] };
  value.statement.compatibility.minimum_bootloader_version = '0.0.1';
  Object.assign(value.statement, statement);
  delete value.signature;
  value.signature = sign(null, Buffer.from('LimeIoT Device Firmware v1\n' + canonicalJSON(value)), privateKey).toString('base64'); return value;
}
async function setup(t, env = {}, statement = {}) {
  const directory = path.join(root, '.dev', 'ota-device-' + randomUUID()); await mkdir(directory);
  const trust = structuredClone(vector.request.trust); trust.product_ids = ['desk-node-lamp-host'];
  if (statement.download) trust.download_origins = [new URL(statement.download.url).origin];
  const policy = path.join(directory, 'policy.json'); await writeFile(policy, JSON.stringify(trust));
  const stack = await startStack({ directory, firmware: true, gatewayEnv: { LIMEIOT_FIRMWARE_OTA_POLICY: policy, ...env } }); t.after(() => stack.close());
  const probe = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'gateway', password: stack.env.LIMEIOT_MQTT_PASSWORD });
  t.after(() => probe.close()); await probe.subscribe(topic + '/up/ota_result');
  const current = async () => (await stack.request(base + '/devices/device-lamp')).value;
  async function install(index = 1) {
    const device = await current(), image = manifest(statement);
    return { v: 1, kind: 'ota_install', message_id: 'install-' + index, device_id: 'device-lamp', model_revision: device.model_revision,
      boot_id: device.boot_id, session_id: device.session_id, body: { task_id: 'ota-device-' + index, execution_id: 'execution-' + index,
        manifest_digest: await documentDigest(image), manifest: image, expires_at: new Date(Date.now() + 20000).toISOString() } };
  }
  async function query(original, change = () => {}) {
    const device = await current();
    const value = { v: 1, kind: 'ota_query', message_id: randomUUID(), device_id: 'device-lamp', model_revision: device.model_revision,
      boot_id: device.boot_id, session_id: device.session_id, body: { task_id: original.body.task_id, execution_id: original.body.execution_id,
        request_digest: await documentDigest(original), manifest_digest: original.body.manifest_digest, expires_at: new Date(Date.now() + 20000).toISOString() } };
    change(value); return value;
  }
  async function publish(value, suffix = value.kind) { await probe.publish(topic + '/down/' + suffix, typeof value === 'string' ? value : JSON.stringify(value)); }
  async function receipt(original) {
    const packet = await probe.message(), value = JSON.parse(packet.payload);
    assert.equal(packet.topic, topic + '/up/ota_result'); assert.equal(receiptSchema(value), true, JSON.stringify(receiptSchema.errors));
    assert.equal(value.body.request_digest, await documentDigest(original)); assert.equal(value.body.manifest_digest, original.body.manifest_digest);
    assert.equal(value.body.execution_id, original.body.execution_id); assert.equal(value.body.image_sha256, runningHash);
    assert.equal(value.body.pending_update, false); assert.equal(value.body.firmware_version, '0.1.0'); assert.equal(value.body.security_epoch, 0);
    return value;
  }
  const journal = path.join(directory, 'firmware-lamp/ota.json');
  return { stack, probe, trust, policy, current, install, query, publish, receipt, journal };
}
test('C设备经真实MQTT拒绝非法安装，耐久拒绝有效请求，重复与当前会话原查询不重写日志', { timeout: 30000 }, async t => {
  const x = await setup(t), original = await x.install();
  const changes = [r => { r.seq = 1; }, r => { r.boot_id = 'wrong'; }, r => { r.session_id = 'wrong'; },
    r => { r.device_id = 'other'; }, r => { r.model_revision = 'sha256:' + 'a'.repeat(64); },
    r => { r.body.extra = true; }, r => { r.body.manifest_digest = runningHash; },
    r => { r.body.expires_at = '2026-01-01T00:00:00Z'; }];
  for (const change of changes) { const value = structuredClone(original); change(value); await x.publish(value); }
  const tampered = structuredClone(original); tampered.body.manifest.statement.version = '0.3.0'; tampered.body.manifest_digest = await documentDigest(tampered.body.manifest);
  await x.publish(tampered); await x.publish(original, 'command');
  await x.publish(JSON.stringify(original).replace('"v":1', '"v":1,"v":1'), 'ota_install');
  await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/); await assert.rejects(readFile(x.journal), { code: 'ENOENT' });
  await x.publish(original); const first = await x.receipt(original);
  assert.equal(first.body.status, 'rejected'); assert.equal(first.body.error, 'ota_device_busy');
  const saved = await readFile(x.journal, 'utf8'), value = JSON.parse(saved), { checksum, ...unsigned } = value;
  assert.equal(checksum, await documentDigest(unsigned)); assert.deepEqual(value.records[0].request, original); assert.equal(value.records[0].stage, 'rejected');
  await x.publish(Object.fromEntries(Object.entries(original).reverse())); const duplicate = await x.receipt(original);
  assert.deepEqual(duplicate.body, first.body); assert.ok(duplicate.seq > first.seq); assert.equal(await readFile(x.journal, 'utf8'), saved);
  const changed = structuredClone(original); changed.message_id = 'different'; await x.publish(changed);
  for (const change of [r => { r.body.request_digest = runningHash; }, r => { r.body.manifest_digest = runningHash; },
    r => { r.body.execution_id = 'not-found'; }, r => { r.body.expires_at = new Date(Date.now() - 1000).toISOString(); },
    r => { r.body.expires_at = new Date(Date.now() + 60000).toISOString(); }, r => { r.boot_id = 'old'; }]) await x.publish(await x.query(original, change));
  await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/); assert.equal(await readFile(x.journal, 'utf8'), saved);
  const oldQuery = await x.query(original); await x.stack.restartDevice('lamp');
  await x.publish(oldQuery); await x.publish(original); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
  await x.publish(await x.query(original)); const restored = await x.receipt(original);
  assert.equal(restored.boot_id, (await x.current()).boot_id); assert.notEqual(restored.boot_id, original.boot_id); assert.deepEqual(restored.body, first.body);
  assert.equal(await readFile(x.journal, 'utf8'), saved);
  x.trust.revoked_artifact_ids = [original.body.manifest.statement.artifact_id]; await writeFile(x.policy, JSON.stringify(x.trust));
  await x.stack.restartDevice('lamp'); await x.publish(await x.query(original)); assert.deepEqual((await x.receipt(original)).body, first.body);
  const revoked = await x.install(2); await x.publish(revoked); assert.equal((await x.receipt(revoked)).body.error, 'ota_artifact_revoked');
  const latest = await readFile(x.journal, 'utf8');
  for (const fault of ['unavailable', 'changed', 'pending']) {
    await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_RUNNING_FAULT: fault }); await x.publish(await x.query(original));
    await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/); assert.equal(await readFile(x.journal, 'utf8'), latest);
  }
});

test('真实网关计划批准到C设备耐久拒绝安装提供方，任务终态及原请求跨SQLite重启一致', { timeout: 30000 }, async t => {
  const x = await setup(t, { LIMEIOT_FIRMWARE_OTA_ELIGIBLE: '1' });
  const change = async (body, key) => {
    const response = await x.stack.request(base + '/ota-operations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, JSON.stringify(response.value)); assert.equal(response.value.status, 'applied', JSON.stringify(response.value)); return response.value;
  };
  await until(async () => (await x.current()).device_info?.fresh);
  const trust = await change({ type: 'trust.add', trust: x.trust, expected_signing_key_id: x.trust.signing_key_id }, 'device-trust');
  const planned = await change({ type: 'tasks.plan', device_id: 'device-lamp', trust_id: trust.resource.id, manifest: manifest(), expires_at: new Date(Date.now() + 600000).toISOString() }, 'device-plan');
  const task = async () => (await x.stack.request(base + '/ota-tasks/' + planned.resource.id)).value;
  await change({ type: 'tasks.approve', task_id: planned.resource.id, expected_revision: (await task()).revision }, 'device-approve');
  const execute = { type: 'tasks.execute', task_id: planned.resource.id, expected_revision: (await task()).revision };
  const operation = await change(execute, 'device-execute');
  const terminal = await until(async () => { const value = await task(); return value.status === 'failed' && value; });
  assert.equal(terminal.reason, 'ota_installer_unavailable'); const original = terminal.execution.envelope;
  const evidence = await x.receipt(original); assert.equal(evidence.body.error, terminal.reason); assert.equal(evidence.body.status, 'rejected');
  assert.deepEqual(JSON.parse(await readFile(x.journal, 'utf8')).records[0].request, original);
  const saved = await readFile(x.journal, 'utf8'); assert.equal((await change(execute, 'device-execute')).operation_id, operation.operation_id);
  await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/); assert.equal(await readFile(x.journal, 'utf8'), saved);
  await x.stack.restartGateway(); assert.equal((await task()).status, 'failed'); assert.equal((await task()).reason, terminal.reason);
  assert.equal((await x.stack.request(base + '/commands')).value.items.length, 0);
  await writeFile(path.join(x.stack.directory, 'ota-device-result.json'), JSON.stringify({ passed: true, c_device_receiver: true, actual_mqtt: true, rust_gateway: true,
    sqlite_terminal_recovery: true, original_envelope: true, durable_rejection: true, hardware: false, device_installation: false }));
});

test('C设备日志终态写入失败与丢上行保持原状态，重启查询不补装', { timeout: 30000 }, async t => {
  const x = await setup(t, { LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '2' }), original = await x.install();
  await x.publish(original); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
  const saved = await readFile(x.journal, 'utf8'); assert.equal(JSON.parse(saved).records[0].stage, 'intent');
  await x.publish(await x.query(original)); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
  await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '0' });
  await x.publish(await x.query(original)); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
  await x.publish(await x.install(2)); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/); assert.equal(await readFile(x.journal, 'utf8'), saved);
  const current = await x.current();
  await x.publish({ v: 1, kind: 'command', message_id: 'control-during-unknown', device_id: 'device-lamp', model_revision: current.model_revision,
    session_id: current.session_id, body: { command_id: 'control-blocked-by-ota', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 5000).toISOString(),
      operation: { type: 'property.set', path: 'light.power', value: true } } }, 'command');
  await assert.rejects(readFile(path.join(x.stack.directory, 'firmware-lamp/hardware.json')), { code: 'ENOENT' });
  const y = await setup(t, { LIMEIOT_FIRMWARE_DROP_OTA_RESULTS: '1' }), lost = await y.install();
  await y.publish(lost); await assert.rejects(y.probe.message(150), /mqtt_packet_timeout/);
  const durable = await readFile(y.journal, 'utf8'); assert.equal(JSON.parse(durable).records[0].stage, 'rejected');
  await y.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_DROP_OTA_RESULTS: '0' }); await y.publish(await y.query(lost));
  assert.equal((await y.receipt(lost)).body.status, 'rejected'); assert.equal(await readFile(y.journal, 'utf8'), durable);
});


async function installSource(t) {
  const directory = path.join(root, '.dev', 'ota-installer-source-' + randomUUID()); await mkdir(directory);
  const exec = promisify(execFile), openssl = args => exec('openssl', args, { cwd: directory, timeout: 10000 });
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=LimeIoT installer test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(path.join(directory, 'ext.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'ext.cnf']);
  const image = Buffer.alloc(65537, 0x5a), requests = [];
  const server = createServer({ key: await readFile(path.join(directory, 'server.key')), cert: await readFile(path.join(directory, 'server.crt')) }, (req, res) => {
    requests.push(req.url);
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); }
    else if (req.url === '/corrupt') res.end(Buffer.alloc(image.length, 1));
    else res.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let index = 0;
  async function device(fault = '', env = {}, route = '/ok') {
    const options = path.join(directory, 'source-' + ++index + '.json'); await writeFile(options, JSON.stringify({ ca: path.join(directory, 'ca.crt'), fault }));
    const x = await setup(t, { LIMEIOT_FIRMWARE_OTA_ELIGIBLE: '1', LIMEIOT_FIRMWARE_OTA_SOURCE: options, ...env },
      { download: { url: 'https://localhost:' + server.address().port + route, redirects: false }, size_bytes: image.length, sha256: 'sha256:' + createHash('sha256').update(image).digest('hex') });
    x.audit = async () => (await readFile(path.join(x.stack.directory, 'firmware-lamp/installer.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    x.next = async original => {
      const value = JSON.parse((await x.probe.message()).payload);
      assert.equal(receiptSchema(value), true, JSON.stringify(receiptSchema.errors));
      assert.equal(value.body.request_digest, await documentDigest(original)); assert.equal(value.body.manifest_digest, original.body.manifest_digest);
      assert.equal(value.body.image_sha256, runningHash); return value;
    };
    return x;
  }
  return { device, image, requests };
}
test('C安装器经MQTT和真实HTTPS先耐久安装，再回读校验与耐久激活，重复/重启不补装', { timeout: 30000 }, async t => {
  const source = await installSource(t), x = await source.device(), candidate = await x.install();
  const change = async (body, key) => {
    const result = await x.stack.request(base + '/ota-operations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    assert.equal(result.status, 200, JSON.stringify(result.value)); assert.equal(result.value.status, 'applied', JSON.stringify(result.value)); return result.value;
  };
  await until(async () => (await x.current()).device_info?.fresh);
  const trusted = await change({ type: 'trust.add', trust: x.trust, expected_signing_key_id: x.trust.signing_key_id }, 'installer-trust');
  const planned = await change({ type: 'tasks.plan', device_id: 'device-lamp', trust_id: trusted.resource.id, manifest: candidate.body.manifest, expires_at: new Date(Date.now() + 600000).toISOString() }, 'installer-plan');
  const task = async () => (await x.stack.request(base + '/ota-tasks/' + planned.resource.id)).value;
  await change({ type: 'tasks.approve', task_id: planned.resource.id, expected_revision: (await task()).revision }, 'installer-approve');
  await change({ type: 'tasks.execute', task_id: planned.resource.id, expected_revision: (await task()).revision }, 'installer-execute');
  const executing = await until(async () => { const value = await task(); return value.execution?.receipt?.envelope?.body?.status === 'awaiting_boot' && value; });
  assert.equal(executing.status, 'executing'); const original = executing.execution.envelope;
  assert.equal((await x.next(original)).body.status, 'installing'); assert.equal((await x.next(original)).body.status, 'awaiting_boot');
  assert.deepEqual(await readFile(path.join(x.stack.directory, 'firmware-lamp/staged.bin')), source.image);
  const audit = await x.audit(); assert.deepEqual(audit.map(v => v.event), ['stage', 'activate', 'selected', 'restart']);
  assert.deepEqual(audit.map(v => v.journal.records[0].stage), ['installing', 'awaiting_boot', 'awaiting_boot', 'awaiting_boot']);
  const saved = await readFile(x.journal, 'utf8');
  await x.publish(original); assert.equal((await x.next(original)).body.status, 'awaiting_boot');
  await x.publish(await x.query(original)); assert.equal((await x.next(original)).body.status, 'awaiting_boot');
  assert.equal(source.requests.length, 1); assert.deepEqual(await x.audit(), audit); assert.equal(await readFile(x.journal, 'utf8'), saved);
  await x.stack.restartDevice('lamp'); await x.publish(await x.query(original));
  await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
  assert.equal(source.requests.length, 1); assert.deepEqual(await x.audit(), audit); assert.equal(await readFile(x.journal, 'utf8'), saved);
  await x.stack.restartGateway(); assert.equal((await task()).status, 'unknown');
  assert.equal(source.requests.length, 1); assert.deepEqual(await x.audit(), audit);
  x.trust.revoked_artifact_ids = [original.body.manifest.statement.artifact_id]; await writeFile(x.policy, JSON.stringify(x.trust));
  await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_BOOT: 'target' });
  const succeeded = await until(async () => { const value = await task(); return value.status === 'succeeded' && value; });
  assert.equal(succeeded.execution.receipt.envelope.body.image_sha256, original.body.manifest.statement.sha256);
  assert.notEqual(succeeded.execution.receipt.envelope.boot_id, original.boot_id);
  assert.equal(JSON.parse(await readFile(x.journal, 'utf8')).records[0].stage, 'succeeded');
  assert.equal(source.requests.length, 1); assert.deepEqual(await x.audit(), audit);
  await x.stack.restartGateway(); assert.equal((await task()).status, 'succeeded');
});
test('C安装器的HTTP/镜像/存储失败与失去授权不选择启动，不把暂存当成安装完成', { timeout: 45000 }, async t => {
  const source = await installSource(t);
  for (const [fault, route, reason] of [
    ['', '/redirect', 'ota_http_response_rejected'], ['', '/corrupt', 'ota_image_hash_mismatch'],
    ['write', '/ok', 'ota_staging_write_failed'], ['finish', '/ok', 'ota_native_image_rejected'],
    ['verify', '/ok', 'ota_staging_read_failed'], ['unverified', '/ok', 'ota_staging_unverified'],
    ['disconnect-stage', '/ok', 'ota_install_authorization_lost'],
    ...['disconnect-read', 'power-read', 'clock-read', 'revoke-read'].map(fault => [fault, '/ok', 'ota_transfer_authorization_lost']),
  ]) {
    const x = await source.device(fault, {}, route), original = await x.install(); await x.publish(original);
    assert.equal((await x.next(original)).body.status, 'installing');
    const failed = await x.next(original); assert.equal(failed.body.status, 'failed'); assert.equal(failed.body.error, reason);
    assert.deepEqual((await x.audit()).map(v => v.event), ['stage']);
    const saved = await readFile(x.journal, 'utf8'); await x.publish(original);
    assert.equal((await x.next(original)).body.status, 'failed'); assert.equal(await readFile(x.journal, 'utf8'), saved);
  }
  assert.equal(source.requests.filter(v => v === '/redirect').length, 1);
});
test('C安装器的耐久日志门禁失败及激活结果不明停止推进，重启不重放', { timeout: 45000 }, async t => {
  const source = await installSource(t);
  for (const count of ['1', '2', '3']) {
    const x = await source.device('', { LIMEIOT_FIRMWARE_OTA_FAIL_STORE: count }), original = await x.install(), before = source.requests.length;
    await x.publish(original);
    if (count === '3') assert.equal((await x.next(original)).body.status, 'installing');
    await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
    assert.equal(source.requests.length - before, count === '3' ? 1 : 0);
    if (count === '1') await assert.rejects(readFile(x.journal), { code: 'ENOENT' });
    else {
      const saved = await readFile(x.journal, 'utf8'); assert.equal(JSON.parse(saved).records[0].stage, count === '2' ? 'intent' : 'installing');
      if (count === '3') assert.deepEqual((await x.audit()).map(v => v.event), ['stage']);
      await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '0' });
      await x.publish(await x.query(original)); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
      assert.equal(await readFile(x.journal, 'utf8'), saved); assert.equal(source.requests.length - before, count === '3' ? 1 : 0);
    }
  }
  {
    const x = await source.device('', { LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '3', LIMEIOT_FIRMWARE_OTA_FAIL_AFTER_STORE: '1' }), original = await x.install();
    await x.publish(original); assert.equal((await x.next(original)).body.status, 'installing');
    await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
    const saved = await readFile(x.journal, 'utf8'); assert.equal(JSON.parse(saved).records[0].stage, 'awaiting_boot');
    const audit = await x.audit(); assert.deepEqual(audit.map(v => v.event), ['stage']);
    await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '0' });
    await x.publish(await x.query(original)); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
    assert.deepEqual(await x.audit(), audit); assert.equal(await readFile(x.journal, 'utf8'), saved);
  }
  for (const fault of ['activation-before', 'activation-after']) {
    const x = await source.device(fault), original = await x.install(); await x.publish(original);
    assert.equal((await x.next(original)).body.status, 'installing'); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
    const saved = await readFile(x.journal, 'utf8'); assert.equal(JSON.parse(saved).records[0].stage, 'awaiting_boot');
    const audit = await x.audit(); assert.deepEqual(audit.map(v => v.event), fault === 'activation-before' ? ['stage', 'activate'] : ['stage', 'activate', 'selected']);
    await x.publish(original); assert.equal((await x.next(original)).body.status, 'awaiting_boot');
    await x.stack.restartDevice('lamp'); await x.publish(await x.query(original)); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
    assert.deepEqual(await x.audit(), audit); assert.equal(await readFile(x.journal, 'utf8'), saved);
  }
});


async function stagedDevice(source, fault = '', env = {}) {
  const x = await source.device(fault, env), original = await x.install(); await x.publish(original);
  assert.equal((await x.next(original)).body.status, 'installing');
  if (!env.LIMEIOT_FIRMWARE_OTA_FAIL_STORE) assert.equal((await x.next(original)).body.status, 'awaiting_boot');
  return { x, original };
}
async function bootReceipt(x, original, status) {
  const value = JSON.parse((await x.probe.message()).payload); assert.equal(receiptSchema(value), true, JSON.stringify(receiptSchema.errors));
  assert.equal(value.body.status, status); assert.equal(value.body.request_digest, await documentDigest(original));
  assert.notEqual(value.boot_id, original.boot_id); assert.equal(value.body.pending_update, false); return value;
}
test('C新启动按原清单完整长度证明成功，待确认/相同基线不推断回滚，查询核对当前实际字节', { timeout: 45000 }, async t => {
  const source = await installSource(t), { x, original } = await stagedDevice(source);
  const saved = await readFile(x.journal, 'utf8'); assert.ok(JSON.parse(saved).records[0].boot_binding);
  await x.stack.restartDevice('lamp'); await x.publish(await x.query(original));
  await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/); assert.equal(await readFile(x.journal, 'utf8'), saved);
  await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_BOOT: 'pending' });
  await x.publish(await x.query(original)); await assert.rejects(x.probe.message(1200), /mqtt_packet_timeout/);
  assert.equal(await readFile(x.journal, 'utf8'), saved);
  await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_BOOT: 'target-native-prefix' });
  const result = await bootReceipt(x, original, 'succeeded'); assert.equal(result.body.image_sha256, original.body.manifest.statement.sha256);
  assert.notEqual(result.body.image_sha256, runningHash);
  const terminal = await readFile(x.journal, 'utf8');
  const bytes = await readFile(path.join(x.stack.directory, 'firmware-lamp/staged.bin')); bytes[0] ^= 1;
  await writeFile(path.join(x.stack.directory, 'firmware-lamp/staged.bin'), bytes);
  await x.publish(await x.query(original)); await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
  assert.equal(await readFile(x.journal, 'utf8'), terminal); assert.equal(source.requests.length, 1);
});
test('C回滚必须有独立本机选择凭据及精确基线，旧凭据和坏镜像保持未知', { timeout: 45000 }, async t => {
  const source = await installSource(t), { x, original } = await stagedDevice(source);
  const selectionFile = path.join(x.stack.directory, 'firmware-lamp/boot-selection.json'), selected = JSON.parse(await readFile(selectionFile, 'utf8'));
  const saved = await readFile(x.journal, 'utf8'); await writeFile(selectionFile, JSON.stringify({ ...selected, binding: 'stale_binding' }));
  await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_BOOT: 'rollback' });
  await x.publish(await x.query(original)); await assert.rejects(x.probe.message(1200), /mqtt_packet_timeout/); assert.equal(await readFile(x.journal, 'utf8'), saved);
  await writeFile(selectionFile, JSON.stringify(selected));
  const result = await bootReceipt(x, original, 'rolled_back'); assert.equal(result.body.image_sha256, runningHash);
  assert.equal(result.body.error, 'ota_boot_rolled_back'); assert.equal(JSON.parse(await readFile(x.journal, 'utf8')).records[0].stage, 'rolled_back');
  assert.equal(source.requests.length, 1);
});
test('C启动凭据及结果提交前后故障保持实际耐久状态，结果丢失可原查询恢复且不重新安装', { timeout: 60000 }, async t => {
  const source = await installSource(t);
  for (const after of ['0', '1']) {
    const { x, original } = await stagedDevice(source, '', { LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '4', LIMEIOT_FIRMWARE_OTA_FAIL_AFTER_STORE: after });
    await assert.rejects(x.probe.message(150), /mqtt_packet_timeout/);
    const saved = await readFile(x.journal, 'utf8'); assert.equal(!!JSON.parse(saved).records[0].boot_binding, after === '1');
    assert.deepEqual((await x.audit()).map(v => v.event), ['stage', 'activate', 'selected']);
    await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_BOOT: 'target', LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '0' });
    if (after === '1') await bootReceipt(x, original, 'succeeded');
    else { await x.publish(await x.query(original)); await assert.rejects(x.probe.message(1200), /mqtt_packet_timeout/); assert.equal(await readFile(x.journal, 'utf8'), saved); }
  }
  for (const after of ['0', '1']) {
    const { x, original } = await stagedDevice(source), audit = await x.audit();
    await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_BOOT: 'target', LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '1', LIMEIOT_FIRMWARE_OTA_FAIL_AFTER_STORE: after });
    await assert.rejects(x.probe.message(1200), /mqtt_packet_timeout/);
    const saved = JSON.parse(await readFile(x.journal, 'utf8')); assert.equal(saved.records[0].stage, after === '1' ? 'succeeded' : 'awaiting_boot');
    await x.stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_OTA_BOOT: 'target', LIMEIOT_FIRMWARE_OTA_FAIL_STORE: '0', LIMEIOT_FIRMWARE_DROP_OTA_RESULTS: after === '0' ? '1' : '0' });
    if (after === '0') {
      await until(async () => JSON.parse(await readFile(x.journal, 'utf8')).records[0].stage === 'succeeded');
    }
    await x.publish(await x.query(original)); await bootReceipt(x, original, 'succeeded');
    assert.deepEqual(await x.audit(), audit);
  }
});

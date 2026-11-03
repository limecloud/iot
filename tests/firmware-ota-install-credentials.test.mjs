import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { createHash, createPrivateKey, sign, randomUUID, X509Certificate } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile), binary = process.env.LIMEIOT_ESP_INSTALL_BINARY;
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const base = '/api/v1/spaces/space-demo', topic = 'limeiot/v1/space-demo/device-lamp';
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json')));
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vector.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
const schema = JSON.parse(await readFile(path.join(root, 'contracts/ota-tasks.schema.json')));
const validReceipt = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/receipt-envelope' });
const image = Buffer.alloc(65537); for (let i = 0; i < image.length; i++) image[i] = (i * 29 + 7) % 251;
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const baselineHash = digest('LimeIoT complete installer baseline fixture\n');
const json = async file => JSON.parse(await readFile(file));
let directory, server, origin;
const requests = [], results = [];
const allScenarios = [
  ['valid', 'none'], ['leaf', 'read'], ['ca', 'verify'],
  ...['read', 'write', 'verify', 'staged', 'awaiting', 'selected', 'activated', 'bind-before', 'bind-after'].map(checkpoint => ['clock', checkpoint]),
];
const group = process.env.LIMEIOT_OTA_INSTALL_GROUP ?? 'all';
assert(['all', 'transfer', 'staging', 'activation'].includes(group), '未知安装凭据检查组');
const scenarios = allScenarios.filter(([credential, checkpoint]) => group === 'all' || (group === 'transfer' ? credential !== 'clock' : group === 'staging' ? ['read', 'write', 'verify', 'staged'].includes(checkpoint) && credential === 'clock' : ['awaiting', 'selected', 'activated', 'bind-before', 'bind-after'].includes(checkpoint)));
before(async () => {
  assert(binary, '使用test:firmware:ota-install-credentials构建当前输入');
  directory = await mkdtemp(path.join(root, '.dev/ota-install-credentials-cases-'));
  const openssl = args => exec('openssl', args, { cwd: directory, timeout: 10000 });
  await openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'download-ca.key', '-out', 'download-ca.crt', '-days', '2', '-subj', '/CN=Independent OTA download CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(path.join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'download-ca.crt', '-CAkey', 'download-ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'server.ext']);
  server = createServer({ key: await readFile(path.join(directory, 'server.key')), cert: await readFile(path.join(directory, 'server.crt')) }, (request, response) => {
    requests.push({ path: request.url, method: request.method, headers: request.headers });
    response.setHeader('Content-Length', image.length); response.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'https://localhost:' + server.address().port;
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });

async function envelope(device, manifest, name) {
  return { v: 1, kind: 'ota_install', message_id: 'install-' + name, device_id: 'device-lamp', model_revision: device.model_revision,
    boot_id: device.boot_id, session_id: device.session_id, body: { task_id: 'ota-task-' + name, execution_id: 'execution-' + name,
      manifest_digest: await documentDigest(manifest), manifest, expires_at: new Date(Date.now() + 29000).toISOString() } };
}
async function receipts(probe, original) {
  const found = [];
  for (;;) {
    let packet;
    try { packet = await probe.message(100); } catch (error) { if (error.message === 'mqtt_packet_timeout') break; throw error; }
    const value = JSON.parse(packet.payload);
    assert.equal(validReceipt(value), true, JSON.stringify(validReceipt.errors));
    assert.equal(value.body.request_digest, await documentDigest(original));
    assert.equal(value.body.manifest_digest, original.body.manifest_digest);
    assert.equal(value.body.execution_id, original.body.execution_id);
    assert.equal(value.body.image_sha256, baselineHash); assert.equal(value.body.firmware_version, '0.2.0');
    assert.equal(value.body.security_epoch, 0); assert.equal(value.body.pending_update, false); found.push(value);
  }
  return found;
}
async function snapshot(host) {
  const names = (await readdir(host)).filter(name => /^nvs-/.test(name) || ['spare.bin', 'selection.json'].includes(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, digest(await readFile(path.join(host, name)))])));
}
for (const [credential, checkpoint] of scenarios) test(`生产worker与完整安装消费者跨失权：${credential}/${checkpoint}，原任务重开不补装`, { timeout: 45000 }, async t => {
  const name = credential + '-' + checkpoint, folder = path.join(directory, name); await mkdir(folder);
  t.diagnostic('证据目录：' + folder);
  await mkdir(path.join(folder, 'config')); await copyFile(path.join(root, 'deploy/dev/config.json'), path.join(folder, 'config/gateway.json'));
  await exec('python3', ['-c', 'import sys\nfrom pathlib import Path\nsys.path.insert(0,"deploy/nas")\nimport device_identity\np=Path(sys.argv[1]);device_identity.initialize(p,"127.0.0.1");device_identity.issue(p,"device-lamp",p/"credentials")', folder], { cwd: root, timeout: 20000 });
  const port = await freePort();
  const stack = await startStack({ directory: folder, brokerTls: { port, ca: path.join(folder, 'broker-tls/ca.crt'), certificate: path.join(folder, 'broker-tls/server.crt'), key: path.join(folder, 'broker-tls/server.key') } });
  t.after(() => stack.close()); await stop(stack.lamp);
  const host = path.join(folder, 'host'); await mkdir(host, { mode: 0o700 });
  for (const [source, destination] of [['ca.crt', 'ca.crt'], ['device.crt', 'device.crt'], ['private.key', 'device.key']]) await copyFile(path.join(folder, 'credentials', source), path.join(host, destination));
  await copyFile(path.join(directory, 'download-ca.crt'), path.join(host, 'download-ca.crt'));
  const trust = structuredClone(vector.request.trust); trust.product_ids = ['desk-node-lamp-host']; trust.download_origins = [origin];
  await writeFile(path.join(host, 'trust.json'), JSON.stringify(trust));
  await writeFile(path.join(host, 'plan.json'), JSON.stringify({ credential, checkpoint, execution: 'execution-' + name, ca: path.join(host, 'download-ca.crt') }));
  if (credential === 'leaf' || credential === 'ca') await exec(python, ['-c', `
import sys
from pathlib import Path
from datetime import datetime,timedelta,timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
p=Path(sys.argv[1]);host=p/'host';key=serialization.load_pem_private_key((p/'device-authority/ca.key').read_bytes(),None)
now=datetime.now(timezone.utc).replace(microsecond=0)
for name,seconds in [('ca.crt',6 if sys.argv[2]=='ca' else 60),('device.crt',6 if sys.argv[2]=='leaf' else 60)]:
 old=x509.load_pem_x509_certificate((host/name).read_bytes())
 builder=x509.CertificateBuilder().subject_name(old.subject).issuer_name(old.issuer).public_key(old.public_key()).serial_number(old.serial_number).not_valid_before(now-timedelta(seconds=10)).not_valid_after(now+timedelta(seconds=seconds))
 for ext in old.extensions:builder=builder.add_extension(ext.value,ext.critical)
 (host/name).write_bytes(builder.sign(key,hashes.SHA256()).public_bytes(serialization.Encoding.PEM))
`, folder, credential], { cwd: root, timeout: 5000 });
  const leaf = new X509Certificate(await readFile(path.join(host, 'device.crt'))), ca = new X509Certificate(await readFile(path.join(host, 'ca.crt')));
  const expiry = Math.min(Date.parse(leaf.validTo), Date.parse(ca.validTo)); assert(expiry - Date.now() > 1500);
  assert.notEqual(digest(await readFile(path.join(host, 'ca.crt'))), digest(await readFile(path.join(host, 'download-ca.crt'))));
  const probe = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'gateway', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => probe.close());
  await probe.subscribe(topic + '/up/ota_result');
  const current = async () => (await stack.request(base + '/devices/device-lamp')).value;
  const launch = (location, mode) => {
    const child = stack.launch('installer-' + mode, binary, [location, String(port), mode]);
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); done.catch(() => {}); return { child, done };
  };
  const previous = (await current()).boot_id, worker = launch(host, 'install');
  await until(async () => { const d = await current(); return d.ready && d.boot_id !== previous; }, 8000);
  const manifest = structuredClone(vector.request.manifest);
  Object.assign(manifest.statement, { target: { product_id: 'desk-node-lamp-host', architecture: 'native', chip: 'host', board: 'host-fixture', hardware_revisions: ['host-fixture'] }, version: '0.3.0', size_bytes: image.length, sha256: digest(image), download: { url: origin + '/' + name, redirects: false } });
  manifest.statement.compatibility.minimum_bootloader_version = '0.0.1'; manifest.statement.compatibility.from_versions = ['0.2.0'];
  delete manifest.signature; manifest.signature = sign(null, Buffer.from('LimeIoT Device Firmware v1\n' + canonicalJSON(manifest)), privateKey).toString('base64');
  const original = await envelope(await current(), manifest, name);
  await writeFile(path.join(folder, 'original-request.json'), JSON.stringify(original));
  const requestCount = requests.length; await probe.publish(topic + '/down/ota_install', JSON.stringify(original));
  await until(() => json(path.join(host, 'consumed.json')), 15000);
  if (credential === 'valid') await writeFile(path.join(host, 'finish'), 'explicit test finish\n');
  assert.deepEqual(await worker.done, { code: 0, signal: null });
  const result = await json(path.join(host, 'result.json')), firstReceipts = await receipts(probe, original);
  assert.equal(result.stage_calls, 1); assert.equal(result.queue_size, 0); assert.equal(result.io_after_gate, 0);
  assert.equal(requests.length - requestCount, 1); assert.equal(result.effects, 0);
  assert.equal(result.injected, credential !== 'valid'); assert.equal(result.locked, credential !== 'valid');
  assert.equal(result.publishes_after_gate, 0); assert.equal(result.ota_installs, 1);
  const selected = ['none', 'selected', 'activated', 'bind-before', 'bind-after'].includes(checkpoint);
  assert.equal(result.selections, selected ? 1 : 0); assert.equal(result.activate_calls, selected ? 1 : 0);
  assert.equal(result.restart_calls, ['none', 'activated'].includes(checkpoint) ? 1 : 0);
  assert.deepEqual(firstReceipts.map(value => value.body.status), checkpoint === 'none' ? ['installing', 'awaiting_boot'] : ['installing']);
  const early = ['read', 'write', 'verify', 'staged'].includes(checkpoint);
  const commitFault = checkpoint.startsWith('bind-'); assert.equal(result.commit_failures, commitFault ? 1 : 0);
  assert.equal(result.commits, ['none', 'activated', 'bind-before', 'bind-after'].includes(checkpoint) ? 4 : 3);
  assert.equal(result.durable_commits, checkpoint === 'bind-before' ? 3 : result.commits);
  if (!commitFault) {
    assert.equal(result.stage, early ? 'failed' : 'awaiting_boot');
    assert.equal(result.binding, ['none', 'activated'].includes(checkpoint) ? 'host-selected-image' : '');
    if (early) assert.equal(result.outcome_error, checkpoint === 'staged' ? 'ota_install_authorization_lost' : 'ota_transfer_authorization_lost');
  } else assert.equal(result.log_error, 'storage_unavailable');
  assert.equal(result.blocked, !early);
  const persisted = await json(path.join(host, 'nvs-2-state.json')), record = persisted.records[0];
  const { checksum, ...unsigned } = persisted; assert.equal(checksum, await documentDigest(unsigned));
  assert.deepEqual(record.baseline, { firmware_version: '0.2.0', security_epoch: 0, image_sha256: baselineHash });
  assert.deepEqual(record.request, original); assert.equal(record.stage, early ? 'failed' : 'awaiting_boot');
  assert.equal(record.boot_binding ?? '', ['none', 'activated', 'bind-after'].includes(checkpoint) ? 'host-selected-image' : '');
  const staged = await readFile(path.join(host, 'spare.bin')); assert.deepEqual(staged, image.subarray(0, staged.length));
  if (checkpoint === 'read') assert.equal(staged.length, 0);
  else if (checkpoint === 'write') assert(staged.length > 0 && staged.length < image.length);
  else assert.equal(staged.length, image.length);
  if (['read', 'write', 'verify'].includes(checkpoint)) {
    for (const key of ['reads', 'writes', 'verifies']) assert.equal(result[key], result[key + '_at_gate']);
    assert.equal(result.staged_verified, false); assert.equal(result.aborts, 1);
  } else assert.equal(result.staged_verified, true);
  if (credential === 'ca') assert(Date.parse(leaf.validTo) > Date.now());
  if (credential === 'ca' || credential === 'leaf') assert(Date.now() >= expiry);
  const before = await snapshot(host), resumed = path.join(folder, 'resumed'); await mkdir(resumed, { mode: 0o700 });
  for (const file of await readdir(host)) if (/^nvs-/.test(file) || ['plan.json', 'trust.json', 'download-ca.crt', 'spare.bin', 'selection.json'].includes(file)) await copyFile(path.join(host, file), path.join(resumed, file));
  // 明确新建进程并恢复同一设备的有效原凭据；本专项不执行NAS换证/CSR维护。
  for (const [source, destination] of [['ca.crt', 'ca.crt'], ['device.crt', 'device.crt'], ['private.key', 'device.key']]) await copyFile(path.join(folder, 'credentials', source), path.join(resumed, destination));
  const restored = launch(resumed, 'resume'), oldBoot = original.boot_id;
  await until(async () => { const d = await current(); return d.ready && d.boot_id !== oldBoot; }, 8000);
  const d = await current(), query = { v: 1, kind: 'ota_query', message_id: randomUUID(), device_id: 'device-lamp', model_revision: d.model_revision,
    boot_id: d.boot_id, session_id: d.session_id, body: { task_id: original.body.task_id, execution_id: original.body.execution_id, request_digest: await documentDigest(original), manifest_digest: original.body.manifest_digest, expires_at: new Date(Date.now() + 20000).toISOString() } };
  await probe.publish(topic + '/down/ota_query', JSON.stringify(query)); await probe.publish(topic + '/down/ota_install', JSON.stringify(original));
  await until(() => json(path.join(resumed, 'consumed.json')), 5000);
  await writeFile(path.join(resumed, 'finish'), 'explicit restored-process finish\n'); assert.deepEqual(await restored.done, { code: 0, signal: null });
  const recovered = await json(path.join(resumed, 'result.json')), recoveredReceipts = await receipts(probe, original);
  for (const key of ['stage_calls', 'activate_calls', 'selections', 'restart_calls', 'commits', 'opens', 'reads', 'writes', 'effects']) assert.equal(recovered[key], 0, key);
  assert.equal(recovered.ota_queries, 1); assert.equal(recovered.ota_installs, 1); assert.equal(recovered.queue_size, 0);
  assert.equal(recovered.stage, early ? 'failed' : 'awaiting_boot'); assert.equal(recovered.blocked, !early);
  assert.equal(recovered.binding, record.boot_binding ?? ''); assert.equal(recovered.request_digest, await documentDigest(original));
  assert.equal(recovered.recovered, !early); assert.deepEqual(await snapshot(resumed), before);
  assert.deepEqual(recoveredReceipts.map(value => value.body.status), early ? ['failed'] : []);
  assert.equal(requests.length - requestCount, 1, '重开与原查询不重新下载');
  const request = requests[requestCount]; assert.equal(request.path, '/' + name); assert.equal(request.method, 'GET');
  for (const key of ['authorization', 'cookie', 'range', 'proxy-authorization']) assert.equal(request.headers[key], undefined);
  const item = { name, result, recovered, original_request_digest: await documentDigest(original), first_receipt_statuses: firstReceipts.map(r => r.body.status), recovered_receipt_statuses: recoveredReceipts.map(r => r.body.status), persistent_snapshot: before, https_requests: 1 };
  results.push(item); await writeFile(path.join(folder, 'case.json'), JSON.stringify(item, null, 2) + '\n');
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: results.length === scenarios.length ? 'passed' : 'in_progress', group, expected_cases: scenarios.length, cases: results, production_adapter_worker: true, production_installation_consumer: true, production_transfer: true, production_credential_window: true, real_mtls_broker_gateway: true, real_https: true, actual_installation: false, fixtures: ['freertos-queue-task', 'file-backed-nvs', 'baseline-image', 'spare-file', 'native-finish', 'boot-selection-binding', 'restart-request', 'unavailable-boot-observer'], identity_maintenance: false, esp_mqtt_runtime: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
  if (results.length === scenarios.length && process.env.LIMEIOT_OTA_INSTALL_REPORT) await writeFile(process.env.LIMEIOT_OTA_INSTALL_REPORT, JSON.stringify({ group, report: path.join(directory, 'report.json') }) + '\n');
});

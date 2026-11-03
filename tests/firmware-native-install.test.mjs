import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { createHash, createPrivateKey, randomUUID, sign, X509Certificate } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';
import { verifyOtaOperation, verifyOtaTask } from '../packages/protocol/ota-tasks.mjs';

const exec = promisify(execFile), binary = process.env.LIMEIOT_NATIVE_OTA_BINARY;
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const base = '/api/v1/spaces/space-demo', topic = 'limeiot/v1/space-demo/device-lamp';
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json')));
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vector.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
const schema = JSON.parse(await readFile(path.join(root, 'contracts/ota-tasks.schema.json')));
const validReceipt = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/receipt-envelope' });
const validInstall = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/install-envelope' });
const validQuery = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/query-envelope' });
const image = Buffer.alloc(65537); for (let i = 0; i < image.length; i++) image[i] = (i * 29 + 7) % 251;
const baseline = Buffer.from('independent baseline bytes; image structure verification is an explicit host fixture');
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file));
const group = process.env.LIMEIOT_NATIVE_INSTALL_GROUP;
assert(['normal', 'transfer', 'activation'].includes(group));
const matrix = {
  normal: [
    { name: 'success', boot: 'boot-success' }, { name: 'rollback', boot: 'boot-rollback' }, { name: 'pending', boot: 'boot-pending' },
  ],
  transfer: [
    { name: 'clock-read', credential: 'clock', checkpoint: 'read' },
    { name: 'leaf-read', credential: 'leaf', checkpoint: 'read' },
    { name: 'ca-verify', credential: 'ca', checkpoint: 'verify' },
    { name: 'finish-error', fault: 'finish' },
  ],
  activation: [
    { name: 'selection-error-after', fault: 'selection-error-after' },
    { name: 'clock-awaiting', credential: 'clock', checkpoint: 'awaiting' },
    { name: 'clock-selected', credential: 'clock', checkpoint: 'selected' },
    { name: 'bind-before', credential: 'clock', checkpoint: 'bind-before' },
    { name: 'bind-after', credential: 'clock', checkpoint: 'bind-after' },
  ],
};
let directory, server, origin;
const requests = [], results = [];
before(async () => {
  assert(binary, '使用npm run test:firmware:native-install构建当前输入');
  directory = await mkdtemp(path.join(root, '.dev/esp-native-install-cases-'));
  await writeFile(path.join(directory, 'image.bin'), image); await writeFile(path.join(directory, 'baseline.bin'), baseline);
  const openssl = args => exec('openssl', args, { cwd: directory, timeout: 10000 });
  await openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'download-ca.key', '-out', 'download-ca.crt', '-days', '2', '-subj', '/CN=Native integration download CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(path.join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'download-ca.crt', '-CAkey', 'download-ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'server.ext']);
  server = createServer({ key: await readFile(path.join(directory, 'server.key')), cert: await readFile(path.join(directory, 'server.crt')) }, (request, response) => {
    requests.push({ path: request.url, method: request.method, headers: request.headers }); response.setHeader('Content-Length', image.length); response.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'https://localhost:' + server.address().port;
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
async function snapshot(folder) {
  const names = (await readdir(folder)).filter(name => /^nvs-/.test(name) || ['baseline.bin', 'spare.bin', 'otadata.bin'].includes(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, digest(await readFile(path.join(folder, name)))])));
}
async function durableReceipts(folder, original, count) {
  const files = (await readdir(folder)).filter(name => /^durable-receipt-\d+\.json$/.test(name)).sort();
  assert.equal(files.length, count); const receipts = [];
  for (const name of files) {
    const { receipt, snapshot: saved } = await json(path.join(folder, name));
    assert.equal(validReceipt(receipt), true, JSON.stringify(validReceipt.errors));
    const { checksum, ...unsigned } = saved; assert.equal(checksum, await documentDigest(unsigned));
    const record = saved.records[0]; assert.deepEqual(record.request, original); assert.equal(record.stage, receipt.body.status);
    assert.equal(await documentDigest(record.request), receipt.body.request_digest);
    if (record.outcome) for (const key of ['firmware_version', 'security_epoch', 'image_sha256', 'pending_update', 'error']) assert.equal(record.outcome[key], receipt.body[key], key);
    receipts.push(receipt);
  }
  return receipts;
}
async function diskTask(stack, taskID) {
  const result = await exec('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); v,b=c.execute("SELECT version,body FROM snapshot").fetchone(); print(json.dumps({"version":v,"task":json.loads(b)["ota_registry"]["tasks"][sys.argv[2]]}))', stack.env.LIMEIOT_DB, taskID], { timeout: 5000 });
  return JSON.parse(result.stdout);
}
for (const scenario of matrix[group]) test(`生产原生OTA完整软件链与原任务恢复：${scenario.name}`, { timeout: 45000 }, async t => {
  const { name, boot = 'resume', credential = 'valid', checkpoint = 'none', fault = 'none' } = scenario;
  const folder = path.join(directory, name); await mkdir(folder); t.diagnostic('证据目录：' + folder);
  await mkdir(path.join(folder, 'config')); await copyFile(path.join(root, 'deploy/dev/config.json'), path.join(folder, 'config/gateway.json'));
  await exec('python3', ['-c', 'import sys\nfrom pathlib import Path\nsys.path.insert(0,"deploy/nas")\nimport device_identity\np=Path(sys.argv[1]);device_identity.initialize(p,"127.0.0.1");device_identity.issue(p,"device-lamp",p/"credentials")', folder], { cwd: root, timeout: 20000 });
  const port = await freePort(), stack = await startStack({ directory: folder, brokerTls: { port, ca: path.join(folder, 'broker-tls/ca.crt'), certificate: path.join(folder, 'broker-tls/server.crt'), key: path.join(folder, 'broker-tls/server.key') } });
  t.after(() => stack.close()); await stop(stack.lamp);
  const host = path.join(folder, 'host'); await mkdir(host, { mode: 0o700 });
  async function restoreCredentials(destination) {
    for (const [source, target] of [['ca.crt', 'ca.crt'], ['device.crt', 'device.crt'], ['private.key', 'device.key']]) await copyFile(path.join(folder, 'credentials', source), path.join(destination, target));
  }
  await restoreCredentials(host); await copyFile(path.join(directory, 'download-ca.crt'), path.join(host, 'download-ca.crt'));
  const trust = structuredClone(vector.request.trust); trust.product_ids = ['desk-node-lamp-host']; trust.download_origins = [origin];
  await writeFile(path.join(host, 'trust.json'), JSON.stringify(trust));
  const plan = { suite: 'stage', fault, checkpoint, invalidation: credential === 'valid' ? 'clock' : credential, credential, execution: '',
    image: path.join(directory, 'image.bin'), baseline: path.join(directory, 'baseline.bin') };
  await writeFile(path.join(host, 'plan.json'), JSON.stringify(plan));
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
  const leaf = new X509Certificate(await readFile(path.join(host, 'device.crt'))), authority = new X509Certificate(await readFile(path.join(host, 'ca.crt')));
  const expires = Math.min(Date.parse(leaf.validTo), Date.parse(authority.validTo)); assert(expires - Date.now() > 1500);
  assert.notEqual(digest(await readFile(path.join(host, 'ca.crt'))), digest(await readFile(path.join(host, 'download-ca.crt'))));
  const probe = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'gateway', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => probe.close());
  const downProbe = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'device-lamp', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => downProbe.close());
  await probe.subscribe(topic + '/up/ota_result');
  for (const suffix of ['/down/ota_install', '/down/ota_query']) {
    const acknowledgement = await downProbe.subscribe(topic + suffix); assert.equal(acknowledgement[acknowledgement.length - 1], 0);
  }
  const packets = [];
  async function collect(predicate, timeout = 5000) {
    const untilTime = Date.now() + timeout;
    for (;;) {
      const found = packets.find(predicate); if (found) return found;
      assert(Date.now() < untilTime, '等待指定MQTT原任务包');
      const message = JSON.parse((await downProbe.message(Math.max(1, untilTime - Date.now()))).payload); packets.push(message);
    }
  }
  async function change(body, key, status = 'applied') {
    const response = await stack.request(base + '/ota-operations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': name + '-' + key }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, JSON.stringify(response.value)); assert.equal(response.value.status, status, JSON.stringify(response.value));
    await verifyOtaOperation(response.value, { space_id: 'space-demo', idempotency_key: name + '-' + key, change: body }); return response.value;
  }
  const current = async () => (await stack.request(base + '/devices/device-lamp')).value;
  const launch = (destination, mode) => {
    const child = stack.launch('native-' + mode, binary, [destination, String(port), mode]);
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); done.catch(() => {}); return { child, done };
  };
  const oldBoot = (await current()).boot_id, worker = launch(host, 'install');
  await until(async () => { const d = await current(); return d.ready && d.boot_id !== oldBoot && d.device_info?.fresh; }, 8000);
  const manifest = structuredClone(vector.request.manifest);
  Object.assign(manifest.statement, { target: { product_id: 'desk-node-lamp-host', architecture: 'native', chip: 'host', board: 'host-fixture', hardware_revisions: ['host-fixture'] },
    version: '0.2.0', security_epoch: 2, size_bytes: image.length, sha256: digest(image), download: { url: origin + '/' + name, redirects: false } });
  manifest.statement.compatibility.minimum_bootloader_version = '0.0.1'; manifest.statement.compatibility.from_versions = ['0.1.0'];
  delete manifest.signature; manifest.signature = sign(null, Buffer.from('LimeIoT Device Firmware v1\n' + canonicalJSON(manifest)), privateKey).toString('base64');
  const trusted = await change({ type: 'trust.add', trust, expected_signing_key_id: trust.signing_key_id }, 'trust');
  const planned = await change({ type: 'tasks.plan', device_id: 'device-lamp', trust_id: trusted.resource.id, manifest, expires_at: new Date(Date.now() + 600000).toISOString() }, 'plan');
  const taskID = planned.resource.id;
  const task = async () => { const value = (await stack.request(base + '/ota-tasks/' + taskID)).value; await verifyOtaTask(value); return value; };
  await change({ type: 'tasks.approve', task_id: taskID, expected_revision: (await task()).revision }, 'approve');
  const requestCount = requests.length;
  await change({ type: 'tasks.execute', task_id: taskID, expected_revision: (await task()).revision }, 'execute');
  const original = await collect(value => value.kind === 'ota_install'); assert.equal(validInstall(original), true, JSON.stringify(validInstall.errors));
  const requestDigest = await documentDigest(original);
  await writeFile(path.join(folder, 'original-request.json'), JSON.stringify(original));
  await writeFile(path.join(host, 'execution.txt'), original.body.execution_id);
  await until(() => json(path.join(host, 'consumed.json')), 15000);
  if (credential === 'valid') await writeFile(path.join(host, 'finish'), 'explicit install-process finish\n');
  assert.deepEqual(await worker.done, { code: 0, signal: null });
  const first = await json(path.join(host, 'result.json'));
  const firstReceipts = await durableReceipts(host, original, first.ota_results);
  assert.equal(first.stage_calls, 1); assert.equal(first.opens, 1); assert.equal(first.io_after_gate, 0); assert.equal(first.publishes_after_gate, 0); assert.equal(first.effects, 0); assert.equal(first.active_handle, false);
  const early = group === 'transfer', commitFault = name.startsWith('bind-');
  const selected = !early && name !== 'clock-awaiting';
  const bound = selected && !['selection-error-after', 'bind-before'].includes(name);
  assert.equal(first.selections, selected ? 1 : 0); assert.equal(first.restart_calls, bound && !commitFault ? 1 : 0);
  assert.equal(first.commit_failures, commitFault ? 1 : 0);
  if (credential !== 'valid') { assert.equal(first.locked, true); assert.equal(first.injected, true); }
  const persisted = await json(path.join(host, 'nvs-2-state.json')), record = persisted.records[0];
  const { checksum, ...unsigned } = persisted; assert.equal(checksum, await documentDigest(unsigned));
  assert.deepEqual(record.request, original); assert.deepEqual(record.baseline, { firmware_version: '0.1.0', security_epoch: 1, image_sha256: digest(baseline) });
  assert.equal(record.stage, early ? 'failed' : 'awaiting_boot'); assert.equal(record.boot_binding ?? '', bound ? 'esp_00200000_00000002' : '');
  assert.equal(await documentDigest(record.request), requestDigest);
  const staged = await readFile(path.join(host, 'spare.bin')); assert.deepEqual(staged, image.subarray(0, staged.length));
  if (checkpoint === 'read') assert.equal(staged.length, 0); else assert.equal(staged.length, image.length);
  if (credential === 'ca') assert(Date.parse(leaf.validTo) > Date.now());
  if (credential === 'leaf' || credential === 'ca') assert(Date.now() >= expires);
  const before = await snapshot(host), firstDisk = await diskTask(stack, taskID); assert.equal(firstDisk.task.execution.request_digest, requestDigest);
  await stack.restartGateway(); assert.equal((await task()).execution.request_digest, requestDigest);
  const resumed = path.join(folder, 'resumed'); await mkdir(resumed, { mode: 0o700 });
  for (const filename of await readdir(host)) if (/^nvs-/.test(filename) || ['plan.json', 'execution.txt', 'trust.json', 'download-ca.crt', 'baseline.bin', 'spare.bin', 'otadata.bin'].includes(filename)) await copyFile(path.join(host, filename), path.join(resumed, filename));
  await restoreCredentials(resumed);
  const restored = launch(resumed, boot);
  await until(async () => { const d = await current(); return d.ready && d.boot_id !== original.boot_id && d.device_info?.fresh; }, 8000);
  const expected = name === 'success' ? 'succeeded' : name === 'rollback' ? 'rolled_back' : early ? 'failed' : null;
  const expectedTask = expected === 'rolled_back' ? 'failed' : expected;
  if (['success', 'rollback'].includes(name)) await until(async () => (await task()).status === expectedTask, 5000);
  const beforeQuery = await task(), terminal = ['succeeded', 'failed'].includes(beforeQuery.status);
  const reconciliation = await change({ type: 'tasks.reconcile', task_id: taskID, expected_revision: beforeQuery.revision }, 'reconcile', terminal ? 'rejected' : 'applied');
  let query;
  if (terminal) {
    assert.equal(beforeQuery.status, expectedTask); assert.equal(reconciliation.reason, 'invalid_ota_transition');
    const device = await current();
    query = { v: 1, kind: 'ota_query', message_id: randomUUID(), device_id: 'device-lamp', model_revision: device.model_revision,
      boot_id: device.boot_id, session_id: device.session_id, body: { task_id: taskID, execution_id: original.body.execution_id,
        request_digest: requestDigest, manifest_digest: original.body.manifest_digest, expires_at: new Date(Date.now() + 20000).toISOString() } };
    await probe.publish(topic + '/down/ota_query', JSON.stringify(query));
  } else query = await collect(value => value.kind === 'ota_query');
  assert.equal(validQuery(query), true, JSON.stringify(validQuery.errors)); assert.equal(query.body.request_digest, requestDigest); assert.equal(query.body.execution_id, original.body.execution_id);
  await probe.publish(topic + '/down/ota_install', JSON.stringify(original));
  await until(() => json(path.join(resumed, 'consumed.json')), 5000);
  if (expected) await until(async () => (await task()).status === expectedTask, 5000);
  await writeFile(path.join(resumed, 'finish'), 'explicit recovered-process finish\n'); assert.deepEqual(await restored.done, { code: 0, signal: null });
  const recovered = await json(path.join(resumed, 'result.json'));
  const recoveredReceipts = await durableReceipts(resumed, original, recovered.ota_results);
  const delivered = [];
  for (let i = 0; i < firstReceipts.length + recoveredReceipts.length; i++) {
    const receipt = JSON.parse((await probe.message()).payload); assert.equal(validReceipt(receipt), true, JSON.stringify(validReceipt.errors)); delivered.push(receipt);
  }
  assert.deepEqual(delivered, [...firstReceipts, ...recoveredReceipts]);
  for (const key of ['stage_calls', 'activate_calls', 'selections', 'restart_calls', 'opens', 'reads', 'writes', 'effects']) assert.equal(recovered[key], 0, key);
  assert.equal(recovered.ota_queries, 1); assert.equal(recovered.ota_installs, 1); assert.equal(recovered.queue_size, 0);
  assert.equal(recovered.stage, expected ?? 'awaiting_boot'); assert.equal(recovered.request_digest, requestDigest); assert.equal(recovered.binding, record.boot_binding ?? '');
  assert.equal(recovered.commits, ['success', 'rollback'].includes(name) ? 1 : 0);
  const after = await snapshot(resumed);
  for (const filename of ['baseline.bin', 'spare.bin']) assert.equal(after[filename], before[filename]);
  if (!['success', 'rollback', 'pending'].includes(name)) assert.deepEqual(after, before);
  else if (name === 'pending') assert.equal(after['nvs-2-state.json'], before['nvs-2-state.json']);
  const finalLog = await json(path.join(resumed, 'nvs-2-state.json')), finalRecord = finalLog.records[0];
  assert.deepEqual(finalRecord.request, original); assert.deepEqual(finalRecord.baseline, record.baseline); assert.equal(await documentDigest(finalRecord.request), requestDigest);
  const finalTask = await task(), finalDisk = await diskTask(stack, taskID);
  assert.equal(finalTask.execution.request_digest, requestDigest); assert.equal(finalDisk.task.status, finalTask.status);
  if (expected) {
    assert.equal(finalTask.status, expectedTask); assert.equal(finalTask.execution.receipt.envelope.body.status, expected);
    assert.equal(finalTask.execution.receipt.envelope.body.request_digest, requestDigest);
    assert.equal(finalTask.execution.receipt.envelope.body.image_sha256, digest(name === 'success' ? image : baseline));
  } else assert(['unknown', 'executing'].includes(finalTask.status));
  await stack.restartGateway(); const reopenedTask = await task();
  assert.equal(reopenedTask.status, expectedTask ?? 'unknown'); assert.equal(reopenedTask.execution.request_digest, requestDigest);
  assert.deepEqual(reopenedTask.execution.envelope, original);
  assert.equal(requests.length - requestCount, 1); const request = requests[requestCount]; assert.equal(request.path, '/' + name); assert.equal(request.method, 'GET');
  for (const key of ['authorization', 'cookie', 'range', 'proxy-authorization']) assert.equal(request.headers[key], undefined);
  const item = { name, first, recovered, original, original_request_digest: requestDigest, initial_snapshot: before, recovered_snapshot: after,
    first_receipts: firstReceipts, recovered_receipts: recoveredReceipts, durable_before_publish: true,
    first_gateway_task: firstDisk.task, final_gateway_task: finalTask, final_disk_task: finalDisk.task, reopened_gateway_task: reopenedTask,
    query_source: terminal ? 'direct-device-query-after-terminal-reconcile-rejected' : 'gateway-reconcile', reconciliation,
    https_requests: 1, gateway_reopened: true };
  results.push(item); await writeFile(path.join(folder, 'case.json'), JSON.stringify(item, null, 2) + '\n');
  const report = { status: results.length === matrix[group].length ? 'passed' : 'in_progress', scope: 'production-worker-consumer-native-provider-integration', group,
    cases: results, production_adapter_worker: true, production_installation_consumer: true, production_native_stage: true, production_native_activation: true,
    production_native_observer: true, production_credential_window: true, real_mtls_broker_gateway: true, real_https: true, device_process_reopened: true,
    gateway_reopened: true, identity_maintenance: false, actual_installation: false, esp_mqtt_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false,
    fixtures: ['freertos-queue-task', 'file-backed-nvs', 'libmosquitto-openssl-mqtt', 'openssl-firmware-signature', 'openssl-https-api-bridge', 'file-partitions', 'native-image-verifier', 'scripted-boot-selection-and-metadata', 'restart-request'] };
  const reportPath = path.join(directory, 'report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (report.status === 'passed' && process.env.LIMEIOT_NATIVE_OTA_RESULTS) await writeFile(process.env.LIMEIOT_NATIVE_OTA_RESULTS, JSON.stringify({ report: reportPath }) + '\n');
});

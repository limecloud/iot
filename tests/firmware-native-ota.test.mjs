import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const binary = process.env.LIMEIOT_NATIVE_OTA_BINARY;
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const image = Buffer.alloc(65537); for (let i = 0; i < image.length; i++) image[i] = (i * 29 + 7) % 251;
const baseline = Buffer.from('independent baseline bytes; image structure verification is an explicit host fixture');
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
let directory, server, origin, completedGroups = 0;
const requests = [], cases = [], sockets = new Set();
before(async () => {
  assert(binary, '使用npm run test:firmware:native-ota构建固定输入');
  directory = await mkdtemp(path.join(root, '.dev/esp-native-ota-cases-'));
  await writeFile(path.join(directory, 'image.bin'), image); await writeFile(path.join(directory, 'baseline.bin'), baseline);
  const openssl = args => exec('openssl', args, { cwd: directory, timeout: 10000 });
  await openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'https-ca.key', '-out', 'https-ca.crt', '-days', '2', '-subj', '/CN=Native OTA download CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(path.join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'https-ca.crt', '-CAkey', 'https-ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'server.ext']);
  await exec(python, ['firmware/tests/runtime_certificates.py', directory, 'valid'], { cwd: root, timeout: 5000 });
  server = createServer({ key: await readFile(path.join(directory, 'server.key')), cert: await readFile(path.join(directory, 'server.crt')) }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = '', handled = false;
    socket.on('data', chunk => {
      if (handled) return; pending += chunk.toString(); assert(pending.length < 8192);
      if (!pending.includes('\r\n\r\n')) return; handled = true;
      const route = pending.split(' ')[1], fault = route.split('/').at(-1); requests.push({ route, raw: pending });
      let status = fault === 'redirect' ? '302 Found' : fault === 'status' ? '503 Unavailable' : '200 OK';
      let headers = fault === 'no-length' ? [] : ['Content-Length: ' + image.length];
      if (fault === 'duplicate-length') headers.push('Content-Length: ' + image.length);
      if (fault === 'length-mismatch') headers = ['Content-Length: 1'];
      if (fault === 'invalid-length') headers = ['Content-Length: 65537x'];
      if (fault === 'overflow-length') headers = ['Content-Length: 4294967296'];
      if (fault === 'encoded') headers.push('Content-Encoding: gzip');
      if (fault === 'redirect') headers.push('Location: /never-follow');
      const body = fault === 'truncated' ? image.subarray(0, 1025) : fault === 'too-long' ? Buffer.concat([image, Buffer.from('x')]) : image;
      socket.end(Buffer.concat([Buffer.from(['HTTP/1.0 ' + status, ...headers, '', ''].join('\r\n')), body]));
    });
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'https://localhost:' + server.address().port;
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
});
async function run(suite, fault = 'none', checkpoint = 'none', invalidation = 'clock') {
  const name = [suite, fault, checkpoint, invalidation].join('-'), folder = path.join(directory, name); await mkdir(folder, { mode: 0o700 });
  let identity = directory;
  if (invalidation !== 'clock') {
    identity = folder;
    await exec(python, ['firmware/tests/runtime_certificates.py', folder, invalidation === 'ca' ? 'short-ca' : 'short-leaf'], { cwd: root, timeout: 5000 });
  }
  const plan = { suite, fault, checkpoint, invalidation, size: image.length, sha256: digest(image), baseline_sha256: digest(baseline),
    url: origin + '/' + name + '/' + fault, image: path.join(directory, 'image.bin'), baseline: path.join(directory, 'baseline.bin'),
    download_ca: path.join(directory, 'https-ca.crt'), identity_key: path.join(identity, 'key.pem'), identity_leaf: path.join(identity, 'leaf.pem'), identity_ca: path.join(identity, 'ca.pem') };
  if (fault === 'wrong-download-ca') plan.download_ca = plan.identity_ca;
  if (fault === 'candidate-hash') plan.sha256 = 'sha256:' + '0'.repeat(64);
  const leaf = new X509Certificate(await readFile(plan.identity_leaf)), ca = new X509Certificate(await readFile(plan.identity_ca));
  const expires = Math.min(Date.parse(leaf.validTo), Date.parse(ca.validTo)); assert(expires - Date.now() > 1200);
  assert.notEqual(digest(await readFile(path.join(directory, 'https-ca.crt'))), digest(await readFile(plan.identity_ca)));
  const filename = path.join(folder, 'plan.json'); await writeFile(filename, JSON.stringify(plan), { mode: 0o600 });
  const count = requests.length;
  const result = await exec(binary, [filename, folder], { cwd: root, timeout: 10000 });
  assert.equal(result.stderr, '', name); const value = JSON.parse(result.stdout);
  assert.equal(value.io_after_loss, 0, name); assert.equal(value.active_handle, false, name);
  assert.equal(value.hardware, false); assert.equal(value.actual_installation, false);
  for (const request of requests.slice(count)) {
    assert.match(request.raw, /^GET /); assert.match(request.raw, /Accept-Encoding: identity\r\n/);
    assert(!/\r\n(?:Authorization|Proxy-Authorization|Cookie|Range):/i.test(request.raw)); assert(!request.route.includes('never-follow'));
  }
  const item = { name, suite, fault, checkpoint, invalidation, folder, value, request_count: requests.length - count,
    expires_at: new Date(expires).toISOString() };
  await writeFile(path.join(folder, 'result.json'), JSON.stringify(item, null, 2) + '\n'); cases.push(item);
  return item;
}
async function unchangedMetadata(item) {
  assert.deepEqual(await readFile(path.join(item.folder, 'otadata-before.bin')), await readFile(path.join(item.folder, 'otadata-after.bin')), item.name);
}
test('原生暂存经真实HTTPS、SDK PSA和文件分区完整写入/回读，独立摘要与元数据核对', { timeout: 45000 }, async () => {
  for (const fault of ['none', 'no-length']) {
    const item = await run('stage', fault), v = item.value;
    assert.equal(v.accepted, true); assert.equal(v.code, 0); assert.equal(v.image_verified, true); assert.equal(v.image_sha256, digest(image));
    for (const field of ['bytes_received', 'bytes_written', 'bytes_verified']) assert.equal(v[field], image.length);
    assert.equal(v.begins, 1); assert.equal(v.ends, 1); assert.equal(v.aborts, 0); assert.equal(v.selections, 0);
    assert.equal(item.request_count, 1); assert.equal(v.closes, 1); assert.equal(v.cleanups, 1);
    assert.deepEqual(await readFile(path.join(item.folder, 'spare.bin')), image); await unchangedMetadata(item);
  }
  completedGroups++;
});
test('原生响应/信任及底层故障不得产生暂存证明或启动选择', { timeout: 45000 }, async () => {
  const response = ['redirect', 'status', 'duplicate-length', 'length-mismatch', 'invalid-length', 'overflow-length', 'encoded'];
  const noBegin = [...response, 'empty-ca', 'wrong-download-ca', 'http-init', 'http-header', 'http-open', 'http-fetch'];
  const issues = {
    redirect: 'ota_http_response_rejected', status: 'ota_http_response_rejected', encoded: 'ota_http_response_rejected',
    'duplicate-length': 'ota_http_unavailable', 'invalid-length': 'ota_http_unavailable', 'overflow-length': 'ota_http_unavailable',
    'length-mismatch': 'ota_http_length_mismatch', 'empty-ca': 'invalid_ota_https_trust',
    'wrong-download-ca': 'ota_http_unavailable', 'http-init': 'ota_http_unavailable', 'http-header': 'ota_http_unavailable', 'http-open': 'ota_http_unavailable', 'http-fetch': 'ota_http_unavailable',
    'http-read': 'ota_http_read_failed', truncated: 'ota_image_truncated', 'too-long': 'ota_image_too_long', begin: 'ota_staging_unavailable',
    write: 'ota_staging_write_failed', finish: 'ota_native_image_rejected', 'partition-read': 'ota_staging_read_failed',
    'corrupt-write': 'ota_image_hash_mismatch', 'candidate-hash': 'ota_image_hash_mismatch',
    'missing-running': 'ota_staging_unavailable', 'missing-next': 'ota_staging_unavailable', 'same-partition': 'ota_staging_unavailable', 'not-app': 'ota_staging_unavailable', capacity: 'ota_staging_unavailable',
  };
  for (const fault of [...noBegin, 'http-read', 'truncated', 'too-long', 'begin', 'write', 'finish', 'partition-read', 'corrupt-write', 'candidate-hash', 'missing-running', 'missing-next', 'same-partition', 'not-app', 'capacity']) {
    const item = await run('stage', fault), v = item.value;
    assert.equal(v.accepted, false, fault); assert.equal(v.image_verified, false, fault); assert.equal(v.image_sha256, '', fault); assert.equal(v.selections, 0, fault);
    assert.equal(v.issue, issues[fault], fault);
    if (noBegin.includes(fault)) assert.equal(v.begins, 0, fault);
    assert.equal(v.cleanups, v.closes, fault);
    assert.equal(item.request_count, ['empty-ca', 'wrong-download-ca', 'http-init', 'http-header', 'http-open'].includes(fault) ? 0 : 1, fault);
    await unchangedMetadata(item);
  }
  completedGroups++;
});
test('原生暂存在真实证书到期及可信时钟失效后停止新增I/O', { timeout: 45000 }, async () => {
  for (const [invalidation, points] of [['clock', ['before', 'read', 'write', 'verify', 'finish']], ['leaf', ['read']], ['ca', ['verify']]]) {
    for (const point of points) {
      const item = await run('stage', 'none', point, invalidation), v = item.value;
      assert.equal(v.accepted, false); assert.equal(v.issue, 'ota_transfer_authorization_lost'); assert.equal(v.image_verified, false);
      assert.equal(v.injected, true); assert.equal(v.observed_loss, true); assert.equal(v.current, false); assert.equal(v.restored_current, false);
      assert.equal(v.selections, 0); assert.equal(item.request_count, point === 'before' ? 0 : 1);
      if (invalidation === 'ca') assert.equal(v.leaf_still_valid, true);
      if (invalidation !== 'clock') assert(Date.now() >= Date.parse(item.expires_at)); await unchangedMetadata(item);
    }
  }
  completedGroups++;
});
test('原生激活仅为核实的本次唯一NEW选择返回绑定，选择后失权仍保留实际绑定', { timeout: 45000 }, async () => {
  for (const point of ['none', 'select']) {
    const item = await run('activate', 'none', point), v = item.value;
    assert.equal(v.accepted, true); assert.equal(v.binding, 'esp_00200000_00000002'); assert.equal(v.selections, 1); assert.equal(v.chosen, 1);
    assert.equal(v.opens, 0); assert.equal(v.writes, 0);
    const after = await readFile(path.join(item.folder, 'otadata-after.bin'));
    assert.equal(after.length, 64); assert.equal(after.readUInt32LE(32), 2); assert.equal(after.readUInt32LE(56), 0);
    assert.equal(after.readUInt32LE(60), 0x55f63774, 'seq=2的CRC与独立zlib参考向量一致');
    if (point === 'select') { assert.equal(v.observed_loss, true); assert.equal(v.current, false); }
  }
  completedGroups++;
});
test('原生选择前拒绝零选择；选择可能生效后报错不补造绑定或重复选择', { timeout: 45000 }, async () => {
  const before = ['missing-running', 'missing-next', 'same-partition', 'capacity', 'description-read', 'target-version', 'target-epoch', 'target-project',
    'unterminated-version', 'unterminated-project', 'candidate-hash', 'partition-read', 'missing-otadata', 'metadata-read', 'bad-erase-size', 'bad-metadata-size', 'sequence-overflow', 'zero-partitions', 'preselected'];
  const after = ['selection-error-before', 'selection-error-after', 'post-selection-read', 'selection-crc', 'selection-duplicate', 'wrong-slot', 'selected-wrong-boot', 'sequence-reused'];
  for (const fault of [...before, ...after]) {
    const item = await run('activate', fault), v = item.value;
    assert.equal(v.accepted, false, fault); assert.equal(v.binding, '', fault); assert.equal(v.selections, before.includes(fault) ? 0 : 1, fault);
    assert.equal(v.opens, 0); assert.equal(v.writes, 0);
    if (before.includes(fault) || fault === 'selection-error-before') await unchangedMetadata(item);
    if (fault === 'selection-error-after' || fault === 'post-selection-read') assert.equal(v.chosen, 1);
  }
  for (const point of ['before', 'activation-read']) {
    const item = await run('activate', 'none', point), v = item.value;
    assert.equal(v.accepted, false); assert.equal(v.selections, 0); assert.equal(v.binding, ''); assert.equal(v.observed_loss, true); await unchangedMetadata(item);
  }
  completedGroups++;
});
test('原生观察只报告目标VALID成功或精确原基线回滚，不产生安装副作用', { timeout: 45000 }, async () => {
  for (const fault of ['none', 'rollback', 'rollback-invalid']) {
    const item = await run('observe', fault), v = item.value; assert.equal(v.accepted, true, fault);
    assert.equal(v.stage, fault === 'none' ? 3 : 6); assert.equal(v.outcome_version, fault === 'none' ? '0.2.0' : '0.1.0');
    assert.equal(v.outcome_sha256, digest(fault === 'none' ? image : baseline)); assert.equal(v.outcome_error, fault === 'none' ? '' : 'ota_boot_rolled_back');
    assert.equal(v.selections, 0); assert.equal(v.writes, 0); assert.equal(v.opens, 0); await unchangedMetadata(item);
  }
  for (const fault of ['pending', 'new', 'binding-noncanonical', 'binding-trailing', 'binding-wrong-address', 'observe-crc', 'observe-duplicate', 'observe-wrong-slot',
    'running-boot-mismatch', 'missing-running', 'missing-boot', 'missing-otadata', 'metadata-read', 'zero-partitions', 'description-read', 'target-version', 'target-epoch',
    'unterminated-version', 'unterminated-project', 'target-hash', 'image-invalid', 'image-too-big', 'partition-read', 'observation-changed',
    'baseline-state-read', 'baseline-pending', 'baseline-hash', 'baseline-version', 'baseline-epoch']) {
    const item = await run('observe', fault), v = item.value;
    assert.equal(v.accepted, false, fault); assert.equal(v.selections, 0); assert.equal(v.writes, 0); assert.equal(v.opens, 0);
    if (fault !== 'observation-changed') await unchangedMetadata(item);
  }
  completedGroups++;
});
test('归档原生提供方各场景的实际结果与明确替换范围', async t => {
  assert.equal(completedGroups, 6, '所有行为组通过后才发布passed报告');
  const report = { status: 'passed', scope: 'production-native-esp-ota-provider-host', cases: cases.length, results: cases,
    production_native_stage: true, production_native_activation: true, production_native_observer: true, real_https: true,
    production_credential_window: true, sdk_psa_and_crc: true, sdk_descriptor_and_otadata_types: true,
    fixtures: ['openssl-https-api-bridge', 'file-partitions', 'native-image-verifier', 'scripted-boot-selection-and-metadata'],
    production_worker: false, installation_consumer: false, log_recovery: false, actual_installation: false, esp_mqtt_runtime: false,
    hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  assert(cases.length > 90);
  const filename = path.join(directory, 'report.json'); await writeFile(filename, JSON.stringify(report, null, 2) + '\n');
  if (process.env.LIMEIOT_NATIVE_OTA_RESULTS) await writeFile(process.env.LIMEIOT_NATIVE_OTA_RESULTS, JSON.stringify({ report: filename }) + '\n');
  t.diagnostic('证据目录：' + directory);
});

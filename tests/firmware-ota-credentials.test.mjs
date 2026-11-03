import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const binary = process.env.LIMEIOT_OTA_CREDENTIAL_BINARY;
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const image = Buffer.alloc(262145); for (let i = 0; i < image.length; i++) image[i] = (i * 29 + 7) % 251;
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
let directory, server, origin;
const requests = [], cases = [];
before(async () => {
  assert(binary, '使用npm run test:firmware:ota-credentials构建当前输入');
  directory = await mkdtemp(path.join(root, '.dev/ota-transfer-credentials-cases-'));
  const openssl = args => exec('openssl', args, { cwd: directory, timeout: 10000 });
  await openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'https-ca.key', '-out', 'https-ca.crt', '-days', '2', '-subj', '/CN=OTA download test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(path.join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'https-ca.crt', '-CAkey', 'https-ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'server.ext']);
  server = createServer({ key: await readFile(path.join(directory, 'server.key')), cert: await readFile(path.join(directory, 'server.crt')) }, (request, response) => {
    requests.push({ path: request.url, method: request.method, headers: request.headers });
    response.setHeader('Content-Length', image.length); response.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'https://localhost:' + server.address().port;
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });

async function run(mode, checkpoint) {
  const name = mode + '-' + checkpoint, folder = path.join(directory, name);
  await mkdir(folder, { mode: 0o700 });
  await exec(python, ['firmware/tests/runtime_certificates.py', folder, mode === 'leaf' ? 'short-leaf' : mode === 'ca' ? 'short-ca' : 'valid'], { cwd: root, timeout: 5000 });
  const leaf = new X509Certificate(await readFile(path.join(folder, 'leaf.pem'))), ca = new X509Certificate(await readFile(path.join(folder, 'ca.pem')));
  const expiry = Math.min(Date.parse(leaf.validTo), Date.parse(ca.validTo));
  assert(expiry - Date.now() > 1200, '启动前证书必须仍有效，不以已过期启动代替运行期失效');
  const plan = { mode, checkpoint, url: origin + '/' + name, size: image.length, sha256: digest(image), ca: path.join(directory, 'https-ca.crt'), identity_ca: path.join(folder, 'ca.pem'), key: path.join(folder, 'key.pem'), leaf: path.join(folder, 'leaf.pem') };
  assert.notEqual(digest(await readFile(plan.ca)), digest(await readFile(plan.identity_ca)), '设备身份和下载CA独立');
  await writeFile(path.join(folder, 'plan.json'), JSON.stringify(plan), { mode: 0o600 });
  const output = path.join(folder, 'spare.bin'), count = requests.length;
  const execution = await exec(binary, [path.join(folder, 'plan.json'), output], { cwd: root, timeout: 10000 });
  assert.equal(execution.stderr, ''); assert(!execution.stdout.includes('PRIVATE KEY'));
  const value = JSON.parse(execution.stdout), actualRequests = requests.slice(count);
  assert.equal(value.opened, true); assert.equal(value.calls_after_gate, 0);
  assert.equal(value.closes, value.opens);
  assert.equal(actualRequests.length, checkpoint === 'before' ? 0 : 1, '失败与恢复可信时钟后均不产生第二次HTTPS请求');
  for (const request of actualRequests) {
    assert.equal(request.path, '/' + name); assert.equal(request.method, 'GET');
    for (const header of ['authorization', 'cookie', 'range', 'proxy-authorization']) assert.equal(request.headers[header], undefined);
  }
  return { name, mode, checkpoint, folder, output, value, expiry, requests: actualRequests.length };
}
async function record(item) {
  const result = { mode: item.mode, checkpoint: item.checkpoint, ...item.value, request_count: item.requests, certificate_expires_at: new Date(item.expiry).toISOString() };
  await writeFile(path.join(item.folder, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  cases.push(result);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: cases.length === 9 ? 'passed' : 'in_progress', scope: 'credential-window-during-production-ota-transfer', cases, actual_sdk_crypto: true, real_https: true, production_transfer: true, production_credential_window: true, fixtures: ['spare-file', 'native-image-finish'], installation_dispatcher: false, actual_installation: false, esp_mqtt_runtime: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
}
test('有效凭据允许真实HTTPS与全部备用文件回读，独立摘要一致', { timeout: 20000 }, async t => {
  const item = await run('valid', 'none'), value = item.value;
  assert.equal(value.code, 0); assert.equal(value.issue, 'ok'); assert.equal(value.image_verified, true); assert.equal(value.image_sha256, digest(image));
  for (const name of ['bytes_received', 'bytes_written', 'bytes_verified']) assert.equal(value[name], image.length);
  assert.deepEqual(await readFile(item.output), image); assert.equal((await stat(item.output)).mode & 0o777, 0o600);
  assert.equal(value.injected, false); assert.equal(value.locked, false); assert.equal(value.current, true); assert.equal(value.restored_current, true);
  assert.equal(value.finishes, 1); assert.equal(value.aborts, 0);
  await record(item); t.diagnostic('证据目录：' + directory);
});
for (const [mode, checkpoints] of [['leaf', ['read', 'verify']], ['ca', ['read', 'verify']], ['clock', ['before', 'read', 'write', 'verify']]]) {
  for (const checkpoint of checkpoints) test(`OTA传输跨凭据失效：${mode}/${checkpoint}，冻结后零新增I/O或验证证明`, { timeout: 20000 }, async t => {
    const item = await run(mode, checkpoint), value = item.value;
    assert.notEqual(value.code, 0); assert.equal(value.issue, 'ota_transfer_authorization_lost');
    assert.equal(value.image_verified, false); assert.equal(value.image_sha256, '');
    assert.equal(value.injected, true); assert.equal(value.observed_invalidation, true);
    assert.equal(value.current, false); assert.equal(value.locked, true); assert.equal(value.restored_current, false);
    assert.notEqual(value.retry_code, 0); assert.equal(value.retry_issue, 'ota_transfer_authorization_lost'); assert.equal(value.retry_verified, false); assert.equal(value.zero_retry_io, true);
    assert.equal(value.writes, value.writes_at_gate); assert.equal(value.reads, value.reads_at_gate); assert.equal(value.verifies, value.verifies_at_gate);
    assert.equal(value.can_reopen, mode === 'clock');
    if (mode === 'ca') assert.equal(value.leaf_still_valid, true, 'CA到期时叶证书本身仍有效');
    if (mode !== 'clock') assert(Date.now() >= item.expiry, '使用真实墙钟跨过证书有效期，不改系统时钟');
    if (checkpoint === 'before') {
      assert.equal(value.opens, 0); assert.equal(value.aborts, 0);
      await assert.rejects(stat(item.output), { code: 'ENOENT' });
    } else {
      assert.equal(value.opens, 1); assert.equal(value.aborts, 1);
      const staged = await readFile(item.output);
      assert.equal(staged.length, value.bytes_written); assert.deepEqual(staged, image.subarray(0, staged.length));
      if (checkpoint === 'read') { assert.equal(staged.length, 0); assert.equal(value.finishes, 0); }
      if (checkpoint === 'write') { assert(staged.length > 0 && staged.length < image.length); assert.equal(value.finishes, 0); }
      if (checkpoint === 'verify') { assert.equal(staged.length, image.length); assert.equal(value.finishes, 1); assert.equal(value.verifies, 1); assert.equal(value.bytes_verified, 0); }
    }
    await record(item); t.diagnostic('证据目录：' + directory);
  });
}

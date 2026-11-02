import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const f = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
const image = Buffer.from(f.image_base64, 'base64');
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(f.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
let directory, server, origin, evidence;
const requests = [], receipts = [], completed = [], outputByPath = new Map();

function resign(request) {
  const unsigned = structuredClone(request.manifest); delete unsigned.signature;
  const message = Buffer.concat([Buffer.from('LimeIoT Device Firmware v1\n'), Buffer.from(canonicalJSON(unsigned))]);
  request.manifest.signature = sign(null, message, privateKey).toString('base64');
  return request;
}
function input(route, host = origin) {
  const request = structuredClone(f.request);
  request.manifest.statement.download.url = host + route;
  request.trust.download_origins = [host];
  return resign(request);
}
async function run(request, name, { ca = true, env = {} } = {}) {
  const source = path.join(directory, name + '.json'), output = path.join(directory, name);
  await writeFile(source, typeof request === 'string' ? request : JSON.stringify(request));
  if (typeof request !== 'string') outputByPath.set(new URL(request.manifest.statement.download.url).pathname, output);
  const args = ['packages/cli/src/main.mjs', 'ota', 'download', '--input', source, '--output-dir', output];
  if (ca) args.push('--ca-file', path.join(directory, typeof ca === 'string' ? ca : 'ca.crt'));
  let result;
  try {
    result = { ...await exec(process.execPath, args, { cwd: root, timeout: 15000, env: { ...process.env, LIMEIOT_OTA_TOOL: path.join(root, 'target/debug/limeiot-ota'), ...env } }), code: 0 };
  } catch (error) { result = error; }
  if (result.stdout) receipts.push(JSON.parse(result.stdout));
  return { ...result, output, source, request };
}
async function absent(file) { await assert.rejects(stat(file), error => error.code === 'ENOENT'); }

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'limeiot-ota-https-'));
  evidence = path.join(root, '.dev', 'ota-download-' + randomBytes(8).toString('hex'));
  await mkdir(evidence, { mode: 0o700 });
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, hardware: false }), { mode: 0o600 });
  const openssl = args => exec('openssl', args, { cwd: directory, timeout: 15000 });
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=LimeIoT OTA test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(path.join(directory, 'extensions.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'extensions.cnf']);
  server = createServer({ key: await readFile(path.join(directory, 'server.key')), cert: await readFile(path.join(directory, 'server.crt')) }, async (req, res) => {
    try {
      const record = { path: req.url, method: req.method, original_durable_before_get: false, headers: req.headers };
      requests.push(record);
      const output = outputByPath.get(req.url);
      const original = JSON.parse(await readFile(path.join(output, 'request.json'), 'utf8'));
      const receipt = JSON.parse(await readFile(path.join(output, 'receipt.json'), 'utf8'));
      record.original_durable_before_get = receipt.status === 'started' && receipt.request_digest === await documentDigest(original);
      if (req.url === '/redirect') { res.writeHead(302, { Location: origin + '/redirect-target' }); res.end(); return; }
      if (req.url === '/unavailable') { res.writeHead(503); res.end(); return; }
      if (req.url === '/encoded') res.setHeader('Content-Encoding', 'gzip');
      if (req.url === '/range') { res.writeHead(206); res.end(image); return; }
      if (req.url === '/large-header') { res.setHeader('Content-Length', image.length + 1); res.end(Buffer.concat([image, Buffer.from('x')])); return; }
      if (req.url === '/large-chunk') { res.write(Buffer.concat([image, Buffer.from('x')])); res.end(); return; }
      if (req.url === '/truncated') { res.write(image.subarray(0, -1)); res.end(); return; }
      if (req.url === '/disconnect') { res.setHeader('Content-Length', image.length); res.write(image.subarray(0, 1)); res.flushHeaders(); setImmediate(() => res.destroy()); return; }
      if (req.url === '/corrupt') { const bad = Buffer.from(image); bad[0] ^= 255; res.end(bad); return; }
      if (req.url === '/collide') await writeFile(path.join(output, 'firmware.bin'), 'preserve-existing', { mode: 0o600 });
      if (req.url === '/expires' || req.url === '/interrupted') {
        res.setHeader('Content-Length', image.length); res.write(image.subarray(0, 1)); res.flushHeaders();
        if (req.url === '/expires') {
          const timer = setTimeout(() => res.end(image.subarray(1)), 3500);
          res.on('close', () => clearTimeout(timer));
        }
        return;
      }
      res.end(image);
    } catch (error) { res.destroy(error); }
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'https://localhost:' + server.address().port;
});

after(async () => {
  server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  const source_digests = {};
  for (const relative of ['gateway/crates/core/src/ota.rs', 'tools/model-validator/src/ota_download.rs', 'tools/model-validator/src/bin/limeiot-ota.rs', 'contracts/ota.schema.json', 'packages/cli/src/ota.mjs']) {
    source_digests[relative] = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex');
  }
  const durable = requests.length > 0 && requests.every(item => item.original_durable_before_get);
  const headers = requests.every(item => item.method === 'GET' && item.headers['accept-encoding'] === 'identity' && !item.headers.authorization && !item.headers.cookie && !item.headers.range);
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: completed.length === 5 && durable && headers, completed, https_requests: requests.length, original_durable_before_every_get: durable, no_auth_cookie_or_range: headers, source_digests, hardware: false, device_installation: false }, null, 2));
  await writeFile(path.join(evidence, 'receipts.json'), JSON.stringify(receipts, null, 2), { mode: 0o600 });
  console.log('OTA HTTPS evidence: ' + evidence);
  await rm(directory, { recursive: true, force: true });
  assert.equal(durable && headers, true, 'HTTPS request boundaries');
});

test('真实CA验证HTTPS下载，先落原请求、核对完整字节、私有权限且不覆盖旧目录', async () => {
  const request = input('/valid'), result = await run(request, 'success');
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.error, null);
  assert.equal(receipt.request_digest, await documentDigest(request));
  assert.equal(receipt.verification.request_digest, receipt.request_digest);
  assert.equal(receipt.verification.valid, true);
  assert.equal(receipt.bytes_received, image.length);
  assert.deepEqual(await readFile(path.join(result.output, 'firmware.bin')), image);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.output, 'receipt.json'), 'utf8')), receipt);
  assert.deepEqual((await readdir(result.output)).sort(), ['firmware.bin', 'receipt.json', 'request.json']);
  assert.equal((await stat(result.output)).mode & 0o777, 0o700);
  for (const name of await readdir(result.output)) assert.equal((await stat(path.join(result.output, name))).mode & 0o777, 0o600);
  const count = requests.length;
  const again = await run(request, 'success');
  assert.equal(again.code, 4); assert.equal(JSON.parse(again.stderr).error.code, 'ota_output_exists');
  assert.equal(requests.length, count);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.output, 'receipt.json'), 'utf8')), receipt);
  const collision = await run(input('/collide'), 'collision');
  assert.equal(collision.code, 5); assert.equal(JSON.parse(collision.stdout).status, 'failed');
  assert.equal(await readFile(path.join(collision.output, 'firmware.bin'), 'utf8'), 'preserve-existing');
  completed.push('verified_private_artifact_and_no_overwrite');
});

test('重定向、非200、编码、超长、截断、坏摘要和断流均不发布固件且不重试', async () => {
  for (const [route, exit, code] of [
    ['/redirect', 2, 'ota_download_redirect'], ['/unavailable', 5, 'ota_download_http'],
    ['/range', 5, 'ota_download_http'], ['/encoded', 2, 'ota_download_encoding'],
    ['/large-header', 2, 'ota_image_size_mismatch'], ['/large-chunk', 2, 'ota_image_size_mismatch'],
    ['/truncated', 2, 'ota_image_size_mismatch'], ['/corrupt', 2, 'ota_image_digest_mismatch'],
    ['/disconnect', 5, 'ota_download_network'],
  ]) {
    const before = requests.length, result = await run(input(route), route.slice(1));
    assert.equal(result.code, exit, route + result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.error, code);
    assert.equal(requests.length, before + 1, route);
    assert.equal(receipt.bytes_received <= image.length, true);
    await absent(path.join(result.output, 'firmware.bin'));
    assert.deepEqual(JSON.parse(await readFile(path.join(result.output, 'receipt.json'), 'utf8')), receipt);
  }
  assert.equal(requests.some(item => item.path === '/redirect-target'), false);
  completed.push('http_and_image_failures_no_redirect_or_retry');
});

test('错误签名/状态/JSON在创建目录前拒绝；未知CA与主机名拒绝真实TLS', async () => {
  let index = 0;
  for (const change of [
    value => { value.manifest.signature = 'invalid'; },
    value => { value.device.board = 'other-board'; },
    value => { value.trust.revoked_artifact_ids = [value.manifest.statement.artifact_id]; },
    value => { value.device.pending_update = true; },
  ]) {
    const request = input('/rejected'); change(request);
    const before = requests.length, result = await run(request, 'rejected-' + index++);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.equal(requests.length, before); await absent(result.output);
  }
  const malformed = await run('{', 'malformed'); assert.equal(malformed.code, 2); await absent(malformed.output);
  for (const [name, request, options] of [
    ['unknown-ca', input('/unknown-ca'), { ca: false }],
    ['wrong-host', input('/wrong-host', 'https://127.0.0.1:' + server.address().port), {}],
  ]) {
    const before = requests.length, result = await run(request, name, options);
    assert.equal(result.code, 5, result.stderr);
    assert.equal(JSON.parse(result.stdout).error, 'ota_download_network');
    assert.equal(requests.length, before); await absent(path.join(result.output, 'firmware.bin'));
  }
  completed.push('preflight_zero_get_and_verified_tls');
});

test('传输期间清单到期，完成时重新预检并拒绝交付文件', { timeout: 15000 }, async () => {
  const request = input('/expires');
  request.manifest.statement.expires_at = new Date((Math.floor(Date.now() / 1000) + 3) * 1000).toISOString().replace('.000Z', 'Z'); resign(request);
  const result = await run(request, 'expired-during-transfer');
  assert.equal(result.code, 2, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.error, 'ota_outside_validity');
  assert.equal(receipt.bytes_received, image.length); assert.equal(receipt.verification.valid, false);
  await absent(path.join(result.output, 'firmware.bin'));
  completed.push('expiry_rechecked_after_transfer');
});

test('真实进程中断留下开始记录，重新调用同目录零GET且不自动续传', { timeout: 10000 }, async () => {
  const request = input('/interrupted'), source = path.join(directory, 'interrupted.json'), output = path.join(directory, 'interrupted');
  await writeFile(source, JSON.stringify(request)); outputByPath.set('/interrupted', output);
  const child = spawn(path.join(root, 'target/debug/limeiot-ota'), ['download', '--input', source, '--output-dir', output, '--ca-file', path.join(directory, 'ca.crt')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = once(child, 'exit');
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      if (await stat(path.join(output, 'image.part')).then(value => value.size === 1, () => false)) break;
      assert.equal(child.exitCode, null); assert.ok(Date.now() < deadline, 'download did not start'); await delay(10);
    }
    child.kill('SIGTERM'); const [, signal] = await stopped; assert.equal(signal, 'SIGTERM');
    const receipt = JSON.parse(await readFile(path.join(output, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'started'); receipts.push(receipt);
    await absent(path.join(output, 'firmware.bin'));
    const count = requests.length, again = await run(request, 'interrupted');
    assert.equal(again.code, 4); assert.equal(requests.length, count);
    completed.push('process_interruption_no_automatic_resume');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await stopped; } }
});

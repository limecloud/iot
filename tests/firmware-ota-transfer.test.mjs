import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), exec = promisify(execFile);
const image = Buffer.alloc(262145); for (let i = 0; i < image.length; i++) image[i] = (i * 29 + 7) % 251;
const sha256 = 'sha256:' + createHash('sha256').update(image).digest('hex');
let directory, server, origin; const requests = [];
before(async () => {
  directory = path.join(root, '.dev', 'ota-transfer-' + randomUUID()); await mkdir(directory);
  const openssl = args => exec('openssl', args, { cwd: directory, timeout: 10000 });
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=LimeIoT transfer test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(path.join(directory, 'extensions.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'extensions.cnf']);
  server = createServer({ key: await readFile(path.join(directory, 'server.key')), cert: await readFile(path.join(directory, 'server.crt')) }, (req, res) => {
    requests.push({ path: req.url, method: req.method, headers: req.headers });
    if (req.url === '/redirect') { res.writeHead(302, { Location: origin + '/redirect-target' }); res.end(); return; }
    if (req.url === '/status') { res.writeHead(503); res.end(); return; }
    if (req.url === '/range') { res.writeHead(206); res.end(image); return; }
    if (req.url === '/encoded') res.setHeader('Content-Encoding', 'gzip');
    if (req.url === '/length') res.setHeader('Content-Length', image.length + 1);
    if (['/extra', '/truncated', '/missing-length'].includes(req.url)) {
      res.writeHead(200, { Connection: 'close' });
      res.write(req.url === '/extra' ? Buffer.concat([image, Buffer.from('x')]) : req.url === '/truncated' ? image.subarray(0, -1) : image);
      res.end(); return;
    }
    if (req.url === '/disconnect') { res.setHeader('Content-Length', image.length); res.write(image.subarray(0, 512)); res.flushHeaders(); setImmediate(() => res.destroy()); return; }
    if (req.url === '/stall') { res.setHeader('Content-Length', image.length); res.flushHeaders(); return; }
    if (req.url === '/corrupt') { const bad = Buffer.from(image); bad[0] ^= 1; res.end(bad); return; }
    res.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'https://localhost:' + server.address().port;
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
async function run(route = '/ok', options = {}) {
  const name = randomUUID(), input = path.join(directory, name + '.json'), output = path.join(directory, name + '.bin');
  const plan = { url: origin + route, size: image.length, sha256, ca: path.join(directory, 'ca.crt'), ...options };
  await writeFile(input, JSON.stringify(plan)); const beforeCount = requests.length;
  const execution = await exec(path.join(root, '.dev/firmware-host/ota-transfer'), [input, output], { cwd: root, timeout: 8000 });
  assert.equal(execution.stderr, '', execution.stderr);
  return { ...JSON.parse(execution.stdout), output, requests: requests.slice(beforeCount) };
}
function failed(value, issue) {
  assert.equal(value.image_verified, false); assert.equal(value.image_sha256, ''); assert.notEqual(value.code, 0);
  if (issue) assert.equal(value.issue, issue, JSON.stringify(value));
  assert.ok(value.opens <= 1); assert.ok(value.requests.length <= 1); assert.equal(value.closes, value.opens);
}
test('C传输经真实HTTPS有界暂存，完成后回读全部实际字节，摘要与Node一致', async () => {
  for (const route of ['/ok', '/missing-length']) {
    const value = await run(route); assert.equal(value.code, 0, JSON.stringify(value)); assert.equal(value.issue, 'ok');
    assert.equal(value.image_verified, true); assert.equal(value.image_sha256, sha256);
    for (const count of ['bytes_received', 'bytes_written', 'bytes_verified']) assert.equal(value[count], image.length);
    assert.deepEqual(await readFile(value.output), image); assert.equal((await stat(value.output)).mode & 0o777, 0o600);
    assert.ok(value.writes > 256); assert.ok(value.verifies > 256); assert.equal(value.finishes, 1); assert.equal(value.aborts, 0);
    assert.equal(value.requests.length, 1); assert.equal(value.requests[0].method, 'GET'); assert.equal(value.requests[0].headers['accept-encoding'], 'identity');
    for (const header of ['authorization', 'cookie', 'range', 'proxy-authorization']) assert.equal(value.requests[0].headers[header], undefined);
  }
});
test('C传输验证独立CA与主机名，不跟随重定向，不接受错误状态、编码或声明长度', async () => {
  const wrongCA = await run('/ok', { ca: path.join(directory, 'server.crt') }); failed(wrongCA, 'ota_http_unavailable'); assert.equal(wrongCA.begins, 0);
  const wrongHost = await run('/ok', { url: origin.replace('localhost', '127.0.0.1') + '/ok' }); failed(wrongHost, 'ota_http_unavailable'); assert.equal(wrongHost.requests.length, 0);
  for (const route of ['/redirect', '/status', '/range', '/encoded', '/length']) {
    const value = await run(route); failed(value, route === '/length' ? 'ota_http_length_mismatch' : 'ota_http_response_rejected'); assert.equal(value.begins, 0);
  }
  assert.equal(requests.filter(r => r.path === '/redirect-target').length, 0);
});
test('C传输拒绝断流、超长、截断和坏摘要，部分文件不形成验证证明', async () => {
  for (const [route, issue] of [['/extra', 'ota_image_too_long'], ['/truncated', 'ota_image_truncated'], ['/corrupt', 'ota_image_hash_mismatch'], ['/stall', 'ota_http_read_failed']]) {
    const value = await run(route); failed(value, issue); assert.equal(value.aborts, 1); assert.ok(value.bytes_written <= image.length);
  }
  const disconnected = await run('/disconnect'); failed(disconnected); assert.ok(['ota_http_read_failed', 'ota_http_unavailable'].includes(disconnected.issue));
});
test('C传输在存储、原生校验、回读和摘要端口失败时关闭资源且保留失败状态', async () => {
  const cases = { begin: 'ota_staging_unavailable', write: 'ota_staging_write_failed', finish: 'ota_native_image_rejected',
    verify: 'ota_staging_read_failed', 'hash-begin': 'ota_hash_unavailable', 'hash-update': 'ota_hash_failed', 'hash-finish': 'ota_hash_failed',
    'corrupt-write': 'ota_image_hash_mismatch' };
  for (const [fault, issue] of Object.entries(cases)) {
    const value = await run('/ok', { fault }); failed(value, issue); assert.equal(value.aborts, 1);
    if (['corrupt-write', 'hash-finish'].includes(fault)) assert.equal(value.bytes_verified, image.length);
  }
});
test('C传输在授权丢失、总预算超时和时钟倒退时停止，不重试或续传', async () => {
  const cases = { authorization: 'ota_transfer_authorization_lost', 'authorization-write': 'ota_transfer_authorization_lost',
    'authorization-verify': 'ota_transfer_authorization_lost', 'clock-negative': 'ota_transfer_clock_untrusted',
    'clock-backwards': 'ota_transfer_clock_untrusted', timeout: 'ota_transfer_timeout', stalled: 'ota_http_stalled', 'oversized-read': 'ota_http_read_invalid' };
  for (const [fault, issue] of Object.entries(cases)) {
    const value = await run('/ok', { fault }); failed(value, issue);
    if (['authorization', 'clock-negative'].includes(fault)) { assert.equal(value.opens, 0); assert.equal(value.begins, 0); }
    if (fault === 'timeout' || fault === 'clock-backwards') { assert.equal(value.reads, 1); assert.equal(value.writes, 0); }
  }
});
test('C传输输入有界，已有暂存文件保持原样，不自动覆盖或重新安装', async () => {
  for (const options of [{ size: 0 }, { size: 33554433 }, { url: origin.replace('https:', 'http:') + '/ok' }, { sha256: 'invalid' }]) {
    const value = await run('/ok', options); failed(value, 'invalid_ota_transfer'); assert.equal(value.opens, 0); assert.equal(value.begins, 0);
  }
  const name = randomUUID(), input = path.join(directory, name + '.json'), output = path.join(directory, name + '.bin');
  await writeFile(input, JSON.stringify({ url: origin + '/ok', size: image.length, sha256, ca: path.join(directory, 'ca.crt') }));
  await writeFile(output, 'preserve-existing');
  const execution = await exec(path.join(root, '.dev/firmware-host/ota-transfer'), [input, output], { cwd: root, timeout: 8000 });
  const value = JSON.parse(execution.stdout); assert.equal(value.issue, 'ota_staging_unavailable'); assert.equal(value.image_verified, false);
  assert.equal(await readFile(output, 'utf8'), 'preserve-existing');
});

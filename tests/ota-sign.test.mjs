import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, chmod, symlink } from 'node:fs/promises';
import { createServer } from 'node:https';
import { once } from 'node:events';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
const schema = JSON.parse(await readFile(path.join(root, 'contracts/ota-release.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
ajv.addSchema(JSON.parse(await readFile(path.join(root, 'contracts/ota.schema.json'), 'utf8')), 'ota.schema.json');
ajv.addSchema(schema, 'release.schema.json');
const validRecipe = ajv.getSchema('release.schema.json');
const validKey = ajv.compile({ $ref: 'release.schema.json#/$defs/key' });
const validReceipt = ajv.compile({ $ref: 'release.schema.json#/$defs/receipt' });
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function cli(args) {
  try { return { ...await exec(process.execPath, ['packages/cli/src/main.mjs', 'ota', ...args], {
    cwd: root, timeout: 15000, env: { ...process.env, LIMEIOT_OTA_TOOL: path.join(root, 'target/debug/limeiot-ota'), HTTPS_PROXY: 'http://127.0.0.1:1' },
  }), code: 0 }; } catch (error) { return error; }
}
// 有效布局/校验和的字节夹具，不代表真实板卡可启动镜像。
function image(version = '0.2.0', epoch = 1) {
  const header = Buffer.alloc(32), data = Buffer.alloc(256);
  header[0] = 0xe9; header[1] = 1; header.writeUInt16LE(5, 12); header[23] = 1; header.writeUInt32LE(data.length, 28);
  data.writeUInt32LE(0xabcd5432); data.writeUInt32LE(epoch, 4); data.write(version, 16); data.write('limeiot_test', 48);
  const body = Buffer.concat([header, data, Buffer.alloc(16)]);
  body[body.length - 1] = data.reduce((sum, byte) => sum ^ byte, 0xef);
  return Buffer.concat([body, createHash('sha256').update(body).digest()]);
}
async function workspace() {
  const dir = path.join(root, '.dev', 'ota-sign-' + crypto.randomUUID()); await mkdir(dir, { mode: 0o700 });
  const generated = await cli(['keygen', '--output-dir', path.join(dir, 'key')]);
  assert.equal(generated.code, 0, generated.stderr);
  const key = JSON.parse(generated.stdout); assert.equal(validKey(key), true, JSON.stringify(validKey.errors));
  const recipe = { schema: 'limeiot.ota-release', version: 1, image_format: 'esp32c3', target: fixture.request.manifest.statement.target,
    firmware_version: '0.2.0', compatibility: fixture.request.manifest.statement.compatibility, security_epoch: 1,
    download_base_url: 'https://firmware.example.test/artifacts/', issued_at: '2026-11-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' };
  const trust = { ...fixture.request.trust, public_key: key.public_key, signing_key_id: key.signing_key_id };
  await writeFile(path.join(dir, 'recipe.json'), JSON.stringify(recipe));
  await writeFile(path.join(dir, 'trust.json'), JSON.stringify(trust));
  await writeFile(path.join(dir, 'image.bin'), image());
  return { dir, key, recipe, trust };
}
const args = (w, output) => ['sign', '--input', path.join(w.dir, 'recipe.json'), '--trust', path.join(w.dir, 'trust.json'),
  '--key', path.join(w.dir, 'key/private.pk8'), '--image', path.join(w.dir, 'image.bin'), '--output-dir', path.join(w.dir, output)];
async function signed(w, output) {
  const result = await cli(args(w, output)); assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout); assert.equal(validReceipt(receipt), true, JSON.stringify(validReceipt.errors));
  return { receipt, manifest: JSON.parse(await readFile(path.join(w.dir, output, 'manifest.json'), 'utf8')) };
}

test('OTA独立密钥仅落新私有目录，公开描述不自动授信，发现包含签名合同', async () => {
  const w = await workspace();
  assert.equal(validRecipe(w.recipe), true, JSON.stringify(validRecipe.errors));
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(w.dir, 'key'))).mode & 0o777, 0o700);
    for (const name of ['private.pk8', 'public.json']) assert.equal((await stat(path.join(w.dir, 'key', name))).mode & 0o777, 0o600);
  }
  assert.equal(w.key.signing_key_id, hash(Buffer.from(w.key.public_key, 'base64')));
  assert.deepEqual(JSON.parse(await readFile(path.join(w.dir, 'key/public.json'), 'utf8')), w.key);
  const privateBefore = await readFile(path.join(w.dir, 'key/private.pk8'));
  assert.equal((await cli(['keygen', '--output-dir', path.join(w.dir, 'key')])).code, 4);
  assert.deepEqual(await readFile(path.join(w.dir, 'key/private.pk8')), privateBefore);
  const catalog = JSON.parse((await cli(['schema'])).stdout);
  assert.deepEqual(catalog.operations.map(v => v.operation_id), ['ota.verify', 'ota.download', 'ota.keygen', 'ota.sign', 'ota.publish']);
  assert.deepEqual(catalog.schemas.release, schema);
  assert.deepEqual(catalog.schema_resources, { 'ota.schema.json': 'verification', 'ota-release.schema.json': 'release' });
  assert.equal(catalog.operations[3].network, false);
});

test('签名绑定实际镜像/元数据/独立密钥，Node独立验签与正式Rust校验一致，重复不覆盖', async () => {
  const w = await workspace(), a = await signed(w, 'bundle');
  const files = await readdir(path.join(w.dir, 'bundle'));
  assert.deepEqual(files.sort(), ['firmware.bin', 'manifest.json', 'receipt.json', 'release.json']);
  const bytes = await readFile(path.join(w.dir, 'bundle/firmware.bin'));
  assert.deepEqual(bytes, image());
  assert.equal(a.manifest.statement.sha256, hash(bytes)); assert.equal(a.manifest.statement.size_bytes, bytes.length);
  assert.equal(a.receipt.manifest_digest, await documentDigest(a.manifest));
  assert.equal(a.receipt.recipe_digest, await documentDigest(w.recipe));
  const identity = { schema: 'limeiot.ota-artifact-identity', version: 1, signing_key_id: w.key.signing_key_id,
    recipe: w.recipe, size_bytes: bytes.length, sha256: hash(bytes) };
  assert.equal(a.receipt.artifact_id, (await documentDigest(identity)).replace('sha256:', 'artifact-'));
  assert.equal(a.manifest.statement.download.url, w.recipe.download_base_url + a.receipt.artifact_id + '/firmware.bin');
  const unsigned = structuredClone(a.manifest); delete unsigned.signature;
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(w.key.public_key, 'base64')]), type: 'spki', format: 'der' });
  assert.equal(verify(null, Buffer.concat([Buffer.from('LimeIoT Device Firmware v1\n'), Buffer.from(canonicalJSON(unsigned))]), publicKey, Buffer.from(a.manifest.signature, 'base64')), true);
  const verification = { manifest: a.manifest, trust: w.trust, device: fixture.request.device };
  await writeFile(path.join(w.dir, 'verification.json'), JSON.stringify(verification));
  const verified = await cli(['verify', '--input', path.join(w.dir, 'verification.json'), '--image', path.join(w.dir, 'bundle/firmware.bin')]);
  assert.equal(verified.code, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).valid, true);
  const before = await readFile(path.join(w.dir, 'bundle/receipt.json'));
  assert.equal((await cli(args(w, 'bundle'))).code, 4);
  assert.deepEqual(await readFile(path.join(w.dir, 'bundle/receipt.json')), before);
  const repeat = await signed(w, 'same-input'); assert.deepEqual(repeat, a);
  const rotated = JSON.parse((await cli(['keygen', '--output-dir', path.join(w.dir, 'rotated')])).stdout);
  await writeFile(path.join(w.dir, 'trust.json'), JSON.stringify({ ...w.trust, public_key: rotated.public_key, signing_key_id: rotated.signing_key_id }));
  const rotateArgs = args(w, 'rotated-bundle'); rotateArgs[rotateArgs.indexOf('--key') + 1] = path.join(w.dir, 'rotated/private.pk8');
  const rotatedResult = await cli(rotateArgs); assert.equal(rotatedResult.code, 0, rotatedResult.stderr);
  assert.notEqual(JSON.parse(rotatedResult.stdout).artifact_id, a.receipt.artifact_id);
});

test('坏配方、独立信任、版本/原生摘要/长度及私钥条件失败时不产生制品', async () => {
  const w = await workspace(); let n = 0;
  async function rejected(recipe, trust, bytes, code) {
    await writeFile(path.join(w.dir, 'recipe.json'), typeof recipe === 'string' ? recipe : JSON.stringify(recipe));
    await writeFile(path.join(w.dir, 'trust.json'), JSON.stringify(trust)); await writeFile(path.join(w.dir, 'image.bin'), bytes);
    const name = 'rejected-' + n++, result = await cli(args(w, name));
    assert.equal(result.code, 2, result.stderr); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, code); assert.equal(result.stderr.includes(w.dir), false);
    await assert.rejects(stat(path.join(w.dir, name)), { code: 'ENOENT' });
  }
  for (const value of [{ ...w.recipe, extra: true }, { ...w.recipe, version: 2 }, { ...w.recipe, image_format: 'opaque' },
    JSON.stringify(w.recipe).replace('"version":1', '"version":1,"version":1')])
    await rejected(value, w.trust, image(), 'invalid_ota_release_document');
  await rejected(' '.repeat(32769), w.trust, image(), 'ota_input_too_large');
  await rejected(w.recipe, { ...w.trust, public_key: fixture.request.trust.public_key, signing_key_id: fixture.request.trust.signing_key_id }, image(), 'untrusted_ota_key');
  await rejected(w.recipe, { ...w.trust, expires_at: '2026-11-01T00:00:00Z' }, image(), 'ota_trust_outside_validity');
  await rejected(w.recipe, { ...w.trust, download_origins: ['https://different.example.test'] }, image(), 'untrusted_ota_download');
  await rejected(w.recipe, { ...w.trust, minimum_security_epoch: 2 }, image(), 'ota_downgrade_forbidden');
  await rejected(w.recipe, w.trust, image('0.3.0'), 'ota_image_metadata_mismatch');
  await rejected(w.recipe, w.trust, image('0.2.0', 2), 'ota_image_metadata_mismatch');
  const corrupt = image(); corrupt[40] ^= 1;
  for (const bytes of [Buffer.from('not firmware'), image().subarray(0, -1), corrupt, Buffer.concat([image(), Buffer.from('trailing')])])
    await rejected(w.recipe, w.trust, bytes, 'invalid_ota_esp32c3_image');
  await rejected(w.recipe, w.trust, Buffer.alloc(0), 'invalid_ota_image_size');
  if (process.platform !== 'win32') {
    await chmod(path.join(w.dir, 'key/private.pk8'), 0o644);
    await rejected(w.recipe, w.trust, image(), 'ota_private_key_permissions');
    await chmod(path.join(w.dir, 'key/private.pk8'), 0o600);
    await symlink(path.join(w.dir, 'key/private.pk8'), path.join(w.dir, 'key/link.pk8'));
    const linkedArgs = args(w, 'linked'); linkedArgs[linkedArgs.indexOf('--key') + 1] = path.join(w.dir, 'key/link.pk8');
    const linked = await cli(linkedArgs); assert.equal(linked.code, 5); assert.equal(linked.stdout, '');
    await assert.rejects(stat(path.join(w.dir, 'linked')), { code: 'ENOENT' });
  }
});

test('新生成签名制品经真实HTTPS和正式下载器完整验证，已有暂存目录零GET', async () => {
  const w = await workspace(), tls = path.join(w.dir, 'https');
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', tls, '--origin', 'https://127.0.0.1:18443'], { cwd: root });
  let expectedPath, gets = 0;
  const server = createServer({ key: await readFile(path.join(tls, 'tls/server.key')), cert: await readFile(path.join(tls, 'tls/server.crt')) }, async (req, res) => {
    if (req.url !== expectedPath || req.method !== 'GET') { res.writeHead(404).end(); return; }
    gets++; res.end(await readFile(path.join(w.dir, 'bundle/firmware.bin')));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = 'https://127.0.0.1:' + server.address().port;
    w.recipe.download_base_url = origin + '/artifacts/'; w.trust.download_origins = [origin];
    await writeFile(path.join(w.dir, 'recipe.json'), JSON.stringify(w.recipe)); await writeFile(path.join(w.dir, 'trust.json'), JSON.stringify(w.trust));
    const signedBundle = await signed(w, 'bundle'); expectedPath = new URL(signedBundle.manifest.statement.download.url).pathname;
    await writeFile(path.join(w.dir, 'request.json'), JSON.stringify({ manifest: signedBundle.manifest, trust: w.trust, device: fixture.request.device }));
    const downloadArgs = ['download', '--input', path.join(w.dir, 'request.json'), '--output-dir', path.join(w.dir, 'download'), '--ca-file', path.join(tls, 'authority/ca.crt')];
    const downloaded = await cli(downloadArgs); assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.equal(JSON.parse(downloaded.stdout).status, 'verified'); assert.equal(gets, 1);
    assert.deepEqual(await readFile(path.join(w.dir, 'download/firmware.bin')), image());
    assert.equal((await cli(downloadArgs)).code, 4); assert.equal(gets, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

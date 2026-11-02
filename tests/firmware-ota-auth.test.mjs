import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';
const root = path.resolve(import.meta.dirname, '..'), exec = promisify(execFile);
const fixture = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(fixture.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
const domain = 'LimeIoT Device Firmware v1\n';
function signed(value, prefix = domain) {
  const manifest = structuredClone(value); delete manifest.signature;
  return { ...manifest, signature: sign(null, Buffer.from(prefix + canonicalJSON(manifest)), key).toString('base64') };
}
async function workspace(run) {
  const directory = path.join(root, '.dev', 'ota-auth-' + crypto.randomUUID()); await mkdir(directory);
  await run(directory);
}
async function authenticate(directory, raw, expected = true, { publicKey = fixture.request.trust.public_key, fingerprint = fixture.request.trust.signing_key_id, failure } = {}) {
  const filename = path.join(directory, 'manifest.json'); await writeFile(filename, raw);
  let result;
  try { result = await exec(path.join(root, '.dev/firmware-host/ota-auth'), [filename, publicKey, fingerprint, ...(failure ? [failure] : [])], { cwd: root, timeout: 5000 }); }
  catch (error) { result = error; }
  assert.equal(result.code ?? 0, expected ? 0 : 2, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout); assert.equal(output.authenticated, expected);
  if (expected) {
    assert.equal(output.manifest_digest, await documentDigest(JSON.parse(raw)));
    assert.equal(output.signing_key_id, fingerprint);
  } else {
    assert.equal(output.proof_cleared, true); assert.equal(output.manifest_digest, ''); assert.equal(output.signing_key_id, '');
  }
  return output;
}
test('C签名域及完整清单摘要与正式Node/Rust向量一致，ASan/UBSan无异常', async () => workspace(async directory => {
  await authenticate(directory, JSON.stringify(fixture.request.manifest));
  await writeFile(path.join(directory, 'request.json'), JSON.stringify(fixture.request));
  await writeFile(path.join(directory, 'image.bin'), Buffer.from(fixture.image_base64, 'base64'));
  const result = await exec(path.join(root, 'target/debug/limeiot-ota'), ['verify', '--input', path.join(directory, 'request.json'), '--image', path.join(directory, 'image.bin')], { cwd: root, timeout: 5000 });
  assert.equal(JSON.parse(result.stdout).valid, true);
}));
test('C递归规范化对象/数组、转义和安全整数，字段顺序与JSON空白不改变签名', async () => workspace(async directory => {
  const value = structuredClone(fixture.request.manifest);
  // 仅验签层的规范化向量；扩展statement不属于可安装固件Schema。
  value.statement.canonical_fixture = [{ z: 9007199254740991, a: [{ b: -9007199254740991, a: 0 }, true, false, null] }, { escape: '\u001f\b\t\n\f\r\\"/' }];
  const manifest = signed(value);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, value]) => [key, reverse(value)])) : value;
  await authenticate(directory, JSON.stringify(reverse(manifest), null, 2));
  await authenticate(directory, JSON.stringify(manifest).replace('device-firmware', '\\u0064evice-firmware'));
  const zero = structuredClone(fixture.request.manifest); zero.statement.security_epoch = 0;
  await authenticate(directory, JSON.stringify(signed(zero)).replace('"security_epoch":0', '"security_epoch":-0'));
}));
test('错误公钥/指纹、跨签名域、篡改和不可用密码学端口均拒绝且清空证明', async () => workspace(async directory => {
  const raw = JSON.stringify(fixture.request.manifest);
  await authenticate(directory, raw.replace('0.2.0', '9.0.0'), false);
  await authenticate(directory, raw, false, { fingerprint: 'sha256:' + '0'.repeat(64) });
  await authenticate(directory, raw, false, { publicKey: Buffer.alloc(32, 7).toString('base64') });
  await authenticate(directory, raw, false, { failure: 'hash-fail' });
  await authenticate(directory, raw, false, { failure: 'verify-fail' });
  await authenticate(directory, JSON.stringify(signed(fixture.request.manifest, 'LimeIoT Model Artifact v1\n')), false);
  await authenticate(directory, JSON.stringify({ ...fixture.request.manifest, trust: fixture.request.trust }), false);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const badPad = structuredClone(fixture.request.manifest);
  badPad.signature = badPad.signature.slice(0, 85) + alphabet[alphabet.indexOf(badPad.signature[85]) + 1] + '==';
  await authenticate(directory, JSON.stringify(badPad), false);
  const publicKey = fixture.request.trust.public_key;
  await authenticate(directory, raw, false, { publicKey: publicKey.slice(0, 42) + alphabet[alphabet.indexOf(publicKey[42]) + 1] + '=' });
}));
test('重复键、非法JSON词法、Unicode、深度/节点/字节越界保持拒绝', async () => workspace(async directory => {
  const raw = JSON.stringify(fixture.request.manifest);
  for (const invalid of [raw + '\0', raw + ' trailing', raw.replace('"version":1', '"version":01'), raw.replace('"version":1', '"version":1.0'), raw.replace('"version":1', '"version":1e0'),
    raw.replace('"kind":"device-firmware"', '"kind":"device-firmware","kind":"device-firmware"'), raw.replace('"schema":', '"schema":"limeiot.ota-manifest","schema":'),
    raw.replace('device-firmware', '\\u0000device-firmware'), ' '.repeat(16385) + raw]) await authenticate(directory, invalid, false);
  for (const extra of [Array(2100).fill(0), { text: '中文' }, { text: '\ud800' }, { number: 9007199254740992 }, { number: 1.5 }]) {
    const manifest = structuredClone(fixture.request.manifest); manifest.statement.fixture = extra;
    await authenticate(directory, JSON.stringify(signed(manifest)), false);
  }
  let nested = {};
  for (let i = 0; i < 20; i++) nested = { nested };
  const deep = structuredClone(fixture.request.manifest); deep.statement.fixture = nested;
  await authenticate(directory, JSON.stringify(signed(deep)), false);
}));

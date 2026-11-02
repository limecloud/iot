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
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(fixture.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
function signed(manifest) {
  const value = structuredClone(manifest); delete value.signature;
  return { ...value, signature: sign(null, Buffer.from('LimeIoT Device Firmware v1\n' + canonicalJSON(value)), privateKey).toString('base64') };
}
async function workspace(run) {
  const directory = path.join(root, '.dev', 'ota-policy-' + crypto.randomUUID()); await mkdir(directory);
  await writeFile(path.join(directory, 'image.bin'), Buffer.from(fixture.image_base64, 'base64'));
  await run(directory);
}
async function invoke(command, args) {
  try { return { ...(await exec(command, args, { cwd: root, timeout: 5000 })), code: 0 }; }
  catch (error) { return error; }
}
async function check(directory, change = () => {}, expected = 'ok', options = {}) {
  const request = structuredClone(fixture.request); change(request);
  request.manifest = options.unsigned ? request.manifest : signed(request.manifest);
  const local = { trust: request.trust, device: request.device, now: Date.parse('2026-11-02T00:00:00Z') / 1000,
    trust_not_before: Date.parse(request.trust.not_before) / 1000, trust_expires_at: Date.parse(request.trust.expires_at) / 1000, ...options.local };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(request.manifest));
  await writeFile(path.join(directory, 'local.json'), JSON.stringify(local));
  const result = await invoke(path.join(root, '.dev/firmware-host/ota-policy'), [path.join(directory, 'manifest.json'), path.join(directory, 'local.json')]);
  assert.equal(result.stderr, '', result.stderr);
  assert.equal(result.code, expected === 'ok' ? 0 : 2, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.issue, expected); assert.equal(output.accepted, expected === 'ok');
  if (expected === 'ok') {
    assert.equal(output.candidate_cleared, false);
    assert.equal(output.device_reads, 1); assert.equal(output.clock_reads, 1);
    assert.equal(output.manifest_digest, await documentDigest(request.manifest));
    assert.equal(output.artifact_id, request.manifest.statement.artifact_id);
    assert.equal(output.version, request.manifest.statement.version);
    assert.equal(output.download_url, request.manifest.statement.download.url);
    assert.equal(output.image_sha256, request.manifest.statement.sha256);
    assert.equal(output.size_bytes, request.manifest.statement.size_bytes);
    assert.equal(output.security_epoch, request.manifest.statement.security_epoch);
    assert.equal(output.issued_at, Date.parse(request.manifest.statement.issued_at) / 1000);
    assert.equal(output.expires_at, Date.parse(request.manifest.statement.expires_at) / 1000);
  } else {
    assert.equal(output.candidate_cleared, true, '失败必须清空预先填充的整个候选对象');
    assert.equal(output.manifest_digest, ''); assert.equal(output.download_url, '');
  }
  if (options.rust) {
    await writeFile(path.join(directory, 'request.json'), JSON.stringify(request));
    const rust = await invoke(path.join(root, 'target/debug/limeiot-ota'), ['verify', '--input', path.join(directory, 'request.json'), '--image', path.join(directory, 'image.bin')]);
    assert.equal(rust.stderr, ''); assert.equal(rust.code, expected === 'ok' ? 0 : 2, rust.stdout);
    assert.equal(JSON.parse(rust.stdout).valid, expected === 'ok');
  }
  return output;
}
test('设备预检使用正式签名和本机读数，输出完整候选且与Rust校验一致', async () => workspace(async dir => {
  await check(dir, () => {}, 'ok', { rust: true });
  await check(dir, r => { r.manifest.statement.version = '0.10.0'; r.device.firmware_version = '0.9.0'; r.manifest.statement.compatibility.from_versions = ['0.9.0']; }, 'ok', { rust: true });
  await check(dir, r => { r.manifest.statement.version = '4294967295.4294967295.4294967295'; r.manifest.statement.security_epoch = 4294967295; }, 'ok', { rust: true });
  const rejected = await check(dir, r => { r.manifest.statement.version = '0.3.0'; }, 'invalid_ota_signature', { unsigned: true, rust: true });
  assert.equal(rejected.device_reads, 0); assert.equal(rejected.clock_reads, 0);
}));
test('有效签名不能绕过完整statement结构、字段类型、数组唯一性与版本值域', async () => workspace(async dir => {
  for (const field of Object.keys(fixture.request.manifest.statement)) {
    const result = await check(dir, r => { delete r.manifest.statement[field]; }, 'invalid_ota_manifest', { rust: true });
    assert.equal(result.device_reads, 0);
  }
  for (const change of [
    r => { r.manifest.statement.extra = true; }, r => { r.manifest.statement.kind = 'gateway'; },
    r => { r.manifest.statement.size_bytes = 0; }, r => { r.manifest.statement.size_bytes = 33554433; },
    r => { r.manifest.statement.security_epoch = -1; }, r => { r.manifest.statement.security_epoch = 4294967296; },
    r => { r.manifest.statement.sha256 = 'sha256:' + 'A'.repeat(64); },
    r => { r.manifest.statement.version = '01.2.0'; }, r => { r.manifest.statement.version = '4294967296.0.0'; },
    r => { r.manifest.statement.artifact_id = null; }, r => { r.manifest.statement.target = null; },
  ]) {
    // target自身的缺失/错误类型归为目标结构错误，其他为清单错误。
    const sample = structuredClone(fixture.request); change(sample);
    await check(dir, change, sample.manifest.statement.target === null ? 'invalid_ota_target' : 'invalid_ota_manifest', { rust: true });
  }
  for (const [object, expected] of [['target', 'invalid_ota_target'], ['compatibility', 'invalid_ota_compatibility'], ['download', 'untrusted_ota_download']]) {
    await check(dir, r => { r.manifest.statement[object].extra = 0; }, expected, { rust: true });
    for (const name of Object.keys(fixture.request.manifest.statement[object]))
      await check(dir, r => { delete r.manifest.statement[object][name]; }, expected, { rust: true });
  }
  for (const [object, field, expected] of [['target', 'hardware_revisions', 'invalid_ota_target'], ['compatibility', 'model_revisions', 'invalid_ota_compatibility'], ['compatibility', 'from_versions', 'invalid_ota_compatibility']]) {
    for (const value of [[], null, [1], Array(17).fill('bad'), Array(2).fill(fixture.request.manifest.statement[object][field][0])])
      await check(dir, r => { r.manifest.statement[object][field] = value; }, expected, { rust: true });
  }
  await check(dir, r => { r.manifest.statement.compatibility.protocol_version = 2; }, 'invalid_ota_compatibility', { rust: true });
  await check(dir, r => { r.manifest.statement.compatibility.from_versions.push('0.2.0'); }, 'invalid_ota_compatibility', { rust: true });
}));
test('设备目标、模型、升级路径、引导程序及安全代次从本机精确匹配', async () => workspace(async dir => {
  for (const field of ['product_id', 'architecture', 'chip', 'board', 'hardware_revision'])
    await check(dir, r => { r.device[field] = 'different'; }, 'ota_target_mismatch', { rust: true });
  await check(dir, r => { r.device.model_revision = 'sha256:' + '0'.repeat(64); }, 'ota_device_incompatible', { rust: true });
  await check(dir, r => { r.device.firmware_version = '0.0.9'; }, 'ota_device_incompatible', { rust: true });
  await check(dir, r => { r.device.bootloader_version = '0.0.9'; }, 'ota_device_incompatible', { rust: true });
  await check(dir, r => { r.device.security_epoch = 2; }, 'ota_downgrade_forbidden', { rust: true });
  await check(dir, r => { r.trust.minimum_security_epoch = 2; }, 'ota_downgrade_forbidden', { rust: true });
  await check(dir, r => { r.device.ota_capacity_bytes = 29; }, 'ota_partition_too_small', { rust: true });
  await check(dir, r => { r.device.ota_capacity_bytes = 30; }, 'ok', { rust: true });
  for (const change of [r => { r.device.product_id = ''; }, r => { r.device.model_revision = 'invalid'; }, r => { r.device.firmware_version = '01.0.0'; }, r => { r.device.ota_capacity_bytes = 0; }])
    await check(dir, change, 'invalid_ota_device', { rust: true });
}));
test('电源、忙碌和读取失败保持拒绝，不推断未知电量或可升级状态', async () => workspace(async dir => {
  await check(dir, r => { r.device.external_power = false; }, 'ota_insufficient_power', { rust: true });
  await check(dir, r => { r.device.external_power = false; r.device.battery_percent = 29; }, 'ota_insufficient_power', { rust: true });
  await check(dir, r => { r.device.external_power = false; r.device.battery_percent = 30; }, 'ok', { rust: true });
  await check(dir, r => { r.device.battery_percent = 0; }, 'ok', { rust: true });
  await check(dir, r => { r.device.battery_percent = 101; }, 'invalid_ota_device', { rust: true });
  await check(dir, r => { r.device.safe_to_update = false; }, 'ota_device_busy', { rust: true });
  await check(dir, r => { r.device.pending_update = true; }, 'ota_device_busy', { rust: true });
  await check(dir, () => {}, 'ota_device_unavailable', { local: { fault: 'device-unavailable' } });
  await check(dir, () => {}, 'clock_untrusted', { local: { fault: 'clock-untrusted' } });
  const expired = await check(dir, () => {}, 'ota_outside_validity', { local: { fault: 'expire-during-device-read' } });
  assert.equal(expired.device_reads, 1); assert.equal(expired.clock_reads, 1);
}));
test('独立策略覆盖产品范围、撤销、有效期、唯一列表和必需本机端口', async () => workspace(async dir => {
  await check(dir, r => { r.trust.product_ids = ['other-product']; }, 'untrusted_ota_product', { rust: true });
  await check(dir, r => { r.trust.revoked_artifact_ids = [r.manifest.statement.artifact_id]; }, 'ota_artifact_revoked', { rust: true });
  for (const field of ['product_ids', 'download_origins']) {
    await check(dir, r => { r.trust[field] = []; }, 'invalid_ota_policy', { rust: true });
    await check(dir, r => { r.trust[field].push(r.trust[field][0]); }, 'invalid_ota_policy', { rust: true });
  }
  await check(dir, r => { r.trust.revoked_artifact_ids = ['artifact-' + '0'.repeat(64), 'artifact-' + '0'.repeat(64)]; }, 'invalid_ota_policy', { rust: true });
  await check(dir, r => { r.trust.minimum_battery_percent = 101; }, 'invalid_ota_policy', { rust: true });
  for (const fault of ['no-clock-port', 'no-device-port', 'no-identity', 'no-products', 'no-origins', 'no-revocations'])
    await check(dir, () => {}, 'invalid_ota_policy', { local: { fault } });
  await check(dir, () => {}, 'invalid_ota_signature', { local: { fault: 'no-key' } });
  for (const local of [{ trust_not_before: -1 }, { trust_not_before: 4102444800 }, { trust_expires_at: 253402300800 }])
    await check(dir, () => {}, 'invalid_ota_policy', { local });
}));
test('规范UTC整秒、闰年和完整信任有效期有边界检查，读取时失效不能沿用旧通过', async () => workspace(async dir => {
  for (const value of ['2026-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2026-11-31T00:00:00Z', '2026-11-01T24:00:00Z', '2026-11-01T00:00:60Z', '2026-11-01T00:00:00+00:00', '2026-11-01T00:00:00.000Z', '1969-12-31T23:59:59Z'])
    await check(dir, r => { r.manifest.statement.issued_at = value; }, 'invalid_ota_manifest', { rust: true });
  await check(dir, r => { r.manifest.statement.issued_at = r.trust.not_before; r.manifest.statement.expires_at = r.trust.expires_at; }, 'ok', { rust: true });
  await check(dir, r => { r.manifest.statement.issued_at = '2025-12-31T23:59:59Z'; }, 'invalid_ota_validity', { rust: true });
  await check(dir, r => { r.manifest.statement.expires_at = '2100-01-01T00:00:01Z'; }, 'invalid_ota_validity', { rust: true });
  await check(dir, r => { r.manifest.statement.expires_at = r.manifest.statement.issued_at; }, 'invalid_ota_validity', { rust: true });
  const issued = Date.parse(fixture.request.manifest.statement.issued_at) / 1000, expires = Date.parse(fixture.request.manifest.statement.expires_at) / 1000;
  for (const now of [issued, expires-1]) await check(dir, () => {}, 'ok', { local: { now } });
  for (const now of [issued-1, expires]) await check(dir, () => {}, 'ota_outside_validity', { local: { now } });
  for (const now of [-1, 253402300800]) await check(dir, () => {}, 'clock_untrusted', { local: { now } });
  for (const issued_at of ['2028-02-29T12:34:56Z', '2000-02-29T00:00:00Z', '9999-12-30T23:59:59Z']) {
    const expiry = issued_at.startsWith('9999') ? '9999-12-31T23:59:59Z' : '2099-01-01T00:00:00Z';
    await check(dir, r => { r.manifest.statement.issued_at = issued_at; r.manifest.statement.expires_at = expiry; }, 'ok', { local: { now: Date.parse(issued_at)/1000, trust_not_before: 0, trust_expires_at: 253402300799 } });
  }
}));
test('下载精确限定独立HTTPS来源，支持NAS端口与IPv4/IPv6并拒绝规范化歧义', async () => workspace(async dir => {
  for (const origin of ['https://firmware.example.test', 'https://nas.local:8443', 'https://192.168.1.10:8443', 'https://[::1]:8443', 'https://[2001:db8::1]', 'https://[::]', 'https://[2001:db8:0:1:1:1:1:1]', 'https://[1:0:0:2::3]', 'https://[1::2:0:0:3:4]', 'https://[::ffff:c000:201]']) {
    assert.equal(new URL(origin).origin, origin);
    await check(dir, r => { r.trust.download_origins = [origin]; r.manifest.statement.download.url = origin+'/artifacts/fw%20v1.bin'; }, 'ok', { rust: true });
  }
  for (const url of ['http://firmware.example.test/fw.bin', 'https://firmware.example.test.evil/fw.bin', 'https://firmware.example.test:443/fw.bin', 'https://firmware.example.test@evil.test/fw.bin',
    'https://firmware.example.test/', 'https://firmware.example.test/fw.bin?token=x', 'https://firmware.example.test/fw.bin#x', 'https://firmware.example.test/a/../fw.bin',
    'https://firmware.example.test/a/%2e%2E/fw.bin', 'https://firmware.example.test/a/.%2e/fw.bin', 'https://firmware.example.test/a/./fw.bin',
    'https://firmware.example.test/a\\fw.bin', 'https://firmware.example.test/fw name.bin', 'https://firmware.example.test/{fw}.bin', 'https://firmware.example.test/`fw.bin'])
    await check(dir, r => { r.manifest.statement.download.url = url; }, 'untrusted_ota_download', { rust: true });
  await check(dir, r => { r.manifest.statement.download.redirects = true; }, 'untrusted_ota_download', { rust: true });
  for (const origin of ['https://Firmware.example.test', 'https://firmware.example.test:443', 'https://nas.local:08443', 'https://nas.local:65536', 'https://nas.local:',
    'https://127.1', 'https://0177.0.0.1', 'https://0x7f000001', 'https://256.1.1.1', 'https://192.168.1.1.',
    'https://[2001:0db8::1]', 'https://[2001:DB8::1]', 'https://[1:0:0:2:0:0:0:3]', 'https://[1:0:0:2:0:0:3:4]', 'https://[1::2::3]', 'https://[:::]', 'https://[1:2:3:4:5:6:7:8:9]'])
    await check(dir, r => { r.trust.download_origins = [origin]; r.manifest.statement.download.url = origin+'/fw.bin'; }, 'invalid_ota_policy', { rust: true });
}));

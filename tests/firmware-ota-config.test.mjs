import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), exec = promisify(execFile);
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
async function workspace(run) {
  const directory = path.join(root, '.dev', 'ota-config-' + crypto.randomUUID()); await mkdir(directory);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(vector.request.manifest));
  await writeFile(path.join(directory, 'local.json'), JSON.stringify({ ...vector.request, now: Date.parse('2026-11-02T00:00:00Z')/1000,
    trust_not_before: Date.parse(vector.request.trust.not_before)/1000, trust_expires_at: Date.parse(vector.request.trust.expires_at)/1000 }));
  await run(directory);
}
async function decoded(dir, raw, expected, validPolicy = true) {
  await writeFile(path.join(dir, 'trust.json'), raw);
  let result;
  try { result = { ...(await exec(path.join(root, '.dev/firmware-host/ota-policy'), ['manifest.json', 'local.json', 'trust.json'], { cwd: dir, timeout: 5000 })), code: 0 }; }
  catch (error) { result = error; }
  assert.equal(result.stderr, '', result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(result.code, expected === 'ok' ? 0 : 2, result.stdout);
  assert.equal(output.issue, expected); assert.equal(output.trust_decoded, validPolicy);
  assert.equal(output.null_policy_accessor, true);
  assert.equal(output.candidate_cleared, expected !== 'ok');
  return output;
}
test('完整本地trust解码拥有输入内容，重建后执行相同预检且保留撤销与来源限制', async () => workspace(async dir => {
  await decoded(dir, JSON.stringify(vector.request.trust, null, 2), 'ok');
  const revoked = structuredClone(vector.request.trust); revoked.revoked_artifact_ids = [vector.request.manifest.statement.artifact_id];
  const result = await decoded(dir, JSON.stringify(revoked), 'ota_artifact_revoked');
  assert.equal(result.device_reads, 0);
  const other = structuredClone(vector.request.trust); other.download_origins = ['https://nas.local:8443'];
  await decoded(dir, JSON.stringify(other), 'untrusted_ota_download');
  const epoch = structuredClone(vector.request.trust); epoch.minimum_security_epoch = 2;
  await decoded(dir, JSON.stringify(epoch), 'ota_downgrade_forbidden');
  const expired = structuredClone(vector.request.trust); expired.expires_at = '2026-11-01T00:00:00Z';
  await decoded(dir, JSON.stringify(expired), 'invalid_ota_validity');
}));
test('完整本地trust严格拒绝缺失/未知字段、坏密钥、非法范围、列表和有效期', async () => workspace(async dir => {
  for (const name of Object.keys(vector.request.trust)) {
    const trust = structuredClone(vector.request.trust); delete trust[name];
    await decoded(dir, JSON.stringify(trust), 'invalid_ota_policy', false);
  }
  for (const change of [
    t => { t.extra = 0; }, t => { t.schema = 'limeiot.model-trust'; }, t => { t.version = true; }, t => { t.version = 2; }, t => { t.purpose = 'model'; },
    t => { t.signing_key_id = 'sha256:'+'0'.repeat(64); }, t => { t.public_key = null; }, t => { t.public_key += ' '; },
    t => { t.minimum_security_epoch = -1; }, t => { t.minimum_security_epoch = 4294967296; },
    t => { t.minimum_battery_percent = true; }, t => { t.minimum_battery_percent = 101; },
    t => { t.product_ids = []; }, t => { t.product_ids = [null]; }, t => { t.product_ids = Array(17).fill('p'); },
    t => { t.product_ids.push(t.product_ids[0]); }, t => { t.product_ids = ['中文']; },
    t => { t.download_origins = []; }, t => { t.download_origins = ['https://0x']; }, t => { t.download_origins = ['https://[0:0:0:0:0:0:0:1]']; },
    t => { t.download_origins = Array(9).fill('https://nas.local'); }, t => { t.revoked_artifact_ids = null; },
    t => { t.revoked_artifact_ids = Array(129).fill('artifact-'+'0'.repeat(64)); },
    t => { t.revoked_artifact_ids = ['artifact-'+'0'.repeat(64), 'artifact-'+'0'.repeat(64)]; },
    t => { t.not_before = '2026-02-29T00:00:00Z'; }, t => { t.expires_at = t.not_before; },
  ]) {
    const trust = structuredClone(vector.request.trust); change(trust);
    await decoded(dir, JSON.stringify(trust), 'invalid_ota_policy', false);
  }
}));
test('本地策略JSON拒绝重复键、尾随数据、NUL、数字词法和字节上限，接受完整撤销列表', async () => workspace(async dir => {
  const raw = JSON.stringify(vector.request.trust);
  for (const invalid of [raw+'\0', raw+' trailing', raw.replace('"version":1', '"version":1.0'), raw.replace('"version":1', '"version":1e0'),
    raw.replace('"schema":', '"schema":"limeiot.ota-trust","schema":'), raw.replace('"product_ids":', '"product_ids":[],"product_ids":'),
    raw.replace('device-firmware', '\\u0000device-firmware'), ' '.repeat(16385)+raw])
    await decoded(dir, invalid, 'invalid_ota_policy', false);
  const maximum = structuredClone(vector.request.trust);
  maximum.product_ids = Array.from({ length: 16 }, (_, i) => i ? 'product-'+i : maximum.product_ids[0]);
  maximum.download_origins = Array.from({ length: 8 }, (_, i) => i ? 'https://nas'+i+'.local:8443' : maximum.download_origins[0]);
  maximum.revoked_artifact_ids = Array.from({ length: 128 }, (_, i) => 'artifact-'+i.toString(16).padStart(64, '0'));
  assert.ok(JSON.stringify(maximum).length > 3999, '策略必须覆盖NVS单条字符串放不下的长度');
  await decoded(dir, JSON.stringify(maximum), 'ok');
}));

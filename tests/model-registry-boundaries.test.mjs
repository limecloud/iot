import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parseModelChange, verifyModelOperation, verifyPublisherTrust, verifyModelInstallation, verifyModelBinding } from '../packages/protocol/model-registry.mjs';

const exec = promisify(execFile), vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/model-release.json'), 'utf8'));
const change = { type: 'trust.add', trust: vector.trust, expected_signing_key_id: vector.trust.signing_key_id };
async function operation(key = 'original') {
  const request = { space_id: 'space', idempotency_key: key, change };
  return { operation_id: 'modelop-original', request, request_digest: await documentDigest(request), status: 'applied', reason: null,
    result: { type: 'trust', value: { trust_id: 'trust-' + (await documentDigest(vector.trust)).slice(7), revision: 'revision', trust: vector.trust, active: true, created_at: '2026-01-01T00:00:00Z', revoked_at: null } }, created_at: '2026-01-01T00:00:00Z' };
}

test('本地模型输入拒绝重复键、缺少显式空基线及未知动作', () => {
  assert.deepEqual(parseModelChange(JSON.stringify(change)), change);
  for (const value of [{ type: 'models.install', trust_id: 'trust-' + 'a'.repeat(64), artifact: vector.artifact }, { ...change, extra: true }, { type: 'device.install' }]) assert.throws(() => parseModelChange(JSON.stringify(value)));
  assert.throws(() => parseModelChange('{"type":"trust.add","type":"trust.revoke"}'));
});

test('本地模型决定绑定完整原请求，拒绝伪造成功、跨空间及错误资源', async () => {
  const good = await operation(); await verifyModelOperation(good, good.request);
  for (const edit of [v => { v.request.space_id = 'other'; }, v => { v.request_digest = 'sha256:' + '0'.repeat(64); }, v => { v.result.value.trust_id = 'trust-' + '0'.repeat(64); }, v => { v.result.value.active = false; }, v => { v.status = 'rejected'; }, v => { delete v.reason; }]) {
    const bad = structuredClone(good); edit(bad); await assert.rejects(verifyModelOperation(bad, good.request));
  }
  const trust = good.result.value; await verifyPublisherTrust(trust);
  const installation = { trust_id: trust.trust_id, artifact: vector.artifact, installed_at: good.created_at };
  installation.installation_id = 'install-' + (await documentDigest({ artifact: installation.artifact, trust_id: installation.trust_id })).slice(7);
  await verifyModelInstallation(installation);
  await assert.rejects(verifyModelInstallation({ ...installation, installation_id: 'install-' + '1'.repeat(64) }));
  verifyModelBinding({ device_id: 'device', model_revision: null, binding: null, trust_active: false }, 'device');
  assert.throws(() => verifyModelBinding({ device_id: 'device', model_revision: null, binding: null, trust_active: true }, 'device'));
});

test('模型CLI原记录失败零发送，丢响应后旧create只GET，404不补发且异参拒绝', { timeout: 25000 }, async t => {
  let writes = 0, reads = 0, saved;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { writes++; saved = await operation(req.headers['idempotency-key']); req.resume(); req.socket.destroy(); return; }
    reads++;
    if (reads === 1) { res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'model_operation_not_found' } })); }
    else res.end(JSON.stringify(saved));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const directory = path.join(root, '.dev', 'registry-boundary-' + randomBytes(8).toString('hex'));
  await mkdir(directory, { recursive: true });
  const input = path.join(directory, 'input.json'), blocked = path.join(directory, 'blocked');
  await writeFile(input, JSON.stringify(change)); await writeFile(blocked, 'regular-file');
  const env = { ...process.env, LIMEIOT_TOKEN: 'test-owner', LIMEIOT_ENDPOINT: 'http://127.0.0.1:' + server.address().port }; delete env.LIMEIOT_TOKEN_FILE;
  async function cli(state, code) {
    let result; try { result = await exec(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'model-changes.create', '--space-id', 'space', '--idempotency-key', 'original', '--state-dir', state, '--input', input], { cwd: root, env, timeout: 6000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, code, result.stderr); return result;
  }
  await cli(blocked, 5); assert.equal(writes, 0);
  const state = path.join(directory, 'state');
  await cli(state, 6); assert.equal(writes, 1);
  await cli(state, 6); assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(JSON.parse((await cli(state, 0)).stdout).operation_id, saved.operation_id); assert.equal(writes, 1);
  await writeFile(input, JSON.stringify({ ...change, expected_signing_key_id: 'sha256:' + '0'.repeat(64) }));
  await cli(state, 4); assert.equal(writes, 1); assert.equal(reads, 2);
  saved = { ...saved, result: { type: 'trust', value: { ...saved.result.value, active: false } } };
  await writeFile(input, JSON.stringify(change)); await cli(state, 6); assert.equal(writes, 1);
});

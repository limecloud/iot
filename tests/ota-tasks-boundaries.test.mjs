import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parseOtaChange, verifyOtaOperation } from '../packages/protocol/ota-tasks.mjs';
const exec = promisify(execFile), vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
const change = { type: 'trust.add', trust: vector.request.trust, expected_signing_key_id: vector.request.trust.signing_key_id };
async function operation(key = 'original') {
  const request = { space_id: 'space', idempotency_key: key, change };
  return { operation_id: 'otaop-original', request, request_digest: await documentDigest(request), status: 'applied', reason: null,
    resource: { kind: 'firmware_trust', id: 'fwtrust-' + (await documentDigest(change.trust)).slice(7), revision: 'revision' }, created_at: '2026-11-02T00:00:00Z' };
}
test('OTA变更Schema严格编译、共享固件定义一致，完整输入与未知字段正反例', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/ota-tasks.schema.json'), 'utf8'));
  const ota = JSON.parse(await readFile(path.join(root, 'contracts/ota.schema.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8'));
  assert.deepEqual(catalog.schemas['ota-change'], schema);
  for (const [name, definition] of Object.entries(ota.$defs)) if (!['download-receipt', 'report'].includes(name)) assert.deepEqual(schema.$defs[name], definition);
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  const trusted = (await operation()).resource.id;
  for (const value of [change,
    { type: 'trust.revoke', trust_id: trusted, expected_revision: 'rev' },
    { type: 'tasks.plan', device_id: 'device-lamp', trust_id: trusted, manifest: vector.request.manifest, expires_at: '2026-11-02T00:10:00Z' },
    { type: 'tasks.approve', task_id: 'ota-fixture', expected_revision: 'rev' },
    { type: 'tasks.execute', task_id: 'ota-fixture', expected_revision: 'rev' },
    { type: 'tasks.reconcile', task_id: 'ota-fixture', expected_revision: 'rev' },
    { type: 'tasks.cancel', task_id: 'ota-fixture', expected_revision: 'rev' },
  ]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, automatic: true }), false);
    const omitted = structuredClone(value); delete omitted[Object.keys(omitted)[1]]; assert.equal(validate(omitted), false);
  }
  assert.equal(validate({ type: 'device.install', device_id: 'device-lamp' }), false);
  const validateOperation = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/operation' });
  assert.equal(validateOperation(await operation()), true, JSON.stringify(validateOperation.errors));
  assert.deepEqual(parseOtaChange(JSON.stringify(change)), change);
  assert.throws(() => parseOtaChange('{"type":"tasks.approve","type":"trust.revoke"}'));
  assert.throws(() => parseOtaChange('{"type":"tasks.approve","task_id":"ota-x"}'));
  assert.throws(() => parseOtaChange(' '.repeat(16385)));
});
test('OTA原决定核对完整请求、独立信任摘要、资源类型及拒绝状态', async () => {
  const good = await operation(); await verifyOtaOperation(good, good.request);
  for (const edit of [value => { value.request.space_id = 'other'; }, value => { value.request_digest = 'sha256:' + '0'.repeat(64); },
    value => { value.resource.id = 'fwtrust-' + '0'.repeat(64); }, value => { value.resource.kind = 'ota_task'; },
    value => { value.status = 'rejected'; }, value => { delete value.reason; }, value => { value.request.change.expected_signing_key_id = 'sha256:' + '0'.repeat(64); },
  ]) { const bad = structuredClone(good); edit(bad); await assert.rejects(verifyOtaOperation(bad, good.request)); }
});
test('OTA CLI先保存原记录，丢响应/404不补发，异参及伪造恢复拒绝', { timeout: 25000 }, async t => {
  let posts = 0, reads = 0, saved;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { posts++; saved = await operation(req.headers['idempotency-key']); req.resume(); req.socket.destroy(); return; }
    reads++;
    if (reads === 1) { res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'ota_operation_not_found' } })); }
    else res.end(JSON.stringify(saved));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const directory = path.join(root, '.dev', 'ota-boundary-' + randomBytes(8).toString('hex'));
  await mkdir(directory, { recursive: true });
  const input = path.join(directory, 'input.json'), blocked = path.join(directory, 'blocked');
  await writeFile(input, JSON.stringify(change)); await writeFile(blocked, 'regular-file');
  const env = { ...process.env, LIMEIOT_TOKEN: 'test-owner', LIMEIOT_ENDPOINT: 'http://127.0.0.1:' + server.address().port }; delete env.LIMEIOT_TOKEN_FILE;
  async function cli(state, code) {
    let result; try { result = await exec(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'ota-changes.create', '--space-id', 'space', '--idempotency-key', 'original', '--state-dir', state, '--input', input], { cwd: root, env, timeout: 6000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, code, result.stderr); return result;
  }
  await cli(blocked, 5); assert.equal(posts, 0);
  const state = path.join(directory, 'state');
  await cli(state, 6); assert.equal(posts, 1);
  await cli(state, 6); assert.equal(posts, 1); assert.equal(reads, 1);
  assert.equal(JSON.parse((await cli(state, 0)).stdout).operation_id, saved.operation_id);
  await writeFile(input, JSON.stringify({ ...change, expected_signing_key_id: 'sha256:' + '0'.repeat(64) }));
  await cli(state, 4); assert.equal(posts, 1); assert.equal(reads, 2);
  await writeFile(input, JSON.stringify(change)); saved.resource.kind = 'ota_task';
  await cli(state, 6); assert.equal(posts, 1);
});

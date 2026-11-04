import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parseObservationChange, parseObservationQuery, verifyObservationBinding, verifyObservationCandidate, verifyObservationCandidates, verifyObservationOperation } from '../packages/protocol/observation-bindings.mjs';

const execute = promisify(execFile), root = new URL('../', import.meta.url).pathname;
const read = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));
test('Swift/Kotlin共享向量保持正式来源合同与JCS摘要一致', async () => {
  const v = await read('tests/fixtures/zigbee/observation-native.json');
  await verifyObservationCandidate(v.candidate); await verifyObservationCandidates(v.page);
  for (const name of ['empty', 'current', 'revoked']) await verifyObservationBinding(v[name], 'sensor');
  for (const name of ['operation', 'revokeOperation', 'rejected', 'conflict']) await verifyObservationOperation(v[name]);
  for (const name of ['bind', 'revoke']) assert.deepEqual(parseObservationChange(JSON.stringify(v[name])), v[name]);
});
async function fixture() {
  const target = { coordinator_ieee: '0102030405060708', ieee_address: '1122334455667788', endpoint: 1 };
  const manifest = { mapping: 'znp-environment-v1', target, manufacturer_code: 4660,
    signature: { manufacturer: 'LimeIoT', model: 'Environment-1', application_version: 2, hardware_version: 1 },
    model_revision: await documentDigest(await read('contracts/models/environment.json')) };
  const source = { adapter_id: 'znp-' + (await documentDigest(target)).slice(7), revision: await documentDigest(manifest) };
  const before = await documentDigest(['observation-binding-v1', 'sensor', null]);
  const change = { type: 'sources.bind', device_id: 'sensor', source, expected_binding_revision: before, expected_model_revision: manifest.model_revision };
  const request = { space_id: 'space', idempotency_key: 'original', change };
  const operation_id = 'observationop-fixture', created_at = '2026-11-04T00:00:00Z';
  const binding = { policy: { device_id: 'sensor', model_revision: manifest.model_revision, source }, manifest, active: true, generation: operation_id, changed_at: created_at };
  const result = { device_id: 'sensor', revision: await documentDigest(['observation-binding-v1', 'sensor', binding]), binding };
  const operation = { operation_id, sequence: 1, request, request_digest: await documentDigest(request), status: 'applied', reason: null, result, created_at };
  const candidate = { source, model_revision: manifest.model_revision, target, signature: manifest.signature, manufacturer_code: 4660,
    observed_at: created_at, expires_at: '2026-11-04T00:01:00Z', protocol: 'zigbee-znp', evidence: 'unauthenticated_protocol' };
  return { change, operation, candidate };
}

test('来源Schema、离线Agent目录与严格解析使用同一输入合同', async () => {
  const schema = await read('contracts/observation-bindings.schema.json'), catalog = await read('contracts/tools/catalog.json');
  assert.deepEqual(catalog.schemas['observation-change'], schema);
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  const validate = ajv.compile(schema), querySchema = ajv.compile(catalog.schemas['observation-query']);
  const { change, operation } = await fixture();
  assert(validate(change), JSON.stringify(validate.errors));
  assert.deepEqual(parseObservationChange(JSON.stringify(change)), change);
  assert(ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/operation' })(operation));
  const query = { coordinator_id: 'home-znp', ieee_address: '1122334455667788', endpoint: 1 };
  assert(querySchema(query)); assert.deepEqual(parseObservationQuery(JSON.stringify(query)), query);
  for (const field of Object.keys(change)) { const invalid = { ...change }; delete invalid[field]; assert.equal(validate(invalid), false); assert.throws(() => parseObservationChange(JSON.stringify(invalid))); }
  for (const extra of [{ serial: '/dev/ttyUSB0' }, { manifest: {} }, { device_id: 'sensor\n' }]) assert.throws(() => parseObservationChange(JSON.stringify({ ...change, ...extra })));
  assert.throws(() => parseObservationQuery(JSON.stringify({ ...query, serial: '/dev/ttyUSB0' })));
  assert.throws(() => parseObservationQuery('{"coordinator_id":"one","coordinator_id":"two","ieee_address":"1122334455667788","endpoint":1}'));
  const result = await execute(process.execPath, ['packages/cli/src/main.mjs', 'schema', 'observation-changes.create'], { cwd: root });
  assert.equal(JSON.parse(result.stdout).recovery_operation, 'observation-changes.resolve');
});

test('来源回执校验绑定实际清单、原请求、代次和结果修订', async () => {
  const { candidate, operation } = await fixture();
  await verifyObservationCandidate(candidate); await verifyObservationOperation(operation, operation.request);
  await verifyObservationBinding(operation.result, 'sensor');
  for (const extra of [{ expires_at: '2026-11-04T00:01:01Z' }, { serial: '/dev/ttyUSB0' }, { source: { ...candidate.source, adapter_id: 'alias' } }, { signature: { ...candidate.signature, model: 'Changed' } }]) {
    await assert.rejects(() => verifyObservationCandidate({ ...candidate, ...extra }));
  }
  for (const mutate of [value => { value.sequence = 0; }, value => { value.result.binding.generation = 'observationop-old'; },
    value => { value.request_digest = 'sha256:' + '0'.repeat(64); }, value => { value.result.binding.active = false; },
    value => { value.result.binding.manifest.serial = '/dev/ttyUSB0'; }]) {
    const invalid = structuredClone(operation); mutate(invalid); await assert.rejects(() => verifyObservationOperation(invalid, operation.request));
  }
});

test('开关候选的固定模型与写权限必须同时匹配，查询不能夹带授权', async () => {
  const { candidate } = await fixture();
  const model_revision = await documentDigest(await read('contracts/models/on-off-light.json'));
  const manifest = { mapping: 'znp-on-off-v1', target: candidate.target, manufacturer_code: candidate.manufacturer_code, signature: candidate.signature, model_revision };
  const writable = { ...candidate, model_revision, write_paths: ['light.power'], source: { ...candidate.source, revision: await documentDigest(manifest) } };
  const schema = await read('contracts/observation-bindings.schema.json');
  const ajv = new Ajv({ strict: true }); addFormats(ajv);
  const validate = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/candidate' });
  assert(validate(writable), JSON.stringify(validate.errors));
  await verifyObservationCandidate(writable);
  const query = { coordinator_id: 'home-znp', ieee_address: candidate.target.ieee_address, endpoint: 1, profile: 'on_off' };
  assert.deepEqual(parseObservationQuery(JSON.stringify(query)), query);
  for (const profile of [null, 'other', 'environment']) assert.throws(() => parseObservationQuery(JSON.stringify({ ...query, profile })));
  assert.throws(() => parseObservationQuery(JSON.stringify({ ...query, write_paths: ['light.power'] })));
  for (const write_paths of [[], ['light.brightness'], ['light.power', 'light.power'], ['light.power', 'light.brightness']]) {
    assert.equal(validate({ ...writable, write_paths }), false);
    await assert.rejects(() => verifyObservationCandidate({ ...writable, write_paths }));
  }
  await assert.rejects(() => verifyObservationCandidate({ ...candidate, write_paths: ['light.power'] }));
  const { write_paths, ...missing } = writable;
  await assert.rejects(() => verifyObservationCandidate(missing));
});

test('CLI丢失绑定响应后仅查询原请求，存储失败和同键异参不发送新决定', async t => {
  const { change, operation } = await fixture();
  let writes = 0, reads = 0, forged = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') { writes++; for await (const _ of req) { /* 先消费原请求，再模拟响应丢失。 */ } req.socket.destroy(); }
    else { reads++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(forged ? { ...operation, request_digest: 'sha256:' + '0'.repeat(64) } : operation)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'limeiot-observation-cli-')));
  const input = path.join(directory, 'input.json'), state = path.join(directory, 'state');
  await writeFile(input, JSON.stringify(change));
  const env = { ...process.env, LIMEIOT_ENDPOINT: `http://127.0.0.1:${server.address().port}`, LIMEIOT_TOKEN: 'isolated-test-owner-token-value' }; delete env.LIMEIOT_TOKEN_FILE;
  const cli = async (stateDir, exit) => {
    let result; try { result = await execute(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'observation-changes.create', '--space-id', 'space', '--idempotency-key', 'original', '--input', input, '--state-dir', stateDir], { cwd: root, env, timeout: 6000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, exit, result.stderr); return result;
  };
  const blocked = path.join(directory, 'blocked'); await writeFile(blocked, 'file');
  await cli(blocked, 5); assert.equal(writes, 0);
  await cli(state, 6); assert.equal(writes, 1);
  const recovered = JSON.parse((await cli(state, 0)).stdout); assert.equal(recovered.operation_id, operation.operation_id); assert.equal(writes, 1); assert.equal(reads, 1);
  await writeFile(input, JSON.stringify({ ...change, expected_binding_revision: 'sha256:' + '1'.repeat(64) }));
  await cli(state, 4); assert.equal(writes, 1); assert.equal(reads, 1);
  await writeFile(input, JSON.stringify(change)); forged = true;
  await cli(state, 6); assert.equal(writes, 1); assert.equal(reads, 2);
});

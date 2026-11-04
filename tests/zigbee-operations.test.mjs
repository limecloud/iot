import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parseZigbeeChange, verifyZigbeeCoordinators, verifyZigbeeOperation, verifyZigbeeOperations } from '../packages/protocol/zigbee-operations.mjs';
import { until } from '../tools/dev-stack.mjs';
import { base, post, targets, devices, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

const execute = promisify(execFile);
const submit = (stack, change, key) => stack.request(base + '/zigbee-operations', {
  ...post(change), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
});
async function coordinator(stack) {
  const page = await stack.request(base + '/zigbee-coordinators');
  assert.equal(page.status, 200); return verifyZigbeeCoordinators(page.value).items[0];
}
const change = (coordinator, seconds = 60) => ({ coordinator_id: coordinator.coordinator_id, expected_revision: coordinator.revision, duration_seconds: seconds });

test('入网正式Schema与机器工具一致，校验原请求摘要和回执上下文', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/zigbee-operations.schema.json', import.meta.url)));
  const catalog = JSON.parse(await readFile(new URL('../contracts/tools/catalog.json', import.meta.url)));
  assert.deepEqual(catalog.schemas['zigbee-change'], schema);
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  const coordinator = { coordinator_id: 'home-znp', coordinator_ieee: '0102030405060708', revision: 'sha256:' + 'a'.repeat(64), timeout_ms: 500 };
  const request = { space_id: 'space-demo', idempotency_key: 'open', change: change(coordinator) };
  const operation = { operation_id: 'join-fixture', sequence: 1, request, request_digest: await documentDigest(request), coordinator,
    status: 'unknown', reason: 'not_confirmed', result: null, created_at: '2026-11-04T00:00:00Z', blocked_until: '2026-11-04T00:01:00.500Z', completed_at: null };
  assert(validate(request.change)); assert.deepEqual(parseZigbeeChange(JSON.stringify(request.change)), request.change);
  const output = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/operation' });
  assert(output(operation), JSON.stringify(output.errors)); await verifyZigbeeOperation(operation, request);
  for (const patch of [{ duration_seconds: 255 }, { duration_seconds: -1 }, { duration_seconds: 1.5 }, { duration_seconds: '60' },
    { serial: '/dev/ttyUSB0' }, { expected_revision: 'sha256:' + 'a'.repeat(64) + '\n' }, { coordinator_id: 'home-znp\n' }]) {
    const invalid = { ...request.change, ...patch }; assert.equal(validate(invalid), false); assert.throws(() => parseZigbeeChange(JSON.stringify(invalid)));
  }
  assert.throws(() => parseZigbeeChange('{"coordinator_id":"one","coordinator_id":"two"}'));
  for (const mutate of [value => { value.request_digest = 'sha256:' + '0'.repeat(64); }, value => { value.coordinator.coordinator_ieee += '\n'; },
    value => { value.coordinator.revision = 'sha256:' + '0'.repeat(64); }, value => { value.blocked_until = value.created_at; },
    value => { value.status = 'open'; }, value => { value.reason = 'retry_allowed\n'; }, value => { value.result = {}; }]) {
    const invalid = structuredClone(operation); mutate(invalid); await assert.rejects(verifyZigbeeOperation(invalid, request));
  }
  const accepted = { ...operation, status: 'protocol_accepted', reason: null, completed_at: '2026-11-04T00:00:00.100Z',
    result: { coordinator_ieee: coordinator.coordinator_ieee, duration_seconds: 60, observed_at: '2026-11-04T00:00:00.100Z' } };
  assert(output(accepted), JSON.stringify(output.errors)); await verifyZigbeeOperation(accepted, request);
  await assert.rejects(verifyZigbeeOperation({ ...accepted, result: { ...accepted.result, duration_seconds: 0 } }, request));
  const tool = JSON.parse((await execute(process.execPath, ['packages/cli/src/main.mjs', 'schema', 'zigbee-changes.create'])).stdout);
  assert(tool.network_write_requested); assert(tool.original_request); assert.equal(tool.device_execution, false);
});

test('真实串口入网与观测轮询共用会话，同键不重发且阈值联动保持', { timeout: 60000 }, async t => {
  const { directory, stack, stats, sensor, control, commands } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  const owner = await coordinator(stack), input = change(owner);
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT + base + '/zigbee-coordinators')).status, 401);
  assert.equal((await stack.request('/api/v1/spaces/other/zigbee-operations', {
    ...post(input), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'wrong-space' },
  })).status, 403);
  const query = await stack.request(base + '/observation-candidates', post({ coordinator_id: owner.coordinator_id, ieee_address: targets[0], endpoint: 1 }));
  assert.equal(query.status, 200); const candidate = query.value;
  const binding = (await stack.request(base + '/devices/' + devices[0] + '/observation-binding')).value;
  const bound = await stack.request(base + '/observation-operations', {
    ...post({ type: 'sources.bind', device_id: devices[0], source: candidate.source, expected_model_revision: candidate.model_revision, expected_binding_revision: binding.revision }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'bind' },
  });
  assert.equal(bound.value.status, 'applied'); await until(async () => (await sensor()).ready);
  const rule = await stack.request(base + '/rule-deployments', { ...post(thresholdRule()), headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' } });
  assert.equal(rule.status, 200);
  const baseline = (await sensor()).state_revision;
  await until(async () => (await sensor()).state_revision > baseline);
  const before = await stats(), first = await submit(stack, input, 'open');
  assert.equal(first.status, 200); await verifyZigbeeOperation(first.value, { space_id: 'space-demo', idempotency_key: 'open', change: input });
  assert.equal(first.value.status, 'protocol_accepted');
  assert.deepEqual((await submit(stack, input, 'open')).value, first.value);
  assert.equal((await submit(stack, change(owner, 0), 'open')).status, 409);
  assert.equal((await submit(stack, { ...input, duration_seconds: 255 }, 'invalid')).status, 422);
  await control(2900); await until(async () => (await commands()).some(command => command.status === 'confirmed'));
  const after = await stats(); assert.deepEqual(after.join_requests, [60]); assert.deepEqual(after.errors, []);
  assert.equal(after.host_checks, before.host_checks); assert(after.af_requests > before.af_requests);
  await stack.restartGateway();
  assert.deepEqual((await stack.request(base + '/zigbee-operations/by-key/open')).value, first.value);
  assert.deepEqual((await submit(stack, input, 'open')).value, first.value);
  assert.deepEqual((await stats()).join_requests, [60]);
  const closed = await submit(stack, change(await coordinator(stack), 0), 'close'); assert.equal(closed.value.status, 'protocol_accepted');
  await verifyZigbeeOperations((await stack.request(base + '/zigbee-operations')).value, 'space-demo');
  assert.deepEqual((await stats()).join_requests, [60, 0]);
  const backup = path.join(directory, 'gateway-backup.sqlite');
  await execute('python3', ['-c', 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()', stack.env.LIMEIOT_DB, backup]);
  stack.env.LIMEIOT_DB = backup;
  await writeFile(stack.env.LIMEIOT_ZIGBEE_CONFIG, JSON.stringify({ schema_version: 1, bindings: [] }));
  await stack.restartGateway();
  assert.deepEqual(verifyZigbeeCoordinators((await stack.request(base + '/zigbee-coordinators')).value).items, []);
  assert.deepEqual((await submit(stack, input, 'open')).value, first.value);
  assert.deepEqual((await stats()).join_requests, [60, 0]);
  await writeFile(path.join(directory, 'commissioning-result.json'), JSON.stringify({ passed: true, same_actor: true, polling_continued: true,
    confirmed_threshold: true, durable_original: true, restart_no_replay: true, sqlite_backup_restored: true,
    original_survives_removed_coordinator: true, stats: await stats(), hardware: false }, null, 2));
});

test('未知入网禁止换键延长，明确关闭可用，强制退出后恢复原记录零补发', { timeout: 60000 }, async t => {
  const { directory, stack, stats, join, restoreFixtureTty } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  const owner = await coordinator(stack); await join('timeout');
  const unknown = await submit(stack, change(owner), 'lost');
  assert.equal(unknown.status, 200); await verifyZigbeeOperation(unknown.value); assert.equal(unknown.value.status, 'unknown');
  const settled = await until(async () => { const value = (await stack.request(base + '/zigbee-operations/by-key/lost')).value; return value.completed_at && value; });
  assert.equal(settled.operation_id, unknown.value.operation_id); assert.equal(settled.request_digest, unknown.value.request_digest);
  assert.equal(settled.status, 'unknown'); assert.equal(settled.reason, 'observation_query_timeout');
  assert.deepEqual((await submit(stack, change(owner), 'lost')).value, settled);
  assert.equal((await submit(stack, change(owner), 'replacement')).status, 409);
  await join('normal'); assert.equal((await submit(stack, change(owner, 0), 'close')).value.status, 'protocol_accepted');
  await stack.restartGateway(); assert.deepEqual((await stats()).join_requests, [60, 0]);
  assert.deepEqual((await stack.request(base + '/zigbee-operations/by-key/lost')).value, settled);
  await join('timeout');
  const pending = submit(stack, change(await coordinator(stack), 0), 'crash-close').catch(error => ({ error: error.name }));
  await until(async () => (await stats()).join_requests.length === 3);
  stack.gateway.kill('SIGKILL'); await until(() => stack.gateway.signalCode === 'SIGKILL'); await pending;
  assert.equal((await stats()).termios_restored, false);
  await restoreFixtureTty(); assert.equal((await stats()).termios_restored, true);
  await stack.restartGateway();
  const recovered = (await stack.request(base + '/zigbee-operations/by-key/crash-close')).value;
  await verifyZigbeeOperation(recovered); assert.equal(recovered.status, 'unknown'); assert.equal(recovered.completed_at, null);
  assert.deepEqual((await stats()).join_requests, [60, 0, 0]);
  assert.deepEqual((await submit(stack, change(owner, 0), 'crash-close')).value, recovered);
  assert.deepEqual((await stats()).join_requests, [60, 0, 0]);
  await writeFile(path.join(directory, 'commissioning-recovery.json'), JSON.stringify({ passed: true, unknown_preserved: true,
    explicit_close: true, crash_without_receipt: true, zero_replay: true,
    sigkill_does_not_restore_tty: true, fixture_tty_restored_explicitly_before_restart: true, hardware: false }, null, 2));
});

test('CLI先保存回读，真实网关丢HTTP响应后只GET原键恢复', { timeout: 60000 }, async t => {
  const { stack, directory, stats } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1000 });
  const input = path.join(directory, 'change.json'), state = path.join(directory, 'private-state');
  const value = change(await coordinator(stack)); await writeFile(input, JSON.stringify(value));
  let posts = 0, gets = 0;
  const proxy = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const result = await fetch(stack.env.LIMEIOT_ENDPOINT + request.url, { method: request.method, headers: request.headers,
      body: request.method === 'POST' ? body : undefined });
    const output = await result.text();
    if (request.method === 'POST') { posts++; response.destroy(); }
    else { gets++; response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(output); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => proxy.close(resolve)));
  const env = { ...stack.env, LIMEIOT_ENDPOINT: `http://127.0.0.1:${proxy.address().port}` };
  const cli = async (stateDir, exit) => {
    let result; try { result = await execute(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'zigbee-changes.create', '--space-id', 'space-demo', '--input', input,
      '--idempotency-key', 'cli-original', '--state-dir', stateDir], { env, timeout: 7000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, exit, result.stderr); return result;
  };
  const blocked = path.join(directory, 'not-a-directory'); await writeFile(blocked, 'blocked');
  await cli(blocked, 5); assert.equal(posts, 0); assert.deepEqual((await stats()).join_requests, []);
  await cli(state, 6); assert.equal(posts, 1);
  const restored = JSON.parse((await cli(state, 0)).stdout); assert.equal(restored.status, 'protocol_accepted');
  assert.equal(posts, 1); assert.equal(gets, 1); assert.deepEqual((await stats()).join_requests, [60]);
  await stack.restartGateway(); assert.equal(JSON.parse((await cli(state, 0)).stdout).operation_id, restored.operation_id);
  assert.equal(posts, 1); assert.equal(gets, 2); assert.deepEqual((await stats()).join_requests, [60]);
  await writeFile(input, JSON.stringify({ ...value, duration_seconds: 0 })); await cli(state, 4); assert.equal(posts, 1);
});

test('网关意图写盘失败零网络发送，回执写盘失败保留未知', { timeout: 60000 }, async t => {
  const { stack, stats, directory } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1000 });
  const input = change(await coordinator(stack));
  const sql = async statement => execute('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.close()', stack.env.LIMEIOT_DB, statement]);
  await sql("CREATE TRIGGER fail_join BEFORE INSERT ON events WHEN NEW.type='zigbee.commissioning' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  assert.equal((await submit(stack, input, 'storage')).status, 503); assert.deepEqual((await stats()).join_requests, []);
  await sql("DROP TRIGGER fail_join; CREATE TRIGGER fail_join BEFORE INSERT ON events WHEN NEW.type='zigbee.commissioning' AND json_extract(NEW.data,'$.data.completed_at') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  const unknown = await submit(stack, input, 'storage'); assert.equal(unknown.status, 200); assert.equal(unknown.value.status, 'unknown');
  assert.equal(unknown.value.completed_at, null); assert.deepEqual((await stats()).join_requests, [60]);
  await sql('DROP TRIGGER fail_join;'); await stack.restartGateway();
  assert.deepEqual((await submit(stack, input, 'storage')).value, unknown.value);
  assert.deepEqual((await stats()).join_requests, [60]);
  await writeFile(path.join(directory, 'commissioning-storage.json'), JSON.stringify({ passed: true, intent_failure_zero_effect: true,
    receipt_failure_remains_unknown: true, restart_zero_replay: true, hardware: false }, null, 2));
});

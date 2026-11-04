import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { verifyZigbeeJoinWindowReport } from '../packages/protocol/zigbee-commissioning.mjs';
import { verifyZigbeeNeighborsReport } from '../packages/protocol/zigbee-discovery.mjs';

const execute = promisify(execFile), coordinator = '0102030405060708';
const cli = new URL('../packages/cli/src/main.mjs', import.meta.url);
const schema = JSON.parse(await readFile(new URL('../contracts/zigbee-diagnostics.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true }); ajv.addSchema(schema);
const response = ajv.getSchema(schema.$id), request = ajv.compile({ $ref: schema.$id + '#/$defs/request' }), error = ajv.compile({ $ref: schema.$id + '#/$defs/error' });
const report = { schema_version: 1, operation: 'permit-join', protocol: 'znp', evidence: 'unauthenticated_protocol', device_binding_created: false, network_write_requested: true, observed_at_unix_ms: 1234,
  result: { ncp: { capabilities: 0x11, transport_revision: 2, product_id: 1, major: 3, minor: 0, maintenance: 1, version_extension: [11] }, coordinator_ieee: coordinator, network_address: 0, scope: 'coordinator', duration_seconds: 60, trust_center_significance: 1, status: 'protocol_accepted' } };

test('有限入网正式合同明确网络写入，0关闭且拒绝永久开放与额外路由', () => {
  const input = { command: 'permit-join', serial: '/dev/ttyUSB0', coordinator_ieee: coordinator, duration_seconds: 60 };
  for (const duration of [0, 1, 120]) assert(request({ ...input, duration_seconds: duration }), JSON.stringify(request.errors));
  for (const change of [{ duration_seconds: 121 }, { duration_seconds: 255 }, { duration_seconds: -1 }, { duration_seconds: 0.5 }, { duration_seconds: '60' }, { address: '0xfffc' }, { endpoint: 1 }, { broadcast: true }, { coordinator_ieee: '0'.repeat(16) }]) assert.equal(request({ ...input, ...change }), false);
  const missing = { ...input }; delete missing.duration_seconds; assert.equal(request(missing), false);
  assert(response(report), JSON.stringify(response.errors)); assert.equal(verifyZigbeeJoinWindowReport(report, coordinator, 60), report);
  assert(error({ error: { code: 'znp_timeout', outcome: 'unknown', retry_allowed: false } }));
  assert(!error({ error: { code: 'znp_timeout', outcome: 'unknown' } })); assert(!error({ error: { code: 'znp_timeout', retry_allowed: true } }));
});

test('客户端严格核对预期协调器、期限、能力和回执语义', () => {
  for (const change of [
    value => { delete value.network_write_requested; }, value => { value.network_write_requested = false; },
    value => { value.result.coordinator_ieee = coordinator + '\n'; }, value => { value.result.coordinator_ieee = '0102030405060709'; },
    value => { value.result.duration_seconds = 120; }, value => { value.result.duration_seconds = 255; }, value => { value.result.duration_seconds = true; },
    value => { value.result.network_address = 0xfffc; }, value => { value.result.scope = 'network'; }, value => { value.result.trust_center_significance = 0; },
    value => { value.result.status = 'open'; }, value => { value.result.joined_devices = []; },
    value => { value.result.ncp.capabilities = 1; }, value => { value.result.ncp.version_extension.push(...Array(12).fill(0)); },
    value => { value.device_binding_created = true; }, value => { value.observed_at_unix_ms = -1; }, value => { value.owner_token = 'unexpected'; },
  ]) { const invalid = structuredClone(report); change(invalid); assert.throws(() => verifyZigbeeJoinWindowReport(invalid, coordinator, 60), /invalid_znp_tool_response/); }
  assert.throws(() => verifyZigbeeJoinWindowReport(report, coordinator, 255));
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'limeiot-join-tool-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const tool = path.join(directory, 'tool.mjs'), calls = path.join(directory, 'calls.jsonl');
  await writeFile(tool, '#!' + process.execPath + '\nimport { appendFileSync } from "node:fs";\n'
    + 'appendFileSync(' + JSON.stringify(calls) + ', JSON.stringify(process.argv.slice(2)) + "\\n");\n'
    + 'if(process.env.JOIN_TOOL_ERROR){process.stderr.write(process.env.JOIN_TOOL_ERROR);process.exitCode=5;}else{process.stdout.write(process.env.JOIN_TOOL_OUTPUT);}\n', { mode: 0o700 });
  return {
    async calls() { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } },
    async run({ output = JSON.stringify(report), detail, args = ['--coordinator-ieee', coordinator, '--duration-seconds', '60'] } = {}) {
      try { const result = await execute(process.execPath, [cli.pathname, 'zigbee', 'permit-join', '--serial', '/dev/test-ncp', ...args], { env: { ...process.env, LIMEIOT_ZNP_TOOL: tool, JOIN_TOOL_OUTPUT: output, JOIN_TOOL_ERROR: detail ? JSON.stringify(detail) : '' }, timeout: 5000 }); return { ...result, code: 0 }; }
      catch (error) { assert.equal(typeof error.code, 'number'); return error; }
    },
  };
}

test('CLI单次转发明确写入与原参数，不隐式读取或重试', async t => {
  const tool = await fixture(t), result = await tool.run();
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), report);
  assert.deepEqual(await tool.calls(), [['permit-join', '--serial', '/dev/test-ncp', '--timeout-ms', '5000', '--coordinator-ieee', coordinator, '--duration-seconds', '60']]);
});

test('CLI拒绝坏回执和重复JSON键，保留未知且不补发', async t => {
  const tool = await fixture(t);
  for (const output of [JSON.stringify({ ...report, network_write_requested: false }), JSON.stringify(report).replace('{', '{"schema_version":1,'), '{"result":']) {
    const result = await tool.run({ output }); assert.equal(result.code, 5); assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'invalid_znp_tool_response', outcome: 'unknown', retry_allowed: false } });
  }
  assert.equal((await tool.calls()).length, 3);
});

test('CLI保留组件未知结果，拒绝伪造可重试与额外诊断', async t => {
  const tool = await fixture(t);
  const original = { error: { code: 'znp_device_rejected', status: 0x84, outcome: 'unknown', retry_allowed: false } };
  const result = await tool.run({ detail: original }); assert.equal(result.code, 5); assert.deepEqual(JSON.parse(result.stderr), original);
  for (const detail of [{ error: { code: 'znp_timeout', outcome: 'unknown', retry_allowed: true } }, { error: { code: 'znp_timeout', raw: 'must-not-escape' } }]) {
    const rejected = await tool.run({ detail }); assert.equal(rejected.code, 5); assert.deepEqual(JSON.parse(rejected.stderr), { error: { code: 'znp_tool_failed', outcome: 'unknown', retry_allowed: false } });
  }
  assert.equal((await tool.calls()).length, 3);
});

test('CLI非法期限和IEEE在启动组件前拒绝', async t => {
  const tool = await fixture(t);
  for (const args of [[], ['--coordinator-ieee', coordinator], ['--coordinator-ieee', coordinator, '--duration-seconds', '255'], ['--coordinator-ieee', coordinator, '--duration-seconds', '60\n'], ['--coordinator-ieee', coordinator + '\n', '--duration-seconds', '60']]) {
    const result = await tool.run({ args }); assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'invalid_znp_input' } });
  }
  assert.deepEqual(await tool.calls(), []);
});

if (process.env.LIMEIOT_ZNP_JOIN_REPORT) test('当前实际PTY与CLI回执通过正式Schema和上下文校验', async () => {
  const result = JSON.parse(await readFile(process.env.LIMEIOT_ZNP_JOIN_REPORT, 'utf8'));
  assert.equal(result.passed, true); assert.equal(result.failures + result.errors, 0); assert.equal(result.hardware, false);
  const accepted = result.records.filter(r => r.exit_code === 0);
  assert(accepted.length >= 10);
  for (const record of result.records) {
    if (record.stdout) {
      assert(response(record.stdout), JSON.stringify(response.errors));
      if (record.command === 'permit-join') {
        const writes = record.requests.filter(([a, b]) => a === 0x25 && b === 0x36); assert.equal(writes.length, 1);
        verifyZigbeeJoinWindowReport(record.stdout, coordinator, Buffer.from(writes[0][2], 'hex')[3]);
      } else verifyZigbeeNeighborsReport(record.stdout, coordinator);
    } else { assert(error(record.stderr), JSON.stringify(error.errors)); }
  }
});

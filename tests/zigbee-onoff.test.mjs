import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import Ajv from 'ajv/dist/2020.js';
import { parseZigbeeOnOffSignature, verifyZigbeeOnOffReport } from '../packages/protocol/zigbee-onoff.mjs';

const execute = promisify(execFile), root = new URL('../', import.meta.url).pathname;
const cli = path.join(root, 'packages/cli/src/main.mjs');
const schema = JSON.parse(await readFile(new URL('../contracts/zigbee-diagnostics.schema.json', import.meta.url)));
const ajv = new Ajv({ strict: true, allErrors: true }); ajv.addSchema(schema);
const validate = ajv.getSchema(schema.$id), request = ajv.compile({ $ref: schema.$id + '#/$defs/request' });
const signature = { manufacturer: 'LimeIoT', model: 'Switch-1', application_version: 2, hardware_version: 1 };
const expected = { coordinator_ieee: '0102030405060708', ieee_address: '1122334455667788', endpoint: 1, manufacturer_code: 0x1234, signature, power: true };
const args = ['set-onoff', '--serial', '/dev/software-only', '--coordinator-ieee', expected.coordinator_ieee,
  '--ieee', expected.ieee_address, '--endpoint', '1', '--power', 'on', '--manufacturer-code', '0x1234', '--signature-json', JSON.stringify(signature)];
const accepted = { schema_version: 1, operation: 'set-onoff', protocol: 'znp', evidence: 'unauthenticated_protocol',
  device_binding_created: false, device_write_requested: true, observed_at_unix_ms: 1000,
  result: { coordinator_ieee: expected.coordinator_ieee, ieee_address: expected.ieee_address, network_address: 0x1234, endpoint: 1,
    manufacturer_code: 0x1234, signature, power_requested: true, status: 'protocol_accepted', device_state_confirmed: false, accepted_at_unix_ms: 999 } };

async function tool(t) {
  const directory = await mkdtemp(path.join(root, '.dev/znp-onoff-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tool.mjs'), calls = path.join(directory, 'calls.jsonl');
  await writeFile(file, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.ONOFF_TOOL_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.env.ONOFF_TOOL_ERROR) { process.stderr.write(process.env.ONOFF_TOOL_ERROR); process.exit(5); }\nprocess.stdout.write(process.env.ONOFF_TOOL_OUTPUT);\n`, { mode: 0o755 });
  return {
    async run({ output = JSON.stringify(accepted), error = '' } = {}) {
      try { return { ...(await execute(process.execPath, [cli, 'zigbee', ...args], { cwd: root, timeout: 5000,
        env: { ...process.env, LIMEIOT_ZNP_TOOL: file, ONOFF_TOOL_CALLS: calls, ONOFF_TOOL_OUTPUT: output, ONOFF_TOOL_ERROR: error } })), code: 0 }; }
      catch (value) { return value; }
    },
    async calls() { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); },
  };
}

test('固定On/Off机器请求、回执与离线Schema一致，禁止任意Cluster和Toggle', async () => {
  assert(request({ command: 'read-onoff', serial: '/dev/test', ...Object.fromEntries(['coordinator_ieee', 'ieee_address', 'endpoint'].map(key => [key, expected[key]])) }));
  const valid = { command: 'set-onoff', serial: '/dev/test', ...expected };
  assert(request(valid), JSON.stringify(request.errors)); assert(validate(accepted), JSON.stringify(validate.errors));
  assert.equal(verifyZigbeeOnOffReport(accepted, expected), accepted);
  for (const patch of [{ power: 'on' }, { power: 1 }, { toggle: true }, { cluster: 6 }, { command: 'raw-zcl' },
    { manufacturer_code: 65536 }, { signature: { ...signature, hardware_version: 1.5 } }]) assert.equal(request({ ...valid, ...patch }), false);
  for (const key of ['signature', 'manufacturer_code', 'power', 'coordinator_ieee']) {
    const value = { ...valid }; delete value[key]; assert.equal(request(value), false);
  }
  const output = await execute(process.execPath, [cli, 'zigbee', 'schema']); assert.deepEqual(JSON.parse(output.stdout), schema);
});

test('当前真实Rust/PTY和CLI全部On/Off回执符合Schema与严格上下文', async () => {
  const report = JSON.parse(await readFile(new URL('../.dev/znp-onoff-20261104/pty-results.json', import.meta.url)));
  assert.equal(report.passed, true); assert.equal(report.hardware, false); assert(report.tests >= 15);
  assert.equal(report.failures + report.errors, 0);
  let reads = 0, writes = 0;
  for (const record of report.records) {
    if (record.exit_code !== 0) {
      const error = ajv.getSchema(schema.$id + '#/$defs/error') ?? ajv.compile({ $ref: schema.$id + '#/$defs/error' });
      assert(error(record.stderr), JSON.stringify(error.errors)); continue;
    }
    assert(validate(record.stdout), JSON.stringify(validate.errors));
    const value = record.stdout.result;
    verifyZigbeeOnOffReport(record.stdout, { ...expected, power: value.power_requested });
    if (record.stdout.operation === 'set-onoff') { writes++; assert.equal(value.device_state_confirmed, false); assert.equal('power' in value, false); }
    else reads++;
  }
  assert(reads >= 12 && writes >= 12);
});

test('签名按UTF8字节与整数校验，拒绝重复键及未知字段', () => {
  assert.deepEqual(parseZigbeeOnOffSignature(JSON.stringify(signature)), signature);
  for (const value of [{ ...signature, manufacturer: '中'.repeat(11) }, { ...signature, model: 'x\u0085y' },
    { ...signature, model: ' ' }, { ...signature, application_version: '2' }, { ...signature, extra: true }]) {
    assert.throws(() => parseZigbeeOnOffSignature(JSON.stringify(value)));
  }
  assert.throws(() => parseZigbeeOnOffSignature(JSON.stringify(signature).replace('{', '{"manufacturer":"Other",')));
});

test('伪造、越权上下文与把受理冒充实际状态的回执拒绝', () => {
  const mutations = [value => { value.result.power = true; }, value => { value.result.device_state_confirmed = true; },
    value => { value.result.status = 'confirmed'; }, value => { value.result.power_requested = false; },
    value => { value.result.signature.model = 'Other'; }, value => { value.result.manufacturer_code++; },
    value => { value.result.coordinator_ieee = expected.ieee_address; }, value => { value.result.endpoint = 2; },
    value => { value.result.network_address = 0xffff; }, value => { value.result.signature.application_version = 1.5; },
    value => { value.result.accepted_at_unix_ms = value.observed_at_unix_ms + 1; },
    value => { value.device_write_requested = false; }, value => { value.device_binding_created = true; },
    value => { value.serial = '/dev/forged'; }, value => { delete value.result.signature; }];
  for (const mutate of mutations) { const value = structuredClone(accepted); mutate(value); assert.throws(() => verifyZigbeeOnOffReport(value, expected)); }
});

test('CLI严格转发已核对目标和指纹，仅启动组件一次', async t => {
  const fixture = await tool(t), result = await fixture.run(); assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), accepted);
  assert.deepEqual(await fixture.calls(), [[args[0], ...args.slice(1, 3), '--timeout-ms', '5000', ...args.slice(3)]]);
});

test('坏回执与重复JSON键在可能发送后保持unknown且不重试', async t => {
  const fixture = await tool(t);
  for (const output of [JSON.stringify({ ...accepted, result: { ...accepted.result, device_state_confirmed: true } }),
    JSON.stringify(accepted).replace('{', '{"device_write_requested":true,'), '{}']) {
    const result = await fixture.run({ output }); assert.equal(result.code, 5);
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'invalid_znp_tool_response', outcome: 'unknown', retry_allowed: false } });
  }
  assert.equal((await fixture.calls()).length, 3);
});

test('组件失败保留未知状态和status，伪造可重试错误拒绝', async t => {
  const fixture = await tool(t), error = { error: { code: 'znp_zcl_rejected', status: 0x81, outcome: 'unknown', retry_allowed: false } };
  const result = await fixture.run({ error: JSON.stringify(error) }); assert.equal(result.code, 5); assert.deepEqual(JSON.parse(result.stderr), error);
  const forged = await fixture.run({ error: JSON.stringify({ error: { code: 'znp_timeout', outcome: 'unknown', retry_allowed: true } }) });
  assert.equal(forged.code, 5); assert.deepEqual(JSON.parse(forged.stderr), { error: { code: 'znp_tool_failed', outcome: 'unknown', retry_allowed: false } });
  assert.equal((await fixture.calls()).length, 2);
});

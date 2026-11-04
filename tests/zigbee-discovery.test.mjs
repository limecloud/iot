import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { verifyZigbeeNeighborsReport } from '../packages/protocol/zigbee-discovery.mjs';

const coordinator = '0102030405060708';
const schema = JSON.parse(readFileSync(new URL('../contracts/zigbee-diagnostics.schema.json', import.meta.url)));
const ajv = new Ajv2020({ strict: true, allErrors: true }); ajv.addSchema(schema);
const response = ajv.getSchema(schema.$id), request = ajv.compile({ $ref: schema.$id + '#/$defs/request' });
const report = JSON.parse(readFileSync(new URL('../.dev/znp-discovery-20261104/pty-results.json', import.meta.url)));
assert.equal(report.passed, true); assert.equal(report.failures + report.errors, 0); assert.equal(report.hardware, false);
const successes = report.records.filter(record => record.exit_code === 0).map(record => record.stdout);

test('邻居发现输入合同只允许明确协调器的固定读取', () => {
  const input = { command: 'neighbors', serial: '/dev/ttyUSB0', coordinator_ieee: coordinator };
  assert(request(input));
  for (const change of [{ coordinator_ieee: '0'.repeat(16) }, { coordinator_ieee: '01020304050607AA' },
    { address: '0x1234' }, { endpoint: 1 }, { ieee_address: '1122334455667788' }, { permit_join: true }, { broadcast: true }]) assert.equal(request({ ...input, ...change }), false);
  const missing = { ...input }; delete missing.coordinator_ieee; assert.equal(request(missing), false);
});

test('真实串口与CLI分页结果满足正式合同和跨字段校验', () => {
  assert(successes.length >= 6);
  assert(successes.some(value => value.result.items.length === 64));
  assert(successes.some(value => value.result.items.length === 0));
  for (const value of successes) {
    assert(response(value), JSON.stringify(response.errors));
    assert.equal(verifyZigbeeNeighborsReport(value, coordinator), value);
  }
});

test('客户端拒绝截断、混入设备、错协调器与伪造标志', () => {
  const sample = successes.find(value => value.result.items.length === 4);
  assert(sample);
  const changes = [
    value => value.result.items.pop(),
    value => { value.result.table_entries = 65; },
    value => { value.result.items[1].ieee_address = value.result.items[0].ieee_address; },
    value => { value.result.items[1].network_address = value.result.items[0].network_address; },
    value => { value.result.coordinator_ieee = '0902030405060708'; },
    value => { value.result.scope = 'entire_network'; },
    value => { value.result.items[0].device_type = 1; },
    value => { value.result.items[0].network_address = 0; },
    value => { value.result.page_count = 0; },
    value => { value.result.ncp.capabilities = 1; },
    value => { value.device_binding_created = true; },
    value => { value.owner_token = 'must-not-be-printed'; },
  ];
  for (const change of changes) {
    const value = structuredClone(sample); change(value);
    assert.throws(() => verifyZigbeeNeighborsReport(value, coordinator), /invalid_znp_tool_response/);
  }
});

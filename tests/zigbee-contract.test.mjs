import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../packages/cli/src/main.mjs', import.meta.url));
const schema = JSON.parse(readFileSync(new URL('../contracts/zigbee-diagnostics.schema.json', import.meta.url)));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const validate = ajv.getSchema(schema.$id);
const request = ajv.compile({ $ref: `${schema.$id}#/$defs/request` });
const error = ajv.compile({ $ref: `${schema.$id}#/$defs/error` });

test('离线发现返回正式合同，无需组件或串口', () => {
  const stdout = execFileSync(process.execPath, [cli, 'zigbee', 'schema'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, LIMEIOT_ZNP_TOOL: '/does-not-exist' },
  });
  assert.deepEqual(JSON.parse(stdout), schema);
  assert(request({ command: 'probe', serial: '/dev/ttyUSB0' }));
  assert(request({ command: 'interview', serial: '/dev/ttyUSB0', address: '0xfff7', timeout_ms: 30000 }));
  assert(request({ command: 'read-environment', serial: '/dev/ttyUSB0', coordinator_ieee: '0102030405060708', ieee_address: '1122334455667788', endpoint: 1 }));
});

test('环境读取合同要求显式身份与端点，拒绝任意ZCL参数', () => {
  const valid = { command: 'read-environment', serial: '/dev/ttyUSB0', coordinator_ieee: '0102030405060708', ieee_address: '1122334455667788', endpoint: 1 };
  for (const change of [
    { coordinator_ieee: '0000000000000000' }, { ieee_address: 'ffffffffffffffff' },
    { ieee_address: '11223344556677AA' }, { endpoint: 0 }, { endpoint: 241 },
    { endpoint: '1' }, { address: '0x1234' }, { cluster: 6 }, { write_attributes: true },
  ]) assert.equal(request({ ...valid, ...change }), false);
  for (const key of ['coordinator_ieee', 'ieee_address', 'endpoint']) {
    const missing = { ...valid };
    delete missing[key];
    assert.equal(request(missing), false);
  }
});

test('实际AF/ZCL旅程符合严格合同，属性时间和值有界', () => {
  const report = JSON.parse(readFileSync(new URL('../.dev/znp-environment-20261104/pty-results.json', import.meta.url)));
  assert.equal(report.passed, true);
  assert.equal(report.hardware, false);
  assert(report.tests >= 17);
  assert.equal(report.failures + report.errors, 0);
  let success = 0;
  for (const record of report.records) {
    if (record.exit_code !== 0) {
      assert(error(record.stderr), JSON.stringify(error.errors));
      continue;
    }
    assert(validate(record.stdout), JSON.stringify(validate.errors));
    assert.equal(record.stdout.operation, 'read-environment');
    success++;
    for (const [property, invalid] of [['temperature_celsius_x100', -32768], ['humidity_percent_x100', 65535]]) {
      const changed = structuredClone(record.stdout);
      changed.result[property].value = invalid;
      assert.equal(validate(changed), false);
    }
    const changed = { ...record.stdout, device_binding_created: true };
    assert.equal(validate(changed), false);
  }
  assert(success >= 10);
});

test('合同拒绝任意MT、广播、超范围和额外字段', () => {
  for (const value of [
    { command: 'reset', serial: '/dev/ttyUSB0' },
    { command: 'probe', serial: 'ttyUSB0' },
    { command: 'interview', serial: '/dev/ttyUSB0', address: '0xffff' },
    { command: 'interview', serial: '/dev/ttyUSB0', address: '0xfff8' },
    { command: 'interview', serial: '/dev/ttyUSB0' },
    { command: 'probe', serial: '/dev/ttyUSB0', address: '0x1234' },
    { command: 'probe', serial: '/dev/ttyUSB0', timeout_ms: 99 },
    { command: 'probe', serial: '/dev/ttyUSB0', timeout_ms: 30001 },
    { command: 'probe', serial: '/dev/ttyUSB0', network_key: 'forbidden' },
  ]) assert.equal(request(value), false, JSON.stringify(value));
});

test('真实串口软件旅程输出符合严格Schema', () => {
  const report = JSON.parse(readFileSync(new URL('../.dev/znp-verification-20261103/pty-results.json', import.meta.url)));
  assert.equal(report.passed, true);
  assert.equal(report.hardware, false);
  assert(report.tests >= 20);
  assert.equal(report.failures + report.errors, 0);
  let success = 0;
  for (const record of report.records) {
    if (record.exit_code === 0) {
      assert(validate(record.stdout), JSON.stringify(validate.errors));
      success++;
      const changed = { ...record.stdout, device_binding_created: true };
      assert.equal(validate(changed), false);
    } else assert(error(record.stderr), JSON.stringify(error.errors));
  }
  assert(success >= 4);
});

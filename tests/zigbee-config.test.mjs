import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => JSON.parse(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
const schema = read('contracts/zigbee-environment.schema.json');
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const fixture = read('deploy/dev/zigbee-environment.example.json');

test('网关配置Schema可离线发现，示例绑定固定环境模型', async () => {
  const output = execFileSync(process.execPath, ['packages/cli/src/main.mjs', 'zigbee', 'config-schema'], { cwd: root, encoding: 'utf8', env: { ...process.env, LIMEIOT_ZNP_TOOL: '/not-installed' } });
  assert.deepEqual(JSON.parse(output), schema);
  assert(validate(fixture), JSON.stringify(validate.errors));
  assert(validate({ schema_version: 1, bindings: [] }));
  assert(validate(read('deploy/dev/zigbee-coordinator.example.json')), JSON.stringify(validate.errors));
  const config = read('deploy/dev/zigbee-gateway.example.json');
  const model = read('contracts/models/environment.json');
  assert.equal(fixture.bindings[0].model_revision, await documentDigest(model));
  assert.deepEqual(config.models.at(-1), model);
  assert.deepEqual(config.devices.at(-1), { device_id: fixture.bindings[0].device_id, model_revision: fixture.bindings[0].model_revision });
});

test('配置拒绝额外执行能力、坏身份、计数与轮询边界', () => {
  for (const change of [{ serial: 'ttyUSB0' }, { serial: '/dev/tty\0USB0' }, { poll_interval_ms: 999 }, { timeout_ms: 30001 },
    { target: { ...fixture.bindings[0].target, endpoint: 241 } }, { target: { ...fixture.bindings[0].target, ieee_address: 'ffffffffffffffff' } },
    { signature: { ...fixture.bindings[0].signature, manufacturer: '\n' } }, { permit_join: true }, { network_key: 'forbidden' }, { write_attributes: [] }]) {
    const invalid = structuredClone(fixture); Object.assign(invalid.bindings[0], change);
    assert.equal(validate(invalid), false, JSON.stringify(change));
  }
  assert.equal(validate({ ...fixture, schema_version: 2 }), false);
  assert.equal(validate({ ...fixture, bindings: Array(17).fill(fixture.bindings[0]) }), false);
  assert.equal(validate({ ...fixture, factory_reset: true }), false);
});

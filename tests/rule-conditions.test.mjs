import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { base, commandResult, post } from './helpers/actions.mjs';

const fixture = async () => JSON.parse(await readFile(path.join(root, 'contracts/examples/button-conditional-light.json')));
test('条件Schema严格且有界，两个工具副本与正式合同一致', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/rule.schema.json')));
  const validate = new Ajv({ strict: true }).compile(schema);
  const rule = await fixture(); assert(validate(rule), JSON.stringify(validate.errors));
  const comparison = { device: 'device-lamp', property: 'light.power', operator: 'eq', value: true };
  for (const conditions of [[{ shell: 'reboot' }], [{ all: [] }], [{ all: [], any: [] }], [{ all: [{ all: [{ all: [{ all: [comparison] }] }] }] }], [{ ...comparison, operator: 'gt' }], [{ ...comparison, unit: null }], Array.from({ length: 17 }, () => comparison)]) {
    assert.equal(validate({ ...rule, conditions }), false, JSON.stringify(conditions));
  }
  let count = 0;
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.title === schema.title) { assert.deepEqual(value, schema); count++; return; }
    Object.values(value).forEach(walk);
  }
  walk(JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json')))); assert.equal(count, 2);
});

test('条件规则经MQTT/HTTP/CLI预演与执行，原观测证据不被后续采样或重启覆盖', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/rule-conditions-'));
  const stack = await startStack({ directory }); t.after(() => stack.close());
  const rule = await fixture();
  const input = { rule, event: { device_id: 'device-button', path: 'button.pressed', historical: false, data: { count: 1 } } };
  let index = 0;
  const set = async (property, value) => {
    const device = (await stack.request(base + '/devices/device-lamp')).value;
    const result = await stack.request(base + '/commands', post({ device_id: device.device_id, model_revision: device.model_revision,
      expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: property, value } }, `condition-manual-${index++}`));
    assert([200, 201, 202].includes(result.status)); await commandResult(stack, result.value.command_id);
    await until(async () => (await stack.request(base + '/devices/device-lamp')).value.reported[property].value === value);
  };
  const press = async id => {
    stack.button.stdin.write(JSON.stringify({ event_id: id, occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } }) + '\n');
    return until(async () => (await stack.request(base + '/runs')).value.items.find(run => run.event_id === id));
  };
  await set('light.brightness', 50); await set('light.power', false);
  const notMet = await stack.request(base + '/rules:simulate', post(input)); assert.equal(notMet.status, 200);
  assert.equal(notMet.value.executed, false); assert.equal(notMet.value.matched, false); assert.deepEqual(notMet.value.proposed_actions, []);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  const skipped = await press('condition-false'); assert.equal(skipped.error, 'rule_conditions_not_met'); assert.deepEqual(skipped.command_ids, []);
  assert.equal(skipped.condition_evaluation.results[0].children[1].children[0].observation.value, false);
  await set('light.power', true);
  const proof = await stack.request(base + '/rules:simulate', post(input)); assert.equal(proof.value.matched, true); assert.equal(proof.value.executed, false);
  const executed = await press('condition-true'); assert.equal(executed.error, null); assert.equal(executed.command_ids.length, 1);
  assert.equal(executed.condition_evaluation.results[0].children[0].observation.value, 50);
  await commandResult(stack, executed.command_ids[0]);
  await until(async () => (await stack.request(base + '/devices/device-lamp')).value.reported['light.brightness'].value === 30);
  const original = structuredClone(executed.condition_evaluation);
  const file = path.join(directory, 'preview.json'); await writeFile(file, JSON.stringify(input));
  const cli = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'rules.simulate', '--space-id', 'space-demo', '--input', file], { cwd: root, env: stack.env })).stdout);
  assert.equal(cli.matched, false); assert.equal(cli.condition_evaluation.results[0].children[0].observation.value, 30);
  await stack.restartGateway(); await stack.restartDevice('lamp'); await stack.restartDevice('button');
  const restarted = await press('condition-after-restart'); assert.equal(restarted.error, 'rule_conditions_not_met');
  const runs = (await stack.request(base + '/runs')).value.items;
  assert.equal(runs.length, 3); assert.deepEqual(runs.find(run => run.run_id === executed.run_id).condition_evaluation, original);
  const commands = (await stack.request(base + '/commands')).value.items; assert.equal(commands.length, 4); assert(commands.every(command => command.status === 'confirmed'));
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, real_http_mqtt_sqlite: true, cli_simulation: true,
    manual_commands: 3, automation_commands: 1, unmet_runs: 2, current_snapshot_preview: true, frozen_observation_evidence: true,
    restart_preserves_evidence: true, hardware: false, hardware_status: '用户要求跳过', native_app_runtime: false, full_goal_completed: false }, null, 2) + '\n');
});

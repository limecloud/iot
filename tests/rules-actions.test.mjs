import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root, until } from '../tools/dev-stack.mjs';
import { actionState, base, commandResult, post, startActionStack } from './helpers/actions.mjs';

const exec = promisify(execFile);
const fixture = async () => JSON.parse(await readFile(path.join(root, 'contracts/examples/button-tv.json'), 'utf8'));
const event = (id, historical = false) => ({ event_id: id, occurred_at: new Date().toISOString(), historical, data: { count: 1 } });
const press = (stack, input) => stack.button.stdin.write(JSON.stringify(input) + '\n');
async function receivedEvents(stack, count) {
  await until(async () => (await stack.request(base + '/events?after=0')).value.items.filter(item => item.type === 'device.event').length >= count);
}

test('规则 Schema 与工具发现同步，动作互斥且旧属性规则兼容', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/rule.schema.json'), 'utf8'));
  const validate = new Ajv({ strict: true }).compile(schema);
  const rule = await fixture(); assert(validate(rule));
  assert(validate(JSON.parse(await readFile(path.join(root, 'contracts/examples/button-light.json'), 'utf8'))));
  for (const action of [{ device: 'device-lamp' }, { device: 'device-lamp', invoke: null }, { device: 'device-lamp', invoke: { path: 'remote.press' } }, { ...rule.actions[0], set: { path: 'audio.muted', value: true } }, { ...rule.actions[0], set: null }]) {
    assert.equal(validate({ ...rule, actions: [action] }), false, JSON.stringify(action));
  }
  const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8'));
  let copies = 0;
  function check(value) {
    if (Array.isArray(value)) return value.forEach(check);
    if (!value || typeof value !== 'object') return;
    if (value.title === schema.title) { assert.deepEqual(value, schema); copies++; return; }
    Object.values(value).forEach(check);
  }
  check(catalog); assert.equal(copies, 2);
});

test('动作规则通过 CLI/HTTP 预演零副作用，混合步骤经 MQTT 按序执行并耐久去重', { timeout: 60000 }, async t => {
  const stack = await startActionStack(); t.after(() => stack.close());
  const rule = await fixture();
  rule.actions.push({ device: 'device-lamp', set: { path: 'audio.volume', value: 37 } }, { device: 'device-lamp', invoke: { path: 'apps.launch', input: { application_id: 'org.example.player' } } });
  const cli = async (operation, input) => {
    const filename = path.join(stack.directory, 'cli-rule.json'); await writeFile(filename, JSON.stringify(input));
    return JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'invoke', operation, '--space-id', 'space-demo', '--input', filename], { cwd: root, env: stack.env })).stdout);
  };
  for (const input of [{ key: 'shell' }, { key: 'home', shell: 'reboot' }, 'home']) {
    const bad = structuredClone(rule); bad.actions[0].invoke.input = input;
    assert.equal((await stack.request(base + '/rules:validate', post(bad))).value.error.code, 'invalid_value');
  }
  assert.equal((await cli('rules.validate', rule)).valid, true);
  const proof = await cli('rules.simulate', { rule, event: { device_id: 'device-button', path: 'button.pressed', historical: false, data: { count: 1 } } });
  assert.equal(proof.executed, false); assert.equal(proof.matched, true); assert.deepEqual(proof.proposed_actions, rule.actions);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const before = await actionState(stack).catch(error => { if (error.code === 'ENOENT') return { action_log: [] }; throw error; });
  assert.equal(before.action_log.length, 0);
  const deployment = (await stack.request(base + '/rule-deployments', post(rule))).value;
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).value.revision, deployment.revision);
  const original = event('action-rule-first'); press(stack, original);
  const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
  assert.equal(run.command_ids.length, 3);
  const commands = [];
  for (const id of run.command_ids) commands.push(await commandResult(stack, id));
  assert.deepEqual(commands.map(item => item.request.operation.type), ['action.invoke', 'property.set', 'action.invoke']);
  assert(commands.every(item => item.run_id === run.run_id));
  assert.equal(commands[0].evidence.completion, 'submitted');
  const state = await actionState(stack); assert.equal(state.reported['audio.volume'], 37);
  assert.deepEqual(state.action_log.map(item => item.command_id), [run.command_ids[0], run.command_ids[2]]);
  press(stack, original); press(stack, event('history', true)); press(stack, event('cooling'));
  await receivedEvents(stack, 4);
  assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
  await stack.restartGateway(); await stack.restartDevice('lamp');
  await until(async () => (await stack.request(base + '/devices/device-button')).value.ready);
  press(stack, original);
  await receivedEvents(stack, 5);
  assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 3);
  assert.equal((await actionState(stack)).action_log.length, 2);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items[0].revision, deployment.revision);
  const stopped = await stack.request(base + '/rule-deployments/' + rule.id + '/stop', post({ revision: deployment.revision })); assert.equal(stopped.status, 200);
  await writeFile(path.join(stack.directory, 'rules-actions-result.json'), JSON.stringify({ passed: true, real_http: true, real_mqtt: true, real_sqlite: true, cli: true, simulation_zero_effects: true, mixed_fifo: true, event_dedupe: true, gateway_device_restart: true, hardware: false }));
});

test('动作规则丢回执后保留 unknown，重启与重复事件不补发', { timeout: 40000 }, async t => {
  const stack = await startActionStack({ dropResults: true }); t.after(() => stack.close());
  const rule = await fixture(); rule.cooldown_ms = 0;
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  const original = event('lost-rule-result'); press(stack, original);
  const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
  const command = await commandResult(stack, run.command_ids[0], 'unknown');
  assert.equal((await actionState(stack)).action_log.length, 1);
  await stack.restartGateway(); await stack.restartDevice('lamp', { LIMEIOT_SIM_DROP_RESULTS: '0' });
  await until(async () => (await stack.request(base + '/devices/device-button')).value.ready);
  press(stack, original);
  await receivedEvents(stack, 2);
  assert.equal((await stack.request(base + '/commands/' + command.command_id)).value.status, 'unknown');
  assert.equal((await stack.request(base + '/commands/by-key/' + command.request.idempotency_key)).value.command_id, command.command_id);
  assert.equal((await actionState(stack)).action_log.length, 1);
  assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
  await writeFile(path.join(stack.directory, 'rules-actions-unknown-result.json'), JSON.stringify({ passed: true, real_http: true, real_mqtt: true, lost_receipt: true, unknown_after_restart: true, duplicate_event_no_replay: true, hardware: false }));
});

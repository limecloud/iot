import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { root, startStack, until } from '../tools/dev-stack.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const example = path.join(root, 'examples/compositions/reading-companion');
const event = id => ({ event_id: id, occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } });
const press = (stack, value) => stack.button.stdin.write(JSON.stringify(value) + '\n');
const events = async stack => (await stack.request(base + '/events?after=0')).value.items.filter(item => item.type === 'device.event').length;

for (const lost of [false, true]) test(`组合伴读样板：CLI规划、明确部署、${lost ? '丢回执未知' : '两步确认'}、重启与明确停用`, { timeout: 60000 }, async t => {
  const stack = await startStack({ dropResults: lost }); t.after(() => stack.close());
  t.diagnostic('evidence: ' + stack.directory);
  async function cli(operation, args = []) {
    return JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', ...operation, ...args], { cwd: root, env: stack.env, timeout: 15000 })).stdout);
  }
  const id = lost ? 'companion-unknown' : 'companion-confirmed';
  const plan = await cli(['composition', 'plan'], ['--input', path.join(example, 'package.json'), '--bindings', path.join(example, 'bindings.json'), '--id', id, '--space-id', 'space-demo']);
  assert.equal(plan.gateway_checked, true); assert.equal(plan.deployed, false);
  assert.equal(plan.simulation.executed, false); assert.equal(plan.simulation.matched, true);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  const ruleFile = path.join(stack.directory, 'compiled-rule.json');
  await writeFile(ruleFile, JSON.stringify(plan.rule));
  const deploy = () => cli(['invoke', 'rules.deploy'], ['--space-id', 'space-demo', '--input', ruleFile]);
  const deployment = await deploy(); assert.equal(deployment.revision, plan.rule_revision);
  assert.equal((await deploy()).revision, deployment.revision);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const original = event('companion-original'); press(stack, original);
  const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
  assert.equal(run.command_ids.length, 2);
  const commands = await until(async () => {
    const list = [];
    for (const command of run.command_ids) list.push((await stack.request(base + '/commands/' + command)).value);
    return list.every(command => ['confirmed', 'unknown', 'expired', 'failed'].includes(command.status)) && list;
  }, 10000);
  if (lost) assert.equal(commands[0].status, 'unknown');
  else {
    assert(commands.every(command => command.status === 'confirmed'));
    const lamp = (await stack.request(base + '/devices/device-lamp')).value;
    assert.equal(lamp.reported['light.power'].value, true);
    assert.equal(lamp.reported['light.brightness'].value, 35);
  }
  assert(commands.every(command => command.run_id === run.run_id));
  const deviceBeforeRestart = JSON.parse(await readFile(path.join(stack.directory, 'lamp.json'), 'utf8'));
  await stack.restartGateway(); await stack.restartDevice('lamp', { LIMEIOT_SIM_DROP_RESULTS: '0' });
  await until(async () => (await stack.request(base + '/devices/device-button')).value.ready);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items[0].revision, plan.rule_revision);
  for (const command of commands) {
    const recovered = await cli(['invoke', 'commands.resolve'], ['--space-id', 'space-demo', '--id', command.request.idempotency_key]).catch(error => {
      // 统一命令CLI对unknown/expired使用非零退出，正文仍是原命令。
      if ([6, 7].includes(error.code)) return JSON.parse(error.stdout);
      throw error;
    });
    assert.equal(recovered.command_id, command.command_id); assert.equal(recovered.status, command.status);
  }
  const beforeDuplicate = await events(stack); press(stack, original);
  await until(async () => await events(stack) > beforeDuplicate);
  assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
  const afterRestart = JSON.parse(await readFile(path.join(stack.directory, 'lamp.json'), 'utf8'));
  assert.deepEqual(afterRestart.reported, deviceBeforeRestart.reported);
  const stopFile = path.join(stack.directory, 'stop.json'); await writeFile(stopFile, JSON.stringify({ revision: deployment.revision }));
  await cli(['invoke', 'rules.stop'], ['--space-id', 'space-demo', '--id', id, '--input', stopFile]);
  const beforeStopEvent = await events(stack); press(stack, event('companion-after-stop'));
  await until(async () => await events(stack) > beforeStopEvent);
  assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  const result = { passed: true, real_rust_gateway: true, real_mqtt: true, real_sqlite: true, cli: true,
    package_digest: plan.package_digest, bindings_digest: plan.bindings_digest, rule_revision: plan.rule_revision,
    package_modules: 2, generated_actions: 2, planning_device_commands: 0, planning_deployments: 0,
    explicit_deployment: true, gateway_restarts: 1, device_restarts: 1,
    command_statuses: commands.map(command => command.status), lost_receipt: lost,
    original_queries_preserved: true, duplicate_event_no_replay: true, explicit_stop_blocks_new_event: true,
    hardware: false, toy_firmware: false, multimodal_companion: false, full_goal_completed: false };
  await writeFile(path.join(stack.directory, 'composition-result.json'), JSON.stringify(result, null, 2) + '\n');
});

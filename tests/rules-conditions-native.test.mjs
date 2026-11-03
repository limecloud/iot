import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { base, commandResult, post } from './helpers/actions.mjs';

const exec = promisify(execFile);
for (const target of ['ios', 'android']) test(`${target} 原生条件表单、HTTP预演与部署、MQTT执行与原证据回读`, { timeout: 240000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/native-conditions-' + target + '-'));
  const stack = await startStack({ directory }); t.after(() => stack.close());
  const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-conditional-light.json'))); rule.cooldown_ms = 1001;
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  async function native(phase) {
    const args = target === 'ios' ? ['run', 'ClientChecks'] : ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', '*ConditionEditorTest', '--rerun-tasks'];
    try {
      const result = await exec(target === 'ios' ? 'swift' : 'sh', args, { cwd: path.join(root, 'apps', target), env: { ...stack.env, LIMEIOT_CONDITION_CHECK: '1', LIMEIOT_CONDITION_PHASE: phase }, timeout: 100000, maxBuffer: 4 * 1024 * 1024 });
      await writeFile(path.join(directory, target + '-' + phase + '.log'), result.stdout + result.stderr);
      if (target === 'ios') assert.match(result.stdout, /"condition_integration":"passed"/);
    } catch (error) { await writeFile(path.join(directory, target + '-' + phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
  }
  await native('edit');
  const edited = (await stack.request(base + '/rule-deployments')).value.items[0].rule;
  assert.equal(edited.conditions[0].all[0].value, 45); assert.deepEqual(edited.conditions[0].all[1], rule.conditions[0].all[1]); assert.equal(edited.cooldown_ms, 1001);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const press = async id => { stack.button.stdin.write(JSON.stringify({ event_id: id, occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } }) + '\n'); return until(async () => (await stack.request(base + '/runs')).value.items.find(run => run.event_id === id)); };
  const skipped = await press('native-condition-unmet'); assert.equal(skipped.error, 'rule_conditions_not_met'); assert.deepEqual(skipped.command_ids, []);
  let index = 0;
  for (const [property, value] of [['light.power', true], ['light.brightness', 50]]) {
    const device = (await stack.request(base + '/devices/device-lamp')).value;
    const response = await stack.request(base + '/commands', post({ device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: property, value } }, 'native-condition-' + index++));
    await commandResult(stack, response.value.command_id); await until(async () => (await stack.request(base + '/devices/device-lamp')).value.reported[property].value === value);
  }
  const executed = await press('native-condition-met'); await commandResult(stack, executed.command_ids[0]);
  assert.equal(executed.condition_evaluation.results[0].children[0].observation.value, 50);
  const frozen = structuredClone(executed.condition_evaluation);
  await stack.restartGateway(); await native('read');
  assert.deepEqual((await stack.request(base + '/runs')).value.items.find(run => run.run_id === executed.run_id).condition_evaluation, frozen);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 3);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, target, native_host_library: true, real_http_mqtt_sqlite: true, full_tree_edit_roundtrip: true, millisecond_cooldown: 1001, unmet_preview_can_review: true, preview_commands: 0, manual_commands: 2, automation_commands: 1, unmet_runs: 1, restart_frozen_evidence: true, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
});

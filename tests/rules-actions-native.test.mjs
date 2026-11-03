import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { actionState, base, commandResult, startActionStack } from './helpers/actions.mjs';

const exec = promisify(execFile);
for (const target of ['ios', 'android']) test(`${target} 动作规则：原生合同、HTTP预演与部署回读、MQTT执行`, { timeout: 240000 }, async t => {
  const stack = await startActionStack(); t.after(() => stack.close());
  const args = target === 'ios' ? ['run', 'ClientChecks'] : ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', '*RuleActionTest', '--rerun-tasks'];
  try {
    const result = await exec(target === 'ios' ? 'swift' : 'sh', args, { cwd: path.join(root, 'apps', target), env: { ...stack.env, LIMEIOT_RULE_ACTION_CHECK: '1' }, timeout: 210000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(path.join(stack.directory, target + '-rules.log'), result.stdout + result.stderr);
  } catch (error) {
    await writeFile(path.join(stack.directory, target + '-rules.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error;
  }
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const deployment = (await stack.request(base + '/rule-deployments')).value.items[0];
  assert.equal(deployment.rule.actions[0].invoke.path, 'remote.press');
  stack.button.stdin.write(JSON.stringify({ event_id: target + '-rule-trigger', data: { count: 1 } }) + '\n');
  const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
  const command = await commandResult(stack, run.command_ids[0]);
  assert.equal(command.evidence.completion, 'submitted');
  assert.equal((await actionState(stack)).action_log.length, 1);
  await writeFile(path.join(stack.directory, 'rules-actions-native-result.json'), JSON.stringify({ passed: true, target, real_http: true, real_mqtt: true, strict_action_contract: true, simulation_zero_effects: true, deployment_readback: true, effects: 1, native_app_runtime: false, hardware: false }));
});

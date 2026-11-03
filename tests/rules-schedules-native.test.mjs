import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack } from '../tools/dev-stack.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
for (const target of ['ios', 'android']) test(`${target} 宿主 SDK 定时合同、网关预演、完整回填与明确停用`, { timeout: 120000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const args = target === 'ios' ? ['run', 'ClientChecks'] : ['gradlew', '--offline', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', '*RuleTriggerTest', '--rerun-tasks'];
  let output;
  try {
    const result = await exec(target === 'ios' ? 'swift' : 'sh', args, { cwd: path.join(root, 'apps', target), env: { ...stack.env, LIMEIOT_SCHEDULE_CHECK: '1' }, timeout: 100000, maxBuffer: 4 * 1024 * 1024 });
    output = result.stdout + result.stderr;
  } catch (error) { await writeFile(path.join(stack.directory, 'schedule-' + target + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
  await writeFile(path.join(stack.directory, 'schedule-' + target + '.log'), output);
  if (target === 'ios') assert.match(output, /"schedule_integration":"passed"/);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  await writeFile(path.join(stack.directory, 'schedule-native-result.json'), JSON.stringify({ passed: true, target, native_host_library: true, native_app_runtime: false, real_http_mqtt_sqlite: true, schedule_roundtrip: true, create_edit_stop: true, commands: 0, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2));
  console.log('定时 SDK 报告：' + path.join(stack.directory, 'schedule-native-result.json'));
});

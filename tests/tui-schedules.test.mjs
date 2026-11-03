import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack } from '../tools/dev-stack.mjs';
import { GatewayTaskSession } from '../packages/cli/src/task-session.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
test('真实 PTY 创建、修改和取消定时规则，保持任务记录与预演零命令', { timeout: 60000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const taskDirectory = path.join(stack.directory, 'tasks');
  const session = new GatewayTaskSession({ endpoint: stack.env.LIMEIOT_ENDPOINT, token: stack.env.LIMEIOT_TOKEN, space: 'space-demo', directory: taskDirectory, catalog: JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'))) });
  const snapshot = await session.refresh(), scheduleIndex = snapshot.sources.length + 1;
  const deviceIndex = snapshot.snapshot.devices.findIndex(device => device.device_id === 'device-lamp') + 1;
  const powerIndex = snapshot.operations['device-lamp'].findIndex(item => item.path === 'light.power') + 1;
  const time = new Date(Date.now() + 7200000).toISOString().slice(11, 16), editedTime = new Date(Date.now() + 10800000).toISOString().slice(11, 16);
  const menu = '0 退出> ', choice = '选择，0 返回> ', ruleMenu = '6 更换触发  7 编辑条件  0 取消> ', steps = [];
  const step = (expect, send) => steps.push({ expect, ...(send === undefined ? {} : { send: String(send) }) });
  step(menu, 2); step('3 停用规则  0 返回> ', 1); step('规则 ID，回车保留 '); step('> ', 'tui-schedule');
  step('选择触发事件或属性'); step(choice, scheduleIndex);
  step('时间（HH:MM），回车保留 22:00> ', '24:00'); step('IANA 时区，回车保留 '); step('> ', 'UTC'); step('星期（周一=1，逗号分隔），回车保留 1,2,3,4,5,6,7> ', '1,3,7');
  step('请检查时间、时区和星期'); step('时间（HH:MM），回车保留 24:00> ', time); step('IANA 时区，回车保留 UTC> ', ''); step('星期（周一=1，逗号分隔），回车保留 1,3,7> ', '');
  step('冷却时间（毫秒），回车保留 10000> ', 1001);
  step(ruleMenu, 1); step('选择设备'); step(choice, deviceIndex); step('选择能力'); step(choice, powerIndex); step('输入参数'); step('选择，回车保留 1，0 返回> ', 1);
  step(ruleMenu, 5); step('输入“启用”确认，回车取消> ', '启用'); step('自动化已启用');
  function edit(currentTime, nextTime, confirm) {
    step(menu, 2); step('3 停用规则  0 返回> ', 2); step('选择规则'); step(choice, 1);
    step('规则 ID，回车保留 tui-schedule> ', ''); step('选择触发事件或属性'); step(`选择，回车保留 ${scheduleIndex}，0 返回> `, '');
    step(`时间（HH:MM），回车保留 ${currentTime}> `, nextTime); step('IANA 时区，回车保留 UTC> ', ''); step('星期（周一=1，逗号分隔），回车保留 1,3,7> ', '');
    step('冷却时间（毫秒），回车保留 1001> ', ''); step(ruleMenu, 5); step('输入“启用”确认，回车取消> ', confirm); step(confirm ? '自动化已启用' : '已取消，未发送');
  }
  edit(time, editedTime, '启用'); edit(editedTime, time, ''); step(menu, 0);
  const stepsPath = path.join(stack.directory, 'schedule-steps.json'), transcript = path.join(stack.directory, 'schedule-transcript.txt');
  await writeFile(stepsPath, JSON.stringify(steps));
  const result = await exec('python3', ['tests/support/tui-pty.py', process.execPath, 'packages/cli/src/main.mjs', stepsPath, transcript], { cwd: root, env: { ...stack.env, LIMEIOT_TEST_TASK_DIR: taskDirectory }, timeout: 45000 });
  assert.equal(JSON.parse(result.stdout).pty, true); assert.equal((await readFile(transcript, 'utf8')).includes(stack.env.LIMEIOT_TOKEN), false);
  const deployment = (await stack.request(base + '/rule-deployments')).value.items[0];
  assert.deepEqual(deployment.rule.trigger, { schedule: { time: editedTime, time_zone: 'UTC', weekdays: [1,3,7] } }); assert.equal(deployment.rule.cooldown_ms, 1001);
  assert.equal((await session.records()).length, 2); assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await stack.restartGateway(); assert.deepEqual((await stack.request(base + '/rule-deployments')).value.items[0].rule, deployment.rule);
  await writeFile(path.join(stack.directory, 'schedule-tui-result.json'), JSON.stringify({ passed: true, real_pty_http_mqtt_sqlite: true, invalid_time_retry: true, create_edit: true, cancel_preserves_rule: true, original_tasks: 2, commands: 0, restart: true, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2));
  console.log('定时 TUI 报告：' + path.join(stack.directory, 'schedule-tui-result.json'));
});

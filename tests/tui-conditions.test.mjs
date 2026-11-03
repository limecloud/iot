import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack } from '../tools/dev-stack.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
test('真实PTY创建与编辑条件树，精确单位、取消、当前条件未满足、重启和停用', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/tui-conditions-')), nas = path.join(directory, 'nas');
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', nas, '--origin', 'https://127.0.0.1:18443', '--with-environment'], { cwd: root });
  const stack = await startStack({ directory: path.join(directory, 'runtime'), environment: true, gatewayEnv: { LIMEIOT_CONFIG: path.join(nas, 'config/gateway.json') } }); t.after(() => stack.close());
  const taskDirectory = path.join(directory, 'tasks');
  const snapshot = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'tui', '--snapshot', '--space-id', 'space-demo', '--state-dir', taskDirectory], { cwd: root, env: stack.env })).stdout);
  const triggerIndex = snapshot.sources.findIndex(source => source.path === 'button.pressed') + 1;
  const temperatureIndex = snapshot.condition_sources.findIndex(source => source.path === 'environment.temperature') + 1;
  const powerIndex = snapshot.condition_sources.findIndex(source => source.path === 'light.power') + 1;
  assert(temperatureIndex > 0 && powerIndex > 0); assert.equal(snapshot.sources.some(source => source.path === 'light.power'), false);
  const deviceIndex = snapshot.snapshot.devices.findIndex(device => device.device_id === 'device-lamp') + 1;
  const operationIndex = snapshot.operations['device-lamp'].findIndex(operation => operation.path === 'light.brightness') + 1;
  const menu = '0 退出> ', choice = '选择，0 返回> ', ruleMenu = '7 编辑条件  0 取消> ', conditionsMenu = '5 保存条件  0 取消条件编辑> ';
  const retained = index => `选择，回车保留 ${index}，0 返回> `;
  const steps = [], step = (expect, send) => steps.push({ expect, ...(send === undefined ? {} : { send: String(send) }) });
  step(menu, 2); step('3 停用规则  0 返回> ', 1); step('规则 ID，回车保留 '); step('> ', 'tui-conditions');
  step('选择触发事件或属性'); step(choice, triggerIndex); step('冷却时间（毫秒），回车保留 10000> ', 1250);
  step(ruleMenu, 1); step('选择设备'); step(choice, deviceIndex); step('选择能力'); step(choice, operationIndex); step('输入参数（integer），回车保留 0> ', 30);
  step(ruleMenu, 7); step(conditionsMenu, 2); step('添加到'); step(choice, 1); step('组合方式'); step(choice, 1);
  step('选择条件属性'); step(choice, temperatureIndex); step('选择比较方式'); step(retained(1), 6);
  step('比较值（℃），回车保留 "-45"，/cancel 返回> ', '28.001');
  step('比较值不符合属性类型、单位精度或值域'); step('比较值（℃），回车保留 "28.001"，/cancel 返回> ', '28.03');
  step(conditionsMenu, 2); step('添加到'); step(choice, 2); step('组合方式'); step(choice, 2);
  step('选择条件属性'); step(choice, powerIndex); step('选择比较方式'); step(retained(1), ''); step('选择比较值'); step(retained(1), ''); step(conditionsMenu, 5);
  step(ruleMenu, 5); step('预演事件样本'); step('count（integer），回车保留 1> ', '');
  step('触发样例有效，当前条件未满足。启用后等待新的触发，不会补执行。'); step('输入“启用”确认，回车取消> ', '启用'); step('自动化已启用');
  function edit(confirm) {
    step(menu, 2); step('3 停用规则  0 返回> ', 2); step('选择规则'); step(choice, 1); step('规则 ID，回车保留 tui-conditions> ', '');
    step('选择触发事件或属性'); step(retained(triggerIndex), ''); step('冷却时间（毫秒），回车保留 1250> ', '');
    step(ruleMenu, 7); step(conditionsMenu, 3); step('选择条件'); step(choice, 2);
    step('选择条件属性'); step(retained(temperatureIndex), ''); step('选择比较方式'); step(retained(6), ''); step('比较值（℃），回车保留 "28.03"，/cancel 返回> ', '29.03');
    step(conditionsMenu, 5); step(ruleMenu, 5); step('预演事件样本'); step('count（integer），回车保留 1> ', '');
    step('输入“启用”确认，回车取消> ', confirm); step(confirm ? '自动化已启用' : '已取消，未发送');
  }
  edit(''); step(menu, 0);
  async function pty(name, entries) {
    const file = path.join(directory, name + '-steps.json'), transcript = path.join(directory, name + '-transcript.txt'); await writeFile(file, JSON.stringify(entries));
    const result = await exec('python3', ['tests/support/tui-pty.py', process.execPath, 'packages/cli/src/main.mjs', file, transcript], { cwd: root, env: { ...stack.env, LIMEIOT_TEST_TASK_DIR: taskDirectory }, timeout: 45000 });
    assert.equal(JSON.parse(result.stdout).pty, true); assert.equal((await readFile(transcript, 'utf8')).includes(stack.env.LIMEIOT_TOKEN), false);
  }
  await pty('create-cancel', steps);
  const deployment = (await stack.request(base + '/rule-deployments')).value.items[0];
  assert.equal(deployment.rule.conditions[0].all[0].value, 2803, '取消后的部署仍保留原比较值');
  assert.deepEqual(deployment.rule.conditions[0].all[1], { any: [{ device: 'device-lamp', property: 'light.power', operator: 'eq', value: true }] });
  steps.length = 0; edit('启用'); step(menu, 0); await pty('edit', steps);
  const expected = { ...deployment.rule, conditions: [{ all: [{ device: 'device-environment', property: 'environment.temperature', operator: 'gte', value: 2903, unit: 'celsius_x100' }, deployment.rule.conditions[0].all[1]] }] };
  assert.deepEqual((await stack.request(base + '/rule-deployments')).value.items[0].rule, expected);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await stack.restartGateway(); assert.deepEqual((await stack.request(base + '/rule-deployments')).value.items[0].rule, expected);
  await pty('stop', [{ expect: menu, send: '2' }, { expect: '3 停用规则  0 返回> ', send: '3' }, { expect: '选择规则' }, { expect: choice, send: '1' }, { expect: '输入“停用”确认，回车取消> ', send: '停用' }, { expect: '自动化已停用' }, { expect: menu, send: '0' }]);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0); assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, real_pty: true, journeys: 3, real_http_mqtt_sqlite: true, full_tree_create_edit_cancel_stop: true, condition_source_discovery: true, exact_unit_precision_retry: true, unmet_explicit_deployment: true, millisecond_cooldown_preserved: true, gateway_restart: true, commands: 0, hardware: false, hardware_status: '用户要求跳过', native_app_runtime: false, full_goal_completed: false }, null, 2) + '\n');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, until, stop } from '../tools/dev-stack.mjs';
import { base, startActionStack, actionState, commandResult, post } from './helpers/actions.mjs';
import { GatewayTaskSession } from '../packages/cli/src/task-session.mjs';

const exec = promisify(execFile);
const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8'));
const example = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-tv.json'), 'utf8'));
function sessionFor(stack, options = {}) {
  return new GatewayTaskSession({ endpoint: stack.env.LIMEIOT_ENDPOINT, token: stack.env.LIMEIOT_TOKEN, space: 'space-demo', directory: path.join(stack.directory, 'terminal-tasks'), catalog, ...options });
}
const prepare = { action: 'commands.prepare', device_id: 'device-lamp', type: 'action.invoke', path: 'remote.press', value: { key: 'home' } };

test('本地Agent终端经真实HTTP/MQTT执行与恢复，规则部署按修订原子拒绝覆盖', { timeout: 60000 }, async t => {
  const stack = await startActionStack(); t.after(() => stack.close());
  let lost = true;
  const session = sessionFor(stack, { transport: async (url, options) => {
    const response = await fetch(url, options);
    if (lost && options.method === 'POST' && url.pathname.endsWith('/commands')) { lost = false; await response.arrayBuffer(); throw new Error('response_lost_after_accept'); }
    return response;
  } });
  await session.dispatch(prepare); const task = session.review.record;
  await assert.rejects(session.dispatch({ action: 'commit', task_id: task.task_id }), error => error.safeCode === 'operation_unknown');
  await until(async () => (await actionState(stack)).action_log.length === 1);
  await stack.restartGateway();
  await stack.restartDevice('lamp'); await stack.restartDevice('button');
  const recovered = sessionFor(stack);
  const original = await recovered.dispatch({ action: 'resolve', task_id: task.task_id });
  assert.equal(original.result.command.status, 'confirmed'); assert.equal(original.result.command.evidence.completion, 'submitted');
  assert.equal((await stack.request(base + '/commands')).value.items.length, 1);

  const observedSession = sessionFor(stack, { transport: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'POST' && url.pathname.endsWith('/rule-deployments')) { await response.arrayBuffer(); throw new Error('rule_response_lost'); }
    return response;
  } });
  const observedRule = { ...example, id: 'terminal-observed' };
  await observedSession.dispatch({ action: 'rules.prepare', rule: observedRule, event_data: { count: 1 } });
  const observedId = observedSession.review.record.task_id;
  await assert.rejects(observedSession.dispatch({ action: 'commit', task_id: observedId }), error => error.safeCode === 'operation_unknown');
  const observation = await observedSession.dispatch({ action: 'resolve', task_id: observedId });
  assert.equal(observation.unknown, true); assert.equal(observation.result, null); assert.equal(observation.observation.currently_deployed, true);
  assert.equal((await stack.request(base + '/rule-deployments/' + observedRule.id + '/stop', post({ revision: observation.observation.revision }))).status, 200);

  const mixed = { ...example, id: 'terminal-mixed', actions: [...example.actions, { device: 'device-lamp', set: { path: 'audio.volume', value: 37 } }] };
  await recovered.dispatch({ action: 'rules.prepare', rule: mixed, event_data: { count: 1 } });
  assert.equal((await stack.request(base + '/commands')).value.items.length, 1);
  const deployment = await recovered.dispatch({ action: 'commit', task_id: recovered.review.record.task_id });
  assert.equal(deployment.result.outcome, 'deployed');
  const stale = sessionFor(stack); await stale.dispatch({ action: 'rules.prepare', rule: { ...mixed, cooldown_ms: 100 }, event_data: { count: 1 } });
  const concurrent = { ...mixed, cooldown_ms: 200 };
  // 在最后一次读取后、条件POST之前注入另一位所有者的明确更新。
  const transport = stale.transport;
  stale.transport = async (url, options) => {
    if (options.method === 'POST' && url.pathname.endsWith('/rule-deployments')) assert.equal((await stack.request(base + '/rule-deployments', post(concurrent))).status, 200);
    return transport(url, options);
  };
  await assert.rejects(stale.dispatch({ action: 'commit', task_id: stale.review.record.task_id }), error => error.safeCode === 'revision_conflict');
  assert.deepEqual((await stack.request(base + '/rule-deployments')).value.items[0].rule, concurrent);
  const conflictTask = (await stale.journal.list()).find(record => record.result?.outcome === 'rejected');
  assert.equal(conflictTask.result.error, 'revision_conflict');
  // create-only与畸形条件头同样在服务端拒绝，不改变当前部署。
  for (const headers of [{ 'If-None-Match': '*' }, { 'If-Match': 'bad' }, { 'If-Match': '"' + deployment.result.deployment.revision + '"', 'If-None-Match': '*' }]) {
    const result = await stack.request(base + '/rule-deployments', { ...post(mixed), headers: { ...post(mixed).headers, ...headers } });
    assert([409, 422].includes(result.status));
  }
  await recovered.dispatch({ action: 'rules.stop.prepare', rule_id: mixed.id });
  await recovered.dispatch({ action: 'commit', task_id: recovered.review.record.task_id });
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);

  // 验证真实CLI路由、交互NDJSON及明确commit，不把session类测试当作入口测试。
  const child = spawn(process.execPath, ['packages/cli/src/main.mjs', 'tui', '--stdio', '--space-id', 'space-demo', '--state-dir', path.join(stack.directory, 'agent-tasks')], { cwd: root, env: stack.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => stop(child));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async action => {
    child.stdin.write(JSON.stringify(action) + '\n');
    const line = await lines.next(); assert.equal(line.done, false);
    const response = JSON.parse(line.value); assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
  };
  await ask({ action: 'refresh' });
  const review = await ask({ ...prepare, path: 'apps.launch', value: { application_id: 'org.example.player' } });
  const result = await ask({ action: 'commit', task_id: review.review.record.task_id });
  await commandResult(stack, result.result.command.command_id);
  const final = await ask({ action: 'resolve', task_id: result.task_id });
  assert.equal(final.result.command.status, 'confirmed');
  child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); assert.equal(child.exitCode, 0);
  assert.equal((await actionState(stack)).action_log.length, 2);
  await writeFile(path.join(stack.directory, 'tui-result.json'), JSON.stringify({ passed: true, http: true, mqtt: true, sqlite_restart: true, cli_stdio: true, response_loss_no_repost: true, rule_observation_not_decision: true, atomic_rule_revision: true, hardware: false }));
});

test('真实PTY完成取消、能力表单、混合规则追加/重排/预演/启用，按键经MQTT执行', { timeout: 60000 }, async t => {
  const stack = await startActionStack(); t.after(() => stack.close());
  const session = sessionFor(stack); await session.dispatch({ action: 'refresh' });
  const deviceIndex = String(session.data.devices.findIndex(item => item.device_id === 'device-lamp') + 1);
  const operations = session.operations('device-lamp');
  const remoteIndex = String(operations.findIndex(item => item.path === 'remote.press') + 1);
  const volumeIndex = String(operations.findIndex(item => item.path === 'audio.volume') + 1);
  const menu = '0 退出> ', choice = '选择，0 返回> ', ruleMenu = '6 更换触发  7 编辑条件  0 取消> ';
  const steps = [];
  const step = (expect, send) => steps.push({ expect, ...(send === undefined ? {} : { send }) });
  const operation = (index, value, initial = false) => {
    if (initial) step(menu, '1');
    step('选择设备', undefined); step(choice, deviceIndex);
    step('选择能力', undefined); step(choice, index);
    step(index === remoteIndex ? '选择，回车保留 1，0 返回> ' : '输入参数（integer），回车保留 0> ', value);
  };
  operation(remoteIndex, '0', true); // 枚举中返回，不能把null当输入提交。
  operation(remoteIndex, '7', true); step('输入“执行”确认，回车取消> ', '执行'); step('原任务：task-', undefined);
  step(menu, '2'); step('3 停用规则  0 返回> ', '1'); step('规则 ID，回车保留 ', undefined); step('> ', 'pty-mixed');
  step('选择触发事件', undefined); step(choice, '1'); step('冷却时间（毫秒），回车保留 10000> ', '0');
  step(ruleMenu, '1'); operation(remoteIndex, '7');
  step(ruleMenu, '1'); operation(volumeIndex, '37');
  step(ruleMenu, '4'); step('选择操作', undefined); step(choice, '2'); step('移动到第几步（1 至 2）> ', '1');
  step(ruleMenu, '5'); step('count（integer），回车保留 1> ', ''); step('输入“启用”确认，回车取消> ', '启用');
  step('自动化已启用', undefined); step(menu, '0');
  const stepsPath = path.join(stack.directory, 'pty-steps.json'), transcript = path.join(stack.directory, 'tui-transcript.txt');
  await writeFile(stepsPath, JSON.stringify(steps));
  const output = await exec('python3', ['tests/support/tui-pty.py', process.execPath, 'packages/cli/src/main.mjs', stepsPath, transcript], { cwd: root, env: { ...stack.env, LIMEIOT_TEST_TASK_DIR: path.join(stack.directory, 'pty-tasks') }, timeout: 45000 });
  assert.equal(JSON.parse(output.stdout).pty, true);
  const deployment = (await stack.request(base + '/rule-deployments')).value.items.find(item => item.rule.id === 'pty-mixed');
  assert.deepEqual(deployment.rule.actions, [{ device: 'device-lamp', set: { path: 'audio.volume', value: 37 } }, example.actions[0]]);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 1);
  stack.button.stdin.write(JSON.stringify({ event_id: 'pty-press', occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } }) + '\n');
  const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
  for (const id of run.command_ids) await commandResult(stack, id);
  assert.equal((await actionState(stack)).reported['audio.volume'], 37);
  assert.equal((await actionState(stack)).action_log.length, 2);
  const text = await readFile(transcript, 'utf8'); assert(text.includes('输入已提交') || text.includes('已受理') || text.includes('已发送'));
  assert.equal(text.includes(stack.env.LIMEIOT_TOKEN), false);
  await writeFile(path.join(stack.directory, 'tui-pty-result.json'), JSON.stringify({ passed: true, pty: true, steps: steps.length, cancel_zero_commands: true, multi_step_reorder: true, http: true, mqtt: true, hardware: false }));
});

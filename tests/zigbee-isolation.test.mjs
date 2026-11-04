import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { until } from '../tools/dev-stack.mjs';
import { base, post, targets, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

test('同NCP异常目标不清除健康来源边沿，共享复位和坏帧仍使整组离线', { timeout: 90000 }, async t => {
  const { directory, stack, sensor, commands, control, stats } = await environmentStack(t, 2);
  for (let index = 0; index < 2; index++) {
    assert.equal((await stack.request(base + '/rule-deployments', post(thresholdRule(index)))).status, 200);
  }
  const waitValue = (index, value) => until(async () => {
    const current = await sensor(index);
    return current.ready && current.reported['environment.temperature'].value === value && current;
  });
  const waitCommands = count => until(async () => {
    const items = await commands();
    return items.length === count && items.every(command => command.status === 'confirmed') && items;
  });
  let commandCount = 0;
  const phases = [];
  for (const mode of ['timeout', 'wrong_signature']) {
    await control(2700);
    await waitValue(0, 2700);
    await control(2900, mode, 1);
    await until(async () => !(await sensor(1)).ready);
    const before = await stats();
    const low = await waitValue(0, 2700);
    // 至少两个后续健康采样跨越异常目标的重复轮询，不以一次偶然读取当故障隔离。
    await until(async () => (await sensor()).state_revision >= low.state_revision + 2);
    assert.equal((await sensor(1)).ready, false);
    assert.equal((await sensor(1)).reported['environment.temperature'].quality, 'stale');
    await control(2900);
    const items = await waitCommands(++commandCount);
    const triggered = items.find(command => command.request.operation.value === 30);
    assert.ok(triggered);
    assert.equal(items.filter(command => command.request.operation.value === 40).length, 0);
    const after = await stats();
    assert.ok(after.samples[targets[0]] >= before.samples[targets[0]] + 3);
    assert.equal((await sensor(1)).ready, false);
    phases.push({ mode, healthy_before: before.samples[targets[0]], healthy_after: after.samples[targets[0]], confirmed_commands: items.length });
  }
  // 异常目标恢复时第一个高温样本只建立自身基线，不补发掉线前边沿。
  await control(2900, 'normal', 1);
  const recovered = await waitValue(1, 2900);
  await until(async () => (await sensor(1)).state_revision > recovered.state_revision);
  assert.equal((await commands()).length, commandCount);
  await control(2600, 'normal', 1); await waitValue(1, 2600);
  await control(2900, 'normal', 1);
  await waitCommands(++commandCount);
  assert.equal((await commands()).filter(command => command.request.operation.value === 40).length, 1);

  for (const mode of ['reset', 'invalid_frame']) {
    await control(2700); await waitValue(0, 2700);
    await control(2600, mode, 1);
    await until(async () => !(await sensor()).ready && !(await sensor(1)).ready);
    assert.equal((await sensor()).reported['environment.temperature'].quality, 'stale');
    await control(2900);
    await control(2600, 'normal', 1);
    const fresh = await waitValue(0, 2900);
    await waitValue(1, 2600);
    await until(async () => (await sensor()).state_revision > fresh.state_revision);
    assert.equal((await commands()).length, commandCount, '共享故障后首个高温样本重建基线');
    phases.push({ mode, both_offline: true, recovery_no_replay: true });
  }
  const beforeRestart = (await commands()).map(command => command.command_id).sort();
  await stack.restartGateway();
  await until(async () => (await sensor()).ready && (await sensor(1)).ready);
  assert.deepEqual((await commands()).map(command => command.command_id).sort(), beforeRestart);
  const runs = (await stack.request(base + '/runs')).value.items;
  assert.equal(runs.length, commandCount);
  assert.ok(runs.every(run => run.condition_evaluation.matched));
  await writeFile(path.join(directory, 'isolation-report.json'), JSON.stringify({ passed: true,
    real_gateway_sqlite_mqtt: true, targets: 2, one_serial_ncp: true, phases,
    target_recovery_baseline: true, shared_failure_resets_all: true, gateway_restart_no_replay: true,
    confirmed_commands: commandCount, hardware: false, published: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'isolation-report.json') }));
});

test('85次正常读取后的串口会话轮换保留两台设备的阈值基线', { timeout: 90000 }, async t => {
  const { directory, stack, sensor, commands, control, stats } = await environmentStack(t, 2);
  for (let index = 0; index < 2; index++) {
    assert.equal((await stack.request(base + '/rule-deployments', post(thresholdRule(index)))).status, 200);
  }
  const initial = await stats();
  assert.equal(initial.host_checks, 1);
  const initialRevisions = [(await sensor()).state_revision, (await sensor(1)).state_revision];
  // 两个目标每秒各轮询一次；保留真实85次容量边界，不缩小生产限制。
  const rotated = await until(async () => {
    const current = await stats();
    return current.host_checks > initial.host_checks
      && Object.values(current.samples).reduce((sum, value) => sum + value, 0) >= 86 && current;
  }, 60000);
  assert.equal(rotated.host_checks, 2);
  assert.equal(rotated.session_samples[0], 85, '第一个传输完整读取85次，不以异常重连冒充容量轮换');
  assert.ok(rotated.session_samples[1] >= 1);
  assert.ok(Object.values(rotated.samples).reduce((sum, value) => sum + value, 0) >= 86);
  assert.equal((await commands()).length, 0);
  await control(2900); await control(2900, 'normal', 1);
  const result = await until(async () => {
    const items = await commands();
    return items.length === 2 && items.every(command => command.status === 'confirmed') && items;
  });
  assert.deepEqual(result.map(command => command.request.operation.value).sort(), [30, 40]);
  const runs = (await stack.request(base + '/runs')).value.items;
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(run => run.property_trigger.previous.value).sort(), [2600, 2700]);
  assert.ok(runs.every(run => run.property_trigger.current.value === 2900));
  assert.ok((await sensor()).state_revision > initialRevisions[0]);
  assert.ok((await sensor(1)).state_revision > initialRevisions[1]);
  // 核对完整耐久事件，避免高频HTTP轮询争用网关，也不会漏掉两次轮询之间的离线。
  const { stdout } = await promisify(execFile)('python3', ['-c',
    "import json,sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps(c.execute(\"SELECT type,data FROM events WHERE type='observation.closed'\").fetchall()))",
    stack.env.LIMEIOT_DB]);
  assert.deepEqual(JSON.parse(stdout), [], '正常会话轮换不关闭任何来源');
  await writeFile(path.join(directory, 'rotation-report.json'), JSON.stringify({ passed: true,
    real_gateway_sqlite_mqtt: true, targets: 2, initial, rotated,
    both_threshold_baselines_preserved: true, durable_source_closes: 0, confirmed_commands: 2,
    hardware: false, published: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'rotation-report.json') }));
});

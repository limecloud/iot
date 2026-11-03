import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { GatewayTaskSession } from '../packages/cli/src/task-session.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ruleAt = date => ({ version: 1, id: 'bedtime', trigger: { schedule: { time: date.toISOString().slice(11, 16), time_zone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7] } }, conditions: [], actions: [{ device: 'device-lamp', set: { path: 'light.power', value: true } }], cooldown_ms: 0 });

test('定时触发的 Schema 和两份工具合同一致，拒绝混合触发与无效时间/星期', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/rule.schema.json'), 'utf8'));
  const validate = new Ajv({ strict: true }).compile(schema), rule = ruleAt(new Date());
  assert(validate(rule), JSON.stringify(validate.errors));
  for (const trigger of [{ ...rule.trigger, device: 'device-lamp' }, { ...rule.trigger, event: 'button.pressed' }, { schedule: null },
    ...[{ time: '24:00' }, { time: '1:00' }, { time: '12:60' }, { time: '22:00\n' }, { weekdays: [] }, { weekdays: [1, 1] }, { weekdays: [0] }, { extra: true }].map(change => ({ schedule: { ...rule.trigger.schedule, ...change } }))]) {
    assert.equal(validate({ ...rule, trigger }), false, JSON.stringify(trigger));
  }
  let copies = 0;
  function check(value) {
    if (!value || typeof value !== 'object') return;
    if (value.title === schema.title) { assert.deepEqual(value, schema); copies++; return; }
    Object.values(value).forEach(check);
  }
  check(JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8')));
  assert.equal(copies, 2);
});

test('真实墙钟定时经 CLI 预演、显式提交、MQTT 执行一次，重启保留原记录', { timeout: 100000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const at = new Date(Math.ceil((Date.now() + 8000) / 60000) * 60000), rule = ruleAt(at);
  const cli = async (operation, input) => {
    const filename = path.join(stack.directory, 'schedule-input.json'); await writeFile(filename, JSON.stringify(input));
    return JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'invoke', operation, '--space-id', 'space-demo', '--input', filename], { cwd: root, env: stack.env, timeout: 10000 })).stdout);
  };
  const validation = await cli('rules.validate', rule);
  assert.equal(validation.valid, true); assert.equal(Date.parse(validation.schedule_preview.scheduled_at), +at);
  const proof = await cli('rules.simulate', { rule, event: { scheduled_at: at.toISOString() } });
  assert.equal(proof.executed, false); assert.equal(proof.matched, true); assert.deepEqual(proof.proposed_actions, rule.actions);
  assert.equal((await stack.request(base + '/rules:simulate', post({ rule, event: { scheduled_at: new Date(+at + 1000).toISOString() } }))).value.matched, false);
  assert.equal((await stack.request(base + '/rules:validate', post({ ...rule, trigger: { schedule: { ...rule.trigger.schedule, time_zone: 'Unknown/Zone' } } }))).status, 422);
  const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8'));
  const session = new GatewayTaskSession({ endpoint: stack.env.LIMEIOT_ENDPOINT, token: stack.env.LIMEIOT_TOKEN, space: 'space-demo', directory: path.join(stack.directory, 'tasks'), catalog });
  const prepared = await session.prepareRule(rule);
  assert.equal(prepared.review.simulation.matched, true);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  await session.commit(prepared.review.record.task_id);
  const deployment = (await stack.request(base + '/rule-deployments')).value.items[0];
  assert.deepEqual(deployment.rule, rule); assert.equal(deployment.revision, validation.revision);
  assert(Date.now() < +at - 1000, '部署必须在计划时刻之前完成');
  const run = await until(async () => (await stack.request(base + '/runs')).value.items[0], +at - Date.now() + 10000);
  assert.equal(run.command_ids.length, 1); assert.equal(run.error, null);
  assert.deepEqual(run.schedule_trigger, { scheduled_at: at.toISOString().replace('.000Z', 'Z'), local_date: at.toISOString().slice(0, 10), local_time: rule.trigger.schedule.time, time_zone: 'UTC' });
  const command = await until(async () => { const item = (await stack.request(base + '/commands/' + run.command_ids[0])).value; return item.status === 'confirmed' && item; });
  assert.equal(command.run_id, run.run_id);
  assert.equal((await stack.request(base + '/devices/device-lamp')).value.reported['light.power'].value, true);
  await stack.restartGateway(); await stack.restartDevice('lamp');
  assert.deepEqual((await stack.request(base + '/runs')).value.items, [run]);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 1);
  const stopped = await session.prepareStop(rule.id); await session.commit(stopped.review.record.task_id);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  const disk = JSON.parse((await exec('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); v,b=c.execute("SELECT version,body FROM snapshot").fetchone(); print(json.dumps({"version":v,"runs":json.loads(b)["runs"]}))', path.join(stack.directory, 'gateway.sqlite')])).stdout);
  assert.equal(disk.version, 11); assert.equal(Object.values(disk.runs)[0].run_id, run.run_id);
  await writeFile(path.join(stack.directory, 'schedule-result.json'), JSON.stringify({ passed: true, real_wall_clock: true, scheduled_at: at.toISOString(), real_http_mqtt_sqlite: true, cli_preview: true, explicit_task_commit: true, preview_commands: 0, commands: 1, restart_no_replay: true, snapshot_version: 11, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2));
  console.log('定时旅程报告：' + path.join(stack.directory, 'schedule-result.json'));
});

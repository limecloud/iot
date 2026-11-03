import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { root, startStack, until } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const base = '/api/v1/spaces/space-demo';
const modelPath = path.join(root, 'contracts/models/gootuan-show-simulator-v2.json');
const post = (body, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });

async function start() {
  await mkdir(path.join(root, '.dev'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.dev/execution-plans-'));
  const model = JSON.parse(await readFile(modelPath, 'utf8'));
  const report = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'model', 'validate', '--input', modelPath], {
    cwd: root, env: { ...process.env, LIMEIOT_MODEL_VALIDATOR: path.join(root, 'target/debug/limeiot-model-validator') },
  })).stdout);
  assert.equal(report.valid, true);
  const config = { space_id: 'space-demo', models: [report.normalized_model], devices: ['device-lamp', 'device-button'].map(device_id => ({ device_id, model_revision: report.model_revision })) };
  const configPath = path.join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  return { stack: await startStack({ directory, modelPaths: { lamp: modelPath, button: modelPath }, gatewayEnv: { LIMEIOT_CONFIG: configPath } }), revision: report.model_revision, model };
}

const get = async (stack, id) => {
  const response = await stack.request(`${base}/execution-plans/${id}`);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
};
async function change(stack, input, key) {
  const response = await stack.request(`${base}/execution-plan-operations`, post(input, key));
  assert.equal(response.status, 200, JSON.stringify(response.value));
  assert.equal(response.value.status, 'applied', JSON.stringify(response.value));
  assert.equal('applied_snapshot' in response.value, false, 'internal decision snapshots are not public API data');
  return response.value;
}
const commandStage = (revision, level) => ({ steps: ['device-lamp', 'device-button'].map((device_id, index) => ({
  step_id: `level-${level}-${index}`, device_id, model_revision: revision,
  operation: { type: 'property.set', path: 'light.level', value: level }, command_timeout_ms: 5000, completion: { type: 'command' },
})) });
const create = (id, stages) => ({ type: 'plans.create', plan_id: id, generation: 'generation-' + id, stages, expires_at: new Date(Date.now() + 120000).toISOString() });
async function transition(stack, id, type, key = `${type}-${id}`) {
  const plan = await get(stack, id);
  return change(stack, { type: 'plans.' + type, plan_id: id, expected_revision: plan.revision }, key);
}
async function childrenConfirmed(stack, id) {
  return until(async () => {
    const plan = await get(stack, id);
    if (plan.children.length !== 2) return false;
    const commands = await Promise.all(plan.children.map(child => stack.request(`${base}/commands/${child.command_id}`)));
    return commands.every(item => item.value.status === 'confirmed') && plan;
  });
}
function sendResult(stack, plan, name, { generation = plan.generation, status = 'completed', eventID = `${plan.plan_id}-${name}-${status}` } = {}) {
  const step = plan.stages[0].steps.find(item => item.device_id === 'device-' + name);
  const event = { event_id: eventID, path: 'show.finished', occurred_at: new Date().toISOString(), historical: false,
    data: { task_id: plan.plan_id, generation, step_id: step.step_id, status } };
  stack[name].stdin.write(JSON.stringify(event) + '\n');
  return event;
}

test('真实双设备计划：预览无副作用、逐阶段结果屏障、原操作恢复、明确释放', { timeout: 45000 }, async t => {
  const { stack, revision } = await start(); t.after(() => stack.close());
  const input = create('two-device-plan', [commandStage(revision, 40), commandStage(revision, 0)]);
  const original = await change(stack, input, 'create-two-device-plan');
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const draft = await get(stack, input.plan_id);
  assert.equal(draft.status, 'draft');
  const denied = await fetch(`${stack.env.LIMEIOT_ENDPOINT}${base}/execution-plan-operations`, post(input, 'unauthorized'));
  assert.equal(denied.status, 401);
  await transition(stack, input.plan_id, 'start');
  const completed = await until(async () => { const p = await get(stack, input.plan_id); return p.status === 'completed' && p; });
  assert.equal(completed.children.length, 4);
  assert.equal(completed.physical_stop, 'not_requested');
  const commands = (await stack.request(base + '/commands')).value.items;
  assert.equal(commands.length, 4);
  assert(commands.every(item => item.status === 'confirmed' && item.run_id === input.plan_id));
  assert(commands.every(item => Date.parse(item.request.expires_at) - Date.parse(item.envelope.body.issued_at) <= 30000));
  for (const name of ['lamp', 'button']) assert.equal(JSON.parse(await readFile(path.join(stack.directory, name + '.json'), 'utf8')).reported['light.level'], 0);
  const replay = await change(stack, input, 'create-two-device-plan');
  assert.deepEqual(replay, original);
  const resolved = await stack.request(base + '/execution-plan-operations/by-key/create-two-device-plan');
  assert.deepEqual(resolved.value, original);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 4);
  const direct = { device_id: 'device-lamp', model_revision: revision, operation: { type: 'property.set', path: 'light.level', value: 10 }, expires_at: new Date(Date.now() + 5000).toISOString() };
  assert.equal((await stack.request(base + '/commands', post(direct, 'reserved-device'))).status, 409);
  await transition(stack, input.plan_id, 'release');
  assert.equal((await stack.request(base + '/commands', post(direct, 'released-device'))).status, 202);
  const db = JSON.parse((await exec('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("SELECT version FROM snapshot").fetchone()))', path.join(stack.directory, 'gateway.sqlite')])).stdout);
  assert.deepEqual(db, [12]);
  const stateDir = path.join(stack.directory, 'cli');
  const cli = await exec(process.execPath, ['packages/cli/src/main.mjs', 'execution-plans', 'get', '--space-id', 'space-demo', '--id', input.plan_id, '--state-dir', stateDir, '--json'], { cwd: root, env: stack.env });
  assert.equal(JSON.parse(cli.stdout).status, 'completed');
  await writeFile(path.join(stack.directory, 'execution-plans-result.json'), JSON.stringify({ passed: true, real_http: true, real_mqtt: true, real_sqlite: true, two_devices: true, stage_barrier: true, original_operation_recovery: true, explicit_release: true, hardware: false, motion: false, beat_synchronization: false }, null, 2) + '\n');
});

test('长任务只凭关联事件完成，取消与重启不重放且不伪造停车', { timeout: 60000 }, async t => {
  const { stack, revision } = await start(); t.after(() => stack.close());
  function taskPlan(id) {
    const input = create(id, []);
    input.stages = [{ steps: ['device-lamp', 'device-button'].map((device_id, index) => ({ step_id: 'show-' + index, device_id, model_revision: revision,
      operation: { type: 'action.invoke', path: 'show.run', value: { task_id: id, generation: input.generation, step_id: 'show-' + index, duration_ms: 60000 } },
      command_timeout_ms: 5000, completion: { type: 'event', path: 'show.finished', timeout_ms: 90000 },
    })) }, commandStage(revision, 25)];
    return input;
  }
  const input = taskPlan('cancel-long-task');
  await change(stack, input, 'create-cancel-long-task');
  await transition(stack, input.plan_id, 'start');
  let plan = await childrenConfirmed(stack, input.plan_id);
  assert.equal(plan.status, 'running', 'submitted is not long-task completion');
  sendResult(stack, plan, 'lamp', { generation: 'wrong-generation', eventID: 'wrong-generation' });
  await until(async () => (await stack.request(base + '/events?after=0')).value.items.some(item => item.payload?.data?.event_id === 'wrong-generation'));
  assert.equal((await get(stack, input.plan_id)).status, 'running');
  await transition(stack, input.plan_id, 'cancel');
  plan = await get(stack, input.plan_id);
  assert.equal(plan.status, 'unknown');
  assert.equal(plan.physical_stop, 'unknown');
  sendResult(stack, plan, 'lamp'); sendResult(stack, plan, 'button');
  await until(async () => (await stack.request(base + '/events?after=0')).value.items.some(item => item.payload?.data?.event_id === input.plan_id + '-button-completed'));
  assert.equal((await get(stack, input.plan_id)).status, 'unknown');
  assert.equal((await stack.request(base + '/commands')).value.items.length, 2, 'cancelled future stage never starts');
  await transition(stack, input.plan_id, 'release');

  const ready = taskPlan('complete-long-task');
  await change(stack, ready, 'create-complete-long-task');
  await transition(stack, ready.plan_id, 'start');
  plan = await childrenConfirmed(stack, ready.plan_id);
  const once = sendResult(stack, plan, 'lamp');
  stack.lamp.stdin.write(JSON.stringify(once) + '\n');
  sendResult(stack, plan, 'button');
  await until(async () => (await get(stack, ready.plan_id)).status === 'completed');
  assert.equal((await get(stack, ready.plan_id)).children.length, 4);
  await transition(stack, ready.plan_id, 'release');

  const restart = taskPlan('restart-long-task');
  await change(stack, restart, 'create-restart-long-task');
  await transition(stack, restart.plan_id, 'start');
  await childrenConfirmed(stack, restart.plan_id);
  const before = (await stack.request(base + '/commands')).value.items.length;
  await stack.restartGateway();
  assert.equal((await get(stack, restart.plan_id)).status, 'unknown');
  assert.equal((await get(stack, restart.plan_id)).physical_stop, 'unknown');
  assert.equal((await stack.request(base + '/commands')).value.items.length, before);
  await writeFile(path.join(stack.directory, 'execution-plan-recovery-result.json'), JSON.stringify({ passed: true, real_http: true, real_mqtt: true, real_sqlite: true, submitted_not_completion: true, wrong_generation_ignored: true, cancel_blocks_future_stage: true, late_event_no_resurrection: true, duplicate_completion_no_replay: true, restart_unknown_no_replay: true, physical_stop_claimed: false, hardware: false }, null, 2) + '\n');
});

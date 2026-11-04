import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { parseCompositionAttempt } from '../packages/protocol/composition.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const directory = path.join(root, '.dev/composition-native-20261105');
const event = id => ({ event_id: id, occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } });
const press = (stack, value) => stack.button.stdin.write(JSON.stringify(value) + '\n');
const events = async stack => (await stack.request(base + '/events?after=0')).value.items.filter(item => item.type === 'device.event').length;

for (const target of ['ios', 'android']) for (const lost of [false, true]) {
  test(`${target}组合包：原生状态层、${lost ? '丢部署回执' : '明确启用'}、三进程恢复和停用`, { timeout: 180000 }, async t => {
    const stack = await startStack(); t.after(() => stack.close());
    t.diagnostic('evidence: ' + stack.directory);
    const store = path.join(stack.directory, 'native-composition.json');
    async function native(phase) {
      const traceFile = path.join(stack.directory, phase + '-trace.json');
      const command = target === 'ios' ? path.join(directory, 'ios-composition-online-checks') : process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
      const args = target === 'ios' ? [] : ['-cp', await readFile(path.join(directory, 'android-classpath.txt'), 'utf8'), 'org.junit.runner.JUnitCore', 'run.limeai.iot.CompositionJourneyTest'];
      const env = { ...stack.env, LIMEIOT_COMPOSITION_PHASE: phase, LIMEIOT_COMPOSITION_STORE: store, LIMEIOT_COMPOSITION_TRACE: traceFile };
      try {
        const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        await writeFile(path.join(stack.directory, phase + '.log'), result.stdout + result.stderr);
        if (target === 'android') assert.match(result.stdout, /OK \(1 test\)/);
      } catch (error) {
        await writeFile(path.join(stack.directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error;
      }
      const trace = JSON.parse(await readFile(traceFile, 'utf8'));
      assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.host_ui_state, true);
      assert.deepEqual(trace.posts, phase.startsWith('deploy') ? ['rules:validate', 'rules:simulate', 'rule-deployments'] : phase === 'query-stop' ? ['stop'] : []);
      const raw = await readFile(store, 'utf8');
      const { record } = await parseCompositionAttempt(raw, stack.env.LIMEIOT_ENDPOINT, 'space-demo');
      assert.deepEqual(record, trace.record); assert.equal((await stat(store)).mode & 0o777, 0o600);
      assert.equal(raw.includes(stack.env.LIMEIOT_TOKEN), false);
      return record;
    }
    const original = await native(lost ? 'deploy-lost' : 'deploy');
    assert.equal(original.state, lost ? 'attempted' : 'acknowledged');
    assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
    const deployment = (await stack.request(base + '/rule-deployments')).value.items[0];
    assert.equal(deployment.revision, original.rule_revision);
    const firstEvent = event('native-composition-original'); press(stack, firstEvent);
    const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
    assert.equal(run.command_ids.length, 2);
    const commands = await until(async () => {
      const values = await Promise.all(run.command_ids.map(id => stack.request(base + '/commands/' + id)));
      return values.every(value => value.value.status === 'confirmed') && values.map(value => value.value);
    }, 10000);
    const lamp = (await stack.request(base + '/devices/device-lamp')).value;
    assert.equal(lamp.reported['light.power'].value, true); assert.equal(lamp.reported['light.brightness'].value, 35);
    const deviceBefore = JSON.parse(await readFile(path.join(stack.directory, 'lamp.json'), 'utf8'));
    await stack.restartGateway(); await stack.restartDevice('lamp');
    await until(async () => (await stack.request(base + '/devices/device-button')).value.ready);
    for (const command of commands) {
      const recovered = (await stack.request(base + '/commands/' + command.command_id)).value;
      assert.equal(recovered.command_id, command.command_id); assert.equal(recovered.status, command.status);
    }
    const beforeDuplicate = await events(stack); press(stack, firstEvent);
    await until(async () => await events(stack) > beforeDuplicate);
    assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
    assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
    assert.deepEqual(JSON.parse(await readFile(path.join(stack.directory, 'lamp.json'), 'utf8')).reported, deviceBefore.reported);
    assert.deepEqual(await native('query-stop'), original);
    const beforeStop = await events(stack); press(stack, event('native-composition-stopped'));
    await until(async () => await events(stack) > beforeStop);
    assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
    assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
    assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
    await stack.restartGateway(); assert.deepEqual(await native('query-stopped'), original);
    const report = { passed: true, target, lost_deployment_receipt: lost, real_rust_gateway: true, real_mqtt: true, real_sqlite: true,
      host_ui_state: true, native_processes: 3, gateway_restarts: 2, device_restarts: 1, original_record_unchanged: true,
      original_submission_state: original.state, command_statuses: commands.map(command => command.status),
      duplicate_event_no_replay: true, stop_blocks_new_event: true, conditional_deployment_posts: 1,
      native_app_runtime: false, production_secure_store_runtime: false, hardware: false, full_goal_completed: false };
    const file = path.join(stack.directory, 'composition-native-result.json');
    await writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: file }));
  });
}

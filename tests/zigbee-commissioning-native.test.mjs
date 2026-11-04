import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { root, until } from '../tools/dev-stack.mjs';
import { base, environmentStack, post, thresholdRule } from './fixtures/zigbee/runtime.mjs';
import { verifyZigbeeOperation } from '../packages/protocol/zigbee-operations.mjs';

const execute = promisify(execFile), selected = process.env.LIMEIOT_NATIVE_TARGET;
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
for (const target of ['ios', 'android'].filter(value => !selected || value === selected)) test(`${target} 入网确认、原生进程恢复和真实阈值联动`, { timeout: 360000 }, async t => {
  const { directory, stack, sensor, commands, control, stats } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  const store = path.join(directory, 'native-join-originals.json');
  async function native(phase) {
    const trace = path.join(directory, `${phase}-join-trace.json`);
    const command = target === 'ios' ? path.join(root, '.dev/observation-native-checks/ios-zigbee-state') : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.ZigbeeJourneyTest', '--rerun'];
    const env = { ...process.env, ...stack.env, LIMEIOT_ZIGBEE_LIVE: '1', LIMEIOT_ZIGBEE_PHASE: phase, LIMEIOT_ZIGBEE_STORE: store, LIMEIOT_ZIGBEE_TRACE: trace };
    try {
      const result = await execute(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 150000, maxBuffer: 2 * 1024 * 1024 });
      await writeFile(path.join(directory, `${phase}-join.log`), result.stdout + result.stderr);
    } catch (error) { await writeFile(path.join(directory, `${phase}-join.log`), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    if (target === 'android') {
      const xml = await readFile(path.join(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.ZigbeeJourneyTest.xml'), 'utf8');
      for (const [key, value] of Object.entries({ tests: 1, failures: 0, errors: 0, skipped: 0 })) assert.match(xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '', new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, `${phase}-join-junit.xml`), xml);
    }
    const result = JSON.parse(await readFile(trace, 'utf8'));
    assert.equal(result.passed, true); assert.equal(result.phase, phase); assert.equal(result.host_ui_state, true);
    assert.equal(result.commissioning_posts, phase === 'create' ? 2 : 1); assert.equal(result.records.length, phase === 'create' ? 2 : 3);
    for (const record of result.records) {
      await verifyZigbeeOperation(record.result, record.request);
      assert.deepEqual((await stack.request(base + '/zigbee-operations/by-key/' + record.request.idempotency_key)).value, record.result);
    }
    const saved = await readFile(store, 'utf8'); assert.equal(saved.includes(stack.env.LIMEIOT_TOKEN), false); assert.equal((await stat(store)).mode & 0o777, 0o600);
    return result;
  }
  const created = await native('create');
  const initial = await until(async () => { const value = await sensor(); return value.ready && value; });
  assert.deepEqual((await stats()).join_requests, [60, 0]); assert.equal((await commands()).length, 0);
  assert.equal((await stack.request(base + '/rule-deployments', post(thresholdRule()))).status, 200);
  await until(async () => (await sensor()).state_revision > initial.state_revision);
  await control(2900); await until(async () => { const list = await commands(); return list.length === 1 && list[0].status === 'confirmed'; });
  await stack.restartGateway(); await until(async () => (await sensor()).ready);
  assert.equal((await commands()).length, 1); assert.deepEqual((await stats()).join_requests, [60, 0]);
  const restored = await native('restore'); assert.deepEqual(restored.records.slice(0, 2), created.records);
  assert.deepEqual((await stats()).join_requests, [60, 0, 0]); assert.equal((await commands()).length, 1);
  await control(2700); await until(async () => (await sensor()).reported['environment.temperature'].value === 2700);
  await control(2900); await until(async () => { const list = await commands(); return list.length === 2 && list.every(command => command.status === 'confirmed'); });
  await stack.restartGateway(); await until(async () => (await sensor()).ready);
  assert.equal((await commands()).length, 2); assert.deepEqual((await stats()).join_requests, [60, 0, 0]); assert.deepEqual((await stats()).errors, []);
  const report = { passed: true, target, native_host_state: true, native_processes: 2, gateway_restarts: 2,
    commissioning_posts: 3, response_loss_and_original_get: true, explicit_close_preserves_prior_operations: true,
    native_discovery_endpoint_and_explicit_bind: true, confirmed_threshold_commands: 2, no_replay_after_restart: true,
    real_rust_sqlite_mqtt: true, software_pty_ncp: true, transport: 'loopback HTTP fixture',
    production_secure_store_runtime: false, native_app_runtime: false, hardware: false, published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'commissioning-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

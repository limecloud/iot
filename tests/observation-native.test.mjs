import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { root, until } from '../tools/dev-stack.mjs';
import { base, devices, environmentStack, post, thresholdRule } from './fixtures/zigbee/runtime.mjs';
import { verifyObservationBinding, verifyObservationOperation } from '../packages/protocol/observation-bindings.mjs';

const exec = promisify(execFile), selected = process.env.LIMEIOT_NATIVE_TARGET, onOff = process.env.LIMEIOT_OBSERVATION_PROFILE === "on_off";
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
for (const target of ['ios', 'android'].filter(value => !selected || value === selected)) test(`${target} 原生状态层经真实网关发现、端点查询、未知恢复、撤销和重启重绑`, { timeout: 360000 }, async t => {
  const { directory, stack, sensor, commands, control, stats } = await environmentStack(t, 1, { dynamic: true, onOff, timeoutMs: 1500 });
  const deviceID = onOff ? "zigbee-switch" : devices[0], readDevice = async () => (await stack.request(base + "/devices/" + deviceID)).value;
  const store = path.join(directory, 'native-originals.json');
  async function native(phase) {
    const trace = path.join(directory, `${phase}-trace.json`);
    const command = target === 'ios' ? path.join(root, '.dev/observation-native-checks/ios-observation-state') : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.ObservationJourneyTest', '--rerun'];
    const env = { ...process.env, ...stack.env, LIMEIOT_OBSERVATION_LIVE: '1', LIMEIOT_OBSERVATION_PHASE: phase, LIMEIOT_OBSERVATION_STORE: store, LIMEIOT_OBSERVATION_TRACE: trace };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 150000, maxBuffer: 2 * 1024 * 1024 }); await writeFile(path.join(directory, `${phase}.log`), result.stdout + result.stderr); }
    catch (error) { await writeFile(path.join(directory, `${phase}.log`), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    if (target === 'android') {
      const xml = await readFile(path.join(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.ObservationJourneyTest.xml'), 'utf8');
      for (const [key, value] of Object.entries({ tests: 1, failures: 0, errors: 0, skipped: 0 })) assert.match(xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '', new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, `${phase}-junit.xml`), xml);
    }
    const result = JSON.parse(await readFile(trace, 'utf8'));
    assert.equal(result.passed, true); assert.equal(result.phase, phase); assert.equal(result.host_ui_state, true);
    assert.equal(result.decision_posts, phase === 'create' ? 2 : 1); assert.equal(result.query_posts, 1);
    assert.equal(result.discovery_posts, 1); assert.equal(result.endpoint_posts, 1);
    assert.equal(result.records.length, phase === 'create' ? 2 : 3);
    for (const record of result.records) {
      await verifyObservationOperation(record.result, record.request);
      const original = (await stack.request(base + '/observation-operations/by-key/' + record.request.idempotency_key)).value;
      assert.deepEqual(original, record.result);
    }
    const saved = await readFile(store, 'utf8'); assert.equal(saved.includes(stack.env.LIMEIOT_TOKEN), false); assert.equal((await stat(store)).mode & 0o777, 0o600);
    return result;
  }
  const created = await native('create');
  assert.equal((await readDevice()).ready, false); assert.equal((await commands()).length, 0);
  await stack.restartGateway(); assert.equal((await readDevice()).ready, false);
  assert.deepEqual((await stack.request(base + '/observation-candidates')).value.items, []);
  const restored = await native('restore');
  assert.deepEqual(restored.records.slice(0, 2), created.records);
  const current = await verifyObservationBinding((await stack.request(base + '/devices/' + deviceID + '/observation-binding')).value, deviceID);
  assert.equal(current.binding.active, true);
  if (onOff) {
    assert.deepEqual(current.binding.write_paths, ["light.power"]);
    const device = await readDevice();
    assert.equal(device.reported["light.power"].value, false);
    const input = { device_id: deviceID, model_revision: device.model_revision, expires_at: new Date(Date.now() + 10000).toISOString(), operation: { type: "property.set", path: "light.power", value: true } };
    assert.equal((await stack.request(base + "/commands", { ...post(input), headers: { "Content-Type": "application/json", "Idempotency-Key": "native-state-switch" } })).status, 202);
    await until(async () => (await commands()).some(command => command.status === "confirmed"));
    assert.deepEqual((await stats()).switch_commands, [true]);
  } else {
    assert.equal((await readDevice()).reported["environment.temperature"].value, 2700);
    assert.equal((await stack.request(base + "/rule-deployments", post(thresholdRule()))).status, 200);
    const baseline = (await readDevice()).reported["environment.temperature"].observed_at;
    await until(async () => (await readDevice()).reported["environment.temperature"].observed_at !== baseline);
    await control(2900); await until(async () => { const list = await commands(); return list.length === 1 && list[0].status === "confirmed"; });
  }
  await stack.restartGateway(); await until(async () => (await readDevice()).ready);
  assert.equal((await commands()).length, 1, "网关恢复不补发历史命令");
  if (onOff) assert.deepEqual((await stats()).switch_commands, [true]);
  else assert.ok((await stats()).samples["1122334455667788"] > 0);
  const report = { passed: true, target, profile: onOff ? "on_off" : "environment", native_host_state: true, native_processes: 2, gateway_restarts: 2, real_rust_sqlite_mqtt: true, software_pty_ncp: true, discovery_and_endpoint_selection: true, discovery_posts: 2, endpoint_posts: 2, response_loss_and_original_get: true, revoke_and_explicit_rebind: true, native_js_rust_digest_match: true, threshold_command_confirmed: !onOff, onoff_command_confirmed: onOff, no_replay_after_restart: true, decision_posts: 3, query_posts: 2, transport: 'loopback HTTP fixture', production_secure_store_runtime: false, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'observation-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

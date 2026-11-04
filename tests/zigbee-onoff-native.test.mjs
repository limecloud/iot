import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { root, until } from '../tools/dev-stack.mjs';
import { base, environmentStack } from './fixtures/zigbee/runtime.mjs';

const execute = promisify(execFile), selected = process.env.LIMEIOT_NATIVE_TARGET;
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
for (const target of ['ios', 'android'].filter(value => !selected || selected === value)) test(`${target}客户端库经真实Zigbee网关控制、丢响应与重启后只读恢复`, { timeout: 300000 }, async t => {
  const { directory, stack, switchDevice, stats } = await environmentStack(t, 1, { onOff: true, timeoutMs: 1200 });
  const original = path.join(directory, target + '-bridge-original.json');
  async function native(phase) {
    const trace = path.join(directory, target + '-' + phase + '-bridge.json');
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', 'run.limeai.iot.core.PropertyBridgeJourneyTest', '--rerun'];
    const command = target === 'ios' ? path.join(root, 'apps/ios/.build/debug/ClientChecks') : 'sh';
    try {
      const result = await execute(command, args, { cwd: path.join(root, 'apps', target), timeout: 150000, maxBuffer: 2_000_000,
        env: { ...process.env, ...stack.env, LIMEIOT_BRIDGE_PHASE: phase, LIMEIOT_BRIDGE_ORIGINAL: original, LIMEIOT_BRIDGE_TRACE: trace } });
      await writeFile(path.join(directory, target + '-' + phase + '.log'), result.stdout + result.stderr);
    } catch (error) { await writeFile(path.join(directory, target + '-' + phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    if (target === 'android') {
      const xml = await readFile(path.join(root, 'apps/android/core/build/test-results/test/TEST-run.limeai.iot.core.PropertyBridgeJourneyTest.xml'), 'utf8');
      for (const [key, value] of Object.entries({ tests: 1, failures: 0, errors: 0, skipped: 0 })) assert.match(xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '', new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, phase + '-junit.xml'), xml);
    }
    const result = JSON.parse(await readFile(trace, 'utf8'));
    assert.equal(result.passed, true); assert.equal(result.phase, phase); assert.equal(result.status, 'confirmed');
    assert.equal(result.command_posts, phase === 'create' ? 1 : 0);
    assert.equal((await stat(original)).mode & 0o777, 0o600);
    assert.equal((await readFile(original, 'utf8')).includes(stack.env.LIMEIOT_TOKEN), false);
    assert.equal((await stack.request(base + '/commands/by-key/' + result.key)).value.command_id, result.command_id);
    return result;
  }
  const created = await native('create');
  assert.deepEqual((await stats()).switch_commands, [true]);
  await stack.restartGateway(); await until(async () => (await switchDevice()).ready);
  const restored = await native('restore');
  assert.equal(restored.key, created.key); assert.equal(restored.command_id, created.command_id);
  assert.deepEqual((await stats()).switch_commands, [true], '原键恢复与网关重启均不补发');
  assert.deepEqual((await stats()).errors, []);
  const report = { passed: true, target, native_client_library: true, native_processes: 2, gateway_restarts: 1,
    response_loss_original_get: true, no_replay: true, software_pty_ncp: true, real_rust_sqlite_mqtt: true,
    native_app_runtime: false, production_secure_store_runtime: false, hardware: false, published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'onoff-native-report.json');
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

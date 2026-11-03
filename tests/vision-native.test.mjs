import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { visionStack, png, base } from './helpers/vision.mjs';
import { createVisionOriginal, verifyVisionTask } from '../packages/protocol/vision.mjs';

const exec = promisify(execFile);
const stateCheck = process.env.LIMEIOT_VISION_STATE_CHECK === '1';
for (const target of ['ios', 'android']) test(target + (stateCheck ? '图片观察原生状态层' : '图片观察原生库') + '：实际大图、丢回执、重启未知与明确清除', { timeout: 600000 }, async t => {
  const { stack, directory, calls, holds, errors, text, setMode } = await visionStack(t, { prefix: 'vision-native-' + target + '-' });
  const bytes = png(512, 512, true), image = path.join(directory, 'input.png'), store = path.join(directory, 'native-originals.json');
  assert.ok(bytes.length > 512 * 1024); await writeFile(image, bytes, { mode: 0o600 });
  const prompt = '请观察青柠🍋与é，有什么形状？';
  async function native(phase) {
    const traceFile = path.join(directory, phase + '-trace.json');
    const command = target === 'ios' ? stateCheck ? path.join(root, '.dev/vision-native-state/ios-vision-checks') : path.join(root, 'apps/ios/.build/debug/ClientChecks') : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', stateCheck ? ':app:testDebugUnitTest' : ':core:test', '--tests', stateCheck ? 'run.limeai.iot.VisionJourneyTest' : 'run.limeai.iot.core.VisionIntegrationTest', '--rerun'];
    const env = { ...stack.env, LIMEIOT_VISION_CHECK: '1', LIMEIOT_VISION_PHASE: phase, LIMEIOT_VISION_IMAGE: image, LIMEIOT_VISION_STORE: store, LIMEIOT_VISION_TRACE: traceFile, LIMEIOT_VISION_TEXT: text };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(path.join(directory, phase + '.log'), result.stdout + result.stderr); }
    catch (error) { await writeFile(path.join(directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    if (target === 'android') {
      const xml = await readFile(path.join(root, stateCheck ? 'apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.VisionJourneyTest.xml' : 'apps/android/core/build/test-results/test/TEST-run.limeai.iot.core.VisionIntegrationTest.xml'), 'utf8');
      for (const [key, value] of Object.entries({ tests: 1, failures: 0, errors: 0, skipped: 0 })) assert.match(xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '', new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, phase + '-tests.xml'), xml);
    }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.native_host_library, true); assert.equal(trace.other_posts, 0);
    if (stateCheck) assert.equal(trace.host_ui_state, true);
    assert.equal(trace.vision_posts, ['create', 'unknown-start', 'unknown-restore', 'clear'].includes(phase) ? 1 : 0);
    assert.equal(trace.records.length, ['create', 'restore'].includes(phase) ? 1 : 2);
    for (const record of trace.records) {
      const request = { image_base64: bytes.toString('base64'), content_type: 'image/png', prompt, retain_seconds: 600, expires_at: record.original.input.expires_at };
      assert.deepEqual(record.original, await createVisionOriginal(stack.env.LIMEIOT_ENDPOINT, 'space-demo', record.original.idempotency_key, request));
      const task = (await stack.request(base + '/vision-observations/by-key/' + record.original.idempotency_key)).value;
      await verifyVisionTask(task, 'space-demo', record.original.idempotency_key, record.original);
      const metadata = structuredClone(task); metadata.input = record.original.input; if (metadata.output) delete metadata.output.text;
      assert.deepEqual(record.observation, metadata);
    }
    const saved = await readFile(store, 'utf8');
    for (const forbidden of ['image_base64', '"prompt"', '"text"', prompt, text, stack.env.LIMEIOT_TOKEN, bytes.toString('base64')]) assert.equal(saved.includes(forbidden), false);
    assert.equal((await stat(store)).mode & 0o777, 0o600);
    return trace;
  }
  const created = await native('create'); assert.equal(calls.length, 1);
  await stack.restartGateway(); const restored = await native('restore');
  assert.equal(restored.records[0].observation.vision_id, created.records[0].observation.vision_id); assert.equal(calls.length, 1);
  setMode('hold'); await native('unknown-start'); await until(() => calls.length === 2); assert.equal(holds.length, 1);
  await stack.restartGateway(); const abandoned = await native('unknown-restore'); assert.equal(abandoned.records[1].observation.status, 'discarded');
  await native('clear'); await stack.restartGateway(); const cleared = await native('cleared-restore');
  assert.ok(cleared.records[0].observation.output.cleared_at); assert.equal(cleared.records[0].observation.status, 'succeeded');
  for (const reply of holds.splice(0)) reply();
  assert.equal(calls.length, 2); assert.deepEqual(errors, []);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0); assert.equal((await stack.request(base + '/media')).value.grants.length, 0);
  const report = { passed: true, target, real_rust_gateway: true, real_sqlite: true, real_mqtt: true, native_host_library: true, host_ui_state: stateCheck, provider_fixture: true, actual_png_bytes: bytes.length, native_processes: 6, gateway_restarts: 3, response_loss: true, same_key_get_only: true, unknown_budget_and_explicit_discard: true, clear_success_without_resurrection: true, digest_matches_js_and_rust: true, no_body_persistence: true, no_device_commands_or_playback_grants: true, provider_calls: 2, vision_posts: 4, native_vision_ui_source: stateCheck, native_vision_ui_runtime: false, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'vision-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

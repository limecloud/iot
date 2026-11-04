import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { textStack, base } from './helpers/text.mjs';
import { createTextOriginal, verifyTextTask } from '../packages/protocol/text.mjs';

const exec = promisify(execFile);
for (const target of ['ios', 'android']) test(target + '原生文字状态：丢回执、进程恢复、网关重启与明确清除', { timeout: 600000 }, async t => {
  const { stack, directory, calls, holds, errors, text, setMode } = await textStack(t, { prefix: 'text-native-' + target + '-' });
  const store = path.join(directory, 'native-originals.json');
  async function native(phase) {
    const traceFile = path.join(directory, phase + '-trace.json');
    const command = target === 'ios' ? path.join(root, '.dev/text-native/ios-text-checks') : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.TextGenerationJourneyTest', '--rerun'];
    const env = { ...stack.env, LIMEIOT_TEXT_NATIVE_PHASE: phase, LIMEIOT_TEXT_NATIVE_STORE: store, LIMEIOT_TEXT_NATIVE_TRACE: traceFile, LIMEIOT_TEXT_NATIVE_TEXT: text };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 150000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(path.join(directory, phase + '.log'), result.stdout + result.stderr); }
    catch (error) { await writeFile(path.join(directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    if (target === 'android') {
      const xml = await readFile(path.join(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.TextGenerationJourneyTest.xml'), 'utf8');
      for (const [key, value] of Object.entries({ tests: 1, failures: 0, errors: 0, skipped: 0 })) assert.match(xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '', new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, phase + '-tests.xml'), xml);
    }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.host_ui_state, true); assert.equal(trace.other_posts, 0);
    assert.equal(trace.text_posts, ['create', 'unknown-start', 'unknown-restore', 'clear'].includes(phase) ? 1 : 0);
    assert.equal(trace.records.length, ['create', 'restore'].includes(phase) ? 1 : 2);
    for (const record of trace.records) {
      const request = { instructions: '', messages: [{ role: 'user', content: '请记住青柠🍋与 é' }], retain_seconds: 600, expires_at: record.original.input.expires_at };
      assert.deepEqual(record.original, await createTextOriginal(stack.env.LIMEIOT_ENDPOINT, 'space-demo', record.original.idempotency_key, request));
      const task = (await stack.request(base + '/text-generations/by-key/' + record.original.idempotency_key)).value;
      await verifyTextTask(task, 'space-demo', record.original.idempotency_key, record.original);
      const metadata = structuredClone(task); if (metadata.output) delete metadata.output.text;
      assert.deepEqual(record.observation, metadata);
    }
    const saved = await readFile(store, 'utf8');
    for (const forbidden of ['"messages"', '"instructions"', '"text"', '请记住青柠', text, stack.env.LIMEIOT_TOKEN]) assert.equal(saved.includes(forbidden), false);
    assert.equal((await stat(store)).mode & 0o777, 0o600);
    return trace;
  }
  const created = await native('create'); assert.equal(calls.length, 1);
  await stack.restartGateway(); const restored = await native('restore'); assert.equal(restored.records[0].observation.text_id, created.records[0].observation.text_id); assert.equal(calls.length, 1);
  setMode('hold'); await native('unknown-start'); await until(() => calls.length === 2); assert.equal(holds.length, 1);
  await stack.restartGateway(); const discarded = await native('unknown-restore'); assert.equal(discarded.records[1].observation.status, 'discarded');
  await native('clear'); await stack.restartGateway(); const cleared = await native('cleared-restore'); assert.ok(cleared.records[0].observation.output.cleared_at);
  for (const reply of holds.splice(0)) reply();
  assert.equal(calls.length, 2); assert.deepEqual(errors, []);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0); assert.equal((await stack.request(base + '/media')).value.grants.length, 0);
  const report = { passed: true, target, real_rust_gateway: true, real_sqlite: true, real_mqtt: true, native_host_library: true, host_ui_state: true, provider_fixture: true, native_processes: 6, gateway_restarts: 3, response_loss: true, same_key_get_only: true, unknown_budget_and_explicit_discard: true, clear_success_without_resurrection: true, digest_matches_js_and_rust: true, no_body_persistence: true, no_device_commands_or_playback_grants: true, provider_calls: 2, text_posts: 4, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'text-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

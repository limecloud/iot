import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { transcriptionStack, base, post } from './helpers/transcription.mjs';
import { createTranscriptionOriginal, verifyTranscriptionTask } from '../packages/protocol/transcription.mjs';

const exec = promisify(execFile);
for (const target of ['ios', 'android']) test(target + '原生识别状态：丢回执、进程与网关恢复、未知放弃和源删除清文', { timeout: 360000 }, async t => {
  const { stack, directory, fixture, calls, holds, errors, media, text, setMode } = await transcriptionStack(t, 'transcription-native-' + target + '-');
  const store = path.join(directory, 'native-originals'); await mkdir(store);
  async function native(phase) {
    const traceFile = path.join(directory, phase + '-trace.json');
    const command = target === 'ios' ? path.join(root, '.dev/transcription-native-state/ios-transcription-checks') : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.TranscriptionJourneyTest', '--rerun'];
    const env = { ...stack.env, LIMEIOT_TRANSCRIPTION_STATE_CHECK: '1', LIMEIOT_TRANSCRIPTION_PHASE: phase, LIMEIOT_TRANSCRIPTION_STORE: store, LIMEIOT_TRANSCRIPTION_TRACE: traceFile, LIMEIOT_TRANSCRIPTION_MEDIA: media.media_id };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(path.join(directory, phase + '.log'), result.stdout + result.stderr); }
    catch (error) { await writeFile(path.join(directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.host_ui_state, true); assert.equal(trace.other_posts, 0);
    assert.equal(trace.transcription_posts, ['create', 'unknown-start', 'unknown-restore'].includes(phase) ? 1 : 0);
    assert.equal(trace.records.length, ['create', 'restore'].includes(phase) ? 1 : 2);
    for (const record of trace.records) {
      assert.deepEqual(record.original, await createTranscriptionOriginal(stack.env.LIMEIOT_ENDPOINT, 'space-demo', record.original.idempotency_key, record.original.input));
      const task = (await stack.request(base + '/audio-transcriptions/by-key/' + record.original.idempotency_key)).value;
      await verifyTranscriptionTask(task, 'space-demo', record.original.idempotency_key, record.original);
      const metadata = structuredClone(task); metadata.input = record.original.input; if (metadata.output) delete metadata.output.text;
      assert.deepEqual(record.observation, metadata);
    }
    const originalFile = path.join(store, 'audio-transcriptions.json'), saved = await readFile(originalFile, 'utf8');
    assert.equal(/"text"|你好，这是本地识别结果。/.test(saved), false); assert.equal(saved.includes(stack.env.LIMEIOT_TOKEN), false); assert.equal((await stat(originalFile)).mode & 0o777, 0o600);
    return trace;
  }
  const created = await native('create'); assert.equal(calls.length, 1);
  const firstKey = created.records[0].original.idempotency_key;
  assert.equal((await stack.request(base + '/audio-transcriptions/by-key/' + firstKey)).value.output.text, text);
  await stack.restartGateway(); const restored = await native('restore');
  assert.equal(restored.records[0].observation.transcription_id, created.records[0].observation.transcription_id); assert.equal(calls.length, 1);
  setMode('hold'); await native('unknown-start'); await until(() => calls.length === 2); assert.equal(holds.length, 1);
  await stack.restartGateway(); const abandoned = await native('unknown-restore');
  assert.equal(abandoned.records[1].observation.status, 'discarded'); assert.equal(abandoned.records[1].discard_intents.length, 1);
  assert.equal((await stack.request(base + '/media-operations', post({ type: 'media.delete', media_id: media.media_id }, 'delete-source'))).status, 200);
  const cleared = await native('cleared'); assert.ok(cleared.records[0].observation.output.cleared_at);
  for (const reply of holds.splice(0)) reply();
  assert.equal(calls.length, 2); assert.deepEqual(errors, []); assert.equal(fixture.effects.length, 0); assert.equal(fixture.renderedPulls.length, 0);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0); assert.equal((await stack.request(base + '/media')).value.grants.length, 0);
  const report = { passed: true, target, real_rust_gateway: true, real_sqlite: true, real_mqtt: true, host_ui_state: true, provider_fixture: true, response_loss: true, native_process_restart: true, gateway_restarts: 2, get_only_recovery: true, unknown_budget_and_explicit_discard: true, no_text_persistence: true, source_deletion_clears_text: true, no_device_commands_or_playback_grants: true, provider_calls: 2, transcription_posts: 3, native_transcription_ui_runtime: false, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'transcription-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

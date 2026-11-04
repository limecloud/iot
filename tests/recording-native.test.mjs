import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';
import { mediaStack } from './helpers/media.mjs';
import { encodeRecordedPcm } from '../packages/protocol/pcm-recording.mjs';
import { createMediaOriginal, verifyMediaOperation, verifyPcmWav } from '../packages/protocol/media.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
for (const target of ['ios', 'android'].filter(n => !process.env.LIMEIOT_RECORDING_TARGET || process.env.LIMEIOT_RECORDING_TARGET === n)) test(target + '有限录音状态：明确上传、丢回执与进程和网关重启只查原键', { timeout: 360000 }, async t => {
  const { stack, directory } = await mediaStack(t, 'recording-native-' + target + '-');
  const store = path.join(directory, 'native-originals.json'), bytes = Buffer.from(encodeRecordedPcm(new Int16Array(16000).fill(321)));
  const original = async trace => {
    assert.deepEqual(trace.original, await createMediaOriginal(stack.env.LIMEIOT_ENDPOINT, 'space-demo', trace.original.idempotency_key, { type: 'media.upload', content_base64: bytes.toString('base64'), retain_seconds: 600 }));
    const result = (await stack.request(base + '/media-operations/by-key/' + trace.original.idempotency_key)).value;
    verifyMediaOperation(result, 'space-demo', trace.original.idempotency_key, trace.original); assert.deepEqual(trace.result, result);
  };
  async function native(phase) {
    const traceFile = path.join(directory, phase + '-trace.json');
    const command = target === 'ios' ? path.join(root, '.dev/recording-native/ios-recording-checks') : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.RecordingJourneyTest', '--rerun'];
    const env = { ...stack.env, LIMEIOT_RECORDING_NATIVE_PHASE: phase, LIMEIOT_RECORDING_NATIVE_STORE: store, LIMEIOT_RECORDING_NATIVE_TRACE: traceFile };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 150000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(path.join(directory, phase + '.log'), result.stdout + result.stderr); }
    catch (error) { await writeFile(path.join(directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    if (target === 'android') {
      const xml = await readFile(path.join(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.RecordingJourneyTest.xml'), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      for (const [key, value] of Object.entries({ tests: 1, failures: 0, errors: 0, skipped: 0 })) assert.match(suite, new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, phase + '-tests.xml'), xml);
    }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.host_ui_state, true); assert.equal(trace.other_posts, 0);
    assert.equal(trace.posts, phase === 'create' ? 1 : 0); assert.equal(trace.input_opened, phase === 'create' ? 1 : 0); assert.equal(trace.input_closed, phase === 'create' ? 1 : 0); assert.ok(trace.gets > 0);
    assert.equal(trace.system_microphone, false); assert.equal(trace.native_app_runtime, false); await original(trace);
    const saved = await readFile(store, 'utf8');
    for (const forbidden of ['content_base64', bytes.toString('base64'), stack.env.LIMEIOT_TOKEN]) assert.equal(saved.includes(forbidden), false);
    assert.equal((await stat(store)).mode & 0o777, 0o600);
    return trace;
  }
  const created = await native('create');
  const disk = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'));
  const page = (await stack.request(base + '/media')).value; assert.equal(page.items.length, 1); assert.equal(page.grants.length, 0);
  const metadata = created.result.result.media; assert.equal(metadata.audio.sample_rate, 16000); assert.equal(metadata.audio.channels, 1); assert.equal(metadata.audio.frames, 16000);
  assert.deepEqual(Buffer.from(Object.values(disk.objects)[0].content_base64, 'base64'), bytes);
  // 原生摘要、服务端正文与独立 JS 编码共同核对上传材料。
  assert.deepEqual(verifyPcmWav(bytes), metadata.audio);
  for (const field of ['speech', 'transcriptions', 'visions', 'texts']) assert.equal(Object.keys(disk[field] ?? {}).length, 0);
  await stack.restartGateway(); const restored = await native('restore'); assert.deepEqual(restored.original, created.original); assert.deepEqual(restored.result, created.result);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0); assert.equal((await stack.request(base + '/media')).value.grants.length, 0);
  const report = { passed: true, target, real_rust_gateway: true, real_sqlite: true, native_host_state: true, native_processes: 2, gateway_restarts: 1, explicit_upload_posts: 1, response_loss: true, original_get_only: true, no_audio_body_in_client_store: true, no_model_tasks_or_playback_grants: true, system_microphone: false, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'recording-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

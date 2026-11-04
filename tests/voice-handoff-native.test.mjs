import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { voiceStack, base, transcript, answer } from './helpers/voice-turns.mjs';

const exec = promisify(execFile);
const domains = ['media-operations', 'audio-transcriptions', 'text-generations', 'speech-syntheses'];
for (const target of ['ios', 'android'].filter(n => !process.env.LIMEIOT_VOICE_TARGET || process.env.LIMEIOT_VOICE_TARGET === n)) test(target + '原生分步语音：录音到识别、提问、合成、独立授权播放和重启恢复', { timeout: 360000 }, async t => {
  let executable;
  if (target === 'ios') {
    const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug'), output = path.join(root, '.dev/voice-handoff-native');
    await mkdir(output, { recursive: true });
    const built = await exec('swift', ['build'], { cwd: ios, timeout: 90000 }); await writeFile(path.join(output, 'swift-build.log'), built.stdout + built.stderr);
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(n => n.endsWith('.o')).map(n => path.join(build, 'LimeIoTKit.build', n));
    executable = path.join(output, 'ios-voice-checks');
    const compiled = await exec('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/RecordingStore.swift', 'App/MediaStore.swift', 'App/TranscriptionStore.swift', 'App/TextGenerationStore.swift', 'App/SpeechStore.swift', 'Checks/VoiceHandoffLiveChecks.swift', ...objects, '-o', executable], { cwd: ios, timeout: 90000 });
    await writeFile(path.join(output, 'swift-voice-compile.log'), compiled.stdout + compiled.stderr);
  }
  const state = await voiceStack(t, { recordedSource: true });
  const { stack, directory, calls, errors, fixture, recordings } = state;
  await state.bindSpeaker();
  const store = path.join(directory, 'native-journals'); await mkdir(store, { mode: 0o700 });
  async function native(phase) {
    const traceFile = path.join(directory, phase + '-trace.json');
    const command = target === 'ios' ? executable : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.VoiceHandoffJourneyTest', '--rerun'];
    const env = { ...stack.env, LIMEIOT_VOICE_NATIVE_PHASE: phase, LIMEIOT_VOICE_NATIVE_STORE: store, LIMEIOT_VOICE_NATIVE_TRACE: traceFile };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 150000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(path.join(directory, phase + '.log'), result.stdout + result.stderr); }
    catch (error) { await writeFile(path.join(directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    if (target === 'android') {
      const xml = await readFile(path.join(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.VoiceHandoffJourneyTest.xml'), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      for (const [key, value] of Object.entries({ tests: 1, failures: 0, errors: 0, skipped: 0 })) assert.match(suite, new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, phase + '-tests.xml'), xml);
    }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.host_ui_state, true);
    assert.deepEqual(trace.posts, phase === 'create' ? ['media-operations', 'audio-transcriptions', 'text-generations', 'speech-syntheses', 'media-operations', 'commands'] : []);
    assert.equal(trace.recording_starts, phase === 'create' ? 1 : 0); assert.equal(trace.recording_closes, phase === 'create' ? 1 : 0);
    assert.equal(trace.system_microphone, false); assert.equal(trace.native_app_runtime, false);
    for (const domain of domains) {
      const file = path.join(store, domain + '.json'), raw = await readFile(file, 'utf8');
      for (const forbidden of ['content_base64', '"text":', '"messages":', transcript, answer, stack.env.LIMEIOT_TOKEN]) assert.equal(raw.includes(forbidden), false);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    return trace;
  }
  const created = await native('create');
  assert.deepEqual(calls, ['transcription', 'text', 'speech']); assert.deepEqual(errors, []);
  assert.equal(recordings.length, 1); assert.equal(recordings[0].frames, 16000); assert.equal(recordings[0].sample_rate, 16000);
  assert.deepEqual(fixture.effects.map(e => e.action), ['SetVolume', 'SetAVTransportURI', 'Play']);
  assert.deepEqual(fixture.renderedPulls, [{ status: 206, byte_length: state.bytes.length }]);
  const commands = (await stack.request(base + '/commands')).value.items; assert.equal(commands.length, 1); assert.equal(commands[0].status, 'confirmed');
  await stack.restartGateway(); await until(async () => (await stack.request(base + '/devices/device-lamp')).value.ready);
  const restored = await native('restore');
  for (const field of ['transcription_key', 'text_key', 'speech_key', 'generated_media']) assert.equal(restored[field], created[field]);
  assert.deepEqual(calls, ['transcription', 'text', 'speech']); assert.equal(fixture.effects.length, 3); assert.equal((await stack.request(base + '/commands')).value.items.length, 1);
  const grants = (await stack.request(base + '/media')).value.grants; assert.equal(grants.length, 1); assert.ok(grants.every(g => !g.active_in_process));
  const report = { passed: true, target, native_host_state: true, real_rust_gateway: true, real_sqlite: true, real_http: true, real_mqtt: true, native_processes: 2, gateway_restarts: 1, provider_calls: 3, model_provider_fixture: true, capture_fixture: true, renderer_fixture: true, explicit_handoff_without_implicit_post: true, full_answer_without_truncation: true, no_client_body_persistence: true, separate_grant_and_playback: true, confirmed_command: true, range_playback_bytes: state.bytes.length, restore_get_only: true, no_reinference_or_replay: true, automatic_voice_turn_composition: false, system_microphone: false, native_app_runtime: false, hardware: false, published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'voice-handoff-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

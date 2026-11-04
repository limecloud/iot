import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';
import { voiceStack, base, answer, transcript } from './helpers/voice-turns.mjs';
import { VoiceTurnClient, parseVoiceTurn } from '../packages/protocol/voice-turns.mjs';

const exec = promisify(execFile);
const targets = process.env.LIMEIOT_VOICE_NATIVE_TARGET ? [process.env.LIMEIOT_VOICE_NATIVE_TARGET] : ['ios', 'android'];
for (const target of targets) test(`${target}统一回合：丢回执、明确继续、跨进程和网关重启、停止只GET恢复`, { timeout: 600000 }, async t => {
  assert.ok(['ios', 'android'].includes(target));
  const s = await voiceStack(t), store = path.join(s.directory, 'native-turn.json');
  async function native(phase) {
    const traceFile = path.join(s.directory, phase + '-trace.json');
    const command = target === 'ios' ? path.join(root, '.dev/voice-turn-native/ios-voice-turn-checks') : process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
    const args = target === 'ios' ? [] : ['-cp', await readFile(path.join(root, '.dev/voice-turn-native/android-classpath.txt'), 'utf8'), 'org.junit.runner.JUnitCore', 'run.limeai.iot.VoiceTurnJourneyTest'];
    const env = { ...s.stack.env, LIMEIOT_VOICE_NATIVE_PHASE: phase, LIMEIOT_VOICE_NATIVE_STORE: store, LIMEIOT_VOICE_NATIVE_TRACE: traceFile, LIMEIOT_VOICE_NATIVE_ANSWER: answer, LIMEIOT_VOICE_NATIVE_MEDIA: s.media.media_id };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 150000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(path.join(s.directory, phase + '.log'), result.stdout + result.stderr); if (target === 'android') assert.match(result.stdout, /OK \(1 test\)/); }
    catch (error) { await writeFile(path.join(s.directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.host_ui_state, true);
    assert.deepEqual(trace.posts, phase === 'create' ? ['audio-transcriptions'] : phase === 'resume' ? ['text-generations', 'speech-syntheses'] : phase === 'restore-stop' ? ['discard'] : []);
    const raw = await readFile(store, 'utf8'), record = await parseVoiceTurn(raw, s.stack.env.LIMEIOT_ENDPOINT, 'space-demo');
    assert.deepEqual(record, trace.record); assert.equal((await stat(store)).mode & 0o777, 0o600);
    for (const forbidden of [answer, transcript, '"messages"', '"instructions"', s.stack.env.LIMEIOT_TOKEN]) assert.equal(raw.includes(forbidden), false);
    // JS消费者只读同一原生账本，重新验证真实任务与原生终态摘要一致。
    const js = new VoiceTurnClient({ origin: s.stack.env.LIMEIOT_ENDPOINT, space: 'space-demo', journal: { load: () => raw, save: async (_, value) => { assert.deepEqual(value, record); } }, request: s.request });
    assert.deepEqual((await js.resolve()).record, record);
    return record;
  }
  const created = await native('create'); assert.deepEqual(s.calls, ['transcription']); assert.equal(created.jobs.text, null);
  await s.stack.restartGateway(); const completed = await native('resume'); assert.deepEqual(s.calls, ['transcription', 'text', 'speech']);
  assert.equal(completed.turn_id, created.turn_id); assert.ok(completed.jobs.speech.observation.media_id);
  await s.stack.restartGateway(); const stopped = await native('restore-stop'); assert.equal(stopped.stopped, true); assert.ok(stopped.jobs.text.observation.output.cleared_at);
  await s.stack.restartGateway(); assert.deepEqual(await native('cleared'), stopped);
  assert.deepEqual(s.calls, ['transcription', 'text', 'speech']); assert.deepEqual(s.errors, []);
  assert.equal((await s.stack.request(base + '/commands')).value.items.length, 0); assert.equal((await s.stack.request(base + '/media')).value.grants.length, 0); assert.deepEqual(s.fixture.effects, []);
  const report = { passed: true, target, real_rust_gateway: true, real_sqlite: true, real_mqtt: true, host_ui_state: true, native_processes: 4, gateway_restarts: 3, lost_receipts: 2, exact_stage_posts: 3, discard_posts: 1, provider_calls: s.calls, shared_js_ledger: true, no_implicit_authorization_or_playback: true, summary_only_persistence: true, synthetic_providers: true, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false };
  const file = path.join(s.directory, 'voice-turn-native-result.json'); await writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: file }));
});

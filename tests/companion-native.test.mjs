import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';
import { voiceStack, base, answer, transcript } from './helpers/voice-turns.mjs';
import { CompanionClient, parseCompanionSession } from '../packages/protocol/companion.mjs';

const exec = promisify(execFile);
const targets = process.env.LIMEIOT_COMPANION_NATIVE_TARGET ? [process.env.LIMEIOT_COMPANION_NATIVE_TARGET] : ['ios', 'android'];
for (const target of targets) test(`${target}有限陪伴：原生状态层两轮、三进程恢复、停止丢回执且不补推理`, { timeout: 180000 }, async t => {
  assert.ok(['ios', 'android'].includes(target));
  const s = await voiceStack(t, { inspectText(input, index) {
    assert.match(input.messages[1].content, /你是积木小狗豆豆/);
    assert.deepEqual(input.messages.slice(2), index === 0 ? [{ role: 'user', content: transcript }] : [{ role: 'user', content: transcript }, { role: 'assistant', content: answer }, { role: 'user', content: transcript }]);
  } }), store = path.join(s.directory, 'native-companion.json');
  async function native(phase) {
    const traceFile = path.join(s.directory, phase + '-trace.json');
    const command = target === 'ios' ? path.join(root, '.dev/companion-native-20261104/ios-companion-checks') : process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
    const args = target === 'ios' ? [] : ['-cp', await readFile(path.join(root, '.dev/companion-native-20261104/android-classpath.txt'), 'utf8'), 'org.junit.runner.JUnitCore', 'run.limeai.iot.CompanionJourneyTest'];
    const env = { ...s.stack.env, LIMEIOT_COMPANION_NATIVE_PHASE: phase, LIMEIOT_COMPANION_NATIVE_STORE: store, LIMEIOT_COMPANION_NATIVE_TRACE: traceFile, LIMEIOT_COMPANION_NATIVE_ANSWER: answer, LIMEIOT_COMPANION_NATIVE_MEDIA: s.media.media_id };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }); await writeFile(path.join(s.directory, phase + '.log'), result.stdout + result.stderr); if (target === 'android') assert.match(result.stdout, /OK \(1 test\)/); }
    catch (error) { await writeFile(path.join(s.directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase); assert.equal(trace.host_ui_state, true);
    assert.deepEqual(trace.posts, phase === 'two-turns' ? ['audio-transcriptions', 'text-generations', 'speech-syntheses', 'audio-transcriptions', 'text-generations', 'speech-syntheses'] : phase === 'restore-stop' ? ['discard', 'discard'] : []);
    const raw = await readFile(store, 'utf8'), record = await parseCompanionSession(raw, s.stack.env.LIMEIOT_ENDPOINT, 'space-demo');
    assert.deepEqual(record, trace.record); assert.equal((await stat(store)).mode & 0o777, 0o600);
    for (const forbidden of [answer, transcript, '"messages"', '"instructions"', s.stack.env.LIMEIOT_TOKEN]) assert.equal(raw.includes(forbidden), false);
    const js = new CompanionClient({ origin: s.stack.env.LIMEIOT_ENDPOINT, space: 'space-demo', journal: { load: () => raw, save: async (_, value) => { assert.deepEqual(value, record); } }, request: s.request });
    assert.deepEqual((await js.resolve()).record, record);
    return record;
  }
  const completed = await native('two-turns'); assert.deepEqual(s.calls, ['transcription', 'text', 'speech', 'transcription', 'text', 'speech']); assert.equal(completed.history.message_count, 4);
  await s.stack.restartGateway(); const stopped = await native('restore-stop'); assert.equal(stopped.stopped, true);
  for (let i = 1; i <= 2; i++) assert.equal((await s.stack.request(`${base}/text-generations/by-key/${completed.session_id}_t${i}-text`)).value.output.text, null);
  await s.stack.restartGateway(); assert.deepEqual(await native('cleared'), stopped);
  assert.equal(s.calls.length, 6); assert.deepEqual(s.errors, []);
  assert.equal((await s.stack.request(base + '/commands')).value.items.length, 0); assert.equal((await s.stack.request(base + '/media')).value.grants.length, 0); assert.deepEqual(s.fixture.effects, []);
  const report = { passed: true, target, real_rust_gateway: true, real_sqlite: true, real_mqtt: true, host_ui_state: true, native_processes: 3, gateway_restarts: 2, lost_discard_receipts: 1, inference_posts: 6, discard_posts: 2, exact_second_round_history: true, shared_js_ledger: true, pause_and_restart_forget_context: true, no_implicit_authorization_or_playback: true, summary_only_persistence: true, synthetic_providers: true, native_app_runtime: false, production_secure_store_runtime: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false };
  const file = path.join(s.directory, 'companion-native-result.json'); await writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: file }));
});

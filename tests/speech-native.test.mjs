import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { mediaStack, pcmWav } from './helpers/media.mjs';
import { verifySpeechTask, validSpeechOriginal, createSpeechOriginal } from '../packages/protocol/speech.mjs';

const exec = promisify(execFile), space = 'space-demo', base = '/api/v1/spaces/' + space;
for (const target of ['ios', 'android']) test(target + '原生语音状态：丢回执、单独授权播放、进程及网关重启与未知任务放弃', { timeout: 360000 }, async t => {
  const calls = [], holds = [], bytes = pcmWav();
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks)); calls.push(value);
    const reply = () => { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(bytes); };
    if (value.input === 'hold') holds.push(reply); else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const reply of holds) reply(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const { stack, directory, fixture, bindSpeaker, mediaPort } = await mediaStack(t, 'speech-native-' + target + '-', { gatewayEnv: { LIMEIOT_TTS_URL: 'http://127.0.0.1:' + server.address().port, LIMEIOT_TTS_MODEL: 'fixture/native-speech', LIMEIOT_TTS_VOICES: 'local,other', LIMEIOT_TTS_CA_FILE: '' } });
  await bindSpeaker(); const store = path.join(directory, 'native-originals'); await mkdir(store);
  async function native(phase) {
    const traceFile = path.join(directory, phase + '-trace.json');
    const command = target === 'ios' ? path.join(root, '.dev/speech-native-state/ios-speech-checks') : 'sh';
    const args = target === 'ios' ? [] : ['gradlew', '--no-daemon', '--configure-on-demand', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.SpeechJourneyTest', '--rerun'];
    const env = { ...stack.env, LIMEIOT_SPEECH_STATE_CHECK: '1', LIMEIOT_SPEECH_PHASE: phase, LIMEIOT_SPEECH_STORE: store, LIMEIOT_SPEECH_TRACE: traceFile };
    try { const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); await writeFile(path.join(directory, phase + '.log'), result.stdout + result.stderr); }
    catch (error) { await writeFile(path.join(directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.host_ui_state, true); assert.equal(trace.phase, phase); assert.equal(trace.approved, false);
    assert.equal(trace.speech_posts, phase === 'restore' ? 0 : 1); assert.equal(trace.media_posts, phase === 'create' ? 1 : 0);
    assert.equal(trace.records.length, phase.startsWith('unknown-') ? 2 : 1);
    for (const record of trace.records) {
      assert.equal(validSpeechOriginal(record.original, stack.env.LIMEIOT_ENDPOINT, space, record.original.idempotency_key), true);
      assert.ok(record.result); verifySpeechTask(record.result, space, record.original.idempotency_key, record.original);
      const input = { text: record === trace.records[0] ? '原生青柠萌宠欢迎回家。' : 'hold', voice: record.original.voice, retain_seconds: record.original.retain_seconds, expires_at: record.original.expires_at };
      assert.deepEqual(record.original, await createSpeechOriginal(stack.env.LIMEIOT_ENDPOINT, space, record.original.idempotency_key, input));
    }
    const originalFile = path.join(store, 'speech-syntheses.json'), saved = await readFile(originalFile, 'utf8');
    assert.equal(/"text"|原生青柠|owner-input/.test(saved), false); assert.equal(saved.includes(stack.env.LIMEIOT_TOKEN), false); assert.equal((await stat(originalFile)).mode & 0o777, 0o600);
    return trace;
  }
  const created = await native('create');
  assert.equal(calls.length, 1); assert.deepEqual(fixture.effects.map(effect => effect.action), ['SetVolume', 'SetAVTransportURI', 'Play']);
  assert.deepEqual(fixture.renderedPulls, [{ status: 206, byte_length: bytes.length }]);
  const completed = created.records[0].result, disk = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'));
  const oldGrant = Object.values(disk.grants)[0].grant, oldUrl = `http://127.0.0.1:${mediaPort}/media/v1/${oldGrant.grant_id}/${oldGrant.token}.wav`;
  assert.equal(created.selected[0], completed.media_id);
  await stack.restartGateway(); await until(async () => (await stack.request(base + '/devices/device-lamp')).value.ready);
  assert.equal((await fetch(oldUrl)).status, 404);
  const restored = await native('restore'); assert.equal(restored.records[0].result.synthesis_id, completed.synthesis_id); assert.equal(calls.length, 1);
  await native('unknown-start'); await until(() => calls.length === 2); assert.equal(holds.length, 1);
  await stack.restartGateway(); await until(async () => (await stack.request(base + '/devices/device-lamp')).value.ready);
  const abandoned = await native('unknown-restore'); assert.equal(abandoned.records[1].result.status, 'discarded'); assert.equal(abandoned.records[1].discard_intents.length, 1);
  for (const reply of holds.splice(0)) reply();
  assert.equal(calls.length, 2); assert.equal(fixture.effects.length, 3); assert.equal(fixture.renderedPulls.length, 1);
  assert.equal((await stack.request(base + '/media')).value.items.length, 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 1);
  const report = { passed: true, target, host_ui_state: true, real_http: true, real_rust_gateway: true, real_sqlite: true, real_mqtt: true, provider_fixture: true, renderer_fixture: true, response_loss: true, native_process_restart: true, gateway_restart: true, get_only_recovery: true, unknown_budget_and_explicit_discard: true, digest_matches_js_and_rust: true, no_text_persistence: true, generated_media_selection_clears_approval: true, separate_authorization_and_playback: true, provider_calls: 2, speech_posts: 3, media_posts: 1, soap_mutations: 3, range_pulls: 1, native_speech_ui_runtime: false, native_app_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'speech-native-result.json'); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

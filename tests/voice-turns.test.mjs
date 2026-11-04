import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, until } from '../tools/dev-stack.mjs';
import { voiceStack, base, post, transcript, answer } from './helpers/voice-turns.mjs';
import { parseVoiceTurn } from '../packages/protocol/voice-turns.mjs';
const exec = promisify(execFile);

test('完整语音回合：真实Rust/SQLite/MQTT，三阶段一次调用、零自动播放和跨重启恢复', { timeout: 90000 }, async t => {
  const state = await voiceStack(t), value = state.client();
  await value.start(state.input('complete')); const result = await state.complete(value);
  assert.equal(result.phase, 'succeeded'); assert.equal(result.transcript, transcript); assert.equal(result.answer, answer); assert.ok(result.media_id);
  assert.deepEqual(state.calls, ['transcription', 'text', 'speech']);
  assert.equal(state.memory.raw.includes(transcript), false); assert.equal(state.memory.raw.includes(answer), false);
  const record = await parseVoiceTurn(state.memory.raw, state.stack.env.LIMEIOT_ENDPOINT, 'space-demo'); assert.equal(record.jobs.speech.observation.media_id, result.media_id);
  const drifted = state.client({ request: async (...args) => { const value = await state.request(...args); if (args[0].endsWith('/complete-text')) value.usage.output_tokens++; return value; } });
  await assert.rejects(drifted.resolve(), /invalid_voice_turn_response/);
  await state.stack.restartGateway(); const recovered = await state.client().resolve(); assert.equal(recovered.media_id, result.media_id); assert.equal(recovered.answer, answer); assert.equal(state.calls.length, 3);
  assert.equal((await state.stack.request(base + '/media')).value.grants.length, 0); assert.equal((await state.stack.request(base + '/commands')).value.items.length, 0); assert.deepEqual(state.fixture.effects, []);
  const stopped = await state.client().stop(); assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.answer, null); assert.equal(stopped.media_id, null);
  await state.stack.restartGateway(); const cleared = await state.client().resolve(); assert.equal(cleared.phase, 'stopped'); assert.equal(cleared.answer, null); assert.equal((await state.stack.request(base + '/text-generations/by-key/complete-text')).value.output.text, null); assert.equal(state.calls.length, 3); assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'voice-turn-result.json'), JSON.stringify({ passed: true, real_gateway: true, real_sqlite: true, real_mqtt: true, provider_fixture: true, stages: state.calls, zero_implicit_play: true, restart_get_only: true, stop_clears_answer: true, hardware: false, real_model_quality: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(state.directory, 'voice-turn-result.json') }));
});

test('语音回合丢响应与后台：原键查询、unknown不推进、停止拒绝迟到结果', { timeout: 90000 }, async t => {
  const state = await voiceStack(t); state.setMode('hold-text');
  let value = state.client(); await value.start(state.input('lost'));
  await until(async () => (await value.resolve()).record.jobs.transcription.observation.status === 'succeeded');
  state.loseResponse('text-generations'); await assert.rejects(value.continue(), /response_lost/); await until(() => state.holds.length === 1);
  assert.equal(state.memory.raw.includes(transcript), false); const count = state.requests.filter(value => value.method === 'POST').length;
  value = state.client(); assert.equal((await value.resolve()).phase, 'running'); assert.equal(state.requests.filter(value => value.method === 'POST').length, count);
  await state.stack.restartGateway(); const recovered = await value.continue(); assert.equal(recovered.phase, 'unknown'); assert.equal(state.calls.length, 2); assert.equal(recovered.record.jobs.speech, null);
  await assert.rejects(value.start(state.input('replacement')), /voice_turn_pending/);
  await value.stop(); state.holds.shift()(); assert.equal((await value.resolve()).phase, 'stopped'); assert.equal(state.calls.length, 2);
  state.memory.raw = null; state.memory.saves = 0; state.memory.pauseAt = 2; state.memory.active = true; state.setMode('ok');
  const before = state.calls.length; await assert.rejects(state.client().start(state.input('pause')), /voice_turn_paused/); assert.equal(state.calls.length, before);
  state.memory.active = true; state.memory.pauseAt = Infinity; value = state.client(); await assert.rejects(value.resolve(), /text_not_found|transcription_not_found/); await assert.rejects(value.continue(), /text_not_found|transcription_not_found/); assert.equal(state.calls.length, before);
  assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'voice-turn-faults.json'), JSON.stringify({ passed: true, lost_response_get_only: true, unknown_no_next_stage: true, paused_after_save_zero_post: true, missing_original_no_resubmit: true, stopped_late_output_ignored: true, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(state.directory, 'voice-turn-faults.json') }));
});

test('语音回合保存失败、模型变化、不可合成回答与原录音删除', { timeout: 90000 }, async t => {
  const state = await voiceStack(t); state.memory.failAt = 2;
  await assert.rejects(state.client().start(state.input('no-save')), /voice_turn_record_unavailable/); assert.equal(state.calls.length, 0);
  state.memory.raw = null; state.memory.saves = 0; state.memory.failAt = Infinity; state.setMode('long'); const value = state.client();
  await value.start(state.input('long'));
  await until(async () => (await value.resolve()).record.jobs.transcription.observation.status === 'succeeded');
  state.stack.env.LIMEIOT_TEXT_MODEL = 'fixture:changed'; await state.stack.restartGateway();
  await assert.rejects(value.continue(), /voice_turn_configuration_changed/); assert.equal(state.calls.length, 1); assert.equal((await value.load()).jobs.text, null);
  state.stack.env.LIMEIOT_TEXT_MODEL = 'fixture:text'; await state.stack.restartGateway();
  await value.continue(); await until(async () => (await value.resolve()).record.jobs.text?.observation?.status === 'succeeded');
  await assert.rejects(value.continue(), /voice_turn_answer_not_speakable/); assert.equal(state.calls.length, 2); assert.equal((await value.load()).jobs.speech, null);
  await state.stack.request(base + '/media-operations', post({ type: 'media.delete', media_id: state.media.media_id }, 'remove-source'));
  await assert.rejects(value.continue(), /voice_turn_source_unavailable/); assert.equal(state.calls.length, 2);
  const corrupted = JSON.parse(state.memory.raw); corrupted.voice = 'tampered'; await assert.rejects(parseVoiceTurn(JSON.stringify(corrupted), state.stack.env.LIMEIOT_ENDPOINT, 'space-demo'), /voice_turn_record_unavailable/);
  assert.deepEqual(state.errors, []);
});

test('CLI语音回合：独立进程、私有摘要账本、只读恢复与停止', { timeout: 90000 }, async t => {
  const state = await voiceStack(t), file = path.join(state.directory, 'turn-input.json'), directory = path.join(state.directory, 'cli');
  await writeFile(file, JSON.stringify(state.input('cli-turn')), { mode: 0o600 });
  const args = ['packages/cli/src/main.mjs', 'voice-turns'];
  const flags = ['--space-id', 'space-demo', '--state-dir', directory];
  const invoke = (operation, extras = []) => exec(process.execPath, [...args, operation, ...flags, ...extras], { cwd: root, env: state.stack.env, timeout: 45000 });
  const result = JSON.parse((await invoke('start', ['--input', file, '--wait'])).stdout); assert.equal(result.phase, 'succeeded'); assert.equal(result.answer, answer);
  assert.equal((await stat(result.cli.record_file)).mode & 0o777, 0o600); const raw = await readFile(result.cli.record_file, 'utf8'); assert.equal(raw.includes(answer), false); assert.equal(raw.includes(transcript), false);
  await state.stack.restartGateway(); const recovered = JSON.parse((await invoke('resolve')).stdout); assert.equal(recovered.media_id, result.media_id); assert.equal(state.calls.length, 3);
  const stop = JSON.parse((await invoke('stop')).stdout); assert.equal(stop.phase, 'stopped'); assert.equal(stop.answer, null); assert.equal(state.calls.length, 3);
  const schema = JSON.parse((await exec(process.execPath, [...args, 'schema'], { cwd: root })).stdout); assert.equal(schema.kind, 'client_composition'); assert.equal(schema.limits.playback, false);
  await writeFile(path.join(state.directory, 'voice-turn-cli.json'), JSON.stringify({ passed: true, processes: 4, real_gateway: true, private_summary_only: true, get_only_recovery: true, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(state.directory, 'voice-turn-cli.json') }));
});

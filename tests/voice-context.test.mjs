import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parseVoiceTextContext, parseVoiceTurn } from '../packages/protocol/voice-turns.mjs';
import { voiceStack, transcript, answer, base } from './helpers/voice-turns.mjs';
import { until } from '../tools/dev-stack.mjs';

const instructions = '你是积木小狗豆豆。用简短中文陪用户讨论搭积木，不调用工具。';
test('语音上下文严格限制交替历史、字节数和JSON，不保存可执行角色', () => {
  assert.deepEqual(parseVoiceTextContext(JSON.stringify({ instructions, history: [] })), { instructions, history: [] });
  const invalid = [
    { instructions, history: [{ role: 'user', content: '一条' }] },
    { instructions, history: [{ role: 'system', content: '越界' }, { role: 'assistant', content: '答' }] },
    { instructions, history: [{ role: 'user', content: '问' }, { role: 'user', content: '答' }] },
    { instructions, history: [{ role: 'user', content: '' }, { role: 'assistant', content: '答' }] },
    { instructions: 'x'.repeat(1025), history: [] },
    { instructions, history: Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '问答' })) },
    { instructions, history: Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '字'.repeat(500) })) },
    { instructions, history: [], tool: 'run' },
  ];
  for (const value of invalid) assert.throws(() => parseVoiceTextContext(JSON.stringify(value)), /invalid_voice_turn_context/);
  assert.throws(() => parseVoiceTextContext('{"instructions":"a","instructions":"b","history":[]}'), /invalid_voice_turn_context/);
});

test('角色语音两轮复用真实网关，第二轮携带历史，账本仅摘要且旧客户端拒绝v2', { timeout: 90000 }, async t => {
  const state = await voiceStack(t, { inspectText(input, index) {
    assert.equal(input.messages[0].role, 'system'); assert.match(input.messages[0].content, /no tools, device access or permission to execute actions/);
    assert.equal(input.messages[1].role, 'system'); assert.equal(input.messages[1].content, instructions);
    assert.deepEqual(input.messages.slice(2), index === 0 ? [{ role: 'user', content: transcript }] : [
      { role: 'user', content: transcript }, { role: 'assistant', content: answer }, { role: 'user', content: transcript },
    ]);
  } });
  let context = { instructions, history: [] };
  let client = state.client({ textContext: context }); await client.start(state.input('context-first'));
  const first = await state.complete(client); assert.equal(first.phase, 'succeeded');
  assert.equal(first.record.version, 2); assert.equal(first.record.text_context.digest, await documentDigest(context));
  await assert.rejects(parseVoiceTurn(state.memory.raw, state.stack.env.LIMEIOT_ENDPOINT, 'space-demo'), /voice_turn_record_unavailable/);
  assert.equal((await parseVoiceTurn(state.memory.raw, state.stack.env.LIMEIOT_ENDPOINT, 'space-demo', { contextual: true })).turn_id, 'context-first');
  context = { instructions, history: [{ role: 'user', content: first.transcript }, { role: 'assistant', content: first.answer }] };
  client = state.client({ textContext: context }); await client.start(state.input('context-second'));
  const second = await state.complete(client); assert.equal(second.phase, 'succeeded');
  assert.equal(second.record.jobs.text.original.input.message_count, 3);
  assert.equal(second.record.text_context.history_messages, 2);
  assert.equal(state.memory.raw.includes(instructions), false); assert.equal(state.memory.raw.includes(transcript), false); assert.equal(state.memory.raw.includes(answer), false);
  assert.deepEqual(state.calls, ['transcription', 'text', 'speech', 'transcription', 'text', 'speech']);
  await state.stack.restartGateway();
  const restored = await state.client({ contextual: true }).resolve(); assert.equal(restored.media_id, second.media_id);
  assert.equal(state.calls.length, 6); assert.equal((await state.stack.request(base + '/media')).value.grants.length, 0);
  assert.equal((await state.stack.request(base + '/commands')).value.items.length, 0);
  await state.client({ contextual: true }).stop(); assert.equal(state.calls.length, 6); assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'voice-context-result.json'), JSON.stringify({ passed: true, real_gateway: true, real_mqtt: true, real_sqlite: true, turns: 2, provider_calls: state.calls.length, second_turn_messages: 3, role_bound: true, summary_only: true, restart_get_only: true, legacy_parser_rejects_context: true, zero_play_or_device_commands: true, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + path.join(state.directory, 'voice-context-result.json'));
});

test('恢复丢失或变更上下文不能推进新阶段，期限由会话收紧，停止无需恢复正文', { timeout: 90000 }, async t => {
  const state = await voiceStack(t), deadline = Date.now() + 60000, context = { instructions, history: [] };
  const client = state.client({ textContext: context, deadline });
  await client.start(state.input('context-pause'));
  await until(async () => (await client.resolve()).record.jobs.transcription.observation?.status === 'succeeded');
  const record = await client.load(); assert.equal(Date.parse(record.expires_at), deadline);
  const count = state.requests.filter(value => value.method === 'POST').length;
  for (const options of [{ contextual: true }, { textContext: { instructions: '另一个角色', history: [] } }, { textContext: { instructions, history: [{ role: 'user', content: '其他问' }, { role: 'assistant', content: '其他答' }] } }]) {
    await assert.rejects(state.client(options).continue(), /voice_turn_context_unavailable/);
  }
  assert.equal(state.requests.filter(value => value.method === 'POST').length, count); assert.equal(state.calls.length, 1);
  assert.equal((await state.client({ contextual: true }).stop()).phase, 'stopped');
  assert.deepEqual(state.errors, []);
});

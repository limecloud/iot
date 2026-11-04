import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { CompanionClient, parseCompanionPolicy, parseCompanionSession } from '../packages/protocol/companion.mjs';
import { voiceStack, transcript, answer, base } from './helpers/voice-turns.mjs';
import { root, until } from '../tools/dev-stack.mjs';

const policy = { schema_version: 1, policy_id: 'block-puppy', version: '1.0.0', name: '积木小狗豆豆', instructions: '你是积木小狗豆豆。用简短中文陪用户搭积木，不调用工具。', language: 'zh', voice: 'local', max_turns: 2, max_seconds: 300 };
const companion = (state, extra = {}) => new CompanionClient({ origin: state.stack.env.LIMEIOT_ENDPOINT, space: 'space-demo', journal: state.journal, request: state.request, policy, active: () => state.memory.active, ...extra });
const posts = state => state.requests.filter(value => value.method === 'POST').length;

test('陪伴政策Schema和共享解析拒绝未支持行为及超额预算', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/companion.schema.json'), 'utf8'));
  const validate = new Ajv({ strict: true }).compile(schema); assert.equal(validate(policy), true);
  const example = parseCompanionPolicy(await readFile(path.join(root, 'examples/companions/block-puppy/policy.json'), 'utf8'));
  assert.equal(validate(example), true); assert.equal(example.policy_id, 'block-puppy');
  for (const change of [v => { v.schema_version = 2; }, v => { v.policy_id = '../role'; }, v => { v.version = 'latest'; }, v => { v.max_turns = 9; }, v => { v.max_turns = 0; }, v => { v.max_seconds = 1801; }, v => { v.max_seconds = 29; }, v => { v.instructions = ''; }, v => { v.instructions = '字'.repeat(1025); }, v => { v.voice = 'http://voice'; }, v => { v.tool = 'execute'; }]) {
    const candidate = structuredClone(policy); change(candidate);
    assert.equal(validate(candidate), false); assert.throws(() => parseCompanionPolicy(JSON.stringify(candidate)), /invalid_companion_policy/);
  }
  assert.throws(() => parseCompanionPolicy(JSON.stringify({ ...policy, instructions: '\u0000' })), /invalid_companion_policy/);
});

test('有限陪伴会话两轮、固定角色/模型、只存摘要、跨重启原查询及独立停止', { timeout: 90000 }, async t => {
  const state = await voiceStack(t, { inspectText(input, index) {
    assert.match(input.messages[0].content, /no tools, device access/); assert.equal(input.messages[1].content, policy.instructions);
    assert.deepEqual(input.messages.slice(2), index === 0 ? [{ role: 'user', content: transcript }] : [
      { role: 'user', content: transcript }, { role: 'assistant', content: answer }, { role: 'user', content: transcript },
    ]);
  } });
  const client = companion(state); const opened = await client.start('puppy-session');
  assert.equal(opened.phase, 'ready'); assert.equal(state.calls.length, 0); assert.equal(opened.can_reply, true);
  await client.reply(state.media.media_id); const first = await state.complete(client); assert.equal(first.phase, 'succeeded');
  assert.equal(first.record.history.message_count, 2); assert.equal(client.history.length, 2);
  const before = posts(state), history = structuredClone(client.history);
  const withoutHistory = companion(state, { history: undefined });
  assert.equal((await withoutHistory.resolve()).history_available, false);
  await assert.rejects(withoutHistory.reply(state.media.media_id), /companion_history_unavailable/);
  await assert.rejects(companion(state, { history, policy: { ...policy, instructions: '另一个角色' } }).reply(state.media.media_id), /companion_policy_changed/);
  assert.equal(posts(state), before);
  state.stack.env.LIMEIOT_TEXT_MODEL = 'fixture:changed'; await state.stack.restartGateway();
  await assert.rejects(companion(state, { history }).reply(state.media.media_id), /companion_configuration_changed/); assert.equal(posts(state), before);
  state.stack.env.LIMEIOT_TEXT_MODEL = 'fixture:text'; await state.stack.restartGateway();
  const resumed = companion(state, { history }); await resumed.reply(state.media.media_id); const second = await state.complete(resumed);
  assert.equal(second.phase, 'succeeded'); assert.equal(second.turns_remaining, 0); assert.equal(second.can_reply, false);
  assert.equal(resumed.history.length, 4); assert.equal(state.calls.length, 6);
  const count = posts(state); await assert.rejects(resumed.reply(state.media.media_id), /companion_turn_budget_exceeded/); assert.equal(posts(state), count);
  const persisted = await parseCompanionSession(state.memory.raw, state.stack.env.LIMEIOT_ENDPOINT, 'space-demo'); assert.equal(persisted.turns.length, 2);
  for (const text of [policy.instructions, transcript, answer]) assert.equal(state.memory.raw.includes(text), false);
  await state.stack.restartGateway(); const restored = await companion(state, { policy: undefined }).resolve();
  assert.equal(restored.turn.media_id, second.turn.media_id); assert.equal(state.calls.length, 6); assert.equal(posts(state), count);
  const stopped = await companion(state, { policy: undefined }).stop(); assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.stop_settled, true);
  for (let i = 1; i <= 2; i++) assert.equal((await state.stack.request(base + `/text-generations/by-key/puppy-session_t${i}-text`)).value.output.text, null);
  assert.equal((await state.stack.request(base + '/media')).value.grants.length, 0); assert.equal((await state.stack.request(base + '/commands')).value.items.length, 0);
  assert.deepEqual(state.fixture.effects, []); assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'companion-result.json'), JSON.stringify({ passed: true, real_gateway: true, real_sqlite: true, real_mqtt: true, turns: 2, model_calls: 6, role_and_history_bound: true, model_change_rejected: true, summary_only: true, history_loss_no_next_turn: true, budget_enforced: true, gateway_restarts: 3, recovery_get_only: true, stop_clears_both_answers: true, zero_grants_or_commands: true, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + path.join(state.directory, 'companion-result.json'));
});

test('未知模型结果不换回合，停止先保存、重启不补推理且旧会话编号不可复用', { timeout: 90000 }, async t => {
  const state = await voiceStack(t); state.setMode('hold-text'); const client = companion(state);
  await client.start('puppy-unknown'); await client.reply(state.media.media_id);
  await until(async () => (await client.resolve()).turn.record.jobs.transcription.observation?.status === 'succeeded');
  state.loseResponse('text-generations'); await assert.rejects(client.continue(), /response_lost/); await until(() => state.holds.length === 1);
  const count = posts(state), read = companion(state, { policy: undefined }); assert.equal((await read.resolve()).phase, 'running'); assert.equal(posts(state), count);
  await state.stack.restartGateway(); const restored = companion(state, { history: [] });
  assert.equal((await restored.continue()).phase, 'unknown'); assert.equal(state.calls.length, 2);
  await assert.rejects(restored.reply(state.media.media_id), /companion_turn_pending/); await assert.rejects(restored.start('replacement'), /companion_session_pending/);
  const stopped = await read.stop(); assert.equal(stopped.stop_settled, true); assert.equal((await read.resolve()).turn, null);
  state.holds.shift()(); const next = companion(state); await next.start('puppy-next'); await next.stop();
  await assert.rejects(next.start('puppy-unknown'), /companion_session_id_unavailable/); assert.equal(state.calls.length, 2); assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'companion-unknown.json'), JSON.stringify({ passed: true, original_tasks_only: true, lost_response: true, unknown_blocks_replacement: true, stop_persisted: true, stop_without_context: true, gateway_restarts: 1, model_calls: 2, no_late_revival: true, old_session_id_rejected: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + path.join(state.directory, 'companion-unknown.json'));
});

test('准备记录保存/暂停失败零POST，会话期限拒绝下一轮，空回合不自动重建', { timeout: 90000 }, async t => {
  const state = await voiceStack(t); let now = Date.now(); const client = companion(state, { now: () => now });
  const opened = await client.start('puppy-prepare'); now = Date.parse(opened.record.expires_at);
  await assert.rejects(client.reply(state.media.media_id), /companion_expired/); assert.equal(state.calls.length, 0);
  now = Date.now(); state.memory.failAt = 2;
  await assert.rejects(client.reply(state.media.media_id), /voice_turn_record_unavailable/); assert.equal(posts(state), 0);
  state.memory.failAt = Infinity; state.memory.pauseAt = 3;
  await assert.rejects(client.reply(state.media.media_id), /companion_paused/); assert.equal(posts(state), 0);
  state.memory.active = true; const restored = companion(state, { history: [] });
  assert.equal((await restored.resolve()).phase, 'prepared');
  await assert.rejects(restored.continue(), /companion_preparation_incomplete/);
  await assert.rejects(restored.reply(state.media.media_id), /companion_turn_pending/); assert.equal(posts(state), 0);
  assert.equal((await restored.stop()).stop_settled, true); assert.equal(posts(state), 0);
  assert.deepEqual(state.errors, []);
});

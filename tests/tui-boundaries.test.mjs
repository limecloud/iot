import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import Ajv from 'ajv/dist/2020.js';
import { root, until } from '../tools/dev-stack.mjs';
import { GatewayTaskSession } from '../packages/cli/src/task-session.mjs';
import { TaskJournal } from '../packages/cli/src/task-journal.mjs';
import { runStdioTasks, runTextTasks, terminalText } from '../packages/cli/src/tui.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile);
const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8'));
const model = JSON.parse(await readFile(path.join(root, 'contracts/models/android-tv.json'), 'utf8'));
const modelRevision = await documentDigest(model);
const prepare = { action: 'commands.prepare', device_id: 'device-lamp', type: 'action.invoke', path: 'remote.press', value: { key: 'home' } };
const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-tv.json'), 'utf8'));
const failure = code => error => error.safeCode === code;
async function fixture() {
  const directory = await mkdtemp(path.join(root, '.dev/tui-boundary-'));
  const state = { calls: [], commands: [], deployments: [], intercept: null };
  const transport = async (url, options) => {
    const call = { path: url.pathname, cursor: url.searchParams.get('cursor'), method: options.method, headers: options.headers, input: options.body && JSON.parse(options.body) };
    state.calls.push(call);
    const custom = await state.intercept?.(call);
    if (custom) return custom;
    const json = value => Response.json(value);
    if (call.path.endsWith('/devices')) return json({ items: [{ device_id: 'device-lamp', model_revision: modelRevision, ready: true, reported: {} }] });
    if (call.path.endsWith('/capabilities')) return json({ models: { [modelRevision]: model } });
    if (call.path.endsWith('/runs')) return json({ items: [] });
    if (call.path.endsWith('/commands') && call.method === 'GET') return json({ items: state.commands, next_cursor: null });
    if (call.path.includes('/commands/by-key/')) return state.commands.length ? json(state.commands.at(-1)) : Response.json({ error: { code: 'command_not_found' } }, { status: 404 });
    if (call.path.endsWith('/commands')) {
      const request = { space_id: 'space-demo', idempotency_key: call.headers['Idempotency-Key'], ...call.input };
      const command = { command_id: 'cmd-1', request, request_digest: await documentDigest(request), status: 'accepted', evidence: null, error: null, run_id: null };
      state.commands.push(command); return json(command);
    }
    if (call.path.endsWith('/rules:validate')) return json({ valid: true, revision: await documentDigest(call.input) });
    if (call.path.endsWith('/rules:simulate')) return json({ executed: false, simulation: true, matched: true, revision: await documentDigest(call.input.rule), proposed_actions: call.input.rule.actions });
    if (call.path.endsWith('/rule-deployments') && call.method === 'GET') return json({ items: state.deployments });
    if (call.path.endsWith('/rule-deployments')) {
      const deployment = { revision: await documentDigest(call.input), rule: call.input, last_run: null };
      state.deployments = [deployment]; return json(deployment);
    }
    if (call.path.endsWith('/stop')) {
      const stopped = { stopped: true, rule_id: state.deployments[0].rule.id, revision: call.input.revision };
      state.deployments = []; return json(stopped);
    }
    throw new Error('unhandled_fixture_path');
  };
  const options = { endpoint: 'http://127.0.0.1:17880', token: 'test-owner-identity-for-fixture-0000', space: 'space-demo', directory, catalog, transport };
  return { state, session: new GatewayTaskSession(options), options };
}
const writes = state => state.calls.filter(call => call.method === 'POST' && !call.path.endsWith(':validate') && !call.path.endsWith(':simulate'));

test('进入阈值编辑后取消，保留完整规则且零POST', { timeout: 5000 }, async t => {
  const { session, state } = await fixture();
  const threshold = { ...rule, trigger: { device: 'device-lamp', property: { path: 'audio.volume', unit: 'percent', edge: 'rising', threshold: 50, hysteresis: 5 } } };
  state.deployments = [{ rule: threshold, revision: await documentDigest(threshold), last_run: null }];
  const before = structuredClone(state.deployments);
  const input = new PassThrough(); let transcript = '';
  const output = new Writable({ write(chunk, _encoding, done) { transcript += chunk; done(); } });
  t.after(() => input.end());
  const running = runTextTasks(session, input, output);
  await until(() => transcript.includes('5 刷新  0 退出> '), 2000); input.write('2\n');
  await until(() => transcript.includes('3 停用规则  0 返回> '), 2000); input.write('2\n');
  await until(() => transcript.includes('选择，0 返回> '), 2000); input.write('1\n');
  await until(() => transcript.includes('规则 ID，回车保留 '), 2000);
  input.end(); await running;
  assert.deepEqual(state.deployments, before); assert.equal(state.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(transcript.includes('选择触发事件'), false);
});

test('终端输入和NDJSON输出Schema严格编译，复用正式规则合同', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/tools/task-session.json'), 'utf8'));
  const ajv = new Ajv({ strict: true });
  ajv.addSchema(JSON.parse(await readFile(path.join(root, 'contracts/rule.schema.json'), 'utf8')), '../rule.schema.json');
  const validate = ajv.compile(schema);
  assert(validate(prepare)); assert(validate({ action: 'rules.prepare', rule, event_data: { count: 1 } }));
  for (const invalid of [{ action: 'commit' }, { ...prepare, value: undefined }, { ...prepare, token: 'bad' }, { action: 'rules.prepare', rule: { id: 'x' }, event_data: {} }, { action: 'refresh', cursor: null }]) assert.equal(validate(invalid), false);
  const output = ajv.compile({ ...schema, oneOf: undefined, $ref: '#/$defs/response' });
  const { session } = await fixture();
  const state = await session.dispatch({ action: 'refresh' });
  assert(output({ version: 1, sequence: 1, ok: true, result: state }));
  assert(state.condition_sources.some(source => source.schema.type === 'boolean'));
  assert.equal(output({ version: 1, sequence: 1, ok: true, result: { ...state, condition_sources: [{ ...state.condition_sources[0], extra: true }] } }), false);
  const property = state.sources.find(item => item.kind === 'property');
  assert.equal(property.path, 'audio.volume'); assert.equal(property.unit, 'percent');
  const missingUnit = structuredClone(property); delete missingUnit.unit;
  assert.equal(output({ version: 1, sequence: 1, ok: true, result: { ...state, sources: [missingUnit] } }), false);
  assert(output({ version: 1, sequence: 2, ok: false, error: { code: 'operation_unknown' } }));
  assert.equal(output({ version: 1, sequence: 0, ok: true, result: {} }), false);
});

test('原请求完整保存回读后才发送；写盘失败零POST', async () => {
  const { session, state } = await fixture();
  await session.dispatch(prepare);
  const original = structuredClone(session.review.record);
  state.intercept = async call => {
    if (call.method === 'POST') {
      const records = await session.journal.list();
      assert.deepEqual(records, [original]);
    }
  };
  await session.dispatch({ action: 'commit', task_id: original.task_id });
  assert.equal(writes(state).length, 1);
  const other = await fixture(); await other.session.dispatch(prepare);
  other.session.journal.create = async () => { throw new Error('disk-full'); };
  await assert.rejects(other.session.dispatch({ action: 'commit', task_id: other.session.review.record.task_id }));
  assert.equal(writes(other.state).length, 0);
});

test('丢响应、重建会话及404只查询原键，未知任务阻止换键', async () => {
  const { session, state, options } = await fixture();
  await session.dispatch(prepare); const id = session.review.record.task_id;
  state.intercept = call => { if (call.method === 'POST') throw new Error('lost'); };
  await assert.rejects(session.dispatch({ action: 'commit', task_id: id }), failure('operation_unknown'));
  assert.equal(session.connected, false);
  const reopened = new GatewayTaskSession(options);
  await assert.rejects(reopened.dispatch({ action: 'resolve', task_id: id }), failure('operation_unknown'));
  await assert.rejects(reopened.dispatch(prepare), failure('original_task_unresolved'));
  assert.equal(writes(state).length, 1);
  assert.equal((await reopened.journal.list())[0].result, null);
});

test('错设备、原键、模型、摘要与回执均拒绝，保留原记录', async () => {
  for (const change of [
    command => { command.request.device_id = 'other'; },
    command => { command.request.idempotency_key = 'other'; },
    command => { command.request.model_revision = 'sha256:' + '0'.repeat(64); },
    command => { command.request_digest = 'sha256:' + '0'.repeat(64); },
    command => { command.status = 'confirmed'; command.evidence = { type: 'device_result', reported: {} }; },
  ]) {
    const { session, state } = await fixture(); await session.dispatch(prepare);
    const id = session.review.record.task_id;
    state.intercept = async call => {
      if (call.method !== 'POST') return;
      const request = { space_id: 'space-demo', idempotency_key: call.headers['Idempotency-Key'], ...call.input };
      const command = { command_id: 'cmd-1', request, request_digest: await documentDigest(request), status: 'accepted', error: null, evidence: null, run_id: null };
      change(command); return Response.json(command);
    };
    await assert.rejects(session.dispatch({ action: 'commit', task_id: id }), failure('operation_unknown'));
    assert.equal((await session.journal.list())[0].result, null);
  }
});

test('修改清除旧核对；过期不发送；401清除快照和核对', async () => {
  const { session, state } = await fixture(); await session.dispatch(prepare);
  const id = session.review.record.task_id;
  await assert.rejects(session.dispatch({ action: 'commands.prepare' }), failure('invalid_task_action'));
  assert.equal(session.review, null);
  await assert.rejects(session.dispatch({ action: 'commit', task_id: id }), failure('review_required'));
  await session.dispatch(prepare);
  session.review.record.input.expires_at = '2000-01-01T00:00:00Z';
  await assert.rejects(session.dispatch({ action: 'commit', task_id: session.review.record.task_id }), failure('review_expired'));
  assert.equal(writes(state).length, 0);
  await session.dispatch(prepare);
  state.intercept = () => Response.json({ error: { code: 'unauthenticated' } }, { status: 401 });
  await assert.rejects(session.dispatch({ action: 'refresh' }), failure('unauthenticated'));
  assert.equal(session.review, null); assert.equal(session.data, null); assert.equal(session.connected, false);
  state.intercept = () => new Response('invalid-json', { status: 403 });
  await assert.rejects(session.dispatch({ action: 'refresh' }), failure('forbidden'));
  assert.equal(session.data, null);
});

test('多步规则预演不执行，基线变化拒绝，停用后可明确重新启用', async () => {
  const { session, state } = await fixture();
  const mixed = { ...rule, actions: [...rule.actions, { device: 'device-lamp', set: { path: 'audio.volume', value: 37 } }] };
  await session.dispatch({ action: 'rules.prepare', rule: mixed, event_data: { count: 1 } });
  assert.equal(writes(state).length, 0); assert.deepEqual(session.review.after.actions, mixed.actions);
  const firstId = session.review.record.task_id;
  const first = await session.dispatch({ action: 'commit', task_id: firstId });
  assert.equal(first.result.outcome, 'deployed'); assert.equal(writes(state)[0].headers['If-None-Match'], '*');
  await session.dispatch({ action: 'rules.stop.prepare', rule_id: rule.id });
  await session.dispatch({ action: 'commit', task_id: session.review.record.task_id });
  await session.dispatch({ action: 'rules.prepare', rule: mixed, event_data: { count: 1 } });
  assert.notEqual(session.review.record.task_id, firstId);
  await session.dispatch({ action: 'commit', task_id: session.review.record.task_id });
  await session.dispatch({ action: 'rules.prepare', rule: mixed, event_data: { count: 1 } });
  state.deployments[0] = { ...state.deployments[0], revision: 'sha256:' + 'f'.repeat(64) };
  await assert.rejects(session.dispatch({ action: 'commit', task_id: session.review.record.task_id }), failure('revision_conflict'));
  assert.equal(writes(state).length, 3);
});

test('规则丢响应恢复不覆盖新规则；停用后缺席不能伪造原操作决定', async () => {
  const { session, state } = await fixture();
  await session.dispatch({ action: 'rules.prepare', rule, event_data: { count: 1 } }); const id = session.review.record.task_id;
  state.intercept = call => { if (call.method === 'POST' && call.path.endsWith('/rule-deployments')) throw new Error('lost'); };
  await assert.rejects(session.dispatch({ action: 'commit', task_id: id }), failure('operation_unknown'));
  state.deployments = [{ rule: { ...rule, cooldown_ms: 777 }, revision: 'sha256:' + 'a'.repeat(64) }];
  await assert.rejects(session.dispatch({ action: 'resolve', task_id: id }), failure('operation_unknown'));
  assert.equal(writes(state).length, 1);
  state.deployments = [{ rule, revision: await documentDigest(rule), last_run: null }];
  const observed = await session.dispatch({ action: 'resolve', task_id: id });
  assert.equal(observed.result, null); assert.equal(observed.unknown, true); assert.equal(observed.observation.currently_deployed, true);
  assert.equal((await session.view()).tasks[0].pending, true);
  const other = await fixture(); other.state.deployments = [{ rule, revision: await documentDigest(rule), last_run: null }];
  await other.session.dispatch({ action: 'rules.stop.prepare', rule_id: rule.id }); const stopId = other.session.review.record.task_id;
  other.state.intercept = call => { if (call.path.endsWith('/stop')) { other.state.deployments = []; throw new Error('lost'); } };
  await assert.rejects(other.session.dispatch({ action: 'commit', task_id: stopId }), failure('operation_unknown'));
  const result = await other.session.dispatch({ action: 'resolve', task_id: stopId });
  assert.equal(result.unknown, true); assert.equal(result.result, null); assert.equal(result.observation.currently_absent, true);
  assert.equal(writes(other.state).length, 1);
});

test('跨进程锁拒绝并发，损坏原记录停止写入', async () => {
  const { session, options } = await fixture();
  await session.journal.locked(async () => {
    const source = 'import {TaskJournal} from "./packages/cli/src/task-journal.mjs"; const j=new TaskJournal(process.argv[1],process.argv[2],"space-demo");try{await j.locked(async()=>{});process.exitCode=1}catch(e){process.stdout.write(e.safeCode)}';
    const output = await exec(process.execPath, ['--input-type=module', '-e', source, options.directory, options.endpoint], { cwd: root });
    assert.equal(output.stdout, 'task_session_busy');
  });
  const second = new TaskJournal(options.directory, options.endpoint, 'space-demo');
  await second.locked(async () => {});
  const record = await session.journal.record('rule.stop', { request_key: 'k', rule_id: rule.id, revision: await documentDigest(rule) });
  await session.journal.create(record);
  await writeFile(session.journal.file(record.task_id), '{}');
  await assert.rejects(session.dispatch(prepare), failure('original_record_unavailable'));
});

test('NDJSON逐行严格JSON，分片UTF8正确，大批合法行不误拒绝', async () => {
  let output = ''; const actions = [];
  const sink = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const line = Buffer.from(JSON.stringify({ action: 'snapshot', text: '中文' }) + '\n');
  const chunks = Array.from(line, byte => Buffer.from([byte]));
  const session = { async dispatch(action) { actions.push(action); return {}; } };
  await runStdioTasks(session, Readable.from(chunks), sink);
  assert.equal(actions[0].text, '中文'); assert.equal(JSON.parse(output).ok, true);
  output = ''; await runStdioTasks(session, Readable.from(['{"action":"snapshot","action":"cancel"}\n']), sink);
  assert.equal(JSON.parse(output).ok, false); assert.equal(actions.length, 1);
  const legal = JSON.stringify({ action: 'snapshot', text: 'x'.repeat(100) }) + '\n';
  await runStdioTasks(session, Readable.from([legal.repeat(600)]), sink);
  await assert.rejects(runStdioTasks(session, Readable.from(['x'.repeat(32769)]), sink), failure('task_input_too_large'));
  await assert.rejects(runStdioTasks(session, Readable.from([Buffer.from([0xe4])]), sink), failure('invalid_task_encoding'));
  await assert.rejects(runStdioTasks(session, Readable.from(['{}']), sink), failure('task_input_line_required'));
  assert.equal(terminalText('\x1b[2J\r中文\u202e'), '\\u001b[2J\\u000d中文\\u202e');
});

test('100条命令响应页可读且传递游标，已见记录移出目录后禁写并保留文件', async () => {
  const { session, state, options } = await fixture();
  for (let index = 0; index < 100; index++) {
    const request = { space_id: 'space-demo', device_id: 'device-lamp', model_revision: modelRevision, idempotency_key: 'key-' + index, expires_at: new Date().toISOString(), operation: { type: 'action.invoke', path: 'remote.press', value: { key: 'home' } } };
    state.commands.push({ command_id: 'cmd-' + index, request, request_digest: await documentDigest(request), status: 'accepted', error: null, evidence: null, run_id: null });
  }
  assert.equal((await session.dispatch({ action: 'refresh', cursor: 'cmd-last-page' })).snapshot.commands.length, 100);
  assert.equal(state.calls.find(call => call.path.endsWith('/commands')).cursor, 'cmd-last-page');
  const record = await session.journal.record('command', state.commands[0].request);
  await session.journal.create(record);
  const moved = path.join(options.directory, 'preserved-original.json'); await rename(session.journal.file(record.task_id), moved);
  await assert.rejects(session.dispatch(prepare), failure('original_record_unavailable'));
  assert.equal(writes(state).length, 0);
  assert.equal(JSON.parse(await readFile(moved, 'utf8')).task_id, record.task_id);
});

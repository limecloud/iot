import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { voiceStack, transcript, answer, base } from './helpers/voice-turns.mjs';
import { root, until } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const policy = { schema_version: 1, policy_id: 'puppy-cli', version: '1.0.0', name: '积木小狗', instructions: '你是积木小狗豆豆，用简短中文回答搭积木的问题，不调用工具。', language: 'zh', voice: 'local', max_turns: 2, max_seconds: 300 };

test('陪伴CLI独立进程双轮上下文、私有摘要存储、重启只查和无上下文停止', { timeout: 90000 }, async t => {
  const state = await voiceStack(t, { inspectText(body, index) {
    assert.equal(body.messages[1].content, policy.instructions);
    assert.equal(body.messages.filter(message => message.role === 'user').length, index + 1);
  } });
  const files = Object.fromEntries(['policy', 'context', 'reply'].map(name => [name, path.join(state.directory, name + '.json')]));
  for (const [name, body] of Object.entries({ policy, context: { history: [] }, reply: { media_id: state.media.media_id } })) await writeFile(files[name], JSON.stringify(body), { mode: 0o600 });
  const flags = ['--space-id', 'space-demo', '--state-dir', path.join(state.directory, 'companion-cli')];
  const invoke = (operation, extras = []) => exec(process.execPath, ['packages/cli/src/main.mjs', 'companion', operation, ...flags, ...extras], { cwd: root, env: state.stack.env, timeout: 45000 });
  const started = JSON.parse((await invoke('start', ['--policy', files.policy, '--id', 'cli-puppy'])).stdout);
  assert.equal(started.phase, 'ready'); assert.equal(state.calls.length, 0);
  const first = JSON.parse((await invoke('reply', ['--policy', files.policy, '--context', files.context, '--input', files.reply, '--wait', '--emit-context'])).stdout);
  assert.equal(first.phase, 'succeeded'); assert.deepEqual(first.context.history, [{ role: 'user', content: transcript }, { role: 'assistant', content: answer }]);
  await writeFile(files.context, JSON.stringify(first.context));
  const second = JSON.parse((await invoke('reply', ['--policy', files.policy, '--context', files.context, '--input', files.reply, '--wait', '--emit-context'])).stdout);
  assert.equal(second.phase, 'succeeded'); assert.equal(second.context.history.length, 4); assert.equal(second.turns_remaining, 0);
  const file = second.cli.record_file, raw = await readFile(file, 'utf8');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const text of [transcript, answer, policy.instructions]) assert.equal(raw.includes(text), false);
  await state.stack.restartGateway(); const restored = JSON.parse((await invoke('resolve')).stdout);
  assert.equal(restored.turn.media_id, second.turn.media_id); assert.equal(restored.history_available, false); assert.equal(state.calls.length, 6);
  const stopped = JSON.parse((await invoke('stop')).stdout); assert.equal(stopped.stop_settled, true); assert.equal(stopped.turn, null); assert.equal(state.calls.length, 6);
  assert.equal((await state.stack.request(base + '/media')).value.grants.length, 0); assert.equal((await state.stack.request(base + '/commands')).value.items.length, 0);
  const schema = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'companion', 'schema'], { cwd: root, env: { ...process.env, LIMEIOT_TOKEN: '', LIMEIOT_TOKEN_FILE: '/nonexistent/companion-token' } })).stdout);
  assert.equal(schema.kind, 'client_companion_session'); assert.equal(schema.limits.playback, false); assert.equal(schema.limits.device_execution, false);
  assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'companion-cli-result.json'), JSON.stringify({ passed: true, independent_cli_processes: 7, turns: 2, real_gateway: true, real_sqlite: true, real_mqtt: true, model_calls: 6, private_summary_only: true, explicit_context_export: true, restart_query_only: true, context_free_stop: true, no_grants_or_commands: true, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + path.join(state.directory, 'companion-cli-result.json'));
});

test('陪伴CLI在未知文字请求期间中断会释放本机锁，后续进程只查询原任务', { timeout: 90000 }, async t => {
  const state = await voiceStack(t); state.setMode('hold-text');
  const directory = path.join(state.directory, 'interrupt-cli'), policyFile = path.join(state.directory, 'policy.json'), contextFile = path.join(state.directory, 'context.json'), inputFile = path.join(state.directory, 'input.json');
  for (const [file, value] of [[policyFile, policy], [contextFile, { history: [] }], [inputFile, { media_id: state.media.media_id }]]) await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const args = ['packages/cli/src/main.mjs', 'companion'], flags = ['--space-id', 'space-demo', '--state-dir', directory];
  const call = (operation, extra = []) => exec(process.execPath, [...args, operation, ...flags, ...extra], { cwd: root, env: state.stack.env, timeout: 15000 });
  await call('start', ['--policy', policyFile, '--id', 'interrupt-puppy']);
  const processChild = spawn(process.execPath, [...args, 'reply', ...flags, '--policy', policyFile, '--context', contextFile, '--input', inputFile, '--wait'], { cwd: root, env: state.stack.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; processChild.stdout.on('data', chunk => stdout.push(chunk)); processChild.stderr.on('data', chunk => stderr.push(chunk));
  const closed = new Promise(resolve => processChild.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (processChild.exitCode === null && !processChild.signalCode) processChild.kill('SIGTERM'); });
  await until(() => state.holds.length === 1); processChild.kill('SIGINT');
  const exit = await closed; assert.equal(exit.signal, null); assert.equal(exit.code, 6);
  assert.equal(stdout.length, 0); assert.match(JSON.parse(Buffer.concat(stderr)).error.code, /operation_unknown|companion_paused/);
  const restored = JSON.parse((await call('resolve')).stdout); assert.equal(restored.phase, 'running'); assert.equal(state.calls.length, 2);
  await state.stack.restartGateway();
  await assert.rejects(call('resolve'), error => error.code === 6 && JSON.parse(error.stdout).phase === 'unknown');
  assert.equal(state.calls.length, 2);
  assert.equal(JSON.parse((await call('stop')).stdout).stop_settled, true); state.holds.shift()(); assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'companion-interrupt-result.json'), JSON.stringify({ passed: true, interrupted_exit: 6, lock_released: true, real_gateway: true, gateway_restarts: 1, original_query_only: true, model_calls: 2, stopped_without_history: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + path.join(state.directory, 'companion-interrupt-result.json'));
});

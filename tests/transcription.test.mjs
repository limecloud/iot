import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, freePort, stop, until } from '../tools/dev-stack.mjs';
import { base, post, input, transcriptionStack } from './helpers/transcription.mjs';
import { createTranscriptionOriginal, parseTranscriptionInput, verifyTranscriptionTask } from '../packages/protocol/transcription.mjs';
const exec = promisify(execFile);

test('转写正式合同、CLI丢响应只查询、文本摘要和源录音删除后清除', { timeout: 120000 }, async t => {
  const { stack, directory, media, text, calls, errors, finish, fixture } = await transcriptionStack(t);
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/transcription.schema.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8')); assert.deepEqual(catalog.schemas.transcription, schema);
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv); ajv.addSchema(schema); const validate = ajv.getSchema(schema.$id + '#/$defs/task');
  assert.equal((await stack.request(base + '/capabilities')).value.transcription.capability, 'audio.transcribe');
  const value = input(media);
  for (const bad of [{ ...value, media_digest: 'bad' }, { ...value, language: 'xx' }, { ...value, extra: true }, { ...value, expires_at: 'bad' }]) assert.throws(() => parseTranscriptionInput(JSON.stringify(bad)), /invalid_transcription_request/);
  assert.equal((await stack.request(base + '/audio-transcriptions', post({ ...value, media_digest: 'sha256:' + 'b'.repeat(64) }, 'mismatch'))).status, 409); assert.equal(calls.length, 0);
  assert.equal((await stack.request('/api/v1/spaces/other/audio-transcriptions', post(value, 'foreign'))).status, 403);
  let posts = 0, gets = 0;
  const proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
    const bytes = Buffer.concat(chunks), response = await fetch(stack.env.LIMEIOT_ENDPOINT + req.url, { method: req.method, headers, body: bytes.length ? bytes : undefined }); const body = await response.text();
    if (req.method === 'POST') { posts++; req.socket.destroy(); } else { gets++; res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(body); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const origin = `http://127.0.0.1:${proxy.address().port}`, file = path.join(directory, 'input.json'), state = path.join(directory, 'cli'); await writeFile(file, JSON.stringify(value));
  const args = ['packages/cli/src/main.mjs', 'audio-transcriptions', 'create', '--space-id', 'space-demo', '--input', file, '--idempotency-key', 'cli-original', '--state-dir', state, '--endpoint', origin];
  await assert.rejects(exec(process.execPath, args, { cwd: root, env: stack.env }), error => error.code === 6 && JSON.parse(error.stderr).error.code === 'operation_unknown');
  const completed = await finish('cli-original'); assert.equal(completed.status, 'succeeded'); assert.equal(validate(completed), true, JSON.stringify(validate.errors));
  const original = await createTranscriptionOriginal(origin, 'space-demo', 'cli-original', value); await verifyTranscriptionTask(completed, 'space-demo', 'cli-original', original);
  assert.equal(completed.output.text, text); const altered = structuredClone(completed); altered.output.text += '!'; await assert.rejects(verifyTranscriptionTask(altered, 'space-demo', 'cli-original', original), /invalid_transcription_response/);
  const recovered = JSON.parse((await exec(process.execPath, args, { cwd: root, env: stack.env })).stdout); assert.equal(recovered.transcription_id, completed.transcription_id); assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(calls.length, 1);
  const records = await readdir(path.join(state, 'audio-transcriptions')); assert.equal(records.length, 1); const record = path.join(state, 'audio-transcriptions', records[0]); assert.equal((await stat(record)).mode & 0o777, 0o600); assert.equal((await readFile(record, 'utf8')).includes(text), false);
  await stack.restartGateway(); assert.equal((await finish('cli-original')).output.text, text); assert.equal(calls.length, 1);
  await stack.request(base + '/media-operations', post({ type: 'media.delete', media_id: media.media_id }, 'delete-source'));
  const cleared = await finish('cli-original'); assert.equal(cleared.status, 'succeeded'); assert.equal(cleared.output.text, null); assert.ok(cleared.output.cleared_at); await verifyTranscriptionTask(cleared, 'space-demo', 'cli-original', original);
  await stack.restartGateway(); assert.equal((await finish('cli-original')).output.text, null); assert.equal(calls.length, 1); assert.equal(fixture.effects.length, 0); assert.equal((await stack.request(base + '/media')).value.grants.length, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'transcription-result.json'), JSON.stringify({ passed: true, real_http: true, real_sqlite: true, real_mqtt: true, strict_schema: true, shared_digest_matches_rust: true, output_digest_verified: true, cli_response_loss_get_only: true, cli_posts: posts, cli_gets: gets, provider_calls: calls.length, durable_before_provider: true, source_deletion_clears_text_across_restart: true, no_authorization_or_play: true, simulated_provider: true, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'transcription-result.json') }));
});

test('转写故障：有界输出、重复键、跳转、未知预算及明确放弃拒绝迟到文本', { timeout: 120000 }, async t => {
  const { stack, directory, media, calls, errors, holds, setMode, finish } = await transcriptionStack(t, 'transcription-faults-');
  const create = (key, value = input(media)) => stack.request(base + '/audio-transcriptions', post(value, key));
  for (const [mode, expected, code] of [['reject', 'failed', 'transcription_provider_rejected'], ['duplicate', 'failed', 'invalid_transcription_output'], ['invalid', 'failed', 'invalid_transcription_output'], ['oversize', 'failed', 'transcription_output_too_large'], ['redirect', 'unknown', 'transcription_provider_unknown'], ['lost', 'unknown', 'transcription_provider_unknown']]) {
    setMode(mode); assert.equal((await create(mode)).status, 202); const task = await finish(mode); assert.equal(task.status, expected); assert.equal(task.error_code, code);
    if (expected === 'unknown') { assert.equal((await create('blocked-' + mode)).status, 429); assert.equal((await stack.request(base + '/audio-transcriptions/by-key/' + mode + '/discard', post({}))).value.status, 'discarded'); }
  }
  const providerOrigin = stack.env.LIMEIOT_ASR_URL; stack.env.LIMEIOT_ASR_URL = 'http://8.8.8.8:9999'; await stack.restartGateway();
  const beforePublic = calls.length; assert.equal((await create('public')).status, 202); assert.equal((await finish('public')).error_code, 'transcription_origin_not_local'); assert.equal(calls.length, beforePublic);
  stack.env.LIMEIOT_ASR_URL = providerOrigin; await stack.restartGateway();
  setMode('hold'); const deadline = { ...input(media), expires_at: new Date(Date.now() + 1000).toISOString() }; assert.equal((await create('deadline', deadline)).status, 202); await until(() => holds.length === 1);
  assert.equal((await finish('deadline')).error_code, 'transcription_deadline_exceeded'); assert.equal((await create('deadline-busy')).status, 429); await stack.request(base + '/audio-transcriptions/by-key/deadline/discard', post({})); holds.shift()();
  const held = input(media); await until(() => create('held', held).then(result => result.status === 202)); await until(() => holds.length === 1);
  assert.equal((await create('held', held)).status, 200); assert.equal((await create('held', { ...held, language: 'zh' })).status, 409); assert.equal((await create('busy')).status, 429);
  await stack.request(base + '/audio-transcriptions/by-key/held/discard', post({})); holds.shift()(); await until(() => create('after-discard').then(result => result.status === 202)); await until(() => holds.length === 1);
  assert.equal((await finish('held')).status, 'discarded');
  await stack.request(base + '/media-operations', post({ type: 'media.delete', media_id: media.media_id }, 'delete-held-source')); holds.shift()();
  assert.equal((await finish('after-discard')).error_code, 'transcription_source_unavailable'); assert.deepEqual(errors, []);
  const disk = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8')); assert.equal(disk.schema_version, 3); assert.equal(Object.values(disk.transcriptions).some(task => task.output !== null), false);
  await writeFile(path.join(directory, 'transcription-faults-result.json'), JSON.stringify({ passed: true, bounded_output: true, duplicate_keys_rejected: true, redirect_not_followed: true, public_origin_rejected_without_network_call: true, deadline_unknown_budget: true, unknown_budget_retained: true, same_key_no_replay: true, explicit_discard_blocks_late_output: true, deleted_source_blocks_late_publication: true, provider_calls: calls.length, simulated_provider: true, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'transcription-faults-result.json') }));
});

test('NAS媒体v3原字节备份恢复：保留转写结果，未完成任务未知且不重发音频', { timeout: 120000 }, async t => {
  const parent = await mkdtemp(path.join(root, '.dev/transcription-nas-')), installation = path.join(parent, 'installation'), backup = path.join(parent, 'backup'), restored = path.join(parent, 'restored');
  const manage = (...args) => exec('python3', ['deploy/nas/manage.py', ...args], { cwd: root, timeout: 30000 });
  await manage('init', '--directory', installation, '--origin', 'https://127.0.0.1:18443', '--media-origin', `http://127.0.0.1:${await freePort()}`);
  const { directory, stack, media, calls, holds, setMode, finish, text, errors } = await transcriptionStack(t, 'unused-', { directory: path.join(installation, 'data') });
  await copyFile(path.join(directory, 'config.json'), path.join(installation, 'config/gateway.json')); await copyFile(path.join(directory, 'audio.json'), path.join(installation, 'config/audio.json'));
  assert.equal((await stack.request(base + '/audio-transcriptions', post(input(media), 'done'))).status, 202); const completed = await finish('done'); assert.equal(completed.output.text, text);
  setMode('hold'); const pendingInput = input(media); await stack.request(base + '/audio-transcriptions', post(pendingInput, 'pending')); await until(() => holds.length === 1);
  const raw = await readFile(path.join(directory, 'gateway.sqlite.media.json')); await manage('backup', '--directory', installation, '--output', backup); assert.deepEqual(await readFile(path.join(backup, 'data/gateway.sqlite.media.json')), raw);
  await manage('restore', '--backup', backup, '--directory', restored); assert.deepEqual(await readFile(path.join(restored, 'data/gateway.sqlite.media.json')), raw);
  await stop(stack.gateway); stack.gateway = stack.launch('restored', path.join(root, 'target/debug/limeiot-gateway'), [], { LIMEIOT_DB: path.join(restored, 'data/gateway.sqlite'), LIMEIOT_CONFIG: path.join(restored, 'config/gateway.json'), LIMEIOT_AUDIO_CONFIG: path.join(restored, 'config/audio.json') });
  await until(async () => (await stack.request('/healthz')).value.broker_connected);
  assert.equal((await finish('done')).output.text, text); const pending = await finish('pending'); assert.equal(pending.status, 'unknown'); assert.equal(pending.error_code, 'transcription_interrupted');
  assert.equal((await stack.request(base + '/audio-transcriptions', post(pendingInput, 'pending'))).value.transcription_id, pending.transcription_id); assert.equal((await stack.request(base + '/audio-transcriptions', post(input(media), 'blocked'))).status, 429); assert.equal(calls.length, 2); holds.shift()(); assert.deepEqual(errors, []);
  await writeFile(path.join(parent, 'transcription-nas-result.json'), JSON.stringify({ passed: true, host_software: true, live_backup_v3_byte_exact: true, restore_new_directory: true, completed_text_retained: true, interrupted_unknown: true, unknown_budget_retained: true, original_queries_no_audio_replay: true, provider_calls: calls.length, container_runtime: false, nas_image_rebuilt: false, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(parent, 'transcription-nas-result.json') }));
});

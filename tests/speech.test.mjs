import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, until, freePort, stop } from '../tools/dev-stack.mjs';
import { mediaStack, pcmWav } from './helpers/media.mjs';
import { createSpeechOriginal, parseSpeechInput, verifySpeechTask } from '../packages/protocol/speech.mjs';
const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const input = text => ({ text, voice: 'local', retain_seconds: 600, expires_at: new Date(Date.now() + 60000).toISOString() });
const post = (value, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) });
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function providerFixture(t) {
  const calls = [], holds = [], bytes = pcmWav(); let inspect = async () => {};
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const c of request) chunks.push(c);
    const value = JSON.parse(Buffer.concat(chunks)); const call = { url: request.url, value, inspected: false }; calls.push(call);
    try { await inspect(value); call.inspected = true; } catch (error) { response.writeHead(500); response.end(); return; }
    switch (value.input) {
      case 'hold': holds.push(() => { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(bytes); }); return;
      case 'reject': response.writeHead(400); response.end('provider private error'); return;
      case 'broken': response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end('not audio'); return;
      case 'json': response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return;
      case 'lost': request.socket.destroy(); return;
      case 'redirect': response.writeHead(302, { Location: '/should-never-follow' }); response.end(); return;
      case 'oversize': response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.write(Buffer.alloc(4 * 1024 * 1024)); response.end(Buffer.alloc(1)); return;
      default: response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(bytes);
    }
  });
  const origin = await listen(server); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin, calls, holds, inspect: callback => { inspect = callback; } };
}
const finish = (stack, key) => until(async () => { const r = await stack.request(base + '/speech-syntheses/by-key/' + key); return r.status === 200 && r.value.status !== 'running' && r.value; });
const env = p => ({ LIMEIOT_TTS_URL: p.origin, LIMEIOT_TTS_MODEL: 'fixture/local-model', LIMEIOT_TTS_VOICES: 'local,other', LIMEIOT_TTS_CA_FILE: '' });

test('NAS语音覆盖渲染及机器输入合同保持一致', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(root, '.dev/speech-compose-'));
  await exec('python3', [path.join(root, 'deploy/nas/manage.py'), 'init', '--directory', directory, '--origin', 'https://127.0.0.1:18443', '--media-origin', `http://127.0.0.1:${await freePort()}`], { cwd: root, timeout: 30000 });
  let command = ['docker', 'compose']; try { await exec(command[0], [...command.slice(1), 'version']); } catch { command = ['docker-compose']; }
  const rendered = JSON.parse((await exec(command[0], [...command.slice(1), '--env-file', path.join(directory, 'compose.env'), '-f', 'deploy/nas/compose.yaml', '-f', 'deploy/nas/compose.media.yaml', '-f', 'deploy/nas/compose.speech.yaml', 'config', '--format', 'json'], { cwd: root, env: { ...process.env, LIMEIOT_TTS_URL: 'http://192.168.1.10:8000', LIMEIOT_TTS_MODEL: 'local-model', LIMEIOT_TTS_VOICES: 'local' }, timeout: 15000 })).stdout);
  assert.equal(rendered.services.gateway.environment.LIMEIOT_TTS_MODEL, 'local-model'); assert.equal(rendered.services.gateway.environment.LIMEIOT_TTS_URL, 'http://192.168.1.10:8000'); assert.ok(rendered.networks.media); assert.equal(rendered.services.gateway.ports.length, 1);
  const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8')), schema = JSON.parse(await readFile(path.join(root, 'contracts/speech.schema.json'), 'utf8'));
  assert.deepEqual(catalog.schemas.speech, schema);
  assert.deepEqual(catalog.operations.filter(o => o.operation_id.startsWith('speech-syntheses.')).map(o => o.operation_id).sort(), ['speech-syntheses.create', 'speech-syntheses.discard', 'speech-syntheses.resolve']);
  for (const v of [{ ...input('text'), text: ' ' }, input('a'.repeat(1001)), input('\u0000bad'), input('\ud800')]) assert.throws(() => parseSpeechInput(JSON.stringify(v)), /invalid_speech_request/);
  await writeFile(path.join(directory, 'speech-compose-result.json'), JSON.stringify({ passed: true, compose_rendered: true, machine_schema_synced: true, container_runtime: false, nas_image_rebuilt: false, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'speech-compose-result.json') }));
});

test('语音合同、CLI丢回执恢复及明确授权后的真实软件播放', { timeout: 120000 }, async t => {
  const provider = await providerFixture(t);
  const { stack, directory, bytes, fixture, model, bindSpeaker } = await mediaStack(t, 'speech-journey-', { gatewayEnv: env(provider) });
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/speech.schema.json'), 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv); ajv.addSchema(schema);
  const validate = ajv.getSchema(schema.$id + '#/$defs/task');
  provider.inspect(async value => {
    const disk = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'));
    assert.ok(Object.values(disk.speech).some(task => task.status === 'running' && task.input_characters === Array.from(value.input).length));
    assert.equal(JSON.stringify(disk).includes(value.input), false);
  });
  const capabilities = (await stack.request(base + '/capabilities')).value;
  assert.equal(capabilities.speech.configured, true); assert.equal(capabilities.speech.deployment.data_location, 'local');
  assert.deepEqual(capabilities.speech.voices, ['local', 'other']);
  assert.equal((await stack.request('/api/v1/spaces/other/speech-syntheses', post(input('foreign'), 'foreign'))).status, 403);
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT + base + '/speech-syntheses', post(input('anonymous'), 'anonymous'))).status, 401);
  assert.equal((await stack.request(base + '/speech-syntheses', post({ ...input('bad voice'), voice: 'missing' }, 'bad-voice'))).status, 422);
  assert.equal(provider.calls.length, 0);
  for (const bad of [{ ...input('expired'), expires_at: new Date(Date.now() - 1000).toISOString() }, input('x'.repeat(1001)), { ...input('bad'), extra: true }]) assert.equal((await stack.request(base + '/speech-syntheses', post(bad, 'invalid-input'))).status, 422);
  let posts = 0, gets = 0;
  const proxy = http.createServer(async (request, response) => {
    const chunks = []; for await (const c of request) chunks.push(c);
    const body = Buffer.concat(chunks), headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
    const result = await fetch(stack.env.LIMEIOT_ENDPOINT + request.url, { method: request.method, headers, body: body.length ? body : undefined });
    const reply = await result.text();
    if (request.method === 'POST') { posts++; request.socket.destroy(); } else { gets++; response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(reply); }
  });
  const origin = await listen(proxy); t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const text = '这是私密的青柠语音测试。', request = input(text), file = path.join(directory, 'input.json'), state = path.join(directory, 'cli'); await writeFile(file, JSON.stringify(request));
  const cli = async args => {
    try { const r = await exec(process.execPath, ['packages/cli/src/main.mjs', ...args, '--space-id', 'space-demo', '--state-dir', state, '--endpoint', origin], { cwd: root, env: stack.env, timeout: 15000 }); return { code: 0, value: JSON.parse(r.stdout) }; }
    catch (e) { return { code: e.code, value: JSON.parse(e.stderr || e.stdout) }; }
  };
  const args = ['speech-syntheses', 'create', '--input', file, '--idempotency-key', 'cli-first'];
  assert.equal((await cli(args)).code, 6);
  const completed = await finish(stack, 'cli-first'); assert.equal(completed.status, 'succeeded');
  assert.equal(validate(completed), true, JSON.stringify(validate.errors));
  const expected = await createSpeechOriginal(origin, 'space-demo', 'cli-first', parseSpeechInput(JSON.stringify(request))); verifySpeechTask(completed, 'space-demo', 'cli-first', expected);
  const restored = await cli(args); assert.equal(restored.code, 0); assert.equal(restored.value.synthesis_id, completed.synthesis_id);
  assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(provider.calls.length, 1); assert.equal(provider.calls[0].inspected, true);
  assert.deepEqual(provider.calls[0].value, { model: 'fixture/local-model', input: text, voice: 'local', response_format: 'wav', speed: 1 }); assert.equal(provider.calls[0].url, '/v1/audio/speech');
  const originals = await readdir(path.join(state, 'speech-syntheses')); const original = await readFile(path.join(state, 'speech-syntheses', originals[0]), 'utf8'); assert.equal(original.includes(text), false); assert.equal((await stat(path.join(state, 'speech-syntheses', originals[0]))).mode & 0o777, 0o600);
  const page = (await stack.request(base + '/media')).value; assert.equal(page.items.length, 1); assert.equal(page.items[0].metadata.media_id, completed.media_id); assert.equal(page.items[0].metadata.byte_length, bytes.length); assert.equal(page.grants.length, 0); assert.equal(fixture.effects.length, 0);
  const binding = await bindSpeaker();
  const granted = await stack.request(base + '/media-operations', post({ type: 'media.grant', media_id: completed.media_id, device_id: 'device-lamp', expected_binding_revision: binding.revision, valid_for_seconds: 300 }, 'speech-grant')); assert.equal(granted.status, 200); assert.equal(fixture.effects.length, 0);
  const command = await stack.request(base + '/commands', post({ device_id: 'device-lamp', model_revision: model.model_revision, expires_at: new Date(Date.now() + 8000).toISOString(), operation: { type: 'action.invoke', path: 'playback.play', value: { media_id: completed.media_id } } }, 'speech-play'));
  assert.equal(command.status, 202); await until(async () => (await stack.request(base + '/commands/' + command.value.command_id)).value.status === 'confirmed'); assert.equal(fixture.effects.length, 3); assert.equal(fixture.renderedPulls.length, 1);
  await stack.request(base + '/media-operations', post({ type: 'media.delete', media_id: completed.media_id }, 'delete-speech')); await stack.restartGateway();
  const old = (await stack.request(base + '/speech-syntheses/by-key/cli-first')).value; assert.equal(old.media_id, completed.media_id); assert.equal((await stack.request(base + '/media')).value.items[0].available, false); assert.equal(provider.calls.length, 1);
  delete stack.env.LIMEIOT_TTS_URL; delete stack.env.LIMEIOT_TTS_MODEL; delete stack.env.LIMEIOT_TTS_VOICES;
  await stack.restartGateway(); assert.equal((await stack.request(base + '/capabilities')).value.speech.configured, false);
  assert.equal((await stack.request(base + '/speech-syntheses', post(request, 'cli-first'))).value.synthesis_id, completed.synthesis_id);
  assert.equal((await stack.request(base + '/speech-syntheses', post(input('disabled'), 'disabled'))).status, 503); assert.equal(provider.calls.length, 1);
  // NAS备份读取保留版本2字节，不把历史任务变成重放请求。
  await exec('python3', ['-c', 'from media_state import read_snapshot\nfrom pathlib import Path\nimport sys\nassert read_snapshot(Path(sys.argv[1]), "space-demo") is not None', path.join(directory, 'gateway.sqlite.media.json')], { cwd: path.join(root, 'deploy/nas') });
  const report = { passed: true, real_http: true, real_sqlite: true, real_mqtt: true, durable_before_provider: true, digest_matches_rust: true, cli_response_loss_get_only: true, provider_calls: provider.calls.length, no_plaintext_in_originals_or_snapshot: true, separate_grant_and_play: true, soap_mutations: fixture.effects.length, media_range_pulls: fixture.renderedPulls.length, restart_no_resynthesis: true, deleted_output_no_resurrection: true, nas_v2_snapshot_read: true, simulated_provider: true, simulated_renderer: true, real_synthesis_quality: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false };
  await writeFile(path.join(directory, 'speech-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'speech-result.json') }));
});

test('语音故障边界：有界响应、不跟随跳转、同键、放弃、期限及重启均不重放', { timeout: 120000 }, async t => {
  const provider = await providerFixture(t); const { stack, directory, fixture } = await mediaStack(t, 'speech-faults-', { gatewayEnv: env(provider) });
  const create = (value, key) => stack.request(base + '/speech-syntheses', post(value, key));
  const holding = input('hold'); const accepted = await create(holding, 'held'); assert.equal(accepted.status, 202); await until(() => provider.holds.length === 1);
  assert.equal((await create(holding, 'held')).status, 200); assert.equal((await create({ ...holding, text: 'changed' }, 'held')).status, 409);
  assert.equal((await create(input('new'), 'busy')).status, 429); assert.equal((await stack.request(base + '/speech-syntheses/by-key/busy')).status, 404);
  const discardArgs = ['packages/cli/src/main.mjs', 'speech-syntheses', 'discard', 'held', '--space-id', 'space-demo', '--state-dir', path.join(directory, 'discard-cli')];
  const discarded = JSON.parse((await exec(process.execPath, discardArgs, { cwd: root, env: stack.env })).stdout); assert.equal(discarded.status, 'discarded');
  assert.equal(JSON.parse((await exec(process.execPath, discardArgs, { cwd: root, env: stack.env })).stdout).status, 'discarded');
  provider.holds.shift()(); await until(async () => (await create(input('ordinary'), 'after-discard')).status === 202);
  assert.equal((await finish(stack, 'held')).status, 'discarded'); assert.equal((await finish(stack, 'after-discard')).status, 'succeeded');
  assert.equal((await stack.request(base + '/media')).value.items.length, 1);
  for (const [text, status, code] of [['reject', 'failed', 'speech_provider_rejected'], ['broken', 'failed', 'invalid_speech_audio'], ['json', 'failed', 'invalid_speech_audio'], ['lost', 'unknown', 'speech_provider_unknown'], ['redirect', 'unknown', 'speech_provider_unknown'], ['oversize', 'failed', 'speech_output_too_large']]) {
    assert.equal((await create(input(text), text)).status, 202); const result = await finish(stack, text); assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.error_code, code);
    if (status === 'unknown') { assert.equal((await create(input('blocked'), 'unknown-busy')).status, 429); assert.equal((await stack.request(base + '/speech-syntheses/by-key/' + text + '/discard', post({}, 'discard'))).value.status, 'discarded'); }
  }
  const deadline = { ...input('hold'), expires_at: new Date(Date.now() + 1000).toISOString() }; assert.equal((await create(deadline, 'deadline')).status, 202); await until(() => provider.holds.length === 1);
  assert.equal((await finish(stack, 'deadline')).error_code, 'speech_deadline_exceeded'); provider.holds.shift()();
  assert.equal((await create(input('blocked'), 'deadline-busy')).status, 429); await stack.request(base + '/speech-syntheses/by-key/deadline/discard', post({}, 'discard'));
  const interrupted = input('hold'); assert.equal((await create(interrupted, 'restart')).status, 202); await until(() => provider.holds.length === 1);
  const count = provider.calls.length; await stack.restartGateway(); const recovered = await finish(stack, 'restart'); assert.equal(recovered.status, 'unknown'); assert.equal(recovered.error_code, 'speech_interrupted'); assert.equal((await create(interrupted, 'restart')).value.synthesis_id, recovered.synthesis_id); assert.equal(provider.calls.length, count); provider.holds.shift()();
  assert.equal((await create(input('blocked'), 'restart-busy')).status, 429); await stack.request(base + '/speech-syntheses/by-key/restart/discard', post({}, 'discard'));
  assert.equal((await stack.request(base + '/media')).value.items.length, 1); assert.equal(fixture.effects.length, 0);
  stack.env.LIMEIOT_TTS_URL = 'http://8.8.8.8:9999'; await stack.restartGateway();
  assert.equal((await create(input('public endpoint'), 'public')).status, 202); assert.equal((await finish(stack, 'public')).error_code, 'speech_origin_not_local'); assert.equal(provider.calls.length, count);
  const disk = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8')); assert.equal(Object.keys(disk.speech).length, 11); assert.equal(provider.calls.every(c => c.url === '/v1/audio/speech'), true);
  await writeFile(path.join(directory, 'speech-faults-result.json'), JSON.stringify({ passed: true, busy_preaccept_no_task: true, same_key_no_replay: true, discard_denies_late_output: true, unknown_timeout_and_restart: true, bounded_chunked_response: true, redirects_not_followed: true, effects: 0, hardware: false, hardware_status: '用户要求跳过', real_synthesis_quality: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'speech-faults-result.json') }));
});

test('NAS语音v2实际备份与新目录恢复：保留音频、未知占用且零重新合成', { timeout: 120000 }, async t => {
  const parent = await mkdtemp(path.join(root, '.dev/speech-nas-')), directory = path.join(parent, 'installation'), backup = path.join(parent, 'backup'), restored = path.join(parent, 'restored');
  const mediaPort = await freePort(), provider = await providerFixture(t);
  const manage = (...args) => exec('python3', [path.join(root, 'deploy/nas/manage.py'), ...args], { cwd: root, timeout: 30000 });
  await manage('init', '--directory', directory, '--origin', 'https://127.0.0.1:18443', '--media-origin', `http://127.0.0.1:${mediaPort}`);
  const secret = async name => (await readFile(path.join(directory, 'secrets', name), 'utf8')).trim();
  const credentials = { owner: await secret('owner-token'), gateway: await secret('gateway-password'), lamp: await secret('device-lamp-password'), button: await secret('device-button-password') };
  const { stack, fixture } = await mediaStack(t, 'unused-', { directory: path.join(directory, 'data'), mediaPort, credentials, gatewayEnv: env(provider) });
  await copyFile(path.join(directory, 'data/config.json'), path.join(directory, 'config/gateway.json')); await copyFile(path.join(directory, 'data/audio.json'), path.join(directory, 'config/audio.json'));
  const first = input('备份后保留这段语音。'); assert.equal((await stack.request(base + '/speech-syntheses', post(first, 'done'))).status, 202);
  const done = await finish(stack, 'done'); assert.equal(done.status, 'succeeded');
  const second = input('hold'); assert.equal((await stack.request(base + '/speech-syntheses', post(second, 'pending'))).status, 202); await until(() => provider.holds.length === 1);
  const source = await readFile(path.join(directory, 'data/gateway.sqlite.media.json')); assert.equal(JSON.parse(source).schema_version, 2);
  await manage('backup', '--directory', directory, '--output', backup); assert.deepEqual(await readFile(path.join(backup, 'data/gateway.sqlite.media.json')), source);
  await manage('restore', '--directory', restored, '--backup', backup); assert.deepEqual(await readFile(path.join(restored, 'data/gateway.sqlite.media.json')), source);
  await stop(stack.gateway);
  stack.gateway = stack.launch('restored-speech', path.join(root, 'target/debug/limeiot-gateway'), [], { LIMEIOT_DB: path.join(restored, 'data/gateway.sqlite'), LIMEIOT_CONFIG: path.join(restored, 'config/gateway.json'), LIMEIOT_AUDIO_CONFIG: path.join(restored, 'config/audio.json') });
  await until(async () => (await stack.request('/healthz')).value.broker_connected);
  const completed = (await stack.request(base + '/speech-syntheses/by-key/done')).value, pending = (await stack.request(base + '/speech-syntheses/by-key/pending')).value;
  assert.equal(completed.synthesis_id, done.synthesis_id); assert.equal(completed.media_id, done.media_id); assert.equal(pending.status, 'unknown'); assert.equal(pending.error_code, 'speech_interrupted');
  assert.equal((await stack.request(base + '/speech-syntheses', post(second, 'pending'))).value.synthesis_id, pending.synthesis_id); assert.equal((await stack.request(base + '/speech-syntheses', post(input('must not synthesize'), 'blocked'))).status, 429);
  const page = (await stack.request(base + '/media')).value; assert.equal(page.items.length, 1); assert.equal(page.items[0].available, true); assert.equal(page.grants.length, 0); assert.equal(provider.calls.length, 2); assert.equal(fixture.effects.length, 0);
  provider.holds.shift()();
  await writeFile(path.join(parent, 'speech-nas-result.json'), JSON.stringify({ passed: true, host_software: true, live_backup_v2_byte_exact: true, restored_new_directory: true, completed_media_retained: true, interrupted_task_unknown: true, unresolved_budget_retained: true, original_queries_no_resynthesis: true, provider_calls: 2, no_authorization_or_play: true, container_runtime: false, nas_image_rebuilt: false, real_synthesis_quality: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(parent, 'speech-nas-result.json') }));
});

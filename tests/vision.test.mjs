import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, until } from '../tools/dev-stack.mjs';
import { base, post, input, png, visionStack } from './helpers/vision.mjs';
import { createVisionOriginal, parseVisionInput, verifyVisionTask } from '../packages/protocol/vision.mjs';
const exec = promisify(execFile);

test('视觉模型计算期间，本地设备控制仍通过原MQTT回执完成', { timeout: 60000 }, async t => {
  const { stack, directory, calls, errors, holds, setMode } = await visionStack(t); setMode('hold');
  assert.equal((await stack.request(base + '/vision-observations', post(input(), 'observation'))).status, 202); await until(() => holds.length === 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const device = (await stack.request(base + '/devices/device-lamp')).value;
  const response = await stack.request(base + '/commands', post({ device_id: 'device-lamp', model_revision: device.model_revision, expires_at: new Date(Date.now() + 8000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'explicit-owner-control'));
  assert.equal(response.status, 202);
  const command = await until(async () => { const value = (await stack.request(base + '/commands/' + response.value.command_id)).value; return value.status === 'confirmed' && value; });
  assert.equal(command.request.idempotency_key, 'explicit-owner-control'); assert.equal((await stack.request(base + '/vision-observations/by-key/observation')).value.status, 'running');
  assert.equal((await stack.request(base + '/commands')).value.items.length, 1); assert.equal(calls.length, 1);
  await stack.request(base + '/vision-observations/by-key/observation/discard', post({})); holds.shift()(); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'vision-availability-result.json'), JSON.stringify({ passed: true, real_http: true, real_gateway: true, real_mqtt: true, provider_held_while_owner_command_confirmed: true, vision_generated_commands: 0, explicit_owner_commands: 1, provider_calls: 1, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'vision-availability-result.json') }));
});

test('视觉正式合同、真实图片、CLI丢回执只查原键、重启和清除不重发', { timeout: 120000 }, async t => {
  const { stack, directory, calls, errors, text, finish } = await visionStack(t);
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/vision.schema.json'), 'utf8')), catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'), 'utf8'));
  assert.deepEqual(catalog.schemas.vision, schema); const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv); ajv.addSchema(schema); const validate = ajv.getSchema(schema.$id + '#/$defs/task');
  const value = { ...input(png(64,64,true)), expires_at: new Date(Math.floor((Date.now()+60000)/1000)*1000).toISOString() };
  assert.ok(JSON.stringify(value).length>8192); assert.equal(ajv.validate(schema.$id, value), true, JSON.stringify(ajv.errors));
  const capabilities = (await stack.request(base + '/capabilities')).value.vision; assert.equal(capabilities.capability, 'vision.understand'); assert.equal(capabilities.device_execution, false);
  assert.equal((await stack.request('/api/v1/spaces/foreign/vision-observations', post(value, 'foreign'))).status, 403);
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT + base + '/vision-observations', post(value, 'anonymous'))).status, 401);
  for (const bad of [{ ...value, image_base64: 'not an image' }, { ...value, content_type: 'text/html' }, { ...value, prompt: 'x'.repeat(513) }, { ...value, retain_seconds: 3601 }, { ...value, extra: true }]) assert.throws(() => parseVisionInput(JSON.stringify(bad)), /invalid_vision_request/);
  const badCRC=png();badCRC[29]^=1;
  for (const bad of [{ ...value, image_base64: png().subarray(0, 30).toString('base64') }, input(badCRC), input(png(1,1,false,true)), input(png(1025)), { ...value, content_type: 'image/jpeg' }]) assert.equal((await stack.request(base + '/vision-observations', post(bad, 'invalid'))).status, 422);
  assert.equal(calls.length, 0);
  let posts = 0, gets = 0;
  const proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
    const bytes = Buffer.concat(chunks), response = await fetch(stack.env.LIMEIOT_ENDPOINT + req.url, { method: req.method, headers, body: bytes.length ? bytes : undefined }); const body = await response.text();
    if (req.method === 'POST') { posts++; req.socket.destroy(); } else { gets++; res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(body); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const origin = `http://127.0.0.1:${proxy.address().port}`, file = path.join(directory, 'input.json'), state = path.join(directory, 'cli'); await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const args = ['packages/cli/src/main.mjs', 'vision-observations', 'create', '--space-id', 'space-demo', '--input', file, '--idempotency-key', 'original', '--state-dir', state, '--endpoint', origin];
  await assert.rejects(exec(process.execPath, args, { cwd: root, env: stack.env }), error => error.code === 6 && JSON.parse(error.stderr).error.code === 'operation_unknown');
  const completed = await finish('original'); assert.equal(completed.status, 'succeeded'); assert.equal(validate(completed), true, JSON.stringify(validate.errors));
  const original = await createVisionOriginal(origin, 'space-demo', 'original', value); await verifyVisionTask(completed, 'space-demo', 'original', original);
  const changed = structuredClone(completed); changed.output.text += '!'; await assert.rejects(verifyVisionTask(changed, 'space-demo', 'original', original), /invalid_vision_response/);
  const resolved = JSON.parse((await exec(process.execPath, args, { cwd: root, env: stack.env })).stdout); assert.equal(resolved.vision_id, completed.vision_id); assert.equal(resolved.output.text, text); assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(calls.length, 1);
  const records = await readdir(path.join(state, 'vision-observations')); assert.equal(records.length, 1); const recordPath = path.join(state, 'vision-observations', records[0]); assert.equal((await stat(recordPath)).mode & 0o777, 0o600); const raw = await readFile(recordPath, 'utf8'); assert.equal(raw.includes(value.image_base64), false); assert.equal(raw.includes(value.prompt), false); assert.equal(raw.includes(text), false);
  await stack.restartGateway(); assert.equal((await finish('original')).output.text, text); assert.equal(calls.length, 1);
  const cleared = (await stack.request(base + '/vision-observations/by-key/original/discard', post({}))).value; assert.equal(cleared.status, 'succeeded'); assert.equal(cleared.output.text, null); assert.ok(cleared.output.cleared_at); await verifyVisionTask(cleared, 'space-demo', 'original', original);
  await stack.restartGateway(); assert.equal((await finish('original')).output.text, null); assert.equal(calls.length, 1); assert.equal((await stack.request(base + '/commands')).value.items.length, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'vision-result.json'), JSON.stringify({ passed: true, real_http: true, real_sqlite: true, real_mqtt: true, decoded_png: true, strict_schema: true, digest_matches_rust: true, cli_response_loss_get_only: true, private_digest_only_record: true, restart_does_not_resubmit: true, clear_survives_restart: true, provider_calls: calls.length, device_commands: 0, provider_fixture: true, real_vision_quality: false, hardware: false, nas_image_rebuilt: false, published: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'vision-result.json') }));
});

test('视觉故障：有界输出、工具注入、截断、超时、未知预算与重启零重发', { timeout: 120000 }, async t => {
  const { stack, directory, calls, errors, holds, setMode, finish } = await visionStack(t);
  const create = (key, value = input()) => stack.request(base + '/vision-observations', post(value, key));
  for (const [mode, expected, code] of [['reject', 'failed', 'vision_provider_rejected'], ['duplicate', 'failed', 'invalid_vision_output'], ['invalid', 'failed', 'invalid_vision_output'], ['tool', 'failed', 'invalid_vision_output'], ['truncated', 'failed', 'invalid_vision_output'], ['model', 'failed', 'invalid_vision_output'], ['oversize', 'failed', 'vision_output_too_large'], ['redirect', 'unknown', 'vision_provider_unknown'], ['lost', 'unknown', 'vision_provider_unknown']]) {
    setMode(mode); assert.equal((await create(mode)).status, 202); const task = await finish(mode); assert.equal(task.status, expected); assert.equal(task.error_code, code);
    if (expected === 'unknown') { assert.equal((await create('blocked-' + mode)).status, 429); await stack.request(base + '/vision-observations/by-key/' + mode + '/discard', post({})); }
  }
  const local = stack.env.LIMEIOT_VISION_URL; stack.env.LIMEIOT_VISION_URL = 'http://8.8.8.8:9999'; await stack.restartGateway(); const beforePublic = calls.length; assert.equal((await create('public')).status, 202); assert.equal((await finish('public')).error_code, 'vision_origin_not_local'); assert.equal(calls.length, beforePublic);
  stack.env.LIMEIOT_VISION_URL = local; await stack.restartGateway(); setMode('hold'); assert.equal((await create('deadline', { ...input(), expires_at: new Date(Date.now() + 1000).toISOString() })).status, 202); await until(() => holds.length === 1); assert.equal((await finish('deadline')).error_code, 'vision_deadline_exceeded'); assert.equal((await create('deadline-busy')).status, 429); await stack.request(base + '/vision-observations/by-key/deadline/discard', post({})); holds.shift()();
  const held = input(); await until(() => create('held', held).then(result => result.status === 202)); await until(() => holds.length === 1); assert.equal((await create('held', held)).status, 200); assert.equal((await create('held', { ...held, prompt: held.prompt + '!' })).status, 409);
  const beforeRestart = calls.length; await stack.restartGateway(); assert.equal((await finish('held')).status, 'unknown'); assert.equal((await create('held', held)).value.status, 'unknown'); assert.equal((await create('blocked')).status, 429); assert.equal(calls.length, beforeRestart);
  await stack.request(base + '/vision-observations/by-key/held/discard', post({})); holds.shift()(); assert.equal((await finish('held')).status, 'discarded');
  await until(() => create('late').then(result => result.status === 202)); await until(() => holds.length === 1); await stack.request(base + '/vision-observations/by-key/late/discard', post({})); holds.shift()(); assert.equal((await finish('late')).status, 'discarded'); assert.equal((await stack.request(base + '/commands')).value.items.length, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'vision-faults-result.json'), JSON.stringify({ passed: true, bounded_output: true, duplicate_keys_rejected: true, tool_calls_rejected: true, truncated_output_rejected: true, model_mismatch_rejected: true, redirect_not_followed: true, public_origin_rejected: true, unknown_blocks_new_work: true, same_key_does_not_resubmit: true, restart_does_not_resubmit: true, late_output_not_published: true, provider_calls: calls.length, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'vision-faults-result.json') }));
});

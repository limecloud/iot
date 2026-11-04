import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { textStack, base, post, input } from './helpers/text.mjs';
import { verifyAiCatalog, parseAiCatalog } from '../packages/protocol/ai-catalog.mjs';

const exec = promisify(execFile);
const resource = base + '/ai-catalog';
const sources = { 'automation.rule_draft': 'inference', 'text.generate': 'text', 'vision.understand': 'vision', 'audio.transcribe': 'transcription', 'audio.synthesize': 'speech' };
const schema = JSON.parse(await readFile(new URL('../contracts/ai-catalog.schema.json', import.meta.url)));
const ajv = new Ajv({ strict: true, allErrors: true });
const valid = ajv.compile(schema);
const check = value => { assert.equal(valid(value), true, JSON.stringify(valid.errors)); return verifyAiCatalog(value, 'space-demo'); };

test('未配置 AI 的目录仍可发现合同，匿名与跨空间拒绝，CLI 只读', { timeout: 60000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const value = check((await stack.request(resource)).value);
  assert.equal(value.definitions.length, 5); assert.deepEqual(value.deployments, []); assert.ok(value.health.every(item => item.status === 'not_configured' && item.checked_at === null));
  const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json')));
  assert.deepEqual(catalog.schemas['ai-catalog'], schema);
  const served = (await stack.request('/api/v1/schema')).value;
  assert.deepEqual(served.schemas['ai-catalog'], schema);
  for (const definition of value.definitions) {
    for (const name of [definition.create_operation, definition.resolve_operation]) assert.ok(served.operations.some(operation => operation.operation_id === name));
    assert.ok(served.schemas[definition.input_schema]);
    if (definition.task_schema) { const [name, fragment] = definition.task_schema.split('#'); assert.ok(served.schemas[name].$defs[fragment.split('/').at(-1)]); }
  }
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT + resource)).status, 401);
  assert.equal((await stack.request('/api/v1/spaces/foreign/ai-catalog')).status, 403);
  const operation = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'schema', 'ai-catalog.list'], { cwd: root, env: stack.env })).stdout);
  assert.equal(operation.method, 'GET'); assert.equal(operation.side_effects, 'none');
  for (const args of [['ai-catalog', 'list'], ['invoke', 'ai-catalog.list']]) {
    const result = await exec(process.execPath, ['packages/cli/src/main.mjs', ...args, '--space-id', 'space-demo'], { cwd: root, env: stack.env });
    assert.deepEqual(check(JSON.parse(result.stdout)), value);
  }
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
});

test('五类服务投影、严格消费者、不可达与重启保持无探测，明确调用才推理', { timeout: 120000 }, async t => {
  const { stack, directory, calls, errors } = await textStack(t);
  stack.env.LIMEIOT_ASR_MODEL = 'fixture/asr'; stack.env.LIMEIOT_ASR_URL = stack.env.LIMEIOT_TEXT_URL;
  stack.env.LIMEIOT_TTS_MODEL = 'fixture/tts'; stack.env.LIMEIOT_TTS_URL = stack.env.LIMEIOT_TEXT_URL; stack.env.LIMEIOT_TTS_VOICES = 'local';
  stack.env.LIMEIOT_VISION_MODEL = 'fixture:vision'; stack.env.LIMEIOT_VISION_URL = stack.env.LIMEIOT_TEXT_URL;
  stack.env.LIMEIOT_OLLAMA_MODEL = 'fixture:rules'; stack.env.LIMEIOT_OLLAMA_URL = stack.env.LIMEIOT_TEXT_URL;
  await stack.restartGateway();
  const mediaState = () => readFile(path.join(directory, 'gateway.sqlite.media.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const before = await mediaState();
  const value = check((await stack.request(resource)).value), capabilities = (await stack.request(base + '/capabilities')).value;
  assert.equal(value.deployments.length, 5); assert.ok(value.health.every(item => item.status === 'unknown'));
  for (const item of value.deployments) {
    const source = structuredClone(capabilities[sources[item.capability_id]]);
    const identity = item.capability_id === 'automation.rule_draft' ? { adapter: source.provider, revision: null, model: source.model, data_location: source.data_location } : source.deployment;
    assert.deepEqual(item.identity, identity);
    for (const key of ['configured', 'capability', 'deployment', 'provider', 'model', 'data_location']) delete source[key];
    assert.deepEqual(item.configuration, source);
    assert.equal(item.license, null); assert.equal(item.quality, null);
  }
  const invalid = [
    v => { v.space_id = 'foreign'; }, v => { v.schema_version = 2; }, v => { v.extra = true; },
    v => { v.deployments.push(v.deployments[0]); }, v => { v.health[1] = v.health[0]; },
    v => { v.health[0].status = 'healthy'; }, v => { v.health[0].checked_at = new Date().toISOString(); },
    v => { v.routing.automatic_fallback = true; }, v => { v.definitions[0].device_execution = true; },
    v => { v.deployments[0].identity.revision = 'sha256:' + '0'.repeat(64); },
    v => { v.deployments[1].identity.adapter = 'ollama-vision-v1'; },
    v => { v.deployments[1].configuration.concurrency = 2; },
    v => { v.deployments[1].configuration.configured = false; },
    v => { v.deployments[1].configuration.url = 'http://private-host'; },
    v => { v.deployments[1].license = 'MIT'; }, v => { v.deployments[1].quality = 'passed'; },
    v => { v.deployments.splice(1, 1); },
  ];
  for (const mutate of invalid) { const bad = structuredClone(value); mutate(bad); assert.throws(() => verifyAiCatalog(bad, 'space-demo'), /invalid_ai_catalog/); }
  assert.deepEqual(parseAiCatalog(JSON.stringify(value), 'space-demo'), value);
  assert.throws(() => parseAiCatalog(JSON.stringify(value).replace('"schema_version":1', '"schema_version":1,"schema_version":1'), 'space-demo'), /invalid_ai_catalog/);
  assert.throws(() => parseAiCatalog(' '.repeat(32769), 'space-demo'), /invalid_ai_catalog/);
  const proxy = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...value, space_id: 'foreign' })); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const failure = await exec(process.execPath, ['packages/cli/src/main.mjs', 'ai-catalog', 'list', '--space-id', 'space-demo'], { cwd: root, env: { ...stack.env, LIMEIOT_ENDPOINT: 'http://127.0.0.1:' + proxy.address().port } }).then(() => assert.fail('CLI must reject mismatched catalog'), error => error);
  assert.equal(failure.code, 2); assert.equal(JSON.parse(failure.stderr).error.code, 'invalid_ai_catalog');
  assert.deepEqual(await mediaState(), before); assert.deepEqual(calls, []);
  const file = path.join(directory, 'catalog-selected-text.json');
  await writeFile(file, JSON.stringify(input()), { mode: 0o600 });
  const operation = value.definitions.find(item => item.capability_id === 'text.generate').create_operation;
  await exec(process.execPath, ['packages/cli/src/main.mjs', 'invoke', operation, '--space-id', 'space-demo', '--input', file, '--idempotency-key', 'catalog-explicit', '--state-dir', path.join(directory, 'cli-state')], { cwd: root, env: stack.env });
  await until(async () => (await stack.request(base + '/text-generations/by-key/catalog-explicit')).value.status === 'succeeded'); assert.equal(calls.length, 1);
  stack.env.LIMEIOT_TEXT_URL = 'http://127.0.0.1:1'; await stack.restartGateway();
  const unavailable = check((await stack.request(resource)).value);
  assert.equal(unavailable.health.find(item => item.capability_id === 'text.generate').status, 'unknown');
  assert.notEqual(unavailable.deployments.find(item => item.capability_id === 'text.generate').identity.revision, value.deployments.find(item => item.capability_id === 'text.generate').identity.revision);
  await stack.request(base + '/text-generations', post(input(), 'catalog-unavailable'));
  const failed = await until(async () => { const r = await stack.request(base + '/text-generations/by-key/catalog-unavailable'); return r.value.status !== 'running' && r.value; });
  assert.equal(failed.status, 'unknown'); assert.equal(failed.error_code, 'text_provider_unknown');
  await until(async () => (await stack.request(base + '/devices/device-lamp')).value.ready);
  const lamp = (await stack.request(base + '/devices/device-lamp')).value;
  const command = await stack.request(base + '/commands', post({ device_id: 'device-lamp', model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 8000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'catalog-manual-lamp'));
  assert.equal(command.status, 202); await until(async () => (await stack.request(base + '/commands/' + command.value.command_id)).value.status === 'confirmed');
  delete stack.env.LIMEIOT_TEXT_MODEL; delete stack.env.LIMEIOT_TEXT_URL; delete stack.env.LIMEIOT_TEXT_CA_FILE; await stack.restartGateway();
  const removed = check((await stack.request(resource)).value);
  assert.equal(removed.deployments.some(item => item.capability_id === 'text.generate'), false);
  assert.equal(removed.health.find(item => item.capability_id === 'text.generate').status, 'not_configured');
  assert.equal(calls.length, 1); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'ai-catalog-result.json'), JSON.stringify({ passed: true, real_gateway: true, real_mqtt: true, real_sqlite: true, cli_discovery_to_explicit_generation: true, configured_capabilities: 5, rejected_corruptions: invalid.length, discovery_provider_calls: 0, explicit_provider_calls: 1, restarts: 3, unreachable_provider_manual_command: 'confirmed', provider_fixture: true, real_model_quality: false, native_app_runtime: false, nas_image_rebuilt: false, hardware: false, published: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'ai-catalog-result.json') }));
});

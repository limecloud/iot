import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { textStack, base, post } from './helpers/text.mjs';
import { verifyAiCatalog } from '../packages/protocol/ai-catalog.mjs';

const exec = promisify(execFile);
test('原生目录共享向量与正式Schema和JavaScript消费者一致', async () => {
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/ai-catalog/contract.json')));
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/ai-catalog.schema.json')));
  assert.deepEqual(fixture.configured.definitions, schema.properties.definitions.const);
  for (const name of ['configured', 'unconfigured']) verifyAiCatalog(fixture[name], 'space-demo');
  for (const vector of Object.values(fixture.invalid)) {
    const changed = structuredClone(fixture.configured); let parent = changed;
    for (const key of vector.path.slice(0, -1)) parent = parent[key]; parent[vector.path.at(-1)] = vector.value;
    assert.throws(() => verifyAiCatalog(changed, 'space-demo'), /invalid_ai_catalog/);
  }
});

for (const target of ['ios', 'android']) test(`${target}实际状态层：发现五能力、网关重启撤回、零推理及明确灯控`, { timeout: 180000 }, async t => {
  const s = await textStack(t), env = s.stack.env;
  for (const [kind, model] of [['ASR', 'fixture/asr'], ['TTS', 'fixture/tts'], ['VISION', 'fixture:vision'], ['OLLAMA', 'fixture:rules']]) {
    env[`LIMEIOT_${kind}_MODEL`] = model; env[`LIMEIOT_${kind}_URL`] = env.LIMEIOT_TEXT_URL;
  }
  env.LIMEIOT_TTS_VOICES = 'local'; await s.stack.restartGateway();
  async function native(phase, configured) {
    const traceFile = path.join(s.directory, `${target}-${phase}-trace.json`);
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
    const command = target === 'ios' ? path.join(root, '.dev/ai-catalog-native/ios-ai-catalog-checks') : java;
    const args = target === 'ios' ? [] : ['-cp', await readFile(path.join(root, '.dev/ai-catalog-native/android-classpath.txt'), 'utf8'), 'run.limeai.iot.AiCatalogLive'];
    try {
      const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env: { ...env, LIMEIOT_AI_NATIVE_TRACE: traceFile }, timeout: 60000, maxBuffer: 1024 * 1024 });
      await writeFile(path.join(s.directory, `${target}-${phase}.log`), result.stdout + result.stderr);
    } catch (error) { await writeFile(path.join(s.directory, `${target}-${phase}.log`), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.host_ui_state, true); assert.equal(trace.cleared_after_pause, true);
    assert.equal(trace.discovery_gets, 1); assert.equal(trace.business_posts, 0);
    const catalog = verifyAiCatalog(trace.catalog, 'space-demo'); assert.equal(catalog.deployments.length, configured ? 5 : 0);
    assert.deepEqual(catalog, (await s.stack.request(base + '/ai-catalog')).value);
    assert.deepEqual(s.calls, []); assert.deepEqual(s.errors, []);
    assert.equal((await s.stack.request(base + '/commands')).value.items.length, 0);
    assert.equal((await s.stack.request(base + '/media')).value.grants.length, 0);
  }
  await native('configured', true);
  for (const kind of ['ASR', 'TTS', 'VISION', 'OLLAMA', 'TEXT']) for (const suffix of ['MODEL', 'URL', 'CA_FILE']) delete env[`LIMEIOT_${kind}_${suffix}`];
  delete env.LIMEIOT_TTS_VOICES;
  await s.stack.restartGateway(); await native('removed', false);
  await until(async () => (await s.stack.request(base + '/devices/device-lamp')).value.ready);
  const lamp = (await s.stack.request(base + '/devices/device-lamp')).value;
  const response = await s.stack.request(base + '/commands', post({ device_id: 'device-lamp', model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 8000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'native-catalog-manual'));
  assert.equal(response.status, 202);
  await until(async () => (await s.stack.request(base + '/commands/' + response.value.command_id)).value.status === 'confirmed');
  assert.deepEqual(s.calls, []); assert.deepEqual(s.errors, []);
  const report = { passed: true, target, host_ui_state: true, real_rust_gateway: true, real_sqlite: true, real_mqtt: true, native_processes: 2, gateway_restarts: 2, configured_capabilities: 5, removed_capabilities: 5, discovery_provider_calls: 0, discovery_business_posts: 0, explicit_manual_command: 'confirmed', no_implicit_authorization_or_play: true, provider_fixture: true, native_app_runtime: false, hardware: false, full_goal_completed: false };
  const file = path.join(s.directory, 'ai-catalog-native-result.json'); await writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: file }));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, startStack, stop, until } from '../tools/dev-stack.mjs';
import { createAdbFixture } from './helpers/android-tv.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const post = (input, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
async function lines(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('网页到受限假ADB：先耐久提交、MQTT不双发、丢响应及重启不重放、Broker离线仍可执行', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/tv-adapter-'));
  const state = path.join(directory, 'adb-state'); await mkdir(state, { mode: 0o700 });
  const binary = await createAdbFixture(state);
  const database = path.join(directory, 'gateway.sqlite');
  async function scenario(change = {}) {
    await writeFile(path.join(state, 'scenario.next.json'), JSON.stringify({ database, ...change }));
    await rename(path.join(state, 'scenario.next.json'), path.join(state, 'scenario.json'));
  }
  await scenario();
  const adapterConfig = {
    schema_version: 1, adb_path: binary, state_directory: state, server_port: 5049,
    target: '192.168.31.94:5555', fingerprint: 'Xiaomi/xmen/xmen:6.0.1/MHC19J/2061:user/release-keys',
    device_serial: 'sample-tv-001', applications: [{ application_id: 'com.example.player', category: 'leanback' }], timeout_ms: 3000,
  };
  const route = { adapter_id: 'tv-adb', revision: await documentDigest(adapterConfig) };
  const modelPath = path.join(root, 'contracts/models/android-tv-remote.json');
  const report = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'model', 'validate', '--input', modelPath], {
    cwd: root, env: { ...process.env, LIMEIOT_MODEL_VALIDATOR: path.join(root, 'target/debug/limeiot-model-validator') }, timeout: 5000,
  })).stdout); assert.equal(report.valid, true);
  const config = JSON.parse(await readFile(path.join(root, 'deploy/dev/config.json'), 'utf8'));
  config.models[0] = report.normalized_model;
  config.devices[0].model_revision = report.model_revision;
  config.devices[0].routes = { 'remote.press': route, 'apps.launch': route };
  const configPath = path.join(directory, 'config.json'), tvPath = path.join(directory, 'tv.json');
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(tvPath, JSON.stringify({ schema_version: 1, bindings: [{ device_id: 'device-lamp', adapter_id: 'tv-adb', config: adapterConfig }] }));
  const stack = await startStack({ directory, modelPaths: { lamp: modelPath }, gatewayEnv: { LIMEIOT_CONFIG: configPath, LIMEIOT_TV_CONFIG: tvPath } });
  t.after(() => stack.close());
  await stop(stack.lamp);
  const mqtt = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'device-lamp', password: stack.env.LIMEIOT_MQTT_PASSWORD });
  t.after(() => mqtt.close()); await mqtt.subscribe('limeiot/v1/space-demo/device-lamp/down/+');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); page.setDefaultTimeout(12000);
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const tv = page.getByRole('article', { name: '电视', exact: true });
  await expect(tv.getByRole('group', { name: '遥控器' })).toBeVisible();
  await tv.getByRole('button', { name: '主页', exact: true }).click();
  await expect(tv.getByText('最近操作：输入已提交', { exact: true })).toBeVisible();
  await tv.getByLabel('应用标识', { exact: true }).fill('com.example.player');
  await tv.getByRole('button', { name: '启动应用', exact: true }).click();
  await expect.poll(async () => (await lines(path.join(state, 'effects.jsonl'))).length).toBe(2);
  await until(async () => (await stack.request(base + '/commands')).value.items.every(command => command.status === 'confirmed'));
  await assert.rejects(mqtt.message(150), /mqtt_packet_timeout/);
  const device = (await stack.request(base + '/devices/device-lamp')).value;
  assert.deepEqual(device.reported, {});
  const makeInput = (value = { key: 'home' }, operationPath = 'remote.press') => ({
    device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 8000).toISOString(),
    operation: { type: 'action.invoke', path: operationPath, value },
  });
  // 服务端已经受理但客户端丢失响应，恢复只能查原操作。
  let lost;
  await page.route('**' + base + '/commands', async handler => {
    if (handler.request().method() !== 'POST') { await handler.continue(); return; }
    lost = handler.request().postDataJSON(); await handler.fetch(); await handler.abort('failed');
    await page.unroute('**' + base + '/commands');
  });
  await tv.getByRole('button', { name: '返回', exact: true }).click();
  await expect.poll(() => lost?.operation.path).toBe('remote.press');
  await expect(page.getByText('操作结果尚未确认，请查询原操作', { exact: true })).toBeVisible();
  await page.reload(); await tv.getByRole('button', { name: '查询原操作', exact: true }).click();
  await expect(tv.getByRole('button', { name: '查询原操作', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await lines(path.join(state, 'effects.jsonl'))).length).toBe(3);
  assert.deepEqual(lost.operation.value, { key: 'back' });
  const forbidden = await stack.request(base + '/commands', post(makeInput({ application_id: 'com.android.settings' }, 'apps.launch'), 'forbidden-app'));
  assert.equal(forbidden.status, 202);
  await until(async () => (await stack.request(base + '/commands/' + forbidden.value.command_id)).value.status === 'failed');
  assert.equal((await lines(path.join(state, 'effects.jsonl'))).length, 3);
  // 假进程记录副作用后阻塞，重启网关时丢失回执，原操作必须保持未知。
  await scenario({ fault: 'timeout' });
  const interrupted = await stack.request(base + '/commands', post(makeInput(), 'interrupted-key'));
  assert.equal(interrupted.status, 202);
  await until(async () => (await lines(path.join(state, 'effects.jsonl'))).length === 4);
  await stack.restartGateway(); await scenario();
  const recovered = (await stack.request(base + '/commands/by-key/interrupted-key')).value;
  assert.equal(recovered.command_id, interrupted.value.command_id); assert.equal(recovered.status, 'unknown');
  await until(async () => (await stack.request(base + '/devices/device-lamp')).value.ready);
  assert.equal((await lines(path.join(state, 'effects.jsonl'))).length, 4);
  await assert.rejects(mqtt.message(150), /mqtt_packet_timeout/);
  // Broker断开只使原生MQTT路径离线，已获准ADB绑定继续工作。
  mqtt.close(); await stop(stack.broker);
  await until(async () => !(await stack.request('/healthz')).value.broker_connected);
  const offline = await stack.request(base + '/commands', post(makeInput(), 'broker-offline'));
  assert.equal(offline.status, 202);
  await until(async () => (await stack.request(base + '/commands/' + offline.value.command_id)).value.status === 'confirmed');
  assert.equal((await lines(path.join(state, 'effects.jsonl'))).length, 5);
  assert.equal((await stack.request(base + '/commands/' + interrupted.value.command_id)).value.status, 'unknown');
  const durable = await lines(path.join(state, 'durable.jsonl'));
  assert.equal(durable.length, 5);
  for (const proof of durable) { assert.equal(proof.version, 7); assert.equal(proof.command.status, 'dispatched'); assert.deepEqual(proof.command.execution_route, route); }
  await page.screenshot({ path: path.join(directory, 'tv-remote-mobile.png'), fullPage: true });
  await writeFile(path.join(directory, 'tv-adapter-result.json'), JSON.stringify({
    passed: true, real_http: true, real_sqlite: true, real_mqtt: true, fake_adb: true, browser: true,
    empty_properties_model: true, durable_before_side_effect: true, mqtt_action_messages: 0, adapter_effects: 5,
    forbidden_app_zero_effects: true, original_request_recovery: true, restart_unknown_no_replay: true,
    broker_independent: true, snapshot_version: 7, hardware: false, native_app_runtime: false, physical_exactly_once: false,
  }));
});

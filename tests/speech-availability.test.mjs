import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { root, startStack, until, freePort } from '../tools/dev-stack.mjs';

const base = '/api/v1/spaces/space-demo';
const post = (input, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(input) });

test('语音服务离线冷启动、计算挂起和重启均不阻塞本地MQTT控制及已部署联动', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/speech-availability-'));
  const providerPort = await freePort(), mediaPort = await freePort();
  let providerCalls = 0;
  const provider = http.createServer(async request => {
    for await (const _chunk of request) { /* 只消费请求，不记录正文，不返回计算结果。 */ }
    providerCalls++;
  });
  const stopProvider = async () => {
    provider.closeAllConnections();
    if (provider.listening) await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  };
  t.after(stopProvider);
  // 提供方尚未监听：验证真实网关不会在启动时等待推理服务。
  const stack = await startStack({ directory, gatewayEnv: {
    LIMEIOT_TTS_URL: `http://127.0.0.1:${providerPort}`,
    LIMEIOT_TTS_MODEL: 'fixture/availability', LIMEIOT_TTS_VOICES: 'local', LIMEIOT_TTS_CA_FILE: '',
    LIMEIOT_MEDIA_LISTEN: `127.0.0.1:${mediaPort}`, LIMEIOT_MEDIA_ORIGIN: `http://127.0.0.1:${mediaPort}`,
  } });
  t.after(() => stack.close());
  assert.equal((await stack.request('/healthz')).value.broker_connected, true);
  assert.equal((await stack.request(base + '/capabilities')).value.speech.configured, true);
  const lamp = (await stack.request(base + '/devices/device-lamp')).value;
  const control = async (key, value) => {
    const created = await stack.request(base + '/commands', post({ device_id: lamp.device_id, model_revision: lamp.model_revision,
      expires_at: new Date(Date.now() + 8000).toISOString(), operation: { type: 'property.set', path: 'light.brightness', value } }, key));
    assert.equal(created.status, 202);
    const confirmed = await until(async () => {
      const command = (await stack.request(base + '/commands/' + created.value.command_id)).value;
      return command.status === 'confirmed' && command;
    });
    assert.equal(confirmed.evidence.type, 'device_result');
    return confirmed.command_id;
  };
  const input = text => ({ text, voice: 'local', retain_seconds: 600, expires_at: new Date(Date.now() + 60000).toISOString() });
  const resolve = async key => (await stack.request(base + '/speech-syntheses/by-key/' + key)).value;
  const terminal = key => until(async () => { const task = await resolve(key); return task.status !== 'running' && task; });
  const coldControl = await control('cold-local-control', 23);
  const offlineInput = input('提供方离线时，本地控制仍可使用。');
  assert.equal((await stack.request(base + '/speech-syntheses', post(offlineInput, 'offline'))).status, 202);
  const offline = await terminal('offline');
  assert.equal(offline.status, 'unknown'); assert.equal(offline.error_code, 'speech_provider_unknown');
  assert.equal((await stack.request(base + '/speech-syntheses', post(input('不能绕过原未知任务'), 'offline-busy'))).status, 429);

  const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-light.json'), 'utf8'));
  rule.id = 'speech-independent-light'; rule.cooldown_ms = 0;
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  const runs = new Set();
  const trigger = async eventID => {
    stack.button.stdin.write(JSON.stringify({ event_id: eventID, occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } }) + '\n');
    const run = await until(async () => (await stack.request(base + '/runs')).value.items.find(item => item.event_id === eventID && !runs.has(item.run_id)));
    runs.add(run.run_id); assert.equal(run.error, null); assert.equal(run.command_ids.length, 1);
    const confirmed = await until(async () => {
      const command = (await stack.request(base + '/commands/' + run.command_ids[0])).value;
      return command.status === 'confirmed' && command;
    });
    assert.equal(confirmed.evidence.type, 'device_result');
    return run.run_id;
  };
  const offlineRule = await trigger('provider-offline-event');
  await stack.restartGateway();
  await until(async () => (await stack.request(base + '/devices')).value.items.every(device => device.ready));
  assert.equal((await resolve('offline')).synthesis_id, offline.synthesis_id);
  assert.equal((await resolve('offline')).status, 'unknown');

  await new Promise((resolve, reject) => provider.once('error', reject).listen(providerPort, '127.0.0.1', resolve));
  // 提供方恢复可达后，原查询和同键POST仍只观察原任务。
  assert.equal((await stack.request(base + '/speech-syntheses', post(offlineInput, 'offline'))).value.synthesis_id, offline.synthesis_id);
  await resolve('offline'); await delay(300); assert.equal(providerCalls, 0);
  assert.equal((await stack.request(base + '/speech-syntheses/by-key/offline/discard', post({}, 'discard-offline'))).value.status, 'discarded');
  const heldInput = input('计算挂起时，设备联动仍独立执行。');
  assert.equal((await stack.request(base + '/speech-syntheses', post(heldInput, 'held'))).status, 202);
  await until(() => providerCalls === 1);
  assert.equal((await resolve('held')).status, 'running');
  const heldControl = await control('held-local-control', 47);
  const heldRule = await trigger('provider-held-event');
  assert.equal((await resolve('held')).status, 'running');
  await stopProvider();
  const interrupted = await terminal('held');
  assert.equal(interrupted.status, 'unknown'); assert.equal(interrupted.error_code, 'speech_provider_unknown');
  await stack.restartGateway();
  await until(async () => (await stack.request(base + '/devices')).value.items.every(device => device.ready));
  assert.equal((await resolve('held')).synthesis_id, interrupted.synthesis_id);
  assert.equal((await stack.request(base + '/speech-syntheses', post(heldInput, 'held'))).value.status, 'unknown');
  assert.equal((await stack.request(base + '/speech-syntheses', post(input('重启后未知仍占用'), 'restart-busy'))).status, 429);
  const restartedControl = await control('restarted-local-control', 71);
  const restartedRule = await trigger('provider-stopped-after-restart-event');
  assert.equal((await stack.request(base + '/commands/' + coldControl)).value.status, 'confirmed');
  assert.equal(providerCalls, 1); assert.equal((await stack.request(base + '/media')).value.items.length, 0);
  const report = { passed: true, real_http: true, real_sqlite: true, real_mqtt: true,
    provider_offline_cold_start: true, provider_held_local_control: true, deployed_rule_survives_provider_failure_and_gateway_restart: true,
    command_ids: [coldControl, heldControl, restartedControl], run_ids: [offlineRule, heldRule, restartedRule],
    gateway_restarts: 2, provider_calls: providerCalls, recovered_provider_original_get_and_post_no_resynthesis: true,
    unknown_budget_retained: true, no_generated_media: true, simulated_provider: true, simulated_devices: true,
    nas_image_rebuilt: false, container_runtime: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  await writeFile(path.join(directory, 'speech-availability-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'speech-availability-result.json') }));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack, stop, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const vectorPath = path.join(root, 'contracts/examples/ota-firmware.json');
const vector = JSON.parse(await readFile(vectorPath, 'utf8'));
const state = process.env.LIMEIOT_OTA_STATE_CHECK === '1';
for (const target of ['ios', 'android']) test(`${target} OTA${state ? '页面状态' : '库'}：本地会话、明确计划/批准/执行，丢响应和网关重启只读恢复`, { timeout: 240000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close()); await stop(stack.lamp);
  const device = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'device-lamp', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => device.close());
  const topic = 'limeiot/v1/space-demo/device-lamp'; await device.subscribe(topic + '/down/+');
  let seq = 0, boot, session, install, query, checkpointError;
  async function publish(kind, body) {
    await device.publish(topic + '/up/' + kind, JSON.stringify({ v: 1, kind, message_id: randomUUID(), device_id: 'device-lamp', model_revision: vector.request.device.model_revision, boot_id: boot, session_id: session, seq: ++seq, body }));
  }
  async function handshake() {
    seq = 0; boot = randomUUID(); session = null; await publish('hello', { challenge: 'ota-native-challenge' });
    const welcome = JSON.parse((await device.message()).payload); assert.equal(welcome.kind, 'welcome'); session = welcome.session_id;
    await publish('state', { type: 'snapshot', revision: 1, properties: [
      { path: 'light.power', value: false, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-native-fixture' },
      { path: 'light.brightness', value: 0, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-native-fixture' },
    ] });
    await publish('device_info', vector.request.device);
    await until(async () => (await stack.request(base + '/devices/device-lamp')).value.device_info?.fresh);
  }
  await handshake();
  const reports = setInterval(() => { if (session) void publish('device_info', vector.request.device).catch(() => {}); }, 700); t.after(() => clearInterval(reports));
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/approved') { assert.equal(install, undefined); await assert.rejects(device.message(150), /mqtt_packet_timeout/); }
      else if (req.url === '/restart') {
        install = JSON.parse((await device.message()).payload); assert.equal(install.kind, 'ota_install');
        await assert.rejects(device.message(150), /mqtt_packet_timeout/);
        session = null; await stack.restartGateway(); await handshake();
      } else if (req.url === '/complete') {
        query = JSON.parse((await device.message()).payload); assert.equal(query.kind, 'ota_query'); assert.equal(query.body.request_digest, await documentDigest(install)); assert.equal(query.body.manifest, undefined);
        await publish('ota_result', { task_id: install.body.task_id, execution_id: install.body.execution_id, request_digest: await documentDigest(install), manifest_digest: install.body.manifest_digest, status: 'succeeded', firmware_version: vector.request.manifest.statement.version, security_epoch: vector.request.manifest.statement.security_epoch, image_sha256: vector.request.manifest.statement.sha256, pending_update: false, error: null });
      } else throw new Error('unknown_checkpoint');
      res.writeHead(200); res.end('{}');
    } catch (error) { checkpointError = error; res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const tracePath = path.join(stack.directory, target + '-ota-trace.json');
  const env = { ...stack.env, LIMEIOT_OTA_CHECK: '1', LIMEIOT_OTA_VECTOR: vectorPath, LIMEIOT_OTA_TRACE: tracePath, LIMEIOT_OTA_FIXTURE: `http://127.0.0.1:${server.address().port}` };
  const args = target === 'ios' ? (state ? [] : ['run', 'ClientChecks']) : (state ? ['gradlew', '--no-daemon', ':app:testDebugUnitTest', '--rerun', '--tests', 'run.limeai.iot.FirmwareControllerTest'] : ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', 'run.limeai.iot.core.OtaClientTest', '--tests', 'run.limeai.iot.core.OtaIntegrationTest', '--rerun-tasks']);
  let result;
  try { result = await exec(target === 'ios' ? (state ? path.join(root, '.dev/ota-native-state/ios-firmware-checks') : 'swift') : 'sh', args, { cwd: path.join(root, 'apps', target), env, timeout: 210000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) { await writeFile(path.join(stack.directory, target + '-ota.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); if (checkpointError) throw checkpointError; throw error; }
  await writeFile(path.join(stack.directory, target + '-ota.log'), result.stdout + result.stderr);
  if (checkpointError) throw checkpointError;
  const trace = JSON.parse(await readFile(tracePath, 'utf8')); assert.equal(trace.passed, true); assert.equal(trace.posts, 8); assert.equal(trace.original_records, 8);
  if (state) assert.equal(trace.host_ui_state, true);
  assert.ok(install); assert.ok(query); await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  const tasks = (await stack.request(base + '/ota-tasks')).value.items; assert.deepEqual(new Set(tasks.map(item => item.status)), new Set(['cancelled', 'succeeded']));
  assert.equal((await stack.request(base + '/firmware-trusts')).value.items[0].active, false);
  await writeFile(path.join(stack.directory, state ? 'ota-native-state-result.json' : 'ota-native-result.json'), JSON.stringify({ ...trace, target, real_http: true, real_mqtt: true, sqlite_restart: true, independent_firmware_trust: true, approval_without_install: true, response_loss: true, original_key_only: true, install_messages: 1, query_messages: 1, new_boot_fixture: true, device_installation: false }));
});

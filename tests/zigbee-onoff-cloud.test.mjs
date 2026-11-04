import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { root, until } from '../tools/dev-stack.mjs';
import { base, environmentStack } from './fixtures/zigbee/runtime.mjs';
import { cloudClient, fixture as cloudFixture, origin, post } from './helpers/control.mjs';

const execute = promisify(execFile);
test('隔离控制面经HTTPS/WSS控制Zigbee开关，确认投影、未知与双进程恢复', { timeout: 120000 }, async t => {
  assert.ok(process.env.LIMEIOT_TEST_CONTROL_CA_FILE, 'run through tools/test-control.mjs --property-bridge');
  const identityDirectory = await mkdtemp(path.join(root, '.dev/onoff-cloud-'));
  const keyFile = path.join(identityDirectory, 'identity.pk8');
  const binary = path.join(process.env.LIMEIOT_TEST_TARGET_DIR ?? path.join(root, 'target/debug'), 'limeiot-gateway');
  await execute(binary, ['identity-init', keyFile]);
  const dynamic = process.env.LIMEIOT_OBSERVATION_PROFILE === 'on_off';
  const { directory, stack, switchDevice, switchControl, stats, commands } = await environmentStack(t, 1, { dynamic, onOff: true, timeoutMs: 1000,
    gatewayEnv: { LIMEIOT_CONTROL_ALLOWED_ORIGINS: origin, LIMEIOT_GATEWAY_KEY_FILE: keyFile,
      LIMEIOT_CONTROL_CA_FILE: process.env.LIMEIOT_TEST_CONTROL_CA_FILE, LIMEIOT_CONTROL_RELAY_ENABLED: '1' } });
  if (dynamic) {
    const candidate = await stack.request(base + '/observation-candidates', post({ coordinator_id: 'home-znp', ieee_address: '1122334455667789', endpoint: 1, profile: 'on_off' }));
    assert.equal(candidate.status, 200);
    const before = (await stack.request(base + '/devices/zigbee-switch/observation-binding')).value;
    const operation = await stack.request(base + '/observation-operations', post({ type: 'sources.bind', device_id: 'zigbee-switch', source: candidate.value.source,
      expected_binding_revision: before.revision, expected_model_revision: candidate.value.model_revision }, 'cloud-dynamic-switch'));
    assert.equal(operation.value.status, 'applied'); assert.deepEqual(operation.value.result.binding.write_paths, ['light.power']);
    await until(async () => (await switchDevice()).ready);
  }
  const cloud = await cloudClient(), pair = await cloud.pair(), cloudBase = `/api/console/v1/spaces/${pair.pairing.space_id}`;
  const created = await stack.request(base + '/control-pairings', post({ control_origin: pair.control_origin, pairing_id: pair.pairing.pairing_id, code: pair.code }, 'onoff-cloud-pair'));
  assert.equal(created.status, 202, JSON.stringify(created.value));
  const here = async () => (await stack.request(base + '/control-pairings/' + created.value.link_id)).value;
  const review = await until(async () => { const value = await here(); return value.status === 'awaiting_approval' && value; });
  assert.equal((await stack.request(base + '/control-pairings/' + review.link_id + '/approve', post({ review_revision: review.review_revision }))).status, 202);
  const binding = (await until(async () => { const value = await here(); return value.status === 'active' && value; })).binding;
  const connected = () => until(async () => (await cloud.connection(binding)).connected, 15000);
  await connected();
  const device = (await cloud.call(cloudBase + '/devices')).items.find(value => value.device_id === 'zigbee-switch'); assert.ok(device?.ready);
  const input = (requestKey, duration = 5000) => ({ request_key: requestKey, gateway_id: binding.gateway_id, binding_revision: binding.revision,
    device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + duration).toISOString(),
    operation: { type: 'property.set', path: 'light.power', value: true } });
  const reconcile = id => cloud.call(cloudBase + '/remote-commands/' + id + '/reconcile', {});
  const create = request => cloud.call(cloudBase + '/remote-commands', request);
  const first = await create(input('onoff-cloud-confirmed'));
  const confirmed = await until(async () => { const value = await reconcile(first.remote_id); return value.status === 'confirmed' && value; });
  assert.deepEqual(confirmed.local_result.evidence, { type: 'device_result', reported: { 'light.power': true } });
  assert.equal((await commands())[0].evidence.type, 'property_observation_result');
  assert.deepEqual((await stats()).switch_commands, [true]);
  await switchControl('hold', false); await until(async () => (await switchDevice()).reported['light.power'].value === false);
  const lostInput = input('onoff-cloud-unknown', 2500), lost = await create(lostInput);
  await until(async () => (await commands()).some(command => command.request.idempotency_key === lost.remote_id && command.status === 'unknown'));
  const unknown = await reconcile(lost.remote_id); assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.local_result.evidence, null); assert.equal((await switchDevice()).reported['light.power'].value, false);
  assert.deepEqual((await stats()).switch_commands, [true, true]);
  await stack.restartGateway(); await until(async () => (await switchDevice()).ready); await connected();
  await cloudFixture({ restart_api: true }); await connected();
  const recovered = await cloud.call(cloudBase + '/remote-commands/by-key/' + lostInput.request_key);
  assert.equal(recovered.remote_id, lost.remote_id); assert.equal(recovered.status, 'unknown');
  assert.equal((await reconcile(lost.remote_id)).status, 'unknown');
  assert.deepEqual((await stats()).switch_commands, [true, true]); assert.deepEqual((await stats()).errors, []);
  const report = { passed: true, dynamic_switch: dynamic, real_https_wss_mysql: true, software_pty_ncp: true, confirmed_projection: true,
    internal_evidence_hidden: true, unknown_preserved: true, gateway_and_control_restart: true, no_replay: true,
    official_cloud_updated: false, published: false, hardware: false, full_goal_completed: false };
  const reportFile = path.join(directory, 'onoff-cloud-report.json');
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: reportFile }));
});

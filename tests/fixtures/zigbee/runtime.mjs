import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentDigest } from '../../../packages/protocol/model-validation.mjs';
import { root, startStack, stop, until } from '../../../tools/dev-stack.mjs';

export const base = '/api/v1/spaces/space-demo';
export const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const targets = ['1122334455667788', '1122334455667789'];
export const devices = ['zigbee-environment', 'zigbee-environment-2'];

export async function environmentStack(t, count = 1, { timeoutMs = 500, dynamic = false, onOff = false, gatewayEnv = {} } = {}) {
  assert.ok(count === 1 || count === 2);
  assert.ok(!onOff || count === 1);
  const directory = await mkdtemp(path.join(root, '.dev/zigbee-gateway-journey-'));
  const ncp = spawn('python3', [onOff ? 'tests/fixtures/zigbee/onoff_ncp.py' : 'tests/fixtures/zigbee/ncp.py', path.join(directory, 'ncp-requests.json')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stack, stderr = '', pending = '', sequence = 0;
  const messages = [];
  ncp.stderr.on('data', chunk => { stderr += chunk; });
  ncp.stdout.on('data', chunk => {
    pending += chunk;
    while (pending.includes('\n')) {
      const at = pending.indexOf('\n');
      messages.push(JSON.parse(pending.slice(0, at))); pending = pending.slice(at + 1);
    }
  });
  t.after(async () => {
    await stack?.close();
    ncp.stdin.end();
    await until(() => ncp.exitCode !== null || ncp.signalCode, 5000).catch(async () => stop(ncp));
    await writeFile(path.join(directory, 'ncp-stderr.log'), stderr);
    assert.equal(ncp.exitCode, 0, stderr);
  });
  const ready = await until(() => messages.find(value => value.type === 'ready'), 5000);
  const send = async (message, type) => {
    const id = ++sequence;
    ncp.stdin.write(JSON.stringify({ ...message, id }) + '\n');
    return until(() => messages.find(value => value.type === type && value.id === id), 5000);
  };
  const environment = JSON.parse(await readFile(path.join(root, 'contracts/models/environment.json'), 'utf8'));
  const modelRevision = await documentDigest(environment);
  const config = JSON.parse(await readFile(path.join(root, 'deploy/dev/config.json'), 'utf8'));
  if (!dynamic) {
    config.models.push(environment);
    config.devices.push(...devices.slice(0, count).map(device_id => ({ device_id, model_revision: modelRevision })));
  }
  const switchModel = onOff ? JSON.parse(await readFile(path.join(root, 'contracts/models/on-off-light.json'), 'utf8')) : null;
  const switchRevision = onOff ? await documentDigest(switchModel) : null;
  if (onOff && !dynamic) {
    config.models.push(switchModel);
    config.devices.push({ device_id: 'zigbee-switch', model_revision: switchRevision });
  }
  const configPath = path.join(directory, 'gateway.json'), sourcePath = path.join(directory, 'zigbee.json');
  await writeFile(configPath, JSON.stringify(config));
  const sourceConfig = dynamic ? {schema_version:2,bindings:[],coordinators:[{
    coordinator_id:'home-znp',serial:ready.serial,coordinator_ieee:'0102030405060708',timeout_ms:timeoutMs,poll_interval_ms:1000,
  }]} : { schema_version: 1, bindings: devices.slice(0, count).map((device_id, index) => ({
    device_id, adapter_id: index ? 'znp-environment-2' : 'znp-environment', model_revision: modelRevision,
    serial: ready.serial, target: { coordinator_ieee: '0102030405060708', ieee_address: targets[index], endpoint: 1 }, manufacturer_code: 4660,
    signature: { manufacturer: 'LimeIoT', model: 'Environment-1', application_version: 2, hardware_version: 1 }, timeout_ms: timeoutMs, poll_interval_ms: 1000,
  })) };
  if (onOff && !dynamic) {
    sourceConfig.schema_version = 3;
    sourceConfig.on_off_bindings = [{ device_id: 'zigbee-switch', adapter_id: 'znp-switch', model_revision: switchRevision,
      serial: ready.serial, target: { coordinator_ieee: '0102030405060708', ieee_address: targets[1], endpoint: 1 },
      manufacturer_code: 4660, signature: { manufacturer: 'LimeIoT', model: 'Switch-1', application_version: 2, hardware_version: 1 },
      timeout_ms: timeoutMs, poll_interval_ms: 1000 }];
  }
  await writeFile(sourcePath, JSON.stringify(sourceConfig));
  const target = process.env.LIMEIOT_TEST_TARGET_DIR ?? path.join(root, 'target/debug');
  stack = await startStack({ directory: path.join(directory, 'stack'), gatewayBinary: path.join(target, 'limeiot-gateway'), simulatorBinary: path.join(target, 'limeiot-simulator'),
    extraDeviceIds: dynamic ? [] : [...devices.slice(0, count), ...(onOff ? ['zigbee-switch'] : [])], gatewayEnv: { ...gatewayEnv, LIMEIOT_CONFIG: configPath, LIMEIOT_ZIGBEE_CONFIG: sourcePath } });
  return { directory, stack,
    sensor: async (index = 0) => (await stack.request(base + '/devices/' + devices[index])).value,
    commands: async () => (await stack.request(base + '/commands')).value.items,
    control: (temperature, mode = 'normal', index = 0) => send({ temperature, mode, device: targets[index] }, 'ack'),
    discovery: mode => send({ type: 'discovery', mode }, 'ack'),
    join: mode => send({ type: 'join', mode }, 'ack'),
    restoreFixtureTty: () => send({ type: 'restore-fixture-tty' }, 'ack'),
    stats: () => send({ type: 'inspect' }, 'stats'),
    switchDevice: async () => (await stack.request(base + '/devices/zigbee-switch')).value,
    switchControl: (mode, power) => send({ type: 'switch', mode, ...(power === undefined ? {} : { power }) }, 'ack'),
  };
}

export function thresholdRule(index = 0) {
  return { version: 1, id: `zigbee-warm-light-${index}`, trigger: { device: devices[index], property: {
    path: 'environment.temperature', unit: 'celsius_x100', edge: 'rising', threshold: 2800, hysteresis: 100 } },
    conditions: [{ device: devices[index], property: 'environment.humidity', unit: 'percent_x100', operator: 'gt', value: 4000 }],
    actions: [{ device: 'device-lamp', set: { path: 'light.brightness', value: index ? 40 : 30 } }], cooldown_ms: 0 };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root, startStack, until, binaryDirectory } from '../tools/dev-stack.mjs';
import { cloudClient, fixture, origin, post } from './helpers/control.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
test('真实WSS机器身份：受信CA、重启/断流重连、本地继续控制及两侧撤销', { timeout: 120000, skip: !process.env.LIMEIOT_TEST_CONTROL_CA_FILE }, async () => {
  const cloud = await cloudClient(), directory = path.join(root, '.dev', `relay-${randomBytes(8).toString('hex')}`);
  await mkdir(directory, { recursive: true }); const key = path.join(directory, 'identity.pk8');
  await exec(path.join(binaryDirectory, 'limeiot-gateway'), ['identity-init', key]);
  const ca = process.env.LIMEIOT_TEST_CONTROL_CA_FILE;
  const s = await startStack({ directory, gatewayEnv: { LIMEIOT_CONTROL_ALLOWED_ORIGINS: origin, LIMEIOT_GATEWAY_KEY_FILE: key, LIMEIOT_CONTROL_CA_FILE: ca, LIMEIOT_CONTROL_RELAY_ENABLED: '1' } });
  const state = async () => (await s.request(`${base}/control-pairings`)).value.connection;
  const local = async (id, status) => until(async () => { const r = (await s.request(`${base}/control-pairings/${id}`)).value; return r.status === status && r; });
  const connected = async binding => until(async () => {
    const [here, there] = await Promise.all([state(), cloud.connection(binding)]);
    return here.status === 'connected' && here.binding_revision === binding.revision && there.connected && there.binding_revision === binding.revision;
  }, 15000);
  async function pair(key) {
    const pair = await cloud.pair();
    const input = { control_origin: pair.control_origin, pairing_id: pair.pairing.pairing_id, code: pair.code };
    const created = await s.request(`${base}/control-pairings`, post(input, key)); assert.equal(created.status, 202);
    const review = await local(created.value.link_id, 'awaiting_approval');
    await s.request(`${base}/control-pairings/${review.link_id}/approve`, post({ review_revision: review.review_revision }));
    const bound = await local(review.link_id, 'active'); await connected(bound.binding); return { pair, bound };
  }
  try {
    assert.equal((await state()).status, 'unpaired');
    const before = await fixture(), first = await pair('relay-original'), binding = first.bound.binding;
    assert.equal((await fixture()).claims, before.claims + 1);
    const firstTime = (await cloud.connection(binding)).connected_at;
    await s.restartGateway(); await connected(binding);
    assert.notEqual((await cloud.connection(binding)).connected_at, firstTime);
    const seen = (await cloud.connection(binding)).last_seen_at;
    await until(async () => (await cloud.connection(binding)).last_seen_at > seen, 8000);
    assert.equal((await fixture()).claims, before.claims + 1);
    await fixture({ reject_relays: true, close_relays: true });
    await until(async () => (await state()).status === 'disconnected');
    await until(async () => !(await cloud.connection(binding)).connected);
    const lamp = await until(async () => { const value = (await s.request(`${base}/devices/device-lamp`)).value; return value.ready && value; });
    const command = await s.request(`${base}/commands`, post({ device_id: lamp.device_id, model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'local-without-relay'));
    assert.equal(command.status, 202, command.value.error?.code); await until(async () => (await s.request(`${base}/commands/${command.value.command_id}`)).value.status === 'confirmed');
    await fixture({}); await connected(binding);
    // 移除测试CA后，旧活动绑定也不能绕过TLS验证建立WSS。
    s.env.LIMEIOT_CONTROL_CA_FILE = ''; await s.restartGateway();
    await until(async () => (await state()).error === 'relay_unavailable');
    assert.equal((await cloud.connection(binding)).connected, false);
    s.env.LIMEIOT_CONTROL_CA_FILE = ca; await s.restartGateway(); await connected(binding);
    await s.request(`${base}/control-pairings/${first.bound.link_id}/revoke`, post({}));
    await until(async () => (await state()).status === 'unpaired');
    await until(async () => !(await cloud.connection(binding)).connected);
    assert.equal((await cloud.bindings(binding.space_id)).gateways[0].active, true);
    await cloud.revoke(binding);
    const second = await pair('relay-next'); assert.notEqual(second.bound.binding.revision, binding.revision);
    await cloud.revoke(second.bound.binding);
    await until(async () => (await state()).status !== 'connected');
    await s.request(`${base}/control-pairings/${second.bound.link_id}/reconcile`, post({})); await local(second.bound.link_id, 'revoked');
    await until(async () => (await state()).status === 'unpaired');
    await s.restartGateway(); assert.equal((await state()).status, 'unpaired');
    assert.equal((await fixture()).claims, before.claims + 2);
    assert.equal((await s.request(`${base}/commands`)).value.items.length, 1);
    for (const name of ['gateway.log', 'gateway.sqlite', 'gateway.sqlite-wal']) {
      const bytes = await readFile(path.join(directory, name)).catch(() => Buffer.alloc(0));
      assert.ok(!bytes.includes(Buffer.from(first.pair.code))); assert.ok(!bytes.includes(Buffer.from(second.pair.code)));
    }
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, real_wss: true, real_mysql: true, simulated_device: true, claims: 2, local_command: command.value.command_id, remote_commands: false }));
  } finally { await fixture({}); await s.close(); }
});

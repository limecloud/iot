import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack, freePort, stop, until } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const manager = path.join(root, 'deploy/nas/manage.py');
test('NAS 初始化、耐久备份、新目录恢复、凭据与损坏拒绝', { timeout: 45000 }, async t => {
  const directory = path.join(root, '.dev', `nas-test-${Date.now()}`);
  await exec('python3', [manager, 'init', '--directory', directory, '--origin', 'https://127.0.0.1:18443']);
  assert.deepEqual(await readdir(path.join(directory, 'firmware')), []);
  await writeFile(path.join(directory, 'firmware/backup-fixture.bin'), 'artifact-cache');
  assert.equal((await stat(path.join(directory, 'secrets/owner-token'))).mode & 0o777, 0o600);
  await exec('openssl', ['verify', '-CAfile', path.join(directory, 'authority/ca.crt'), '-verify_ip', '127.0.0.1', path.join(directory, 'tls/server.crt')]);
  const secret = async file => (await readFile(path.join(directory, 'secrets', file), 'utf8')).trim();
  const credentials = { owner: await secret('owner-token'), gateway: await secret('gateway-password'), lamp: await secret('device-lamp-password'), button: await secret('device-button-password') };
  assert.equal(new Set(Object.values(credentials)).size, 4);
  const issuer = path.join(root, 'deploy/nas/device_identity.py');
  const identity = JSON.parse((await exec('python3', [issuer, 'issue', '--directory', directory, '--device-id', 'device-lamp', '--output', `${directory}-identity`])).stdout);
  const stack = await startStack({ directory: path.join(directory, 'data'), credentials }); t.after(() => stack.close());
  const prefix = '/api/v1/spaces/space-demo';
  const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-light.json'), 'utf8'));
  const post = (input, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  assert.equal((await stack.request(`${prefix}/rule-deployments`, post(rule))).status, 200);
  stack.button.stdin.write(JSON.stringify({ data: { count: 1 } }) + '\n');
  const command = await until(async () => { const items = (await stack.request(`${prefix}/commands`)).value.items; return items.find(command => command.status === 'confirmed'); });
  await stop(stack.lamp);
  const lamp = (await stack.request(`${prefix}/devices/device-lamp`)).value;
  const uncertain = await stack.request(`${prefix}/commands`, post({ device_id: lamp.device_id, model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 1000).toISOString(), operation: { type: 'property.set', path: 'light.brightness', value: 41 } }, { 'Idempotency-Key': 'nas-unknown' }));
  assert.equal(uncertain.status, 202);
  await until(async () => (await stack.request(`${prefix}/commands/${uncertain.value.command_id}`)).value.status === 'unknown');
  const backup = `${directory}-backup`, restored = `${directory}-restored`;
  await exec('python3', [manager, 'backup', '--directory', directory, '--output', backup]);
  await exec('python3', [manager, 'restore', '--directory', restored, '--backup', backup]);
  assert.deepEqual(await readdir(path.join(restored, 'firmware')), ['backup-fixture.bin']);
  assert.equal(await readFile(path.join(restored, 'firmware/backup-fixture.bin'), 'utf8'), 'artifact-cache');
  assert.equal((await stat(path.join(restored, 'firmware'))).mode & 0o777, 0o700);
  await exec('python3', [issuer, 'revoke', '--directory', restored, '--serial', identity.serial]);
  await assert.rejects(exec('openssl', ['verify', '-crl_check', '-CRLfile', path.join(restored, 'broker-tls/revoked.crl'), '-CAfile', path.join(restored, 'device-authority/ca.crt'), `${directory}-identity/device.crt`]), /certificate revoked/);
  await exec('openssl', ['verify', '-crl_check', '-CRLfile', path.join(directory, 'broker-tls/revoked.crl'), '-CAfile', path.join(directory, 'device-authority/ca.crt'), `${directory}-identity/device.crt`]);
  await assert.rejects(exec('python3', [manager, 'restore', '--directory', restored, '--backup', backup]), /destination_must_be_empty/);
  await stop(stack.gateway);
  const apiPort = await freePort(), endpoint = `http://127.0.0.1:${apiPort}`;
  stack.gateway = stack.launch('restored-gateway', path.join(root, 'target/debug/limeiot-gateway'), [], {
    LIMEIOT_LISTEN: `127.0.0.1:${apiPort}`, LIMEIOT_PUBLIC_ORIGIN: endpoint,
    LIMEIOT_TOKEN: undefined, LIMEIOT_TOKEN_FILE: path.join(restored, 'secrets/owner-token'),
    LIMEIOT_DB: path.join(restored, 'data/gateway.sqlite'), LIMEIOT_CONFIG: path.join(restored, 'config/gateway.json'),
  });
  const request = async resource => { const response = await fetch(endpoint + resource, { headers: { Authorization: `Bearer ${credentials.owner}` }, signal: AbortSignal.timeout(2000) }); return response.json(); };
  await until(async () => (await request('/healthz')).broker_connected);
  assert.equal((await request(`${prefix}/commands/${command.command_id}`)).status, 'confirmed');
  assert.equal((await request(`${prefix}/commands/${uncertain.value.command_id}`)).status, 'unknown');
  assert.equal((await request(`${prefix}/commands/by-key/nas-unknown`)).command_id, uncertain.value.command_id);
  assert.equal((await request(`${prefix}/runs`)).items[0].command_ids[0], command.command_id);
  assert.equal((await request(`${prefix}/rule-deployments`)).items[0].rule.id, rule.id);
  const manifest = JSON.parse(await readFile(path.join(backup, 'backup.json'), 'utf8'));
  manifest.files['data/gateway.sqlite'] = 'corrupt';
  await writeFile(path.join(backup, 'backup.json'), JSON.stringify(manifest));
  await assert.rejects(exec('python3', [manager, 'restore', '--directory', `${directory}-corrupt`, '--backup', backup]), /invalid_backup/);
});

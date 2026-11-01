import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
test('离线 NVS 配置验证证书身份、私钥、用途、权限和固定分区尺寸', { timeout: 30000 }, async () => {
  const directory = path.join(root, '.dev', `provision-test-${Date.now()}`);
  await exec('python3', [path.join(root, 'deploy/nas/manage.py'), 'init', '--directory', directory, '--origin', 'https://127.0.0.1:18443']);
  for (const role of ['lamp', 'button']) await exec('python3', [path.join(root, 'deploy/nas/device_identity.py'), 'issue', '--directory', directory, '--device-id', `device-${role}`, '--output', path.join(directory, role)]);
  const config = { space_id: 'space-demo', device_id: 'device-lamp', hardware_rev: 'test-fixture', wifi: { ssid: 'LimeIoT test', password: 'test-password-for-nvs' }, broker: { host: '127.0.0.1', port: 8883 }, identity: { ca: 'lamp/ca.crt', certificate: 'lamp/device.crt', private_key: 'lamp/private.key' } };
  const python = process.env.LIMEIOT_FIRMWARE_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
  const filename = path.join(directory, 'configuration.json');
  const generate = async (input, name) => {
    await writeFile(filename, JSON.stringify(input), { mode: 0o600 });
    return JSON.parse((await exec(python, [path.join(root, 'firmware/tools/provision.py'), '--config', filename, '--output', path.join(directory, name)])).stdout);
  };
  const generated = await generate(config, 'valid');
  assert.equal(generated.encrypted, false); assert.equal(generated.offset, '0x9000');
  assert.equal((await stat(generated.image)).size, 0x6000);
  assert.equal((await stat(generated.image)).mode & 0o777, 0o600);
  const image = await readFile(generated.image);
  assert.ok(image.includes(Buffer.from('li-config')));
  assert.ok(image.includes(Buffer.from(config.device_id)));
  const rejected = async (mutate, name, code) => { const input = structuredClone(config); mutate(input); await assert.rejects(generate(input, name), error => JSON.parse(error.stdout).error === code); };
  await rejected(input => { input.device_id = 'device-button'; }, 'wrong-id', 'certificate_device_id_mismatch');
  await rejected(input => { input.identity.private_key = 'button/private.key'; }, 'wrong-key', 'certificate_private_key_mismatch');
  await rejected(input => { input.identity.ca = 'authority/ca.crt'; }, 'wrong-ca', 'provisioning_validation_or_generation_failed');
  await rejected(input => { input.identity.ca = 'broker-tls/ca.crt'; input.identity.certificate = 'broker-tls/server.crt'; input.identity.private_key = 'broker-tls/server.key'; }, 'server-identity', 'provisioning_validation_or_generation_failed');
  await rejected(input => { input.broker.host = 'https://127.0.0.1'; }, 'invalid-host', 'invalid_broker_hostname');
  await rejected(input => { input.wifi.password = 'short'; }, 'invalid-password', 'invalid_configuration_string');
  await assert.rejects(generate(config, 'valid'), error => JSON.parse(error.stdout).error === 'provisioning_validation_or_generation_failed');
  assert.equal((await stat(generated.image)).size, 0x6000);
});

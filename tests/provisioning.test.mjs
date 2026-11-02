import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
  assert.equal(generated.ota_signing_key_configured, false);
  assert.equal(generated.ota_policy_configured, false);
  assert.equal(generated.ota_https_trust_configured, false);
  const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
  const withKey = { ...config, ota_signing_key: { public_key: vector.request.trust.public_key, signing_key_id: vector.request.trust.signing_key_id } };
  const anchored = await generate(withKey, 'firmware-key');
  assert.equal(anchored.ota_signing_key_configured, true);
  assert.equal(anchored.ota_policy_configured, false);
  const anchoredImage = await readFile(anchored.image);
  assert.ok(anchoredImage.includes(Buffer.from('ota_public_key')));
  assert.ok(anchoredImage.includes(Buffer.from('ota_key_id')));
  const anchoredCSV = await readFile(path.join(path.dirname(anchored.image), 'configuration.csv'), 'utf8');
  assert.ok(anchoredCSV.includes(withKey.ota_signing_key.signing_key_id));
  const policyOnly = { ...config, ota_policy: vector.request.trust };
  const configured = await generate(policyOnly, 'firmware-policy');
  assert.equal(configured.ota_signing_key_configured, true); assert.equal(configured.ota_policy_configured, true);
  const policyPath = path.join(path.dirname(configured.image), 'ota-policy.json');
  assert.deepEqual(JSON.parse(await readFile(policyPath, 'utf8')), vector.request.trust);
  assert.equal((await stat(policyPath)).mode & 0o777, 0o600);
  const withBoth = await generate({ ...withKey, ota_policy: vector.request.trust }, 'firmware-key-and-policy');
  assert.equal(withBoth.ota_policy_configured, true);
  const transportConfig = { ...policyOnly, ota_transport: { ca: 'broker-tls/ca.crt' } };
  const withTransport = await generate(transportConfig, 'firmware-https-transport');
  assert.equal(withTransport.ota_https_trust_configured, true);
  const caPath = path.join(path.dirname(withTransport.image), 'ota-https-ca.pem');
  assert.equal(await readFile(caPath, 'utf8'), await readFile(path.join(directory, 'broker-tls/ca.crt'), 'utf8'));
  assert.equal((await stat(caPath)).mode & 0o777, 0o600);
  const caCSV = await readFile(path.join(path.dirname(withTransport.image), 'configuration.csv'), 'utf8');
  assert.ok(caCSV.includes('ota_ca_ver,data,u8,1'));
  assert.ok(caCSV.includes('ota_https_ca,file,string,'));
  assert.equal(configured.ota_https_trust_configured, false, '完整策略不能隐式继承MQTT的CA');
  const maximum = structuredClone(vector.request.trust);
  maximum.revoked_artifact_ids = Array.from({ length: 128 }, (_, i) => 'artifact-'+i.toString(16).padStart(64, '0'));
  const multipage = await generate({ ...config, ota_policy: maximum }, 'firmware-policy-multipage');
  const maximumPath = path.join(path.dirname(multipage.image), 'ota-policy.json');
  assert.ok((await stat(maximumPath)).size > 3999);
  assert.equal((await stat(multipage.image)).size, 0x6000);
  for (const result of [configured, withBoth, multipage]) {
    const csv = await readFile(path.join(path.dirname(result.image), 'configuration.csv'), 'utf8');
    assert.ok(csv.includes('ota_policy_ver,data,u8,1'));
    assert.ok(csv.includes('ota_policy,file,binary,'));
  }
  const combined = await generate({ ...config, ota_policy: maximum, ota_transport: transportConfig.ota_transport }, 'firmware-maximum-with-https');
  assert.equal(combined.ota_https_trust_configured, true);
  assert.equal((await stat(combined.image)).size, 0x6000);
  await writeFile(path.join(root, '.dev/ota-config-provisioning.json'), JSON.stringify({ cases: [configured, withBoth, multipage, withTransport, combined].map(result => ({ image: result.image, policy: path.join(path.dirname(result.image), 'ota-policy.json'), ota_https_ca: result.ota_https_trust_configured ? path.join(path.dirname(result.image), 'ota-https-ca.pem') : null })) }, null, 2));
  const rejected = async (mutate, name, code) => { const input = structuredClone(config); mutate(input); await assert.rejects(generate(input, name), error => JSON.parse(error.stdout).error === code); await assert.rejects(stat(path.join(directory, name)), { code: 'ENOENT' }); };
  await rejected(input => { input.device_id = 'device-button'; }, 'wrong-id', 'certificate_device_id_mismatch');
  await rejected(input => { input.identity.private_key = 'button/private.key'; }, 'wrong-key', 'certificate_private_key_mismatch');
  await rejected(input => { input.identity.ca = 'authority/ca.crt'; }, 'wrong-ca', 'provisioning_validation_or_generation_failed');
  await rejected(input => { input.identity.ca = 'broker-tls/ca.crt'; input.identity.certificate = 'broker-tls/server.crt'; input.identity.private_key = 'broker-tls/server.key'; }, 'server-identity', 'provisioning_validation_or_generation_failed');
  await rejected(input => { input.broker.host = 'https://127.0.0.1'; }, 'invalid-host', 'invalid_broker_hostname');
  await rejected(input => { input.wifi.password = 'short'; }, 'invalid-password', 'invalid_configuration_string');
  await rejected(input => { input.ota_transport = transportConfig.ota_transport; }, 'transport-without-policy', 'invalid_ota_transport');
  for (const [name, value] of [['null', null], ['missing', {}], ['extra', { ca: 'broker-tls/ca.crt', insecure: true }]])
    await rejected(input => { input.ota_policy = vector.request.trust; input.ota_transport = value; }, 'transport-'+name, 'invalid_ota_transport');
  const validCA = await readFile(path.join(directory, 'broker-tls/ca.crt'), 'utf8');
  for (const [name, content] of [['empty', ''], ['text', 'invalid pem'], ['noise', 'unexpected prefix\n'+validCA],
    ['too-long', validCA+' '.repeat(4000)], ['private', await readFile(path.join(directory, 'lamp/private.key'), 'utf8')]]) {
    await writeFile(path.join(directory, 'ca-'+name+'.pem'), content);
    await rejected(input => { input.ota_policy = vector.request.trust; input.ota_transport = { ca: 'ca-'+name+'.pem' }; }, 'transport-'+name, 'invalid_ota_https_ca');
  }
  for (const leaf of ['lamp/device.crt', 'broker-tls/server.crt'])
    await rejected(input => { input.ota_policy = vector.request.trust; input.ota_transport = { ca: leaf }; }, 'transport-leaf-'+path.basename(leaf), 'invalid_ota_https_ca');
  await rejected(input => { input.ota_signing_key = { ...withKey.ota_signing_key, signing_key_id: 'sha256:' + '0'.repeat(64) }; }, 'bad-fingerprint', 'ota_signing_key_fingerprint_mismatch');
  await rejected(input => { input.ota_signing_key = { ...withKey.ota_signing_key, public_key: 'invalid' }; }, 'bad-public-key', 'invalid_ota_signing_key');
  await rejected(input => { input.ota_signing_key = { ...withKey.ota_signing_key, trust_from_manifest: true }; }, 'extra-trust-field', 'invalid_ota_signing_key');
  await rejected(input => { input.ota_signing_key = null; }, 'empty-key', 'invalid_ota_signing_key');
  for (const [name, change] of [
    ['null', () => null], ['extra', t => ({ ...t, extra: true })], ['missing', t => { delete t.product_ids; return t; }],
    ['purpose', t => ({ ...t, purpose: 'model' })], ['boolean', t => ({ ...t, minimum_battery_percent: true })],
    ['duplicate', t => ({ ...t, product_ids: [...t.product_ids, ...t.product_ids] })], ['bad-time', t => ({ ...t, expires_at: '2026-02-29T00:00:00Z' })],
    ['default-port', t => ({ ...t, download_origins: ['https://nas.local:443'] })], ['hex-ipv4', t => ({ ...t, download_origins: ['https://0x'] })],
    ['bad-fingerprint', t => ({ ...t, signing_key_id: 'sha256:'+'0'.repeat(64) })],
  ]) await rejected(input => { input.ota_policy = change(structuredClone(vector.request.trust)); }, 'policy-'+name, 'invalid_ota_policy');
  const otherPublic = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  await rejected(input => { input.ota_policy = vector.request.trust; input.ota_signing_key = { public_key: otherPublic.toString('base64'), signing_key_id: 'sha256:'+createHash('sha256').update(otherPublic).digest('hex') }; }, 'mismatched-policy-key', 'ota_policy_key_mismatch');
  await writeFile(filename, JSON.stringify(policyOnly).replace('"minimum_security_epoch":1', '"minimum_security_epoch":0,"minimum_security_epoch":1'), { mode: 0o600 });
  await assert.rejects(exec(python, [path.join(root, 'firmware/tools/provision.py'), '--config', filename, '--output', path.join(directory, 'duplicate-policy-key')]), error => JSON.parse(error.stdout).error === 'duplicate_configuration_key');
  await assert.rejects(stat(path.join(directory, 'duplicate-policy-key')), { code: 'ENOENT' });
  await assert.rejects(generate(config, 'valid'), error => JSON.parse(error.stdout).error === 'provisioning_validation_or_generation_failed');
  assert.equal((await stat(generated.image)).size, 0x6000);
});

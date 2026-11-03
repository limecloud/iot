import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises';
import { randomBytes, createHmac } from 'node:crypto';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const python = process.env.LIMEIOT_FIRMWARE_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const sdkPath = process.env.LIMEIOT_IDF_PATH ?? process.env.IDF_PATH;
let directory, configuration, configFile, keyFile, prepared;
const tool = path.join(root, 'firmware/tools/provision.py');
const invoke = async (name, flags = []) => JSON.parse((await exec(python, [tool, '--config', configFile, '--output', path.join(directory, name), ...flags])).stdout);
before(async () => {
  assert(sdkPath, '设置IDF_PATH或LIMEIOT_IDF_PATH，指向完整固定版本SDK');
  directory = await mkdtemp(path.join(root, '.dev/firmware-storage-'));
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', path.join(directory, 'nas'), '--origin', 'https://127.0.0.1:18443'], { cwd: root });
  await exec('python3', ['deploy/nas/device_identity.py', 'issue', '--directory', path.join(directory, 'nas'), '--device-id', 'device-lamp', '--output', path.join(directory, 'identity')], { cwd: root });
  configuration = { space_id: 'space-demo', device_id: 'device-lamp', hardware_rev: 'host-storage-fixture', wifi: { ssid: 'storage-fixture', password: 'fixture-wireless-password' }, broker: { host: '127.0.0.1', port: 8883 }, identity: { ca: 'identity/ca.crt', certificate: 'identity/device.crt', private_key: 'identity/private.key' } };
  configFile = path.join(directory, 'configuration.json'); keyFile = path.join(directory, 'hmac-root.bin');
  await writeFile(configFile, JSON.stringify(configuration), { mode: 0o600 }); await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  prepared = await invoke('encrypted', ['--hmac-key-file', keyFile, '--hmac-key-id', '0']);
});

test('实际加密NVS只交付密文、认证绑定和回执，官方工具恢复全部身份与配网字段', { timeout: 30000 }, async () => {
  assert.equal(prepared.encrypted, true); assert.equal(prepared.storage.automatic_efuse_writes, false);
  const image = await readFile(prepared.image), binding = await readFile(prepared.storage.binding_image);
  assert.equal(image.length, 0x6000); assert.equal(binding.length, 4096);
  for (const secret of [configuration.wifi.password, configuration.wifi.ssid, configuration.device_id, await readFile(path.join(directory, 'identity/private.key'), 'utf8')]) assert.equal(image.includes(Buffer.from(secret)), false);
  assert.deepEqual((await readdir(path.dirname(prepared.image))).sort(), ['nvs.bin', 'provisioning.json', 'storage-binding.bin']);
  for (const name of ['nvs.bin', 'provisioning.json', 'storage-binding.bin']) assert.equal((await stat(path.join(path.dirname(prepared.image), name))).mode & 0o777, 0o600);
  assert.equal(binding[9], 0);
  assert.deepEqual(binding.subarray(176, 208), createHmac('sha256', await readFile(keyFile)).update(binding.subarray(0, 176)).digest());
  const receipt = JSON.parse(await readFile(path.join(path.dirname(prepared.image), 'provisioning.json'), 'utf8'));
  const validate = new Ajv({ strict: true }).compile(JSON.parse(await readFile(path.join(root, 'contracts/device-storage.schema.json'), 'utf8')));
  assert(validate(receipt), JSON.stringify(validate.errors));
  assert.equal(validate({ ...receipt, hardware: true }), false);
  assert.equal(validate({ ...receipt, storage: { ...receipt.storage, key_id: 6 } }), false);
  assert.equal(validate({ ...receipt, private_key: 'unexpected' }), false);
  assert.equal(receipt.storage.image_sha256, prepared.storage.image_sha256);
  const result = JSON.parse((await exec(python, ['firmware/tests/storage_roundtrip.py', '--idf-path', sdkPath, '--configuration', configFile, '--key', keyFile, '--image', prepared.image, '--output', path.join(directory, 'official-roundtrip')], { cwd: root })).stdout);
  assert.equal(result.official_hmac_derivation, true); assert.equal(result.official_parser_crc, true);
  await writeFile(path.join(directory, 'roundtrip-result.json'), JSON.stringify(result));
});

test('加密配置拒绝缺配对参数、宽松/错误/链接密钥及覆盖；明文开发档位保持可用', { timeout: 30000 }, async () => {
  for (const [name, flags, code] of [
    ['missing-id', ['--hmac-key-file', keyFile], 'explicit_hmac_key_file_and_id_required'],
    ['missing-key', ['--hmac-key-id', '0'], 'explicit_hmac_key_file_and_id_required'],
  ]) await assert.rejects(invoke(name, flags), error => JSON.parse(error.stdout).error === code);
  const loose = path.join(directory, 'public-key.bin'); await writeFile(loose, randomBytes(32), { mode: 0o644 });
  const short = path.join(directory, 'short-key.bin'); await writeFile(short, randomBytes(31), { mode: 0o600 });
  const zero = path.join(directory, 'zero-key.bin'); await writeFile(zero, Buffer.alloc(32), { mode: 0o600 });
  const linked = path.join(directory, 'key-link.bin'); await symlink(keyFile, linked);
  for (const [index, file] of [loose, short, zero, linked].entries()) await assert.rejects(invoke('bad-key-' + index, ['--hmac-key-file', file, '--hmac-key-id', '0']));
  await assert.rejects(invoke('encrypted', ['--hmac-key-file', keyFile, '--hmac-key-id', '0']));
  const plain = await invoke('plain'); assert.equal(plain.encrypted, false);
  assert((await readFile(plain.image)).includes(Buffer.from(configuration.wifi.password)));
});

test('实际C适配器先验证受保护硬件键与设备绑定，全部故障拒绝且不调用明文初始化', { timeout: 30000 }, async () => {
  const crypto = (await exec('pkg-config', ['--cflags', '--libs', 'openssl'])).stdout.trim().split(/\s+/);
  const common = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g', '-Ifirmware/tests/storage_stubs', '-Ifirmware/components/limeiot_core/include', '-Ifirmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src/storage.c', 'firmware/tests/esp_storage_host.c', ...crypto];
  const protectedBinary = path.join(directory, 'protected-host');
  await exec(process.env.CC ?? 'clang', [...common, '-DCONFIG_LIMEIOT_NVS_HMAC_PROTECTED=1', '-DCONFIG_NVS_ENCRYPTION=1', '-DCONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC=1', '-DCONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID=0', '-o', protectedBinary], { cwd: root });
  const run = async (binary, mode) => JSON.parse((await exec(binary, [prepared.storage.binding_image, keyFile, mode])).stdout);
  const valid = await run(protectedBinary, 'valid'); assert.equal(valid.ok, true); assert.equal(valid.plain_calls, 0); assert.equal(valid.secure_calls, 2);
  const results = { valid };
  for (const mode of ['missing-key', 'readable-key', 'writable-key', 'purpose-writable', 'missing-binding', 'wrong-size', 'encrypted-binding', 'writable-binding', 'read-failed', 'bad-format', 'wrong-id', 'bad-mac', 'wrong-root', 'hmac-failed', 'missing-scheme', 'wrong-scheme', 'derivation-failed', 'nvs-failed', 'wrong-space', 'wrong-device', 'unknown-partition']) {
    const result = await run(protectedBinary, mode); assert.equal(result.ok, false, mode); assert.equal(result.plain_calls, 0, mode);
    if (!['nvs-failed', 'wrong-space', 'wrong-device'].includes(mode)) assert.equal(result.secure_calls, 0, mode);
    results[mode] = result;
  }
  const developmentBinary = path.join(directory, 'development-host');
  await exec(process.env.CC ?? 'clang', [...common, '-o', developmentBinary], { cwd: root });
  const development = await run(developmentBinary, 'valid'); assert.equal(development.ok, true); assert.equal(development.secure_calls, 0); assert.equal(development.plain_calls, 2);
  await writeFile(path.join(directory, 'storage-host-result.json'), JSON.stringify({ passed: true, cases: Object.keys(results).length, results, development, hardware: false }));
});

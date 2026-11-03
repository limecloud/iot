import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, cp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, createHmac, randomBytes, createPublicKey } from 'node:crypto';
import { root, freePort, stop, until } from '../tools/dev-stack.mjs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const exec = promisify(execFile);
const binary = process.env.LIMEIOT_IDENTITY_HOST_BINARY;
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const issuer = path.join(root, 'deploy/nas/device_identity.py');
const hash = value => createHash('sha256').update(value).digest('hex');
const validateEnrollment = addFormats(new Ajv({ strict: true })).compile(JSON.parse(await readFile(path.join(root, 'contracts/device-enrollment.schema.json'))));
async function setup() {
  assert(binary, '使用npm run test:firmware:identity先编译当前实际C适配器和固定SDK密码库');
  const directory = await mkdtemp(path.join(root, '.dev/device-local-identity-'));
  const nas = path.join(directory, 'nas'), device = path.join(directory, 'device');
  await mkdir(device, { mode: 0o700 });
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', nas, '--origin', 'https://127.0.0.1:18443'], { cwd: root });
  await writeFile(path.join(device, 'root.bin'), randomBytes(32), { mode: 0o600 });
  await exec(python, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0, "firmware/tools"); from nvs_hmac import binding_image; p=Path(sys.argv[1]); (p/"binding.bin").write_bytes(binding_image((p/"root.bin").read_bytes(), 0, "device-lamp", "space-demo"))', device], { cwd: root });
  const ca = path.join(nas, 'device-authority/ca.crt');
  return { directory, nas, device, ca };
}
const drive = async (fixture, action, mode = 'valid', extra = [], deviceId = 'device-lamp') => {
  const { stdout, stderr } = await exec(binary, [fixture.device, fixture.ca, action, mode, deviceId, ...extra]);
  assert.equal(stderr, ''); assert(!stdout.includes('PRIVATE KEY'));
  return JSON.parse(stdout);
};
const sign = async (fixture, fingerprint) => JSON.parse((await exec(python, [issuer, 'sign-csr', '--directory', fixture.nas, '--device-id', 'device-lamp', '--csr', path.join(fixture.device, 'request.csr'), '--public-key-fingerprint', fingerprint, '--request-id', 'device-local-enrollment', '--output', path.join(fixture.directory, 'signed')])).stdout);
const enrollment = async (fixture, action, flags) => {
  const result = JSON.parse((await exec(python, [issuer, action, '--directory', fixture.nas, ...flags])).stdout);
  assert(validateEnrollment(result), JSON.stringify(validateEnrollment.errors)); return result;
};
const rotate = (fixture, candidate, previous, id = 'rotation-lamp-001') => enrollment(fixture, 'rotate-csr', ['--device-id', 'device-lamp', '--csr', path.join(fixture.device, 'request.csr'), '--public-key-fingerprint', candidate.fingerprint, '--request-id', id, '--output', path.join(fixture.directory, id), '--previous-serial', previous.serial, '--previous-certificate-fingerprint', previous.certificate_sha256]);
const complete = (fixture, proof, id = 'rotation-lamp-001') => enrollment(fixture, 'complete-rotation', ['--request-id', id, '--activation-proof', proof]);
const resolve = (fixture, id = 'rotation-lamp-001', flags = []) => enrollment(fixture, 'resolve-csr', ['--request-id', id, ...flags]);
async function readyFixture() {
  const fixture = await setup(), candidate = await drive(fixture, 'request'), issued = await sign(fixture, candidate.fingerprint);
  assert.equal((await drive(fixture, 'import', 'valid', [path.join(issued.output, 'device.crt')])).code, 'ok');
  return { fixture, issued };
}
async function cloneDevice(fixture, name) {
  const device = path.join(fixture.directory, name); await cp(fixture.device, device, { recursive: true });
  return { ...fixture, device };
}
async function brokerFixture(fixture, t) {
  const plainPort = await freePort(), port = await freePort();
  const generated = await exec('python3', ['-c', 'import sys; from device_identity import broker_config; print(broker_config(*sys.argv[1:4], int(sys.argv[4]), int(sys.argv[5]), "127.0.0.1"))', path.join(fixture.nas, 'config'), path.join(fixture.nas, 'secrets'), path.join(fixture.nas, 'broker-tls'), String(plainPort), String(port)], { cwd: path.join(root, 'deploy/nas') });
  const configuration = path.join(fixture.directory, 'mosquitto.conf'); await writeFile(configuration, generated.stdout);
  const launch = async () => {
    const child = spawn(path.join(root, '.dev/tools/mosquitto-build/src/mosquitto'), ['-c', configuration], { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(path.join(fixture.directory, 'broker.log'), { flags: 'a' });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.on('exit', () => log.end()); t.after(() => stop(child));
    await until(() => new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); }));
    return child;
  };
  let broker = await launch();
  return { port, restart: async () => { await stop(broker); broker = await launch(); } };
}

test('实际SDK密码库生成设备本机密钥/CSR，NAS只收公钥，导入后重启保留原身份', async () => {
  const fixture = await setup();
  const generated = await drive(fixture, 'request');
  assert.equal(generated.code, 'ok'); assert.equal(generated.second, 'ok'); assert.equal(generated.writes, 1);
  assert.match(generated.fingerprint, /^sha256:[a-f0-9]{64}$/);
  const publicPEM = (await exec('openssl', ['req', '-in', path.join(fixture.device, 'request.csr'), '-pubkey', '-noout'])).stdout;
  assert.equal(generated.fingerprint, 'sha256:'+hash(createPublicKey(publicPEM).export({ format: 'der', type: 'spki' })));
  const pending = await readFile(path.join(fixture.device, 'identity.blob'));
  const repeated = await drive(fixture, 'request');
  assert.equal(repeated.fingerprint, generated.fingerprint); assert.equal(repeated.writes, 0);
  assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), pending);
  const issued = await sign(fixture, generated.fingerprint);
  const imported = await drive(fixture, 'import', 'valid', [path.join(issued.output, 'device.crt')]);
  assert.equal(imported.code, 'ok'); assert.equal(imported.second, 'ok'); assert.equal(imported.writes, 1);
  const ready = await readFile(path.join(fixture.device, 'identity.blob'));
  const credentials = await drive(fixture, 'credentials'); assert.equal(credentials.code, 'ok'); assert.equal(credentials.writes, 0);
  assert.equal((await drive(fixture, 'request')).code, 'conflict');
  assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), ready);
  assert.equal((await stat(path.join(fixture.device, 'identity.blob'))).mode & 0o777, 0o600);
  await writeFile(path.join(fixture.directory, 'result.json'), JSON.stringify({ passed: true, fingerprint: generated.fingerprint, actual_sdk_crypto: true, host_nvs_and_efuse: true, hardware: false }));
});

test('密钥提交/回读不确定时对象冻结，重新打开复用耐久原键且不自动生成', async () => {
  for (const mode of ['commit-after', 'readback-failed', 'readback-corrupt', 'reopen-failed']) {
    const fixture = await setup();
    const failed = await drive(fixture, 'request', mode);
    assert.equal(failed.code, 'storage', mode); assert.equal(failed.second, 'storage', mode); assert.equal(failed.fingerprint, ''); assert.equal(failed.writes, 1);
    const durable = await readFile(path.join(fixture.device, 'identity.blob'));
    const recovered = await drive(fixture, 'request'); assert.equal(recovered.code, 'ok'); assert.equal(recovered.writes, 0);
    assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), durable);
  }
  const fixture = await setup();
  const failed = await drive(fixture, 'request', 'commit-before');
  assert.equal(failed.code, 'storage'); assert.equal(failed.second, 'storage'); assert.equal(failed.fingerprint, '');
  await assert.rejects(stat(path.join(fixture.device, 'identity.blob')), { code: 'ENOENT' });
});

test('存储损坏、缺硬件钥、读取失败、CA或设备错绑拒绝且不覆盖旧键', async () => {
  const fixture = await setup(); assert.equal((await drive(fixture, 'request')).code, 'ok');
  const pathName = path.join(fixture.device, 'identity.blob'), original = await readFile(pathName);
  for (const mode of ['missing-key', 'mac-failed', 'read-failed']) {
    const result = await drive(fixture, 'request', mode); assert.equal(result.code, 'storage'); assert.equal(result.writes, 0);
  }
  assert.equal((await drive(fixture, 'request', 'valid', [], 'device-button')).code, 'storage');
  assert.equal((await drive({ ...fixture, ca: path.join(fixture.nas, 'authority/ca.crt') }, 'request')).code, 'storage');
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1; await writeFile(pathName, damaged);
  const rejected = await drive(fixture, 'request'); assert.equal(rejected.code, 'storage'); assert.equal(rejected.writes, 0);
  assert.deepEqual(await readFile(pathName), damaged);
});

test('不可信时钟不生成或导入身份，凭据失败输出清空', async () => {
  const fixture = await setup();
  const result = await drive(fixture, 'request', 'clock-untrusted'); assert.equal(result.code, 'clock'); assert.equal(result.writes, 0);
  const credentials = await drive(fixture, 'credentials', 'clock-untrusted');
  assert.equal(credentials.code, 'clock'); assert.equal(credentials.outputs_zero, true);
  await assert.rejects(stat(path.join(fixture.device, 'identity.blob')), { code: 'ENOENT' });
});

test('证书身份、公钥、CA、用途、算法、时间或PEM不匹配均拒绝且保留pending原键', async () => {
  const fixture = await setup(), generated = await drive(fixture, 'request'); assert.equal(generated.code, 'ok');
  await exec(python, ['firmware/tests/identity_certificates.py', fixture.directory], { cwd: root });
  const blob = path.join(fixture.device, 'identity.blob'), pending = await readFile(blob);
  const folder = path.join(fixture.directory, 'certificates'), valid = await readFile(path.join(folder, 'valid.crt'), 'utf8');
  await writeFile(path.join(folder, 'double.crt'), valid.repeat(2));
  await writeFile(path.join(folder, 'trailing.crt'), valid+'unexpected');
  await writeFile(path.join(folder, 'invalid.crt'), '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
  for (const name of (await readdir(folder)).filter(name => name !== 'valid.crt')) {
    const rejected = await drive(fixture, 'import', 'valid', [path.join(folder, name)]);
    assert.equal(rejected.code, 'invalid', name); assert.equal(rejected.second, 'invalid', name); assert.equal(rejected.writes, 0, name);
    assert.deepEqual(await readFile(blob), pending, name);
  }
  const clock = await drive(fixture, 'import', 'clock-untrusted', [path.join(folder, 'valid.crt')]);
  assert.equal(clock.code, 'clock'); assert.equal(clock.writes, 0);
  assert.equal((await drive(fixture, 'import', 'valid', [path.join(folder, 'valid.crt')])).code, 'ok');
  const ready = await readFile(blob);
  const issued = await sign(fixture, generated.fingerprint);
  const different = await drive(fixture, 'import', 'valid', [path.join(issued.output, 'device.crt')]);
  assert.equal(different.code, 'conflict'); assert.equal(different.writes, 0);
  assert.deepEqual(await readFile(blob), ready);
});

test('证书提交丢响应后重开恢复ready，重复原证书不再次写入', async () => {
  const fixture = await setup(), generated = await drive(fixture, 'request');
  const issued = await sign(fixture, generated.fingerprint), certificate = path.join(issued.output, 'device.crt');
  const failed = await drive(fixture, 'import', 'commit-after', [certificate]);
  assert.equal(failed.code, 'storage'); assert.equal(failed.second, 'storage'); assert.equal(failed.writes, 1);
  const original = await readFile(path.join(fixture.device, 'identity.blob'));
  assert.equal((await drive(fixture, 'credentials')).code, 'ok');
  const repeated = await drive(fixture, 'import', 'valid', [certificate]);
  assert.equal(repeated.code, 'ok'); assert.equal(repeated.writes, 0);
  assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), original);
});

test('设备本机私钥留在C适配器内部，真实Broker接受mTLS身份、撤销后拒绝', { timeout: 45000 }, async t => {
  const fixture = await setup(), generated = await drive(fixture, 'request'), issued = await sign(fixture, generated.fingerprint);
  assert.equal((await drive(fixture, 'import', 'valid', [path.join(issued.output, 'device.crt')])).code, 'ok');
  const broker = await brokerFixture(fixture, t), port = broker.port;
  const accepted = await drive(fixture, 'mqtt', 'valid', [String(port)]); assert.equal(accepted.code, 'ok'); assert.equal(accepted.mqtt, true);
  const revoked = JSON.parse((await exec('python3', [issuer, 'revoke', '--directory', fixture.nas, '--serial', issued.serial])).stdout);
  assert.equal(revoked.broker_restart_required, true); await broker.restart();
  const denied = await drive(fixture, 'mqtt', 'valid', [String(port)]); assert.equal(denied.code, 'ok'); assert.equal(denied.mqtt, false);
});

test('CA-only初始化实际生成加密NVS，官方解密确认无设备私钥和叶证书、标记严格匹配', async () => {
  const fixture = await setup(), configFile = path.join(fixture.directory, 'configuration.json');
  const config = { space_id: 'space-demo', device_id: 'device-lamp', hardware_rev: 'identity-host', wifi: { ssid: 'identity-fixture', password: 'fixture-wireless-password' }, broker: { host: '127.0.0.1', port: 8883 }, identity: { mode: 'device-local', ca: 'nas/device-authority/ca.crt' } };
  const key = path.join(fixture.device, 'root.bin'), tool = path.join(root, 'firmware/tools/provision.py');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const provision = async (name, flags = []) => JSON.parse((await exec(python, [tool, '--config', configFile, '--output', path.join(fixture.directory, name), ...flags])).stdout);
  const prepared = await provision('encrypted', ['--hmac-key-file', key, '--hmac-key-id', '0']);
  assert.equal(prepared.encrypted, true); assert.equal(prepared.device_local_identity, true);
  const result = JSON.parse((await exec(python, ['firmware/tests/storage_roundtrip.py', '--idf-path', process.env.LIMEIOT_IDF_PATH ?? process.env.IDF_PATH, '--configuration', configFile, '--key', key, '--image', prepared.image, '--output', path.join(fixture.directory, 'official-roundtrip')], { cwd: root })).stdout);
  assert.equal(result.device_local_identity, true); assert.equal(result.official_parser_crc, true);
  await assert.rejects(provision('plaintext'), error => JSON.parse(error.stdout).error === 'device_local_identity_requires_protected_ca_only');
  await writeFile(configFile, JSON.stringify({ ...config, identity: { ...config.identity, private_key: 'forbidden' } }));
  await assert.rejects(provision('mixed', ['--hmac-key-file', key, '--hmac-key-id', '0']), error => JSON.parse(error.stdout).error === 'device_local_identity_requires_protected_ca_only');
});

test('两代本机轮换通过新键激活证明才撤销旧证书，重启Broker后旧身份拒绝、新身份可用', { timeout: 60000 }, async t => {
  const { fixture, issued } = await readyFixture(), broker = await brokerFixture(fixture, t);
  let previous = issued;
  const initial = await readFile(path.join(fixture.device, 'identity.blob'));
  assert.equal(initial.length, 4722); assert.equal(initial[8], 1);
  for (let generation = 1; generation <= 2; generation++) {
    const id = 'rotation-lamp-00'+generation, old = await cloneDevice(fixture, 'old-identity-'+generation);
    const candidate = await drive(fixture, 'rotate-request', 'valid', [id]);
    assert.equal(candidate.code, 'ok'); assert.equal(candidate.second, 'ok'); assert.equal(candidate.state, 3); assert.equal(candidate.generation, generation-1);
    assert.equal(candidate.writes, 1); assert.notEqual(candidate.fingerprint, candidate.public_key_fingerprint);
    assert.equal(candidate.certificate_fingerprint, previous.certificate_sha256);
    assert.equal(candidate.pending_public_key_fingerprint, candidate.fingerprint);
    const pending = await readFile(path.join(fixture.device, 'identity.blob')); assert.equal(pending.length, 5331); assert.equal(pending[8], 2);
    const repeated = await drive(fixture, 'rotate-request', 'valid', [id]); assert.equal(repeated.fingerprint, candidate.fingerprint); assert.equal(repeated.writes, 0);
    assert.equal((await drive(fixture, 'rotate-request', 'valid', ['conflicting-id'])).code, 'conflict');
    assert.equal((await drive(fixture, 'import', 'valid', [path.join(previous.output, 'device.crt')])).code, 'conflict');
    assert.equal((await drive(fixture, 'rotate-import', 'valid', [id, path.join(previous.output, 'device.crt')])).code, 'invalid');
    assert.equal((await drive(fixture, 'mqtt', 'valid', [String(broker.port)])).mqtt, true);
    const replacement = await rotate(fixture, candidate, previous, id);
    assert.equal(replacement.schema_version, 2); assert.equal(replacement.activation_confirmed, false); assert.equal(replacement.previous_decision, 'issued');
    assert.equal(replacement.rotation_completed, false); assert.equal(replacement.crl_updated, false);
    await assert.rejects(complete(fixture, '00'.repeat(70), id), error => JSON.parse(error.stdout).error === 'rotation_activation_proof_invalid');
    assert.equal((await resolve(fixture, id)).previous_decision, 'issued');
    const imported = await drive(fixture, 'rotate-import', 'valid', [id, path.join(replacement.output, 'device.crt')]);
    assert.equal(imported.code, 'ok'); assert.equal(imported.second, 'ok'); assert.equal(imported.writes, 1);
    assert.equal(imported.generation, generation); assert.equal(imported.state, 2); assert.equal(imported.pending_public_key_fingerprint, '');
    assert.equal(imported.certificate_fingerprint, replacement.certificate_sha256);
    assert.equal((await drive(fixture, 'rotate-request', 'valid', [id])).code, 'conflict');
    assert.equal((await drive(fixture, 'mqtt', 'valid', [String(broker.port)])).mqtt, true);
    assert.equal((await drive(old, 'mqtt', 'valid', [String(broker.port)])).mqtt, true, '激活证明前旧证书仍可用');
    const badChallenge = await drive(fixture, 'proof', 'valid', [id, '0'.repeat(64)]);
    await assert.rejects(complete(fixture, badChallenge.proof, id), error => JSON.parse(error.stdout).error === 'rotation_activation_proof_invalid');
    const proof = await drive(fixture, 'proof', 'valid', [id, replacement.activation_challenge]);
    assert.equal(proof.code, 'ok'); assert.match(proof.proof, /^[a-f0-9]+$/);
    assert(proof.proof.length >= 16 && proof.proof.length <= 144 && proof.proof.length % 2 === 0); assert.equal(proof.writes, 0);
    const finished = await complete(fixture, proof.proof, id);
    assert.equal(finished.rotation_completed, true); assert.equal(finished.activation_confirmed, true); assert.equal(finished.previous_decision, 'revoked');
    assert.equal(finished.crl_updated, true); assert.equal(finished.broker_restart_required, true);
    const serials = await readFile(path.join(fixture.nas, 'device-authority/index.txt'));
    assert.equal((await complete(fixture, proof.proof, id)).rotation_completed, true);
    assert.deepEqual(await readFile(path.join(fixture.nas, 'device-authority/index.txt')), serials);
    assert.equal((await resolve(fixture, id)).rotation_completed, true);
    await broker.restart();
    assert.equal((await drive(old, 'mqtt', 'valid', [String(broker.port)])).mqtt, false);
    assert.equal((await drive(fixture, 'mqtt', 'valid', [String(broker.port)])).mqtt, true);
    previous = replacement;
  }
  await writeFile(path.join(fixture.directory, 'rotation-result.json'), JSON.stringify({ passed: true, generations: 2, actual_sdk_crypto: true, real_broker: true, hardware: false, physical_claim: false }));
});

test('轮换生成/切换的提交和回读故障不换键、不丢旧身份，重开按实际Blob恢复', async () => {
  const { fixture, issued } = await readyFixture(), original = await readFile(path.join(fixture.device, 'identity.blob'));
  for (const mode of ['commit-before', 'commit-after', 'readback-failed', 'readback-corrupt', 'reopen-failed']) {
    const copy = await cloneDevice(fixture, 'stage-'+mode), result = await drive(copy, 'rotate-request', mode, ['rotation-lamp-001']);
    assert.equal(result.code, 'storage', mode); assert.equal(result.second, 'storage', mode); assert.equal(result.fingerprint, '');
    assert.equal((await drive(copy, 'credentials')).certificate_fingerprint, issued.certificate_sha256);
    const durable = await readFile(path.join(copy.device, 'identity.blob'));
    if (mode === 'commit-before') assert.deepEqual(durable, original);
    else {
      const recovered = await drive(copy, 'rotate-request', 'valid', ['rotation-lamp-001']);
      assert.equal(recovered.code, 'ok'); assert.equal(recovered.writes, 0);
      assert.deepEqual(await readFile(path.join(copy.device, 'identity.blob')), durable);
    }
  }
  const candidate = await drive(fixture, 'rotate-request', 'valid', ['rotation-lamp-001']), replacement = await rotate(fixture, candidate, issued);
  const pending = await readFile(path.join(fixture.device, 'identity.blob'));
  for (const mode of ['commit-before', 'commit-after', 'readback-failed', 'readback-corrupt', 'reopen-failed']) {
    const copy = await cloneDevice(fixture, 'activate-'+mode), result = await drive(copy, 'rotate-import', mode, ['rotation-lamp-001', path.join(replacement.output, 'device.crt')]);
    assert.equal(result.code, 'storage', mode); assert.equal(result.second, 'storage', mode);
    const current = await drive(copy, 'credentials'); assert.equal(current.code, 'ok');
    if (mode === 'commit-before') { assert.equal(current.certificate_fingerprint, issued.certificate_sha256); assert.deepEqual(await readFile(path.join(copy.device, 'identity.blob')), pending); }
    else {
      assert.equal(current.certificate_fingerprint, replacement.certificate_sha256); assert.equal(current.generation, 1);
      assert.equal((await drive(copy, 'rotate-import', 'valid', ['rotation-lamp-001', path.join(replacement.output, 'device.crt')])).writes, 0);
    }
  }
  const untouched = await readFile(path.join(fixture.device, 'identity.blob'));
  assert.equal((await drive(fixture, 'rotate-request', 'clock-untrusted', ['rotation-lamp-001'])).code, 'clock');
  assert.equal((await drive(fixture, 'rotate-import', 'clock-untrusted', ['rotation-lamp-001', path.join(replacement.output, 'device.crt')])).code, 'clock');
  assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), untouched);
});

test('轮换核对前证书，激活/CRL中断及NAS备份恢复均保留原决定', async () => {
  const { fixture, issued } = await readyFixture(), candidate = await drive(fixture, 'rotate-request', 'valid', ['rotation-lamp-001']);
  const original = await readFile(path.join(fixture.nas, 'device-authority/index.txt'));
  await assert.rejects(rotate(fixture, candidate, { ...issued, certificate_sha256: 'sha256:'+'0'.repeat(64) }));
  await assert.rejects(rotate(fixture, { ...candidate, fingerprint: issued.public_key_fingerprint }, issued), error => JSON.parse(error.stdout).error === 'csr_public_key_fingerprint_mismatch');
  await assert.rejects(rotate(fixture, candidate, { ...issued, serial: 'DEADBEEF' }));
  assert.deepEqual(await readFile(path.join(fixture.nas, 'device-authority/index.txt')), original);
  const replacement = await rotate(fixture, candidate, issued);
  await assert.rejects(rotate(fixture, candidate, issued), error => JSON.parse(error.stdout).error === 'csr_request_exists_query_original');
  await assert.rejects(rotate(fixture, candidate, issued, 'another-rotation'), error => JSON.parse(error.stdout).error === 'rotation_other_active_certificate_exists');
  assert.equal((await drive(fixture, 'rotate-import', 'valid', ['rotation-lamp-001', path.join(replacement.output, 'device.crt')])).code, 'ok');
  const proof = (await drive(fixture, 'proof', 'valid', ['rotation-lamp-001', replacement.activation_challenge])).proof;
  // 激活意图已保存、旧CA账本已撤销，但CRL尚未写入时中断。
  const script = [
    'import os, sys', 'from pathlib import Path',
    'os.umask(0o077); sys.path.insert(0, "deploy/nas")',
    'import device_identity, csr_enrollment',
    'def fail(*args):', '    raise OSError("rotation_crl_failure_fixture")',
    'device_identity.refresh_crl = fail', 'try:',
    '    csr_enrollment.complete_rotation(Path(sys.argv[1]), "rotation-lamp-001", sys.argv[2])',
    'except OSError:', '    print("injected")', 'else:', '    raise SystemExit("failure_fixture_not_reached")',
  ].join('\n');
  assert.equal((await exec(python, ['-c', script, fixture.nas, proof], { cwd: root })).stdout.trim(), 'injected');
  const interrupted = await resolve(fixture);
  assert.equal(interrupted.activation_confirmed, true); assert.equal(interrupted.previous_decision, 'revoked');
  assert.equal(interrupted.crl_updated, false); assert.equal(interrupted.rotation_completed, false);
  // SQLite仅为资料备份夹具；这里验证轮换意图、激活证明和撤销资料，不声明网关运行验收。
  await exec('python3', ['-c', 'import sqlite3, sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table snapshot (id integer primary key, body text not null)"); c.commit(); c.close()', path.join(fixture.nas, 'data/gateway.sqlite')]);
  const backupAndRestore = async name => {
    const backup = path.join(fixture.directory, name+'-backup'), restored = path.join(fixture.directory, name+'-restored');
    await exec('python3', ['deploy/nas/manage.py', 'backup', '--directory', fixture.nas, '--output', backup], { cwd: root });
    const manifest = JSON.parse(await readFile(path.join(backup, 'backup.json')));
    for (const file of ['request.json', 'request.csr', 'activation.json']) {
      const relative = 'device-authority/csr-operations/rotation-lamp-001/'+file;
      assert.equal(manifest.files[relative], hash(await readFile(path.join(fixture.nas, relative))));
    }
    for (const relative of ['device-authority/index.txt', 'broker-tls/revoked.crl']) {
      assert.equal(manifest.files[relative], hash(await readFile(path.join(fixture.nas, relative))));
    }
    await exec('python3', ['deploy/nas/manage.py', 'restore', '--directory', restored, '--backup', backup], { cwd: root });
    return { ...fixture, nas: restored };
  };
  const restoredInterrupted = await backupAndRestore('interrupted');
  assert.deepEqual(await resolve(restoredInterrupted), interrupted);
  const restoredIndex = await readFile(path.join(restoredInterrupted.nas, 'device-authority/index.txt'));
  assert.equal((await complete(restoredInterrupted, proof)).rotation_completed, true);
  assert.deepEqual(await readFile(path.join(restoredInterrupted.nas, 'device-authority/index.txt')), restoredIndex);
  assert.equal((await resolve(fixture)).rotation_completed, false, '恢复副本补CRL不改变原NAS');
  assert.equal((await complete(fixture, proof)).rotation_completed, true);
  const restoredCompleted = await backupAndRestore('completed');
  assert.deepEqual(await resolve(restoredCompleted), await resolve(fixture));
  const record = path.join(fixture.nas, 'device-authority/csr-operations/rotation-lamp-001/activation.json');
  const activation = JSON.parse(await readFile(record)); activation.request_sha256 = 'sha256:'+'0'.repeat(64); await writeFile(record, JSON.stringify(activation));
  await assert.rejects(resolve(fixture), error => JSON.parse(error.stdout).error === 'rotation_activation_journal_invalid');
});

test('轮换CA签发前后中断保留原序列号与挑战，未知禁止新键，已签发可只读重导出', async () => {
  for (const point of ['before_ca', 'after_ca']) {
    const { fixture, issued } = await readyFixture(), candidate = await drive(fixture, 'rotate-request', 'valid', ['rotation-lamp-001']);
    const script = [
      'import os, sys', 'from pathlib import Path',
      'os.umask(0o077); sys.path.insert(0, "deploy/nas")', 'import csr_enrollment as e',
      'def fail(*args, **kwargs):', '    raise OSError("rotation_sign_failure_fixture")',
      'if sys.argv[6] == "before_ca":', '    e.openssl = fail', 'else:', '    e.export_material = fail',
      'try:',
      '    e.sign_csr(Path(sys.argv[1]), "device-lamp", Path(sys.argv[2]), sys.argv[3], "rotation-lamp-001", Path(sys.argv[1]).parent / "lost-rotation", (sys.argv[4], sys.argv[5]))',
      'except OSError:', '    print("injected")', 'else:', '    raise SystemExit("failure_fixture_not_reached")',
    ].join('\n');
    assert.equal((await exec(python, ['-c', script, fixture.nas, path.join(fixture.device, 'request.csr'), candidate.fingerprint, issued.serial, issued.certificate_sha256, point], { cwd: root })).stdout.trim(), 'injected');
    const status = await resolve(fixture); assert.equal(status.previous_decision, 'issued'); assert.equal(status.activation_confirmed, false);
    assert.equal(status.decision, point === 'before_ca' ? 'unknown' : 'issued');
    assert.equal(status.rotation_completed, false);
    const index = await readFile(path.join(fixture.nas, 'device-authority/index.txt'));
    await assert.rejects(rotate(fixture, candidate, issued), error => JSON.parse(error.stdout).error === 'csr_request_exists_query_original');
    await assert.rejects(rotate(fixture, candidate, issued, 'new-id'));
    const freshSign = () => enrollment(fixture, 'sign-csr', ['--device-id', 'device-lamp', '--csr', path.join(fixture.device, 'request.csr'), '--public-key-fingerprint', candidate.fingerprint, '--request-id', 'fresh-sign', '--output', path.join(fixture.directory, 'fresh-sign')]);
    await assert.rejects(freshSign());
    if (point === 'after_ca') {
      const exported = await resolve(fixture, 'rotation-lamp-001', ['--output', path.join(fixture.directory, 'recovered-rotation')]);
      assert.equal(exported.serial, status.serial); assert.equal(exported.activation_challenge, status.activation_challenge);
      assert.equal((await drive(fixture, 'rotate-import', 'valid', ['rotation-lamp-001', path.join(exported.output, 'device.crt')])).code, 'ok');
      const proof = (await drive(fixture, 'proof', 'valid', ['rotation-lamp-001', status.activation_challenge])).proof;
      assert.equal((await complete(fixture, proof)).rotation_completed, true);
    } else {
      await assert.rejects(resolve(fixture, 'rotation-lamp-001', ['--output', path.join(fixture.directory, 'unknown-export')]));
      assert.deepEqual(await readFile(path.join(fixture.nas, 'device-authority/index.txt')), index);
      assert.equal((await drive(fixture, 'credentials')).certificate_fingerprint, issued.certificate_sha256);
      await exec('python3', [issuer, 'revoke', '--directory', fixture.nas, '--serial', issued.serial]);
      const revokedIndex = await readFile(path.join(fixture.nas, 'device-authority/index.txt'));
      await assert.rejects(freshSign(), error => JSON.parse(error.stdout).error === 'pending_csr_enrollment_query_original');
      await assert.rejects(exec('python3', [issuer, 'issue', '--directory', fixture.nas, '--device-id', 'device-lamp', '--output', path.join(fixture.directory, 'old-issue')]), error => JSON.parse(error.stdout).error === 'pending_csr_enrollment_query_original');
      assert.deepEqual(await readFile(path.join(fixture.nas, 'device-authority/index.txt')), revokedIndex);
    }
  }
});

// 测试CA签署短期证书；使用真实墙钟到期，不向产品注入时间或跳过日期验证。
async function shortReadyFixture() {
  const fixture = await setup(), candidate = await drive(fixture, 'request');
  const { stdout } = await exec(python, ['-c', `
import json, os, sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
os.umask(0o077); sys.path.insert(0, "deploy/nas")
import csr_enrollment as e
original=e.openssl
def short(*args):
    if args[0] == "ca" and "-in" in args:
        now=datetime.now(timezone.utc)
        args=(*args, "-startdate", (now-timedelta(days=1)).strftime("%Y%m%d%H%M%SZ"), "-enddate", (now+timedelta(seconds=8)).strftime("%Y%m%d%H%M%SZ"))
    return original(*args)
e.openssl=short
print(json.dumps(e.sign_csr(Path(sys.argv[1]), "device-lamp", Path(sys.argv[2]), sys.argv[3], "device-local-enrollment", Path(sys.argv[4]))))
`, fixture.nas, path.join(fixture.device, 'request.csr'), candidate.fingerprint, path.join(fixture.directory, 'signed')], { cwd: root });
  const issued = JSON.parse(stdout);
  assert.equal((await drive(fixture, 'import', 'valid', [path.join(issued.output, 'device.crt')])).code, 'ok');
  return { fixture, issued };
}
const waitExpired = fixture => until(async () => (await drive(fixture, 'status')).certificate_expired, 15000);
const recover = (fixture, candidate, previous, id) => enrollment(fixture, 'recover-csr', ['--device-id', 'device-lamp', '--csr', path.join(fixture.device, 'request.csr'), '--public-key-fingerprint', candidate.fingerprint, '--request-id', id, '--output', path.join(fixture.directory, id), '--previous-serial', previous.serial, '--previous-certificate-fingerprint', previous.certificate_sha256]);

test('C3实际到期后明确维护，耐久原CSR经NAS恢复/激活/CRL后新身份可连接', { timeout: 45000 }, async t => {
  const { fixture, issued } = await shortReadyFixture(), id = 'expired-lamp-001';
  const initial = await readFile(path.join(fixture.device, 'identity.blob'));
  assert.equal((await drive(fixture, 'recover-request', 'valid', [id])).code, 'invalid');
  assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), initial);
  await waitExpired(fixture);
  const old = await drive(fixture, 'credentials'); assert.equal(old.code, 'invalid'); assert.equal(old.outputs_zero, true);
  assert.equal((await drive(fixture, 'rotate-request', 'valid', [id])).code, 'invalid');
  const candidate = await drive(fixture, 'recover-request', 'valid', [id]);
  assert.equal(candidate.code, 'ok'); assert.equal(candidate.second, 'ok'); assert.equal(candidate.writes, 1);
  assert.equal(candidate.recovery_origin, 1); assert.equal(candidate.certificate_expired, true);
  assert.notEqual(candidate.fingerprint, issued.public_key_fingerprint);
  const csr = await readFile(path.join(fixture.device, 'request.csr')), pending = await readFile(path.join(fixture.device, 'identity.blob'));
  assert.equal(pending.length, 6355); assert.equal(pending[8], 3);
  const repeated = await drive(fixture, 'recover-request', 'valid', [id]); assert.equal(repeated.writes, 0);
  assert.deepEqual(await readFile(path.join(fixture.device, 'request.csr')), csr);
  assert.equal((await drive(fixture, 'recover-request', 'valid', ['different-id'])).code, 'conflict');
  assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), pending);
  const signed = await recover(fixture, candidate, issued, id); assert.equal(signed.schema_version, 3);
  const der = (await exec('openssl', ['req', '-in', path.join(fixture.device, 'request.csr'), '-outform', 'DER'], { encoding: 'buffer' })).stdout;
  assert.equal(signed.csr_sha256, 'sha256:'+hash(der));
  const switched = await drive(fixture, 'rotate-import', 'valid', [id, path.join(signed.output, 'device.crt')]);
  assert.equal(switched.code, 'ok'); assert.equal(switched.second, 'ok'); assert.equal(switched.generation, 1); assert.equal(switched.certificate_expired, false);
  const proof = await drive(fixture, 'proof', 'valid', [id, signed.activation_challenge]); assert.equal(proof.code, 'ok');
  const finished = await complete(fixture, proof.proof, id); assert.equal(finished.rotation_completed, true);
  const broker = await brokerFixture(fixture, t);
  assert.equal((await drive(fixture, 'mqtt', 'valid', [String(broker.port)])).mqtt, true);
  const activated = await readFile(path.join(fixture.device, 'identity.blob'));
  assert.deepEqual(activated.subarray(6323), createHmac('sha256', await readFile(path.join(fixture.device, 'root.bin'))).update(activated.subarray(0, 6323)).digest());
  await writeFile(path.join(fixture.directory, 'expiry-result.json'), JSON.stringify({ passed: true, actual_expiry: true, real_nas_recover_csr: true, original_csr_retained: true, activation_and_crl: true, broker_new_identity: true, actual_sdk_crypto: true, host_nvs_and_efuse: true, usb_runtime: false, hardware: false })+'\n');
});

test('C3原v2候选随后到期，核对原CSR转维护且管理v2/v3均沿原请求完成', { timeout: 60000 }, async () => {
  for (const alreadySigned of [true, false]) {
    const { fixture, issued } = await shortReadyFixture(), id = 'pending-expired-001';
    const candidate = await drive(fixture, 'rotate-request', 'valid', [id]); assert.equal(candidate.code, 'ok');
    const csr = await readFile(path.join(fixture.device, 'request.csr'));
    const originalFile = path.join(fixture.directory, 'original.csr'); await writeFile(originalFile, csr);
    const signedBefore = alreadySigned ? await rotate(fixture, candidate, issued, id) : null;
    const pending = await readFile(path.join(fixture.device, 'identity.blob'));
    await waitExpired(fixture);
    assert.equal((await drive(fixture, 'recover-request', 'valid', [id])).code, 'invalid');
    assert.equal((await drive(fixture, 'recover-request', 'valid', ['new-id', originalFile])).code, 'conflict');
    if (signedBefore) assert.equal((await drive(fixture, 'rotate-import', 'valid', [id, path.join(signedBefore.output, 'device.crt')])).code, 'invalid');
    assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), pending);
    const accepted = await drive(fixture, 'recover-request', 'valid', [id, originalFile]);
    assert.equal(accepted.code, 'ok'); assert.equal(accepted.second, 'ok'); assert.equal(accepted.recovery_origin, 2); assert.equal(accepted.fingerprint, candidate.fingerprint);
    const maintained = await readFile(path.join(fixture.device, 'identity.blob'));
    assert.deepEqual(maintained.subarray(4755, 5267), pending.subarray(4755, 5267));
    assert.deepEqual(await readFile(path.join(fixture.device, 'request.csr')), csr);
    const signed = signedBefore ?? await recover(fixture, candidate, issued, id);
    assert.equal(signed.schema_version, alreadySigned ? 2 : 3);
    assert.equal((await drive(fixture, 'rotate-import', 'valid', [id, path.join(signed.output, 'device.crt')])).code, 'ok');
    const proof = await drive(fixture, 'proof', 'valid', [id, signed.activation_challenge]);
    assert.equal((await complete(fixture, proof.proof, id)).rotation_completed, true);
  }
});

test('C3过期维护提交/回读不确定时冻结，重开只恢复原候选和CSR', { timeout: 45000 }, async () => {
  const { fixture } = await shortReadyFixture(), id = 'expired-fault-001'; await waitExpired(fixture);
  const original = await readFile(path.join(fixture.device, 'identity.blob'));
  for (const mode of ['commit-before', 'commit-after', 'readback-failed', 'readback-corrupt', 'reopen-failed']) {
    const copy = await cloneDevice(fixture, 'expired-'+mode), failed = await drive(copy, 'recover-request', mode, [id]);
    assert.equal(failed.code, 'storage', mode); assert.equal(failed.second, 'storage', mode); assert.equal(failed.fingerprint, '');
    const durable = await readFile(path.join(copy.device, 'identity.blob'));
    if (mode === 'commit-before') assert.deepEqual(durable, original);
    else {
      const restored = await drive(copy, 'recover-request', 'valid', [id]); assert.equal(restored.code, 'ok'); assert.equal(restored.writes, 0);
      assert.deepEqual(await readFile(path.join(copy.device, 'identity.blob')), durable);
      assert.deepEqual(await readFile(path.join(copy.device, 'request.csr')), durable.subarray(5299, 6323).subarray(0, durable.subarray(5299, 6323).indexOf(0)));
      assert.equal((await drive(copy, 'credentials')).outputs_zero, true);
    }
  }
});

test('C3维护不放行未来/错用途/错键/错CA/坏签名或不可信时钟，坏原CSR零写入', { timeout: 45000 }, async () => {
  const { fixture } = await shortReadyFixture(), id = 'expired-negative-001';
  const oldCSR = await readFile(path.join(fixture.device, 'request.csr'));
  const candidate = await drive(fixture, 'rotate-request', 'valid', [id]); assert.equal(candidate.code, 'ok');
  const csr = await readFile(path.join(fixture.device, 'request.csr'));
  await writeFile(path.join(fixture.device, 'request.csr'), oldCSR);
  await exec(python, ['firmware/tests/identity_certificates.py', fixture.directory], { cwd: root });
  await writeFile(path.join(fixture.device, 'request.csr'), csr);
  await waitExpired(fixture);
  const original = await readFile(path.join(fixture.device, 'identity.blob'));
  const brokenDER = (await exec('openssl', ['req', '-in', path.join(fixture.device, 'request.csr'), '-outform', 'DER'], { encoding: 'buffer' })).stdout;
  brokenDER[brokenDER.length - 1] ^= 1;
  const broken = '-----BEGIN CERTIFICATE REQUEST-----\n'+brokenDER.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE REQUEST-----\n';
  const badCSR = path.join(fixture.directory, 'bad.csr'); await writeFile(badCSR, broken);
  for (const value of [badCSR, path.join(fixture.directory, 'certificates/valid.crt')]) {
    assert.equal((await drive(fixture, 'recover-request', 'valid', [id, value])).code, 'invalid');
    assert.deepEqual(await readFile(path.join(fixture.device, 'identity.blob')), original);
  }
  const originalCSR = path.join(fixture.directory, 'original.csr'); await writeFile(originalCSR, csr);
  assert.equal((await drive(fixture, 'recover-request', 'clock-untrusted', [id, originalCSR])).code, 'clock');
  // 测试夹具可重算宿主HMAC，用于验证已保存的坏叶证书不能进入维护；产品没有该入口。
  for (const name of ['future', 'wrong-cn', 'wrong-key', 'wrong-ca', 'server-auth', 'dual-eku', 'extra-ku', 'unknown-critical']) {
    const copy = await cloneDevice(fixture, 'invalid-'+name), data = Buffer.from(original);
    data.fill(0, 690, 4690); (await readFile(path.join(fixture.directory, 'certificates', name+'.crt'))).copy(data, 690);
    createHash('sha256').update((await exec('openssl', ['x509', '-in', path.join(fixture.directory, 'certificates', name+'.crt'), '-outform', 'DER'], { encoding: 'buffer' })).stdout).digest().copy(data, 5267);
    createHmac('sha256', await readFile(path.join(copy.device, 'root.bin'))).update(data.subarray(0, 5299)).digest().copy(data, 5299);
    await writeFile(path.join(copy.device, 'identity.blob'), data);
    const rejected = await drive(copy, 'recover-request', 'valid', [id, originalCSR]); assert.equal(rejected.code, name === 'unknown-critical' ? 'storage' : 'invalid', name); assert.equal(rejected.writes, 0, name);
    assert.equal((await drive(copy, 'credentials')).outputs_zero, true, name);
    assert.deepEqual(await readFile(path.join(copy.device, 'identity.blob')), data);
  }
  const expiredCA = path.join(fixture.directory, 'expired-ca.crt');
  await exec(python, ['-c', `
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
p=Path(sys.argv[1]); ca=x509.load_pem_x509_certificate((p/"ca.crt").read_bytes()); key=serialization.load_pem_private_key((p/"ca.key").read_bytes(), None)
now=datetime.now(timezone.utc)
b=x509.CertificateBuilder().subject_name(ca.subject).issuer_name(ca.issuer).public_key(ca.public_key()).serial_number(ca.serial_number).not_valid_before(now-timedelta(days=3)).not_valid_after(now-timedelta(days=1))
for extension in ca.extensions: b=b.add_extension(extension.value, extension.critical)
Path(sys.argv[2]).write_bytes(b.sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM))
`, path.join(fixture.nas, 'device-authority'), expiredCA]);
  const copy = await cloneDevice(fixture, 'expired-ca'), data = Buffer.from(original);
  const der = (await exec('openssl', ['x509', '-in', expiredCA, '-outform', 'DER'], { encoding: 'buffer' })).stdout;
  createHash('sha256').update(der).digest().copy(data, 146);
  createHmac('sha256', await readFile(path.join(copy.device, 'root.bin'))).update(data.subarray(0, 5299)).digest().copy(data, 5299);
  await writeFile(path.join(copy.device, 'identity.blob'), data);
  const rejected = await drive({ ...copy, ca: expiredCA }, 'recover-request', 'valid', [id, originalCSR]);
  assert.equal(rejected.code, 'invalid'); assert.equal(rejected.writes, 0);
  assert.deepEqual(await readFile(path.join(copy.device, 'identity.blob')), data);
});

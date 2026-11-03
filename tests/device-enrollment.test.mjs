import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, symlink, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, generateKeyPairSync, sign as signBytes, X509Certificate } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, freePort, stop, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';

const exec = promisify(execFile);
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const issuer = path.join(root, 'deploy/nas/device_identity.py');
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
let validate;
before(async () => {
  const schema = JSON.parse((await exec('python3', [issuer, 'csr-schema'])).stdout);
  assert.deepEqual(schema, JSON.parse(await readFile(path.join(root, 'contracts/device-enrollment.schema.json'))));
  validate = addFormats(new Ajv({ strict: true })).compile(schema);
});
const command = async (action, directory, flags = []) => {
  const result = JSON.parse((await exec(python, [issuer, action, '--directory', directory, ...flags])).stdout);
  assert(validate(result), JSON.stringify(validate.errors));
  return result;
};
const rejected = async (promise, code) => assert.rejects(promise, error => {
  const result = JSON.parse(error.stdout);
  assert(validate(result), JSON.stringify(validate.errors));
  return !code || result.error === code;
});
async function setup() {
  const directory = await mkdtemp(path.join(root, '.dev/device-enrollment-'));
  const nas = path.join(directory, 'nas');
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', nas, '--origin', 'https://127.0.0.1:18443'], { cwd: root });
  return { directory, nas };
}
async function device(directory, name = 'lamp', options = {}) {
  const location = path.join(directory, name); await mkdir(location, { mode: 0o700 });
  const keys = generateKeyPairSync(options.type ?? 'ec', options.type === 'rsa' ? { modulusLength: 2048 } : { namedCurve: options.curve ?? 'prime256v1' });
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const key = path.join(location, 'private.key'), csr = path.join(location, 'request.csr');
  await writeFile(key, privateKey, { mode: 0o600 });
  await exec('openssl', ['req', '-new', '-key', key, '-subj', options.subject ?? '/CN=device-lamp', options.hash ?? '-sha256', ...(options.extensions ?? []).flatMap(value => ['-addext', value]), '-out', csr]);
  return { location, key, csr, privateKey, publicKey: keys.publicKey, fingerprint: digest(keys.publicKey.export({ type: 'spki', format: 'der' })) };
}
const sign = (nas, candidate, output, request = 'enrollment-lamp', extra = []) => command('sign-csr', nas, ['--device-id', 'device-lamp', '--csr', candidate.csr, '--public-key-fingerprint', candidate.fingerprint, '--request-id', request, '--output', output, ...extra]);
const resolve = (nas, request = 'enrollment-lamp', output) => command('resolve-csr', nas, ['--request-id', request, ...(output ? ['--output', output] : [])]);
const index = nas => readFile(path.join(nas, 'device-authority/index.txt'), 'utf8');
const replacement = (nas, candidate, previous, output, request = 'recover-lamp', action = 'recover-csr') => command(action, nas, [
  '--device-id', 'device-lamp', '--csr', candidate.csr, '--public-key-fingerprint', candidate.fingerprint,
  '--previous-serial', previous.serial, '--previous-certificate-fingerprint', previous.certificate_sha256,
  '--request-id', request, '--output', output,
]);
const activation = (candidate, result) => signBytes('sha256', Buffer.from([
  'limeiot.device-rotation-activate/v1', result.space_id, result.device_id, result.request_id,
  result.certificate_sha256, result.activation_challenge,
].join('\n')), candidate.privateKey).toString('hex');
const complete = (nas, result, proof) => command('complete-rotation', nas, ['--request-id', result.request_id, '--activation-proof', proof]);
async function expiredCertificate(nas, candidate, name = 'expired') {
  // 测试CA真实签署过去有效的证书；墙钟和生产证书检查均保持原值。
  const result = await exec(python, ['-c', `
import json, os, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
os.umask(0o077)
sys.path.insert(0, "deploy/nas")
from device_identity import openssl
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
authority = Path(sys.argv[1]) / "device-authority"
serial = (authority / "serial").read_text().strip()
output = Path(sys.argv[2]).parent / (sys.argv[3] + ".crt")
now = datetime.now(timezone.utc)
openssl("ca", "-batch", "-config", authority / "openssl.cnf", "-extensions", "client", "-notext", "-in", sys.argv[2], "-out", output,
        "-startdate", (now-timedelta(days=2)).strftime("%Y%m%d%H%M%SZ"), "-enddate", (now-timedelta(days=1)).strftime("%Y%m%d%H%M%SZ"))
certificate = x509.load_pem_x509_certificate(output.read_bytes())
print(json.dumps({"serial": serial, "certificate_sha256": "sha256:"+certificate.fingerprint(hashes.SHA256()).hex(), "path": str(output)}))
`, nas, candidate.csr, name], { cwd: root });
  return JSON.parse(result.stdout);
}
async function brokerFixture(nas, directory, t) {
  const [plainPort, port] = [await freePort(), await freePort()];
  const generated = await exec('python3', ['-c', 'import sys; from device_identity import broker_config; print(broker_config(*sys.argv[1:4], int(sys.argv[4]), int(sys.argv[5]), "127.0.0.1"))', path.join(nas, 'config'), path.join(nas, 'secrets'), path.join(nas, 'broker-tls'), String(plainPort), String(port)], { cwd: path.join(root, 'deploy/nas') });
  const configuration = path.join(directory, 'mosquitto.conf'); await writeFile(configuration, generated.stdout);
  const launch = async () => {
    const child = spawn(path.join(root, '.dev/tools/mosquitto-build/src/mosquitto'), ['-c', configuration], { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(path.join(directory, 'broker.log'), { flags: 'a' }); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.on('exit', () => log.end());
    t.after(() => stop(child));
    await until(() => new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); }));
    return child;
  };
  let broker = await launch();
  return { port, restart: async () => { await stop(broker); broker = await launch(); } };
}
const faultSign = async (nas, candidate, output, point) => exec(python, ['-c', `
import json, os, sys
os.umask(0o077)
sys.path.insert(0, "deploy/nas")
import csr_enrollment as enrollment
def fail(*args, **kwargs):
    raise OSError("host_failure_fixture")
if sys.argv[5] == "after_ca":
    enrollment.export_material = fail
else:
    enrollment.openssl = fail
try:
    enrollment.sign_csr(__import__("pathlib").Path(sys.argv[1]), "device-lamp", __import__("pathlib").Path(sys.argv[2]), sys.argv[3], "enrollment-lamp", __import__("pathlib").Path(sys.argv[4]))
except OSError:
    print(json.dumps({"injected": sys.argv[5]}))
else:
    raise SystemExit("failure_fixture_did_not_run")
`, nas, candidate.csr, candidate.fingerprint, output, point], { cwd: root });

test('外部CSR只交付公钥材料，独立指纹、正式Schema、单次签发及只读原结果一致', async () => {
  const { directory, nas } = await setup(), candidate = await device(directory);
  const initial = await index(nas);
  const inspection = await command('inspect-csr', nas, ['--device-id', 'device-lamp', '--csr', candidate.csr]);
  assert.equal(inspection.public_key_fingerprint, candidate.fingerprint);
  assert.equal(await index(nas), initial);
  const output = path.join(directory, 'issued');
  const result = await sign(nas, candidate, output);
  assert.equal(result.decision, 'issued'); assert.equal(result.physical_claim, false); assert.equal(result.hardware, false);
  const certificate = new X509Certificate(await readFile(path.join(output, 'device.crt')));
  assert.equal(digest(certificate.publicKey.export({ type: 'spki', format: 'der' })), candidate.fingerprint);
  assert.equal(certificate.ca, false);
  assert.deepEqual((await readdir(output)).sort(), ['ca.crt', 'device.crt', 'enrollment.json', 'request.csr']);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  for (const name of await readdir(output)) {
    assert.equal((await stat(path.join(output, name))).mode & 0o777, 0o600);
    assert(!(await readFile(path.join(output, name))).includes(Buffer.from('PRIVATE KEY')));
  }
  const receipt = JSON.parse(await readFile(path.join(output, 'enrollment.json')));
  assert(validate(receipt), JSON.stringify(validate.errors));
  assert.equal(validate({ ...receipt, physical_claim: true }), false);
  const signed = await index(nas);
  assert.equal((signed.match(/\/CN=device-lamp/g) ?? []).length, 1);
  const resolved = await resolve(nas);
  assert.equal(resolved.serial, result.serial); assert.equal(resolved.request_sha256, result.request_sha256);
  await rejected(sign(nas, candidate, path.join(directory, 'repeat')), 'csr_request_exists_query_original');
  await rejected(sign(nas, candidate, path.join(directory, 'new-key'), 'enrollment-lamp-2'), 'active_certificate_exists_revoke_before_reissue');
  assert.equal(await index(nas), signed);
  const exported = await resolve(nas, 'enrollment-lamp', path.join(directory, 'export'));
  assert.equal(exported.serial, result.serial);
  assert.equal(await readFile(path.join(exported.output, 'device.crt'), 'utf8'), await readFile(path.join(output, 'device.crt'), 'utf8'));
  await rejected(resolve(nas, 'enrollment-lamp', exported.output));
  assert.equal(await index(nas), signed);
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, serial: result.serial, private_key_on_device_fixture_only: true, hardware: false }));
});

test('错误身份/指纹/算法/签名/扩展、私钥输入与符号链接均在签发前拒绝', async () => {
  const { directory, nas } = await setup(), candidate = await device(directory);
  const initial = await index(nas);
  await rejected(command('sign-csr', nas, ['--device-id', 'device-lamp', '--csr', candidate.csr, '--request-id', 'missing-pin', '--output', path.join(directory, 'missing-pin')]), 'explicit_public_key_fingerprint_required');
  await rejected(sign(nas, { ...candidate, fingerprint: 'sha256:'+'0'.repeat(64) }, path.join(directory, 'wrong-pin')), 'csr_public_key_fingerprint_mismatch');
  for (const [name, options] of [
    ['wrong-cn', { subject: '/CN=device-button' }], ['extra-subject', { subject: '/CN=device-lamp/O=another' }],
    ['p384', { curve: 'secp384r1' }], ['rsa', { type: 'rsa' }], ['sha384', { hash: '-sha384' }],
    ['ca-request', { extensions: ['basicConstraints=critical,CA:TRUE'] }], ['san', { extensions: ['subjectAltName=DNS:gateway'] }],
  ]) {
    const invalid = await device(directory, name, options);
    await rejected(sign(nas, invalid, path.join(directory, name+'-issued'), name));
    await assert.rejects(stat(path.join(directory, name+'-issued')), { code: 'ENOENT' });
  }
  const broken = Buffer.from((await exec('openssl', ['req', '-in', candidate.csr, '-outform', 'DER'], { encoding: 'buffer' })).stdout);
  broken[broken.length - 1] ^= 1;
  const brokenFile = path.join(directory, 'broken.csr');
  await writeFile(brokenFile, '-----BEGIN CERTIFICATE REQUEST-----\n'+broken.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE REQUEST-----\n');
  await rejected(sign(nas, { ...candidate, csr: brokenFile }, path.join(directory, 'broken-issued')), 'invalid_csr_proof');
  await rejected(sign(nas, { ...candidate, csr: candidate.key }, path.join(directory, 'private-input')), 'single_public_csr_required');
  const doubled = path.join(directory, 'doubled.csr'); await writeFile(doubled, (await readFile(candidate.csr, 'utf8')).repeat(2));
  await rejected(sign(nas, { ...candidate, csr: doubled }, path.join(directory, 'double-input')));
  const link = path.join(directory, 'linked.csr'); await symlink(candidate.csr, link);
  await rejected(sign(nas, { ...candidate, csr: link }, path.join(directory, 'linked-issued')), 'identity_path_symlink_forbidden');
  const outputLink = path.join(directory, 'linked-directory'); await symlink(directory, outputLink);
  await rejected(sign(nas, candidate, path.join(outputLink, 'out')), 'identity_path_symlink_forbidden');
  await rejected(command('inspect-csr', nas, ['--device-id', 'gateway', '--csr', candidate.csr]), 'device_not_bound_to_gateway');
  const config = path.join(nas, 'config/gateway.json'), moved = path.join(directory, 'config-fixture.json');
  await rename(config, moved); await symlink(moved, config);
  await rejected(command('inspect-csr', nas, ['--device-id', 'device-lamp', '--csr', candidate.csr]), 'identity_path_symlink_forbidden');
  await rejected(sign(nas, candidate, path.join(directory, 'linked-config-issued')), 'identity_path_symlink_forbidden');
  assert.equal(await index(nas), initial);
  await assert.rejects(stat(path.join(nas, 'device-authority/csr-operations')), { code: 'ENOENT' });
});

test('CA已签发但响应/交付丢失后只查询原证书，重新导出不再签发', async () => {
  const { directory, nas } = await setup(), candidate = await device(directory);
  assert.deepEqual(JSON.parse((await faultSign(nas, candidate, path.join(directory, 'lost-output'), 'after_ca')).stdout), { injected: 'after_ca' });
  await assert.rejects(stat(path.join(directory, 'lost-output')), { code: 'ENOENT' });
  const signed = await index(nas);
  const original = await resolve(nas);
  assert.equal(original.decision, 'issued');
  await rejected(sign(nas, candidate, path.join(directory, 'retry-output')), 'csr_request_exists_query_original');
  const exported = await resolve(nas, 'enrollment-lamp', path.join(directory, 'recovered-output'));
  assert.equal(exported.serial, original.serial); assert.equal(exported.certificate_sha256, original.certificate_sha256);
  assert.equal(await index(nas), signed);
  assert.equal((await readdir(path.join(nas, 'device-authority/issued'))).length, 2, 'Broker加本次设备证书');
});

test('意图已保存但签发未确认时保持unknown，新CSR与旧开发入口都不能绕过', async () => {
  const { directory, nas } = await setup(), candidate = await device(directory);
  const initial = await index(nas);
  assert.deepEqual(JSON.parse((await faultSign(nas, candidate, path.join(directory, 'not-issued'), 'before_ca')).stdout), { injected: 'before_ca' });
  const original = await resolve(nas); assert.equal(original.decision, 'unknown');
  assert.equal(original.certificate_sha256, undefined);
  await rejected(resolve(nas, 'enrollment-lamp', path.join(directory, 'cannot-export')), 'csr_original_certificate_not_active');
  const another = await device(directory, 'another');
  await rejected(sign(nas, another, path.join(directory, 'new-request'), 'enrollment-lamp-2'), 'pending_csr_enrollment_query_original');
  await rejected(command('issue', nas, ['--device-id', 'device-lamp', '--output', path.join(directory, 'old-entry')]), 'pending_csr_enrollment_query_original');
  assert.equal(await index(nas), initial);
  const record = path.join(nas, 'device-authority/csr-operations/enrollment-lamp/request.json');
  const input = JSON.parse(await readFile(record)); input.device_id = 'device-button'; await writeFile(record, JSON.stringify(input));
  const corrupted = await readFile(record);
  await rejected(resolve(nas), 'csr_journal_invalid'); assert.deepEqual(await readFile(record), corrupted);
});

test('已有公共CSR证书通过真实Broker的mTLS/设备ACL，撤销后不能导出或连接', { timeout: 45000 }, async t => {
  const { directory, nas } = await setup(), candidate = await device(directory);
  const output = path.join(directory, 'issued'), issued = await sign(nas, candidate, output);
  const broker = await brokerFixture(nas, directory, t), port = broker.port;
  const options = { port, ca: await readFile(path.join(output, 'ca.crt')), cert: await readFile(path.join(output, 'device.crt')), key: await readFile(candidate.key) };
  const client = await mqttProbe({ ...options, username: 'gateway' }); t.after(() => client.close());
  assert.ok([0, 16].includes(await client.publish('limeiot/v1/space-demo/device-lamp/up/hello')));
  assert.equal(await client.publish('limeiot/v1/space-demo/device-button/up/event'), 135);
  assert.equal(await client.publish('limeiot/v1/space-demo/device-lamp/down/command'), 135);
  client.close();
  const revoked = JSON.parse((await exec('python3', [issuer, 'revoke', '--directory', nas, '--serial', issued.serial])).stdout);
  assert.equal(revoked.broker_restart_required, true);
  await broker.restart();
  await assert.rejects(mqttProbe(options));
  assert.equal((await resolve(nas)).decision, 'revoked');
  await rejected(resolve(nas, 'enrollment-lamp', path.join(directory, 'revoked-export')), 'csr_original_certificate_not_active');
  const renewed = await sign(nas, candidate, path.join(directory, 'renewed'), 'enrollment-lamp-2');
  assert.notEqual(renewed.serial, issued.serial);
  assert.equal((await resolve(nas)).decision, 'revoked');
  const valid = await mqttProbe({ ...options, cert: await readFile(path.join(renewed.output, 'device.crt')) }); valid.close();
});

test('NAS备份恢复保留原签发意图与序列号，空间、CA和证书错绑均拒绝', async () => {
  const { directory, nas } = await setup(), candidate = await device(directory);
  const issued = await sign(nas, candidate, path.join(directory, 'issued'));
  // 仅验证身份管理资料随NAS备份移动；SQLite为专用夹具，不宣称网关运行验收。
  await exec('python3', ['-c', 'import sqlite3, sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table snapshot (id integer primary key check(id=1), version integer not null, config_hash text not null, body text not null)"); c.commit(); c.close()', path.join(nas, 'data/gateway.sqlite')]);
  const backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
  await exec('python3', ['deploy/nas/manage.py', 'backup', '--directory', nas, '--output', backup], { cwd: root });
  const manifest = JSON.parse(await readFile(path.join(backup, 'backup.json')));
  assert(manifest.files['device-authority/csr-operations/enrollment-lamp/request.json']);
  assert(manifest.files['device-authority/csr-operations/enrollment-lamp/request.csr']);
  await exec('python3', ['deploy/nas/manage.py', 'restore', '--directory', restored, '--backup', backup], { cwd: root });
  const original = await resolve(restored);
  assert.equal(original.serial, issued.serial); assert.equal(original.request_sha256, issued.request_sha256);
  const exported = await resolve(restored, 'enrollment-lamp', path.join(directory, 'restored-export'));
  assert.equal(exported.certificate_sha256, issued.certificate_sha256);
  const before = await index(restored);
  const configPath = path.join(restored, 'config/gateway.json'), config = JSON.parse(await readFile(configPath));
  await writeFile(configPath, JSON.stringify({ ...config, space_id: 'space-other' }));
  await rejected(resolve(restored), 'csr_space_binding_changed');
  await writeFile(configPath, JSON.stringify(config));
  const certificatePath = path.join(restored, 'device-authority/issued', issued.serial+'.pem');
  const realCertificate = await readFile(certificatePath);
  await writeFile(certificatePath, await readFile(path.join(restored, 'broker-tls/server.crt')));
  await rejected(resolve(restored), 'csr_issued_certificate_mismatch');
  await writeFile(certificatePath, realCertificate);
  const caPath = path.join(restored, 'device-authority/ca.crt');
  await writeFile(caPath, await readFile(path.join(restored, 'authority/ca.crt')));
  await rejected(resolve(restored), 'csr_ca_binding_changed');
  assert.equal(await index(restored), before); assert.equal(await index(nas), before);
});

test('与既有签发/撤销/备份共用互斥锁，并发签发在创建意图前拒绝', async t => {
  const { directory, nas } = await setup(), candidate = await device(directory);
  const initial = await index(nas);
  const holder = spawn('python3', ['-c', 'import fcntl, os, sys; os.umask(0o077); f=open(sys.argv[1], "a"); fcntl.flock(f, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.read()', path.join(nas, 'device-authority/.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => stop(holder));
  await new Promise((resolve, reject) => { holder.stdout.once('data', data => data.toString().includes('locked') ? resolve() : reject(new Error('lock_fixture_not_ready'))); holder.once('error', reject); holder.once('exit', code => reject(new Error('lock_fixture_exited_'+code))); });
  await rejected(sign(nas, candidate, path.join(directory, 'concurrent')), 'identity_operation_failed');
  assert.equal(await index(nas), initial);
  await assert.rejects(stat(path.join(nas, 'device-authority/csr-operations')), { code: 'ENOENT' });
  holder.stdin.end(); await stop(holder);
});

test('过期身份必须明确恢复并换新键，v3原决定、激活撤旧和真实Broker核对连续', { timeout: 45000 }, async t => {
  const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), next = await device(directory, 'next');
  const previous = await expiredCertificate(nas, oldKey), before = await index(nas);
  await rejected(replacement(nas, next, previous, path.join(directory, 'normal'), 'normal', 'rotate-csr'), 'rotation_previous_certificate_not_active');
  assert.equal(await index(nas), before);
  const broker = await brokerFixture(nas, directory, t);
  const ca = await readFile(path.join(nas, 'broker-tls/ca.crt'));
  await assert.rejects(mqttProbe({ port: broker.port, ca, cert: await readFile(previous.path), key: oldKey.privateKey }));
  const output = path.join(directory, 'recovered');
  const recovered = await replacement(nas, next, previous, output);
  assert.equal(recovered.schema_version, 3); assert.equal(recovered.recovery_reason, 'certificate_expired');
  assert.equal(recovered.previous_decision, 'expired'); assert.equal(recovered.rotation_completed, false);
  assert.equal(recovered.device_id, 'device-lamp'); assert.equal(recovered.space_id, 'space-demo');
  const requestPath = path.join(nas, 'device-authority/csr-operations/recover-lamp/request.json');
  const request = await readFile(requestPath), parsedRequest = JSON.parse(request);
  assert(validate(parsedRequest), JSON.stringify(validate.errors));
  assert.equal(parsedRequest.request_sha256, digest(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(parsedRequest).filter(([k]) => k !== 'request_sha256').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))));
  const receipt = JSON.parse(await readFile(path.join(output, 'enrollment.json')));
  assert(validate(receipt), JSON.stringify(validate.errors));
  assert.equal(validate({ ...receipt, recovery_reason: undefined }), false);
  assert.equal(validate({ ...receipt, schema_version: 2 }), false);
  assert.equal(validate({ ...recovered, action: 'rotate-csr' }), false);
  const cert = await readFile(path.join(output, 'device.crt'));
  const connected = await mqttProbe({ port: broker.port, ca, cert, key: next.privateKey }); connected.close();
  const signed = await index(nas), serial = await readFile(path.join(nas, 'device-authority/serial'));
  const resolved = await resolve(nas, 'recover-lamp', path.join(directory, 'resolved'));
  assert.equal(resolved.serial, recovered.serial); assert.equal(resolved.request_sha256, recovered.request_sha256);
  assert.deepEqual(await readFile(path.join(directory, 'resolved/device.crt')), cert);
  await rejected(replacement(nas, next, previous, path.join(directory, 'duplicate')), 'csr_request_exists_query_original');
  await rejected(complete(nas, recovered, activation(oldKey, recovered)), 'rotation_activation_proof_invalid');
  assert.equal(await index(nas), signed);
  const done = await complete(nas, recovered, activation(next, recovered));
  assert.equal(done.previous_decision, 'revoked'); assert.equal(done.rotation_completed, true); assert.equal(done.broker_restart_required, true);
  assert.deepEqual(await readFile(requestPath), request); assert.deepEqual(await readFile(path.join(nas, 'device-authority/serial')), serial);
  await broker.restart();
  await assert.rejects(mqttProbe({ port: broker.port, ca, cert: await readFile(previous.path), key: oldKey.privateKey }));
  const final = await mqttProbe({ port: broker.port, ca, cert, key: next.privateKey }); final.close();
  assert.equal((await complete(nas, recovered, activation(next, recovered))).rotation_completed, true);
  await writeFile(path.join(directory, 'recovery-result.json'), JSON.stringify({ passed: true, schema_version: 3, recovery_reason: 'certificate_expired', original_request_retained: true, actual_broker: true, expired_identity_rejected: true, replacement_identity_accepted: true, original_key_exported: false, hardware: false })+'\n');
});

test('恢复入口拒绝有效/撤销/未知前证书、错指纹和同键，全部在新意图前拒绝', async () => {
  const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), next = await device(directory, 'next');
  const valid = await sign(nas, oldKey, path.join(directory, 'valid'));
  await rejected(replacement(nas, next, valid, path.join(directory, 'not-expired')), 'recovery_previous_certificate_not_expired');
  const indexPath = path.join(nas, 'device-authority/index.txt'), validIndex = await index(nas);
  await writeFile(indexPath, validIndex.split('\n').map(row => row.split('\t')[3] === valid.serial ? 'E'+row.slice(1) : row).join('\n'));
  await rejected(replacement(nas, next, valid, path.join(directory, 'false-expiry')), 'recovery_previous_certificate_not_expired');
  await writeFile(indexPath, validIndex);
  await exec('python3', [issuer, 'revoke', '--directory', nas, '--serial', valid.serial]);
  const previous = await expiredCertificate(nas, oldKey);
  const before = await index(nas), serial = await readFile(path.join(nas, 'device-authority/serial'));
  await rejected(replacement(nas, oldKey, previous, path.join(directory, 'same')), 'rotation_new_key_required');
  await rejected(replacement(nas, next, { ...previous, certificate_sha256: 'sha256:'+'0'.repeat(64) }, path.join(directory, 'wrong-digest')), 'csr_issued_certificate_mismatch');
  await rejected(replacement(nas, next, { ...previous, serial: '7FFFFFFF' }, path.join(directory, 'unknown')), 'recovery_previous_certificate_not_expired');
  await rejected(replacement(nas, next, { ...previous, serial: '' }, path.join(directory, 'missing')), 'rotation_previous_certificate_confirmation_required');
  await exec('python3', [issuer, 'revoke', '--directory', nas, '--serial', previous.serial]);
  const revoked = await index(nas);
  await rejected(replacement(nas, next, previous, path.join(directory, 'revoked')), 'recovery_previous_certificate_not_expired');
  assert.notEqual(revoked, before); assert.equal(await index(nas), revoked);
  assert.deepEqual(await readFile(path.join(nas, 'device-authority/serial')), serial);
  assert.deepEqual(await readdir(path.join(nas, 'device-authority/csr-operations')), ['enrollment-lamp']);
});

test('过期恢复不从多张未撤销旧证书中猜测，V和E索引状态均检查', async () => {
  const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), other = await device(directory, 'other'), next = await device(directory, 'next');
  const previous = await expiredCertificate(nas, oldKey), another = await expiredCertificate(nas, other);
  await exec(python, ['-c', 'import os, sys; os.umask(0o077); sys.path.insert(0, "deploy/nas"); from device_identity import openssl; openssl("ca", "-config", sys.argv[1], "-updatedb")', path.join(nas, 'device-authority/openssl.cnf')], { cwd: root });
  const before = await index(nas); assert.match(before, /^E\t/m);
  for (const old of [previous, another]) await rejected(replacement(nas, next, old, path.join(directory, 'ambiguous-'+old.serial)), 'rotation_other_active_certificate_exists');
  assert.equal(await index(nas), before);
  await assert.rejects(stat(path.join(nas, 'device-authority/csr-operations')), { code: 'ENOENT' });
});

test('恢复签发前后中断只查原v3决定，不能换ID重签或丢失原挑战', async () => {
  for (const point of ['before_ca', 'after_ca']) {
    const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), next = await device(directory, 'next');
    const previous = await expiredCertificate(nas, oldKey);
    const before = await index(nas);
    const injected = await exec(python, ['-c', `
import json, os, sys
from pathlib import Path
os.umask(0o077)
sys.path.insert(0, "deploy/nas")
import csr_enrollment as enrollment
def fail(*args, **kwargs):
    raise OSError("recovery_failure_fixture")
if sys.argv[7] == "before_ca":
    enrollment.openssl = fail
else:
    enrollment.export_material = fail
try:
    enrollment.sign_csr(Path(sys.argv[1]), "device-lamp", Path(sys.argv[2]), sys.argv[3], "recover-lamp", Path(sys.argv[4]), (sys.argv[5], sys.argv[6]), recovery=True)
except OSError:
    print(json.dumps({"injected": sys.argv[7]}))
else:
    raise SystemExit("failure_fixture_did_not_run")
`, nas, next.csr, next.fingerprint, path.join(directory, 'lost'), previous.serial, previous.certificate_sha256, point], { cwd: root });
    assert.deepEqual(JSON.parse(injected.stdout), { injected: point });
    const record = path.join(nas, 'device-authority/csr-operations/recover-lamp/request.json'), original = await readFile(record);
    const result = await resolve(nas, 'recover-lamp');
    assert.equal(result.schema_version, 3); assert.equal(result.recovery_reason, 'certificate_expired');
    assert.equal(result.decision, point === 'before_ca' ? 'unknown' : 'issued');
    await rejected(replacement(nas, next, previous, path.join(directory, 'same')), 'csr_request_exists_query_original');
    // after_ca时存在第二张未撤销证书，before_ca时存在未知意图，均拒绝新请求。
    await rejected(replacement(nas, next, previous, path.join(directory, 'another'), 'different-id'), point === 'before_ca' ? 'pending_csr_enrollment_query_original' : 'rotation_other_active_certificate_exists');
    if (point === 'before_ca') {
      assert.equal(await index(nas), before);
      await rejected(resolve(nas, 'recover-lamp', path.join(directory, 'not-exported')), 'csr_original_certificate_not_active');
    } else {
      const issued = await index(nas), exported = await resolve(nas, 'recover-lamp', path.join(directory, 'exported'));
      assert.equal(exported.serial, result.serial); assert.equal(exported.activation_challenge, result.activation_challenge);
      assert.equal(exported.certificate_sha256, result.certificate_sha256); assert.equal(await index(nas), issued);
    }
    assert.deepEqual(await readFile(record), original);
  }
});

test('恢复激活后CRL失败及NAS备份恢复保留原决定，不重复签发或扩大撤销范围', async () => {
  const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), next = await device(directory, 'next');
  const previous = await expiredCertificate(nas, oldKey);
  await exec(python, ['-c', 'import os, sys; os.umask(0o077); sys.path.insert(0, "deploy/nas"); from device_identity import openssl; openssl("ca", "-config", sys.argv[1], "-updatedb")', path.join(nas, 'device-authority/openssl.cnf')], { cwd: root });
  const result = await replacement(nas, next, previous, path.join(directory, 'candidate'));
  const proof = activation(next, result);
  const injected = await exec(python, ['-c', `
import json, os, sys
from pathlib import Path
os.umask(0o077)
sys.path.insert(0, "deploy/nas")
import device_identity, csr_enrollment
def fail(*args):
    raise OSError("crl_failure_fixture")
device_identity.refresh_crl = fail
try:
    csr_enrollment.complete_rotation(Path(sys.argv[1]), "recover-lamp", sys.argv[2])
except OSError:
    print(json.dumps({"injected": "after_activation_and_revoke_before_crl"}))
else:
    raise SystemExit("failure_fixture_did_not_run")
`, nas, proof], { cwd: root });
  assert.equal(JSON.parse(injected.stdout).injected, 'after_activation_and_revoke_before_crl');
  const interrupted = await resolve(nas, 'recover-lamp');
  assert.equal(interrupted.activation_confirmed, true); assert.equal(interrupted.previous_decision, 'revoked');
  assert.equal(interrupted.crl_updated, false); assert.equal(interrupted.rotation_completed, false);
  const operation = path.join(nas, 'device-authority/csr-operations/recover-lamp');
  const intent = await readFile(path.join(operation, 'request.json')), activationFile = await readFile(path.join(operation, 'activation.json'));
  await exec('python3', ['-c', 'import sqlite3, sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table snapshot (id integer primary key check(id=1), version integer not null, config_hash text not null, body text not null)"); c.commit(); c.close()', path.join(nas, 'data/gateway.sqlite')]);
  const backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
  await exec('python3', ['deploy/nas/manage.py', 'backup', '--directory', nas, '--output', backup], { cwd: root });
  await exec('python3', ['deploy/nas/manage.py', 'restore', '--directory', restored, '--backup', backup], { cwd: root });
  const recovered = await resolve(restored, 'recover-lamp');
  assert.equal(recovered.request_sha256, result.request_sha256); assert.equal(recovered.rotation_completed, false);
  const serial = await readFile(path.join(restored, 'device-authority/serial')), before = await index(restored);
  const done = await complete(restored, recovered, proof);
  assert.equal(done.rotation_completed, true); assert.equal(done.schema_version, 3);
  assert.equal(await index(restored), before); assert.deepEqual(await readFile(path.join(restored, 'device-authority/serial')), serial);
  assert.deepEqual(await readFile(path.join(restored, 'device-authority/csr-operations/recover-lamp/request.json')), intent);
  assert.deepEqual(await readFile(path.join(restored, 'device-authority/csr-operations/recover-lamp/activation.json')), activationFile);
  assert.equal((await resolve(nas, 'recover-lamp')).rotation_completed, false, '新目录恢复不修改原测试NAS');
});

test('未完成的v2或v3候选过期后仍阻止新恢复请求，不能利用过期绕过原操作', async () => {
  for (const recovery of [false, true]) {
    const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), next = await device(directory, 'next'), later = await device(directory, 'later');
    const previous = recovery ? await expiredCertificate(nas, oldKey) : await sign(nas, oldKey, path.join(directory, 'initial'));
    const injected = await exec(python, ['-c', `
import json, os, sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
os.umask(0o077)
sys.path.insert(0, "deploy/nas")
import csr_enrollment as enrollment
original = enrollment.openssl
def expired(*args):
    now = datetime.now(timezone.utc)
    return original(*args, "-startdate", (now-timedelta(days=2)).strftime("%Y%m%d%H%M%SZ"), "-enddate", (now-timedelta(days=1)).strftime("%Y%m%d%H%M%SZ"))
enrollment.openssl = expired
try:
    enrollment.sign_csr(Path(sys.argv[1]), "device-lamp", Path(sys.argv[2]), sys.argv[3], "unfinished", Path(sys.argv[4]), (sys.argv[5], sys.argv[6]), recovery=sys.argv[7] == "true")
except ValueError as error:
    print(json.dumps({"error": str(error)}))
else:
    raise SystemExit("expired_candidate_fixture_did_not_run")
`, nas, next.csr, next.fingerprint, path.join(directory, 'expired-candidate'), previous.serial, previous.certificate_sha256, String(recovery)], { cwd: root });
    assert.equal(JSON.parse(injected.stdout).error, 'csr_issuance_unknown_query_original');
    const original = await resolve(nas, 'unfinished');
    assert.equal(original.decision, 'expired'); assert.equal(original.rotation_completed, false);
    await exec('python3', [issuer, 'revoke', '--directory', nas, '--serial', previous.serial]);
    const before = await index(nas);
    await rejected(replacement(nas, later, original, path.join(directory, 'bypass'), 'bypass'), 'pending_csr_enrollment_query_original');
    assert.equal(await index(nas), before);
    await assert.rejects(stat(path.join(nas, 'device-authority/csr-operations/bypass')), { code: 'ENOENT' });
  }
});

test('过期CA不能借设备恢复续用，恢复失败在保存意图及调用CA之前', async () => {
  const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), next = await device(directory, 'next');
  const previous = await expiredCertificate(nas, oldKey);
  await exec(python, ['-c', `
import os, sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
os.umask(0o077)
authority=Path(sys.argv[1]) / "device-authority"
ca=x509.load_pem_x509_certificate((authority/"ca.crt").read_bytes())
key=serialization.load_pem_private_key((authority/"ca.key").read_bytes(), None)
now=datetime.now(timezone.utc)
builder=x509.CertificateBuilder().subject_name(ca.subject).issuer_name(ca.issuer).public_key(ca.public_key()).serial_number(ca.serial_number).not_valid_before(now-timedelta(days=10)).not_valid_after(now-timedelta(hours=1))
for extension in ca.extensions:
    builder=builder.add_extension(extension.value, extension.critical)
(authority/"ca.crt").write_bytes(builder.sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM))
`, nas], { cwd: root });
  const before = await index(nas);
  await rejected(replacement(nas, next, previous, path.join(directory, 'bad-ca')), 'device_ca_expired_or_not_yet_valid');
  assert.equal(await index(nas), before);
  await assert.rejects(stat(path.join(nas, 'device-authority/csr-operations')), { code: 'ENOENT' });
});

test('v3恢复记录的用途、版本、摘要和原CA绑定严格核对，损坏只读拒绝', async () => {
  const { directory, nas } = await setup(), oldKey = await device(directory, 'old'), next = await device(directory, 'next');
  const previous = await expiredCertificate(nas, oldKey);
  const result = await replacement(nas, next, previous, path.join(directory, 'candidate'));
  const record = path.join(nas, 'device-authority/csr-operations/recover-lamp/request.json');
  const original = await readFile(record), value = JSON.parse(original), before = await index(nas);
  const invalid = [
    { ...value, recovery_reason: 'revoked' }, { ...value, recovery_reason: undefined },
    { ...value, schema_version: 2 }, { ...value, schema_version: true },
    { ...value, recovery_reason: 'certificate_expired', extra: 'ignored' },
    { ...value, activation_challenge: '0'.repeat(64) },
  ];
  for (const candidate of invalid) {
    const raw = Buffer.from(JSON.stringify(candidate)); await writeFile(record, raw);
    await rejected(resolve(nas, 'recover-lamp'), 'csr_journal_invalid');
    assert.deepEqual(await readFile(record), raw); assert.equal(await index(nas), before);
  }
  await writeFile(record, original);
  const configPath = path.join(nas, 'config/gateway.json'), config = await readFile(configPath);
  await writeFile(configPath, JSON.stringify({ ...JSON.parse(config), space_id: 'space-other' }));
  await rejected(resolve(nas, 'recover-lamp'), 'csr_space_binding_changed');
  await writeFile(configPath, config);
  assert.equal((await resolve(nas, 'recover-lamp')).request_sha256, result.request_sha256);
  assert.equal(await index(nas), before);
});

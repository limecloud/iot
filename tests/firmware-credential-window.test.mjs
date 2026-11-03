import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const binary = process.env.LIMEIOT_CREDENTIAL_WINDOW_BINARY;
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
async function fixture(kind) {
  assert(binary, '使用npm run test:firmware:credentials构建当前凭据窗口代码');
  const directory = await mkdtemp(path.join(root, '.dev/credential-window-'));
  await exec(python, ['-c', `
import os,sys
from pathlib import Path
from datetime import datetime,timedelta,timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID
os.umask(0o077);p=Path(sys.argv[1]);kind=sys.argv[2];now=datetime.now(timezone.utc).replace(microsecond=0)
ca_key=ec.generate_private_key(ec.SECP256R1());key=ec.generate_private_key(ec.SECP256R1())
ca_name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Window CA')])
ca_start=now+timedelta(days=1) if kind=='future-ca' else now-timedelta(days=2)
ca_end=now-timedelta(days=1) if kind=='expired-ca' else now+timedelta(seconds=4) if kind=='short-ca' else now+timedelta(days=2)
ca=x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key()).serial_number(1).not_valid_before(ca_start).not_valid_after(ca_end).add_extension(x509.BasicConstraints(ca=True,path_length=None),True).add_extension(x509.KeyUsage(False,False,False,False,False,True,True,None,None),True).sign(ca_key,hashes.SHA256())
subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'other-device' if kind=='wrong-cn' else 'device-lamp')])
start=now+timedelta(days=1) if kind=='future-leaf' else now-timedelta(days=2)
end=now-timedelta(days=1) if kind=='expired-leaf' else now+timedelta(seconds=4) if kind=='short-leaf' else now+timedelta(days=2)
signer=ec.generate_private_key(ec.SECP256R1()) if kind=='wrong-ca' else ca_key
leaf=x509.CertificateBuilder().subject_name(subject).issuer_name(ca_name).public_key(key.public_key()).serial_number(2).not_valid_before(start).not_valid_after(end).add_extension(x509.BasicConstraints(ca=False,path_length=None),True).add_extension(x509.KeyUsage(True,False,False,False,False,False,False,None,None),True).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH if kind=='wrong-usage' else ExtendedKeyUsageOID.CLIENT_AUTH]),False).sign(signer,hashes.SHA256())
if kind=='wrong-key': key=ec.generate_private_key(ec.SECP256R1())
(p/'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
(p/'leaf.pem').write_bytes(leaf.public_bytes(serialization.Encoding.PEM));(p/'ca.pem').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
`, directory, kind], { timeout: 5000 });
  return directory;
}
async function check(directory, mode) {
  const { stdout, stderr } = await exec(binary, [path.join(directory, 'key.pem'), path.join(directory, 'leaf.pem'), path.join(directory, 'ca.pem'), mode], { timeout: 15000 });
  assert.equal(stderr, ''); assert(!stdout.includes('PRIVATE KEY')); return JSON.parse(stdout);
}
test('凭据窗口启动前核对固定CA、设备、公钥、用途和双重有效期', async () => {
  const valid = await check(await fixture('valid'), 'check');
  assert.equal(valid.opened, true); assert.equal(valid.initial, true);
  for (const kind of ['wrong-cn', 'wrong-key', 'wrong-ca', 'wrong-usage', 'future-leaf', 'expired-leaf', 'future-ca', 'expired-ca']) {
    const result = await check(await fixture(kind), 'check');
    assert.equal(result.opened, false, kind); assert.equal(result.initial, false, kind);
  }
});
test('可信时钟失效后当前窗口持续拒绝，只有明确重开并完整验证才可恢复', async () => {
  const result = await check(await fixture('valid'), 'clock');
  assert.deepEqual([result.opened, result.initial, result.after, result.restored, result.reopened], [true, true, false, false, true]);
});
for (const kind of ['short-leaf', 'short-ca']) test('真实墙钟到期后拒绝当前及重开窗口：' + kind, { timeout: 20000 }, async () => {
  const directory = await fixture(kind), result = await check(directory, 'expiry');
  assert.deepEqual([result.opened, result.initial, result.after, result.restored, result.reopened], [true, true, false, false, false]);
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, kind, real_wall_clock: true, actual_sdk_crypto: true, window_only: true, esp_mqtt_runtime: false, hardware: false, hardware_status: '用户要求跳过' }, null, 2) + '\n');
});

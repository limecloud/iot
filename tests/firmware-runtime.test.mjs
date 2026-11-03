import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const base = '/api/v1/spaces/space-demo';
for (const mode of ['expiry', 'ca-expiry', 'clock']) {
  const label = { expiry: '叶证书到期', 'ca-expiry': 'CA到期', clock: '时钟失信' }[mode];
  test(`生产ESP适配器宿主旅程：分片/受控重连后${label}，已落盘及已排队命令零新增副作用`, { timeout: 45000 }, async t => {
    const binary = process.env.LIMEIOT_ESP_RUNTIME_BINARY;
    assert.ok(binary, '通过tools/test-firmware-runtime.mjs构建并运行');
    const directory = await mkdtemp(path.join(root, '.dev/esp-runtime-'));
    await mkdir(path.join(directory, 'config'));
    await copyFile(path.join(root, 'deploy/dev/config.json'), path.join(directory, 'config/gateway.json'));
    await exec('python3', ['-c', 'import sys\nfrom pathlib import Path\nsys.path.insert(0,"deploy/nas")\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")', directory], { cwd: root, timeout: 20000 });
    const port = await freePort();
    const stack = await startStack({ directory, brokerTls: { port, ca: path.join(directory, 'broker-tls/ca.crt'), certificate: path.join(directory, 'broker-tls/server.crt'), key: path.join(directory, 'broker-tls/server.key') } });
    t.after(() => stack.close()); await stop(stack.lamp);
    const previousBoot = (await stack.request(base + '/devices/device-lamp')).value.boot_id;
    const host = path.join(directory, 'host'); await mkdir(host, { mode: 0o700 });
    for (const [source, target] of [['ca.crt', 'ca.crt'], ['device.crt', 'device.crt'], ['private.key', 'device.key']]) await copyFile(path.join(directory, 'credentials', source), path.join(host, target));
    const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
    const clock = JSON.parse((await exec(python, ['-c', `
import json,sys
from pathlib import Path
from datetime import datetime,timedelta,timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
p=Path(sys.argv[1]); host=p/'host'; old=x509.load_pem_x509_certificate((host/'device.crt').read_bytes())
key=serialization.load_pem_private_key((p/'device-authority/ca.key').read_bytes(),None)
now=datetime.now(timezone.utc).replace(microsecond=0); ca_mode=sys.argv[2]=='ca-expiry'
if ca_mode:
 ca=x509.load_pem_x509_certificate((host/'ca.crt').read_bytes())
 root=x509.CertificateBuilder().subject_name(ca.subject).issuer_name(ca.issuer).public_key(ca.public_key()).serial_number(ca.serial_number).not_valid_before(now-timedelta(seconds=10)).not_valid_after(now+timedelta(seconds=15))
 for ext in ca.extensions: root=root.add_extension(ext.value,ext.critical)
 (host/'ca.crt').write_bytes(root.sign(key,hashes.SHA256()).public_bytes(serialization.Encoding.PEM))
builder=x509.CertificateBuilder().subject_name(old.subject).issuer_name(old.issuer).public_key(old.public_key()).serial_number(old.serial_number).not_valid_before(now-timedelta(seconds=10)).not_valid_after(now+timedelta(seconds=60 if ca_mode else 15))
for ext in old.extensions: builder=builder.add_extension(ext.value,ext.critical)
cert=builder.sign(key,hashes.SHA256());(host/'device.crt').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
print(json.dumps({'expires_at':(now+timedelta(seconds=15)).isoformat(),'leaf_expires_at':cert.not_valid_after_utc.isoformat(),'ca_expires_at':x509.load_pem_x509_certificate((host/'ca.crt').read_bytes()).not_valid_after_utc.isoformat()}))
`, directory, mode], { cwd: root, timeout: 5000 })).stdout);
    const worker = stack.launch('esp-runtime', binary, [host, String(port), mode]);
    const done = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', (code, signal) => resolve({ code, signal })); }); done.catch(() => {});
    await until(async () => { const d = (await stack.request(base + '/devices/device-lamp')).value; return d.ready && d.boot_id !== previousBoot; }, 8000);
    async function command(key, value) {
      const device = (await stack.request(base + '/devices/device-lamp')).value;
      const response = await stack.request(base + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ device_id: 'device-lamp', model_revision: device.model_revision, expires_at: new Date(Date.now() + 25000).toISOString(), operation: { type: 'property.set', path: 'light.power', value } }) });
      assert.equal(response.status, 202); return response.value;
    }
    const first = await command('runtime-before-' + mode, true);
    await until(async () => (await stack.request(base + '/commands/' + first.command_id)).value.status === 'confirmed');
    const oldSession = (await stack.request(base + '/devices/device-lamp')).value.session_id;
    await writeFile(path.join(host, 'disconnect'), 'explicit host transport fault\n');
    await until(async () => { const d = (await stack.request(base + '/devices/device-lamp')).value; return d.ready && d.session_id !== oldSession; }, 8000);
    assert.ok(Date.parse(clock.expires_at) - Date.now() > 3000, '第二条命令受理时身份仍有效');
    const second = await command('runtime-pending-' + mode, false);
    const intent = await until(async () => readFile(path.join(host, 'pending-intent.json'), 'utf8').then(JSON.parse).catch(() => false));
    assert.equal(intent.command, second.command_id); assert.equal(intent.stage, 1);
    assert.ok(intent.expires_ms > Date.parse(clock.expires_at), '命令自身期限须晚于证书到期');
    assert.deepEqual(await done, { code: 0, signal: null }, `运行日志：${directory}/esp-runtime.log`);
    const result = JSON.parse(await readFile(path.join(host, 'runtime-result.json')));
    assert.equal(result.gated, true); assert.equal(result.locked, true); assert.equal(result.ready, false);
    assert.equal(result.trusted_clock_restored_current, false);
    assert.equal(result.effects_before_invalidation, 1); assert.equal(result.effects_after_invalidation, 0);
    assert.equal(result.connects, 2); assert.equal(result.reconnects, 1); assert.equal(result.stops, 1);
    assert.ok(result.fragments > 10); assert.equal(result.receipt_commits, 4);
    assert.equal(result.publishes_after_gate, 0); assert.equal(result.reconnects_after_gate, 0);
    assert.equal(result.queued_before_gate, 1); assert.equal(result.consumed_after_gate, 1); assert.equal(result.stale_generation, 1);
    for (const key of ['late_events_rejected', 'publish_guard_rejected', 'driver_guard_rejected', 'ota_current_guard_rejected']) assert.equal(result[key], true, key);
    if (mode === 'ca-expiry') assert.ok(Date.parse(clock.leaf_expires_at) > Date.now(), 'CA到期时叶证书自身仍有效');
    const firstReceipt = JSON.parse(await readFile(path.join(host, 'nvs-1-r00.json')));
    const secondReceipt = JSON.parse(await readFile(path.join(host, 'nvs-1-r01.json')));
    assert.equal(firstReceipt.command, first.command_id); assert.equal(firstReceipt.stage, 2);
    assert.equal(secondReceipt.command, intent.command); assert.equal(secondReceipt.fingerprint, intent.fingerprint);
    assert.equal(secondReceipt.session, intent.session); assert.equal(secondReceipt.stage, 3); assert.equal(secondReceipt.error, 'driver_failed');
    assert.deepEqual(JSON.parse(await readFile(path.join(host, 'effects.json'))), { effects: 1, effects_after_invalidation: 0 });
    assert.deepEqual((await stack.request(base + '/commands')).value.items.map(c => c.command_id).sort(), [first.command_id, second.command_id].sort());
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ...result, status: 'passed', invalidation: mode, certificate_expires_at: clock.expires_at, accepted_commands: 2, original_intent_and_result_preserved: true, real_broker_and_gateway: true, identity_crypto: 'fixed-sdk-mbedtls', transport: 'libmosquitto-openssl', fixtures: ['freertos-queue-task', 'file-backed-nvs', 'lamp-driver', 'ota-crypto-and-ports'], esp_mqtt_runtime: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
    t.diagnostic('证据目录：' + directory);
  });
}

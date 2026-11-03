import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';
import { tvAgentRuntime } from './helpers/tv-agent.mjs';

const exec = promisify(execFile);
const base = '/api/v1/spaces/space-demo';
test('TV真实长连接到期：已存TLS工厂拒绝连接，已耐久待执行命令零新增副作用', { timeout: 60000 }, async t => {
  const runtime = await tvAgentRuntime();
  const directory = await mkdtemp(path.join(root, '.dev/tv-identity-expiry-'));
  await mkdir(path.join(directory, 'config'));
  const modelPath = path.join(root, 'contracts/models/android-tv-agent.json');
  const validation = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'model', 'validate', '--input', modelPath], { cwd: root, env: { ...process.env, LIMEIOT_MODEL_VALIDATOR: process.env.LIMEIOT_MODEL_VALIDATOR ?? path.join(root, 'target/debug/limeiot-model-validator') }, timeout: 5000 })).stdout);
  assert.equal(validation.valid, true);
  const config = JSON.parse(await readFile(path.join(root, 'deploy/dev/config.json')));
  config.models[0] = validation.normalized_model; config.devices[0].model_revision = validation.model_revision;
  const configFile = path.join(directory, 'config/gateway.json'); await writeFile(configFile, JSON.stringify(config));
  await exec('python3', ['-c', 'import sys\nfrom pathlib import Path\nsys.path.insert(0,"deploy/nas")\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")', directory], { cwd: root, timeout: 20000 });
  const tlsPort = await freePort();
  const stack = await startStack({ directory, modelPaths: { lamp: modelPath }, gatewayEnv: { LIMEIOT_CONFIG: configFile }, brokerTls: { port: tlsPort, ca: path.join(directory, 'broker-tls/ca.crt'), certificate: path.join(directory, 'broker-tls/server.crt'), key: path.join(directory, 'broker-tls/server.key') } });
  t.after(() => stack.close()); await stop(stack.lamp);
  const previousBoot = (await stack.request(base + '/devices/device-lamp')).value.boot_id;
  const python = process.env.LIMEIOT_TV_AGENT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
  const clock = JSON.parse((await exec(python, ['-c', `
import json,sys
from pathlib import Path
from datetime import datetime,timedelta,timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
p=Path(sys.argv[1]); old=x509.load_pem_x509_certificate((p/'credentials/device.crt').read_bytes())
key=serialization.load_pem_private_key((p/'device-authority/ca.key').read_bytes(),None)
now=datetime.now(timezone.utc).replace(microsecond=0)
builder=x509.CertificateBuilder().subject_name(old.subject).issuer_name(old.issuer).public_key(old.public_key()).serial_number(old.serial_number).not_valid_before(now-timedelta(seconds=10)).not_valid_after(now+timedelta(seconds=15))
for ext in old.extensions: builder=builder.add_extension(ext.value,ext.critical)
cert=builder.sign(key,hashes.SHA256());(p/'credentials/device.crt').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
print(json.dumps({'expires_at':cert.not_valid_after_utc.isoformat()}))
`, directory], { cwd: root, timeout: 5000 })).stdout);
  await exec('python3', ['tools/tv-agent-enrollment.py', '--identity-directory', path.join(directory, 'credentials'), '--broker', 'ssl://127.0.0.1:' + tlsPort, '--output', path.join(directory, 'credentials/enrollment.json')], { cwd: root, timeout: 5000 });
  const args = [...runtime.args]; args[args.length - 1] = 'run.limeai.iot.device.IdentityExpiryJourneyMain';
  const worker = spawn(runtime.executable, args, { cwd: root, env: { ...process.env, LIMEIOT_TV_AGENT_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(directory, 'jvm.log')); worker.stdout.pipe(log); worker.stderr.pipe(log); worker.once('exit', () => log.end());
  const done = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', code => resolve(code)); }); done.catch(() => {});
  t.after(() => stop(worker));
  await until(async () => { const device = (await stack.request(base + '/devices/device-lamp')).value; return device.ready && device.boot_id !== previousBoot; }, 8000);
  async function command(key) {
    const response = await stack.request(base + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ device_id: 'device-lamp', model_revision: validation.model_revision, expires_at: new Date(Date.now() + 25000).toISOString(), operation: { type: 'action.invoke', path: 'apps.launch', value: { application_id: 'com.example.player' } } }) });
    assert.equal(response.status, 202); return response.value;
  }
  const first = await command('expiry-before');
  await until(async () => (await stack.request(base + '/commands/' + first.command_id)).value.status === 'confirmed');
  assert.ok(Date.parse(clock.expires_at) - Date.now() > 3000, '必须在证书仍有效时提交第二条命令');
  const second = await command('expiry-pending');
  await until(async () => readFile(path.join(directory, 'expiry-pending')).then(() => true).catch(() => false));
  assert.equal(await done, 0);
  const result = JSON.parse(await readFile(path.join(directory, 'expiry-result.json')));
  assert.equal(result.effects_before_expiry, 1); assert.equal(result.effects_after_expiry, 0);
  assert.deepEqual((await stack.request(base + '/commands')).value.items.map(c => c.command_id).sort(), [first.command_id, second.command_id].sort());
  const effects = (await readFile(path.join(directory, 'expiry-effects.jsonl'), 'utf8')).trim().split('\n'); assert.equal(effects.length, 1);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ...result, certificate_expires_at: clock.expires_at, accepted_commands: 2, command_deadline_after_certificate_expiry: true, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
});

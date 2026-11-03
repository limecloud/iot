import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { commands, persistentSnapshot, cloneHost, hash, json, publishFixture } from './support/firmware-recovery.mjs';

const exec = promisify(execFile);
const base = '/api/v1/spaces/space-demo', topic = 'limeiot/v1/space-demo/device-lamp';
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const issuer = path.join(root, 'deploy/nas/device_identity.py');
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json')));
let commandRecoveryFixture;

async function startupFailures({ binary, host, port, directory, withOta }) {
  const cases = ['receipt-malformed', 'receipt-future', 'receipt-read-size', 'receipt-read-data'];
  if (withOta) cases.push('ota-malformed', 'ota-future', 'ota-read-size', 'ota-read-data');
  const results = [], original = await persistentSnapshot(host);
  await mkdir(path.join(directory, 'start-failures'), { mode: 0o700 });
  for (const mode of cases) {
    const isolated = path.join(directory, 'start-failures', mode);
    await cloneHost(host, isolated);
    const file = path.join(isolated, mode.startsWith('receipt-') ? 'nvs-1-r00.json' : 'nvs-2-state.json');
    if (mode.endsWith('-malformed')) await writeFile(file, '{"version":', { mode: 0o600 });
    if (mode.endsWith('-future')) {
      const record = await json(file); record.version = mode.startsWith('receipt-') ? 2 : 3;
      if (mode.startsWith('ota-')) { delete record.checksum; record.checksum = await documentDigest(record); }
      await writeFile(file, JSON.stringify(record), { mode: 0o600 });
    }
    const before = await persistentSnapshot(isolated);
    const result = await exec(binary, [isolated, String(port), 'start-check', ...(mode.includes('-read-') ? [mode] : [])], { cwd: root, timeout: 5000 });
    assert.equal(result.stderr, '', mode); assert(!result.stdout.includes('PRIVATE KEY'));
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed, { start_code: 'storage_unavailable', adapter_created: false, task_created: false, mqtt_inits: 0, connects: 0,
      process_effects: 0, receipt_writes: 0, ota_writes: 0, identity_writes: 0, read_failures: mode.includes('-read-') ? 1 : 0 }, mode);
    assert.deepEqual(await persistentSnapshot(isolated), before, mode + '拒绝时保留全部原记录');
    results.push({ mode, ...observed, persistent_sha256: before });
  }
  assert.deepEqual(await persistentSnapshot(host), original, '故障副本不影响换证后的原持久目录');
  await writeFile(path.join(directory, 'startup-failures.json'), JSON.stringify({ status: 'passed', cases: results }, null, 2) + '\n');
  return results;
}

async function commandFailures({ binary, host, port, directory, stack, probe, command }) {
  const results = [], original = await persistentSnapshot(host);
  await mkdir(path.join(directory, 'commit-failures'), { mode: 0o700 });
  async function launch(folder, mode) {
    const previous = (await stack.request(base + '/devices/device-lamp')).value;
    const child = stack.launch('commit-' + mode, binary, [folder, String(port), 'after', ...(mode.endsWith('-reopen') ? [] : [mode])]);
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); done.catch(() => {});
    await until(async () => { const value = (await stack.request(base + '/devices/device-lamp')).value; return value.ready && value.boot_id !== previous.boot_id; }, 8000);
    await until(() => json(path.join(folder, 'recovery-check.json')));
    return { child, done };
  }
  for (const mode of ['intent-before', 'intent-after', 'terminal-before', 'terminal-after']) {
    const isolated = path.join(directory, 'commit-failures', mode);
    await cloneHost(host, isolated);
    const prior = await persistentSnapshot(isolated), terminal = mode.startsWith('terminal-'), after = mode.endsWith('-after');
    const worker = await launch(isolated, mode);
    const accepted = await command('commit-' + mode, 'applied', true, isolated);
    const observed = await until(async () => { const value = await json(path.join(isolated, 'recovery-observed.json')); return value.commands_received === 1 && value; });
    assert.equal(observed.receipt_commit_failures, 1, mode); assert.equal(observed.receipt_commit_attempts, terminal ? 2 : 1, mode);
    assert.equal(observed.process_effects, terminal ? 1 : 0, mode);
    assert.equal(observed.receipt_writes, (terminal ? 1 : 0) + Number(after), mode);
    const record = (await stack.request(base + '/commands/' + accepted.command_id)).value;
    assert(record.envelope); const envelope = JSON.stringify(record.envelope);
    assert(!['confirmed', 'failed'].includes(record.status), mode + '不公布未耐久确认的终态');
    const durable = await persistentSnapshot(isolated), target = [];
    for (const name of Object.keys(durable).filter(name => name.startsWith('nvs-1-'))) {
      const receipt = await json(path.join(isolated, name));
      if (receipt.command === accepted.command_id) { target.push(name); assert.equal(receipt.stage, terminal && after ? 2 : 1, mode); }
    }
    assert.equal(target.length, terminal || after ? 1 : 0, mode);
    for (const [name, digest] of Object.entries(prior)) if (!target.includes(name)) assert.equal(durable[name], digest, mode + '/' + name);
    await probe.publish(topic + '/down/command', envelope);
    await until(async () => (await json(path.join(isolated, 'recovery-observed.json'))).commands_received === 2);
    // 网关FIFO保留前一条未决；用获准的测试网关探针独立验证端侧的新意图拒绝。
    const later = structuredClone(record.envelope);
    later.message_id = later.body.command_id = 'storage-later-' + mode;
    await probe.publish(topic + '/down/command', JSON.stringify(later));
    const repeated = await until(async () => { const value = await json(path.join(isolated, 'recovery-observed.json')); return value.commands_received === 3 && value; });
    assert.equal(repeated.process_effects, observed.process_effects, mode); assert.equal(repeated.receipt_commit_attempts, observed.receipt_commit_attempts, mode);
    assert.equal(repeated.receipt_writes, observed.receipt_writes, mode); assert.deepEqual(await persistentSnapshot(isolated), durable, mode);
    await stop(worker.child); assert.deepEqual(await worker.done, { code: 0, signal: null });
    const completed = await json(path.join(isolated, 'recovery-after-result.json'));
    assert.equal(completed.identity_writes, 0); assert.equal(completed.ota_writes, 0); assert.equal(completed.effects_after_invalidation, 0);
    await stack.restartGateway();
    const reopened = isolated + '-reopen'; await cloneHost(isolated, reopened);
    const next = await launch(reopened, mode + '-reopen');
    assert.deepEqual(await persistentSnapshot(reopened), durable, mode + '重开仅恢复持久事实');
    await probe.publish(topic + '/down/command', envelope);
    const stale = await until(async () => { const value = await json(path.join(reopened, 'recovery-observed.json')); return value.commands_received === 1 && value; });
    assert.equal(stale.process_effects, 0); assert.equal(stale.receipt_writes, 0);
    const fresh = await command('commit-' + mode + '-fresh', 'applied', false, reopened);
    await until(async () => (await stack.request(base + '/commands/' + fresh.command_id)).value.status === 'confirmed');
    await stop(next.child); assert.deepEqual(await next.done, { code: 0, signal: null });
    const recovered = await json(path.join(reopened, 'recovery-after-result.json'));
    assert.equal(recovered.process_effects, 1); assert.equal(recovered.receipt_commit_failures, 0); assert.equal(recovered.identity_writes, 0);
    assert.equal((await stack.request(base + '/commands/' + accepted.command_id)).value.status, 'unknown');
    results.push({ mode, observed, repeated, completed, recovered, gateway_sqlite_reopened: true, durable_sha256: durable, original_envelope_sha256: hash(envelope) });
  }
  assert.deepEqual(await persistentSnapshot(host), original);
  await writeFile(path.join(directory, 'commit-failures.json'), JSON.stringify({ status: 'passed', cases: results }, null, 2) + '\n');
  return results;
}

for (const withOta of [false, true]) {
  test(`实际C身份存储换证后新进程恢复：原命令${withOta ? '及未决OTA占用' : '与明确新命令'}连续`, { timeout: 60000 }, async t => {
    const binary = process.env.LIMEIOT_ESP_RUNTIME_BINARY, identityBinary = process.env.LIMEIOT_IDENTITY_HOST_BINARY;
    assert(binary && identityBinary, '使用test:firmware:recovery构建当前源码');
    const directory = await mkdtemp(path.join(root, '.dev/esp-recovery-'));
    const host = path.join(directory, 'host'), ca = path.join(directory, 'device-authority/ca.crt');
    await mkdir(host, { mode: 0o700 }); await mkdir(path.join(directory, 'config'), { mode: 0o700 });
    await writeFile(path.join(directory, 'config/gateway.json'), await readFile(path.join(root, 'deploy/dev/config.json')), { mode: 0o600 });
    await exec(python, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,"deploy/nas"); import device_identity; device_identity.initialize(Path(sys.argv[1]),"127.0.0.1")', directory], { cwd: root });
    await writeFile(path.join(host, 'ca.crt'), await readFile(ca), { mode: 0o600 });
    await writeFile(path.join(host, 'root.bin'), randomBytes(32), { mode: 0o600 });
    await writeFile(path.join(host, 'driver-mode'), 'applied\n', { mode: 0o600 });
    await exec(python, ['-c', 'import os,sys; from pathlib import Path; os.umask(0o077); sys.path.insert(0,"firmware/tools"); from nvs_hmac import binding_image; p=Path(sys.argv[1]); (p/"binding.bin").write_bytes(binding_image((p/"root.bin").read_bytes(),0,"device-lamp","space-demo"))', host], { cwd: root });
    async function drive(action, extra = []) {
      const result = await exec(identityBinary, [host, ca, action, 'valid', 'device-lamp', ...extra], { cwd: root, timeout: 5000 });
      assert.equal(result.stderr, ''); assert(!result.stdout.includes('PRIVATE KEY')); return JSON.parse(result.stdout);
    }
    const candidate = await drive('request'); assert.equal(candidate.code, 'ok');
    const port = await freePort();
    const stack = await startStack({ directory, brokerTls: { port, ca, certificate: path.join(directory, 'broker-tls/server.crt'), key: path.join(directory, 'broker-tls/server.key') } });
    t.after(() => stack.close()); await stop(stack.lamp);
    const configuration = path.join(directory, 'mosquitto.conf');
    await writeFile(configuration, (await readFile(configuration, 'utf8')).replace('require_certificate true\n', `require_certificate true\ncrlfile ${path.join(directory, 'broker-tls/revoked.crl')}\n`));
    async function restartBroker() {
      await stop(stack.broker); stack.broker = stack.launch('recovery-broker', path.join(root, '.dev/tools/mosquitto-build/src/mosquitto'), ['-c', configuration]);
      await until(async () => (await stack.request('/healthz')).value.broker_connected);
    }
    await restartBroker();
    const signed = JSON.parse((await exec(python, ['-c', `
import json,os,sys
from pathlib import Path
from datetime import datetime,timedelta,timezone
os.umask(0o077)
sys.path.insert(0,"deploy/nas"); import csr_enrollment as e
original=e.openssl
def short(*args):
 if args[0]=="ca" and "-in" in args:
  now=datetime.now(timezone.utc)
  args=(*args,"-startdate",(now-timedelta(days=1)).strftime("%Y%m%d%H%M%SZ"),"-enddate",(now+timedelta(seconds=15)).strftime("%Y%m%d%H%M%SZ"))
 return original(*args)
e.openssl=short
print(json.dumps(e.sign_csr(Path(sys.argv[1]),"device-lamp",Path(sys.argv[2]),sys.argv[3],"recovery-initial",Path(sys.argv[4]))))
`, directory, path.join(host, 'request.csr'), candidate.fingerprint, path.join(directory, 'initial')], { cwd: root, timeout: 5000 })).stdout);
    assert.equal((await drive('import', [path.join(signed.output, 'device.crt')])).code, 'ok');
    const previous = (await stack.request(base + '/devices/device-lamp')).value;
    const beforeWorker = stack.launch('identity-before', binary, [host, String(port), 'before']);
    const beforeDone = new Promise((resolve, reject) => { beforeWorker.once('error', reject); beforeWorker.once('exit', (code, signal) => resolve({ code, signal })); }); beforeDone.catch(() => {});
    const device = await until(async () => { const d = (await stack.request(base + '/devices/device-lamp')).value; return d.ready && d.boot_id !== previous.boot_id && d; }, 8000);
    const command = commands(stack, host);
    const confirmed = await command('recovery-confirmed', 'applied', true);
    await until(async () => (await stack.request(base + '/commands/' + confirmed.command_id)).value.status === 'confirmed');
    const failed = await command('recovery-failed', 'failed', false);
    await until(async () => (await stack.request(base + '/commands/' + failed.command_id)).value.status === 'failed');
    const unknown = await command('recovery-unknown', 'unknown', false);
    await until(async () => (await json(path.join(host, 'effects-total.json'))).total_effects === 2);
    const receipts = {};
    for (const [slot, command, stage] of [[0, confirmed, 2], [1, failed, 3], [2, unknown, 1]]) {
      const name = `nvs-1-r0${slot}.json`, data = await readFile(path.join(host, name));
      assert.equal(JSON.parse(data).command, command.command_id); assert.equal(JSON.parse(data).stage, stage); receipts[name] = data;
    }
    let ota;
    if (withOta) {
      const manifest = structuredClone(vector.request.manifest);
      ota = { v: 1, kind: 'ota_install', message_id: 'recovery-install', device_id: 'device-lamp', model_revision: device.model_revision, boot_id: device.boot_id, session_id: device.session_id,
        body: { task_id: 'ota-recovery-task', execution_id: 'recovery-execution', manifest_digest: await documentDigest(manifest), manifest, expires_at: new Date(Date.now() + 60000).toISOString() } };
      await publishFixture(host, 'prepare-ota.json', ota);
      await until(async () => (await json(path.join(host, 'ota-seeded.json'))).production_log_api);
    }
    assert.deepEqual(await beforeDone, { code: 0, signal: null }, `运行日志：${directory}/identity-before.log`);
    const before = await json(path.join(host, 'recovery-before-result.json'));
    assert.equal(before.locked, true); assert.equal(before.ready, false); assert.equal(before.stops, 1); assert.equal(before.connects, 1);
    assert.equal(before.process_effects, 2); assert.equal(before.effects_after_invalidation, 0); assert.equal(before.identity_writes, 0);
    assert.equal(before.receipt_writes, 5); assert.equal(before.ota_writes, withOta ? 2 : 0);
    const oldEnvelope = await readFile(path.join(host, 'old-command.json'), 'utf8'); assert.equal(JSON.parse(oldEnvelope).body.command_id, confirmed.command_id);
    const otaBytes = withOta ? await readFile(path.join(host, 'nvs-2-state.json')) : null;
    assert.equal((await drive('credentials')).code, 'invalid');
    const id = 'runtime-expired-maintenance';
    const newCandidate = await drive('recover-request', [id]); assert.equal(newCandidate.code, 'ok'); assert.notEqual(newCandidate.fingerprint, candidate.fingerprint);
    const originalCsr = await readFile(path.join(host, 'request.csr')), pendingIdentity = await readFile(path.join(host, 'identity.blob'));
    const repeated = await drive('recover-request', [id]); assert.equal(repeated.writes, 0);
    assert.deepEqual(await readFile(path.join(host, 'request.csr')), originalCsr); assert.deepEqual(await readFile(path.join(host, 'identity.blob')), pendingIdentity);
    const maintained = JSON.parse((await exec(python, [issuer, 'recover-csr', '--directory', directory, '--device-id', 'device-lamp', '--csr', path.join(host, 'request.csr'), '--public-key-fingerprint', newCandidate.fingerprint, '--request-id', id, '--output', path.join(directory, 'maintained'), '--previous-serial', signed.serial, '--previous-certificate-fingerprint', signed.certificate_sha256], { cwd: root, timeout: 5000 })).stdout);
    assert.equal(maintained.schema_version, 3);
    assert.equal((await drive('rotate-import', [id, path.join(maintained.output, 'device.crt')])).code, 'ok');
    const proof = await drive('proof', [id, maintained.activation_challenge]); assert.equal(proof.code, 'ok');
    const complete = JSON.parse((await exec(python, [issuer, 'complete-rotation', '--directory', directory, '--request-id', id, '--activation-proof', proof.proof], { cwd: root, timeout: 5000 })).stdout);
    assert.equal(complete.rotation_completed, true);
    await restartBroker(); await stack.restartGateway();
    const startupFailureCases = await startupFailures({ binary, host, port, directory, withOta });
    const afterWorker = stack.launch('identity-after', binary, [host, String(port), 'after']);
    const afterDone = new Promise((resolve, reject) => { afterWorker.once('error', reject); afterWorker.once('exit', (code, signal) => resolve({ code, signal })); }); afterDone.catch(() => {});
    const restored = await until(async () => { const d = (await stack.request(base + '/devices/device-lamp')).value; return d.ready && d.boot_id !== device.boot_id && d; }, 8000);
    assert.notEqual(restored.session_id, device.session_id);
    const recovery = await until(async () => json(path.join(host, 'recovery-check.json')));
    assert.equal(recovery.effects_at_recovery, 0); assert.equal(recovery.receipt_writes_at_recovery, 0); assert.equal(recovery.ota_writes_at_recovery, 0); assert.equal(recovery.old_session_rejected, true);
    assert.equal(recovery.ota_blocked, withOta); assert.equal(recovery.ota_recovered, withOta); assert.equal(recovery.ota_queries_read_only, withOta);
    for (const [name, bytes] of Object.entries(receipts)) assert.deepEqual(await readFile(path.join(host, name)), bytes);
    if (withOta) assert.deepEqual(await readFile(path.join(host, 'nvs-2-state.json')), otaBytes);
    const history = (await stack.request(base + '/commands')).value.items;
    assert.equal(history.find(c => c.command_id === confirmed.command_id).status, 'confirmed');
    assert.equal(history.find(c => c.command_id === failed.command_id).status, 'failed');
    assert.equal(history.find(c => c.command_id === unknown.command_id).status, 'unknown');
    const probe = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'gateway', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => probe.close());
    await probe.publish(topic + '/down/command', oldEnvelope);
    await until(async () => (await json(path.join(host, 'recovery-observed.json'))).commands_received === 1);
    assert.equal((await json(path.join(host, 'effects-total.json'))).total_effects, 2);
    if (!withOta) {
      const fresh = await command('recovery-new-command', 'applied', true);
      await until(async () => (await stack.request(base + '/commands/' + fresh.command_id)).value.status === 'confirmed');
      assert.equal((await json(path.join(host, 'effects-total.json'))).total_effects, 3);
    } else {
      const current = (await stack.request(base + '/devices/device-lamp')).value;
      const query = { v: 1, kind: 'ota_query', message_id: 'recovery-query', device_id: 'device-lamp', model_revision: current.model_revision, boot_id: current.boot_id, session_id: current.session_id,
        body: { task_id: ota.body.task_id, execution_id: ota.body.execution_id, request_digest: await documentDigest(ota), manifest_digest: ota.body.manifest_digest, expires_at: new Date(Date.now() + 20000).toISOString() } };
      await probe.publish(topic + '/down/ota_query', JSON.stringify(query));
      const observed = await until(async () => { const value = await json(path.join(host, 'recovery-observed.json')); return value.ota_queries_received === 1 && value; });
      assert.equal(observed.process_effects, 0); assert.equal(observed.receipt_writes, 0); assert.equal(observed.ota_writes, 0);
    }
    await stop(afterWorker); assert.deepEqual(await afterDone, { code: 0, signal: null });
    const after = await json(path.join(host, 'recovery-after-result.json'));
    assert.equal(after.identity_generation, 1); assert.equal(after.public_key_fingerprint, newCandidate.fingerprint); assert.equal(after.certificate_fingerprint, maintained.certificate_sha256);
    assert.equal(after.ready, true); assert.equal(after.locked, false); assert.equal(after.connects, 1); assert.equal(after.identity_writes, 0);
    assert.equal(after.process_effects, withOta ? 0 : 1); assert.equal(after.total_effects, withOta ? 2 : 3); assert.equal(after.effects_after_invalidation, 0); assert.equal(after.ota_writes, 0);
    if (withOta) {
      assert.deepEqual(await readFile(path.join(host, 'nvs-2-state.json')), otaBytes);
      const log = JSON.parse(otaBytes); assert.deepEqual(log.records[0].request, ota); assert.equal(log.records[0].stage, 'installing');
    }
    const names = await readdir(host); assert(!names.includes('device.key') && !names.includes('private.key'));
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: 'passed', with_ota: withOta, before, recovery, after, startup_failure_cases: startupFailureCases, real_nas_maintenance: true, original_csr_recovered: true, crl_enabled: true, gateway_sqlite_reopened: true, old_command_envelope_sha256: hash(oldEnvelope), original_receipt_sha256: Object.fromEntries(Object.entries(receipts).map(([k,v]) => [k,hash(v)])), ota_log_sha256: otaBytes && hash(otaBytes), existing_ota_log_recovery: withOta, actual_installation: false, private_key_tool_export: false, same_process_identity_tls: true, esp_mqtt_runtime: false, hardware: false, full_goal_completed: false }, null, 2) + '\n');
    if (!withOta) {
      commandRecoveryFixture = { host, directory, ca };
      if (process.env.LIMEIOT_RECOVERY_FIXTURE_OUTPUT) await writeFile(process.env.LIMEIOT_RECOVERY_FIXTURE_OUTPUT, JSON.stringify({ ...commandRecoveryFixture, report_sha256: hash(await readFile(path.join(directory, 'report.json'))) }) + '\n', { mode: 0o600 });
    }
    t.diagnostic('证据目录：' + directory);
  });
}

test('换证后命令意图/终态提交前后故障：当前实例停止新写入，重开不补发', { timeout: 60000 }, async t => {
  assert(commandRecoveryFixture, '本轮常规身份恢复须先通过，不复用旧运行目录');
  const binary = process.env.LIMEIOT_ESP_RUNTIME_BINARY, source = commandRecoveryFixture;
  const directory = await mkdtemp(path.join(root, '.dev/esp-recovery-commits-')), port = await freePort();
  const stack = await startStack({ directory, brokerTls: { port, ca: source.ca, certificate: path.join(source.directory, 'broker-tls/server.crt'), key: path.join(source.directory, 'broker-tls/server.key') } });
  t.after(() => stack.close()); await stop(stack.lamp);
  const probe = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'gateway', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => probe.close());
  const cases = await commandFailures({ binary, host: source.host, port, directory, stack, probe, command: commands(stack, source.host) });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ status: 'passed', scope: 'post-maintenance-command-commit-failures', source_report: path.relative(root, path.join(source.directory, 'report.json')), source_report_sha256: hash(await readFile(path.join(source.directory, 'report.json'))), cases, same_process_identity_tls: true, actual_installation: false, esp_mqtt_runtime: false, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('证据目录：' + directory);
});

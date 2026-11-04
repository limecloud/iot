import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, request as httpsRequest } from 'node:https';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, freePort, until } from './dev-stack.mjs';
import { inspectNasImages, nasImageOverrides, nasVerificationPlatform, verifyNasMachine } from './nas-verification-platform.mjs';
import { thresholdRule } from '../tests/fixtures/zigbee/runtime.mjs';

const execute = promisify(execFile), { values } = parseArgs({ options: { image: { type: 'string' }, platform: { type: 'string' }, dynamic: { type: 'boolean', default: false } } });
assert.match(values.image ?? '', /^limeiot\/verification:[A-Za-z0-9_.-]+$/, 'provide a local verification image');
const directory = path.join(root, '.dev/nas-onoff-' + randomBytes(8).toString('hex'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const project = 'limeiot-onoff-' + randomBytes(6).toString('hex'), manager = path.join(root, 'deploy/nas/manage.py');
const installation = path.join(directory, 'installation'), backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
const overrideFile = path.join(directory, 'compose.test.json'), base = '/api/v1/spaces/space-demo';
const report = { passed: false, hardware: false, hardware_acceptance: 'skipped_by_user', published: false, full_goal_completed: false };
let state = installation, docker, prefix, origin, mqttTlsPort, owner, agent, session, started = false, browser;
const fixtures = [];
const composeEnvironment = () => ({ ...process.env, LIMEIOT_STATE_DIR: state, LIMEIOT_BIND_HOST: '127.0.0.1', ...(mqttTlsPort ? { LIMEIOT_MQTT_TLS_PORT: mqttTlsPort } : {}) });
async function run(command, args, log) {
  try { const result = await execute(command, args, { cwd: root, timeout: 120000, maxBuffer: 4_000_000, env: composeEnvironment() }); if (log) await writeFile(path.join(directory, log), result.stdout + result.stderr); return result.stdout.trim(); }
  catch (error) { if (log) await writeFile(path.join(directory, log), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error; }
}
async function compose(args, log) {
  const envFile = path.join(state, 'compose.env');
  // compose.env内已保存本次独立安装路径，不复用用户已有安装。
  return run(docker, [...prefix, '--project-name', project, '--env-file', envFile, '-f', path.join(root, 'deploy/nas/compose.yaml'), '-f', overrideFile, ...args], log);
}
function call(resource, { input, key, authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const request = httpsRequest(origin + resource, { agent, method: input === undefined ? 'GET' : 'POST', headers: {
      Origin: origin, ...(authenticated && session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}),
    } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 2_000_000) request.destroy(new Error('response_too_large')); else chunks.push(chunk); });
      response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, value: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
    });
    request.setTimeout(5000, () => request.destroy(new Error('https_timeout'))); request.on('error', reject); request.end(body);
  });
}
async function login() {
  const response = await call('/api/v1/auth/session', { authenticated: false, input: { token: owner } }); assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('__Host-limeiot_session='));
  assert.ok(cookie?.includes('Secure') && cookie.includes('HttpOnly'));
  session = { cookie: cookie.split(';')[0], csrf: response.value.csrf_token };
}
const light = async () => (await call(base + '/devices/zigbee-light')).value;
const sensor = async () => (await call(base + '/devices/zigbee-environment')).value;
const commands = async () => (await call(base + '/commands')).value.items;
async function ncp(phase) {
  const child = spawn(docker, [...prefix, '--project-name', project, '--env-file', path.join(state, 'compose.env'), '-f', path.join(root, 'deploy/nas/compose.yaml'), '-f', overrideFile, 'exec', '-T', 'gateway', 'python3', '-u', '/fixture/tests/fixtures/zigbee/onoff_ncp.py', '/tmp/ncp-requests.json'], { cwd: root, env: composeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const fixture = { child, phase, messages: [], pending: '', stderr: '', sequence: 0 }; fixtures.push(fixture);
  child.on('error', error => { fixture.error = error; }); child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { fixture.stderr += chunk; });
  child.stdout.on('data', chunk => { fixture.pending += chunk; while (fixture.pending.includes('\n')) {
    const at = fixture.pending.indexOf('\n'), line = fixture.pending.slice(0, at); fixture.pending = fixture.pending.slice(at + 1);
    try { fixture.messages.push(JSON.parse(line)); } catch { fixture.error = new Error('invalid_ncp_output: ' + line); }
  } });
  const ready = await until(() => { if (fixture.error) throw fixture.error; assert.equal(child.exitCode, null, fixture.stderr); return fixture.messages.find(value => value.type === 'ready'); }, 10000);
  assert.equal(ready.serial, '/dev/pts/0');
  async function send(input, type = 'ack') {
    assert.equal(child.exitCode, null, fixture.stderr); const id = ++fixture.sequence; child.stdin.write(JSON.stringify({ ...input, id }) + '\n');
    const result = await until(() => { if (fixture.error) throw fixture.error; return fixture.messages.find(value => value.type === type && value.id === id); }, 5000);
    if (type === 'stats') assert.deepEqual(result.errors, []); return result;
  }
  return { send, stats: () => send({ type: 'inspect' }, 'stats') };
}
async function snapshot(at) {
  return JSON.parse(await run('python3', ['-c', 'import sqlite3,json,sys,hashlib; d=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); r=d.execute("SELECT version,config_hash,body FROM snapshot WHERE id=1").fetchone(); print(json.dumps({"integrity":d.execute("PRAGMA integrity_check").fetchone()[0],"version":r[0],"config_hash":r[1],"body_sha256":hashlib.sha256(r[2].encode()).hexdigest()}))', path.join(at, 'data/gateway.sqlite')]));
}
try {
  try { await execute('docker', ['compose', 'version']); docker = 'docker'; prefix = ['compose']; } catch { await execute('docker-compose', ['version']); docker = 'docker-compose'; prefix = []; }
  const daemon = (await execute('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).stdout.trim();
  const platform = nasVerificationPlatform(values.platform, daemon); report.target_platform = platform; report.emulated = platform !== daemon;
  const images = await inspectNasImages({ gateway: values.image, lamp: values.image, button: values.image, edge: process.env.LIMEIOT_TEST_NGINX_IMAGE ?? 'nginxinc/nginx-unprivileged:1.29-alpine' }, platform); report.images = images;
  const labels = JSON.parse((await execute('docker', ['image', 'inspect', images.gateway.id, '--format', '{{json .Config.Labels}}'])).stdout);
  assert.match(labels?.['run.limeiot.source-digest'] ?? '', /^[a-f0-9]{64}$/); report.source_digest = labels['run.limeiot.source-digest'];
  origin = `https://127.0.0.1:${await freePort()}`;
  mqttTlsPort = String(await freePort());
  await run('python3', [manager, 'init', '--directory', state, '--origin', origin], 'init.log');
  const config = JSON.parse(await readFile(path.join(root, values.dynamic ? 'deploy/dev/config.json' : 'deploy/dev/zigbee-onoff-gateway.example.json'), 'utf8'));
  const sources = values.dynamic ? { schema_version: 2, bindings: [], coordinators: [{ coordinator_id: 'home-znp', serial: '/dev/pts/0', coordinator_ieee: '0102030405060708', timeout_ms: 1500, poll_interval_ms: 1000 }] } : JSON.parse(await readFile(path.join(root, 'deploy/dev/zigbee-onoff.example.json'), 'utf8'));
  const environment = JSON.parse(await readFile(path.join(root, 'deploy/dev/zigbee-environment.example.json'), 'utf8')).bindings[0];
  if (!values.dynamic) {
    environment.device_id = 'zigbee-environment'; sources.bindings.push(environment);
    config.models.push(JSON.parse(await readFile(path.join(root, 'contracts/models/environment.json'), 'utf8')));
    config.devices.push({ device_id: environment.device_id, model_revision: environment.model_revision });
  }
  for (const source of [...sources.bindings, ...(sources.on_off_bindings ?? [])]) { source.serial = '/dev/pts/0'; source.timeout_ms = 1200; source.poll_interval_ms = 1000; }
  await writeFile(path.join(state, 'config/gateway.json'), JSON.stringify(config)); await writeFile(path.join(state, 'config/zigbee.json'), JSON.stringify(sources));
  const mounts = ['test_znp.py', 'test_znp_environment.py', 'fixtures/zigbee/ncp.py', 'fixtures/zigbee/onoff_ncp.py'].map(name => ({ type: 'bind', source: path.join(root, 'tests', name), target: '/fixture/tests/' + name, read_only: true }));
  const overrides = { services: nasImageOverrides(images, platform) };
  overrides.services.gateway.environment = { LIMEIOT_ZIGBEE_CONFIG: '/config/zigbee.json' }; overrides.services.gateway.volumes = mounts;
  await writeFile(overrideFile, JSON.stringify(overrides, null, 2));
  const configuration = JSON.parse(await compose(['config', '--format', 'json'], 'configuration.log'));
  assert.equal(configuration.services.gateway.read_only, true); assert.ok(configuration.services.gateway.cap_drop.includes('ALL'));
  assert.notEqual(configuration.services.gateway.user.split(':')[0], '0'); assert.notEqual(configuration.services.gateway.privileged, true);
  assert.ok(configuration.services.edge.ports.every(port => port.host_ip === '127.0.0.1'));
  owner = (await readFile(path.join(state, 'secrets/owner-token'), 'utf8')).trim();
  agent = new Agent({ ca: await readFile(path.join(state, 'authority/ca.crt')), keepAlive: true });
  started = true; await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90'], 'initial-up.log');
  report.linux_machine = verifyNasMachine(await compose(['exec', '-T', 'gateway', 'uname', '-m']), platform, 'gateway');
  assert.equal((await call(base + '/devices', { authenticated: false })).status, 401); await login();
  let fixture = await ncp('initial');
  if (values.dynamic) {
    const candidate = await call(base + '/observation-candidates', { input: { coordinator_id: 'home-znp', ieee_address: '1122334455667788', endpoint: 1 } });
    assert.equal(candidate.status, 200);
    const binding = (await call(base + '/devices/zigbee-environment/observation-binding')).value;
    const operation = await call(base + '/observation-operations', { key: 'nas-dynamic-sensor', input: { type: 'sources.bind', device_id: 'zigbee-environment', source: candidate.value.source,
      expected_binding_revision: binding.revision, expected_model_revision: candidate.value.model_revision } });
    assert.equal(operation.value.status, 'applied');
    await until(async () => (await sensor()).ready, 15000);
  } else await until(async () => (await light()).ready && (await sensor()).ready, 15000);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.getByLabel('所有者凭据', { exact: true }).fill(owner); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  if (values.dynamic) {
    await page.goto(origin + '/?view=models');
    const panel = page.getByRole('region', { name: 'Zigbee设备接入', exact: true });
    await expect(panel.getByLabel('设备 IEEE', { exact: true })).toBeEnabled();
    await panel.getByLabel('设备 IEEE', { exact: true }).fill('1122334455667789');
    await panel.getByLabel('设备编号', { exact: true }).fill('zigbee-light');
    await panel.getByRole('combobox', { name: /^设备类型/ }).selectOption('on_off');
    await panel.getByRole('button', { name: '查询设备', exact: true }).click();
    const review = panel.getByRole('group', { name: '核对Zigbee设备', exact: true });
    await expect(review.getByText('接入权限：读取和控制电源', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: '确认添加设备', exact: true }).click();
    await until(async () => (await light()).ready, 15000);
    assert.deepEqual((await light()).routes['light.power'].adapter_id.startsWith('znp-'), true);
    report.packaged_dynamic_switch_binding = true;
    await page.goto(origin + '/?view=devices');
  }
  const card = page.locator('article.device').filter({ has: page.getByText('zigbee-light', { exact: true }) });
  const toggle = card.getByRole('switch', { name: '电源', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); await toggle.click();
  await until(async () => (await commands()).length === 1 && (await commands())[0].status === 'confirmed');
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await expect(toggle).toBeEnabled();
  await page.route('**/commands', async route => { if (route.request().method() !== 'POST') return route.continue(); await route.fetch(); await route.abort(); }, { times: 1 });
  await toggle.click(); await expect(card.getByRole('button', { name: '查询原操作', exact: true })).toBeVisible();
  await until(async () => (await commands()).length === 2 && (await commands()).every(command => command.status === 'confirmed'));
  await card.getByRole('button', { name: '查询原操作', exact: true }).click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  assert.deepEqual((await fixture.stats()).switch_commands, [true, false]);
  const rule = thresholdRule(); rule.actions = [{ device: 'zigbee-light', set: { path: 'light.power', value: true } }];
  const baseline = (await sensor()).state_revision; assert.equal((await call(base + '/rule-deployments', { input: rule })).status, 200);
  await until(async () => (await sensor()).state_revision > baseline);
  await fixture.send({ device: '1122334455667788', temperature: 2900, mode: 'normal' });
  await until(async () => (await commands()).length === 3 && (await commands()).every(command => command.status === 'confirmed'));
  await fixture.send({ type: 'switch', mode: 'hold', power: false }); await until(async () => (await light()).reported['light.power'].value === false);
  const device = await light(), key = 'nas-onoff-unknown';
  assert.equal((await call(base + '/commands', { key, input: { device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 2500).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } } })).status, 202);
  const unknown = await until(async () => { const result = await call(base + '/commands/by-key/' + key); return result.value.status === 'unknown' && result.value; });
  assert.equal((await light()).reported['light.power'].value, false); report.initial_stats = await fixture.stats();
  assert.deepEqual(report.initial_stats.switch_commands, [true, false, true, true]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, 'nas-onoff-mobile.png'), fullPage: true, animations: 'disabled' });
  await browser.close(); browser = undefined;
  await compose(['up', '--no-build', '--detach', '--force-recreate', '--no-deps', 'gateway'], 'recreate.log');
  await until(async () => (await call('/healthz', { authenticated: false })).value?.broker_connected, 15000); await login(); fixture = await ncp('recreated');
  await until(async () => (await light()).ready && (await sensor()).ready, 15000);
  assert.deepEqual((await call(base + '/commands/by-key/' + key)).value, unknown); assert.deepEqual((await fixture.stats()).switch_commands, []);
  await run('python3', [manager, 'backup', '--directory', state, '--output', backup], 'backup.log');
  await run('python3', [manager, 'restore', '--backup', backup, '--directory', restored], 'restore.log');
  const saved = await snapshot(backup), recovered = await snapshot(restored); assert.equal(saved.integrity, 'ok'); assert.equal(saved.version, values.dynamic ? 15 : 14); assert.deepEqual(recovered, saved);
  await compose(['logs', '--no-color'], 'original-containers.log'); await compose(['down', '--remove-orphans'], 'original-down.log'); started = false;
  state = restored; started = true; await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90'], 'restored-up.log');
  await login(); fixture = await ncp('restored'); await until(async () => (await light()).ready && (await sensor()).ready, 15000);
  assert.deepEqual((await call(base + '/commands/by-key/' + key)).value, unknown); assert.deepEqual((await fixture.stats()).switch_commands, []);
  assert.equal((await commands()).length, 4); assert.equal((await light()).reported['light.power'].value, false);
  report.backup_snapshot = saved; report.restored_snapshot = recovered; report.final_stats = await fixture.stats();
  report.https_verified_ca = true; report.non_root_read_only_cap_drop_all = true; report.packaged_mobile_web = true;
  report.web_response_loss_original_get = true; report.confirmed_threshold = true; report.unknown_preserved = true;
  report.recreate_and_restore_zero_replay = true; report.physical_device_passthrough = false; report.passed = true;
} catch (error) { report.error = String(error); report.error_stack = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); agent?.destroy();
  if (started) { await compose(['logs', '--no-color'], 'final-containers.log').catch(() => {}); try { await compose(['down', '--remove-orphans'], 'final-down.log'); report.containers_cleaned = true; } catch { report.passed = false; report.containers_cleaned = false; process.exitCode = 1; } }
  for (const fixture of fixtures) { await until(() => fixture.child.exitCode !== null || fixture.child.signalCode !== null, 5000).catch(() => {}); await writeFile(path.join(directory, fixture.phase + '-ncp.log'), fixture.stderr); }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, report: path.relative(root, path.join(directory, 'report.json')) }));
}

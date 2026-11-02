import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpsRequest, Agent } from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { root, freePort, until } from './dev-stack.mjs';
import { mqttProbe } from '../tests/support/mqtt-probe.mjs';
import { nasVerificationPlatform, inspectNasImages, nasImageOverrides, verifyNasMachine } from './nas-verification-platform.mjs';

// 只使用本次创建的Compose项目和目录，不连接既有NAS实例。
const exec = promisify(execFile);
const { values } = parseArgs({ options: { image: { type: 'string' }, 'no-build': { type: 'boolean' }, platform: { type: 'string' } } });
if (values.platform) nasVerificationPlatform(values.platform);
const id = randomBytes(8).toString('hex'), project = 'limeiot-nas-' + id;
const directory = path.join(root, '.dev', 'nas-container-' + id), state = path.join(directory, 'installation');
const image = values.image ?? `limeiot/verification:nas-${id}`;
if (!/^limeiot\/[a-z0-9/_-]+:[a-zA-Z0-9_.-]+$/.test(image)) throw new Error('local_test_image_required');
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { passed: false, image, real_containers: false, hardware: false, hardware_acceptance: 'skipped_by_user', evidence: path.relative(root, directory) };
const composeFile = path.join(directory, 'compose.test.json'), manager = path.join(root, 'deploy/nas/manage.py');
let composeCommand, composePrefix, currentState = state, started = false, browser, agent, mqttPort;
async function run(command, args, logName, options = {}) {
  const output = logName ? createWriteStream(path.join(directory, logName), { flags: 'a', mode: 0o600 }) : null;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options, stdio: output ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    let result = '', timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 120000);
    child.stdout.on('data', chunk => { if (output) output.write(chunk); else result += chunk; });
    child.stderr.on('data', chunk => { if (output) output.write(chunk); });
    child.once('error', error => { clearTimeout(timer); output?.end(); reject(error); });
    child.once('exit', code => { clearTimeout(timer); output?.end(); code === 0 ? resolve(result.trim()) : reject(new Error(`${command}_exit_${code}${logName ? ': ' + logName : ''}`)); });
  });
}
async function compose(args, log = 'compose.log') {
  return run(composeCommand, [...composePrefix, '--project-name', project, '--env-file', path.join(currentState, 'compose.env'), '-f', path.join(root, 'deploy/nas/compose.yaml'), '-f', composeFile, '--profile', 'simulation', ...args], log, { env: { ...process.env, LIMEIOT_BIND_HOST: '127.0.0.1', LIMEIOT_MQTT_TLS_PORT: String(mqttPort) } });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  try { await exec('docker', ['compose', 'version']); composeCommand = 'docker'; composePrefix = ['compose']; }
  catch { await exec('docker-compose', ['version']); composeCommand = 'docker-compose'; composePrefix = []; }
  report.daemon_platform = (await exec('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).stdout.trim();
  const platform = nasVerificationPlatform(values.platform, report.daemon_platform);
  report.target_platform = platform;
  if (!values['no-build']) {
    console.log('构建NAS镜像，日志位于本次证据目录。');
    let env = process.env;
    try { await exec('docker', ['buildx', 'version']); }
    catch { env = { ...process.env, DOCKER_BUILDKIT: '0' }; }
    await run('docker', ['build', '--platform', platform, '--pull=false', '--tag', image, '--file', 'deploy/nas/Dockerfile', '.'], 'build.log', { env, timeout: 1200000 });
  }
  const primary = await inspectNasImages({ gateway: image }, platform);
  report.image_id = primary.gateway.id;
  report.platform = platform;
  const port = await freePort(); mqttPort = await freePort(); const origin = `https://127.0.0.1:${port}`;
  await run('python3', [manager, 'init', '--directory', state, '--origin', origin], 'initialize.log');
  const overrides = { services: {
    gateway: { image, pull_policy: 'never' },
    edge: { pull_policy: 'never' },
    lamp: { image, pull_policy: 'never' }, button: { image, pull_policy: 'never' },
  } };
  if (process.env.LIMEIOT_TEST_NGINX_IMAGE) {
    assert.match(process.env.LIMEIOT_TEST_NGINX_IMAGE, /^limeiot\/verification:[\w.-]+$/);
    overrides.services.edge.image = process.env.LIMEIOT_TEST_NGINX_IMAGE;
  }
  await writeFile(composeFile, JSON.stringify(overrides), { mode: 0o600 });
  const configuration = JSON.parse(await compose(['config', '--format', 'json'], null));
  const images = await inspectNasImages(Object.fromEntries(Object.entries(configuration.services).map(([service, config]) => [service, config.image])), platform);
  report.image_platforms = images;
  await writeFile(composeFile, JSON.stringify({ services: nasImageOverrides(images, platform) }, null, 2), { mode: 0o600 });
  const owner = (await readFile(path.join(state, 'secrets/owner-token'), 'utf8')).trim();
  agent = new Agent({ ca: await readFile(path.join(state, 'authority/ca.crt')), keepAlive: true });
  let session;
  function call(resource, { input, key, authenticated = true, headers = {}, method } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(origin + resource, { agent, method: method ?? (input === undefined ? 'GET' : 'POST'), headers: {
        ...(authenticated && session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, Origin: origin } : {}),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...headers,
      } }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 2_000_000) req.destroy(new Error('response_too_large')); else chunks.push(chunk); });
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let value; try { value = JSON.parse(raw); } catch { value = raw; }
          resolve({ status: response.statusCode, headers: response.headers, value });
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('https_timeout'))); req.on('error', reject);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async function login() {
    const response = await call('/api/v1/auth/session', { authenticated: false, input: { token: owner }, headers: { Origin: origin } });
    assert.equal(response.status, 200); assert.equal(response.value.authenticated, true);
    const cookie = response.headers['set-cookie']?.find(value => value.startsWith('__Host-limeiot_session='));
    assert.ok(cookie?.includes('Secure') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
    session = { cookie: cookie.split(';')[0], csrf: response.value.csrf_token };
  }
  const base = '/api/v1/spaces/space-demo';
  started = true;
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90']);
  report.real_containers = true;
  report.runtime_machines = {};
  for (const service of ['gateway', 'edge']) {
    report.runtime_machines[service] = verifyNasMachine(await compose(['exec', '-T', service, 'uname', '-m'], null), platform, service);
  }
  await until(async () => (await call('/healthz', { authenticated: false })).value.broker_connected, 15000);
  report.https_verified_ca = true;
  assert.equal((await call(base + '/devices', { authenticated: false })).status, 401);
  assert.equal((await call('/api/v1/auth/session', { authenticated: false, input: { token: owner }, headers: { Origin: 'https://other.example.test' } })).status, 403);
  await login();
  await until(async () => { const devices = (await call(base + '/devices')).value.items; return devices?.length === 2 && devices.every(device => device.ready); }, 20000);
  const gatewayID = await compose(['ps', '--quiet', 'gateway'], null), edgeID = await compose(['ps', '--quiet', 'edge'], null);
  const inspect = async container => JSON.parse((await exec('docker', ['inspect', '--format', '{{json .}}', container])).stdout);
  for (const container of [gatewayID, edgeID]) {
    const value = await inspect(container);
    assert.equal(value.HostConfig.ReadonlyRootfs, true); assert.ok(value.HostConfig.CapDrop.includes('ALL'));
    assert.notEqual(value.Config.User.split(':')[0], '0');
    assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  }
  const gateway = await inspect(gatewayID);
  assert.ok(!gateway.NetworkSettings.Ports['17880/tcp'] && !gateway.NetworkSettings.Ports['18884/tcp']);
  const networkID = Object.values(gateway.NetworkSettings.Networks)[0].NetworkID;
  assert.equal(JSON.parse((await exec('docker', ['network', 'inspect', '--format', '{{json .Internal}}', networkID])).stdout), true);
  report.non_root_read_only_internal_network = true;
  const lamp = (await call(base + '/devices/device-lamp')).value;
  const input = { device_id: lamp.device_id, model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 10000).toISOString(), operation: { type: 'property.set', path: 'light.brightness', value: 43 } };
  const created = await call(base + '/commands', { input, key: 'nas-container-confirmed' }); assert.equal(created.status, 202);
  const confirmed = await until(async () => { const value = (await call(base + '/commands/' + created.value.command_id)).value; return value.status === 'confirmed' && value; });
  assert.equal(confirmed.evidence.type, 'device_result');
  const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-light.json'), 'utf8'));
  assert.equal((await call(base + '/rule-deployments', { input: rule })).status, 200);
  report.mqtt_command_confirmed = true;
  browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE });
  // 浏览器只验UI；TLS信任由上面的Node专用CA连接独立证明。
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin); await page.getByLabel('所有者凭据', { exact: true }).fill(owner);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的设备', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '环境灯', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设备接入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设备接入', exact: true })).toBeVisible();
  await expect(page.getByLabel('发布者信任材料', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(directory, 'nas-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(directory, 'nas-mobile.png'), fullPage: true });
  assert.deepEqual(pageErrors, []); await browser.close(); browser = undefined;
  report.browser_home_and_model_entry = true;
  // 替换网关时入口不重建，核对DNS更新和模拟器网络命名空间重新关联。
  await compose(['up', '--no-build', '--detach', '--force-recreate', '--no-deps', 'gateway']);
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90', 'lamp', 'button']);
  await until(async () => (await call('/healthz', { authenticated: false })).value.broker_connected, 15000);
  assert.equal(await compose(['ps', '--quiet', 'edge'], null), edgeID);
  assert.notEqual(await compose(['ps', '--quiet', 'gateway'], null), gatewayID);
  session = undefined; await login();
  await until(async () => (await call(base + '/devices')).value.items?.every(device => device.ready), 20000);
  assert.equal((await call(base + '/commands/' + confirmed.command_id)).value.status, 'confirmed');
  report.gateway_recreation_routed = true;
  await compose(['stop', 'lamp', 'button']);
  const uncertain = await call(base + '/commands', { input: { ...input, expires_at: new Date(Date.now() + 1200).toISOString() }, key: 'nas-container-unknown' });
  assert.equal(uncertain.status, 202);
  await until(async () => (await call(base + '/commands/' + uncertain.value.command_id)).value.status === 'unknown');
  const identityDirectory = path.join(directory, 'device-identity');
  const issuer = path.join(root, 'deploy/nas/device_identity.py');
  const identity = JSON.parse(await run('python3', [issuer, 'issue', '--directory', state, '--device-id', 'device-lamp', '--output', identityDirectory], null));
  const mqtt = { port: mqttPort, ca: await readFile(path.join(identityDirectory, 'ca.crt')), cert: await readFile(path.join(identityDirectory, 'device.crt')), key: await readFile(path.join(identityDirectory, 'private.key')) };
  await assert.rejects(mqttProbe({ port: mqttPort, ca: mqtt.ca }));
  const probe = await mqttProbe({ ...mqtt, username: 'gateway' });
  try {
    assert.equal(await probe.publish('limeiot/v1/space-demo/device-button/up/event'), 135);
    assert.equal(await probe.publish('limeiot/v1/space-demo/device-lamp/down/command'), 135);
  } finally { probe.close(); }
  await run('python3', [issuer, 'revoke', '--directory', state, '--serial', identity.serial], 'identity.log');
  await compose(['restart', 'gateway']);
  await until(async () => (await call('/healthz', { authenticated: false })).value.broker_connected, 15000);
  await assert.rejects(mqttProbe(mqtt)); report.device_mtls_acl_revocation = true;
  const originalKey = hash(await readFile(path.join(state, 'secrets/gateway-identity.pk8')));
  const backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
  await run('python3', [manager, 'backup', '--directory', state, '--output', backup], 'backup.log');
  await run('python3', [manager, 'restore', '--backup', backup, '--directory', restored], 'restore.log');
  assert.equal(hash(await readFile(path.join(restored, 'secrets/gateway-identity.pk8'))), originalKey);
  await compose(['down', '--remove-orphans']); currentState = restored;
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90']);
  session = undefined; await login();
  await until(async () => (await call(base + '/devices')).value.items?.every(device => device.ready), 20000);
  assert.equal((await call(base + '/commands/' + confirmed.command_id)).value.status, 'confirmed');
  assert.equal((await call(base + '/commands/by-key/nas-container-unknown')).value.command_id, uncertain.value.command_id);
  assert.equal((await call(base + '/commands/' + uncertain.value.command_id)).value.status, 'unknown');
  assert.equal((await call(base + '/rule-deployments')).value.items[0].rule.id, rule.id);
  assert.equal((await call(base + '/commands')).value.items.length, 2);
  assert.equal((await call(base + '/devices/device-lamp')).value.reported['light.brightness'].value, 0);
  await assert.rejects(mqttProbe(mqtt));
  report.consistent_backup_restore = true; report.revocation_restored = true; report.no_command_replay = true;
  report.passed = true;
  console.log('NAS容器：HTTPS、家庭页面、MQTT控制、mTLS/撤销和新目录备份恢复通过。');
} catch (error) {
  report.error = error instanceof Error ? error.message : 'nas_verification_failed';
  if (started) await compose(['ps', '--all', '--quiet'], null).then(ids => { report.real_containers ||= Boolean(ids.trim()); }).catch(() => {});
  console.error('NAS检查未通过，详见本次证据目录。'); process.exitCode = 1;
} finally {
  await browser?.close(); agent?.destroy();
  if (started) {
    await compose(['logs', '--no-color'], 'containers.log').catch(() => {});
    try { await compose(['down', '--remove-orphans']); report.containers_cleaned = true; }
    catch { report.containers_cleaned = false; report.passed = false; process.exitCode = 1; }
  }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, report: path.relative(root, path.join(directory, 'report.json')) }));
}

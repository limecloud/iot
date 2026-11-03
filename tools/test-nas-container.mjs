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
import { prepareNasMultimodal, nasMultimodalJourney } from './nas-multimodal-journey.mjs';

// 只使用本次创建的Compose项目和目录，不连接既有NAS实例。
const exec = promisify(execFile);
const { values } = parseArgs({ options: { image: { type: 'string' }, 'no-build': { type: 'boolean' }, platform: { type: 'string' }, multimodal: { type: 'boolean' } } });
if (values.platform) nasVerificationPlatform(values.platform);
const id = randomBytes(8).toString('hex'), project = 'limeiot-nas-' + id;
const directory = path.join(root, '.dev', 'nas-container-' + id), state = path.join(directory, 'installation');
const image = values.image ?? `limeiot/verification:nas-${id}`;
if (!/^limeiot\/[a-z0-9/_-]+:[a-zA-Z0-9_.-]+$/.test(image)) throw new Error('local_test_image_required');
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { passed: false, image, real_containers: false, hardware: false, hardware_acceptance: 'skipped_by_user', evidence: path.relative(root, directory) };
const composeFile = path.join(directory, 'compose.test.json'), manager = path.join(root, 'deploy/nas/manage.py');
let composeCommand, composePrefix, currentState = state, started = false, browser, agent, mqttPort, multimodalConfiguration, multimodal, multimodalSnapshot;
async function run(command, args, logName, options = {}) {
  const output = logName ? createWriteStream(path.join(directory, logName), { flags: 'a', mode: 0o600 }) : null;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (options.input !== undefined) child.stdin.end(options.input);
    let result = '', timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 120000);
    child.stdout.on('data', chunk => { if (output) output.write(chunk); else result += chunk; });
    child.stderr.on('data', chunk => { if (output) output.write(chunk); });
    child.once('error', error => { clearTimeout(timer); output?.end(); reject(error); });
    child.once('exit', code => { clearTimeout(timer); output?.end(); code === 0 ? resolve(result.trim()) : reject(new Error(`${command}_exit_${code}${logName ? ': ' + logName : ''}`)); });
  });
}
async function compose(args, log = 'compose.log') {
  const files = ['compose.yaml', ...(values.multimodal ? ['compose.media.yaml', 'compose.speech.yaml', 'compose.transcription.yaml', 'compose.vision.yaml'] : [])];
  return run(composeCommand, [...composePrefix, '--project-name', project, '--env-file', path.join(currentState, 'compose.env'), ...files.flatMap(file => ['-f', path.join(root, 'deploy/nas', file)]), '-f', composeFile, '--profile', 'simulation', ...args], log, { env: { ...process.env, ...multimodalConfiguration?.environment, LIMEIOT_STATE_DIR: currentState, LIMEIOT_BIND_HOST: '127.0.0.1', LIMEIOT_MQTT_TLS_PORT: String(mqttPort) } });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  try { await exec('docker', ['compose', 'version']); composeCommand = 'docker'; composePrefix = ['compose']; }
  catch { await exec('docker-compose', ['version']); composeCommand = 'docker-compose'; composePrefix = []; }
  report.daemon_platform = (await exec('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).stdout.trim();
  const platform = nasVerificationPlatform(values.platform, report.daemon_platform);
  report.target_platform = platform;
  report.emulated = platform !== report.daemon_platform;
  if (!values['no-build']) {
    console.log('构建NAS镜像，日志位于本次证据目录。');
    let env = process.env;
    try { await exec('docker', ['buildx', 'version']); }
    catch { env = { ...process.env, DOCKER_BUILDKIT: '0' }; }
    await run('docker', ['build', '--platform', platform, '--pull=false', '--tag', image, '--file', 'deploy/nas/Dockerfile', '.'], 'build.log', { env, timeout: 1200000 });
  }
  const primary = await inspectNasImages({ gateway: image }, platform);
  report.image_id = primary.gateway.id;
  report.image_source_digest = (await exec('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "run.limeiot.source-digest"}}', report.image_id])).stdout.trim() || null;
  report.platform = platform;
  const port = await freePort(); mqttPort = await freePort(); const origin = `https://127.0.0.1:${port}`;
  await run('python3', [manager, 'init', '--directory', state, '--origin', origin], 'initialize.log');
  const overrides = { services: {
    gateway: { image, pull_policy: 'never' },
    edge: { pull_policy: 'never' },
    lamp: { image, pull_policy: 'never' }, button: { image, pull_policy: 'never' },
  } };
  if (values.multimodal) {
    multimodalConfiguration = await prepareNasMultimodal({ state, image: report.image_id, manager, run, emulated: report.emulated });
    overrides.networks = multimodalConfiguration.overrides.networks;
    for (const [service, config] of Object.entries(multimodalConfiguration.overrides.services)) overrides.services[service] = { ...overrides.services[service], ...config };
  }
  if (process.env.LIMEIOT_TEST_NGINX_IMAGE) {
    assert.match(process.env.LIMEIOT_TEST_NGINX_IMAGE, /^limeiot\/verification:[\w.-]+$/);
    overrides.services.edge.image = process.env.LIMEIOT_TEST_NGINX_IMAGE;
  }
  await writeFile(composeFile, JSON.stringify(overrides), { mode: 0o600 });
  const configuration = JSON.parse(await compose(['config', '--format', 'json'], null));
  assert.ok(configuration.services.gateway.volumes.every(volume => volume.type === 'bind' && volume.source.startsWith(state + path.sep)), 'verification_state_directory_mismatch');
  report.installation_scoped_to_verification_directory = true;
  const images = await inspectNasImages(Object.fromEntries(Object.entries(configuration.services).map(([service, config]) => [service, config.image])), platform);
  report.image_platforms = images;
  for (const [service, pinned] of Object.entries(nasImageOverrides(images, platform))) overrides.services[service] = { ...overrides.services[service], ...pinned };
  await writeFile(composeFile, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  const owner = (await readFile(path.join(state, 'secrets/owner-token'), 'utf8')).trim();
  agent = new Agent({ ca: await readFile(path.join(state, 'authority/ca.crt')), keepAlive: true });
  let session;
  function call(resource, { input, key, authenticated = true, headers = {}, method } = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now(), body = input === undefined ? undefined : JSON.stringify(input);
      const request = { method: method ?? (input === undefined ? 'GET' : 'POST'), resource, input_bytes: body === undefined ? 0 : Buffer.byteLength(body) };
      const observation = () => ({ ...request, elapsed_ms: Math.round(performance.now() - startedAt) });
      const req = httpsRequest(origin + resource, { agent, method: method ?? (input === undefined ? 'GET' : 'POST'), headers: {
        ...(authenticated && session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, Origin: origin } : {}),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...headers,
      } }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 2_000_000) req.destroy(new Error('response_too_large')); else chunks.push(chunk); });
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let value; try { value = JSON.parse(raw); } catch { value = raw; }
          const timing = observation();
          if (timing.elapsed_ms >= 1000) (report.slow_requests ??= []).push({ ...timing, status: response.statusCode });
          resolve({ status: response.statusCode, headers: response.headers, value });
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('https_timeout')));
      req.on('error', error => { error.request_observation = observation(); reject(error); });
      req.end(body);
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
  const simulationReady = async () => {
    const devices = (await call(base + '/devices')).value.items;
    return devices?.length === (values.multimodal ? 3 : 2) && ['device-lamp', 'device-button'].every(id => devices.find(device => device.device_id === id)?.ready);
  };
  if (values.multimodal) {
    multimodal = nasMultimodalJourney({ configuration: multimodalConfiguration, call, compose, directory, getState: () => currentState });
    report.multimodal = multimodal.report;
  }
  started = true;
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90']);
  report.real_containers = true;
  report.runtime_machines = {};
  for (const service of ['gateway', 'edge', ...(values.multimodal ? ['multimodal'] : [])]) {
    report.runtime_machines[service] = verifyNasMachine(await compose(['exec', '-T', service, 'uname', '-m'], null), platform, service);
  }
  await until(async () => {
    const response = await call('/healthz', { authenticated: false });
    report.startup_health = { status: response.status, broker_connected: response.value?.broker_connected };
    return response.value.broker_connected;
  }, 15000);
  report.https_verified_ca = true;
  assert.equal((await call(base + '/devices', { authenticated: false })).status, 401);
  assert.equal((await call('/api/v1/auth/session', { authenticated: false, input: { token: owner }, headers: { Origin: 'https://other.example.test' } })).status, 403);
  await login();
  await until(simulationReady, 20000);
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
  if (values.multimodal) {
    const provider = await inspect(await compose(['ps', '--quiet', 'multimodal'], null));
    assert.equal(provider.HostConfig.ReadonlyRootfs, true); assert.notEqual(provider.Config.User.split(':')[0], '0');
    assert.ok(provider.HostConfig.CapDrop.includes('ALL')); assert.ok(provider.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(provider.Mounts.length, 1); assert.equal(provider.Mounts[0].Destination, '/fixture/multimodal.py'); assert.equal(provider.Mounts[0].RW, false);
    assert.deepEqual(provider.HostConfig.PortBindings ?? {}, {}); assert.equal(Object.keys(provider.NetworkSettings.Networks).length, 1);
    assert.equal(JSON.parse((await exec('docker', ['network', 'inspect', '--format', '{{json .Internal}}', Object.values(provider.NetworkSettings.Networks)[0].NetworkID])).stdout), true);
    assert.equal(configuration.services.gateway.depends_on?.multimodal, undefined);
    report.inference_container_isolated_without_device_or_owner_secrets = true;
  }
  const lamp = (await call(base + '/devices/device-lamp')).value;
  const input = { device_id: lamp.device_id, model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 10000).toISOString(), operation: { type: 'property.set', path: 'light.brightness', value: 43 } };
  const created = await call(base + '/commands', { input, key: 'nas-container-confirmed' }); assert.equal(created.status, 202);
  const confirmed = await until(async () => { const value = (await call(base + '/commands/' + created.value.command_id)).value; return value.status === 'confirmed' && value; });
  assert.equal(confirmed.evidence.type, 'device_result');
  const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-light.json'), 'utf8'));
  assert.equal((await call(base + '/rule-deployments', { input: rule })).status, 200);
  report.mqtt_command_confirmed = true;
  await multimodal?.begin();
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
  await until(simulationReady, 20000);
  assert.equal((await call(base + '/commands/' + confirmed.command_id)).value.status, 'confirmed');
  report.gateway_recreation_routed = true;
  await multimodal?.afterRecreate();
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
  assert.equal((await call(base + '/devices')).status, 401);
  session = undefined; await login();
  report.session_reauthenticated_after_gateway_restart = true;
  const originalKey = hash(await readFile(path.join(state, 'secrets/gateway-identity.pk8')));
  const backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
  multimodalSnapshot = await multimodal?.beforeBackup();
  await run('python3', [manager, 'backup', '--directory', state, '--output', backup], 'backup.log');
  await run('python3', [manager, 'restore', '--backup', backup, '--directory', restored], 'restore.log');
  if (multimodalSnapshot) {
    for (const location of [backup, restored]) assert.deepEqual(await readFile(path.join(location, 'data/gateway.sqlite.media.json')), multimodalSnapshot);
    report.multimodal.snapshot_v4_backup_and_restore_byte_exact = true;
  }
  assert.equal(hash(await readFile(path.join(restored, 'secrets/gateway-identity.pk8'))), originalKey);
  await compose(['down', '--remove-orphans']); currentState = restored;
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90']);
  session = undefined; await login();
  await until(simulationReady, 20000);
  await multimodal?.afterRestore();
  if (multimodal) {
    await compose(['restart', 'gateway']);
    await until(async () => (await call('/healthz', { authenticated: false })).value.broker_connected, 15000);
    session = undefined; await login();
    await until(simulationReady, 20000);
    const netns = ['exec', '-T', 'gateway', 'python3', '-c', 'import os;print(os.readlink("/proc/self/ns/net"))'];
    const gatewayNamespace = await compose(netns, null);
    for (const service of ['lamp', 'button']) {
      assert.equal(await compose(['exec', '-T', service, ...netns.slice(3)], null), gatewayNamespace);
    }
    report.simulators_rejoined_gateway_network_after_restart = true;
    await multimodal.afterClearRestart();
  }
  assert.equal((await call(base + '/commands/' + confirmed.command_id)).value.status, 'confirmed');
  assert.equal((await call(base + '/commands/by-key/nas-container-unknown')).value.command_id, uncertain.value.command_id);
  assert.equal((await call(base + '/commands/' + uncertain.value.command_id)).value.status, 'unknown');
  assert.equal((await call(base + '/rule-deployments')).value.items[0].rule.id, rule.id);
  assert.equal((await call(base + '/commands')).value.items.length, values.multimodal ? 4 : 2);
  assert.equal((await call(base + '/devices/device-lamp')).value.reported['light.brightness'].value, 0);
  await assert.rejects(mqttProbe(mqtt));
  report.consistent_backup_restore = true; report.revocation_restored = true; report.no_command_replay = true;
  report.passed = true;
  console.log('NAS容器：HTTPS、家庭页面、MQTT控制、mTLS/撤销和新目录备份恢复通过。' + (values.multimodal ? ' 多模态容器、显式播放与清文恢复通过。' : ''));
} catch (error) {
  report.error = error instanceof Error ? error.message : 'nas_verification_failed';
  if (error?.request_observation) report.failed_request = error.request_observation;
  if (started) {
    try {
      const ids = (await compose(['ps', '--all', '--quiet'], null)).split(/\s+/).filter(Boolean);
      report.real_containers ||= ids.length > 0;
      if (ids.length) report.container_states = JSON.parse((await exec('docker', ['inspect', ...ids])).stdout).map(container => ({
        service: container.Config.Labels['com.docker.compose.service'], status: container.State.Status,
        exit_code: container.State.ExitCode, oom_killed: container.State.OOMKilled,
        memory_limit_bytes: container.HostConfig.Memory, health: container.State.Health?.Status,
      }));
    } catch { /* 诊断失败不替代原始验收错误。 */ }
  }
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

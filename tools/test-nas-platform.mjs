import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpsRequest, Agent } from 'node:https';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, freePort, until } from './dev-stack.mjs';
import { nasVerificationPlatform, inspectNasImages, nasImageOverrides, verifyNasMachine } from './nas-verification-platform.mjs';

// 仅创建本次独立项目，不使用已有 NAS 或数据库。
const exec = promisify(execFile), id = randomBytes(8).toString('hex');
const directory = path.join(root, '.dev', 'nas-platform-' + id), initial = path.join(directory, 'installation');
const manager = path.join(root, 'deploy/nas/manage.py'), override = path.join(directory, 'images.json');
const report = { passed: false, real_containers: false, hardware: false, hardware_acceptance: 'skipped_by_user', evidence: directory };
const { values } = parseArgs({ options: { keep: { type: 'boolean' }, 'no-build': { type: 'boolean' }, platform: { type: 'string' } } });
const keep = values.keep;
const noBuild = values['no-build'];
if (values.platform) nasVerificationPlatform(values.platform);
let current = initial, browser, agent, control, local, started = false;
let targetPlatform;
const projects = new Set();
await mkdir(directory, { recursive: true, mode: 0o700 });
const port = await freePort(), mqttPort = await freePort(), hostname = `nas-${id}.localhost`, origin = `https://${hostname}:${port}`;
if (noBuild && (!process.env.LIMEIOT_TEST_NAS_IMAGE || !process.env.LIMEIOT_TEST_PLATFORM_IMAGE)) throw new Error('prebuilt_verification_images_required');
const gatewayImage = process.env.LIMEIOT_TEST_NAS_IMAGE ?? `limeiot/verification:nas-platform-${id}`;
const controlImage = process.env.LIMEIOT_TEST_PLATFORM_IMAGE ?? `limeiot/verification:control-platform-${id}`;
for (const image of [gatewayImage, controlImage]) assert.match(image, /^limeiot\/verification:[\w.-]+$/);
const overrides = { services: {
  gateway: { image: gatewayImage, pull_policy: 'never', extra_hosts: [`${hostname}:host-gateway`] }, lamp: { image: gatewayImage, pull_policy: 'never' }, button: { image: gatewayImage, pull_policy: 'never' },
  control: { image: controlImage, pull_policy: 'never' }, migrate: { image: controlImage, pull_policy: 'never' },
} };
for (const [service, variable] of [['edge', 'LIMEIOT_TEST_NGINX_IMAGE'], ['control-mysql', 'LIMEIOT_TEST_MYSQL_IMAGE']]) {
  if (process.env[variable]) {
    assert.match(process.env[variable], /^limeiot\/verification:[\w.-]+$/);
    overrides.services[service] = { image: process.env[variable], pull_policy: 'never' };
  }
}
await writeFile(override, JSON.stringify(overrides), { mode: 0o600 });
let composeTool;
try { await exec('docker', ['compose', 'version']); composeTool = ['docker', 'compose']; }
catch { await exec('docker-compose', ['version']); composeTool = ['docker-compose']; }
const env = { ...process.env, LIMEIOT_BIND_HOST: '127.0.0.1', LIMEIOT_MQTT_TLS_PORT: String(mqttPort) };
function composeArgs(args) {
  const name = 'limeiot-' + createHash('sha256').update(current).digest('hex').slice(0, 12);
  projects.add(current);
  return [...composeTool.slice(1), '--project-name', name, '--env-file', path.join(current, 'compose.env'), '-f', path.join(root, 'deploy/nas/compose.yaml'), '-f', path.join(root, 'deploy/nas/compose.platform.yaml'), '-f', override, '--profile', 'simulation', ...args];
}
async function compose(args) { return exec(composeTool[0], composeArgs(args), { cwd: root, env, timeout: 180000, maxBuffer: 4_000_000 }); }
async function manage(action, args = []) { return exec('python3', [manager, action, '--directory', current, ...args], { cwd: root, env, timeout: 120000 }); }
function call(resource, { input, auth = control, key, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(origin + resource, { agent, method: input === undefined ? 'GET' : 'POST', headers: {
      Origin: origin, ...(auth ? { Cookie: auth.cookie, ...(auth.csrf ? { 'X-CSRF-Token': auth.csrf } : {}) } : {}),
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...headers,
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const raw = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(raw); } catch { value = raw; }
        resolve({ status: response.statusCode, headers: response.headers, value });
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('request_timeout'))); request.on('error', reject);
    request.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function login(token, audience = 'console') {
  const prefix = audience === 'local' ? '/api/v1/auth' : `/api/${audience}/v1/auth`;
  const response = await call(prefix + (audience === 'local' ? '/session' : '/local'), { auth: null, input: { token } });
  assert.equal(response.status, 200);
  const cookies = response.headers['set-cookie']; assert.ok(cookies?.length);
  const cookie = cookies[0].split(';')[0];
  assert.ok(cookies[0].includes('HttpOnly') && cookies[0].includes('Secure'));
  const session = await call(prefix + '/session', { auth: { cookie } });
  assert.equal(session.status, 200); assert.equal(typeof session.value.csrf_token, 'string');
  return { cookie, csrf: session.value.csrf_token };
}
async function navigate(page, label) { await page.locator('.sidebar nav').getByRole('link', { name: label, exact: true }).click(); }
async function build(image, dockerfile, log) {
  const output = createWriteStream(path.join(directory, log), { mode: 0o600 });
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['build', '--platform', targetPlatform, '--pull=false', '--tag', image, '--file', dockerfile, '.'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    child.once('error', reject); child.once('exit', code => { output.end(); code === 0 ? resolve() : reject(new Error('build_failed: ' + log)); });
  });
}
const base = '/api/v1/spaces/space-demo';
try {
  report.daemon_platform = (await exec('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).stdout.trim();
  report.target_platform = targetPlatform = nasVerificationPlatform(values.platform, report.daemon_platform);
  if (!noBuild) {
    console.log('构建隔离验收镜像。');
    await build(gatewayImage, 'deploy/nas/Dockerfile', 'gateway-build.log');
    await build(controlImage, 'deploy/control/Dockerfile', 'control-build.log');
  }
  const primaryImages = await inspectNasImages({ gateway: gatewayImage, control: controlImage }, targetPlatform);
  report.images = { gateway: primaryImages.gateway.id, control: primaryImages.control.id };
  report.platform = targetPlatform;
  const pinned = JSON.parse(await readFile(override, 'utf8'));
  for (const name of ['gateway', 'lamp', 'button']) Object.assign(pinned.services[name], { image: report.images.gateway, platform: targetPlatform });
  for (const name of ['control', 'migrate']) Object.assign(pinned.services[name], { image: report.images.control, platform: targetPlatform });
  await writeFile(override, JSON.stringify(pinned), { mode: 0o600 });
  console.log('初始化隔离的完整本地安装。');
  await manage('init', ['--mode', 'private', '--origin', origin]);
  const configuration = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
  const images = await inspectNasImages(Object.fromEntries(Object.entries(configuration.services).map(([service, config]) => [service, config.image])), targetPlatform);
  report.image_platforms = images;
  for (const [service, image] of Object.entries(nasImageOverrides(images, targetPlatform))) {
    pinned.services[service] = { ...pinned.services[service], ...image };
  }
  await writeFile(override, JSON.stringify(pinned), { mode: 0o600 });
  agent = new Agent({ ca: await readFile(path.join(current, 'authority/ca.crt')), lookup: (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4) });
  const owner = (await readFile(path.join(current, 'secrets/owner-token'), 'utf8')).trim();
  const adminToken = (await readFile(path.join(current, 'platform-secrets/admin-token'), 'utf8')).trim();
  assert.notEqual(owner, adminToken);
  started = true;
  await compose(['up', '-d', '--no-build', '--wait', 'control-mysql']);
  report.real_containers = true;
  await compose(['run', '--rm', '--no-deps', 'migrate']);
  await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90']);
  report.runtime_machines = {};
  for (const service of ['gateway', 'control', 'control-mysql', 'edge']) {
    report.runtime_machines[service] = verifyNasMachine((await compose(['exec', '-T', service, 'uname', '-m'])).stdout, targetPlatform, service);
  }
  await until(async () => (await call('/health/ready', { auth: null })).status === 200, 30000);
  control = await login(owner); local = await login(owner, 'local');
  await until(async () => (await call(base + '/devices', { auth: local })).value.items?.filter(d => d.ready).length === 2, 30000);
  assert.deepEqual((await call('/platform.json', { auth: null })).value, { mode: 'private' });
  assert.equal((await call('/api/admin/v1/status')).status, 401);
  const sql = await compose(['exec', '-T', 'control-mysql', 'mysql', '--defaults-extra-file=/private/readonly.cnf', '-Nse', "SHOW GRANTS FOR CURRENT_USER"]);
  assert.ok(!/GRANT ALL|GRANT CREATE/.test(sql.stdout));
  const runtimeDSN = await readFile(path.join(current, 'platform-secrets/mysql-runtime.dsn'), 'utf8');
  assert.match(runtimeDSN, /^limeiot_runtime:/);
  await assert.rejects(compose(['exec', '-T', 'control', 'limeiot-migrate']), /migration_failed/);
  report.runtime_account_cannot_migrate = true;
  const containers = JSON.parse((await exec('docker', ['inspect', ...(await compose(['ps', '-q'])).stdout.trim().split(/\s+/)])).stdout);
  for (const container of containers) {
    assert.ok(container.HostConfig.ReadonlyRootfs); assert.notEqual(container.Config.User.split(':')[0], '0');
    assert.ok(container.HostConfig.CapDrop.includes('ALL'));
    if (container.Config.Labels['com.docker.compose.service'] === 'control') assert.ok(!container.Mounts.some(m => /mysql-migrator|mysql-root|mysql-init/.test(m.Source)));
    if (container.Config.Labels['com.docker.compose.service'] === 'control-mysql') assert.ok(!container.NetworkSettings.Ports['3306/tcp']);
  }
  report.non_root_readonly_no_database_port = true;
  console.log('真实容器已就绪，验证统一登录、菜单和业务。');
  browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE, args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } }), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
  await page.goto(origin); await page.getByLabel('实例凭据', { exact: true }).fill(owner);
  await page.getByRole('button', { name: '登录私有实例', exact: true }).click();
  await page.getByRole('heading', { name: '工作台概览', exact: true }).waitFor();
  const cookies = await context.cookies();
  assert.ok(cookies.some(c => c.name === '__Host-limeiot_console' && c.httpOnly));
  assert.ok(cookies.some(c => c.name === '__Host-limeiot_session' && c.httpOnly));
  const shell = await page.locator('.workspace').elementHandle();
  const menu = [['设备管理', '我的设备'], ['自动化', '自动化'], ['操作记录', '执行记录'], ['产品开发', '产品开发'], ['设备接入', '设备接入'], ['固件升级', '固件升级'], ['我的空间', '我的空间'], ['网关管理', '网关管理'], ['开发连接', '开发连接'], ['账号与安全', '账号与安全'], ['工作台概览', '工作台概览']];
  for (const [label, heading] of menu) {
    await navigate(page, label); await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
    assert.ok(await shell.evaluate(node => node.isConnected));
    assert.equal(await page.locator('.workspace-bar').count(), 1);
  }
  report.same_document_menus = menu.length;
  await navigate(page, '设备管理');
  const lamp = page.getByRole('article', { name: '环境灯', exact: true });
  await expect(lamp.getByRole('switch', { name: '电源', exact: true })).toBeEnabled();
  await lamp.getByLabel('亮度', { exact: true }).fill('43'); await lamp.getByRole('button', { name: '设置', exact: true }).click();
  await until(async () => (await call(base + '/commands', { auth: local })).value.items?.some(c => c.status === 'confirmed'));
  await page.screenshot({ path: path.join(directory, 'devices-desktop.png'), fullPage: true });
  await navigate(page, '自动化'); await page.getByRole('button', { name: '校验并预演', exact: true }).click();
  await page.getByRole('button', { name: '启用自动化', exact: true }).click();
  await until(async () => (await call(base + '/rule-deployments', { auth: local })).value.items?.length === 1);
  await navigate(page, '产品开发'); await page.getByRole('link', { name: '创建产品', exact: true }).click();
  const publisher = (await call('/api/console/v1/publisher')).value;
  const model = JSON.parse(await readFile(path.join(root, 'contracts/models/lamp.json'), 'utf8'));
  model.model_id = `urn:${publisher.namespace}:model:nas-${id}:1`;
  await page.getByLabel('产品名称', { exact: true }).fill('本地环境灯');
  await page.getByLabel('物模型 JSON', { exact: true }).fill(JSON.stringify(model));
  await page.getByRole('button', { name: '创建产品', exact: true }).click();
  await page.getByRole('button', { name: '校验当前输入', exact: true }).click();
  await page.getByText('当前输入校验通过，尚未发布', { exact: true }).waitFor();
  const product = new URL(page.url()).searchParams.get('product'); assert.match(product, /^product-/);
  const releaseSection = page.getByRole('region', { name: '发布版本', exact: true });
  await releaseSection.getByRole('button', { name: '公开发布当前草稿', exact: true }).click();
  await releaseSection.getByRole('cell', { name: '已发布', exact: true }).waitFor();
  const head = (await call(`/api/console/v1/products/${product}/releases/head`)).value.release; assert.ok(head?.artifact);
  report.local_product_validation_signed_publication = true;
  await navigate(page, '我的空间'); await page.getByLabel('空间名称', { exact: true }).fill('本地家庭');
  await page.getByRole('button', { name: '创建空间', exact: true }).click();
  await page.getByLabel('允许控制设备', { exact: true }).check();
  await page.getByRole('button', { name: '生成配对信息', exact: true }).click();
  await page.getByText('查看配对信息', { exact: true }).click();
  const pair = JSON.parse(await page.locator('.gateway-setup').getByLabel('配对信息', { exact: true }).inputValue());
  const localPair = page.getByRole('region', { name: '网关配对', exact: true });
  await localPair.getByLabel('配对信息', { exact: true }).fill(JSON.stringify(pair));
  await localPair.getByRole('button', { name: '读取配对信息', exact: true }).click();
  await localPair.getByRole('button', { name: '批准配对', exact: true }).click();
  await until(async () => await call(base + '/control-pairings', { auth: local }).then(({ value }) => value.items?.some(v => v.status === 'active') && value.connection?.status === 'connected'), 30000);
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(pair.code));
  report.explicit_pairing_wss = true;
  await navigate(page, '设备管理');
  const remoteLamp = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'device-lamp', exact: true }) });
  await expect(remoteLamp.getByRole('switch', { name: 'light.power', exact: true })).toBeEnabled();
  await remoteLamp.getByRole('switch', { name: 'light.power', exact: true }).click();
  await navigate(page, '操作记录'); await page.getByRole('button', { name: '查询结果', exact: true }).click();
  await page.getByLabel('当前空间', { exact: true }).selectOption('');
  await page.getByRole('heading', { name: '执行记录', exact: true }).waitFor();
  report.local_and_managed_space_tasks = true;
  await navigate(page, '设备管理'); await page.getByLabel('外观', { exact: true }).selectOption('dark');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '工作台导航', exact: true }).click();
  await navigate(page, '自动化'); await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await expect.poll(() => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
  await page.screenshot({ path: path.join(directory, 'automation-mobile-dark.png'), fullPage: true, animations: 'disabled' });
  await page.reload(); await page.getByRole('heading', { name: '自动化', exact: true }).waitFor();
  assert.equal(await page.getByLabel('外观', { exact: true }).inputValue(), 'dark');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByLabel('实例凭据', { exact: true }).waitFor();
  assert.ok(!(await context.cookies()).some(c => ['__Host-limeiot_console', '__Host-limeiot_session'].includes(c.name) && c.value));
  const adminPage = await context.newPage(); await adminPage.goto(origin + '/admin/');
  await adminPage.getByLabel('实例凭据', { exact: true }).fill(adminToken); await adminPage.getByRole('button', { name: '登录私有实例', exact: true }).click();
  await adminPage.getByRole('heading', { name: '运营管理', exact: true }).waitFor();
  await adminPage.goto(origin + '/local/'); await adminPage.getByLabel('所有者凭据', { exact: true }).waitFor();
  await compose(['stop', 'control', 'control-mysql']);
  await page.goto(origin); await page.getByRole('link', { name: '本地维护', exact: true }).click();
  await page.getByLabel('所有者凭据', { exact: true }).fill(owner); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await page.getByRole('heading', { name: '我的设备', exact: true }).waitFor(); await expect(lamp.getByRole('switch', { name: '电源', exact: true })).toBeEnabled();
  report.control_failure_local_maintenance = true;
  assert.deepEqual(errors, []); await browser.close(); browser = undefined;
  console.log('业务与故障维护通过，验证完整备份和空数据库恢复。');
  await compose(['start', 'control-mysql']);
  await compose(['stop', 'control', 'gateway', 'lamp', 'button']);
  const backup = path.join(directory, 'backup'); await manage('backup', ['--output', backup]);
  assert.equal((await stat(path.join(backup, 'control.sql'))).mode & 0o777, 0o600);
  const originalMachine = await readFile(path.join(current, 'secrets/gateway-identity.pk8'));
  await compose(['down']); current = path.join(directory, 'restored');
  await manage('restore', ['--backup', backup]);
  assert.deepEqual(await readFile(path.join(current, 'secrets/gateway-identity.pk8')), originalMachine);
  await compose(['up', '-d', '--no-build', '--wait', 'control-mysql']); await manage('restore-control');
  await assert.rejects(manage('restore-control'), /restore_requires_empty_control_database/);
  await compose(['run', '--rm', '--no-deps', 'migrate']); await compose(['up', '-d', '--no-build', '--wait']);
  control = await login(owner); local = await login(owner, 'local');
  assert.equal((await call(`/api/console/v1/products/${product}/releases/head`)).value.release.artifact.statement.release_id, head.artifact.statement.release_id);
  assert.equal((await call(base + '/rule-deployments', { auth: local })).value.items.length, 1);
  assert.ok((await call(base + '/commands', { auth: local })).value.items.some(v => v.status === 'confirmed'));
  await until(async () => await call(base + '/control-pairings', { auth: local }).then(({ value }) => value.items?.some(v => v.status === 'active') && value.connection?.status === 'connected'), 30000);
  report.backup_restored_products_rules_commands_identity = true;
  if (keep) report.preview = { endpoint: origin, installation: current, simulated_devices: true };
  report.passed = true;
} catch (error) {
  report.error = error.message;
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: path.join(directory, 'failure-' + context.pages().indexOf(page) + '.png'), fullPage: true }).catch(() => {});
  if (started) {
    await compose(['ps', '--all', '--quiet']).then(r => { report.real_containers ||= Boolean(r.stdout.trim()); }).catch(() => {});
    await compose(['logs', '--no-color', '--tail', '80']).then(r => writeFile(path.join(directory, 'containers.log'), r.stdout, { mode: 0o600 })).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close(); agent?.destroy();
  const retained = current;
  if (started) {
    report.containers_cleaned = true;
    for (const install of projects) {
      if (report.passed && keep && install === retained) { report.containers_retained = true; continue; }
      current = install;
      try { await compose(['down']); }
      catch { report.containers_cleaned = false; report.passed = false; process.exitCode = 1; }
    }
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, evidence: directory }));
}

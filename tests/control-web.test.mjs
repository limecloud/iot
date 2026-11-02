import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const core = path.resolve(import.meta.dirname, '..');
const enabled = !!process.env.LIMEIOT_TEST_CONTROL_ORIGIN;
const { startStack, until } = await import('../tools/dev-stack.mjs');
const { origin, fixture, post, cloudClient } = await import('./helpers/control.mjs');
const website = core;
const exec = promisify(execFile);
const zh = '/console/';

async function setup(label) {
  const directory = path.join(website, '.dev', `${label}-${randomBytes(8).toString('hex')}`);
  await mkdir(directory, { recursive: true });
  const token = (await readFile(process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE, 'utf8')).trim();
  const adminToken = (await readFile(process.env.LIMEIOT_TEST_ADMIN_TOKEN_FILE, 'utf8')).trim();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE });
  // 浏览器仅忽略本次临时 CA 的系统信任；Node/Go/Rust 仍验证独立证书链。
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
  const page = await context.newPage(), errors = [];
  context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
  page.on('pageerror', e => errors.push(e.message));
  async function login(page, url = zh) {
    await page.goto(origin + url);
    await page.getByLabel('实例凭据', { exact: true }).fill(token);
    await page.getByRole('button', { name: '登录私有实例', exact: true }).click();
    await page.locator('.workspace').waitFor();
  }
  async function shot(page, name) {
    const selected = new URL(page.url()).searchParams.get('space');
    if (selected) await expect(page.locator('.space-picker select')).toHaveValue(selected);
    if (new URL(page.url()).searchParams.get('view') === 'devices')
      await page.getByRole('heading', { name: 'device-lamp', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(directory, name + '.png'), fullPage: true, animations: 'disabled' });
  }
  return { browser, context, page, token, adminToken, directory, errors, login, shot };
}
async function failStorage(page) {
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('limeiot.official:v1:')) throw new DOMException('fixture', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
}
async function confirmOriginals(page, count) {
  await until(async () => {
    if (await page.getByRole('cell', { name: '设备已确认', exact: true }).count() === count) return true;
    const reconcile = page.getByRole('button', { name: '向网关核对结果', exact: true }).first();
    if (await reconcile.count() && await reconcile.isEnabled()) await reconcile.click();
    return false;
  });
  await expect(page.getByRole('cell', { name: '设备已确认', exact: true })).toHaveCount(count);
}

test('通用产品工作台：存储失败零发送、丢响应即时查询、重启只读恢复与双标签页修订冲突', { timeout: 120000, skip: !enabled }, async () => {
  const s = await setup('official-products');
  const { page, context } = s;
  let appPosts = 0;
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/console\/v1\/products(?:\/[^/]+\/drafts)?$/.test(r.url())) appPosts++; });
  try {
    await s.login(page, zh + '?view=products&new=1');
    await expect(page.getByRole('button', { name: '创建产品', exact: true })).toBeEnabled();
    await failStorage(page);
    await page.getByLabel('产品名称', { exact: true }).fill('组合玩具');
    await page.getByRole('button', { name: '创建产品', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '浏览器无法保存请求记录' }).waitFor();
    assert.equal(appPosts, 0);
    await page.reload();
    await expect(page.getByRole('button', { name: '创建产品', exact: true })).toBeEnabled();
    await page.getByLabel('产品名称', { exact: true }).fill('组合玩具');
    await page.getByLabel('物模型 JSON', { exact: true }).fill('{"x":1,"x":2}');
    await page.getByRole('button', { name: '创建产品', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '不含重复字段' }).waitFor();
    assert.equal(appPosts, 0);
    const model = { services: [], description: '可组合玩具草稿' };
    await page.getByLabel('物模型 JSON', { exact: true }).fill(JSON.stringify(model));
    await fixture({ drop_product_responses: true });
    await page.getByRole('button', { name: '创建产品', exact: true }).click();
    await page.getByRole('alert').waitFor();
    // 无需刷新就能查询刚刚产生的未知记录；查询不得补发原 POST。
    await expect(page.getByRole('button', { name: '查询结果', exact: true })).toBeEnabled();
    const before = (await fixture()).product_posts;
    assert.equal(appPosts, 1);
    await fixture({ restart_api: true });
    await page.getByRole('button', { name: '查询结果', exact: true }).click();
    await page.getByRole('cell', { name: '草稿已保存', exact: true }).waitFor();
    assert.equal((await fixture()).product_posts, before);
    assert.equal(appPosts, 1);
    await page.getByRole('link', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('产品名称', { exact: true })).toHaveValue('组合玩具');
    const product = new URL(page.url()).searchParams.get('product');
    assert.match(product, /^product-[a-f0-9]{64}$/);
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(other.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
    await other.getByLabel('物模型 JSON', { exact: true }).fill('{"variant":"second"}');
    await page.getByLabel('物模型 JSON', { exact: true }).fill('{"variant":"first"}');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '草稿已保存' }).waitFor();
    await other.getByRole('button', { name: '保存草稿', exact: true }).click();
    await other.getByRole('status').filter({ hasText: '草稿已变化' }).waitFor();
    await expect(other.getByLabel('物模型 JSON', { exact: true })).toHaveValue('{"variant":"second"}');
    await other.getByRole('button', { name: '采用最新修订', exact: true }).click();
    await other.getByRole('button', { name: '保存草稿', exact: true }).click();
    await other.getByRole('status').filter({ hasText: '草稿已保存' }).waitFor();
    const cloud = await cloudClient();
    const latest = await cloud.call('/api/console/v1/products/' + product);
    assert.deepEqual(latest.model, { variant: 'second' });
    assert.equal((await cloud.call('/api/console/v1/products')).items.length, 1);
    await s.shot(other, 'products-desktop');
    await other.setViewportSize({ width: 390, height: 844 });
    await s.shot(other, 'products-mobile');
    assert.deepEqual(s.errors, []);
    await writeFile(path.join(s.directory, 'result.json'), JSON.stringify({ passed: true, response_loss: true, process_restart: true, conflict: true, recovery_extra_posts: 0, hardware: false }));
  } finally { await fixture({}); await s.browser.close(); }
});

test('通用工作台：空间、最小配对权限、真实 Rust/MQTT 远程闭环、CLI 材料及双受众双语主题', { timeout: 180000, skip: !enabled }, async () => {
  const s = await setup('official-workspace');
  const { page } = s;
  let stack;
  try {
    const key = path.join(s.directory, 'identity.pk8');
    await exec(path.join(core, 'target/debug/limeiot-gateway'), ['identity-init', key]);
    stack = await startStack({ directory: s.directory, gatewayEnv: { LIMEIOT_CONTROL_ALLOWED_ORIGINS: origin, LIMEIOT_GATEWAY_KEY_FILE: key, LIMEIOT_CONTROL_CA_FILE: process.env.LIMEIOT_TEST_CONTROL_CA_FILE, LIMEIOT_CONTROL_RELAY_ENABLED: '1' } });
    await s.login(page, zh + '?view=spaces');
    await page.getByLabel('空间名称', { exact: true }).fill('通用工作台家庭');
    await page.getByRole('button', { name: '创建空间', exact: true }).click();
    await page.getByRole('heading', { name: '绑定本地网关', exact: true }).waitFor();
    const space = new URL(page.url()).searchParams.get('space');
    const prefix = '/api/console/v1/spaces/' + space;
    const write = page.getByRole('checkbox', { name: '允许控制设备', exact: true });
    await expect(write).not.toBeChecked();
    await write.check();
    await page.getByRole('button', { name: '生成配对信息', exact: true }).click();
    await page.getByText('查看配对信息', { exact: true }).click();
    const material = page.getByLabel('配对信息', { exact: true });
    await material.waitFor();
    const pair = JSON.parse(await material.inputValue());
    const cloud = await cloudClient();
    const local = (await stack.request('/api/v1/spaces/space-demo/control-pairings', post({ control_origin: pair.control_origin, pairing_id: pair.pairing.pairing_id, code: pair.code }, 'official-pair'))).value;
    const review = await until(async () => { const v = (await stack.request('/api/v1/spaces/space-demo/control-pairings/' + local.link_id)).value; return v.status === 'awaiting_approval' && v; });
    assert.deepEqual([...review.review.pairing.scopes].sort(), ['commands.write', 'devices.read']);
    await stack.request('/api/v1/spaces/space-demo/control-pairings/' + local.link_id + '/approve', post({ review_revision: review.review_revision }));
    const binding = (await until(async () => { const v = (await stack.request('/api/v1/spaces/space-demo/control-pairings/' + local.link_id)).value; return v.status === 'active' && v; })).binding;
    await until(async () => (await cloud.connection(binding)).connected);
    // 空间仍在读取时，导航必须保留请求中的作用域，避免快速切页丢失选择。
    let releaseSpaces;
    const heldSpaces = new Promise(resolve => { releaseSpaces = resolve; });
    const spacesRoute = async route => { await heldSpaces; await route.continue().catch(() => {}); };
    await page.route('**/api/console/v1/spaces', spacesRoute);
    try {
      await page.goto(origin + zh + '?view=operations&space=' + space);
      const deviceLink = page.getByRole('link', { name: '设备管理', exact: true });
      await deviceLink.waitFor();
      assert.equal(new URL(await deviceLink.getAttribute('href'), origin).searchParams.get('space'), space);
    } finally {
      releaseSpaces();
      await page.unroute('**/api/console/v1/spaces', spacesRoute);
    }
    await expect(page.locator('.space-picker select')).toHaveValue(space);
    await page.getByRole('link', { name: '设备管理', exact: true }).click();
    const lamp = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'device-lamp', exact: true }) });
    await expect(lamp.getByRole('switch', { name: 'light.power', exact: true })).toBeEnabled();
    let appPosts = 0;
    page.on('request', r => { if (r.method() === 'POST' && /\/remote-commands$/.test(r.url())) appPosts++; });
    await failStorage(page);
    await lamp.getByRole('switch', { name: 'light.power', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '浏览器无法保存请求记录' }).waitFor();
    assert.equal(appPosts, 0);
    await page.reload();
    await expect(lamp.getByRole('switch', { name: 'light.power', exact: true })).toBeEnabled();
    await fixture({ drop_remote_responses: true });
    await lamp.getByRole('switch', { name: 'light.power', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.getByRole('link', { name: '查询结果', exact: true }).waitFor();
    const remoteBefore = (await fixture()).remote_posts;
    await fixture({ restart_api: true });
    await until(async () => (await cloud.connection(binding)).connected);
    await page.getByRole('link', { name: '查询结果', exact: true }).click();
    await page.getByRole('button', { name: '查询结果', exact: true }).click();
    // 云端只读查询保留耐久的受理状态；设备最终回执需显式向原网关核对。
    await until(async () => (await stack.request('/api/v1/spaces/space-demo/commands')).value.items.some(v => v.status === 'confirmed'));
    await confirmOriginals(page, 1);
    assert.equal((await fixture()).remote_posts, remoteBefore);
    assert.equal(appPosts, 1);
    await page.getByRole('link', { name: '设备管理', exact: true }).click();
    await expect(lamp.getByRole('switch', { name: 'light.power', exact: true })).toBeEnabled();
    await lamp.locator('input[type="number"]').fill('37');
    await lamp.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /受理|确认|设备/ }).waitFor();
    await page.getByRole('link', { name: '操作记录', exact: true }).click();
    const queries = page.getByRole('button', { name: '查询结果', exact: true });
    await expect(queries).toHaveCount(2);
    await queries.first().click();
    await until(async () => (await stack.request('/api/v1/spaces/space-demo/commands')).value.items.filter(v => v.status === 'confirmed').length === 2);
    await confirmOriginals(page, 2);
    assert.equal((await stack.request('/api/v1/spaces/space-demo/commands')).value.items.length, 2);
    await page.getByRole('link', { name: '设备管理', exact: true }).click();
    await s.shot(page, 'devices-desktop');
    const denied = await page.request.get(origin + '/api/admin/v1/status');
    assert.equal(denied.status(), 401);
    await page.getByRole('link', { name: '开发连接', exact: true }).click();
    await page.getByRole('button', { name: '创建 CLI 会话', exact: true }).click();
    const cli = JSON.parse(await page.getByLabel('CLI 凭据', { exact: true }).inputValue());
    assert.equal(cli.origin, origin);
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    for (const secret of [s.token, s.adminToken, pair.code, cli.session]) assert.ok(!stored.includes(secret));
    await page.getByRole('button', { name: '隐藏凭据', exact: true }).click();
    assert.ok(!(await page.content()).includes(cli.session));
    await page.getByRole('link', { name: '设备管理', exact: true }).click();
    await page.getByLabel('外观', { exact: true }).selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await s.shot(page, 'devices-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await s.shot(page, 'devices-mobile');
    await page.getByRole('link', { name: '语言 EN', exact: true }).click();
    await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('Appearance', { exact: true }).selectOption('light');
    await s.shot(page, 'devices-en-mobile');
    const adminContext = await s.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
    const admin = await adminContext.newPage();
    await admin.goto(origin + '/admin/');
    await admin.getByLabel('实例凭据', { exact: true }).fill(s.token);
    await admin.getByRole('button', { name: '登录私有实例', exact: true }).click();
    await admin.getByRole('alert').waitFor();
    await admin.getByLabel('实例凭据', { exact: true }).fill(s.adminToken);
    await admin.getByRole('button', { name: '登录私有实例', exact: true }).click();
    await admin.getByRole('heading', { name: '网关绑定', exact: true }).waitFor();
    await admin.getByRole('cell', { name: binding.gateway_id, exact: true }).waitFor();
    assert.equal((await admin.request.get(origin + prefix + '/devices')).status(), 401);
    assert.equal((await admin.request.get(origin + '/api/console/v1/products')).status(), 401);
    await s.shot(admin, 'admin-desktop');
    await admin.setViewportSize({ width: 390, height: 844 });
    await s.shot(admin, 'admin-mobile');
    assert.deepEqual(s.errors, []);
    await writeFile(path.join(s.directory, 'result.json'), JSON.stringify({ passed: true, real_mysql: true, real_wss: true, simulated_device: true, commands: 2, audience_isolation: true, multilingual: true, themes: true, official_cloud: false, hardware: false }));
  } finally { await fixture({}); await s.browser.close(); await stack?.close(); }
});

test('通用手机授权页面：明确批准、无关空间零请求、子会话领取及秘密不落盘', { timeout: 60000, skip: !enabled }, async () => {
  const s = await setup('official-native');
  try {
    const key = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('hex');
    async function native(route, value) {
      const response = await fetch(origin + '/api/native/v1/authorizations' + route, post(value));
      assert.equal(response.status, 200);
      return response.json();
    }
    const started = await native('', { request_key: key, code_challenge: createHash('sha256').update(verifier).digest('base64url'), platform: 'ios' });
    let spaceRequests = 0;
    s.page.on('request', r => { if (/\/api\/console\/v1\/spaces/.test(r.url())) spaceRequests++; });
    await s.login(s.page, zh + '?native=' + started.authorization_id);
    await s.page.getByRole('heading', { name: '授权手机登录', exact: true }).waitFor();
    const approve = s.page.getByRole('button', { name: '批准登录', exact: true });
    await expect(approve).toBeDisabled();
    assert.equal((await native('/poll', { request_key: key, code_verifier: verifier })).status, 'pending');
    await s.page.getByLabel('手机上的授权码', { exact: true }).fill(started.user_code);
    await approve.click();
    await s.page.getByText('请求已结束，请返回手机。', { exact: true }).waitFor();
    const approved = await native('/poll', { request_key: key, code_verifier: verifier });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.material.origin, origin);
    assert.equal(spaceRequests, 0);
    const local = await s.page.evaluate(() => JSON.stringify(localStorage));
    for (const secret of [s.token, key, verifier, started.user_code, approved.material.session]) assert.ok(!local.includes(secret));
    await s.shot(s.page, 'native-desktop');
    await s.page.setViewportSize({ width: 390, height: 844 });
    await s.shot(s.page, 'native-mobile');
    assert.deepEqual(s.errors, []);
    await writeFile(path.join(s.directory, 'result.json'), JSON.stringify({ passed: true, pkce: true, explicit_approval: true, unrelated_space_requests: 0, native_app: false, hardware: false }));
  } finally { await s.browser.close(); }
});

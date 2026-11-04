import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { until } from '../tools/dev-stack.mjs';
import { base, post, targets, devices, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

const namespace = `limeiot.observation-operation:${base}:`;
const panelFor = page => page.getByRole('region', { name: 'Zigbee设备接入', exact: true });
async function login(page, stack) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=models');
  const token = page.getByLabel('所有者凭据', { exact: true });
  await expect(token.or(panelFor(page))).toBeVisible();
  if (await token.isVisible()) {
    await token.fill(stack.env.LIMEIOT_TOKEN);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  }
  await expect(panelFor(page).getByRole('button', { name: '查询设备', exact: true })).toBeVisible();
}
async function prepare(page, id = devices[0]) {
  const panel = panelFor(page);
  await panel.getByLabel('设备 IEEE', { exact: true }).fill(targets[0]);
  await panel.getByLabel('设备编号', { exact: true }).fill(id);
  await panel.getByRole('button', { name: '查询设备', exact: true }).click();
  await expect(panel.getByRole('group', { name: '核对Zigbee设备', exact: true })).toBeVisible();
  await expect(panel.getByText('Environment-1', { exact: true })).toBeVisible();
}
async function originals(page) {
  return page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key))), namespace);
}
async function openHistory(page) {
  const summary = panelFor(page).getByText('接入操作记录', { exact: true });
  if (!await summary.locator('..').evaluate(element => element.open)) await summary.click();
}
const rowFor = (page, key) => panelFor(page).locator(`[data-observation-key="${key}"]`);
const sourceFor = page => panelFor(page).locator(`[data-observation-device="${devices[0]}"]`);

test('家庭网页完成Zigbee查询、明确接入、未知恢复、撤销、重启与重新接入联动', { timeout: 120000 }, async t => {
  let browser;
  t.after(async () => browser?.close());
  const { directory, stack, sensor, commands, control, stats } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/observation-operations')) posts++; });
  await login(page, stack);
  await prepare(page);
  assert.equal((await stack.request(base + '/devices/' + devices[0])).status, 404);
  await panelFor(page).getByRole('button', { name: '取消接入', exact: true }).click();
  assert.equal(posts, 0); assert.equal((await originals(page)).length, 0);
  const reads = (await stats()).samples[targets[0]];
  await prepare(page);
  assert.ok((await stats()).samples[targets[0]] > reads);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('limeiot.observation-operation:')) throw new Error('fixture-storage-fault');
      return original.call(this, key, value);
    };
  });
  await panelFor(page).getByRole('button', { name: '确认添加设备', exact: true }).click();
  await expect(panelFor(page).getByText('无法保存接入操作记录，尚未发送请求', { exact: true })).toBeVisible();
  assert.equal(posts, 0); assert.equal((await originals(page)).length, 0);
  await login(page, stack); await prepare(page);
  await page.route('**/observation-operations', async route => { const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort(); });
  await panelFor(page).getByRole('button', { name: '确认添加设备', exact: true }).click();
  await expect(panelFor(page).getByText('接入结果未知，请查询原操作', { exact: true })).toBeVisible();
  assert.equal(posts, 1);
  const saved = await originals(page), original = saved[0];
  assert.equal(saved.length, 1); assert.equal(original.request.change.device_id, devices[0]);
  assert.equal(original.request.change.type, 'sources.bind');
  assert.equal(JSON.stringify(saved).includes('manifest'), false);
  await page.unroute('**/observation-operations');
  await openHistory(page);
  await page.route('**/observation-operations/by-key/*', route => route.fulfill({ status: 404, json: { error: { code: 'observation_operation_not_found' } } }));
  await rowFor(page, original.request.idempotency_key).getByRole('button', { name: '查询原操作', exact: true }).click();
  await expect(panelFor(page).getByText('结果仍未知，请保留记录后查询原操作', { exact: true })).toBeVisible();
  assert.equal(posts, 1);
  await page.unroute('**/observation-operations/by-key/*');
  await page.route('**/observation-operations/by-key/*', async route => {
    const response = await route.fetch(), value = await response.json();
    value.request.change.device_id = 'forged-device';
    await route.fulfill({ status: 200, json: value });
  });
  await rowFor(page, original.request.idempotency_key).getByRole('button', { name: '查询原操作', exact: true }).click();
  await expect(rowFor(page, original.request.idempotency_key).getByText('结果未知', { exact: true })).toBeVisible();
  assert.equal(posts, 1);
  await page.unroute('**/observation-operations/by-key/*');
  await login(page, stack); await openHistory(page);
  assert.equal(posts, 1);
  await rowFor(page, original.request.idempotency_key).getByRole('button', { name: '查询原操作', exact: true }).click();
  await expect(rowFor(page, original.request.idempotency_key).getByText('已完成', { exact: true })).toBeVisible();
  await expect(sourceFor(page).getByText('已接入', { exact: true })).toBeVisible();
  const first = await until(async () => { const value = await sensor(); return value.ready && value; });
  assert.equal((await stack.request(base + '/rule-deployments', post(thresholdRule()))).status, 200);
  await until(async () => (await sensor()).state_revision > first.state_revision);
  await control(2900);
  await until(async () => { const list = await commands(); return list.length === 1 && list[0].status === 'confirmed'; });
  await sourceFor(page).getByRole('button', { name: '撤销接入', exact: true }).click();
  await panelFor(page).getByRole('button', { name: '取消撤销', exact: true }).click();
  assert.equal(posts, 1);
  await sourceFor(page).getByRole('button', { name: '撤销接入', exact: true }).click();
  await panelFor(page).getByRole('button', { name: '确认撤销接入', exact: true }).click();
  await expect(sourceFor(page).getByText('已撤销', { exact: true })).toBeVisible();
  assert.equal(posts, 2); assert.equal((await sensor()).ready, false);
  assert.equal((await sensor()).reported['environment.temperature'].quality, 'stale');
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: path.join(directory, 'observation-revoked-web.png'), fullPage: true });
  await stack.restartGateway();
  await expect(page.getByLabel('所有者凭据', { exact: true })).toBeVisible();
  await login(page, stack); await openHistory(page);
  for (const record of await originals(page)) {
    await rowFor(page, record.request.idempotency_key).getByRole('button', { name: '查询原操作', exact: true }).click();
    await expect(rowFor(page, record.request.idempotency_key).getByText('已完成', { exact: true })).toBeVisible();
  }
  await expect(sourceFor(page).getByText('已撤销', { exact: true })).toBeVisible();
  assert.equal((await sensor()).ready, false); assert.equal(posts, 2);
  await sourceFor(page).getByRole('button', { name: '重新接入', exact: true }).click();
  await expect(panelFor(page).getByRole('group', { name: '核对Zigbee设备', exact: true })).toBeVisible();
  await panelFor(page).getByRole('button', { name: '确认重新接入', exact: true }).click();
  await expect(sourceFor(page).getByText('已接入', { exact: true })).toBeVisible();
  assert.equal(posts, 3); await until(async () => (await sensor()).ready);
  assert.equal((await commands()).length, 1, '重启和重绑的高温首样本不补发');
  await control(2700); await until(async () => (await sensor()).reported['environment.temperature'].value === 2700);
  await control(2900); await until(async () => { const list = await commands(); return list.length === 2 && list.every(item => item.status === 'confirmed'); });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: path.join(directory, 'observation-bound-web.png'), fullPage: true });
  const report = { passed: true, real_gateway_sqlite_serial_and_mqtt: true, software_ncp: true, binding_posts: posts,
    cancel_zero_write: true, storage_failure_zero_post: true, lost_response_original_only: true,
    missing_and_forged_original_remain_unknown: true, restart_and_old_applied_cannot_reactivate: true,
    revoke_and_explicit_rebind: true, confirmed_threshold_commands: 2, responsive_390px: true,
    hardware: false, published: false, full_goal_completed: false };
  await writeFile(path.join(directory, 'observation-web-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'observation-web-report.json') }));
});

test('接入网页使用跨标签页锁、阻止未决来源换编号重发并拒绝被篡改的本机原请求', { timeout: 60000 }, async t => {
  let browser;
  t.after(async () => browser?.close());
  const { directory, stack } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(), other = await context.newPage();
  await login(other, stack);
  await other.evaluate(prefix => {
    window.fixtureLease = navigator.locks.request(prefix, () => new Promise(resolve => { window.fixtureRelease = resolve; window.fixtureLocked = true; }));
  }, namespace);
  await expect.poll(() => other.evaluate(() => window.fixtureLocked)).toBe(true);
  await login(page, stack); await prepare(page);
  let posts = 0; context.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/observation-operations')) posts++; });
  await panelFor(page).getByRole('button', { name: '确认添加设备', exact: true }).click();
  await expect(panelFor(page).getByText('另一个页面正在处理设备接入', { exact: true })).toBeVisible();
  assert.equal(posts, 0); assert.deepEqual(await originals(page), []);
  await other.evaluate(async () => { window.fixtureRelease(); await window.fixtureLease; });
  await panelFor(page).getByRole('button', { name: '确认添加设备', exact: true }).click();
  await expect(sourceFor(page).getByText('已接入', { exact: true })).toBeVisible();
  assert.equal(posts, 1);
  await other.bringToFront(); await prepare(other, 'alias-sensor');
  await panelFor(other).getByRole('button', { name: '确认添加设备', exact: true }).click();
  await expect(panelFor(other).getByText('请先查询该设备或来源的原操作', { exact: true })).toBeVisible();
  assert.equal(posts, 1);
  const record = (await originals(other))[0];
  await other.evaluate(({ prefix, key }) => {
    const value = JSON.parse(localStorage.getItem(prefix + key)); value.request.change.device_id = 'tampered';
    localStorage.setItem(prefix + key, JSON.stringify(value));
  }, { prefix: namespace, key: record.request.idempotency_key });
  await expect(panelFor(page).getByText('无法保存或读取接入操作记录，请保留原记录后检查浏览器存储', { exact: true })).toBeVisible();
  assert.equal(posts, 1);
  await writeFile(path.join(directory, 'observation-web-lock-report.json'), JSON.stringify({ passed: true,
    real_cross_tab_web_lock: true, busy_zero_save_and_post: true, pending_source_blocks_alias: true,
    rewritten_original_detected: true, binding_posts: posts, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'observation-web-lock-report.json') }));
});

test('候选过期、原生设备编号、坏候选和后台迟到读取均不能生成接入决定', { timeout: 60000 }, async t => {
  let browser;
  t.after(async () => browser?.close());
  const { directory, stack } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await page.clock.install();
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/observation-operations')) posts++; });
  await login(page, stack);
  await panelFor(page).getByLabel('设备 IEEE', { exact: true }).fill(targets[0]);
  await panelFor(page).getByLabel('设备编号', { exact: true }).fill('device-lamp');
  await panelFor(page).getByRole('button', { name: '查询设备', exact: true }).click();
  await expect(panelFor(page).getByText('设备编号已被其他设备使用', { exact: true })).toBeVisible();
  await page.route('**/observation-candidates', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(), value = await response.json(); value.signature.model = 'forged';
    await route.fulfill({ status: 200, json: value });
  });
  await panelFor(page).getByLabel('设备编号', { exact: true }).fill(devices[0]);
  await panelFor(page).getByRole('button', { name: '查询设备', exact: true }).click();
  await expect(panelFor(page).getByText('接入信息未通过校验，请重新读取', { exact: true })).toBeVisible();
  await page.unroute('**/observation-candidates');
  let release, intercepted, fulfilled;
  const waiting = new Promise(resolve => { intercepted = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const handled = new Promise(resolve => { fulfilled = resolve; });
  await page.route('**/observation-candidates', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); intercepted(); await gate; await route.fulfill({ response }); fulfilled();
  });
  await panelFor(page).getByRole('button', { name: '查询设备', exact: true }).click(); await waiting;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  release(); await handled; await page.unroute('**/observation-candidates');
  await expect(panelFor(page).getByRole('button', { name: '查询设备', exact: true })).toBeEnabled();
  assert.equal(await panelFor(page).getByRole('group', { name: '核对Zigbee设备', exact: true }).count(), 0);
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await prepare(page);
  await page.clock.fastForward(61000);
  await expect(panelFor(page).getByText('接入信息已过期，请重新查询设备', { exact: true })).toBeVisible();
  await expect(panelFor(page).getByRole('button', { name: '确认添加设备', exact: true })).toBeDisabled();
  assert.equal(posts, 0); assert.deepEqual(await originals(page), []);
  await writeFile(path.join(directory, 'observation-web-review-report.json'), JSON.stringify({ passed: true,
    native_device_not_taken_over: true, candidate_digest_mismatch_rejected: true,
    late_background_read_does_not_restore_review: true, expired_candidate_disabled_using_browser_clock: true,
    binding_posts: posts, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'observation-web-review-report.json') }));
});

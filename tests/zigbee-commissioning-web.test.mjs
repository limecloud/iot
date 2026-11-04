import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { until } from '../tools/dev-stack.mjs';
import { base, post, targets, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

const namespace = `limeiot.zigbee-operation:${base}:`;
const panelFor = page => page.getByRole('region', { name: 'Zigbee入网管理', exact: true });
const reviewFor = page => panelFor(page).getByRole('group', { name: '核对Zigbee入网', exact: true });
const sourcesFor = page => page.getByRole('region', { name: 'Zigbee设备接入', exact: true });
const rowFor = (page, key) => panelFor(page).locator(`[data-zigbee-key="${key}"]`);
async function login(page, stack) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=models');
  const credential = page.getByLabel('所有者凭据', { exact: true });
  await expect(credential.or(panelFor(page))).toBeVisible();
  if (await credential.isVisible()) {
    await credential.fill(stack.env.LIMEIOT_TOKEN);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  }
  await expect(panelFor(page).getByRole('button', { name: '开放入网', exact: true })).toBeEnabled();
}
async function prepare(page, close = false) {
  await panelFor(page).getByRole('button', { name: close ? '关闭入网' : '开放入网', exact: true }).click();
  await expect(reviewFor(page)).toBeVisible();
}
async function originals(page) {
  return page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key))), namespace);
}
async function history(page) {
  const summary = panelFor(page).getByText('入网操作记录', { exact: true });
  if (!await summary.locator('..').evaluate(element => element.open)) await summary.click();
}
async function screenshot(page, file) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
}
async function report(directory, name, value) {
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify({ passed: true, ...value, hardware: false, published: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: file }));
}

test('入网网页先保存原请求，丢响应只读恢复，再明确发现接入与阈值联动', { timeout: 120000 }, async t => {
  let browser; t.after(async () => browser?.close());
  const { directory, stack, stats, control, commands } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/zigbee-operations')) posts++; });
  await login(page, stack); await prepare(page);
  assert.deepEqual(await originals(page), []); assert.equal(posts, 0); assert.deepEqual((await stats()).join_requests, []);
  await reviewFor(page).getByRole('button', { name: '取消入网操作', exact: true }).click();
  assert.equal(await reviewFor(page).count(), 0); assert.deepEqual(await originals(page), []);
  await prepare(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('limeiot.zigbee-operation:')) throw new Error('fixture-storage-fault');
      return original.call(this, key, value);
    };
  });
  await reviewFor(page).getByRole('button', { name: '确认开放', exact: true }).click();
  await expect(panelFor(page).getByText('无法保存入网操作记录，尚未发送请求', { exact: true })).toBeVisible();
  assert.equal(posts, 0); assert.deepEqual(await originals(page), []); assert.deepEqual((await stats()).join_requests, []);
  await login(page, stack); await prepare(page);
  await screenshot(page, path.join(directory, 'commissioning-review-390.png'));
  await page.route('**/zigbee-operations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const saved = await originals(page), key = route.request().headers()['idempotency-key'];
    assert.equal(saved.length, 1); assert.equal(saved[0].request.idempotency_key, key, '回读原请求先于POST');
    assert.deepEqual(saved[0].request.change, route.request().postDataJSON());
    const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort();
  });
  await reviewFor(page).getByRole('button', { name: '确认开放', exact: true }).click();
  await expect(panelFor(page).getByText('入网结果未知，请查询原操作', { exact: true })).toBeVisible();
  const [original] = await originals(page), key = original.request.idempotency_key;
  assert.equal(posts, 1); assert.deepEqual((await stats()).join_requests, [60]);
  assert.deepEqual(Object.keys(original.request.change).sort(), ['coordinator_id', 'duration_seconds', 'expected_revision']);
  await page.unroute('**/zigbee-operations'); await history(page);
  await page.route('**/zigbee-operations/by-key/*', route => route.fulfill({ status: 404, json: { error: { code: 'zigbee_operation_not_found' } } }));
  await rowFor(page, key).getByRole('button', { name: '查询原入网操作', exact: true }).click();
  await expect(panelFor(page).getByText('结果仍未知，请保留原操作记录', { exact: true })).toBeVisible();
  await page.unroute('**/zigbee-operations/by-key/*');
  await page.route('**/zigbee-operations/by-key/*', async route => {
    const response = await route.fetch(), value = await response.json(); value.request.change.duration_seconds = 0;
    await route.fulfill({ status: 200, json: value });
  });
  await rowFor(page, key).getByRole('button', { name: '查询原入网操作', exact: true }).click();
  await expect(rowFor(page, key).getByText('结果未知', { exact: true })).toBeVisible();
  await page.unroute('**/zigbee-operations/by-key/*');
  await page.route('**/zigbee-operations/by-key/*', async route => {
    const response = await route.fetch(), text = await response.text();
    await route.fulfill({ status: 200, contentType: 'application/json', body: text.replace('{', '{"status":"unknown",') });
  });
  await rowFor(page, key).getByRole('button', { name: '查询原入网操作', exact: true }).click();
  await expect(rowFor(page, key).getByText('结果未知', { exact: true })).toBeVisible();
  await page.unroute('**/zigbee-operations/by-key/*');
  await login(page, stack); await history(page);
  await expect(rowFor(page, key).getByText('协议已受理', { exact: true })).toBeVisible();
  await rowFor(page, key).getByRole('button', { name: '查询原入网操作', exact: true }).click();
  await expect(panelFor(page).getByText('已查询原操作，协议已受理', { exact: true })).toBeVisible();
  assert.equal(posts, 1); assert.deepEqual((await stats()).join_requests, [60]);
  await prepare(page, true);
  assert.equal(posts, 1);
  await reviewFor(page).getByRole('button', { name: '取消入网操作', exact: true }).click();
  await prepare(page, true); await reviewFor(page).getByRole('button', { name: '确认关闭', exact: true }).click();
  await expect(panelFor(page).getByText('关闭入网协议已受理', { exact: true })).toBeVisible();
  assert.equal(posts, 2); assert.deepEqual((await stats()).join_requests, [60, 0]);
  const source = sourcesFor(page);
  await source.getByRole('button', { name: '发现已有设备', exact: true }).click();
  const neighbors = source.getByRole('group', { name: '发现的Zigbee设备', exact: true });
  await neighbors.getByRole('article').filter({ hasText: targets[0] }).getByRole('button', { name: '读取端点', exact: true }).click();
  await source.getByRole('group', { name: 'Zigbee设备端点', exact: true }).getByRole('button', { name: '查询此端点', exact: true }).click();
  await source.getByRole('group', { name: '核对Zigbee设备', exact: true }).getByRole('button', { name: '确认添加设备', exact: true }).click();
  const id = 'zigbee-' + targets[0], sensor = async () => (await stack.request(base + '/devices/' + id)).value;
  await expect(source.locator(`[data-observation-device="${id}"]`).getByText('已接入', { exact: true })).toBeVisible();
  const initial = await until(async () => { const value = await sensor(); return value.ready && value; });
  const rule = thresholdRule(); rule.trigger.device = id; rule.conditions[0].device = id;
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  await until(async () => (await sensor()).state_revision > initial.state_revision);
  await control(2900); await until(async () => { const items = await commands(); return items.length === 1 && items[0].status === 'confirmed'; });
  await stack.restartGateway();
  await expect(page.getByLabel('所有者凭据', { exact: true })).toBeVisible(); await login(page, stack); await history(page);
  await expect(rowFor(page, key).getByText('协议已受理', { exact: true })).toBeVisible();
  await until(async () => (await sensor()).ready);
  assert.equal(posts, 2); assert.equal((await commands()).length, 1); assert.deepEqual((await stats()).join_requests, [60, 0]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); assert.deepEqual((await stats()).errors, []);
  await screenshot(page, path.join(directory, 'commissioning-history-390.png'));
  await report(directory, 'commissioning-web-flow.json', { cancel_and_storage_failure_zero_post: true,
    original_readback_before_post: true, missing_forged_duplicate_key_receipts_remain_unknown: true,
    explicit_open_and_close: true, refresh_and_gateway_restart_zero_replay: true, commissioning_posts: posts,
    discovery_explicit_binding_and_confirmed_threshold: true, confirmed_commands: 1, responsive_390px: true });
});

test('入网网页跨标签页互斥，未知操作禁止换键开放，明确关闭后仍保留原未知记录', { timeout: 90000 }, async t => {
  let browser; t.after(async () => browser?.close());
  const { directory, stack, stats, join } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(), other = await context.newPage();
  await login(other, stack);
  await other.evaluate(prefix => {
    window.fixtureLease = navigator.locks.request(prefix, () => new Promise(resolve => { window.fixtureRelease = resolve; window.fixtureLocked = true; }));
  }, namespace);
  await expect.poll(() => other.evaluate(() => window.fixtureLocked)).toBe(true);
  await login(page, stack); await prepare(page);
  let posts = 0; context.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/zigbee-operations')) posts++; });
  await reviewFor(page).getByRole('button', { name: '确认开放', exact: true }).click();
  await expect(panelFor(page).getByText('另一个页面正在处理入网操作', { exact: true })).toBeVisible();
  assert.equal(posts, 0); assert.deepEqual(await originals(page), []);
  await other.evaluate(async () => { window.fixtureRelease(); await window.fixtureLease; });
  await join('timeout');
  await reviewFor(page).getByRole('button', { name: '确认开放', exact: true }).click();
  await expect(panelFor(page).getByText('入网结果未知，请查询原操作', { exact: true })).toBeVisible();
  const [original] = await originals(page), key = original.request.idempotency_key;
  await until(async () => (await stack.request(base + '/zigbee-operations/by-key/' + key)).value.completed_at);
  await panelFor(page).getByRole('button', { name: '开放入网', exact: true }).click();
  await expect(panelFor(page).getByText('此前入网结果未确认，请查询原操作或明确关闭', { exact: true })).toBeVisible();
  assert.equal(await reviewFor(page).count(), 0); assert.equal(posts, 1); assert.deepEqual((await stats()).join_requests, [60]);
  await join('normal'); await prepare(page, true);
  await reviewFor(page).getByRole('button', { name: '确认关闭', exact: true }).click();
  await expect(panelFor(page).getByText('关闭入网协议已受理', { exact: true })).toBeVisible();
  await history(page); await expect(rowFor(page, key).getByText('结果未知', { exact: true })).toBeVisible();
  assert.equal(posts, 2); assert.deepEqual((await stats()).join_requests, [60, 0]);
  await other.evaluate(({ prefix, key }) => localStorage.removeItem(prefix + key), { prefix: namespace, key });
  await expect(panelFor(page).getByText('无法读取入网操作记录，请保留原记录后检查浏览器存储', { exact: true })).toBeVisible();
  await expect(panelFor(page).getByRole('button', { name: '关闭入网', exact: true })).toBeDisabled();
  assert.equal(posts, 2);
  await report(directory, 'commissioning-web-lock.json', { real_cross_tab_lock: true, busy_zero_save_and_post: true,
    unknown_blocks_replacement_open: true, separate_explicit_close: true, original_unknown_preserved: true,
    removed_original_blocks_further_write: true, commissioning_posts: posts });
});

test('入网核对在输入、过期、配置变化和后台迟到时失效且零写入', { timeout: 90000 }, async t => {
  let browser; t.after(async () => browser?.close());
  const { directory, stack, stats } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await page.clock.install();
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/zigbee-operations')) posts++; });
  await login(page, stack); await prepare(page);
  await panelFor(page).getByLabel('开放时长（秒）', { exact: true }).fill('30');
  assert.equal(await reviewFor(page).count(), 0);
  await prepare(page); await page.clock.fastForward(61000);
  await expect(reviewFor(page)).toHaveCount(0);
  await expect(panelFor(page).getByText('入网确认已过期，请重新核对', { exact: true })).toBeVisible();
  await prepare(page);
  await page.route('**/zigbee-coordinators', async route => {
    const response = await route.fetch(), value = await response.json(); value.items[0].revision = 'sha256:' + '0'.repeat(64);
    await route.fulfill({ status: 200, json: value });
  });
  await reviewFor(page).getByRole('button', { name: '确认开放', exact: true }).click();
  await expect(panelFor(page).getByText('协调器配置已变化，请重新核对', { exact: true })).toBeVisible();
  assert.equal(await reviewFor(page).count(), 0); await page.unroute('**/zigbee-coordinators');
  let release, captured, finished;
  const gate = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { captured = resolve; }), handled = new Promise(resolve => { finished = resolve; });
  await page.route('**/zigbee-coordinators', async route => {
    const response = await route.fetch(); captured(); await gate;
    try { await route.fulfill({ response }); }
    catch (error) { assert.match(error.message, /canceled|Invalid InterceptionId|already handled/i); }
    finally { finished(); }
  });
  await panelFor(page).getByRole('button', { name: '开放入网', exact: true }).click(); await intercepted;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  release(); await handled; await page.unroute('**/zigbee-coordinators');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panelFor(page).getByRole('button', { name: '开放入网', exact: true })).toBeEnabled();
  assert.equal(await reviewFor(page).count(), 0);
  await prepare(page);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(reviewFor(page)).toHaveCount(0);
  assert.equal(posts, 0); assert.deepEqual(await originals(page), []); assert.deepEqual((await stats()).join_requests, []);
  await report(directory, 'commissioning-web-review.json', { changed_input_and_expiry_invalidate: true,
    coordinator_revision_rechecked_before_write: true, late_background_response_does_not_restore_review: true,
    offline_invalidates: true, commissioning_posts: 0 });
});

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { until } from '../tools/dev-stack.mjs';
import { base, post, targets, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

const panelFor = page => page.getByRole('region', { name: 'Zigbee设备接入', exact: true });
const neighborsFor = page => panelFor(page).getByRole('group', { name: '发现的Zigbee设备', exact: true });
const endpointsFor = page => panelFor(page).getByRole('group', { name: 'Zigbee设备端点', exact: true });
async function login(page, stack) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=models');
  const credential = page.getByLabel('所有者凭据', { exact: true });
  await expect(credential.or(panelFor(page))).toBeVisible();
  if (await credential.isVisible()) {
    await credential.fill(stack.env.LIMEIOT_TOKEN);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  }
  await expect(panelFor(page).getByRole('button', { name: '发现已有设备', exact: true })).toBeEnabled();
}
async function discover(page) {
  await panelFor(page).getByRole('button', { name: '发现已有设备', exact: true }).click();
  await expect(neighborsFor(page)).toBeVisible();
}
async function selectFirst(page) {
  await neighborsFor(page).getByRole('article').filter({ hasText: targets[0] }).getByRole('button', { name: '读取端点', exact: true }).click();
  await expect(endpointsFor(page)).toBeVisible();
}
async function screenshot(page, file) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
}

test('390px家庭网页从邻居发现、访谈端点到明确添加和confirmed联动', { timeout: 90000 }, async t => {
  let browser; t.after(async () => browser?.close());
  const { directory, stack, stats, control, commands } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/observation-operations')) posts++; });
  await login(page, stack);
  const csrf = await page.evaluate(async url => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coordinator_id: 'home-znp' }) })).status, base + '/observation-discoveries');
  assert.equal(csrf, 403);
  await discover(page);
  await expect(neighborsFor(page).getByRole('article')).toHaveCount(2);
  assert.equal(posts, 0); assert.equal((await stats()).af_requests, 0);
  await screenshot(page, path.join(directory, 'discovery-neighbors-390.png'));
  await selectFirst(page);
  await expect(endpointsFor(page).getByRole('button', { name: '查询此端点', exact: true })).toBeEnabled();
  assert.equal((await stats()).af_requests, 0);
  await screenshot(page, path.join(directory, 'discovery-endpoints-390.png'));
  await endpointsFor(page).getByRole('button', { name: '查询此端点', exact: true }).click();
  const review = panelFor(page).getByRole('group', { name: '核对Zigbee设备', exact: true });
  await expect(review).toBeVisible(); await expect(review.getByText('Environment-1', { exact: true })).toBeVisible();
  const id = 'zigbee-' + targets[0], sensor = async () => (await stack.request(base + '/devices/' + id)).value;
  assert.equal((await stack.request(base + '/devices/' + id)).status, 404); assert.equal(posts, 0);
  await review.getByRole('button', { name: '确认添加设备', exact: true }).click();
  await expect(panelFor(page).locator(`[data-observation-device="${id}"]`).getByText('已接入', { exact: true })).toBeVisible();
  assert.equal(posts, 1); assert.equal(await neighborsFor(page).count(), 0); assert.equal(await endpointsFor(page).count(), 0);
  const initial = await until(async () => { const value = await sensor(); return value.ready && value; });
  const rule = thresholdRule(); rule.trigger.device = id; rule.conditions[0].device = id;
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  await until(async () => (await sensor()).state_revision > initial.state_revision);
  await control(2900); await until(async () => { const list = await commands(); return list.length === 1 && list[0].status === 'confirmed'; });
  await stack.restartGateway(); await until(async () => (await sensor()).ready);
  await expect(page.getByLabel('所有者凭据', { exact: true })).toBeVisible();
  await login(page, stack);
  assert.equal(await neighborsFor(page).count(), 0); assert.equal(await endpointsFor(page).count(), 0);
  assert.equal((await commands()).length, 1); assert.equal(posts, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); assert.deepEqual((await stats()).errors, []);
  await writeFile(path.join(directory, 'discovery-web-report.json'), JSON.stringify({ passed: true, discovery_interview_review_explicit_bind: true,
    csrf_required: true, readonly_discovery_af_requests: 0, binding_posts: posts, confirmed_commands: 1,
    restart_no_replay_or_stale_discovery: true, responsive_390px: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'discovery-web-report.json') }));
});

test('坏发现回执、非支持端点、输入变化、后台迟到响应与过期均不能直接接入', { timeout: 90000 }, async t => {
  let browser; t.after(async () => browser?.close());
  const { directory, stack, stats } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await page.clock.install();
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/observation-operations')) posts++; });
  await login(page, stack);
  await page.route('**/observation-discoveries', async route => {
    const response = await route.fetch(), value = await response.json(); value.coordinator_ieee = '0102030405060709';
    await route.fulfill({ status: 200, json: value });
  });
  await panelFor(page).getByRole('button', { name: '发现已有设备', exact: true }).click();
  await expect(panelFor(page).getByText('接入信息未通过校验，请重新读取', { exact: true })).toBeVisible();
  assert.equal(await neighborsFor(page).count(), 0); await page.unroute('**/observation-discoveries');
  await discover(page);
  await page.route('**/observation-endpoints', async route => {
    const response = await route.fetch(), value = await response.json(); value.endpoints[0].profile_id = 0x0105;
    await route.fulfill({ status: 200, json: value });
  });
  await selectFirst(page);
  await expect(endpointsFor(page).getByText('暂不支持此端点', { exact: true })).toBeVisible();
  await expect(endpointsFor(page).getByRole('button', { name: '查询此端点', exact: true })).toBeDisabled();
  await panelFor(page).getByLabel('设备 IEEE', { exact: true }).fill(targets[1]);
  assert.equal(await endpointsFor(page).count(), 0); await page.unroute('**/observation-endpoints');
  let release, captured, finished;
  const gate = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { captured = resolve; }), handled = new Promise(resolve => { finished = resolve; });
  await page.route('**/observation-discoveries', async route => {
    const response = await route.fetch(); captured(); await gate;
    try { await route.fulfill({ response }); }
    catch (error) { assert.match(error.message, /canceled|Invalid InterceptionId|already handled/i); }
    finally { finished(); }
  });
  await panelFor(page).getByRole('button', { name: '发现已有设备', exact: true }).click(); await intercepted;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  release(); await handled;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panelFor(page).getByRole('button', { name: '发现已有设备', exact: true })).toBeEnabled();
  assert.equal(await neighborsFor(page).count(), 0); await page.unroute('**/observation-discoveries');
  await discover(page);
  const reads = (await stats()).neighbor_requests;
  await page.clock.fastForward(61000);
  await expect(neighborsFor(page)).toHaveCount(0);
  await expect(panelFor(page).getByText('发现信息已过期，请重新查询', { exact: true })).toBeVisible();
  assert.equal((await stats()).neighbor_requests, reads, '过期不自动重查');
  assert.equal((await stats()).af_requests, 0); assert.equal(posts, 0);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('coordinator_neighbors'))), false);
  await writeFile(path.join(directory, 'discovery-web-boundaries-report.json'), JSON.stringify({ passed: true, bad_context_rejected: true,
    unsupported_endpoint_disabled: true, input_change_and_background_invalidate: true, expired_results_removed_without_retry: true,
    discovery_not_persisted: true, binding_posts: 0, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'discovery-web-boundaries-report.json') }));
});

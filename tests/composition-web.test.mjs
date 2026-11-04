import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startStack, until } from '../tools/dev-stack.mjs';

const base = '/api/v1/spaces/space-demo', storage = `limeiot.composition:${base}`;
async function setup(t, { clock = false } = {}) {
  const stack = await startStack(); t.after(() => stack.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  if (clock) await page.clock.install();
  const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === base + '/rule-deployments') posts.push({ body: req.postDataJSON(), condition: req.headers()['if-none-match'] }); });
  async function connect() {
    if (await page.getByLabel('所有者凭据', { exact: true }).isVisible()) {
      await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
      await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
    }
    const navigation = page.getByRole('button', { name: '自动化', exact: true });
    if (await navigation.getAttribute('aria-current') !== 'page') {
      await page.getByRole('button', { name: '家庭导航', exact: true }).click();
      await navigation.click();
    }
    const details = panel.locator('details').first();
    if (!await details.evaluate(element => element.open)) await panel.getByText('使用组合包', { exact: true }).click();
  }
  const panel = page.getByRole('region', { name: '组合包', exact: true });
  await page.goto(stack.env.LIMEIOT_ENDPOINT); await connect();
  const preview = panel.getByRole('button', { name: '预演组合', exact: true }), enable = panel.getByRole('button', { name: '启用组合', exact: true });
  async function bind() {
    await expect(panel.getByLabel('组合模块 touch', { exact: true })).toBeEnabled();
    await panel.getByLabel('组合模块 touch', { exact: true }).selectOption('device-button');
    await panel.getByLabel('组合模块 light', { exact: true }).selectOption('device-lamp');
  }
  async function plan() { await preview.click(); await expect(enable).toBeEnabled(); }
  const record = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage);
  const empty = async () => {
    assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
    assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  };
  async function evidence(name, result) {
    assert.deepEqual(errors, []);
    const file = path.join(stack.directory, name + '.json');
    await writeFile(file, JSON.stringify({ passed: true, real_gateway: true, real_sqlite: true, real_mqtt: true, browser: true, deployment_posts: posts.length, ...result, hardware: false, nas_image: false, full_goal_completed: false }, null, 2) + '\n');
    t.diagnostic('evidence: ' + file);
  }
  return { stack, page, context, panel, posts, connect, bind, plan, enable, preview, record, empty, evidence };
}

test('组合网页完整旅程：预演零执行、明确启用、两步确认、停用与重启恢复', { timeout: 90000 }, async t => {
  const state = await setup(t), { stack, page, panel, posts } = state;
  await expect(state.preview).toBeDisabled(); await expect(state.enable).toBeDisabled();
  await state.bind(); await state.plan(); await state.empty();
  await expect(panel.getByText('预演通过，设备尚未执行', { exact: true })).toBeVisible();
  assert.equal(posts.length, 0); await state.enable.click();
  await expect(panel.getByText('启用回执已确认', { exact: true })).toBeVisible();
  const original = await state.record(); assert.equal(original.state, 'acknowledged');
  assert.equal(posts.length, 1); assert.equal(posts[0].condition, '*');
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const row = page.locator('.deployment'); await expect(row).toHaveCount(1); await expect(row.locator('li')).toHaveCount(2);
  await expect(row.getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
  stack.button.stdin.write(JSON.stringify({ event_id: 'composition-web-first', occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } }) + '\n');
  await until(async () => { const commands = (await stack.request(base + '/commands')).value.items; return commands.length === 2 && commands.every(command => command.status === 'confirmed'); });
  const lamp = (await stack.request(base + '/devices/device-lamp')).value;
  assert.equal(lamp.reported['light.power'].value, true); assert.equal(lamp.reported['light.brightness'].value, 35);
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(stack.directory, 'composition-mobile.png'), fullPage: true });
  await row.getByRole('button', { name: '停用', exact: true }).click(); await expect(row).toHaveCount(0);
  stack.button.stdin.write(JSON.stringify({ event_id: 'composition-web-stopped', occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } }) + '\n');
  await until(async () => (await stack.request(base + '/events?after=0')).value.items.some(item => item.type === 'device.event' && item.payload.data.event_id === 'composition-web-stopped'));
  assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
  await stack.restartGateway(); await page.reload(); await state.connect();
  await expect(panel.getByRole('button', { name: '查询当前部署', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '查询当前部署', exact: true }).click();
  await expect(panel.getByText('当前组合未启用', { exact: true })).toBeVisible();
  assert.deepEqual(await state.record(), original); assert.equal(posts.length, 1);
  await panel.getByRole('button', { name: '准备其他组合', exact: true }).click(); await expect(state.preview).toBeDisabled();
  assert.equal(await state.record(), null); assert.equal(posts.length, 1);
  await state.evidence('composition-web-success', { preview_zero_execution: true, conditional_create: true, two_confirmed_commands: true, explicit_stop_blocks_new_event: true, restart_read_only: true, mobile_no_overflow: true });
});

test('组合网页保存失败零提交，丢回执恢复仅查询，损坏和删除记录拒绝新写', { timeout: 90000 }, async t => {
  const state = await setup(t), { page, panel, posts, stack } = state;
  await state.bind(); await state.plan();
  await page.evaluate(key => { window.__compositionSet = Storage.prototype.setItem; Storage.prototype.setItem = function(name, value) { if (name === key) throw new Error('fixture_storage_failure'); return window.__compositionSet.call(this, name, value); }; }, storage);
  await state.enable.click(); await expect(panel.getByText('无法核对本地提交记录，已暂停新提交', { exact: true })).toBeVisible();
  assert.equal(posts.length, 0); await state.empty();
  await page.evaluate(() => { Storage.prototype.setItem = window.__compositionSet; }); await page.reload(); await state.connect();
  await state.bind(); await state.plan();
  let intercepted;
  const completed = new Promise(resolve => { intercepted = resolve; });
  await page.route('**' + base + '/rule-deployments', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); intercepted();
  });
  await state.enable.click(); await completed;
  await expect(panel.getByText('原提交结果待核实', { exact: true })).toBeVisible();
  await page.unroute('**' + base + '/rule-deployments');
  const original = await state.record(); assert.equal(original.state, 'attempted'); assert.equal(posts.length, 1);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 1);
  await page.reload(); await state.connect(); await panel.getByRole('button', { name: '查询当前部署', exact: true }).click();
  await expect(panel.getByText('当前已启用，原提交结果仍待核实', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '准备其他组合', exact: true })).toHaveCount(0);
  await expect(state.enable).toHaveCount(0); assert.deepEqual(await state.record(), original); assert.equal(posts.length, 1);
  const second = await state.context.newPage(); await second.goto(stack.env.LIMEIOT_ENDPOINT);
  await second.evaluate(key => { localStorage.removeItem(key); }, storage);
  await expect(panel.getByText('无法核对本地提交记录，已暂停新提交', { exact: true })).toBeVisible();
  await second.evaluate(({key, original}) => { localStorage.setItem(key, JSON.stringify(original)); }, {key: storage, original});
  await page.reload(); await state.connect();
  await second.evaluate(key => { localStorage.setItem(key, '{'); }, storage);
  await expect(panel.getByText('无法核对本地提交记录，已暂停新提交', { exact: true })).toBeVisible();
  assert.equal(posts.length, 1); assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await second.close();
  await state.evidence('composition-web-faults', { save_failure_zero_posts: true, lost_response_get_only: true, current_state_not_original_receipt: true, unknown_blocks_replacement: true, cross_tab_deleted_record_blocks: true, corrupt_record_blocks: true });
});

test('组合网页预演因绑定、后台和模型变化失效，跨标签锁与条件创建拒绝覆盖', { timeout: 90000 }, async t => {
  const state = await setup(t, { clock: true }), { page, panel, posts, stack } = state;
  await state.bind(); await state.plan();
  await page.clock.fastForward(60001); await expect(state.enable).toBeDisabled(); await state.plan();
  await panel.getByLabel('组合模块 light', { exact: true }).selectOption(''); await expect(state.enable).toBeDisabled();
  await panel.getByLabel('组合模块 light', { exact: true }).selectOption('device-lamp'); await expect(state.enable).toBeDisabled(); await state.plan();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(state.enable).toBeDisabled();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(state.preview).toBeEnabled(); await expect(state.enable).toBeDisabled(); await state.plan();
  const other = await state.context.newPage(); await other.goto(stack.env.LIMEIOT_ENDPOINT);
  await other.evaluate(key => new Promise(resolve => { void navigator.locks.request(key, async () => { resolve(); await new Promise(release => { window.__compositionRelease = release; }); }); }), storage);
  await state.enable.click(); await expect(panel.getByText('另一个标签正在提交组合，请稍后查询', { exact: true })).toBeVisible();
  assert.equal(posts.length, 0); await state.empty();
  await other.evaluate(() => window.__compositionRelease()); await other.close();
  await page.route('**' + base + '/devices/device-lamp', async route => { const response = await route.fetch(), body = await response.json(); body.model_revision = 'sha256:' + '0'.repeat(64); await route.fulfill({ response, json: body }); });
  await state.enable.click(); await expect(panel.getByText('设备能力已变化，请重新选择并预演', { exact: true })).toBeVisible();
  assert.equal(posts.length, 0); await state.empty();
  await page.unroute('**' + base + '/devices/device-lamp'); await state.plan();
  let frozen;
  await page.route('**' + base + '/rule-deployments', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    frozen = route.request().postDataJSON();
    const previous = { ...frozen, cooldown_ms: frozen.cooldown_ms + 1 };
    const response = await stack.request(base + '/rule-deployments', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(previous) });
    assert.equal(response.status, 200); await route.continue();
  });
  await state.enable.click(); await expect(panel.getByText('提交未获接受', { exact: true })).toBeVisible();
  assert.equal(posts.length, 1); assert.equal(posts[0].condition, '*'); assert.equal((await state.record()).state, 'rejected');
  const deployed = (await stack.request(base + '/rule-deployments')).value.items;
  assert.equal(deployed.length, 1); assert.equal(deployed[0].rule.cooldown_ms, frozen.cooldown_ms + 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await state.evidence('composition-web-concurrency', { proof_expires_after_60_seconds: true, binding_change_invalidates_proof: true, background_invalidates_proof: true, changed_model_blocks_deploy: true, cross_tab_lock: true, conditional_create_preserves_existing_rule: true });
});

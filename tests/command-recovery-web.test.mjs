import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startStack, until } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const base = '/api/v1/spaces/space-demo', storageKey = 'limeiot.pending';
const lamp = page => page.getByRole('article', { name: '环境灯', exact: true });
const power = page => lamp(page).getByRole('switch', { name: '电源', exact: true });
const recover = page => lamp(page).getByRole('button', { name: '查询原操作', exact: true });
async function login(page, stack) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  const token = page.getByLabel('所有者凭据', { exact: true });
  if (await token.isVisible()) {
    await token.fill(stack.env.LIMEIOT_TOKEN);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  }
  await expect(lamp(page)).toBeVisible();
}
const records = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), storageKey);

test('普通命令：跨浏览器持久恢复、错误回执保留、双标签页只提交一次、存储异常零发送', { timeout: 120000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const profile = path.join(stack.directory, 'chromium-profile'); await mkdir(profile);
  let context;
  t.after(async () => { await context?.close(); });
  const errors = [], posts = [];
  const open = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE, serviceWorkers: 'block' });
    context.setDefaultTimeout(12000);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(base + '/commands')) posts.push(request.postDataJSON()); });
    return context.pages()[0] ?? await context.newPage();
  };
  let page = await open(); await login(page, stack);
  let sent;
  await page.route('**' + base + '/commands', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON();
    const response = await route.fetch(), value = await response.json();
    // 即使错误回执自己带有一致摘要，也不能替换原输入。
    value.request.operation.value = !sent.operation.value;
    value.request_digest = await documentDigest(value.request);
    await route.fulfill({ response, json: value });
  });
  await power(page).click();
  await expect(page.getByText('操作结果尚未确认，请查询原操作', { exact: true })).toBeVisible();
  const original = (await records(page))['device-lamp'];
  assert.deepEqual(original.input, sent);
  assert.equal(original.space, base); assert.equal(posts.length, 1);
  await until(async () => (await stack.request(base + '/commands')).value.items[0]?.status === 'confirmed');
  await expect(power(page)).toBeDisabled();
  await context.close(); context = undefined;

  page = await open(); await login(page, stack);
  assert.deepEqual((await records(page))['device-lamp'], original);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null);
  await expect(recover(page)).toBeVisible(); await expect(power(page)).toBeDisabled();
  const byKey = '**' + base + '/commands/by-key/*';
  await page.route(byKey, async route => {
    const response = await route.fetch(), value = await response.json();
    value.request.idempotency_key = 'another-operation';
    value.request_digest = await documentDigest(value.request);
    await route.fulfill({ response, json: value });
  });
  await recover(page).click();
  await expect(page.getByText('原操作尚未核实，请保留记录后再次查询', { exact: true })).toBeVisible();
  assert.deepEqual((await records(page))['device-lamp'], original);
  await page.unroute(byKey);
  await page.route(byKey, route => route.fulfill({ status: 404, contentType: 'application/json', json: { error: { code: 'command_not_found' } } }));
  await recover(page).click();
  await expect(page.getByText('尚未查到原操作，请稍后再次查询', { exact: true })).toBeVisible();
  await expect(power(page)).toBeDisabled(); assert.equal(posts.length, 1);
  await page.unroute(byKey); await recover(page).click();
  await expect(recover(page)).toHaveCount(0); await expect(power(page)).toBeEnabled();
  assert.deepEqual(await records(page), {});

  const second = await context.newPage();
  await second.addInitScript(() => addEventListener('storage', event => event.stopImmediatePropagation()));
  await login(second, stack);
  await expect(power(second)).toBeEnabled();
  // 两页同时准备；先发页持有锁直到网络结果返回，后发页只能读取已存原请求。
  let release, requested;
  const held = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { requested = resolve; });
  await context.route('**' + base + '/commands', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requested(); await held; await route.fetch(); await route.abort('failed');
  });
  const click = power(page).click(); await arrived; await click;
  const secondResult = await second.evaluate(() => {
    const button = document.querySelector('[aria-label="环境灯"] [role="switch"][aria-label="电源"]');
    const wasDisabled = button.disabled;
    if (!wasDisabled) button.click();
    return wasDisabled;
  });
  release();
  assert.equal(secondResult, false, 'the second tab attempts control before learning about the first request');
  await expect(recover(page)).toBeVisible(); await expect(recover(second)).toBeVisible();
  await expect(power(second)).toBeDisabled();
  const heldRecord = (await records(second))['device-lamp'];
  assert.equal(posts.length, 2); assert(heldRecord?.input);
  await context.unroute('**' + base + '/commands');
  await until(async () => (await stack.request(base + '/commands')).value.items.every(item => item.status === 'confirmed'));
  await recover(second).click(); await expect(recover(second)).toHaveCount(0);
  // 第一页保留自己观测到的未知，只核实原操作后解除。
  await recover(page).click(); await expect(recover(page)).toHaveCount(0);
  assert.equal(posts.length, 2);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 2);

  await second.close();
  await page.evaluate(key => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) { if (name !== key) set.call(this, name, value); };
  }, storageKey);
  await power(page).click();
  await expect(page.getByText('无法核对本地操作记录，尚未发送请求', { exact: true })).toBeVisible();
  assert.equal(posts.length, 2);
  await page.reload(); await expect(lamp(page)).toBeVisible();
  await page.evaluate(key => localStorage.setItem(key, '{'), storageKey);
  await page.reload();
  await expect(page.getByText('无法核对本地操作记录，请保留记录后检查浏览器存储', { exact: true })).toBeVisible();
  await expect(power(page)).toBeDisabled();
  assert.equal(posts.length, 2); assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
  assert.deepEqual(errors, []);
  await writeFile(path.join(stack.directory, 'command-recovery-web.json'), JSON.stringify({ passed: true, real_gateway: true, real_sqlite: true, real_mqtt: true, persistent_profile_reopened: true, wrong_post_and_get_preserve_original: true, missing_original_no_repost: true, two_tabs_single_post: true, second_disabled_before_attempt: secondResult, storage_failure_zero_posts: true, corrupt_storage_blocks: true, commands: 2, native_app: false, hardware: false }, null, 2));
});

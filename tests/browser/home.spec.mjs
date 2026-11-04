import { test, expect } from '@playwright/test';
import { startStack, until } from '../../tools/dev-stack.mjs';

let stack;
test.beforeAll(async () => { stack = await startStack(); });
test.afterAll(async () => { await stack?.close(); });
async function login(page) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的设备' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '本地已连接' })).toBeVisible();
}
test('家庭任务：真实控制、预演、按钮联动、停用、原记录与退出', async ({ page, context }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  const lamp = page.getByRole('article', { name: '环境灯', exact: true });
  await lamp.getByRole('switch', { name: '电源' }).click();
  await expect(lamp.getByText('最近操作：已确认', { exact: true })).toBeVisible();
  await expect(lamp.getByRole('switch', { name: '电源' })).toHaveAttribute('aria-checked', 'true');
  await lamp.getByLabel('亮度', { exact: true }).fill('42');
  await lamp.getByRole('button', { name: '设置', exact: true }).click();
  await expect.poll(async () => (await stack.request('/api/v1/spaces/space-demo/devices/device-lamp')).value.reported['light.brightness'].value).toBe(42);
  await lamp.getByRole('switch', { name: '电源' }).click();
  await expect(lamp.getByRole('switch', { name: '电源' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: '自动化', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用自动化' })).toBeDisabled();
  await page.getByRole('button', { name: '校验并预演' }).click();
  await expect(page.getByText('预演通过，预计执行 1 个设备操作。设备尚未执行。', { exact: true })).toBeVisible();
  expect((await stack.request('/api/v1/spaces/space-demo/devices/device-lamp')).value.reported['light.power'].value).toBe(false);
  await page.getByLabel('冷却时间（秒）').fill('0');
  await expect(page.getByRole('button', { name: '启用自动化' })).toBeDisabled();
  await page.getByRole('button', { name: '校验并预演' }).click();
  await page.getByRole('button', { name: '启用自动化' }).click();
  await expect(page.getByText('自动化已启用', { exact: true })).toBeVisible();
  stack.button.stdin.write(JSON.stringify({ data: { count: 1 } }) + '\n');
  await until(async () => (await stack.request('/api/v1/spaces/space-demo/runs')).value.items.length === 1);
  await page.getByRole('button', { name: '执行记录', exact: true }).click();
  await expect(page.getByText('1 个关联操作', { exact: true })).toBeVisible();
  await page.getByText('1 个关联操作', { exact: true }).click();
  const run = (await stack.request('/api/v1/spaces/space-demo/runs')).value.items[0];
  await expect(page.locator('.run').getByText(run.run_id, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '自动化', exact: true }).click();
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await expect(page.getByText('自动化已停用', { exact: true })).toBeVisible();
  stack.button.stdin.write(JSON.stringify({ data: { count: 1 } }) + '\n');
  await expect.poll(async () => (await stack.request('/api/v1/spaces/space-demo/rule-deployments')).value.items.length).toBe(0);
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await page.screenshot({ path: '.dev/browser-results/home-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(lamp).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.dev/browser-results/home-mobile.png', fullPage: true });
  expect((await context.cookies()).find(cookie => cookie.name === 'limeiot_session')?.httpOnly).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '连接我的家' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '环境灯' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('离线不控制，静态外壳不缓存家庭 API', async ({ page, context }) => {
  await login(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole('heading', { name: '我的设备' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: '连接中断' })).toBeVisible();
  await expect(page.getByRole('switch', { name: '电源' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
  const cached = await page.evaluate(async () => { const keys = await caches.keys(); return (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))).flat(); });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.some(url => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  await context.setOffline(false);
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByRole('heading', { name: '我的设备' })).toBeVisible();
});

test('受理响应丢失后，刷新页面仍查询原操作且不重复发送', async ({ page }) => {
  await login(page);
  const before = (await stack.request('/api/v1/spaces/space-demo/commands')).value.items.length;
  await page.route('**/api/v1/spaces/space-demo/commands', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch(); await route.abort('failed');
    await page.unroute('**/api/v1/spaces/space-demo/commands');
  });
  const lamp = page.getByRole('article', { name: '环境灯', exact: true });
  await lamp.getByRole('switch', { name: '电源' }).click();
  await expect(lamp.getByRole('button', { name: '查询原操作' })).toBeVisible();
  await page.reload();
  await expect(lamp.getByRole('button', { name: '查询原操作' })).toBeVisible();
  await lamp.getByRole('button', { name: '查询原操作' }).click();
  await expect(lamp.getByRole('button', { name: '查询原操作' })).toHaveCount(0);
  expect((await stack.request('/api/v1/spaces/space-demo/commands')).value.items.length).toBe(before + 1);
});

test('本地存储不可写时不发送设备操作', async ({ page }) => {
  await login(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const before = (await stack.request('/api/v1/spaces/space-demo/commands')).value.items.length;
  let submitted = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/commands')) submitted++; });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'limeiot.pending') throw new DOMException('storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  const lamp = page.getByRole('article', { name: '环境灯', exact: true });
  await lamp.getByRole('switch', { name: '电源' }).click();
  await expect(page.getByText('无法核对本地操作记录，尚未发送请求', { exact: true })).toBeVisible();
  expect(submitted).toBe(0);
  expect((await stack.request('/api/v1/spaces/space-demo/commands')).value.items.length).toBe(before);
  expect(errors).toEqual([]);
});

test('受理后的代理错误保留原操作，重新登录后仍可查询', async ({ page }) => {
  await login(page);
  const before = (await stack.request('/api/v1/spaces/space-demo/commands')).value.items.length;
  await page.route('**/api/v1/spaces/space-demo/commands', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'upstream_unavailable' } }) });
    await page.unroute('**/api/v1/spaces/space-demo/commands');
  });
  const lamp = page.getByRole('article', { name: '环境灯', exact: true });
  await lamp.getByRole('switch', { name: '电源' }).click();
  await expect(lamp.getByRole('button', { name: '查询原操作' })).toBeVisible();
  await expect(lamp.getByRole('switch', { name: '电源' })).toBeDisabled();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '连接我的家' })).toBeVisible();
  await login(page);
  await expect(lamp.getByRole('button', { name: '查询原操作' })).toBeVisible();
  await lamp.getByRole('button', { name: '查询原操作' }).click();
  await expect(lamp.getByRole('button', { name: '查询原操作' })).toHaveCount(0);
  expect((await stack.request('/api/v1/spaces/space-demo/commands')).value.items.length).toBe(before + 1);
});

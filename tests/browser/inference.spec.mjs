import { test, expect } from '@playwright/test';
import { startStack, until } from '../../tools/dev-stack.mjs';
import { ollamaFixture } from '../support/ollama-fixture.mjs';
let stack, provider;
const base = '/api/v1/spaces/space-demo';
test.beforeAll(async () => { provider = await ollamaFixture(); stack = await startStack({ gatewayEnv: { LIMEIOT_OLLAMA_MODEL: 'fixture-local', LIMEIOT_OLLAMA_URL: provider.origin } }); });
test.afterAll(async () => { await stack?.close(); await provider?.close(); });
async function open(page) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的设备' })).toBeVisible();
  await page.getByRole('button', { name: '自动化', exact: true }).click();
  return page.getByRole('region', { name: 'AI 联动草案' });
}
test('AI草案响应丢失后恢复原记录，预演后显式启用才产生联动', async ({ page }) => {
  const panel = await open(page), before = (await stack.request(`${base}/commands`)).value.items.length;
  await page.route('**/api/v1/spaces/space-demo/rule-drafts', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch(); await route.abort('failed'); await page.unroute('**/api/v1/spaces/space-demo/rule-drafts');
  });
  await panel.getByLabel('希望如何联动').fill('按下按钮时把环境灯亮度设为37');
  await panel.getByRole('button', { name: '生成草案', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询生成结果' })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: '自动化', exact: true }).click();
  await expect(panel.getByText('草案已生成', { exact: true })).toBeVisible();
  expect(provider.requests.length).toBe(1);
  expect((await stack.request(`${base}/commands`)).value.items.length).toBe(before);
  await expect(panel.getByRole('button', { name: '启用草案', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '预演草案', exact: true }).click();
  await expect(panel.getByText('预演通过，预计执行 1 个设备操作。设备尚未执行。', { exact: true })).toBeVisible();
  expect((await stack.request(`${base}/commands`)).value.items.length).toBe(before);
  await panel.getByLabel('希望如何联动').fill('把亮度设为38');
  await expect(panel.getByRole('button', { name: '启用草案', exact: true })).toHaveCount(0);
  await panel.getByLabel('希望如何联动').fill('按下按钮时把环境灯亮度设为37');
  await expect(panel.getByRole('button', { name: '启用草案', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '预演草案', exact: true }).click();
  await panel.getByRole('button', { name: '启用草案', exact: true }).click();
  await expect(panel.getByText('自动化已启用', { exact: true })).toBeVisible();
  stack.button.stdin.write(JSON.stringify({ data: { count: 1 } }) + '\n');
  await until(async () => (await stack.request(`${base}/commands`)).value.items.some(item => item.status === 'confirmed' && item.request.operation.value === 37));
  await page.screenshot({ path: '.dev/browser-results/ai-automation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.dev/browser-results/ai-automation-mobile.png', fullPage: true });
});
test('本地生成记录写入失败时，不发送模型请求', async ({ page }) => {
  const panel = await open(page), before = provider.requests.length;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('limeiot.rule-draft:')) throw new DOMException('storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await panel.getByLabel('希望如何联动').fill('按下按钮时打开环境灯');
  await panel.getByRole('button', { name: '生成草案', exact: true }).click();
  await expect(panel.getByText('无法保存本地生成记录，请检查浏览器存储设置', { exact: true })).toBeVisible();
  expect(provider.requests.length).toBe(before);
});

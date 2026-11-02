import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { startStack } from '../../tools/dev-stack.mjs';

let stack;
test.beforeAll(async () => { stack = await startStack(); });
test.afterAll(async () => { await stack?.close(); });

test('NAS 全部任务共用主题、导航和布局，支持历史、手机抽屉及刷新', async ({ page }) => {
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的设备' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '本地已连接' })).toBeVisible();
  const shell = await page.locator('.shell').elementHandle();
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('外观', { exact: true }).selectOption(theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [view, label] of [['devices', '设备'], ['automation', '自动化'], ['activity', '执行记录'], ['connections', '网关配对'], ['models', '设备接入'], ['firmware', '固件升级']]) {
        if (width === 390) await page.getByRole('button', { name: '家庭导航', exact: true }).click();
        await page.locator('nav').getByRole('button', { name: label, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`view=${view}`));
        await expect(page.locator('aside')).not.toHaveClass(/open/);
        expect(await shell.evaluate(node => node.isConnected)).toBe(true);
        if (width === 390) await expect.poll(async () => { const rect = await page.locator('aside').boundingBox(); return rect.x + rect.width <= 0; }).toBe(true);
        await page.evaluate(() => document.fonts.ready);
        const facts = await page.evaluate(() => {
          const sizes = new Set();
          for (const el of document.querySelectorAll('body *')) {
            if (['SCRIPT', 'STYLE', 'OPTION', 'SVG', 'PATH'].includes(el.tagName)) continue;
            const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
            if (!rect.width || !rect.height || style.visibility === 'hidden') continue;
            if ([...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) sizes.add(parseFloat(style.fontSize));
          }
          return { overflow: document.documentElement.scrollWidth > innerWidth, sizes: [...sizes], dot: document.body.innerText.includes('·'), theme: document.documentElement.dataset.theme };
        });
        expect(facts.overflow).toBe(false);
        expect(facts.dot).toBe(false);
        expect(facts.theme).toBe(theme);
        expect(facts.sizes.every(size => size >= 12) && facts.sizes.length <= 3).toBe(true);
        await mkdir('.dev/platform-ui/screenshots', { recursive: true });
        await page.screenshot({ path: `.dev/platform-ui/screenshots/nas-${view}-${theme}-${width}.png` });
        results.push({ view, width, theme, ...facts });
      }
    }
  }
  await page.goBack();
  await expect(page.locator('nav button[aria-current]')).toHaveText('设备接入');
  await page.goForward();
  await expect(page.locator('nav button[aria-current]')).toHaveText('固件升级');
  await page.reload();
  await expect(page.getByRole('heading', { name: '固件升级', exact: true })).toBeVisible();
  await expect(page.getByLabel('外观', { exact: true })).toHaveValue('dark');
  expect(errors).toEqual([]);
  await writeFile('.dev/platform-ui/browser-report.json', JSON.stringify({ passed: true, hardware: false, identity: 'local-test-instance', results }, null, 2));
});

import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root } from '../../tools/dev-stack.mjs';
import { cloudClient, fixture, origin } from './control.mjs';

// 同一业务旅程验证两个独立构建的消费者；仅由显式隔离测试调用。
export async function publicationBrowser({ official = false, evidenceRoot = path.join(root, '.dev'), labels = {} } = {}) {
  const tag = randomBytes(8).toString('hex'), cloud = await cloudClient(), publisher = await cloud.call('/api/console/v1/publisher');
  const model = JSON.parse(await readFile(path.join(root, 'contracts/models/lamp.json'), 'utf8'));
  model.model_id = `urn:${publisher.namespace}:model:browser-${tag}:1`;
  const created = await cloud.call('/api/console/v1/products', { request_key: tag, name: '发布环境灯', model });
  const product = created.product, base = '/api/console/v1/products/' + product.product_id;
  assert.deepEqual(await cloud.call(base + '/releases/head'), { release: null });
  const evidence = path.join(evidenceRoot, 'publication-' + tag); await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, ignoreHTTPSErrors: official });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let submissions = 0;
    page.on('request', request => { if (request.method() === 'POST' && /\/products\/[^/]+\/releases$/.test(new URL(request.url()).pathname)) submissions++; });
    const url = id => origin + (official ? '/zh-cn/console/' : '/console/') + '?view=products&product=' + id;
    await page.goto(url(product.product_id));
    await page.getByLabel('实例凭据', { exact: true }).fill((await readFile(process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE, 'utf8')).trim());
    await page.getByRole('button', { name: '登录私有实例', exact: true }).click();
    const section = page.getByRole('region', { name: '发布版本', exact: true });
    const publish = section.getByRole('button', { name: labels.publish ?? '公开发布当前草稿', exact: true });
    await expect(publish).toBeEnabled();
    const before = (await fixture()).release_posts;
    await page.evaluate(official => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('limeiot.official:v1:')) throw new DOMException('fixture', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    }, official);
    await publish.click(); await section.getByRole('alert').waitFor();
    assert.equal((await fixture()).release_posts, before); assert.equal(submissions, 0);
    await page.reload(); await expect(publish).toBeEnabled();
    await page.getByLabel('产品名称', { exact: true }).fill('尚未保存'); await expect(publish).toBeDisabled();
    await page.getByLabel('产品名称', { exact: true }).fill(product.name); await expect(publish).toBeEnabled();
    await fixture({ drop_release_responses: true }); await publish.click();
    await section.getByRole('alert').waitFor(); await section.getByRole('button', { name: '查询原发布操作', exact: true }).waitFor();
    assert.equal(submissions, 1); const lost = (await fixture()).release_posts; assert.ok(lost > before);
    await fixture({ restart_api: true }); await page.reload();
    await section.getByRole('button', { name: '查询原发布操作', exact: true }).click();
    try {
      await section.getByRole('cell', { name: '已发布', exact: true }).waitFor();
    } catch (error) {
      console.error('发布恢复界面状态', JSON.stringify({ alerts: await section.getByRole('alert').allTextContents(), statuses: await section.getByRole('status').allTextContents(), browserErrors: errors }));
      await page.screenshot({ path: path.join(evidence, 'recovery-failed.png'), fullPage: true, animations: 'disabled' });
      throw error;
    }
    assert.equal((await fixture()).release_posts, lost); assert.equal(submissions, 1);
    const head = (await cloud.call(base + '/releases/head')).release; assert.ok(head);
    await section.getByRole('button', { name: '读取最新发布', exact: true }).click(); await expect(publish).toBeEnabled();
    for (const [label, value] of [[labels.downloadArtifact ?? '下载签名文件', head.artifact], [labels.downloadTrust ?? '下载验证材料', head.trust]]) {
      const downloaded = page.waitForEvent('download');
      await section.getByRole('button', { name: label, exact: true }).first().click();
      const download = await downloaded; assert.deepEqual(JSON.parse(await readFile(await download.path(), 'utf8')), value);
    }
    // 定义不兼容为终态拒绝，既有发布不改变。
    model.model_version = '0.1.0';
    await page.getByLabel('物模型 JSON', { exact: true }).fill(JSON.stringify(model));
    await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await expect(publish).toBeEnabled();
    await publish.click(); await section.getByRole('cell', { name: '发布被拒绝', exact: true }).waitFor();
    assert.deepEqual((await cloud.call(base + '/releases/head')).release, head);
    // 另一个明确发布使旧基线冲突；浏览器不能自动采用新基线再发。
    model.model_version = '1.0.1';
    await page.getByLabel('物模型 JSON', { exact: true }).fill(JSON.stringify(model));
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await section.getByRole('button', { name: '读取最新发布', exact: true }).click(); await expect(publish).toBeEnabled();
    const saved = await cloud.call(base);
    const newer = await cloud.call(base + '/releases', { request_key: tag + '-other', expected_revision: saved.revision, expected_release_id: head.artifact.statement.release_id, visibility: 'public' });
    assert.equal(newer.status, 'published');
    await publish.click(); await section.getByRole('cell', { name: '修订冲突', exact: true }).waitFor(); await expect(publish).toBeDisabled();
    const conflictPosts = (await fixture()).release_posts; assert.equal(submissions, 3);
    await page.reload(); await expect(publish).toBeEnabled(); assert.equal((await fixture()).release_posts, conflictPosts);
    await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true, animations: 'disabled' });
    // 未抵达服务端的旧键，即使查询404也不能补发。
    model.model_id = `urn:${publisher.namespace}:model:unsent-${tag}:1`;
    const unsent = await cloud.call('/api/console/v1/products', { request_key: tag + '-unsent', name: '未送达发布', model });
    await page.goto(url(unsent.product_id)); await expect(publish).toBeEnabled();
    await page.route('**/api/console/v1/products/*/releases', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await publish.click(); await section.getByRole('alert').waitFor(); await page.unrouteAll(); await page.reload();
    await section.getByRole('button', { name: '查询原发布操作', exact: true }).click();
    await section.getByText('尚未查到原发布操作，未重新发送', { exact: false }).waitFor();
    await expect(publish).toBeDisabled(); assert.equal((await fixture()).release_posts, conflictPosts);
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, official, real_mysql: true, process_restart: true, storage_failure_zero_post: true, unknown_get_only: true, baseline_conflict: true, incompatible_rejected: true, downloads: true, no_resend_after_404: true, hardware: false }));
  } finally { await fixture({}); await browser.close(); }
}

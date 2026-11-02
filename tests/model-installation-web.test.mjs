import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, startStack, stop, until } from '../tools/dev-stack.mjs';

const base = '/api/v1/spaces/space-demo';
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/model-release.json'), 'utf8'));
async function enter(page, stack) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await expect(page.getByRole('heading', { name: /^(我的设备|连接我的家)$/ })).toBeVisible();
  if (await page.getByLabel('所有者凭据', { exact: true }).isVisible()) {
    await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  }
  await page.getByRole('heading', { name: '我的设备', exact: true }).waitFor();
  await page.getByRole('button', { name: '设备接入', exact: true }).click();
  await page.getByRole('heading', { name: '设备接入', exact: true }).waitFor();
}

test('NAS模型接入界面：存储失败零发送，丢响应恢复、明确安装绑定、升级不自动切换与独立撤销', { timeout: 90000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(base + '/model-operations')) posts++; });
  const trusts = page.getByRole('region', { name: '发布者信任', exact: true }), installs = page.getByRole('region', { name: '安装模型', exact: true });
  const bindings = page.getByRole('region', { name: '绑定设备模型', exact: true });
  await enter(page, stack);
  await trusts.getByLabel('发布者信任材料', { exact: true }).fill(JSON.stringify(vector.trust));
  assert.equal(await trusts.getByLabel('独立核对的公钥指纹').inputValue(), '');
  await trusts.getByLabel('独立核对的公钥指纹').fill(vector.trust.signing_key_id);
  await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.startsWith('limeiot.model-operation:')) throw new DOMException('denied', 'QuotaExceededError'); return set.call(this, key, value); }; });
  await trusts.getByRole('button', { name: '信任发布者', exact: true }).click();
  await expect(page.getByText('无法保存或读取本机操作记录，请检查浏览器存储设置', { exact: true })).toBeVisible();
  assert.equal(posts, 0); assert.equal((await stack.request(base + '/model-trusts')).value.items.length, 0);
  await page.reload(); await page.getByRole('button', { name: '设备接入', exact: true }).click();
  await trusts.getByLabel('发布者信任材料', { exact: true }).fill(JSON.stringify(vector.trust));
  await trusts.getByLabel('独立核对的公钥指纹').fill(vector.trust.signing_key_id);
  await page.route('**' + base + '/model-operations', async route => { await route.fetch(); await route.abort('failed'); await page.unroute('**' + base + '/model-operations'); });
  await trusts.getByRole('button', { name: '信任发布者', exact: true }).click();
  await expect(page.getByText('结果未知，请查询原操作', { exact: true })).toBeVisible(); assert.equal(posts, 1);
  await stack.restartGateway(); await enter(page, stack);
  await expect(page.getByRole('region', { name: '模型原操作', exact: true }).getByText('已完成', { exact: true })).toBeVisible();
  assert.equal(posts, 1);
  const trust = (await stack.request(base + '/model-trusts')).value.items[0];
  await installs.getByLabel('信任的发布者', { exact: true }).selectOption(trust.trust_id);
  await installs.getByLabel('签名模型制品', { exact: true }).fill(JSON.stringify({ artifact: vector.artifact, trust: vector.trust }));
  await installs.getByRole('button', { name: '读取安装基线', exact: true }).click();
  await expect(installs.getByText('尚未安装', { exact: true })).toBeVisible();
  await installs.getByLabel('签名模型制品', { exact: true }).fill(JSON.stringify(vector.artifact));
  await expect(installs.getByRole('button', { name: '确认安装', exact: true })).toHaveCount(0);
  await installs.getByRole('button', { name: '读取安装基线', exact: true }).click();
  await installs.getByRole('button', { name: '确认安装', exact: true }).click();
  await expect.poll(async () => Object.keys((await stack.request(base + '/model-installations')).value.heads).length).toBe(1);
  const first = (await stack.request(base + '/model-installations')).value.items[0];
  assert.notEqual((await stack.request(base + '/devices/device-lamp')).value.model_revision, first.artifact.statement.model_revision);
  await bindings.getByLabel('设备编号', { exact: true }).fill('device-lamp');
  await bindings.getByLabel('已安装模型', { exact: true }).selectOption(first.installation_id);
  await bindings.getByRole('button', { name: '读取设备当前绑定', exact: true }).click();
  await bindings.getByRole('button', { name: '确认绑定', exact: true }).click();
  await expect.poll(async () => (await stack.request(base + '/devices/device-lamp/model-binding')).value.binding?.installation_id).toBe(first.installation_id);
  await stop(stack.lamp);
  const file = path.join(stack.directory, 'ui-signed-model.json'); await writeFile(file, JSON.stringify(vector.artifact.statement.model));
  stack.lamp = stack.launch('ui-signed-lamp', path.join(root, 'target/debug/limeiot-simulator'), ['device-lamp', file, path.join(stack.directory, 'ui-signed-state.json')]);
  await until(async () => (await stack.request(base + '/devices/device-lamp')).value.ready);
  await installs.getByLabel('签名模型制品', { exact: true }).fill(JSON.stringify(vector.upgrade));
  await installs.getByRole('button', { name: '读取安装基线', exact: true }).click();
  await expect(installs.getByText('1.0.0', { exact: true })).toBeVisible();
  await installs.getByRole('button', { name: '确认安装', exact: true }).click();
  await expect.poll(async () => (await stack.request(base + '/model-installations')).value.items.length).toBe(2);
  assert.equal((await stack.request(base + '/devices/device-lamp')).value.model_revision, first.artifact.statement.model_revision);
  // 未知安装原请求不妨碍所有者撤销信任；另一个标签页接收记录变更。
  const second = await context.newPage();
  await second.goto(stack.env.LIMEIOT_ENDPOINT);
  await second.evaluate(({ base, artifact, trustID }) => {
    localStorage.setItem('limeiot.model-operation:' + base + ':unknown-install', JSON.stringify({ version: 1, origin: location.origin, request: { space_id: 'space-demo', idempotency_key: 'unknown-install', change: { type: 'models.install', trust_id: trustID, artifact, expected_release_id: null } } }));
  }, { base, artifact: vector.artifact, trustID: trust.trust_id });
  await expect(page.locator('[data-model-key="unknown-install"]')).toBeVisible();
  await trusts.getByRole('button', { name: '撤销信任', exact: true }).click();
  await page.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect.poll(async () => (await stack.request(base + '/model-trusts/' + trust.trust_id)).value.active).toBe(false);
  assert.equal((await stack.request(base + '/devices/device-lamp')).value.ready, false);
  assert.equal(posts, 5);
  await expect(trusts.getByText('已撤销', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(stack.directory, 'model-registry-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(stack.directory, 'model-registry-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(path.join(stack.directory, 'model-installation-web-result.json'), JSON.stringify({ passed: true, real_gateway: true, real_mqtt: true, public_test_vector: true, storage_failure_zero_posts: true, original_request_recovery: true, explicit_install_bind: true, independent_revocation: true, posts, hardware: false }));
});

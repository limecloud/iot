import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, startStack, stop, until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const base = '/api/v1/spaces/space-demo';
const vector = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
async function enter(page, stack) {
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await expect(page.getByRole('heading', { name: /^(我的设备|连接我的家)$/ })).toBeVisible();
  if (await page.getByLabel('所有者凭据', { exact: true }).isVisible()) {
    await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  }
  await page.getByRole('heading', { name: '我的设备', exact: true }).waitFor();
  await page.locator('nav').getByRole('button', { name: '固件升级', exact: true }).click();
  await page.getByRole('heading', { name: '固件升级', exact: true }).waitFor();
}

test('NAS固件升级：先保存原操作，明确计划/批准/执行，丢响应与重启只查询原安装', { timeout: 120000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  await stop(stack.lamp);
  const device = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'device-lamp', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => device.close());
  const topic = 'limeiot/v1/space-demo/device-lamp'; await device.subscribe(topic + '/down/+');
  let seq = 0, boot, session;
  async function publish(kind, body) {
    await device.publish(topic + '/up/' + kind, JSON.stringify({ v: 1, kind, message_id: randomUUID(), device_id: 'device-lamp', model_revision: vector.request.device.model_revision, boot_id: boot, session_id: session, seq: ++seq, body }));
  }
  async function handshake() {
    seq = 0; boot = randomUUID(); session = null;
    await publish('hello', { challenge: 'ota-web-challenge' });
    const welcome = JSON.parse((await device.message()).payload); assert.equal(welcome.kind, 'welcome'); session = welcome.session_id;
    await publish('state', { type: 'snapshot', revision: 1, properties: [
      { path: 'light.power', value: false, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-web-fixture' },
      { path: 'light.brightness', value: 0, observed_at: new Date().toISOString(), quality: 'confirmed', source: 'ota-web-fixture' },
    ] });
    await publish('device_info', vector.request.device);
    await until(async () => (await stack.request(base + '/devices/device-lamp')).value.device_info?.fresh);
  }
  await handshake();
  const reports = setInterval(() => { if (session) void publish('device_info', vector.request.device).catch(() => {}); }, 700); t.after(() => clearInterval(reports));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let posts = 0; page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(base + '/ota-operations')) posts++; });
  const trusts = page.getByRole('region', { name: '固件信任', exact: true }), plans = page.getByRole('region', { name: '创建升级计划', exact: true });
  const review = page.getByRole('region', { name: '核对升级任务', exact: true });
  await enter(page, stack);
  await trusts.getByLabel('固件信任材料', { exact: true }).fill(JSON.stringify(vector.request.trust));
  assert.equal(await trusts.getByLabel('独立核对的固件公钥指纹', { exact: true }).inputValue(), '');
  await trusts.getByLabel('独立核对的固件公钥指纹', { exact: true }).fill(vector.request.trust.signing_key_id);
  await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.startsWith('limeiot.ota-operation:')) throw new DOMException('denied', 'QuotaExceededError'); return set.call(this, key, value); }; });
  await trusts.getByRole('button', { name: '信任固件签名者', exact: true }).click();
  await expect(page.getByText('无法保存或读取本机升级记录，请检查浏览器存储设置', { exact: true })).toBeVisible();
  assert.equal(posts, 0); assert.equal((await stack.request(base + '/firmware-trusts')).value.items.length, 0);
  await enter(page, stack);
  await trusts.getByLabel('固件信任材料', { exact: true }).fill(JSON.stringify(vector.request.trust));
  await trusts.getByLabel('独立核对的固件公钥指纹', { exact: true }).fill(vector.request.trust.signing_key_id);
  await page.route('**' + base + '/ota-operations', async route => { await route.fetch(); await route.abort('failed'); await page.unroute('**' + base + '/ota-operations'); });
  await trusts.getByRole('button', { name: '信任固件签名者', exact: true }).click();
  await expect(page.getByText('结果未知，请查询升级原操作', { exact: true })).toBeVisible(); assert.equal(posts, 1);
  await enter(page, stack);
  await expect(page.getByRole('region', { name: '升级原操作', exact: true }).getByText('决定已保存', { exact: true })).toBeVisible(); assert.equal(posts, 1);
  const trust = (await stack.request(base + '/firmware-trusts')).value.items[0];
  await plans.getByLabel('升级设备', { exact: true }).selectOption('device-lamp');
  await plans.getByLabel('固件签名者', { exact: true }).selectOption(trust.trust_id);
  await plans.getByLabel('签名固件清单', { exact: true }).fill(JSON.stringify(vector.request.manifest));
  await plans.getByRole('button', { name: '创建升级计划', exact: true }).click();
  await expect.poll(async () => (await stack.request(base + '/ota-tasks')).value.items.length).toBe(1);
  const cancelledID = (await stack.request(base + '/ota-tasks')).value.items[0].task_id;
  const cancelled = page.locator(`[data-ota-task="${cancelledID}"]`);
  await cancelled.getByRole('button', { name: '读取当前任务', exact: true }).click();
  await review.getByRole('button', { name: '取消计划', exact: true }).click();
  await expect(cancelled.getByRole('status')).toHaveText('已取消');
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  await plans.getByRole('button', { name: '创建升级计划', exact: true }).click();
  await expect.poll(async () => (await stack.request(base + '/ota-tasks')).value.items.length).toBe(2);
  const taskID = (await stack.request(base + '/ota-tasks')).value.items.find(task => task.status === 'planned').task_id;
  const row = page.locator(`[data-ota-task="${taskID}"]`);
  await expect(row.getByRole('status')).toHaveText('待批准');
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  await row.getByRole('button', { name: '读取当前任务', exact: true }).click();
  await review.getByRole('button', { name: '批准升级', exact: true }).click();
  await expect(row.getByRole('status')).toHaveText('已批准，尚未安装'); assert.equal(posts, 5);
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  await row.getByRole('button', { name: '读取当前任务', exact: true }).click();
  await page.route('**' + base + '/ota-operations', async route => { await route.fetch(); await route.abort('failed'); await page.unroute('**' + base + '/ota-operations'); });
  await review.getByRole('button', { name: '开始安装', exact: true }).click();
  const install = await device.message(); assert.equal(install.topic, topic + '/down/ota_install');
  const envelope = JSON.parse(install.payload), digest = await documentDigest(envelope);
  await expect(page.getByText('结果未知，请查询升级原操作', { exact: true })).toBeVisible(); assert.equal(posts, 6);
  session = null; await stack.restartGateway(); await handshake(); await enter(page, stack);
  await expect(row.getByRole('status')).toHaveText('结果未知'); assert.equal(posts, 6);
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  await row.getByRole('button', { name: '读取当前任务', exact: true }).click();
  await expect(review.getByRole('button', { name: '开始安装', exact: true })).toHaveCount(0);
  await review.getByRole('button', { name: '查询设备结果', exact: true }).click();
  const query = JSON.parse((await device.message()).payload); assert.equal(query.kind, 'ota_query'); assert.equal(query.body.request_digest, digest); assert.equal(query.body.manifest, undefined);
  await publish('ota_result', { task_id: taskID, execution_id: envelope.body.execution_id, request_digest: digest, manifest_digest: envelope.body.manifest_digest, status: 'succeeded', firmware_version: vector.request.manifest.statement.version, security_epoch: vector.request.manifest.statement.security_epoch, image_sha256: vector.request.manifest.statement.sha256, pending_update: false, error: null });
  await expect(row.getByRole('status')).toHaveText('升级成功'); assert.equal(posts, 7);
  await assert.rejects(device.message(150), /mqtt_packet_timeout/);
  const second = await context.newPage(); await second.goto(stack.env.LIMEIOT_ENDPOINT);
  await second.evaluate(({ base, trustID, manifest }) => { localStorage.setItem('limeiot.ota-operation:' + base + ':unknown-plan', JSON.stringify({ version: 1, origin: location.origin, request: { space_id: 'space-demo', idempotency_key: 'unknown-plan', change: { type: 'tasks.plan', device_id: 'device-lamp', trust_id: trustID, manifest, expires_at: new Date(Date.now() + 600000).toISOString() } } })); }, { base, trustID: trust.trust_id, manifest: vector.request.manifest });
  await expect(page.locator('[data-ota-key="unknown-plan"]')).toBeVisible();
  await plans.getByLabel('升级设备', { exact: true }).selectOption('device-lamp'); await plans.getByLabel('固件签名者', { exact: true }).selectOption(trust.trust_id);
  await plans.getByLabel('签名固件清单', { exact: true }).fill(JSON.stringify(vector.request.manifest));
  await plans.getByRole('button', { name: '创建升级计划', exact: true }).click();
  await expect(page.getByText('请先查询同一设备或任务的原操作', { exact: true })).toBeVisible(); assert.equal(posts, 7);
  await trusts.getByRole('button', { name: '撤销固件信任', exact: true }).click();
  await page.getByRole('button', { name: '确认撤销固件信任', exact: true }).click();
  await expect(trusts.getByText('已撤销', { exact: true })).toBeVisible(); assert.equal(posts, 8);
  await page.screenshot({ path: path.join(stack.directory, 'ota-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('外观', { exact: true }).selectOption('dark'); await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await expect.poll(() => page.locator('aside').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
  await page.screenshot({ path: path.join(stack.directory, 'ota-mobile-dark.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  await writeFile(path.join(stack.directory, 'ota-web-result.json'), JSON.stringify({ passed: true, real_browser: true, real_gateway_mqtt_sqlite: true, storage_failure_zero_posts: true, independent_fingerprint: true, distinct_plan_approve_execute: true, explicit_cancel_without_install: true, original_response_loss_restart_recovery: true, install_messages: 1, query_messages: 1, unknown_same_device_blocks_new_plan: true, revocation_remains_available: true, posts, hardware: false, device_installation: false }));
});

test('NAS固件升级：错绑响应保持未知、原键只读恢复、损坏本机记录禁止新写入', { timeout: 60000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let posts = 0; page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(base + '/ota-operations')) posts++; });
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.evaluate(base => { localStorage.setItem('limeiot.model-operation:' + base + ':unrelated', 'invalid model record'); }, base);
  await enter(page, stack);
  const trusts = page.getByRole('region', { name: '固件信任', exact: true });
  await trusts.getByLabel('固件信任材料', { exact: true }).fill(JSON.stringify(vector.request.trust));
  await trusts.getByLabel('独立核对的固件公钥指纹', { exact: true }).fill(vector.request.trust.signing_key_id);
  await page.route('**' + base + '/ota-operations', async route => {
    const response = await route.fetch(), value = await response.json();
    value.request.idempotency_key = 'different-original';
    await route.fulfill({ response, json: value }); await page.unroute('**' + base + '/ota-operations');
  });
  await trusts.getByRole('button', { name: '信任固件签名者', exact: true }).click();
  await expect(page.getByText('结果未知，请查询升级原操作', { exact: true })).toBeVisible(); assert.equal(posts, 1);
  await page.getByRole('button', { name: '查询升级原操作', exact: true }).click();
  await expect(page.getByRole('region', { name: '升级原操作', exact: true }).getByText('决定已保存', { exact: true })).toBeVisible(); assert.equal(posts, 1);
  const trusted = (await stack.request(base + '/firmware-trusts')).value.items[0];
  const malformed = structuredClone(trusted); malformed.trust.product_ids = { invalid: true };
  malformed.trust_id = 'fwtrust-' + (await documentDigest(malformed.trust)).slice(7);
  await page.route('**' + base + '/firmware-trusts', route => route.fulfill({ json: { items: [malformed], next_cursor: null } }));
  await trusts.getByRole('button', { name: '读取升级状态', exact: true }).click();
  await expect(page.getByText('响应未通过校验，请查询原操作', { exact: true })).toBeVisible();
  await expect(trusts.getByRole('button', { name: '信任固件签名者', exact: true })).toBeDisabled();
  await page.unroute('**' + base + '/firmware-trusts');
  const key = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('limeiot.ota-operation:')));
  await page.evaluate(key => localStorage.setItem(key, 'damaged-original'), key);
  await enter(page, stack);
  await expect(page.getByText('无法保存或读取本机升级记录，请检查浏览器存储设置', { exact: true })).toBeVisible();
  await trusts.getByLabel('固件信任材料', { exact: true }).fill(JSON.stringify(vector.request.trust));
  await trusts.getByLabel('独立核对的固件公钥指纹', { exact: true }).fill(vector.request.trust.signing_key_id);
  await expect(trusts.getByRole('button', { name: '信任固件签名者', exact: true })).toBeDisabled();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'damaged-original'); assert.equal(posts, 1);
  assert.deepEqual(errors, []);
  await writeFile(path.join(stack.directory, 'ota-web-boundaries-result.json'), JSON.stringify({ passed: true, mismatched_operation_response_rejected: true, resolve_is_read_only: true, malformed_trust_no_crash_and_writes_disabled: true, damaged_original_preserved_and_writes_disabled: true, model_ota_journals_isolated: true, posts, hardware: false }));
});

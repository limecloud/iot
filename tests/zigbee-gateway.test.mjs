import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { until } from '../tools/dev-stack.mjs';
import { base, post, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

test('ZNP属性经真实串口、网关和SQLite触发MQTT灯，恢复不重放且错误型号离线', { timeout: 180000 }, async t => {
  let browser;
  // 先关闭浏览器的SSE连接，允许网关完成优雅退出和串口恢复。
  t.after(async () => browser?.close());
  const { directory, stack, sensor, commands, control } = await environmentStack(t);
  const initial = await sensor();
  assert.equal(initial.ready, true); assert.equal(initial.session_id, null); assert.equal(initial.boot_id, null);
  assert.equal(initial.native_execution, undefined); assert.equal(initial.observation_source.ready, true);
  assert.equal(initial.reported['environment.temperature'].value, 2700);
  assert.equal(initial.reported['environment.humidity'].value, 4567);
  assert.equal(initial.reported['environment.temperature'].quality, 'confirmed');
  assert.match(initial.reported['environment.temperature'].source, /^adapter:znp-environment:sha256:[a-f0-9]{64}$/);
  const rule = thresholdRule();
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  await until(async () => (await sensor()).state_revision > initial.state_revision);
  assert.equal((await commands()).length, 0);
  await control(2900);
  const first = await until(async () => { const list = await commands(); return list.length === 1 && list[0].status === 'confirmed' && list[0]; });
  assert.equal(first.request.device_id, 'device-lamp'); assert.equal(first.request.operation.value, 30);
  const runs = (await stack.request(base + '/runs')).value.items;
  assert.equal(runs.length, 1); assert.equal(runs[0].condition_evaluation.matched, true);
  assert.equal(runs[0].property_trigger.previous.value, 2700); assert.equal(runs[0].property_trigger.current.value, 2900);
  assert.match(runs[0].property_trigger.current.source, /^adapter:/);
  assert.equal(JSON.parse(await readFile(path.join(stack.directory, 'lamp.json'), 'utf8')).reported['light.brightness'], 30);
  await stack.restartGateway();
  await until(async () => (await sensor()).ready && (await stack.request(base + '/devices/device-lamp')).value.ready);
  assert.equal((await commands()).length, 1); assert.equal((await commands())[0].command_id, first.command_id);
  await control(2900, 'wrong_signature');
  await until(async () => !(await sensor()).ready);
  assert.equal((await sensor()).reported['environment.temperature'].quality, 'stale');
  assert.equal((await commands()).length, 1);
  await control(2900);
  await until(async () => (await sensor()).ready);
  assert.equal((await commands()).length, 1, '新来源会话的高温首样本不补发旧边沿');
  await control(2900, 'timeout');
  await until(async () => !(await sensor()).ready);
  await control(2700);
  await until(async () => (await sensor()).ready && (await sensor()).reported['environment.temperature'].value === 2700);
  await control(2900);
  await until(async () => { const list = await commands(); return list.length === 2 && list.every(command => command.status === 'confirmed'); });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const card = page.getByRole('article', { name: '环境传感器', exact: true });
  await expect(card.getByText('29.00 ℃', { exact: true })).toBeVisible();
  await expect(card.getByText('45.67 %RH', { exact: true })).toBeVisible();
  await card.getByText('设备详情', { exact: true }).click();
  await expect(card.getByText('zigbee-environment', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, 'zigbee-mobile.png'), fullPage: true });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, real_gateway_sqlite_mqtt: true, real_serial_component_with_software_ncp: true,
    external_source_without_native_identity: true, threshold_and_condition: true, gateway_restart_no_replay: true,
    signature_failure_offline: true, timeout_recovery: true, responsive_browser: true, hardware: false, published: false, full_goal_completed: false,
    commands: (await commands()).map(command => ({ command_id: command.command_id, status: command.status })) }, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'report.json') }));
});

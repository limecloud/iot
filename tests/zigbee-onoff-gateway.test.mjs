import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { until } from '../tools/dev-stack.mjs';
import { base, environmentStack, post, thresholdRule } from './fixtures/zigbee/runtime.mjs';

test('Zigbee开关经同一串口完成网页、阈值、读回及重启闭环，未知不重发', { timeout: 180000 }, async t => {
  let browser;
  t.after(async () => browser?.close());
  const fixture = await environmentStack(t, 1, { onOff: true, timeoutMs: 800 });
  const { directory, stack, sensor, switchDevice, switchControl, commands, stats } = fixture;
  const initial = await switchDevice();
  assert.equal(initial.ready, true); assert.equal(initial.reported['light.power'].value, false);
  assert.equal(initial.boot_id, null); assert.equal(initial.session_id, null);
  assert.equal(initial.routes['light.power'].adapter_id, 'znp-switch');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const card = page.locator('article.device').filter({ has: page.getByText('zigbee-switch', { exact: true }) });
  const toggle = card.getByRole('switch', { name: '电源', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await until(async () => { const list = await commands(); return list.length === 1 && list[0].status === 'confirmed'; });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  let lost;
  await page.route('**/commands', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    lost = { key: route.request().headers()['idempotency-key'], command: await response.json() };
    await route.abort('failed');
  }, { times: 1 });
  await expect(toggle).toBeEnabled(); await toggle.click();
  await expect(card.getByRole('button', { name: '查询原操作', exact: true })).toBeVisible();
  await until(async () => { const list = await commands(); return list.length === 2 && list.every(command => command.status === 'confirmed'); });
  await card.getByRole('button', { name: '查询原操作', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  assert.deepEqual((await stats()).switch_commands, [true, false]);
  assert.equal((await stack.request(base + '/commands/by-key/' + lost.key)).value.command_id, lost.command.command_id);

  const rule = thresholdRule(); rule.actions = [{ device: 'zigbee-switch', set: { path: 'light.power', value: true } }];
  const before = (await sensor()).state_revision;
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  await until(async () => (await sensor()).state_revision > before);
  await fixture.control(2900);
  const automatic = await until(async () => (await commands()).find(command => command.run_id && command.status === 'confirmed'));
  assert.equal(automatic.request.device_id, 'zigbee-switch');
  assert.equal(automatic.evidence.type, 'property_observation_result');
  assert.equal((await switchDevice()).reported['light.power'].value, true);

  const send = async (key, duration = 1800) => {
    const device = await switchDevice();
    const request = { device_id: device.device_id, model_revision: device.model_revision,
      expires_at: new Date(Date.now() + duration).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } };
    const response = await stack.request(base + '/commands', { ...post(request), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } });
    assert.equal(response.status, 202); return { request, command: response.value };
  };
  await switchControl('hold', false);
  await until(async () => (await switchDevice()).reported['light.power'].value === false);
  const held = await send('onoff-hold');
  const accepted = await until(async () => {
    const command = (await stack.request(base + '/commands/' + held.command.command_id)).value;
    return command.evidence?.type === 'property_adapter_result' && command;
  });
  assert.equal(accepted.status, 'dispatched');
  assert.equal((await switchDevice()).reported['light.power'].value, false);
  await until(async () => (await stack.request(base + '/commands/' + held.command.command_id)).value.status === 'unknown');
  assert.deepEqual((await stats()).switch_commands, [true, false, true, true]);

  await switchControl('drop_ack', false);
  const dropped = await send('onoff-drop', 4000);
  await until(async () => (await stack.request(base + '/commands/' + dropped.command.command_id)).value.status === 'unknown');
  await switchControl('normal');
  await until(async () => (await switchDevice()).ready && (await switchDevice()).reported['light.power'].value === true);
  const sent = (await stats()).switch_commands;
  assert.deepEqual(sent, [true, false, true, true, true]);
  assert.equal((await stack.request(base + '/commands/' + dropped.command.command_id)).value.status, 'unknown');
  await browser.close(); browser = null;
  await stack.restartGateway();
  await until(async () => (await switchDevice()).ready);
  const original = await stack.request(base + '/commands/by-key/onoff-drop');
  assert.equal(original.value.command_id, dropped.command.command_id); assert.equal(original.value.status, 'unknown');
  const replay = await stack.request(base + '/commands', { ...post(dropped.request), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'onoff-drop' } });
  assert.equal(replay.value.command_id, dropped.command.command_id); assert.equal(replay.value.status, 'unknown');
  assert.deepEqual((await stats()).switch_commands, sent);
  assert.equal((await commands()).length, 5); assert.deepEqual((await stats()).errors, []); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'onoff-report.json'), JSON.stringify({ passed: true, hardware: false,
    real_gateway_sqlite: true, mixed_environment_onoff_single_serial: true, browser_control: true,
    response_loss_original_get: true, threshold_onoff: true, ack_does_not_forge_state: true,
    unknown_and_restart_no_replay: true, native_app_runtime: false, published: false, full_goal_completed: false,
    commands: (await commands()).map(command => ({ command_id: command.command_id, status: command.status })) }, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'onoff-report.json') }));
});

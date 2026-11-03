import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { base, commandResult, post } from './helpers/actions.mjs';

test('自动化预算经MQTT/HTTP/CLI与网页可见，重启和换名不清零，手动控制保留', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/rule-budget-'));
  const stack = await startStack({ directory }); t.after(() => stack.close());
  const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-light.json')));
  rule.cooldown_ms = 0;
  rule.actions = Array.from({ length: 8 }, () => ({ device: 'device-lamp', set: { path: 'light.brightness', value: 30 } }));
  const deployment = await stack.request(base + '/rule-deployments', post(rule)); assert.equal(deployment.status, 200);
  const runs = async () => (await stack.request(base + '/runs')).value.items;
  const commands = async () => (await stack.request(base + '/commands')).value.items;
  const press = async (id, original) => {
    const input = original ?? { event_id: id, occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } };
    stack.button.stdin.write(JSON.stringify(input) + '\n');
    return until(async () => (await runs()).find(run => run.event_id === id));
  };
  for (let index = 0; index < 8; index++) {
    const run = await press(`budget-${index}`);
    assert.equal(run.error, null); assert.equal(run.command_ids.length, 8);
    await Promise.all(run.command_ids.map(id => commandResult(stack, id)));
  }
  const originalIds = (await commands()).map(command => command.command_id).sort(); assert.equal(originalIds.length, 64);
  const rejected = await press('budget-exhausted');
  assert.equal(rejected.error, 'automation_budget_exceeded'); assert.deepEqual(rejected.command_ids, []);
  assert.deepEqual((await commands()).map(command => command.command_id).sort(), originalIds);
  const device = (await stack.request(base + '/devices/device-lamp')).value;
  const manual = await stack.request(base + '/commands', post({ device_id: 'device-lamp', model_revision: device.model_revision,
    expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: 'light.brightness', value: 37 } }, 'budget-manual'));
  assert([200, 201, 202].includes(manual.status)); await commandResult(stack, manual.value.command_id);
  assert.equal((await commands()).length, 65);
  assert.equal((await stack.request(base + '/rule-deployments/' + rule.id + '/stop', post({ revision: deployment.value.revision }))).status, 200);
  rule.id = 'renamed-budget-rule';
  assert.equal((await stack.request(base + '/rule-deployments', post(rule))).status, 200);
  await stack.restartGateway(); await stack.restartDevice('lamp'); await stack.restartDevice('button');
  const afterRestart = await press('after-budget-restart');
  assert.equal(afterRestart.error, 'automation_budget_exceeded'); assert.deepEqual(afterRestart.command_ids, []);
  const cli = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'runs.list', '--space-id', 'space-demo'], { cwd: root, env: stack.env })).stdout);
  assert(cli.items.some(run => run.run_id === rejected.run_id && run.error === 'automation_budget_exceeded'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await page.getByRole('button', { name: '家庭导航', exact: true }).click();
  await page.getByRole('button', { name: '执行记录', exact: true }).click();
  const summary = page.locator('summary').filter({ hasText: '自动化操作过于频繁，本次未执行' });
  await expect(summary).toHaveCount(2); await summary.first().click();
  await expect(page.getByText('automation_budget_exceeded', { exact: true }).first()).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(directory, 'budget-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal((await commands()).length, 65);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, real_http_mqtt_sqlite: true,
    automation_commands: 64, manual_commands: 1, rejected_runs: 2, cli: true, mobile_browser: true,
    restart_and_rule_rename_preserve_budget: true, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
});

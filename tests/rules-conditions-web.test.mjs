import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { base, commandResult, post } from './helpers/actions.mjs';
import { GatewayTaskSession } from '../packages/cli/src/task-session.mjs';

test('条件网页与终端任务：完整树编辑、未满足可明确启用、取消、冻结证据和窄屏', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/conditions-web-'));
  const stack = await startStack({ directory }); t.after(() => stack.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = JSON.parse(await readFile(path.join(root, 'contracts/examples/button-conditional-light.json')));
  fixture.cooldown_ms = 1001;
  // 先把完整嵌套规则交给任务会话；当前条件未满足也必须校验触发与证据。
  const session = new GatewayTaskSession({ endpoint: stack.env.LIMEIOT_ENDPOINT, token: stack.env.LIMEIOT_TOKEN, space: 'space-demo', directory: path.join(directory, 'tasks'), catalog: JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json'))) });
  await session.prepareRule(fixture, { count: 1 }); assert.equal(session.review.simulation.trigger_matched, true); assert.equal(session.review.simulation.matched, false);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  await session.commit(session.review.record.task_id);
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await page.getByRole('button', { name: '自动化', exact: true }).click();
  const row = page.locator('.deployment'); await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('冷却时间（秒）', { exact: true })).toHaveValue('1.001');
  await expect(page.getByLabel('条件 1-1 比较值', { exact: true })).toHaveValue('40');
  await expect(page.getByLabel('条件 1-2-1 比较值', { exact: true })).toHaveValue('true');
  await page.getByLabel('条件 1-1 比较值', { exact: true }).fill('50');
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  assert.deepEqual((await stack.request(base + '/rule-deployments')).value.items[0].rule, fixture);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  const simulate = page.getByRole('button', { name: '校验并预演', exact: true }), enable = page.getByRole('button', { name: '启用自动化', exact: true });
  const value = page.getByLabel('条件 1-1 比较值', { exact: true }); await value.fill('40.01'); await expect(simulate).toBeDisabled();
  await value.fill('40'); await simulate.click(); await expect(enable).toBeEnabled();
  await expect(page.getByText('触发样例有效，当前条件未满足。启用后等待新的触发，不会补执行。', { exact: true })).toBeVisible();
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await value.fill('41'); await expect(enable).toBeDisabled(); await simulate.click(); await expect(enable).toBeEnabled(); await enable.click();
  const edited = (await stack.request(base + '/rule-deployments')).value.items[0];
  assert.equal(edited.rule.id, fixture.id); assert.equal(edited.rule.conditions[0].all[0].value, 41);
  assert.equal(edited.rule.cooldown_ms, 1001);
  assert.deepEqual(edited.rule.conditions[0].all[1], fixture.conditions[0].all[1]);
  const press = async id => {
    stack.button.stdin.write(JSON.stringify({ event_id: id, occurred_at: new Date().toISOString(), historical: false, data: { count: 1 } }) + '\n');
    return until(async () => (await stack.request(base + '/runs')).value.items.find(run => run.event_id === id));
  };
  const skipped = await press('web-condition-unmet'); assert.equal(skipped.error, 'rule_conditions_not_met'); assert.deepEqual(skipped.command_ids, []);
  let index = 0;
  for (const [property, value] of [['light.power', true], ['light.brightness', 50]]) {
    const device = (await stack.request(base + '/devices/device-lamp')).value;
    const response = await stack.request(base + '/commands', post({ device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: property, value } }, `web-condition-${index++}`));
    await commandResult(stack, response.value.command_id);
    await until(async () => (await stack.request(base + '/devices/device-lamp')).value.reported[property].value === value);
  }
  const executed = await press('web-condition-met'); await commandResult(stack, executed.command_ids[0]);
  assert.equal(executed.condition_evaluation.results[0].children[0].observation.value, 50);
  await page.getByRole('button', { name: '执行记录', exact: true }).click();
  const success = page.locator('.run').filter({ hasText: 'web-condition-met' }); await success.locator(':scope > summary').click();
  const evidence = success.locator('.condition-evidence'); await evidence.locator(':scope > summary').click(); await expect(evidence).toContainText('观测值 50 percent');
  const failed = page.locator('.run').filter({ hasText: 'web-condition-unmet' }); await expect(failed.locator(':scope > summary')).toHaveText('条件未满足，本次未执行');
  assert.equal((await stack.request(base + '/commands')).value.items.length, 3);
  await page.screenshot({ path: path.join(directory, 'conditions-evidence.png'), fullPage: true });
  await page.getByRole('button', { name: '自动化', exact: true }).click(); await page.locator('.deployment').getByRole('button', { name: '编辑', exact: true }).click();
  // 在界面实际增删组合，保留已有树，不靠只读展示代替编辑。
  await page.getByRole('button', { name: '添加任一满足组', exact: true }).last().click();
  await expect(page.getByLabel('条件 2 组合方式', { exact: true })).toHaveValue('any');
  await page.getByRole('button', { name: '移除条件 2', exact: true }).click();
  await expect(page.getByLabel('条件 2 组合方式', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => { const rect = await page.locator('aside').boundingBox(); return rect.x + rect.width <= 0; }).toBe(true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(directory, 'conditions-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, real_http_mqtt_sqlite: true, terminal_conditional_review: true, full_tree_edit_cancel: true, unmet_explicit_deployment: true, changed_condition_invalidates_preview: true, preview_commands: 0, manual_commands: 2, automation_commands: 1, unmet_runs: 1, frozen_evidence_visible: true, mobile_width: 390, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
});

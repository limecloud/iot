import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { voiceStack, base, transcript, answer } from './helpers/voice-turns.mjs';

test('私有工作台陪伴导航、真实网关回合及离页后无历史恢复', { timeout: 120000 }, async t => {
  const instructions = '你是本地搭建伙伴，用简短中文回答，不调用工具。';
  const state = await voiceStack(t, { inspectText(input) {
    assert.match(input.messages[0].content, /no tools, device access/);
    assert.equal(input.messages[1].content, instructions);
    assert.deepEqual(input.messages.slice(2), [{ role: 'user', content: transcript }]);
  } });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && /\/(audio-transcriptions|text-generations|speech-syntheses)$/.test(new URL(req.url()).pathname)) posts.push(req.url()); });
  await page.goto(state.stack.env.LIMEIOT_ENDPOINT + '/?view=companion');
  await page.getByLabel('所有者凭据', { exact: true }).fill(state.stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await expect(page.getByRole('region', { name: '陪伴会话', exact: true }).getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
  // 只模拟私有控制面的身份/空间只读接口；陪伴和媒体仍访问真实网关。
  await page.route('**/platform.json', route => route.fulfill({ json: { mode: 'private' } }));
  await page.route('**/api/console/v1/auth/config', route => route.fulfill({ json: { local: true, oidc: false } }));
  await page.route('**/api/console/v1/auth/session', route => route.fulfill({ json: { audience: 'console', principal: { principal_id: 'fixture-owner', name: '本地所有者' }, csrf_token: 'a'.repeat(32), expires_at: new Date(Date.now() + 3600000).toISOString() } }));
  await page.route('**/api/console/v1/spaces', route => route.fulfill({ json: { spaces: [] } }));
  await page.goto(state.stack.env.LIMEIOT_ENDPOINT + '/?view=media');
  await expect(page.getByRole('heading', { name: '音频', exact: true })).toBeVisible();
  const shell = await page.locator('.workspace').elementHandle();
  async function navigate(name) {
    await page.getByRole('button', { name: '工作台导航', exact: true }).click();
    await page.getByRole('link', { name, exact: true }).click();
    assert.ok(await shell.evaluate(node => node.isConnected));
    assert.equal(await page.locator('.workspace-bar').count(), 1);
  }
  await navigate('陪伴'); const panel = page.getByRole('region', { name: '陪伴会话', exact: true });
  await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
  assert.equal(posts.length, 0); assert.equal(state.calls.length, 0);
  await panel.getByLabel('陪伴角色', { exact: true }).selectOption('custom'); await panel.getByLabel('角色说明', { exact: true }).fill(instructions);
  await panel.getByRole('button', { name: '开始陪伴', exact: true }).click(); await expect(panel.getByLabel('本轮录音', { exact: true })).toBeEnabled();
  await panel.getByLabel('本轮录音', { exact: true }).selectOption(state.media.media_id);
  await panel.getByRole('button', { name: '发送本轮录音', exact: true }).click(); await expect(panel.getByText('本轮回复已生成', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('本次陪伴记录', { exact: true }).locator('span')).toHaveText([transcript, answer]);
  assert.equal(posts.length, 3); assert.equal(state.calls.length, 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(state.directory, 'companion-private-workspace.png'), fullPage: true });
  await navigate('音频'); await expect(page.getByRole('heading', { name: '音频', exact: true })).toBeVisible();
  await navigate('陪伴'); await expect(panel.getByText('会话上下文已清除，请结束后重新开始', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送本轮录音', exact: true })).toHaveCount(0); assert.equal(posts.length, 3);
  await panel.getByRole('button', { name: '结束并清除回答', exact: true }).click(); await expect(panel.getByText('会话已结束', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
  assert.equal((await state.stack.request(base + '/media')).value.grants.length, 0);
  assert.equal((await state.stack.request(base + '/commands')).value.items.length, 0);
  assert.equal(posts.length, 3); assert.deepEqual(state.errors, []); assert.deepEqual(errors, []);
  const report = path.join(state.directory, 'companion-workspace.json');
  await writeFile(report, JSON.stringify({ passed: true, browser: true, viewport: 390, workspace_control_identity_mocked: true, real_gateway: true, real_sqlite: true, real_mqtt: true, provider_fixture: true, same_document_navigation: true, gateway_home_entry: true, nas_nginx_maintenance_route_retested: false, role_bound: true, explicit_turn: true, leave_clears_history: true, recovery_zero_new_inference: true, context_free_stop: true, provider_calls: 3, zero_grants_or_commands: true, nas_image_rebuilt: false, published: false, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + report);
});

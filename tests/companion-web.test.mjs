import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { voiceStack, base, transcript, answer } from './helpers/voice-turns.mjs';
import { until } from '../tools/dev-stack.mjs';

const storage = `limeiot.companion:${base}`;
const instructions = '你是积木伙伴小青，用简短中文讨论搭建，不调用工具。';
async function setup(t) {
  const state = await voiceStack(t, { inspectText(input, index) {
    assert.match(input.messages[0].content, /no tools, device access/);
    assert.equal(input.messages[1].content, instructions);
    assert.deepEqual(input.messages.slice(2), index === 0 ? [{ role: 'user', content: transcript }] : [
      { role: 'user', content: transcript }, { role: 'assistant', content: answer }, { role: 'user', content: transcript },
    ]);
  } });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const pageErrors = [], posts = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && /\/(audio-transcriptions|text-generations|speech-syntheses)$/.test(new URL(req.url()).pathname)) posts.push(req.url()); });
  await page.goto(state.stack.env.LIMEIOT_ENDPOINT + '/?view=companion');
  await page.getByLabel('所有者凭据', { exact: true }).fill(state.stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const panel = page.getByRole('region', { name: '陪伴会话', exact: true });
  await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
  async function start() {
    await panel.getByLabel('陪伴角色', { exact: true }).selectOption('custom');
    await panel.getByLabel('角色说明', { exact: true }).fill(instructions);
    await panel.getByRole('button', { name: '开始陪伴', exact: true }).click();
    await expect(panel.getByLabel('本轮录音', { exact: true })).toBeEnabled();
  }
  async function reply() {
    await panel.getByLabel('本轮录音', { exact: true }).selectOption(state.media.media_id);
    await panel.getByRole('button', { name: '发送本轮录音', exact: true }).click();
  }
  return { ...state, page, panel, context, pageErrors, posts, start, reply };
}

test('390px陪伴页面双轮角色历史、摘要持久化、重载只查询和无历史停止', { timeout: 150000 }, async t => {
  const state = await setup(t), { page, panel, posts, stack } = state;
  await state.start(); assert.equal(posts.length, 0); assert.equal(state.calls.length, 0);
  for (let round = 1; round <= 2; round++) {
    await state.reply(); await expect(panel.getByText('本轮回复已生成', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('本次陪伴记录', { exact: true }).locator('span')).toHaveText(Array.from({ length: round }, () => [transcript, answer]).flat());
    assert.equal(posts.length, round * 3); assert.equal(state.calls.length, round * 3);
  }
  const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage);
  assert.equal(record.turns.length, 2); assert.equal(record.history.message_count, 4);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const text of [instructions, transcript, answer]) assert.equal(stored.includes(text), false);
  const grants = page.getByRole('region', { name: '播放授权', exact: true });
  await expect(grants.getByLabel('音频', { exact: true })).toHaveValue(record.turns[1].record.jobs.speech.observation.media_id);
  await expect(grants.getByLabel('允许所选音箱读取此音频', { exact: true })).not.toBeChecked();
  assert.equal((await stack.request(base + '/media')).value.grants.length, 0); assert.deepEqual(state.fixture.effects, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(state.directory, 'companion-mobile-light.png'), fullPage: true });
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('dark');
  await page.screenshot({ path: path.join(state.directory, 'companion-mobile-dark.png'), fullPage: true });
  await page.reload(); await expect(panel.getByText('会话上下文已清除，请结束后重新开始', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('本轮录音', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('本次陪伴记录', { exact: true })).toHaveCount(0); assert.equal(posts.length, 6);
  await panel.getByRole('button', { name: '查询原会话', exact: true }).click();
  await expect(panel.getByLabel('当前文字回复', { exact: true })).toHaveText(answer); assert.equal(posts.length, 6);
  await panel.getByRole('button', { name: '结束并清除回答', exact: true }).click();
  await expect(panel.getByText('会话已结束', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('当前文字回复', { exact: true })).toHaveCount(0);
  await stack.restartGateway();
  for (const slot of record.turns) assert.equal((await stack.request(base + '/text-generations/by-key/' + slot.record.jobs.text.original.idempotency_key)).value.output.text, null);
  assert.deepEqual(state.calls, ['transcription', 'text', 'speech', 'transcription', 'text', 'speech']);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  assert.deepEqual(state.errors, []); assert.deepEqual(state.pageErrors, []);
  const report = path.join(state.directory, 'companion-web.json');
  await writeFile(report, JSON.stringify({ passed: true, browser: true, viewport: 390, real_gateway: true, real_sqlite: true, real_mqtt: true, provider_fixture: true, turns: 2, provider_calls: 6, role_and_exact_history: true, summary_only_storage: true, reload_no_new_post: true, lost_history_blocks_reply: true, query_reveals_only_current_result: true, context_free_stop_clears_both_answers: true, gateway_restart: true, zero_grants_or_commands: true, hardware: false, native_app_runtime: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + report);
});

test('陪伴网页保存失败零推理、响应丢失只查询、后台暂停与明确继续', { timeout: 150000 }, async t => {
  const state = await setup(t), { page, panel, posts } = state;
  await page.evaluate(key => { const original = Storage.prototype.setItem; window.__companionSet = original; Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('blocked', 'QuotaExceededError'); return original.call(this, name, value); }; }, storage);
  await panel.getByRole('button', { name: '开始陪伴', exact: true }).click();
  await expect(panel.getByText('会话记录不可用，已暂停新请求', { exact: true })).toBeVisible(); assert.equal(posts.length, 0); assert.equal(state.calls.length, 0);
  await page.evaluate(() => { Storage.prototype.setItem = window.__companionSet; }); await page.reload();
  await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled(); await state.start();
  await page.route('**' + base + '/audio-transcriptions', async route => { await route.fetch(); await route.abort('failed'); });
  await state.reply(); await expect(panel.getByText('本轮结果待核实，请查询原会话', { exact: true })).toBeVisible(); await until(() => state.calls.length === 1);
  await page.unroute('**' + base + '/audio-transcriptions'); await panel.getByRole('button', { name: '查询原会话', exact: true }).click();
  await expect(panel.getByRole('button', { name: '继续本轮', exact: true })).toBeEnabled(); assert.equal(posts.length, 1);
  state.setMode('hold-text'); await panel.getByRole('button', { name: '继续本轮', exact: true }).click(); await until(() => state.holds.length === 1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panel.getByLabel('当前识别文本', { exact: true })).toHaveCount(0); await expect(panel.getByLabel('本次陪伴记录', { exact: true })).toHaveCount(0);
  state.holds.shift()();
  await until(async () => { const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage); return (await state.stack.request(base + '/text-generations/by-key/' + record.turns[0].record.jobs.text.original.idempotency_key)).value.status === 'succeeded'; });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panel.getByRole('button', { name: '继续本轮', exact: true })).toBeEnabled(); assert.equal(posts.length, 2); assert.equal(state.calls.length, 2);
  await expect(panel.getByLabel('当前文字回复', { exact: true })).toHaveCount(0);
  state.setMode('ok'); await panel.getByRole('button', { name: '继续本轮', exact: true }).click();
  await expect(panel.getByText('本轮回复已生成', { exact: true })).toBeVisible(); assert.equal(posts.length, 3); assert.equal(state.calls.length, 3);
  await page.evaluate(key => { localStorage.setItem(key, '{'); dispatchEvent(new StorageEvent('storage', { key, newValue: '{' })); }, storage);
  await expect(panel.getByText('会话记录不可用，已暂停新请求', { exact: true })).toBeVisible(); assert.equal(posts.length, 3);
  assert.deepEqual(state.pageErrors, []); assert.deepEqual(state.errors, []);
  const report = path.join(state.directory, 'companion-web-faults.json');
  await writeFile(report, JSON.stringify({ passed: true, browser: true, save_failure_zero_inference: true, lost_response_get_only: true, hidden_no_next_stage: true, visible_get_only_until_explicit_continue: true, corrupt_record_blocks: true, provider_calls: 3, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + report);
});

test('陪伴网页网关重启保持unknown且跨标签锁拒绝新推理', { timeout: 150000 }, async t => {
  const state = await setup(t), { page, panel, posts } = state;
  await page.evaluate(key => new Promise(resolve => { void navigator.locks.request(key, async () => { resolve(); await new Promise(release => { window.__companionRelease = release; }); }); }), storage);
  await panel.getByRole('button', { name: '开始陪伴', exact: true }).click();
  await expect(panel.getByText('另一个标签正在操作会话，请稍后查询', { exact: true })).toBeVisible(); assert.equal(posts.length, 0); assert.equal(state.calls.length, 0);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storage), null);
  await page.evaluate(() => window.__companionRelease());
  await state.start(); state.setMode('hold-text'); await state.reply(); await until(() => state.holds.length === 1);
  await state.stack.restartGateway(); await page.reload();
  await expect(page.getByLabel('所有者凭据', { exact: true })).toBeVisible();
  await page.getByLabel('所有者凭据', { exact: true }).fill(state.stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原会话', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '查询原会话', exact: true }).click();
  await expect(panel.getByText('结果待核实', { exact: true })).toBeVisible(); assert.equal(posts.length, 2); assert.equal(state.calls.length, 2);
  await expect(panel.getByRole('button', { name: '继续本轮', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '发送本轮录音', exact: true })).toHaveCount(0);
  state.holds.shift()();
  await panel.getByRole('button', { name: '结束并清除回答', exact: true }).click();
  await expect(panel.getByText('会话已结束', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
  assert.equal(posts.length, 2); assert.equal(state.calls.length, 2); assert.deepEqual(state.errors, []); assert.deepEqual(state.pageErrors, []);
  const report = path.join(state.directory, 'companion-web-unknown.json');
  await writeFile(report, JSON.stringify({ passed: true, browser: true, cross_tab_exclusion: true, reauthenticated_after_restart: true, gateway_restart_unknown: true, unknown_blocks_replacement: true, original_query_only: true, context_free_stop: true, provider_calls: 2, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  t.diagnostic('evidence: ' + report);
});

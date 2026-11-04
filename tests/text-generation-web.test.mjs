import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { until } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { textStack, base } from './helpers/text.mjs';

const storage = `limeiot.text:${base}`;
async function setup(t) {
  const result = await textStack(t), browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }), page = await context.newPage(); page.setDefaultTimeout(15000);
  const login = async () => { await page.getByLabel('所有者凭据', { exact: true }).fill(result.stack.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click(); };
  await page.goto(result.stack.env.LIMEIOT_ENDPOINT + '/?view=text'); await login();
  const panel = page.getByRole('region', { name: '本地对话', exact: true }); await expect(panel.getByLabel('消息', { exact: true })).toBeEnabled();
  const send = async text => { await panel.getByLabel('消息', { exact: true }).fill(text); await panel.getByRole('button', { name: '发送', exact: true }).click(); };
  return { ...result, context, page, panel, login, send };
}

test('390px本地对话：多轮上下文、丢回执只查原键、后台清文和明确清除', { timeout: 150000 }, async t => {
  const { stack, directory, calls, errors, text, page, panel, send } = await setup(t); let posts = 0, discards = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === base + '/text-generations') posts++; if (req.method() === 'POST' && req.url().endsWith('/discard')) discards++; });
  await send('我喜欢积木。'); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText(text);
  assert.equal(calls[0].message_count, 1); assert.equal(calls[0].context_digest, await documentDigest({ instructions: '', messages: [{ role: 'user', content: '我喜欢积木。' }] }));
  await page.route('**/text-generations', async route => { if (route.request().method() === 'POST') { await route.fetch(); await route.abort(); } else await route.continue(); });
  await send('我刚才说喜欢什么？'); await expect(panel.getByRole('status')).toHaveText('回答结果待核实，请查询原任务');
  await panel.getByRole('button', { name: '查询原任务', exact: true }).click(); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText(text);
  assert.equal(calls[1].message_count, 3); assert.equal(calls[1].context_digest, await documentDigest({ instructions: '', messages: [{ role: 'user', content: '我喜欢积木。' }, { role: 'assistant', content: text }, { role: 'user', content: '我刚才说喜欢什么？' }] }));
  const saved = await page.evaluate(key => localStorage.getItem(key), storage); for (const raw of ['我喜欢积木。', '我刚才说喜欢什么？', text]) assert.equal(saved.includes(raw), false);
  assert.equal(posts, 2); assert.equal(calls.length, 2);
  await page.evaluate(() => { window.__textHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__textHidden }); document.dispatchEvent(new Event('visibilitychange')); }); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveCount(0); await expect(panel.getByLabel('本页对话', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.__textHidden = false; document.dispatchEvent(new Event('visibilitychange')); }); await expect(panel.getByRole('button', { name: '查询原任务', exact: true })).toBeEnabled(); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '查询原任务', exact: true }).click(); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText(text);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(directory, 'text-mobile.png'), fullPage: true });
  await panel.getByRole('button', { name: '清除回答', exact: true }).click(); await panel.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(discards, 0);
  await panel.getByRole('button', { name: '清除回答', exact: true }).click(); await panel.getByRole('button', { name: '确认清除输出', exact: true }).click(); await expect(panel.getByText('回答已清除', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '查询原任务', exact: true }).click(); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveCount(0); assert.equal(posts, 2); assert.equal(discards, 1); assert.equal(calls.length, 2);
  await page.unroute('**/text-generations'); await send('新的话题'); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText(text); assert.equal(calls[2].message_count, 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'text-web-result.json'), JSON.stringify({ passed: true, viewport: 390, real_browser: true, real_gateway: true, multi_turn_digest_verified: true, raw_input_output_absent_from_storage: true, lost_response_get_only: true, background_clears_context: true, explicit_clear: true, horizontal_overflow: false, create_posts: posts, provider_calls: calls.length, provider_fixture: true, real_model_quality: false, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'text-web-result.json') }));
});

test('对话存储写入/回读失败零POST，重启未知占用和迟到回答隔离', { timeout: 150000 }, async t => {
  const { stack, directory, calls, holds, errors, setMode, page, panel, send, login } = await setup(t); let posts = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === base + '/text-generations') posts++; });
  for (const mode of ['write', 'readback']) {
    await page.evaluate(({ key, mode }) => { const set = Storage.prototype.setItem, get = Storage.prototype.getItem; let written = false; window.__restoreTextStorage = () => { Storage.prototype.setItem = set; Storage.prototype.getItem = get; }; Storage.prototype.setItem = function (name, value) { if (name === key && mode === 'write') throw new Error('fixture_write_failure'); const result = set.call(this, name, value); if (name === key) written = true; return result; }; Storage.prototype.getItem = function (name) { if (name === key && written && mode === 'readback') throw new Error('fixture_readback_failure'); return get.call(this, name); }; }, { key: storage, mode });
    await send('不应发送的私密消息'); await expect(panel.getByRole('status')).toHaveText('对话记录不可用，已暂停新请求'); assert.equal(posts, 0); assert.equal(calls.length, 0);
    await page.evaluate(key => { window.__restoreTextStorage(); localStorage.removeItem(key); }, storage); await page.reload(); await expect(panel.getByLabel('消息', { exact: true })).toBeEnabled();
  }
  setMode('hold'); await send('等待生成'); await until(() => holds.length === 1);
  await stack.restartGateway(); await page.reload(); await login(); await expect(panel.getByText('结果待核实', { exact: true })).toBeVisible(); await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled(); assert.equal(posts, 1); assert.equal(calls.length, 1);
  await panel.getByRole('button', { name: '放弃生成输出', exact: true }).click(); await panel.getByRole('button', { name: '确认清除输出', exact: true }).click(); await expect(panel.getByText('已放弃输出', { exact: true })).toBeVisible(); holds.shift()();
  await panel.getByRole('button', { name: '查询原任务', exact: true }).click(); await expect(panel.getByLabel('回答结果', { exact: true })).toHaveCount(0); assert.equal(posts, 1);
  await page.evaluate(key => localStorage.setItem(key, '{bad'), storage); await page.reload(); await expect(panel.getByRole('status')).toHaveText('对话记录不可用，已暂停新请求'); assert.equal(posts, 1); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'text-web-recovery-result.json'), JSON.stringify({ passed: true, write_readback_failures_prevent_post: true, restart_unknown_blocks_new_work: true, late_output_ignored: true, corrupt_storage_blocks_post: true, provider_calls: calls.length, provider_fixture: true, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'text-web-recovery-result.json') }));
});

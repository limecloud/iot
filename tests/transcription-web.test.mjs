import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { transcriptionStack, base, post } from './helpers/transcription.mjs';
import { until } from '../tools/dev-stack.mjs';
const storage = `limeiot.transcription:${base}`;
async function setup(t, prefix) {
  const result = await transcriptionStack(t, prefix);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }), page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(result.stack.env.LIMEIOT_ENDPOINT + '/?view=media'); await page.getByLabel('所有者凭据', { exact: true }).fill(result.stack.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const panel = page.getByRole('region', { name: '语音识别', exact: true }); await expect(panel.getByLabel('录音', { exact: true })).toBeEnabled();
  await panel.getByLabel('录音', { exact: true }).selectOption(result.media.media_id);
  return { ...result, context, page, panel };
}
test('390px转写网页：存储失败零发送，丢响应及刷新只查询，文本不进浏览器存储', { timeout: 150000 }, async t => {
  const { directory, stack, media, calls, errors, text, fixture, page, panel } = await setup(t, 'transcription-web-');
  let posts = 0; page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === base + '/audio-transcriptions') posts++; });
  assert.equal(posts, 0);
  await page.evaluate(key => { const original = Storage.prototype.setItem; window.__restoreTranscriptionStorage = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function (name, value) { if (name === key) throw new Error('fixture_write_failed'); return original.call(this, name, value); }; }, storage);
  await panel.getByRole('button', { name: '识别录音', exact: true }).click(); await expect(panel.getByRole('status')).toHaveText('识别记录不可用，已暂停新请求'); assert.equal(posts, 0); assert.equal(calls.length, 0);
  await page.evaluate(() => window.__restoreTranscriptionStorage()); await page.reload(); await expect(panel.getByLabel('录音', { exact: true })).toBeEnabled(); await panel.getByLabel('录音', { exact: true }).selectOption(media.media_id);
  await page.route('**/audio-transcriptions', async route => { if (route.request().method() === 'POST') { await route.fetch(); await route.abort(); } else await route.continue(); });
  await panel.getByRole('button', { name: '识别录音', exact: true }).click(); await expect(panel.getByRole('status')).toHaveText('识别结果待核实，请查询原任务');
  await panel.getByRole('button', { name: '查询原任务', exact: true }).click(); await expect(panel.getByLabel('识别文本', { exact: true })).toHaveText(text); assert.equal(posts, 1); assert.equal(calls.length, 1);
  const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage); assert.equal(record.original.input.media_digest, media.content_digest);
  assert.equal(await page.evaluate(value => Object.values(localStorage).some(raw => raw.includes(value)), text), false);
  await page.reload(); await expect(panel.getByLabel('识别文本', { exact: true })).toHaveText(text); assert.equal(posts, 1); assert.equal(calls.length, 1);
  await page.evaluate(() => { window.__transcriptionHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__transcriptionHidden }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panel.getByLabel('识别文本', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.__transcriptionHidden = false; document.dispatchEvent(new Event('visibilitychange')); }); await expect(panel.getByLabel('识别文本', { exact: true })).toHaveText(text); assert.equal(posts, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(directory, 'transcription-mobile.png'), fullPage: true });
  await stack.request(base + '/media-operations', post({ type: 'media.delete', media_id: media.media_id }, 'web-delete-source')); await panel.getByRole('button', { name: '查询原任务', exact: true }).click(); await expect(panel.getByText('识别文本已清除', { exact: true })).toBeVisible();
  assert.equal(calls.length, 1); assert.equal(fixture.effects.length, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'transcription-web-result.json'), JSON.stringify({ passed: true, browser: true, viewport: 390, storage_failure_zero_posts: true, response_loss_get_only: true, reload_get_only: true, background_clears_text: true, foreground_get_only: true, no_text_in_browser_storage: true, deletion_clears_display: true, posts, provider_calls: calls.length, simulated_provider: true, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'transcription-web-result.json') }));
});

test('转写网页：重启未知占用、取消零放弃请求，损坏记录阻止新发送', { timeout: 150000 }, async t => {
  const { directory, stack, calls, holds, errors, setMode, finish, page, panel, context } = await setup(t, 'transcription-web-unknown-');
  let posts = 0, discards = 0; page.on('request', req => { if (req.method() !== 'POST') return; const url = new URL(req.url()).pathname; if (url === base + '/audio-transcriptions') posts++; if (url.endsWith('/discard')) discards++; });
  setMode('hold'); await panel.getByRole('button', { name: '识别录音', exact: true }).click(); await until(() => holds.length === 1); await expect(panel.getByText('正在识别', { exact: true })).toBeVisible();
  const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage); await stack.restartGateway();
  // 网关重启使旧浏览器会话失效；重新认证后从原记录恢复，不能点击已退出的页面。
  await page.reload(); await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await panel.getByRole('button', { name: '查询原任务', exact: true }).click(); await expect(panel.getByText('结果未知', { exact: true })).toBeVisible(); await expect(panel.getByRole('button', { name: '识别录音', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '放弃识别输出', exact: true }).click(); await panel.getByRole('group', { name: '确认放弃识别输出', exact: true }).getByRole('button', { name: '取消', exact: true }).click(); assert.equal(discards, 0);
  await panel.getByRole('button', { name: '放弃识别输出', exact: true }).click(); await panel.getByRole('button', { name: '确认放弃识别输出', exact: true }).click(); await expect(panel.getByText('已放弃输出', { exact: true })).toBeVisible(); assert.equal(discards, 1); holds.shift()(); assert.equal((await finish(record.original.idempotency_key)).output, null);
  await context.setOffline(true); await expect(panel.getByRole('button', { name: '识别录音', exact: true })).toBeDisabled(); await context.setOffline(false); await expect(panel.getByRole('button', { name: '读取识别状态', exact: true })).toBeEnabled();
  await page.evaluate(key => localStorage.setItem(key, '{bad'), storage); await panel.getByRole('button', { name: '读取识别状态', exact: true }).click(); await expect(panel.getByRole('status')).toHaveText('识别记录不可用，已暂停新请求'); await expect(panel.getByRole('button', { name: '识别录音', exact: true })).toBeDisabled();
  assert.equal(posts, 1); assert.equal(calls.length, 1); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'transcription-web-unknown-result.json'), JSON.stringify({ passed: true, restart_unknown_budget: true, cancel_discard_zero_posts: true, explicit_discard: true, late_output_ignored: true, offline_disabled: true, corrupt_record_blocks_new_posts: true, create_posts: posts, discard_posts: discards, provider_calls: calls.length, simulated_provider: true, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'transcription-web-unknown-result.json') }));
});

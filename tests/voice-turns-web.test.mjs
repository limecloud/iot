import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { voiceStack, base, transcript, answer } from './helpers/voice-turns.mjs';
import { until } from '../tools/dev-stack.mjs';

const storage = `limeiot.voice-turn:${base}`;
async function setup(t) {
  const state = await voiceStack(t);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(state.stack.env.LIMEIOT_ENDPOINT + '/?view=media');
  await page.getByLabel('所有者凭据', { exact: true }).fill(state.stack.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const panel = page.getByRole('region', { name: '语音对话', exact: true });
  await expect(panel.getByLabel('对话录音', { exact: true })).toBeEnabled(); await panel.getByLabel('对话录音', { exact: true }).selectOption(state.media.media_id);
  return { ...state, context, page, panel, pageErrors: errors };
}

test('390px完整语音回合：自动衔接三阶段、清正文、独立授权与实际Range播放', { timeout: 150000 }, async t => {
  const state = await setup(t), { panel, page, stack, fixture } = state; await state.bindSpeaker();
  const posts = []; page.on('request', req => { if (req.method() === 'POST' && /\/(audio-transcriptions|text-generations|speech-syntheses)$/.test(new URL(req.url()).pathname)) posts.push(req.url()); });
  await panel.getByRole('button', { name: '生成语音回答', exact: true }).click();
  await expect(panel.getByText('语音回答已生成', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('本轮识别文本', { exact: true })).toHaveText(transcript); await expect(panel.getByLabel('本轮文字回答', { exact: true })).toHaveText(answer);
  assert.deepEqual(state.calls, ['transcription', 'text', 'speech']); assert.equal(posts.length, 3); assert.equal(fixture.effects.length, 0);
  const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage); assert.equal(JSON.stringify(record).includes(transcript), false); assert.equal(JSON.stringify(record).includes(answer), false);
  const mediaID = record.jobs.speech.observation.media_id;
  const grants = page.getByRole('region', { name: '播放授权', exact: true }); await expect(grants.getByLabel('音频', { exact: true })).toHaveValue(mediaID);
  await expect(grants.getByLabel('允许所选音箱读取此音频', { exact: true })).not.toBeChecked(); assert.equal((await stack.request(base + '/media')).value.grants.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(state.directory, 'voice-turn-mobile.png'), fullPage: true });
  await page.reload(); await expect(panel.getByText('语音回答已生成', { exact: true })).toBeVisible(); await expect(panel.getByLabel('本轮文字回答', { exact: true })).toHaveCount(0); assert.equal(posts.length, 3);
  await panel.getByRole('button', { name: '查询原回合', exact: true }).click(); await expect(panel.getByLabel('本轮文字回答', { exact: true })).toHaveText(answer); assert.equal(posts.length, 3);
  await grants.getByLabel('音频', { exact: true }).selectOption(mediaID); await grants.getByLabel('授权音箱', { exact: true }).selectOption('device-lamp'); await grants.getByLabel('允许所选音箱读取此音频', { exact: true }).check(); await grants.getByRole('button', { name: '创建播放授权', exact: true }).click();
  await expect(page.getByText('播放授权已创建', { exact: true })).toBeVisible(); assert.equal(fixture.effects.length, 0);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=devices'); const speaker = page.getByRole('article', { name: '音箱', exact: true });
  await speaker.getByRole('button', { name: '读取接入信息', exact: true }).click(); await speaker.getByLabel('获准音频', { exact: true }).selectOption(mediaID); await speaker.getByRole('button', { name: '播放音频', exact: true }).click();
  await expect(speaker.getByText('最近操作：输入已提交', { exact: true })).toBeVisible(); assert.equal(fixture.effects.length, 3); assert.equal(fixture.renderedPulls.length, 1);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=media'); await expect(panel.getByText('语音回答已生成', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '结束并清除回答', exact: true }).click(); await expect(panel.getByText('本轮已结束', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('本轮文字回答', { exact: true })).toHaveCount(0); await stack.restartGateway();
  assert.equal((await stack.request(base + '/text-generations/by-key/' + record.jobs.text.original.idempotency_key)).value.output.text, null);
  assert.deepEqual(state.pageErrors, []); assert.deepEqual(state.errors, []); assert.equal(state.calls.length, 3);
  await writeFile(path.join(state.directory, 'voice-turn-web.json'), JSON.stringify({ passed: true, browser: true, viewport: 390, real_gateway: true, real_sqlite: true, provider_fixture: true, renderer_fixture: true, stages_posted_once: 3, summary_only_storage: true, reload_no_new_post: true, explicit_grant_and_play: true, range_pull: true, stop_clear_survives_gateway_restart: true, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(state.directory, 'voice-turn-web.json'), screenshot: path.join(state.directory, 'voice-turn-mobile.png') }));
});

test('网页语音回合保存失败零POST、丢响应只查、后台暂停及明确继续', { timeout: 150000 }, async t => {
  const state = await setup(t), { page, panel } = state; const posts = [];
  page.on('request', req => { if (req.method() === 'POST' && /\/(audio-transcriptions|text-generations|speech-syntheses)$/.test(new URL(req.url()).pathname)) posts.push(req.url()); });
  await page.evaluate(key => { const original = Storage.prototype.setItem; window.__voiceSet = original; Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('blocked', 'QuotaExceededError'); return original.call(this, name, value); }; }, storage);
  await panel.getByRole('button', { name: '生成语音回答', exact: true }).click(); await expect(panel.getByText('语音回合记录不可用，已暂停新请求', { exact: true })).toBeVisible(); assert.equal(posts.length, 0); assert.equal(state.calls.length, 0);
  await page.evaluate(() => { Storage.prototype.setItem = window.__voiceSet; }); await page.reload();
  await expect(panel.getByLabel('对话录音', { exact: true })).toBeEnabled(); await panel.getByLabel('对话录音', { exact: true }).selectOption(state.media.media_id);
  await page.route('**' + base + '/audio-transcriptions', async route => { await route.fetch(); await route.abort('failed'); });
  await panel.getByRole('button', { name: '生成语音回答', exact: true }).click(); await expect(panel.getByText('本轮结果待核实，请查询原回合', { exact: true })).toBeVisible(); await until(() => state.calls.length === 1);
  await page.unroute('**' + base + '/audio-transcriptions'); await panel.getByRole('button', { name: '查询原回合', exact: true }).click(); await expect(panel.getByText('可以继续本轮', { exact: true })).toBeVisible(); assert.equal(posts.length, 1);
  state.setMode('hold-text'); await panel.getByRole('button', { name: '继续本轮', exact: true }).click(); await until(() => state.holds.length === 1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panel.getByLabel('本轮识别文本', { exact: true })).toHaveCount(0); state.holds.shift()();
  await until(async () => { const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage); return (await state.stack.request(base + '/text-generations/by-key/' + record.jobs.text.original.idempotency_key)).value.status === 'succeeded'; });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panel.getByText('可以继续本轮', { exact: true })).toBeVisible(); assert.equal(state.calls.length, 2); assert.equal(posts.length, 2); await expect(panel.getByLabel('本轮文字回答', { exact: true })).toHaveCount(0);
  state.setMode('ok'); await panel.getByRole('button', { name: '继续本轮', exact: true }).click(); await expect(panel.getByText('语音回答已生成', { exact: true })).toBeVisible(); assert.equal(posts.length, 3); assert.equal(state.calls.length, 3);
  await page.evaluate(key => { localStorage.setItem(key, '{'); dispatchEvent(new StorageEvent('storage', { key, newValue: '{' })); }, storage);
  await expect(panel.getByText('语音回合记录不可用，已暂停新请求', { exact: true })).toBeVisible(); assert.equal(posts.length, 3);
  assert.deepEqual(state.pageErrors, []); assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'voice-turn-web-faults.json'), JSON.stringify({ passed: true, browser: true, save_failure_zero_post: true, response_loss_get_only: true, background_no_next_stage: true, resume_get_only_until_explicit_continue: true, corrupt_record_blocks: true, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(state.directory, 'voice-turn-web-faults.json') }));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { until } from '../tools/dev-stack.mjs';
import { mediaStack, pcmWav } from './helpers/media.mjs';

const base = '/api/v1/spaces/space-demo', storage = `limeiot.speech:${base}:`;
async function setup(t, prefix) {
  const calls = [], holds = [], bytes = pcmWav();
  const provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); calls.push(value);
    const respond = () => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(bytes); };
    if (value.input === 'hold') holds.push(respond); else respond();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const result = await mediaStack(t, prefix, { gatewayEnv: {
    LIMEIOT_TTS_URL: `http://127.0.0.1:${provider.address().port}`,
    LIMEIOT_TTS_MODEL: 'fixture/local-model', LIMEIOT_TTS_VOICES: 'local,other', LIMEIOT_TTS_CA_FILE: '',
  } });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  async function login() {
    await page.goto(result.stack.env.LIMEIOT_ENDPOINT + '/?view=media');
    await page.getByLabel('所有者凭据', { exact: true }).fill(result.stack.env.LIMEIOT_TOKEN);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
    await expect(page.getByRole('heading', { name: '音频', exact: true })).toBeVisible();
  }
  await login();
  const speech = page.getByRole('region', { name: '文字转语音', exact: true });
  await expect(speech.getByLabel('文本', { exact: true })).toBeEnabled();
  return { ...result, calls, holds, page, context, speech, login };
}

test('390px语音网页：存储失败零发送、丢回执只查询、明确授权及真实软件播放', { timeout: 150000 }, async t => {
  const { directory, stack, fixture, bindSpeaker, calls, page, speech } = await setup(t, 'speech-web-'); await bindSpeaker();
  let posts = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === base + '/speech-syntheses') posts++; });
  const text = '这段家庭语音不会保存在浏览器任务记录中。';
  await speech.getByLabel('文本', { exact: true }).fill(text);
  await speech.getByLabel('声音', { exact: true }).selectOption('other');
  await speech.getByLabel('保留时间', { exact: true }).selectOption('3600');
  assert.equal(posts, 0); assert.equal(calls.length, 0);
  await page.evaluate(prefix => {
    window.__speechSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key.startsWith(prefix)) throw new DOMException('blocked', 'QuotaExceededError'); return window.__speechSetItem.call(this, key, value); };
  }, storage);
  await speech.getByRole('button', { name: '生成音频', exact: true }).click();
  await expect(speech.getByText('语音记录不可用，已暂停新请求', { exact: true })).toBeVisible();
  assert.equal(posts, 0); assert.equal(calls.length, 0);
  await page.evaluate(() => { Storage.prototype.setItem = window.__speechSetItem; }); await page.reload();
  await expect(speech.getByLabel('文本', { exact: true })).toBeEnabled();
  await page.evaluate(key => localStorage.setItem(key, '{'), storage + 'corrupt'); await page.reload();
  await expect(speech.getByText('语音记录不可用，已暂停新请求', { exact: true })).toBeVisible();
  await expect(speech.locator('form')).toHaveCount(0); assert.equal(posts, 0); assert.equal(calls.length, 0);
  await page.evaluate(key => localStorage.removeItem(key), storage + 'corrupt'); await page.reload();
  let lost;
  await page.route('**' + base + '/speech-syntheses', async route => {
    const response = await route.fetch(); lost = { key: route.request().headers()['idempotency-key'], value: await response.json() }; await route.abort('failed');
  });
  await expect(speech.getByLabel('文本', { exact: true })).toBeEnabled();
  await speech.getByLabel('文本', { exact: true }).fill(text);
  await speech.getByRole('button', { name: '生成音频', exact: true }).click();
  await expect(speech.getByText('生成结果待核实，请查询原任务', { exact: true })).toBeVisible(); assert.ok(lost); assert.equal(posts, 1);
  await expect(speech.getByLabel('文本', { exact: true })).toHaveValue('');
  await page.unroute('**' + base + '/speech-syntheses');
  const row = speech.getByRole('article', { name: `语音任务 ${lost.key}`, exact: true });
  await row.getByRole('button', { name: '查询原任务', exact: true }).click();
  await expect(row.getByText('生成完成', { exact: true })).toBeVisible();
  const completed = (await stack.request(base + '/speech-syntheses/by-key/' + lost.key)).value, mediaID = completed.media_id;
  const grantForm = page.getByRole('region', { name: '播放授权', exact: true });
  await expect(grantForm.getByLabel('音频', { exact: true })).toHaveValue(mediaID);
  await expect(grantForm.getByLabel('允许所选音箱读取此音频', { exact: true })).not.toBeChecked();
  assert.equal(posts, 1); assert.equal(calls.length, 1); assert.equal(fixture.effects.length, 0);
  assert.equal((await stack.request(base + '/media')).value.grants.length, 0);
  const records = await page.evaluate(prefix => Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)).map(([, raw]) => JSON.parse(raw)), storage);
  assert.equal(records.length, 1); assert.equal(JSON.stringify(records).includes(text), false);
  assert.equal((await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8')).includes(text), false);
  await row.getByText('任务详情', { exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(directory, 'speech-mobile.png'), fullPage: true });
  await grantForm.getByLabel('授权音箱', { exact: true }).selectOption('device-lamp');
  await expect(grantForm.getByRole('button', { name: '创建播放授权', exact: true })).toBeDisabled();
  await grantForm.getByLabel('允许所选音箱读取此音频', { exact: true }).check();
  await grantForm.getByRole('button', { name: '创建播放授权', exact: true }).click();
  await expect(page.getByText('播放授权已创建', { exact: true })).toBeVisible(); assert.equal(fixture.effects.length, 0);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=devices');
  const speaker = page.getByRole('article', { name: '音箱', exact: true });
  await speaker.getByRole('button', { name: '读取接入信息', exact: true }).click();
  await speaker.getByLabel('获准音频', { exact: true }).selectOption(mediaID);
  await speaker.getByRole('button', { name: '播放音频', exact: true }).click();
  await expect(speaker.getByText('最近操作：输入已提交', { exact: true })).toBeVisible();
  assert.equal(fixture.effects.length, 3); assert.equal(fixture.renderedPulls.length, 1);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=media');
  await expect(row.getByText('生成完成', { exact: true })).toBeVisible(); assert.equal(posts, 1);
  // 强制碰撞原编号，必须在发送前拒绝覆盖已有身份。
  await page.evaluate(key => { crypto.randomUUID = () => key; }, lost.key);
  await speech.getByLabel('文本', { exact: true }).fill('另一段内容');
  await speech.getByRole('button', { name: '生成音频', exact: true }).click();
  await expect(speech.getByText('语音记录不可用，已暂停新请求', { exact: true })).toBeVisible();
  assert.equal(posts, 1); assert.equal(calls.length, 1);
  const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage + lost.key); assert.deepEqual(after.original, records[0].original);
  const report = { passed: true, browser: true, viewport: 390, storage_failure_zero_posts: true, corrupt_record_blocks: true, identity_collision_zero_posts: true, lost_receipt_get_only: true, records_exclude_text: true, synthesis_does_not_authorize_or_play: true, separate_explicit_grant_and_play: true, real_http: true, real_sqlite: true, real_mqtt: true, simulated_provider: true, simulated_renderer: true, soap_mutations: 3, media_range_pulls: 1, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false };
  await writeFile(path.join(directory, 'speech-web-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'speech-web-result.json') }));
});

test('语音网页：前后台与离线清正文、原任务重启未知、明确放弃且不发布迟到输出', { timeout: 120000 }, async t => {
  const { stack, directory, calls, holds, page, context, speech, login } = await setup(t, 'speech-web-recovery-');
  await speech.getByLabel('文本', { exact: true }).fill('尚未提交的私人内容');
  // 注入可见性事件来验证页面的生命周期边界，不声称操作系统后台调度验收。
  await page.evaluate(() => { window.__speechHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__speechHidden }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(speech.getByLabel('文本', { exact: true })).toHaveValue(''); assert.equal(calls.length, 0);
  await page.evaluate(() => { window.__speechHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(speech.getByLabel('文本', { exact: true })).toBeEnabled();
  await speech.getByLabel('文本', { exact: true }).fill('离线后清除'); await context.setOffline(true);
  await expect(speech.getByLabel('文本', { exact: true })).toHaveValue('');
  await context.setOffline(false); await expect(speech.getByLabel('文本', { exact: true })).toBeEnabled();
  await speech.getByLabel('文本', { exact: true }).fill('hold'); await speech.getByRole('button', { name: '生成音频', exact: true }).click();
  await expect(speech.getByText('正在生成', { exact: true })).toBeVisible(); await until(() => holds.length === 1);
  const record = await page.evaluate(prefix => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith(prefix))[1]), storage), key = record.original.idempotency_key;
  await stack.restartGateway(); await login();
  const row = speech.getByRole('article', { name: `语音任务 ${key}`, exact: true });
  await expect(row.getByText('结果未知', { exact: true })).toBeVisible();
  await expect(speech.getByLabel('文本', { exact: true })).toBeDisabled(); assert.equal(calls.length, 1);
  let discardPosts = 0; page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/discard')) discardPosts++; });
  await row.getByRole('button', { name: '放弃输出', exact: true }).click(); await speech.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(discardPosts, 0);
  await row.getByRole('button', { name: '放弃输出', exact: true }).click();
  await speech.getByRole('button', { name: '确认放弃输出', exact: true }).click();
  await expect(row.getByText('已放弃输出', { exact: true })).toBeVisible(); assert.equal(discardPosts, 1);
  holds.shift()();
  const original = (await stack.request(base + '/speech-syntheses/by-key/' + key)).value;
  assert.equal(original.status, 'discarded'); assert.equal(original.media_id, null); assert.equal((await stack.request(base + '/media')).value.items.length, 0);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage + key); assert.equal(stored.discard_intents.length, 1); assert.deepEqual(stored.original, record.original);
  await expect(speech.getByLabel('文本', { exact: true })).toBeEnabled();
  await speech.getByLabel('文本', { exact: true }).fill('新任务必须明确提交'); assert.equal(calls.length, 1);
  let releaseResponse, delayedKey, finished;
  const responseFinished = new Promise(resolve => { finished = resolve; });
  await page.route('**' + base + '/speech-syntheses', async route => {
    try {
      const response = await route.fetch(); delayedKey = route.request().headers()['idempotency-key'];
      await new Promise(resolve => { releaseResponse = resolve; }); await route.fulfill({ response });
    } catch { /* 页面进入后台会中止本地读取，服务端原任务仍可查询。 */ }
    finally { finished(); }
  });
  await speech.getByRole('button', { name: '生成音频', exact: true }).click();
  await until(() => typeof releaseResponse === 'function');
  await page.evaluate(() => { window.__speechHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  releaseResponse(); await responseFinished;
  const delayedRow = speech.getByRole('article', { name: `语音任务 ${delayedKey}`, exact: true });
  await expect(delayedRow.getByText('结果待核实', { exact: true })).toBeVisible();
  await expect(delayedRow.getByText('生成完成', { exact: true })).toHaveCount(0);
  await page.unroute('**' + base + '/speech-syntheses');
  await page.evaluate(() => { window.__speechHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(speech.getByText('生成完成', { exact: true })).toBeVisible(); assert.equal(calls.length, 2);
  const report = { passed: true, browser: true, visibility_event_injected: true, background_and_offline_clear_text: true, background_late_response_ignored: true, foreground_get_original_only: true, restart_preserves_original_unknown: true, unknown_blocks_new_synthesis: true, explicit_discard: true, late_output_not_published: true, discarded_original_immutable: true, new_request_explicit: true, simulated_provider: true, real_http: true, real_sqlite: true, real_mqtt: true, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false };
  await writeFile(path.join(directory, 'speech-web-recovery-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'speech-web-recovery-result.json') }));
});

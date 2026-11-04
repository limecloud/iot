// 在完整备份恢复后的安装包验证两轮陪伴、准确历史及无上下文停止。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { verifyPcmWav } from '../packages/protocol/media.mjs';
import { instrumentNasRecording } from './nas-recording-journey.mjs';
import { until } from './dev-stack.mjs';

const base = '/api/v1/spaces/space-demo', storage = `limeiot.companion:${base}`;
const instructions = '你是本地搭建伙伴，用简短中文回答，不调用工具。';
const transcripts = ['我想搭一个会说话的积木小狗。', '怎样让小狗的底座更稳？'];
const answers = ['先搭一个稳固底座，再安装灯和扬声器。', '可以加宽底座，让两侧积木交错连接。'];

export async function nasCompanionJourney({ origin, owner, call, provider, compose, directory, recordingAudio }) {
  const report = { passed: false, provider_fixture: true, microphone_fixture: true, real_microphone: false, real_model_quality: false, hardware: false };
  const before = await provider(); assert.deepEqual(before.calls, []); assert.deepEqual(before.errors, []);
  const commands = (await call(base + '/commands')).value.items;
  const grantIDs = async () => (await call(base + '/media')).value.grants.map(item => item.grant_id).sort();
  const grantsBefore = await grantIDs();
  await provider('/fixture/scenario', { scenario: 'companion' });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${recordingAudio}`] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, permissions: ['microphone'], serviceWorkers: 'block' });
  page.setDefaultTimeout(15000); await page.addInitScript(instrumentNasRecording);
  const errors = [], posts = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, input: request.postDataJSON() }); });
  const inferencePosts = () => posts.filter(item => /\/(audio-transcriptions|text-generations|speech-syntheses)$/.test(item.path));
  let record;
  try {
    await page.goto(origin + '/?view=companion');
    await page.getByLabel('所有者凭据', { exact: true }).fill(owner);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
    const panel = page.getByRole('region', { name: '陪伴会话', exact: true });
    await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
    await panel.getByLabel('陪伴角色', { exact: true }).selectOption('custom');
    await panel.getByLabel('角色说明', { exact: true }).fill(instructions);
    await panel.getByRole('button', { name: '开始陪伴', exact: true }).click();
    await expect(panel.getByLabel('本轮录音', { exact: true })).toBeEnabled();
    assert.deepEqual((await provider()).calls, []); assert.equal(inferencePosts().length, 0);
    const upload = page.getByRole('region', { name: '上传音频', exact: true });
    const microphone = upload.getByRole('group', { name: '麦克风录音', exact: true });
    const sources = [];
    for (let turn = 0; turn < 2; turn++) {
      const uploadsBefore = posts.filter(item => item.input?.type === 'media.upload').length;
      await microphone.getByRole('button', { name: '开始录音', exact: true }).click();
      await expect(microphone.getByText(/正在录音 [1-9]/)).toBeVisible();
      await microphone.getByRole('button', { name: '完成录音', exact: true }).click();
      await expect(upload.getByText('recording.wav', { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__nasStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')) && window.__nasContexts.every(context => context.state === 'closed'))).toBe(true);
      assert.equal(posts.filter(item => item.input?.type === 'media.upload').length, uploadsBefore);
      assert.equal(inferencePosts().length, turn * 3);
      await upload.getByRole('button', { name: '上传音频', exact: true }).click();
      await expect(page.getByText('音频已上传', { exact: true })).toBeVisible();
      await expect(upload.getByRole('button', { name: '上传音频', exact: true })).toBeDisabled();
      await expect(upload.getByText('未选择文件', { exact: true })).toBeVisible();
      const uploads = posts.filter(item => item.input?.type === 'media.upload');
      assert.equal(uploads.length, uploadsBefore + 1);
      const bytes = Buffer.from(uploads.at(-1).input.content_base64, 'base64'), format = verifyPcmWav(bytes);
      assert.equal(format.sample_rate, 16000); assert.equal(format.channels, 1); assert.ok(format.frames > 0);
      const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      const source = (await call(base + '/media')).value.items.find(item => item.available && item.metadata.content_digest === digest);
      assert.ok(source); sources.push({ media_id: source.metadata.media_id, digest, bytes: bytes.length });
      assert.equal((await provider()).calls.length, turn * 3);
      await panel.getByLabel('本轮录音', { exact: true }).selectOption(source.metadata.media_id);
      await panel.getByRole('button', { name: '发送本轮录音', exact: true }).click();
      await expect(panel.getByText('本轮回复已生成', { exact: true })).toBeVisible();
      await expect(panel.getByLabel('本次陪伴记录', { exact: true }).locator('span')).toHaveText(transcripts.slice(0, turn + 1).flatMap((text, index) => [text, answers[index]]));
      assert.equal(inferencePosts().length, (turn + 1) * 3);
    }
    record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storage);
    assert.equal(record.turns.length, 2); assert.equal(record.history.message_count, 4);
    const generated = await provider(); assert.deepEqual(generated.errors, []);
    assert.deepEqual(generated.calls.map(item => item.kind), ['asr', 'text', 'speech', 'asr', 'text', 'speech']);
    for (let turn = 0; turn < 2; turn++) {
      assert.equal('sha256:' + generated.calls[turn * 3].digest, sources[turn].digest);
      assert.equal(generated.calls[turn * 3].bytes, sources[turn].bytes);
      assert.equal(generated.calls[turn * 3 + 1].message_count, turn * 2 + 1);
    }
    const saved = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const text of [instructions, ...transcripts, ...answers, ...posts.filter(item => item.input?.type === 'media.upload').map(item => item.input.content_base64)]) assert.equal(saved.includes(text), false);
    assert.deepEqual(await grantIDs(), grantsBefore);
    assert.deepEqual((await call(base + '/commands')).value.items, commands);
    assert.deepEqual(generated.effects, before.effects); assert.deepEqual(generated.pulls, before.pulls);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(directory, 'nas-companion-mobile.png'), fullPage: true });
    await page.reload();
    await expect(panel.getByText('会话上下文已清除，请结束后重新开始', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('本次陪伴记录', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '发送本轮录音', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '查询原会话', exact: true }).click();
    await expect(panel.getByLabel('当前文字回复', { exact: true })).toHaveText(answers[1]);
    assert.equal(inferencePosts().length, 6); assert.deepEqual((await provider()).calls, generated.calls);
    await panel.getByRole('button', { name: '结束并清除回答', exact: true }).click();
    await expect(panel.getByText('会话已结束', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '开始陪伴', exact: true })).toBeEnabled();
    await expect(panel.getByLabel('当前文字回复', { exact: true })).toHaveCount(0);
    for (const slot of record.turns) assert.equal((await call(base + '/text-generations/by-key/' + slot.record.jobs.text.original.idempotency_key)).value.output.text, null);
    await compose(['restart', 'gateway']);
    await until(async () => (await call('/healthz', { authenticated: false })).value.broker_connected, 15000);
    await page.reload(); await page.getByLabel('所有者凭据', { exact: true }).fill(owner);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
    await expect(panel.getByText('会话已结束', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '查询原会话', exact: true }).click();
    await expect(panel.getByText('会话已结束', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('当前文字回复', { exact: true })).toHaveCount(0);
    for (const slot of record.turns) {
      const restored = await page.evaluate(async resource => {
        const response = await fetch(resource); return { status: response.status, value: await response.json() };
      }, base + '/text-generations/by-key/' + slot.record.jobs.text.original.idempotency_key);
      assert.equal(restored.status, 200); assert.equal(restored.value.output.text, null); assert.ok(restored.value.output.cleared_at);
    }
    const after = await provider(); assert.deepEqual(after.calls, generated.calls); assert.deepEqual(after.errors, []);
    assert.deepEqual(after.effects, before.effects); assert.deepEqual(after.pulls, before.pulls); assert.equal(inferencePosts().length, 6);
    assert.deepEqual(await page.evaluate(() => window.__nasCsp), []); assert.deepEqual(errors, []);
    Object.assign(report, { passed: true, completed_after_full_install_restore: true, https_packaged_worklet: true, turns: 2, inference_posts: 6, role_and_exact_history: true, sources, media_tracks_ended: true, audio_context_closed: true, no_pre_upload_inference: true, summary_only_storage: true, reload_and_query_zero_inference: true, context_free_stop_clears_both_answers: true, cleared_answers_survive_gateway_restart: true, no_new_grants_commands_or_play: true, horizontal_overflow: false, csp_violations: 0 });
    return report;
  } catch (error) {
    report.error = error.message; report.provider_state = await provider().catch(() => null); report.page_errors = errors;
    report.post_operations = posts.map(item => ({ path: item.path, type: item.input?.type }));
    await page.screenshot({ path: path.join(directory, 'nas-companion-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await writeFile(path.join(directory, 'companion-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await browser.close();
  }
}

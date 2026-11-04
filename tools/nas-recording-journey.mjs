// 从恢复后的HTTPS安装包实际采集模拟音频，贯通三阶段与独立授权播放。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { verifyPcmWav } from '../packages/protocol/media.mjs';
import { until } from './dev-stack.mjs';

const base = '/api/v1/spaces/space-demo';
const transcript = '这是容器协议夹具的识别结果。', answer = '这是容器协议夹具的文字回答。';
export function instrumentNasRecording() {
  window.__nasStreams = []; window.__nasContexts = []; window.__nasCsp = [];
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); window.__nasStreams.push(stream); return stream; };
  const Context = window.AudioContext;
  window.AudioContext = class extends Context { constructor(options) { super(options); window.__nasContexts.push(this); } };
  document.addEventListener('securitypolicyviolation', event => window.__nasCsp.push(event.violatedDirective));
}

export async function nasRecordingVoiceJourney({ origin, owner, call, provider, directory, recordingAudio }) {
  const report = { passed: false, microphone_fixture: true, real_microphone: false, provider_fixture: true, renderer_fixture: true, real_model_quality: false, hardware: false };
  const before = await provider(); assert.deepEqual(before.calls, []); assert.deepEqual(before.errors, []);
  const commandCount = (await call(base + '/commands')).value.items.length;
  const grantIDs = () => call(base + '/media').then(result => result.value.grants.map(item => item.grant_id).sort());
  const originalGrants = await grantIDs();
  await provider('/fixture/scenario', { scenario: 'recorded_voice_turn' });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${recordingAudio}`] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, permissions: ['microphone'], serviceWorkers: 'block' });
  page.setDefaultTimeout(15000); await page.addInitScript(instrumentNasRecording);
  const errors = [], posts = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin + '/?view=media');
    await page.getByLabel('所有者凭据', { exact: true }).fill(owner);
    await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
    page.on('request', request => { if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, input: request.postDataJSON() }); });
    const upload = page.getByRole('region', { name: '上传音频', exact: true });
    const microphone = upload.getByRole('group', { name: '麦克风录音', exact: true });
    await microphone.getByRole('button', { name: '开始录音', exact: true }).click();
    await expect(microphone.getByText(/正在录音 [1-9]/)).toBeVisible();
    await microphone.getByRole('button', { name: '完成录音', exact: true }).click();
    await expect(upload.getByText('recording.wav', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__nasStreams.length === 1 && window.__nasStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')) && window.__nasContexts.length === 1 && window.__nasContexts.every(context => context.state === 'closed'))).toBe(true);
    assert.deepEqual(posts, []); assert.deepEqual((await provider()).calls, []);
    await upload.getByRole('button', { name: '上传音频', exact: true }).click(); await expect(page.getByText('音频已上传', { exact: true })).toBeVisible();
    assert.equal(posts.length, 1); assert.equal(posts[0].input.type, 'media.upload');
    const bytes = Buffer.from(posts[0].input.content_base64, 'base64'), format = verifyPcmWav(bytes);
    assert.equal(format.sample_rate, 16000); assert.equal(format.channels, 1); assert.ok(format.frames > 0);
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const source = (await call(base + '/media')).value.items.find(item => item.available && item.metadata.content_digest === digest);
    assert.ok(source); assert.deepEqual((await provider()).calls, []);
    const voice = page.getByRole('region', { name: '语音对话', exact: true });
    await voice.getByLabel('对话录音', { exact: true }).selectOption(source.metadata.media_id);
    await voice.getByRole('button', { name: '生成语音回答', exact: true }).click();
    await expect(voice.getByText('语音回答已生成', { exact: true })).toBeVisible();
    await expect(voice.getByLabel('本轮识别文本', { exact: true })).toHaveText(transcript);
    await expect(voice.getByLabel('本轮文字回答', { exact: true })).toHaveText(answer);
    const generated = await provider(); assert.deepEqual(generated.calls.map(item => item.kind), ['asr', 'text', 'speech']);
    assert.equal('sha256:' + generated.calls[0].digest, digest); assert.equal(generated.calls[0].bytes, bytes.length);
    assert.deepEqual(generated.effects, before.effects); assert.deepEqual(generated.pulls, before.pulls); assert.deepEqual(generated.errors, []);
    assert.equal((await call(base + '/commands')).value.items.length, commandCount);
    assert.deepEqual(await grantIDs(), originalGrants);
    const storageKey = 'limeiot.voice-turn:' + base;
    const saved = await page.evaluate(key => localStorage.getItem(key), storageKey), record = JSON.parse(saved);
    for (const raw of [transcript, answer, posts[0].input.content_base64]) assert.equal(saved.includes(raw), false);
    assert.equal(record.source.content_digest, digest);
    const media = record.jobs.speech.observation.media_id;
    const grants = page.getByRole('region', { name: '播放授权', exact: true });
    await expect(grants.getByLabel('音频', { exact: true })).toHaveValue(media);
    await expect(grants.getByLabel('允许所选音箱读取此音频', { exact: true })).not.toBeChecked();
    await page.reload(); await expect(voice.getByText('语音回答已生成', { exact: true })).toBeVisible();
    await expect(voice.getByLabel('本轮文字回答', { exact: true })).toHaveCount(0);
    await voice.getByRole('button', { name: '查询原回合', exact: true }).click();
    await expect(voice.getByLabel('本轮文字回答', { exact: true })).toHaveText(answer);
    assert.deepEqual((await provider()).calls, generated.calls);
    const inferencePosts = () => posts.filter(item => /\/(audio-transcriptions|text-generations|speech-syntheses)$/.test(item.path));
    assert.equal(inferencePosts().length, 3);
    await grants.getByLabel('音频', { exact: true }).selectOption(media);
    await grants.getByLabel('授权音箱', { exact: true }).selectOption('device-speaker');
    await grants.getByLabel('允许所选音箱读取此音频', { exact: true }).check();
    await grants.getByRole('button', { name: '创建播放授权', exact: true }).click();
    await expect(page.getByText('播放授权已创建', { exact: true })).toBeVisible();
    assert.deepEqual((await provider()).effects, before.effects);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(directory, 'nas-recording-voice-mobile.png'), fullPage: true });
    await page.goto(origin + '/?view=devices');
    const speaker = page.getByRole('article', { name: '音箱', exact: true });
    await speaker.getByRole('button', { name: '读取接入信息', exact: true }).click();
    await speaker.getByLabel('获准音频', { exact: true }).selectOption(media);
    await speaker.getByRole('button', { name: '播放音频', exact: true }).click();
    await expect(speaker.getByText('最近操作：输入已提交', { exact: true })).toBeVisible();
    const played = await until(async () => { const value = await provider(); return value.pulls.length === before.pulls.length + 1 && value; });
    assert.deepEqual(played.calls, generated.calls); assert.deepEqual(played.errors, []);
    assert.deepEqual(played.effects.slice(before.effects.length), ['SetVolume', 'SetAVTransportURI', 'Play']);
    assert.equal((await call(base + '/commands')).value.items.length, commandCount + 1);
    assert.equal(inferencePosts().length, 3); assert.deepEqual(await page.evaluate(() => window.__nasCsp), []); assert.deepEqual(errors, []);
    Object.assign(report, { passed: true, https_packaged_worklet: true, completed_after_full_install_restore: true, media_tracks_ended: true, audio_context_closed: true, no_pre_upload_posts: true, format, source_media_id: source.metadata.media_id, source_digest: digest, source_bytes: bytes.length, stages: generated.calls.map(item => item.kind), reload_and_query_zero_inference: true, inference_posts: inferencePosts().length, no_implicit_grant_or_play: true, separate_explicit_grant_and_play: true, new_range_pull: played.pulls.at(-1), no_audio_or_text_in_turn_storage: true, horizontal_overflow: false, csp_violations: 0 });
    return report;
  } catch (error) {
    report.error = error.message; report.provider_state = await provider().catch(() => null);
    report.post_operations = posts.map(item => ({ path: item.path, type: item.input?.type })); report.page_errors = errors;
    await page.screenshot({ path: path.join(directory, 'nas-recording-voice-failure.png'), fullPage: true }).catch(() => {}); throw error;
  } finally {
    await writeFile(path.join(directory, 'recording-voice-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await browser.close();
  }
}

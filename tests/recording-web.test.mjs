import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, cp, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { voiceStack, base, answer } from './helpers/voice-turns.mjs';
import { verifyPcmWav } from '../packages/protocol/media.mjs';
import { root } from '../tools/dev-stack.mjs';

async function setup(t, { permission = 'granted', missingModule = false } = {}) {
  if (missingModule) console.log('recording failure fixture: copying shell');
  const homeDirectory = missingModule ? await mkdtemp(path.join(root, '.dev/recording-home-')) : undefined;
  if (homeDirectory) await cp(path.join(root, 'apps/home/dist'), homeDirectory, { recursive: true, filter: source => !path.basename(source).startsWith('pcm-capture-worklet-') });
  if (missingModule) console.log('recording failure fixture: starting stack');
  const state = await voiceStack(t, { recordedSource: true, homeDirectory });
  if (missingModule) console.log('recording failure fixture: starting browser');
  const wav = Buffer.alloc(44 + 16000 * 4 * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 16000 * 4; i++) wav.writeInt16LE(Math.round(Math.sin(i / 16000 * Math.PI * 2 * 440) * 14000), 44 + i * 2);
  const file = path.join(state.directory, 'fake-microphone.wav'); await writeFile(file, wav);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`] }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: permission === 'granted' ? ['microphone'] : [] });
  await context.addInitScript(() => {
    window.__captureStreams = []; window.__captureContexts = []; window.__captureRequests = []; window.__captureFailures = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { window.__captureRequests.push(constraints); try { const stream = await capture(constraints); window.__captureStreams.push(stream); return stream; } catch (error) { window.__captureFailures.push({ stage: 'permission', name: error.name, message: error.message }); throw error; } };
    const Context = window.AudioContext; window.AudioContext = class extends Context { constructor(options) { super(options); window.__captureContexts.push(this); } };
    const module = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function (...args) { try { return await module.apply(this, args); } catch (error) { window.__captureFailures.push({ stage: 'module', name: error.name, message: error.message }); throw error; } };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); const errors = [], violations = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.__cspViolations = []; document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI })); });
  await page.goto(state.stack.env.LIMEIOT_ENDPOINT + '/?view=media'); await page.getByLabel('所有者凭据', { exact: true }).fill(state.stack.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const upload = page.getByRole('region', { name: '上传音频', exact: true }), mic = upload.getByRole('group', { name: '麦克风录音', exact: true });
  await expect(mic.getByRole('button', { name: '开始录音', exact: true })).toBeEnabled();
  if (missingModule) console.log('recording failure fixture: ready');
  const posts = []; page.on('request', req => { if (req.method() === 'POST') posts.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() }); });
  async function start() { await mic.getByRole('button', { name: '开始录音', exact: true }).click(); try { await expect(mic.getByRole('button', { name: '完成录音', exact: true })).toBeVisible(); await expect(mic.getByText(/正在录音 [1-9]/)).toBeVisible(); } catch (error) { console.log(JSON.stringify({ capture_diagnostics: await page.evaluate(() => ({ failures: window.__captureFailures, csp: window.__cspViolations, requests: window.__captureRequests?.length, tracks: window.__captureStreams?.flatMap(stream => stream.getTracks().map(track => track.readyState)), contexts: window.__captureContexts?.map(context => ({ state: context.state, sampleRate: context.sampleRate })) })) })); throw error; } }
  async function ended() {
    await expect.poll(() => page.evaluate(() => window.__captureStreams.flatMap(stream => stream.getTracks().map(track => track.readyState)))).not.toContain('live');
    await expect.poll(() => page.evaluate(() => window.__captureContexts.every(context => context.state === 'closed'))).toBe(true);
  }
  return { ...state, browser, context, page, upload, mic, posts, pageErrors: errors, violations, start, ended };
}

test('真实浏览器AudioWorklet采音至语音回答：严格CSP、PCM入库、三阶段及单独播放', { timeout: 150000 }, async t => {
  const state = await setup(t), { page, mic, upload, stack } = state; await state.bindSpeaker();
  assert.equal((await page.evaluate(() => window.__captureRequests)).length, 0);
  await state.start(); assert.equal(state.posts.length, 0); await mic.getByRole('button', { name: '完成录音', exact: true }).click();
  await expect(upload.getByText('recording.wav', { exact: true })).toBeVisible(); await state.ended(); assert.equal(state.posts.length, 0);
  await upload.getByRole('button', { name: '上传音频', exact: true }).click(); await expect(page.getByText('音频已上传', { exact: true })).toBeVisible();
  const posted = state.posts.find(value => value.path === base + '/media-operations' && value.body.type === 'media.upload'), bytes = Buffer.from(posted.body.content_base64, 'base64'), format = verifyPcmWav(bytes);
  assert.equal(format.sample_rate, 16000); assert.equal(format.channels, 1); assert.ok(format.frames >= 16000 && format.frames <= 960000); assert.ok(bytes.subarray(44).some(value => value !== 0));
  const media = (await stack.request(base + '/media')).value.items.find(item => item.metadata.audio.sample_rate === 16000).metadata;
  const voice = page.getByRole('region', { name: '语音对话', exact: true }); await voice.getByLabel('对话录音', { exact: true }).selectOption(media.media_id); await voice.getByRole('button', { name: '生成语音回答', exact: true }).click();
  await expect(voice.getByText('语音回答已生成', { exact: true })).toBeVisible(); await expect(voice.getByLabel('本轮文字回答', { exact: true })).toHaveText(answer);
  assert.deepEqual(state.calls, ['transcription', 'text', 'speech']); assert.equal(state.recordings[0].frames, format.frames); assert.equal(state.fixture.effects.length, 0);
  const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), `limeiot.voice-turn:${base}`); const mediaID = record.jobs.speech.observation.media_id;
  const grants = page.getByRole('region', { name: '播放授权', exact: true }); await expect(grants.getByLabel('音频', { exact: true })).toHaveValue(mediaID); await expect(grants.getByLabel('允许所选音箱读取此音频', { exact: true })).not.toBeChecked();
  await grants.getByLabel('授权音箱', { exact: true }).selectOption('device-lamp'); await grants.getByLabel('允许所选音箱读取此音频', { exact: true }).check(); await grants.getByRole('button', { name: '创建播放授权', exact: true }).click(); await expect(page.getByText('播放授权已创建', { exact: true })).toBeVisible();
  assert.equal(state.fixture.effects.length, 0); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(state.directory, 'recording-mobile.png'), fullPage: true });
  const csp = await page.evaluate(() => window.__cspViolations); assert.deepEqual(csp, []);
  const local = await page.evaluate(() => Object.values(localStorage).join('')); assert.equal(local.includes(posted.body.content_base64), false);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=devices'); const speaker = page.getByRole('article', { name: '音箱', exact: true }); await speaker.getByRole('button', { name: '读取接入信息', exact: true }).click(); await speaker.getByLabel('获准音频', { exact: true }).selectOption(mediaID); await speaker.getByRole('button', { name: '播放音频', exact: true }).click(); await expect(speaker.getByText('最近操作：输入已提交', { exact: true })).toBeVisible(); assert.equal(state.fixture.effects.length, 3); assert.equal(state.fixture.renderedPulls.length, 1);
  assert.deepEqual(state.pageErrors, []); assert.deepEqual(state.errors, []);
  await writeFile(path.join(state.directory, 'recording-web.json'), JSON.stringify({ passed: true, browser_audio_worklet: true, microphone_fixture: true, real_microphone: false, real_gateway: true, provider_fixture: true, renderer_fixture: true, format, captures: 1, no_pre_upload_posts: true, media_tracks_ended: true, audio_context_closed: true, csp_violations: csp, recorded_bytes_match_asr: state.recordings[0], stages: state.calls, separate_explicit_grant_and_play: true, local_storage_excludes_audio: true, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(state.directory, 'recording-web.json'), screenshot: path.join(state.directory, 'recording-mobile.png') }));
});

test('录音生命周期：后台、离页、离线、设备中断及迟到授权均停止采音且零上传', { timeout: 150000 }, async t => {
  const state = await setup(t), { page, mic, upload } = state;
  const hide = () => page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const show = () => page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await state.start(); await hide(); await state.ended(); await expect(mic.getByRole('button', { name: '开始录音', exact: true })).toBeVisible(); await expect(upload.getByRole('button', { name: '上传音频', exact: true })).toBeDisabled(); await show();
  await state.start(); await mic.getByRole('button', { name: '完成录音', exact: true }).click(); await expect(upload.getByText('recording.wav', { exact: true })).toBeVisible(); await hide(); await expect(upload.getByText('recording.wav', { exact: true })).toHaveCount(0); await show();
  await state.start(); await mic.getByRole('button', { name: '完成录音', exact: true }).click(); await expect(upload.getByText('recording.wav', { exact: true })).toBeVisible();
  await page.evaluate(() => { const read = File.prototype.arrayBuffer; File.prototype.arrayBuffer = async function () { const bytes = await read.call(this); if (this.name === 'recording.wav') await new Promise(resolve => { window.__releaseRecordingRead = resolve; }); return bytes; }; });
  await upload.getByRole('button', { name: '上传音频', exact: true }).click(); await expect.poll(() => page.evaluate(() => typeof window.__releaseRecordingRead)).toBe('function'); await hide(); await page.evaluate(() => window.__releaseRecordingRead()); await expect(page.getByText('本机录音已清除，请重新录制', { exact: true })).toBeVisible(); await expect(upload.getByText('recording.wav', { exact: true })).toHaveCount(0); assert.equal(state.posts.length, 0); await show();
  await state.start(); await page.evaluate(() => window.__captureStreams.at(-1).getAudioTracks()[0].dispatchEvent(new Event('ended'))); await expect(mic.getByText('录音已中断，请重新开始', { exact: true })).toBeVisible(); await state.ended();
  await state.start(); await state.context.setOffline(true); await expect(page.getByText('连接中断', { exact: true })).toBeVisible(); await state.ended(); await state.context.setOffline(false); await page.reload(); await expect(mic.getByRole('button', { name: '开始录音', exact: true })).toBeEnabled();
  await state.start(); await page.getByRole('button', { name: '家庭导航', exact: true }).click(); await page.getByRole('navigation', { name: '家庭导航', exact: true }).getByRole('button', { name: '设备', exact: true }).click(); await expect(mic).toHaveCount(0); await state.ended(); await page.getByRole('button', { name: '家庭导航', exact: true }).click(); await page.getByRole('navigation', { name: '家庭导航', exact: true }).getByRole('button', { name: '音频', exact: true }).click(); await expect(mic.getByRole('button', { name: '开始录音', exact: true })).toBeEnabled();
  await state.start(); await page.goto(state.stack.env.LIMEIOT_ENDPOINT + '/?view=devices'); assert.equal(state.posts.length, 0); await page.goto(state.stack.env.LIMEIOT_ENDPOINT + '/?view=media'); await expect(mic.getByRole('button', { name: '开始录音', exact: true })).toBeEnabled();
  await page.evaluate(() => { const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async constraints => { const stream = await original(constraints); await new Promise(resolve => { window.__releasePermission = resolve; }); return stream; }; });
  await mic.getByRole('button', { name: '开始录音', exact: true }).click(); await expect(mic.getByText('等待麦克风授权', { exact: true })).toBeVisible(); await expect.poll(() => page.evaluate(() => typeof window.__releasePermission)).toBe('function'); await mic.getByRole('button', { name: '取消录音', exact: true }).click(); await page.evaluate(() => window.__releasePermission()); await state.ended();
  await expect(upload.getByRole('button', { name: '上传音频', exact: true })).toBeDisabled(); assert.equal(state.posts.length, 0); assert.deepEqual(state.pageErrors, []);
  await writeFile(path.join(state.directory, 'recording-lifecycle.json'), JSON.stringify({ passed: true, browser_audio_worklet: true, microphone_fixture: true, background_cancels_and_clears: true, saved_unuploaded_audio_cleared_in_background: true, background_during_file_read_zero_post: true, offline_stops_tracks: true, navigation_stops: true, spa_unmount_stops_tracks: true, device_end_stops: true, cancelled_permission_late_stream_stopped: true, upload_posts: 0, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(state.directory, 'recording-lifecycle.json') }));
});

test('麦克风拒绝权限和工作模块加载失败：无上传并关闭已取得的设备', { timeout: 90000 }, async t => {
  const state = await setup(t, { permission: 'denied', missingModule: true });
  await state.mic.getByRole('button', { name: '开始录音', exact: true }).click(); await expect(state.mic.getByText('未获得麦克风权限，可在浏览器设置中允许', { exact: true })).toBeVisible(); assert.equal(state.posts.length, 0);
  console.log('recording failure fixture: permission denied');
  const failedModules = []; state.page.on('response', response => { if (new URL(response.url()).pathname.includes('/pcm-capture-worklet-')) failedModules.push(response.status()); });
  await state.context.grantPermissions(['microphone']);
  console.log('recording failure fixture: permission granted');
  await state.mic.getByRole('button', { name: '开始录音', exact: true }).click(); await expect(state.mic.getByText('未能保存录音，请重新开始', { exact: true })).toBeVisible(); await state.ended(); assert.equal(state.posts.length, 0); assert.equal(state.calls.length, 0); assert.deepEqual(state.pageErrors, []);
  console.log('recording failure fixture: module failed and released');
  const failures = await state.page.evaluate(() => window.__captureFailures); assert.equal(failures.some(value => value.stage === 'permission' && value.name === 'NotAllowedError'), true); assert.equal(failures.some(value => value.stage === 'module'), true);
  assert.equal((await state.page.evaluate(() => window.__captureStreams)).length, 1);
  await writeFile(path.join(state.directory, 'recording-failures.json'), JSON.stringify({ passed: true, microphone_fixture: true, permission_denied: true, actual_module_missing: true, module_failure_stops_tracks_and_context: true, upload_posts: 0, provider_calls: 0, observed_module_responses: failedModules, failures, hardware: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(state.directory, 'recording-failures.json') }));
});

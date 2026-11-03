import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, freePort, until, stop } from '../tools/dev-stack.mjs';
import { mediaStack } from './helpers/media.mjs';
import { verifyPcmWav } from '../packages/protocol/media.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const post = (value, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) });

test('真实本地中文TTS：网页生成、同字节入库与授权播放、CLI原查询及丢响应不重合成', { timeout: 150000 }, async t => {
  const python = process.env.LIMEIOT_SPEECH_PYTHON, models = process.env.LIMEIOT_SPEECH_MODEL_DIRECTORY;
  assert.ok(python && path.isAbsolute(python), 'LIMEIOT_SPEECH_PYTHON must explicitly select a private Python environment');
  assert.ok(models && path.isAbsolute(models), 'LIMEIOT_SPEECH_MODEL_DIRECTORY must explicitly select external local model files');
  const directory = await mkdtemp(path.join(root, '.dev/sherpa-live-')), config = path.join(directory, 'provider.json'), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  await copyFile(path.join(root, 'providers/sherpa-tts/aishell3.example.json'), config);
  const child = spawn(python, ['-I', 'providers/sherpa-tts/server.py', '--config', config, '--model-directory', models, '--port', String(port)], { cwd: root, env: { OPENBLAS_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(directory, 'provider.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  t.after(async () => { await stop(child); await new Promise(resolve => log.end(resolve)); });
  const health = async () => (await fetch(origin + '/healthz', { signal: AbortSignal.timeout(2000) })).json();
  await until(async () => { assert.equal(child.exitCode, null); return (await health()).ready; }, 15000);
  const input = text => ({ model: 'vits-icefall-zh-aishell3', input: text, voice: 'mandarin', response_format: 'wav', speed: 1 });
  assert.equal((await fetch(origin + '/v1/audio/speech', post({ ...input('你好'), voice: 'missing' }, 'direct-invalid'))).status, 422);
  // 直接并发检查是真实引擎；健康读取证明首请求已持有计算槽位。
  const first = fetch(origin + '/v1/audio/speech', post(input('请记得休息一下，喝点水。'), 'direct-first'));
  await until(async () => (await health()).busy);
  assert.equal((await fetch(origin + '/v1/audio/speech', post(input('不会排队'), 'direct-busy'))).status, 429);
  const firstResponse = await first; assert.equal(firstResponse.status, 200); verifyPcmWav(new Uint8Array(await firstResponse.arrayBuffer()));
  await until(async () => !(await health()).busy);
  const limited = await fetch(origin + '/v1/audio/speech', post(input('请记得喝水，'.repeat(150)), 'direct-audio-limit'));
  assert.equal(limited.status, 422); assert.equal((await limited.json()).error.code, 'audio_limit');
  let calls = 0, output, lose = false;
  const proxy = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      calls++;
      const response = await fetch(origin + req.url, { method: req.method, headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(85000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status === 200) output = bytes;
      if (lose) { req.socket.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') }); res.end(bytes);
    } catch { req.socket.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const { stack, fixture, bindSpeaker } = await mediaStack(t, 'sherpa-live-', { directory, gatewayEnv: {
    LIMEIOT_TTS_URL: `http://127.0.0.1:${proxy.address().port}`, LIMEIOT_TTS_MODEL: 'vits-icefall-zh-aishell3', LIMEIOT_TTS_VOICES: 'mandarin', LIMEIOT_TTS_CA_FILE: '',
  } });
  await bindSpeaker();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); page.setDefaultTimeout(15000);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=media');
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const speech = page.getByRole('region', { name: '文字转语音', exact: true }), text = '你好，这是青柠物联。请记得喝水。';
  await expect(speech.getByLabel('文本', { exact: true })).toBeEnabled();
  await speech.getByLabel('文本', { exact: true }).fill(text);
  await speech.getByRole('button', { name: '生成音频', exact: true }).click();
  await expect(speech.getByText('生成完成', { exact: true })).toBeVisible();
  const record = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith('limeiot.speech:'))[1]));
  const completed = (await stack.request(base + '/speech-syntheses/by-key/' + record.original.idempotency_key)).value;
  assert.equal(completed.status, 'succeeded'); assert.equal(calls, 1);
  const format = verifyPcmWav(output), generatedBytes = output.length; assert.equal(format.sample_rate, 8000);
  let peak = 0; for (let i = 44; i < output.length; i += 2) peak = Math.max(peak, Math.abs(output.readInt16LE(i)));
  assert.ok(peak > 100, 'real speech output must be non-silent');
  const diskText = await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'), disk = JSON.parse(diskText);
  assert.deepEqual(Buffer.from(disk.objects[completed.media_id].content_base64, 'base64'), output);
  assert.equal(diskText.includes(text), false); assert.equal(JSON.stringify(record).includes(text), false);
  fixture.setExpectedMedia(output);
  const media = (await stack.request(base + '/media')).value; assert.equal(media.grants.length, 0); assert.equal(fixture.effects.length, 0);
  const grants = page.getByRole('region', { name: '播放授权', exact: true });
  await expect(grants.getByLabel('音频', { exact: true })).toHaveValue(completed.media_id);
  await expect(grants.getByLabel('允许所选音箱读取此音频', { exact: true })).not.toBeChecked();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(directory, 'real-speech-mobile.png'), fullPage: true });
  await grants.getByLabel('授权音箱', { exact: true }).selectOption('device-lamp');
  await grants.getByLabel('允许所选音箱读取此音频', { exact: true }).check();
  await grants.getByRole('button', { name: '创建播放授权', exact: true }).click();
  await expect(page.getByText('播放授权已创建', { exact: true })).toBeVisible(); assert.equal(fixture.effects.length, 0);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=devices');
  const speaker = page.getByRole('article', { name: '音箱', exact: true });
  await speaker.getByRole('button', { name: '读取接入信息', exact: true }).click();
  await speaker.getByLabel('获准音频', { exact: true }).selectOption(completed.media_id);
  await speaker.getByRole('button', { name: '播放音频', exact: true }).click();
  await expect(speaker.getByText('最近操作：输入已提交', { exact: true })).toBeVisible();
  assert.equal(fixture.effects.length, 3); assert.equal(fixture.renderedPulls.length, 1);
  const cli = async key => JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'speech-syntheses', 'resolve', key, '--space-id', 'space-demo', '--state-dir', path.join(directory, 'cli')], { cwd: root, env: stack.env, timeout: 10000 })).stdout);
  assert.equal((await cli(record.original.idempotency_key)).synthesis_id, completed.synthesis_id);
  await stack.restartGateway(); assert.equal((await cli(record.original.idempotency_key)).synthesis_id, completed.synthesis_id); assert.equal(calls, 1);
  // 真实引擎已完成，但网关丢失HTTP响应：只保留unknown，不能重新发送文本。
  lose = true;
  const lostInput = { text: '这条响应将被测试链路中断。', voice: 'mandarin', retain_seconds: 600, expires_at: new Date(Date.now() + 60000).toISOString() };
  assert.equal((await stack.request(base + '/speech-syntheses', post(lostInput, 'lost-real-response'))).status, 202);
  await until(async () => (await stack.request(base + '/speech-syntheses/by-key/lost-real-response')).value.status === 'unknown');
  assert.equal(calls, 2); lose = false;
  assert.equal((await stack.request(base + '/speech-syntheses', post({ ...lostInput, text: '不能绕过未知预算' }, 'blocked-real-request'))).status, 429);
  await stack.restartGateway(); assert.equal((await stack.request(base + '/speech-syntheses/by-key/lost-real-response')).value.status, 'unknown'); assert.equal(calls, 2);
  assert.equal((await stack.request(base + '/speech-syntheses/by-key/lost-real-response/discard', post({}, 'discard-real'))).value.status, 'discarded');
  assert.equal((await stack.request(base + '/media')).value.items.length, 1);
  assert.equal(fixture.effects.length, 3); assert.equal(fixture.renderedPulls.length, 1);
  assert.equal((await readFile(path.join(directory, 'provider.log'), 'utf8')).includes(text), false);
  const report = { passed: true, real_engine: 'sherpa-onnx-2.0.1', real_model: 'vits-icefall-zh-aishell3', direct_concurrent_rejected: true, real_audio_limit_rejected: true, browser: true, viewport: 390, real_http: true, real_sqlite: true, real_mqtt: true, real_audio_byte_exact_store_and_pull: true, generated_bytes: generatedBytes, format, non_silent: true, separate_explicit_authorization_and_play: true, cli_original_get_only: true, restart_no_resynthesis: true, lost_real_provider_response_unknown: true, unknown_budget_retained: true, explicit_discard: true, gateway_provider_requests: calls, soap_mutations: 3, media_range_pulls: 1, simulated_renderer: true, weights_license: 'not_confirmed', human_listening: false, hardware: false, hardware_status: '用户要求跳过', nas_image_rebuilt: false, published: false, full_goal_completed: false };
  await writeFile(path.join(directory, 'sherpa-live-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'sherpa-live-result.json') }));
});

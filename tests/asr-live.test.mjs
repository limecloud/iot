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
import { base, post, input } from './helpers/transcription.mjs';
const exec = promisify(execFile);

test('真实本地ASR：不同录音、390px网页、CLI、重启未知零重放及源删除清文', { timeout: 240000 }, async t => {
  const python = process.env.LIMEIOT_ASR_PYTHON, models = process.env.LIMEIOT_ASR_MODEL_DIRECTORY, manifest = process.env.LIMEIOT_ASR_SAMPLES;
  for (const [name, value] of Object.entries({ LIMEIOT_ASR_PYTHON: python, LIMEIOT_ASR_MODEL_DIRECTORY: models, LIMEIOT_ASR_SAMPLES: manifest })) assert.ok(value && path.isAbsolute(value), `${name} must explicitly select an external absolute path`);
  const samples = JSON.parse(await readFile(manifest, 'utf8'));
  assert.ok(Array.isArray(samples) && samples.length >= 2);
  for (const sample of samples) { assert.ok(path.isAbsolute(sample.file)); assert.ok(['auto', 'zh', 'en'].includes(sample.language)); assert.ok(Array.isArray(sample.expected_patterns) && sample.expected_patterns.length > 0); }
  const directory = await mkdtemp(path.join(root, '.dev/asr-live-')), config = path.join(directory, 'provider.json'), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  await copyFile(process.env.LIMEIOT_ASR_CONFIG ?? path.join(root, 'providers/sherpa-asr/paraformer-small.example.json'), config);
  const modelID = JSON.parse(await readFile(config, 'utf8')).model_id;
  const child = spawn(python, ['-I', 'providers/sherpa-asr/server.py', '--config', config, '--model-directory', models, '--port', String(port)], { cwd: root, env: { OPENBLAS_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(directory, 'provider.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  t.after(async () => { await stop(child); await new Promise(resolve => log.end(resolve)); });
  const health = async () => (await fetch(origin + '/healthz', { signal: AbortSignal.timeout(2000) })).json();
  await until(async () => { assert.equal(child.exitCode, null); return (await health()).ready; }, 20000);
  const audio = await Promise.all(samples.slice(0, 2).map(sample => readFile(sample.file))), outputs = [], timings = [];
  const checkText = (text, sample) => { assert.equal(typeof text, 'string'); for (const pattern of sample.expected_patterns) assert.match(text, new RegExp(pattern, 'u')); };
  const recognize = (bytes, language) => fetch(origin + '/v1/audio/transcriptions', { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Limeiot-Model': modelID, 'X-Limeiot-Language': language }, body: bytes, signal: AbortSignal.timeout(85000) });
  for (let i = 0; i < 2; i++) {
    const format = verifyPcmWav(audio[i]), start = performance.now(), request = recognize(audio[i], samples[i].language);
    if (i === 0) { await until(async () => (await health()).busy); assert.equal((await recognize(audio[1], samples[1].language)).status, 429); }
    const response = await request; assert.equal(response.status, 200);
    const value = await response.json(); assert.deepEqual(Object.keys(value), ['text']); checkText(value.text, samples[i]); outputs.push(value.text);
    timings.push({ audio_seconds: format.frames / format.sample_rate, elapsed_seconds: (performance.now() - start) / 1000, sample_rate: format.sample_rate, channels: format.channels });
    await until(async () => !(await health()).busy);
  }
  assert.notEqual(outputs[0], outputs[1], 'different spoken content must yield different recognition');
  // 第二段语音在31秒后，防止只识别开头30秒却返回成功。
  assert.equal(audio[0].readUInt32LE(24), audio[1].readUInt32LE(24)); assert.equal(audio[0].readUInt16LE(22), 1); assert.equal(audio[1].readUInt16LE(22), 1);
  const rate = audio[0].readUInt32LE(24), late = Buffer.alloc(44 + rate * 2 * 31 + audio[1].length - 44);
  audio[0].subarray(0, 44).copy(late); audio[0].subarray(44).copy(late, 44); audio[1].subarray(44).copy(late, 44 + rate * 2 * 31);
  late.writeUInt32LE(late.length - 8, 4); late.writeUInt32LE(late.length - 44, 40); verifyPcmWav(late);
  const lateStart = performance.now(), lateResponse = await recognize(late, samples[0].language); assert.equal(lateResponse.status, 200);
  const lateText = (await lateResponse.json()).text; checkText(lateText, samples[0]); checkText(lateText, samples[1]);
  const lateElapsed = (performance.now() - lateStart) / 1000;
  let calls = 0, mode = 'ok', held, release; const proxyErrors = [];
  const proxy = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(req.url, '/v1/audio/transcriptions'); assert.equal(req.headers['content-type'], 'audio/wav');
      assert.equal(req.headers['x-limeiot-model'], modelID); assert.equal(req.headers.authorization, undefined);
      assert.ok(audio.some(source => source.equals(bytes)), 'the provider must receive the complete original WAV'); calls++;
      const response = await recognize(bytes, req.headers['x-limeiot-language']), body = Buffer.from(await response.arrayBuffer());
      if (mode === 'hold') { held = true; await new Promise(resolve => { release = resolve; }); }
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') }); res.end(body);
    } catch (error) { proxyErrors.push(error.message); req.socket.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release?.(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const { stack, fixture } = await mediaStack(t, 'asr-live-', { directory, gatewayEnv: { LIMEIOT_ASR_URL: `http://127.0.0.1:${proxy.address().port}`, LIMEIOT_ASR_MODEL: modelID, LIMEIOT_ASR_CA_FILE: '' } });
  const uploaded = [];
  for (let i = 0; i < 2; i++) {
    const result = await stack.request(base + '/media-operations', post({ type: 'media.upload', content_base64: audio[i].toString('base64'), retain_seconds: 600 }, 'source-' + i));
    assert.equal(result.status, 200); uploaded.push(result.value.result.media);
  }
  const finish = key => until(async () => { const task = (await stack.request(base + '/audio-transcriptions/by-key/' + key)).value; return task.status !== 'running' && task; }, 85000);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); page.setDefaultTimeout(85000);
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=media'); await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const panel = page.getByRole('region', { name: '语音识别', exact: true });
  await expect(panel.getByLabel('录音', { exact: true })).toBeEnabled(); await panel.getByLabel('录音', { exact: true }).selectOption(uploaded[0].media_id); await panel.getByLabel('语言', { exact: true }).selectOption(samples[0].language);
  await panel.getByRole('button', { name: '识别录音', exact: true }).click(); await expect(panel.getByLabel('识别文本', { exact: true })).toHaveText(outputs[0], { timeout: 85000 }); assert.equal(calls, 1);
  const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), `limeiot.transcription:${base}`);
  assert.equal(await page.evaluate(text => Object.values(localStorage).some(value => value.includes(text)), outputs[0]), false);
  await page.reload(); await expect(panel.getByLabel('识别文本', { exact: true })).toHaveText(outputs[0], { timeout: 15000 }); assert.equal(calls, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(directory, 'real-asr-mobile.png'), fullPage: true });
  const cli = async args => { try { const result = await exec(process.execPath, ['packages/cli/src/main.mjs', 'audio-transcriptions', ...args, '--space-id', 'space-demo', '--state-dir', path.join(directory, 'cli')], { cwd: root, env: stack.env, timeout: 15000 }); return { code: 0, value: JSON.parse(result.stdout) }; } catch (error) { return { code: error.code, value: error.stdout && JSON.parse(error.stdout) }; } };
  assert.equal((await cli(['resolve', record.original.idempotency_key])).value.output.text, outputs[0]);
  const secondInput = { ...input(uploaded[1]), language: samples[1].language }, inputPath = path.join(directory, 'second.json'); await writeFile(inputPath, JSON.stringify(secondInput));
  assert.equal((await cli(['create', '--input', inputPath, '--idempotency-key', 'cli-real'])).code, 0);
  assert.equal((await finish('cli-real')).output.text, outputs[1]); assert.equal(calls, 2);
  assert.equal((await cli(['create', '--input', inputPath, '--idempotency-key', 'cli-real'])).value.output.text, outputs[1]); assert.equal(calls, 2);
  await stack.restartGateway(); assert.equal((await cli(['resolve', 'cli-real'])).value.output.text, outputs[1]); assert.equal(calls, 2);
  // 引擎已经算完而网关尚未收到响应，此时重启只能恢复unknown，不能重新发录音。
  mode = 'hold'; const interruptedInput = { ...input(uploaded[0]), language: samples[0].language };
  assert.equal((await stack.request(base + '/audio-transcriptions', post(interruptedInput, 'interrupted-real'))).status, 202);
  await until(() => held, 85000); assert.equal(calls, 3); await stack.restartGateway(); release();
  const unknown = await finish('interrupted-real'); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.error_code, 'transcription_interrupted'); assert.equal(unknown.output, null);
  assert.equal((await stack.request(base + '/audio-transcriptions', post(interruptedInput, 'interrupted-real'))).value.transcription_id, unknown.transcription_id);
  assert.equal((await stack.request(base + '/audio-transcriptions', post(input(uploaded[1]), 'cannot-bypass'))).status, 429);
  assert.equal((await cli(['resolve', 'interrupted-real'])).code, 6); assert.equal(calls, 3);
  assert.equal((await stack.request(base + '/audio-transcriptions/by-key/interrupted-real/discard', post({}))).value.status, 'discarded');
  await stack.request(base + '/media-operations', post({ type: 'media.delete', media_id: uploaded[0].media_id }, 'delete-source'));
  const cleared = await finish(record.original.idempotency_key); assert.equal(cleared.status, 'succeeded'); assert.equal(cleared.output.text, null); assert.ok(cleared.output.cleared_at);
  assert.equal(fixture.effects.length, 0); assert.equal((await stack.request(base + '/media')).value.grants.length, 0); assert.equal(calls, 3); assert.deepEqual(proxyErrors, []);
  await writeFile(path.join(directory, 'asr-live-result.json'), JSON.stringify({ passed: true, real_asr_engine: true, model: modelID, sample_texts: outputs, sample_sources: samples.slice(0, 2).map(sample => sample.source ?? null), independent_quality_benchmark: false, timings, late_phrase_after_31_seconds: { text: lateText, elapsed_seconds: lateElapsed, full_input_processed: true }, different_audio_different_text: true, browser: true, viewport: 390, cli: true, gateway_restarts: 2, restart_unknown_no_replay: true, unknown_budget_retained: true, source_deletion_clears_text: true, no_commands_or_grants: true, provider_calls: calls, native_transcription_ui: false, container_runtime: false, nas_image_rebuilt: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'asr-live-result.json') }));
});

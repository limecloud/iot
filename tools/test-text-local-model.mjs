// 显式验收已安装的真实Ollama模型；不下载权重、不改写模型输出、不重试生成。
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, freePort, startStack, until } from './dev-stack.mjs';
import { createTextOriginal, verifyTextTask } from '../packages/protocol/text.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { textLiveSamples as samples } from '../tests/helpers/text-live-samples.mjs';

const exec = promisify(execFile);
const model = process.env.LIMEIOT_TEXT_MODEL;
const origin = new URL(process.env.LIMEIOT_TEXT_URL ?? 'http://127.0.0.1:11434');
assert.ok(model, 'set LIMEIOT_TEXT_MODEL to an installed model with an explicit tag');
assert.ok(model.includes(':'), 'use an explicit model tag');
assert.ok(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'invalid local provider origin');
assert.match(origin.hostname, /^(127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/, 'this live test requires an explicit private numeric provider address');

const directory = process.env.LIMEIOT_TEXT_LIVE_DIRECTORY ?? path.join(root, '.dev', `text-live-${Date.now()}`);
await mkdir(directory, { recursive: true });
const base = '/api/v1/spaces/space-demo';
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const post = (body, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
const report = { passed: false, model, provider: origin.origin, samples: samples.map(({ id, messages, expectation }) => ({ id, messages, expectation })), cases: [], provider_calls: [], hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
let stack, proxy, browser, mode = 'ok', release, held = false, proxyRequests = 0;
const proxyErrors = [], browserErrors = [], expected = new Map();
async function providerJSON(resource) {
  const response = await fetch(new URL(resource, origin), { redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  report.ollama_version = (await providerJSON('/api/version')).version;
  const installed = (await providerJSON('/api/tags')).models.find(item => item.name === model);
  assert.ok(installed, 'the exact model tag must already be installed');
  assert.match(installed.digest, /^[a-f0-9]{64}$/);
  report.installed_model = { name: installed.name, digest: installed.digest, size: installed.size, details: installed.details };
  proxy = http.createServer(async (req, res) => {
    try {
      proxyRequests++;
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/chat'); assert.equal(req.headers.authorization, undefined);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes);
      assert.equal(body.model, model); assert.equal(body.stream, false); assert.equal(body.keep_alive, 0); assert.equal(body.tools, undefined);
      assert.deepEqual(body.options, { num_ctx: 4096, num_predict: 1024, temperature: 0 });
      assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /no tools, device access or permission/);
      const hasInstructions = body.messages[1]?.role === 'system';
      const context = { instructions: hasInstructions ? body.messages[1].content : '', messages: body.messages.slice(hasInstructions ? 2 : 1) }, digest = await documentDigest(context);
      assert.ok(expected.has(digest), 'only predeclared sample contexts may reach the provider');
      assert.deepEqual(context, expected.get(digest));
      const snapshot = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'));
      assert.equal(snapshot.schema_version, 5);
      assert.ok(Object.values(snapshot.texts).some(task => task.status === 'running' && task.input.context_digest === digest), 'the original request must be durable before inference');
      if (mode === 'offline') { req.socket.destroy(); return; }
      const started = performance.now();
      const response = await fetch(new URL('/api/chat', origin), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(85000) });
      const responseChunks = []; let responseBytes = 0;
      for await (const chunk of response.body) { responseBytes += chunk.length; assert.ok(responseBytes <= 65536); responseChunks.push(chunk); }
      const output = Buffer.concat(responseChunks); assert.equal(response.status, 200);
      let observed; try { observed = JSON.parse(output); } catch { /* 无效JSON仍原样交给网关裁定。 */ }
      report.provider_calls.push({ context_digest: digest, request_digest: hash(bytes), response_digest: hash(output), response_bytes: output.length, output_text: observed?.message?.content ?? null, done_reason: observed?.done_reason ?? null, elapsed_ms: Math.round(performance.now() - started), durable_before_provider: true, unmodified_forwarding: true });
      if (mode === 'hold') { held = true; await new Promise(resolve => { release = resolve; }); }
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') }); res.end(output);
    } catch (error) { proxyErrors.push(error.message); req.socket.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const mediaPort = await freePort();
  stack = await startStack({ directory, gatewayEnv: { LIMEIOT_MEDIA_LISTEN: `127.0.0.1:${mediaPort}`, LIMEIOT_MEDIA_ORIGIN: `http://127.0.0.1:${mediaPort}`, LIMEIOT_TEXT_URL: `http://127.0.0.1:${proxy.address().port}`, LIMEIOT_TEXT_MODEL: model, LIMEIOT_TEXT_CA_FILE: '' } });
  const capabilities = (await stack.request(base + '/capabilities')).value.text;
  assert.equal(capabilities.configured, true); assert.equal(capabilities.device_execution, false); assert.equal(capabilities.server_memory, false);
  const finish = key => until(async () => { const response = await stack.request(base + '/text-generations/by-key/' + key); return response.status === 200 && response.value.status !== 'running' && response.value; }, 88000);
  async function requestInput(sample) {
    const context = { instructions: sample.id === 'arithmetic' ? '' : '用简短中文回答。', messages: sample.messages };
    expected.set(await documentDigest(context), context);
    return { ...context, retain_seconds: 600, expires_at: new Date(Date.now() + 90000).toISOString() };
  }
  const originals = []; let cliRecord;
  const cli = args => exec(process.execPath, ['packages/cli/src/main.mjs', 'text-generations', ...args, '--space-id', 'space-demo', '--state-dir', path.join(directory, 'cli')], { cwd: root, env: stack.env, timeout: 15000 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT + '/?view=text');
  await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  const panel = page.getByRole('region', { name: '本地对话', exact: true });
  await expect(panel.getByLabel('消息', { exact: true })).toBeEnabled();
  for (const sample of samples) {
    let input = await requestInput(sample), key = 'live-' + sample.id;
    if (sample.id === 'arithmetic') {
      await panel.getByLabel('消息', { exact: true }).fill(sample.messages[0].content);
      const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === base + '/text-generations');
      await panel.getByRole('button', { name: '发送', exact: true }).click();
      const request = await submitted; input = request.postDataJSON(); key = await request.headerValue('idempotency-key');
      assert.deepEqual(input.messages, sample.messages); assert.equal(input.instructions, '');
      await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText('15', { timeout: 88000 });
      const saved = await page.evaluate(key => localStorage.getItem(key), 'limeiot.text:' + base);
      assert.equal(saved.includes(sample.messages[0].content), false); assert.equal(saved.includes(stack.env.LIMEIOT_TOKEN), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(directory, 'text-live-mobile.png'), fullPage: true });
    } else if (sample.id === 'context') {
      const inputPath = path.join(directory, 'context-input.json'); await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
      cliRecord = JSON.parse((await cli(['create', '--input', inputPath, '--idempotency-key', key])).stdout).cli.record_file;
      assert.equal((await stat(cliRecord)).mode & 0o777, 0o600);
      const saved = await readFile(cliRecord, 'utf8');
      for (const message of sample.messages) assert.equal(saved.includes(message.content), false);
    } else assert.equal((await stack.request(base + '/text-generations', post(input, key))).status, 202);
    const original = await createTextOriginal(stack.env.LIMEIOT_ENDPOINT, 'space-demo', key, input);
    const task = await finish(key); await verifyTextTask(task, 'space-demo', key, original);
    report.cases.push({ id: sample.id, status: task.status, error_code: task.error_code, text: task.output?.text, usage: task.usage });
    assert.equal(task.status, 'succeeded', JSON.stringify({ id: sample.id, status: task.status, error: task.error_code }));
    sample.check(task.output.text); assert.ok(task.usage.input_tokens > 0 && task.usage.output_tokens > 0);
    originals.push({ key, original, task });
    console.log(JSON.stringify({ sample: sample.id, status: 'passed', provider_calls: report.provider_calls.length }));
  }
  await browser.close(); browser = undefined; assert.deepEqual(browserErrors, []);
  assert.equal(report.provider_calls.length, 3);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  await stack.restartGateway();
  for (const { key, original, task } of originals) {
    const recovered = await finish(key); await verifyTextTask(recovered, 'space-demo', key, original);
    assert.equal(recovered.text_id, task.text_id); assert.equal(recovered.output.text, task.output.text);
  }
  assert.equal(JSON.parse((await cli(['resolve', 'live-context'])).stdout).output.text, originals[1].task.output.text);
  for (const { key } of originals) assert.equal((await stack.request(base + '/text-generations/by-key/' + key + '/discard', post({}))).status, 200);
  await stack.restartGateway();
  for (const { key } of originals) { const task = await finish(key); assert.equal(task.output.text, null); assert.ok(task.output.cleared_at); }
  const cleared = await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8');
  for (const sample of samples) for (const message of sample.messages) assert.equal(cleared.includes(message.content), false, 'input text must not be persisted');
  assert.equal(report.provider_calls.length, 3); report.success_restart_and_clear = true;

  // 真实模型已算完，故意扣住原响应；重启后保留unknown，禁止重复推理。
  mode = 'hold'; const interrupted = await requestInput(samples[0]);
  assert.equal((await stack.request(base + '/text-generations', post(interrupted, 'live-interrupted'))).status, 202);
  await until(() => held || proxyErrors.length, 88000); assert.deepEqual(proxyErrors, []); assert.equal(report.provider_calls.length, 4);
  await stack.restartGateway(); release();
  const unknown = await finish('live-interrupted'); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.error_code, 'text_interrupted'); assert.equal(unknown.output, null);
  assert.equal((await stack.request(base + '/text-generations', post(interrupted, 'live-interrupted'))).value.text_id, unknown.text_id);
  assert.equal((await stack.request(base + '/text-generations', post(await requestInput(samples[0]), 'live-budget-blocked'))).status, 429);
  assert.equal((await stack.request(base + '/text-generations/by-key/live-interrupted/discard', post({}))).value.status, 'discarded');
  assert.equal(report.provider_calls.length, 4); report.interrupted_unknown_no_replay = true;

  mode = 'offline';
  assert.equal((await stack.request(base + '/text-generations', post(await requestInput(samples[0]), 'live-offline'))).status, 202);
  const offline = await finish('live-offline'); assert.equal(offline.status, 'unknown'); assert.equal(offline.error_code, 'text_provider_unknown');
  const device = await until(async () => { const response = await stack.request(base + '/devices/device-lamp'); return response.status === 200 && response.value.ready && response.value; });
  report.offline_device_ready_before_command = device.ready;
  const accepted = await stack.request(base + '/commands', post({ device_id: 'device-lamp', model_revision: device.model_revision, expires_at: new Date(Date.now() + 8000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'explicit-owner'));
  assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
  await until(async () => (await stack.request(base + '/commands/' + accepted.value.command_id)).value.status === 'confirmed');
  assert.equal((await stack.request(base + '/commands')).value.items.length, 1);
  assert.equal((await stack.request(base + '/rule-deployments')).value.items.length, 0);
  assert.equal(report.provider_calls.length, 4); assert.equal(proxyRequests, 5); assert.deepEqual(proxyErrors, []);
  await stack.request(base + '/text-generations/by-key/live-offline/discard', post({}));
  assert.equal((await readFile(cliRecord, 'utf8')).includes(stack.env.LIMEIOT_TOKEN), false);
  assert.equal((await providerJSON('/api/tags')).models.find(item => item.name === model)?.digest, installed.digest);
  Object.assign(report, { passed: true, real_ollama: true, real_browser: true, browser_viewport: 390, browser_errors: browserErrors, independent_quality_benchmark: false, gateway_restarts: 3, provider_transport_failure_injected: true, offline_device_command_confirmed: true, automatic_device_commands: 0, explicit_device_commands: 1, model_output_rewritten: false, proxy_requests: proxyRequests, automatic_retries: 0, cli_digest_only_record: true, native_app_runtime: false, nas_container_runtime: false });
} catch (error) {
  report.failure = { message: error.message, code: error.code ?? null }; throw error;
} finally {
  release?.();
  await browser?.close();
  await stack?.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  report.proxy_errors = proxyErrors;
  await writeFile(path.join(directory, 'text-live-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ report: path.join(directory, 'text-live-result.json'), passed: report.passed }));
}

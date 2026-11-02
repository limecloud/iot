import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { chatEndpoint, createChatProvider } from '../tools/xiaodu-skill/provider.mjs';

async function upstream(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('提供方地址保留v1前缀并拒绝URL凭据和外部明文HTTP', () => {
  assert.equal(chatEndpoint('https://example.com/').href, 'https://example.com/v1/chat/completions');
  assert.equal(chatEndpoint('https://example.com/v1/').href, 'https://example.com/v1/chat/completions');
  for (const url of ['http://example.com/', 'https://key@example.com/', 'https://example.com/?key=secret']) {
    assert.throws(() => chatEndpoint(url), /invalid_provider_url/);
  }
});

test('真实HTTP发送指定模型和会话文字，解析回答', async t => {
  let observed;
  const baseUrl = await upstream(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    observed = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: ' 青柠助手连接正常 ' } }] }));
  });
  const reply = createChatProvider({ baseUrl, apiKey: 'test-key', model: 'selected-model', reasoningEffort: 'none' });
  assert.equal(await reply([{ role: 'user', content: '你好' }]), '青柠助手连接正常');
  assert.equal(observed.path, '/v1/chat/completions');
  assert.equal(observed.authorization, 'Bearer test-key');
  assert.equal(observed.body.model, 'selected-model');
  assert.equal(observed.body.messages.at(-1).content, '你好');
  assert.equal(observed.body.stream, false);
  assert.equal(observed.body.reasoning_effort, 'none');
  assert.equal(observed.body.tools, undefined);
});

test('拒绝重定向，不将密钥发送给第二个地址', async t => {
  let leaked = 0;
  const destination = await upstream(t, (_req, res) => { leaked++; res.end('{}'); });
  const baseUrl = await upstream(t, (_req, res) => {
    res.writeHead(307, { location: destination });
    res.end();
  });
  const reply = createChatProvider({ baseUrl, apiKey: 'test-key', model: 'selected-model' });
  await assert.rejects(reply([]), /provider_rejected/);
  assert.equal(leaked, 0);
});

test('上游错误不会把密钥或错误正文带回技能', async t => {
  const baseUrl = await upstream(t, (_req, res) => {
    res.writeHead(401); res.end('sensitive-upstream-secret');
  });
  const reply = createChatProvider({ baseUrl, apiKey: 'test-key', model: 'selected-model' });
  await assert.rejects(reply([]), error => {
    assert.equal(error.message, 'provider_authentication_failed');
    assert.equal(error.status, 401);
    return true;
  });
});

test('会话退出信号能中止正在等待的模型调用', async t => {
  let started;
  const incoming = new Promise(resolve => { started = resolve; });
  const baseUrl = await upstream(t, () => started());
  const controller = new AbortController();
  const reply = createChatProvider({ baseUrl, apiKey: 'test-key', model: 'selected-model' });
  const pending = reply([], { signal: controller.signal });
  await incoming;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('超大和空回答拒绝作为语音结果', async t => {
  const oversized = await upstream(t, (_req, res) => res.end('x'.repeat(130 * 1024)));
  await assert.rejects(createChatProvider({ baseUrl: oversized, apiKey: 'test-key', model: 'm' })([]), /provider_response_too_large/);
  const empty = await upstream(t, (_req, res) => res.end(JSON.stringify({ choices: [] })));
  await assert.rejects(createChatProvider({ baseUrl: empty, apiKey: 'test-key', model: 'm' })([]), /provider_invalid_response/);
});

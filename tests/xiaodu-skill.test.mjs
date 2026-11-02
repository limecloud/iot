import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { createSkillServer } from '../tools/xiaodu-skill/server.mjs';
import { validateCertificateUrl, verifySignatureWithCertificate } from '../tools/xiaodu-skill/dueros.mjs';

const app = 'test-limeiot-skill';
const validSignature = 'contract-test-signature';
const verifier = async ({ headers }) => headers.signature === validSignature;

function envelope({ type = 'IntentRequest', id = 'request-1', session = 'session-1', user = 'user-1', device = 'device-1', query = '你好', fresh = true, timestamp = String(Math.floor(Date.now() / 1000)), applicationId = app, intents = [] } = {}) {
  return {
    version: '2.0', session: { new: fresh, sessionId: session, attributes: {} },
    context: { System: { application: { applicationId }, user: { userId: user }, device: { deviceId: device } } },
    request: { type, requestId: id, timestamp, ...(type === 'IntentRequest' ? { query: { type: 'TEXT', original: query }, intents } : {}) },
  };
}

async function fixture(t, reply = async () => '测试回答', options = {}) {
  const server = createSkillServer({ applicationId: app, reply, verifyRequest: verifier, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url,
    async post(value, signature = validSignature) {
      const response = await fetch(url + '/dueros', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { signature } : {}) }, body: JSON.stringify(value),
      });
      return { status: response.status, value: await response.json() };
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('小度技能 HTTP 合同：探活、Launch 不调用模型、直接 Intent 与普通多轮', async t => {
  const calls = [];
  const f = await fixture(t, async messages => { calls.push(messages); return '来自测试模型'; });
  assert.equal((await fetch(f.url + '/healthz')).status, 200);
  assert.equal((await fetch(f.url + '/dueros', { method: 'HEAD' })).status, 204);
  assert.equal((await fetch(f.url + '/dueros')).status, 405);
  const launch = await f.post(envelope({ type: 'LaunchRequest', id: 'launch' }));
  assert.equal(launch.status, 200); assert.equal(calls.length, 0);
  assert.equal(launch.value.response.shouldEndSession, false);
  assert.equal(launch.value.response.card.content, launch.value.response.outputSpeech.text);
  const first = await f.post(envelope({ id: 'first', fresh: false, query: '第一个问题' }));
  assert.equal(first.value.response.outputSpeech.text, '来自测试模型');
  assert.equal(first.value.response.expectSpeech, true);
  await f.post(envelope({ id: 'second', fresh: false, query: '第二个问题' }));
  assert.deepEqual(calls[1].map(message => message.content), ['第一个问题', '来自测试模型', '第二个问题']);
  const direct = await f.post(envelope({ session: 'direct-intent', id: 'direct' }));
  assert.equal(direct.status, 200); assert.equal(calls.at(-1).length, 1);
});

test('来源校验始终拒绝无效签名、错误 applicationId、过期或未来时间戳', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls += 1; return '不能调用'; });
  assert.equal((await f.post(envelope(), 'invalid')).status, 401);
  assert.equal((await f.post(envelope({ applicationId: 'foreign' }))).status, 403);
  assert.equal((await f.post(envelope({ timestamp: String(Math.floor(Date.now() / 1000) - 181) }))).status, 401);
  assert.equal((await f.post(envelope({ timestamp: String(Math.floor(Date.now() / 1000) + 181) }))).status, 401);
  assert.equal((await f.post(envelope({ timestamp: 'not-a-timestamp' }))).status, 401);
  assert.equal(calls, 0);
  const strict = await fixture(t, async () => '不能调用', { verifyRequest: undefined });
  assert.equal((await strict.post(envelope(), '')).status, 401);
});

test('官方模拟器 v2.0 与新会话默认意图启动兼容，未知版本仍拒绝', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls += 1; return '模型回答'; });
  const value = envelope({ query: '打开柠檬管家', intents: [{ name: 'ai.dueros.common.default_intent' }] });
  value.version = 'v2.0';
  const launch = await f.post(value);
  assert.equal(launch.status, 200);
  assert.match(launch.value.response.outputSpeech.text, /柠檬管家已连接/);
  assert.equal(calls, 0);
  const reopen = envelope({ id: 'reopen', query: '打开青柠助手', fresh: false });
  reopen.version = 'v2.0';
  assert.match((await f.post(reopen)).value.response.outputSpeech.text, /柠檬管家已连接/);
  assert.equal(calls, 0);
  const question = envelope({ id: 'next', query: '你好', fresh: false });
  question.version = 'v2.0';
  assert.equal((await f.post(question)).value.response.outputSpeech.text, '模型回答');
  assert.equal(calls, 1);
  value.version = '3.0'; value.request.requestId = 'unknown-version';
  assert.equal((await f.post(value)).status, 400);
});

test('续答模式在同步预算内响应，继续只取已有结果并保留真实对话历史', async t => {
  const answer = deferred();
  const calls = [];
  const f = await fixture(t, async messages => {
    calls.push(messages);
    return calls.length === 1 ? answer.promise : '第二个回答';
  }, { deferredReplies: true, responseBudgetMs: 10 });
  const question = envelope({ query: '第一个问题' });
  const waiting = await f.post(question);
  assert.equal(waiting.status, 200);
  assert.match(waiting.value.response.outputSpeech.text, /正在思考/);
  const poll = await f.post(envelope({ id: 'poll', query: '继续', fresh: false }));
  assert.match(poll.value.response.outputSpeech.text, /正在思考/);
  assert.match((await f.post(envelope({ id: 'other', query: '另一个问题', fresh: false })))
    .value.response.outputSpeech.text, /上一个问题尚未收听/);
  assert.equal(calls.length, 1);
  answer.resolve('第一个回答');
  await new Promise(resolve => setImmediate(resolve));
  const result = await f.post(envelope({ id: 'take', query: '继续', fresh: false }));
  assert.equal(result.value.response.outputSpeech.text, '第一个回答');
  assert.match((await f.post(envelope({ id: 'empty', query: '继续', fresh: false })))
    .value.response.outputSpeech.text, /没有待取/);
  assert.equal(calls.length, 1);
  await f.post(envelope({ id: 'next-question', query: '第二个问题', fresh: false }));
  assert.deepEqual(calls[1].map(message => message.content), ['第一个问题', '第一个回答', '第二个问题']);
  assert.deepEqual(await f.post(question), waiting);
});

test('续答退出取消后台任务，忽略取消的迟到回答不能进入新会话', async t => {
  const answer = deferred();
  let signal;
  const f = await fixture(t, async (_messages, options) => { signal = options.signal; return answer.promise; },
    { deferredReplies: true, responseBudgetMs: 10 });
  await f.post(envelope());
  const exit = await f.post(envelope({ id: 'exit', query: '切回小度', fresh: false }));
  assert.equal(exit.value.response.shouldEndSession, true);
  assert.equal(signal.aborted, true);
  await f.post(envelope({ type: 'LaunchRequest', id: 'new-launch' }));
  answer.resolve('不能泄露的旧回答');
  await new Promise(resolve => setImmediate(resolve));
  const result = await f.post(envelope({ id: 'take-old', query: '继续', fresh: false }));
  assert.match(result.value.response.outputSpeech.text, /没有待取/);
});

test('同 sessionId 的不同用户、设备与新会话不共享模型历史', async t => {
  const calls = [];
  const f = await fixture(t, async messages => { calls.push(messages); return '回答'; });
  await f.post(envelope({ id: 'owner', query: '原用户秘密' }));
  await f.post(envelope({ id: 'other-user', user: 'user-2', query: '另一用户' }));
  await f.post(envelope({ id: 'other-device', device: 'device-2', query: '另一设备' }));
  await f.post(envelope({ id: 'new-session', session: 'session-2', query: '另一会话' }));
  await f.post(envelope({ id: 'reset', query: '重新开始' }));
  assert.ok(calls.every(messages => messages.length === 1));
});

test('相同 requestId 并发及完成后重放均只调用一次，相同 ID 异参拒绝', async t => {
  const started = deferred(), answer = deferred(); let calls = 0;
  const f = await fixture(t, async () => { calls += 1; started.resolve(); return answer.promise; });
  const value = envelope();
  const first = f.post(value); await started.promise;
  const second = f.post(value);
  answer.resolve('同一结果');
  assert.deepEqual(await first, await second);
  assert.equal((await f.post(value)).value.response.outputSpeech.text, '同一结果');
  assert.equal((await f.post({ ...value, request: { ...value.request, query: { type: 'TEXT', original: '不同内容' } } })).status, 409);
  assert.equal(calls, 1);
});

test('退出取消同会话任务；提供方忽略取消的迟到结果和旧请求重放不播报', async t => {
  const started = deferred(), answer = deferred(); let observedSignal;
  const f = await fixture(t, async (_messages, { signal }) => { observedSignal = signal; started.resolve(); return answer.promise; });
  const old = envelope({ id: 'pending' });
  const pending = f.post(old); await started.promise;
  const exit = await f.post(envelope({ id: 'exit', fresh: false, query: '切回小度' }));
  assert.equal(exit.value.response.shouldEndSession, true);
  assert.equal(observedSignal.aborted, true);
  const cancelled = await pending;
  assert.equal(cancelled.value.response.shouldEndSession, true);
  assert.equal(cancelled.value.response.outputSpeech, undefined);
  answer.resolve('这个迟到回答不能播放');
  const replay = await f.post(old);
  assert.equal(replay.value.response.outputSpeech, undefined);
  const after = await f.post(envelope({ id: 'after-exit', fresh: false }));
  assert.equal(after.value.response.shouldEndSession, true);
});

test('SessionEnded 和取消意图无需模型，已完成回答在退出后也不重播', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls += 1; return '旧回答'; });
  const old = envelope(); await f.post(old);
  const end = await f.post(envelope({ type: 'SessionEndedRequest', id: 'end', fresh: false }));
  assert.equal(end.value.response.outputSpeech, undefined);
  assert.equal((await f.post(old)).value.response.outputSpeech, undefined);
  const cancel = await f.post(envelope({ session: 'new', id: 'cancel', query: '不用了', intents: [{ name: 'ai.dueros.common.cancel_intent' }] }));
  assert.equal(cancel.value.response.shouldEndSession, true);
  assert.equal(calls, 1);
});

test('验签乱序完成时，退出标记阻止先到达的旧请求重新开启会话', async t => {
  const authenticating = deferred(), verified = deferred(); let calls = 0;
  const f = await fixture(t, async () => { calls += 1; return '新会话回答'; }, {
    verifyRequest: async ({ body }) => {
      if (JSON.parse(body).request.requestId === 'delayed-verification') {
        authenticating.resolve(); await verified.promise;
      }
      return true;
    },
  });
  const delayed = f.post(envelope({ id: 'delayed-verification' })); await authenticating.promise;
  await f.post(envelope({ id: 'exit-before-verification', query: '退出', fresh: false }));
  verified.resolve();
  const old = await delayed;
  assert.equal(old.value.response.shouldEndSession, true);
  assert.equal(old.value.response.outputSpeech, undefined);
  assert.equal(calls, 0);
  const reopened = await f.post(envelope({ id: 'explicit-reopen' }));
  assert.equal(reopened.value.response.outputSpeech.text, '新会话回答');
  assert.equal(calls, 1);
});

test('模型错误不泄露信息或切换提供方，回答长度有界，输入大小受限', async t => {
  const f = await fixture(t, async () => { throw new Error('secret-token-provider-details'); });
  const failed = await f.post(envelope());
  assert.equal(failed.status, 200);
  assert.match(failed.value.response.outputSpeech.text, /暂时无法回答/);
  assert.ok(!JSON.stringify(failed.value).includes('secret-token'));
  const long = await fixture(t, async () => '响'.repeat(600));
  const result = await long.post(envelope());
  assert.equal(Array.from(result.value.response.outputSpeech.text).length, 256);
  assert.ok(Buffer.byteLength(JSON.stringify(result.value)) < 24 * 1024);
  const response = await fetch(long.url + '/dueros', {
    method: 'POST', headers: { 'Content-Type': 'application/json', signature: validSignature }, body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(response.status, 413);
});

test('模型并发有界且退出事件能够进入取消，未配身份的请求不共享匿名历史', async t => {
  const started = [], answers = []; let calls = 0;
  const f = await fixture(t, async (_messages, { signal }) => {
    calls += 1; const answer = deferred(); answers.push(answer); started.shift()?.resolve();
    signal.addEventListener('abort', () => answer.resolve('取消后的回答'), { once: true });
    return answer.promise;
  });
  const pending = [];
  for (let index = 0; index < 4; index += 1) {
    const ready = deferred(); started.push(ready);
    pending.push(f.post(envelope({ id: `pending-${index}`, session: `session-${index}` })));
    await ready.promise;
  }
  const busy = await f.post(envelope({ id: 'busy', session: 'session-busy' }));
  assert.match(busy.value.response.outputSpeech.text, /正在处理/); assert.equal(calls, 4);
  const exit = await f.post(envelope({ id: 'exit-full', session: 'session-0', fresh: false, query: '退出' }));
  assert.equal(exit.value.response.shouldEndSession, true);
  answers.forEach(answer => answer.resolve('完成')); await Promise.all(pending);
  const anonymous = envelope({ id: 'anonymous' }); delete anonymous.context.System.user;
  assert.equal((await f.post(anonymous)).status, 400);
});

test('证书 URL 严格限定百度签名目录，禁止外站、端口、凭据、查询和目录逃逸', () => {
  assert.equal(validateCertificateUrl('https://duer.bdstatic.com/saiya/flow/example.cer.txt').hostname, 'duer.bdstatic.com');
  for (const url of [
    'http://duer.bdstatic.com/saiya/flow/a', 'https://evil.example/saiya/flow/a',
    'https://duer.bdstatic.com.evil.example/saiya/flow/a', 'https://duer.bdstatic.com:444/saiya/flow/a',
    'https://user@duer.bdstatic.com/saiya/flow/a', 'https://duer.bdstatic.com/saiya/flow/a?key=value',
    'https://@duer.bdstatic.com/saiya/flow/a', 'https://duer.bdstatic.com/saiya/flow/a?',
    'https://duer.bdstatic.com/saiya/flow/a#',
    'https://duer.bdstatic.com/saiya/flow/a#fragment', 'https://duer.bdstatic.com/saiya/flow/../a',
    'https://duer.bdstatic.com/saiya/flow/%2e%2e/a', 'https://duer.bdstatic.com/saiya/flow/%2f..%2fa',
  ]) assert.throws(() => validateCertificateUrl(url), url);
});

test('RSA-SHA1 验原始正文，证书 SAN、有效期与正文篡改独立验证', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaodu-signature-contract-'));
  const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=dueros-api.baidu.com', '-addext', 'subjectAltName=DNS:dueros-api.baidu.com'], { stdio: 'ignore' });
  const key = await readFile(keyPath), certificate = await readFile(certPath);
  const body = Buffer.from('{"真实正文":"保持字节不变"}');
  const signature = sign('RSA-SHA1', body, key).toString('base64');
  assert.equal(verifySignatureWithCertificate({ body, signature, certificate }), true);
  assert.equal(verifySignatureWithCertificate({ body: Buffer.from(body + ' '), signature, certificate }), false);
  assert.throws(() => verifySignatureWithCertificate({ body, signature, certificate, now: 0 }));
  assert.throws(() => verifySignatureWithCertificate({ body, signature, certificate, now: Date.now() + 2 * 24 * 60 * 60 * 1000 }));
  const otherCert = path.join(directory, 'wrong-san.pem');
  execFileSync('openssl', ['req', '-x509', '-key', keyPath, '-out', otherCert, '-days', '1', '-subj', '/CN=dueros-api.baidu.com', '-addext', 'subjectAltName=DNS:wrong.example'], { stdio: 'ignore' });
  const wrongCertificate = await readFile(otherCert);
  assert.throws(() => verifySignatureWithCertificate({ body, signature, certificate: wrongCertificate }));
  assert.equal(verifySignatureWithCertificate({ body, signature,
    certificate: Buffer.concat([certificate, wrongCertificate]) }), true);
  assert.throws(() => verifySignatureWithCertificate({ body, signature,
    certificate: Buffer.concat([wrongCertificate, certificate]) }));
  assert.throws(() => verifySignatureWithCertificate({ body, signature,
    certificate: certificate.toString() + 'unexpected data' }));
});

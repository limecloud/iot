import http from 'node:http';
import { createHash } from 'node:crypto';
import { verifyDuerosRequest } from './dueros.mjs';

const bodyLimit = 64 * 1024;
const responseLimit = 24 * 1024;
const sessionLimit = 128;
const historyLimit = 12;
const sessionTtl = 10 * 60 * 1000;
const cacheLimit = 512;
const cacheTtl = 2 * 60 * 1000;
const concurrencyLimit = 4;
const replyTimeout = 20_000;
const exitIntents = new Set(['ai.dueros.common.cancel_intent', 'ai.dueros.common.stop_intent', 'limeiot.exit', 'limeiot.switch_to_dueros']);
const exitWords = new Set(['退出', '结束', '结束对话', '切回小度', '切回原厂', '切回原厂小度', '返回小度', '退出柠檬管家', '退出青柠助手', '退出青柠物联', '退出limeiot']);
const launchWords = new Set(['打开柠檬管家', '进入柠檬管家', '启动柠檬管家', '打开青柠助手', '进入青柠助手', '启动青柠助手']);
const continueWords = new Set(['继续', '继续回答', '有答案了吗', '回答好了吗']);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function boundedString(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
}

function speech(text, end = false) {
  const content = Array.from(text).slice(0, 256).join('');
  return {
    version: '2.0',
    context: { intent: null },
    session: { attributes: end ? {} : { mode: 'limeiot' } },
    response: {
      ...(content ? { outputSpeech: { type: 'PlainText', text: content },
        card: { type: 'txt', content } } : {}),
      directives: [],
      shouldEndSession: end,
      expectSpeech: !end,
    },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(new HttpError(408, 'request_timeout')), 5000);
    timer.unref();
    function finish(error) {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', failed);
      if (error) { request.pause(); reject(error); }
      else resolve(Buffer.concat(chunks));
    }
    function data(chunk) {
      size += chunk.length;
      if (size > bodyLimit) return finish(new HttpError(413, 'request_too_large'));
      chunks.push(chunk);
    }
    function end() { finish(); }
    function aborted() { finish(new HttpError(400, 'request_aborted')); }
    function failed() { finish(new HttpError(400, 'request_failed')); }
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', failed);
  });
}

function validateRequest(value, applicationId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['2.0', 'v2.0'].includes(value.version)) {
    throw new HttpError(400, 'invalid_request');
  }
  const system = value.context?.System;
  if (system?.application?.applicationId !== applicationId) throw new HttpError(403, 'application_rejected');
  const request = value.request;
  if (typeof request?.timestamp !== 'string' || !/^\d{1,12}$/.test(request.timestamp)
    || Math.abs(Date.now() - Number(request.timestamp) * 1000) >= 180_000) {
    throw new HttpError(401, 'request_expired');
  }
  if (!boundedString(system.user?.userId, 256) || !boundedString(system.device?.deviceId, 256)
    || !boundedString(value.session?.sessionId, 256) || typeof value.session?.new !== 'boolean'
    || !boundedString(request.requestId, 256)
    || !['LaunchRequest', 'IntentRequest', 'SessionEndedRequest'].includes(request.type)) {
    throw new HttpError(400, 'invalid_request');
  }
  if (request.type === 'IntentRequest' && !boundedString(request.query?.original, 2048)) {
    throw new HttpError(400, 'invalid_query');
  }
  return {
    sessionKey: JSON.stringify([applicationId, system.user.userId, system.device.deviceId, value.session.sessionId]),
    requestKey: JSON.stringify([applicationId, system.user.userId, system.device.deviceId, request.requestId]),
  };
}

export function createSkillServer({ applicationId, reply, verifyRequest = verifyDuerosRequest,
  deferredReplies = false, responseBudgetMs = 1800 }) {
  if (!boundedString(applicationId, 256) || typeof reply !== 'function' || typeof verifyRequest !== 'function'
    || typeof deferredReplies !== 'boolean' || !Number.isInteger(responseBudgetMs)
    || responseBudgetMs < 10 || responseBudgetMs > 2500) {
    throw new Error('invalid_skill_configuration');
  }
  const sessions = new Map();
  const requests = new Map();
  let active = 0;
  let arrivalOrder = 0;

  function endSession(session, reason = 'session_ended') {
    session.ended = true;
    session.history = [];
    session.controller?.abort(reason);
    session.controller = null;
    session.pendingReply = null;
    session.lastSeen = Date.now();
  }

  function prune() {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastSeen >= sessionTtl) {
        endSession(session, 'session_expired');
        sessions.delete(key);
      }
    }
    for (const [key, request] of requests) {
      if (request.finished && now - request.created >= cacheTtl) requests.delete(key);
    }
  }

  function newSession(key, order) {
    if (sessions.has(key)) endSession(sessions.get(key), 'session_replaced');
    else if (sessions.size >= sessionLimit) {
      const idle = [...sessions].find(([, value]) => !value.controller);
      if (!idle) throw new HttpError(503, 'session_capacity');
      endSession(idle[1], 'session_evicted');
      sessions.delete(idle[0]);
    }
    const session = { key, order, history: [], controller: null, ended: false, lastSeen: Date.now() };
    sessions.set(key, session);
    return session;
  }

  async function process(value, key, order) {
    const request = value.request;
    const normalized = request.query?.original?.trim().toLowerCase().replace(/[。！!？?，,\s]+$/u, '');
    const isExit = request.type === 'SessionEndedRequest' || exitWords.has(normalized)
      || (Array.isArray(request.intents) && request.intents.some(intent => exitIntents.has(intent?.name)));
    let session = sessions.get(key);
    // 验签可能乱序完成，已经结束或替换会话的旧请求不能重新开启录音。
    if (session && order < session.order) return { payload: speech('', true), terminal: true };
    if (isExit) {
      session ??= newSession(key, order);
      session.order = order;
      endSession(session);
      // 退出不受模型并发限制，也不请求模型生成结束语。
      return { payload: speech(request.type === 'SessionEndedRequest' ? '' : '已退出柠檬管家，请继续使用小度。', true), terminal: true };
    }
    if (value.session.new) session = newSession(key, order);
    if (!session || session.ended) return { payload: speech('会话已结束，请重新打开柠檬管家。', true), terminal: true };
    session.order = order;
    session.lastSeen = Date.now();
    if (request.type === 'LaunchRequest' || launchWords.has(normalized)) {
      return { payload: speech('柠檬管家已连接，请说出你的问题。说切回小度可以退出。'), session };
    }
    if (deferredReplies && session.pendingReply) {
      const pending = session.pendingReply;
      if (!continueWords.has(normalized)) {
        return { payload: speech('上一个问题尚未收听，请说继续获取回答，或说切回小度退出。'), session };
      }
      if (pending.result) {
        session.pendingReply = null;
        return pending.result;
      }
      return { payload: speech('青柠正在思考，请稍后说继续获取回答。说切回小度可以退出。'), session };
    }
    if (deferredReplies && continueWords.has(normalized)) {
      return { payload: speech('目前没有待取的回答，请说出你的问题。'), session };
    }
    if (session.controller || active >= concurrencyLimit) {
      return { payload: speech('青柠正在处理请求，请稍后再试。'), session };
    }

    const controller = new AbortController();
    session.controller = controller;
    const messages = [...session.history, { role: 'user', content: request.query.original }];
    active += 1;
    const providerTask = Promise.resolve().then(() => reply(messages, { signal: controller.signal }));
    // 提供方忽略取消时仍占并发槽，避免不断取消造成无界后台调用。
    providerTask.finally(() => { active -= 1; }).catch(() => {});
    let abortListener;
    const aborted = new Promise((resolve, reject) => {
      abortListener = () => reject(new Error('reply_cancelled'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const timer = setTimeout(() => controller.abort('reply_timeout'), replyTimeout);
    timer.unref();
    const completion = (async () => {
      try {
        const answer = await Promise.race([providerTask, aborted]);
        if (controller.signal.aborted || session.ended || sessions.get(key) !== session) {
          return { payload: speech('', true), terminal: true };
        }
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('invalid_reply');
        const text = Array.from(answer.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')).slice(0, 256).join('');
        session.history = [...messages, { role: 'assistant', content: text }].slice(-historyLimit);
        return { payload: speech(text), session };
      } catch {
        if (session.ended || sessions.get(key) !== session) return { payload: speech('', true), terminal: true };
        return { payload: speech(controller.signal.reason === 'reply_timeout'
          ? '青柠回答超时，请稍后再试。' : '青柠暂时无法回答，请稍后再试。'), session };
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abortListener);
        if (session.controller === controller) session.controller = null;
      }
    })();
    if (!deferredReplies) return completion;

    // 平台同步请求的等待时间短；后台回答只在后续已验签的会话请求中交付。
    const pending = { result: null };
    session.pendingReply = pending;
    completion.then(result => {
      if (session.pendingReply === pending) pending.result = result;
    });
    let budgetTimer;
    const waiting = Symbol('waiting');
    try {
      const result = await Promise.race([completion, new Promise(resolve => {
        budgetTimer = setTimeout(() => resolve(waiting), responseBudgetMs);
        budgetTimer.unref();
      })]);
      if (result === waiting) {
        return { payload: speech('青柠正在思考，请稍后说继续获取回答。说切回小度可以退出。'), session };
      }
      if (session.pendingReply === pending) session.pendingReply = null;
      return result;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  function send(response, status, value) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > responseLimit) throw new Error('response_too_large');
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    response.end(body);
  }

  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (request, response) => {
    const order = ++arrivalOrder;
    try {
      if ((request.method === 'GET' || request.method === 'HEAD') && request.url === '/healthz') {
        return send(response, 200, { status: 'ok', mode: 'dueros-skill-experiment' });
      }
      if (request.method === 'HEAD' && request.url === '/dueros') {
        response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return;
      }
      if (request.url !== '/dueros') throw new HttpError(404, 'not_found');
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        throw new HttpError(415, 'json_required');
      }
      const body = await readBody(request);
      let verified = false;
      try { verified = await verifyRequest({ headers: request.headers, body }); } catch {}
      if (verified !== true) throw new HttpError(401, 'signature_rejected');
      let value;
      try { value = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
      const { sessionKey, requestKey } = validateRequest(value, applicationId);
      prune();
      const digest = createHash('sha256').update(body).digest('hex');
      let cached = requests.get(requestKey);
      if (cached && cached.digest !== digest) throw new HttpError(409, 'request_id_conflict');
      if (!cached) {
        while (requests.size >= cacheLimit) {
          const completed = [...requests].find(([, item]) => item.finished);
          if (!completed) throw new HttpError(503, 'request_capacity');
          requests.delete(completed[0]);
        }
        cached = { digest, created: Date.now(), finished: false };
        requests.set(requestKey, cached);
        cached.promise = process(value, sessionKey, order).finally(() => { cached.finished = true; });
      }
      const result = await cached.promise;
      const stale = !result.terminal && result.session
        && (result.session.ended || sessions.get(sessionKey) !== result.session);
      send(response, 200, stale ? speech('', true) : result.payload);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!response.headersSent && !response.destroyed) {
        response.setHeader('Connection', 'close');
        send(response, status, { error: error instanceof HttpError ? error.message : 'internal_error' });
        response.once('finish', () => request.destroy());
      }
    }
  });
  server.maxHeadersCount = 32;
  server.on('close', () => {
    for (const session of sessions.values()) endSession(session, 'server_closed');
    sessions.clear(); requests.clear();
  });
  return server;
}

import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request, type Session } from './api';
import { createTextOriginal, parseTextInput, validTextOriginal, verifyTextCapabilities, verifyTextTask, type TextCapabilities, type TextMessage, type TextOriginal, type TextTask } from '../../../packages/protocol/text.mjs';
import { documentDigest } from '../../../packages/protocol/model-validation.mjs';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';

type Record = { version: 1; original: TextOriginal; rejected_code: string | null; discard_intents: string[] };
type Context = { epoch: number; signal: AbortSignal };
type ViewTask = Omit<TextTask, 'output'> & { output: Omit<NonNullable<TextTask['output']>, 'text'> | null };
type Conversation = { messages: TextMessage[]; expires: number };
const emptyConversation = (): Conversation => ({ messages: [], expires: Infinity });
const states = { running: '正在生成', succeeded: '回答已完成', failed: '生成未完成', unknown: '结果待核实', discarded: '已放弃输出' };

export function TextGeneration({ prefix, session, online, onError }: { prefix: string; session: Session; online: boolean; onError: (error: unknown) => void }) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.text:${prefix}`;
  const [record, setRecord] = useState<Record | null>(null), [task, setTask] = useState<ViewTask | null>(null), [result, setResult] = useState<string | null>(null), [prompt, setPrompt] = useState('');
  const [conversation, setConversation] = useState<Conversation>(emptyConversation), [capability, setCapability] = useState<TextCapabilities | null>(null);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState(''), [confirmation, setConfirmation] = useState(false);
  const active = useRef(false), epoch = useRef(0), abort = useRef(new AbortController()), working = useRef<symbol | null>(null), observed = useRef<ViewTask | null>(null), currentOnline = useRef(online);
  const history = useRef<Conversation>(emptyConversation()), turn = useRef<{ key: string; messages: TextMessage[]; expires: number } | null>(null);
  currentOnline.current = online;
  const valid = (context: Context) => active.current && epoch.current === context.epoch && currentOnline.current && !document.hidden && !context.signal.aborted;
  function clearConversation() { history.current = emptyConversation(); turn.current = null; setConversation(history.current); setPrompt(''); }
  function read(): Record | null {
    try {
      const raw = localStorage.getItem(storage); if (raw === null) { setRecord(null); return null; }
      const value = parseBoundedJSON(raw, { maxBytes: 8192, maxDepth: 5, maxNodes: 128 }) as Record;
      if (!value || Object.keys(value).sort().join(',') !== 'discard_intents,original,rejected_code,version' || value.version !== 1 || !validTextOriginal(value.original, location.origin, space, value.original?.idempotency_key) || !(value.rejected_code === null || typeof value.rejected_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.rejected_code)) || !Array.isArray(value.discard_intents) || value.discard_intents.length > 8 || new Set(value.discard_intents).size !== value.discard_intents.length || !value.discard_intents.every(key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key))) throw new Error();
      setRecord(value); return value;
    } catch { throw new Error('text_record_unavailable'); }
  }
  function save(value: Record, previous: Record | null) {
    try {
      const raw = localStorage.getItem(storage); if (raw === null ? previous !== null : previous === null || !sameJSON(parseBoundedJSON(raw, { maxBytes: 8192 }), previous)) throw new Error();
      const encoded = JSON.stringify(value); localStorage.setItem(storage, encoded); if (localStorage.getItem(storage) !== encoded) throw new Error(); setRecord(value);
    } catch { throw new Error('text_record_unavailable'); }
  }
  async function accept(raw: unknown, original: TextOriginal, context: Context, reveal = true) {
    const value = await verifyTextTask(raw, space, original.idempotency_key, original); if (!valid(context)) return;
    const prior = observed.current;
    if (prior?.idempotency_key === value.idempotency_key && (prior.text_id !== value.text_id || !sameJSON(prior.deployment, value.deployment) || prior.created_at !== value.created_at || Date.parse(value.updated_at) < Date.parse(prior.updated_at) || ['failed', 'succeeded', 'discarded'].includes(prior.status) && prior.status !== value.status || prior.status === 'unknown' && !['unknown', 'discarded'].includes(value.status) || prior.output && (!value.output || prior.output.content_digest !== value.output.content_digest || prior.output.expires_at !== value.output.expires_at || prior.output.cleared_at !== null && value.output.cleared_at !== prior.output.cleared_at))) throw new Error('invalid_text_response');
    const output = value.output ? { content_digest: value.output.content_digest, expires_at: value.output.expires_at, cleared_at: value.output.cleared_at } : null;
    const next = { ...value, output }; observed.current = next; setTask(next);
    const text = reveal && value.output && Date.parse(value.output.expires_at) > Date.now() ? value.output.text : null; setResult(text);
    if (text !== null && turn.current?.key === value.idempotency_key && value.output) {
      const expires = Math.min(turn.current.expires, Date.parse(value.output.expires_at));
      if (expires > Date.now()) { history.current = { messages: [...turn.current.messages, { role: 'assistant', content: text }], expires }; setConversation(history.current); }
      turn.current = null;
    }
    if (value.status === 'discarded' || value.output?.cleared_at) clearConversation();
  }
  async function resolve(original: TextOriginal, context: Context, reveal = true) {
    await accept(await request<unknown>(`${prefix}/text-generations/by-key/${encodeURIComponent(original.idempotency_key)}`, session, undefined, { signal: context.signal }), original, context, reveal);
  }
  async function refresh(context: Context) {
    setReady(false); const value = read();
    if (value && value.original.request_digest !== await documentDigest({ space_id: space, idempotency_key: value.original.idempotency_key, input: value.original.input })) throw new Error('text_record_unavailable');
    const raw = await request<{ text: unknown }>(`${prefix}/capabilities`, session, undefined, { signal: context.signal });
    const next = verifyTextCapabilities(raw.text); if (!valid(context)) return; setCapability(next);
    if (value && value.rejected_code === null) { try { await resolve(value.original, context, false); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; } }
    if (valid(context)) setReady(true);
  }
  async function run(work: (context: Context) => Promise<void>) {
    if (working.current || !active.current || !currentOnline.current || document.hidden) return;
    const token = Symbol(), context = { epoch: epoch.current, signal: abort.current.signal }; working.current = token; setBusy(true); setMessage('');
    try { await work(context); }
    catch (error) {
      if (!valid(context)) return;
      if (error instanceof Error && ['text_record_unavailable', 'invalid_text_response'].includes(error.message)) { setBlocked(true); setReady(false); setResult(null); clearConversation(); setMessage(error.message === 'text_record_unavailable' ? '对话记录不可用，已暂停新请求' : '回答未通过校验，请保留原任务'); }
      else { setMessage(error instanceof Error && error.message === 'text_lock_unavailable' ? '当前浏览器不支持安全提交对话' : errorText(error)); if (error instanceof ApiError && error.status === 401) onError(error); }
    } finally { if (working.current === token) { working.current = null; if (valid(context)) setBusy(false); } }
  }
  useEffect(() => {
    active.current = true;
    const invalidate = () => { epoch.current++; abort.current.abort(); abort.current = new AbortController(); working.current = null; observed.current = null; setTask(null); setResult(null); clearConversation(); setConfirmation(false); setBusy(false); setReady(false); };
    invalidate(); if (online && !document.hidden) void run(refresh);
    const visibility = () => { invalidate(); if (!document.hidden && currentOnline.current) void run(refresh); };
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === storage) { invalidate(); if (currentOnline.current && !document.hidden) void run(refresh); } };
    document.addEventListener('visibilitychange', visibility); addEventListener('storage', changed);
    return () => { active.current = false; epoch.current++; abort.current.abort(); working.current = null; observed.current = null; history.current = emptyConversation(); turn.current = null; document.removeEventListener('visibilitychange', visibility); removeEventListener('storage', changed); };
  }, [online, session.csrf_token]);
  useEffect(() => {
    if (!online || !ready || busy || blocked || !record || !task) return;
    if (task.status === 'running') { const timer = setTimeout(() => void run(context => resolve(record.original, context)), 1000); return () => clearTimeout(timer); }
    if (result !== null && task.output) { const timer = setTimeout(() => setResult(null), Math.max(0, Date.parse(task.output.expires_at) - Date.now())); return () => clearTimeout(timer); }
  }, [online, ready, busy, blocked, task, record, result]);
  useEffect(() => {
    if (!Number.isFinite(conversation.expires)) return;
    const timer = setTimeout(() => { clearConversation(); setResult(null); }, Math.max(0, conversation.expires - Date.now())); return () => clearTimeout(timer);
  }, [conversation]);
  async function locked(work: () => Promise<void>) {
    if (!navigator.locks) throw new Error('text_lock_unavailable');
    await navigator.locks.request(storage, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new ApiError('text_busy', 429); await work(); });
  }
  const pending = (value: Record | null) => value !== null && value.rejected_code === null && (!observed.current || observed.current.idempotency_key !== value.original.idempotency_key || ['running', 'unknown'].includes(observed.current.status));
  async function create(context: Context) {
    await locked(async () => {
      const previous = read(); if (!valid(context)) return;
      if (blocked || pending(previous)) throw new ApiError('text_busy', 429);
      const current = history.current.expires > Date.now() ? history.current : emptyConversation();
      let input; try { input = parseTextInput(JSON.stringify({ instructions: '', messages: [...current.messages, { role: 'user', content: prompt }], retain_seconds: 600, expires_at: new Date(Date.now() + 85000).toISOString() })); } catch { throw new ApiError('invalid_text_request', 422); }
      const original = await createTextOriginal(location.origin, space, crypto.randomUUID(), input); if (!valid(context)) return;
      const value: Record = { version: 1, original, rejected_code: null, discard_intents: [] }; save(value, previous);
      turn.current = { key: original.idempotency_key, messages: input.messages, expires: current.expires }; observed.current = null; setTask(null); setResult(null); setConfirmation(false); setPrompt('');
      if (!valid(context)) return;
      try { await accept(await request<unknown>(`${prefix}/text-generations`, session, input, { signal: context.signal, key: original.idempotency_key }), original, context); }
      catch (error) { if (!valid(context)) return; if (error instanceof ApiError && error.definitiveRejection) { save({ ...value, rejected_code: error.code }, value); turn.current = null; throw error; } setMessage('回答结果待核实，请查询原任务'); if (error instanceof ApiError && error.status === 401) onError(error); }
    });
  }
  async function discard(context: Context) {
    await locked(async () => {
      const value = read(); if (!valid(context)) return;
      if (!value || value.discard_intents.length >= 8) throw new Error('text_record_unavailable');
      save({ ...value, discard_intents: [...value.discard_intents, crypto.randomUUID()] }, value); setConfirmation(false); setResult(null); clearConversation();
      if (!valid(context)) return;
      await accept(await request<unknown>(`${prefix}/text-generations/by-key/${encodeURIComponent(value.original.idempotency_key)}/discard`, session, {}, { signal: context.signal }), value.original, context);
    });
  }
  const disabled = !online || busy || blocked || !ready, cleared = task?.output && (task.output.cleared_at !== null || Date.parse(task.output.expires_at) <= Date.now());
  return <section className="text-generation" aria-label="本地对话"><div className="section-heading"><h2>本地对话</h2><button disabled={!online || busy || blocked} onClick={() => void run(refresh)}>读取对话状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}{capability && !capability.configured && <p className="muted">网关尚未配置本地文字模型</p>}
    {conversation.messages.length > 0 && <div className="conversation" aria-label="本页对话">{conversation.messages.map((item, index) => <p key={index}><strong>{item.role === 'user' ? '你' : '助手'}</strong><span aria-label={index === conversation.messages.length - 1 ? '回答结果' : undefined}>{item.content}</span></p>)}</div>}
    {capability?.configured && <form className="text-form" onSubmit={event => { event.preventDefault(); void run(create); }}><label htmlFor="text-prompt">消息</label><textarea id="text-prompt" rows={3} maxLength={4096} value={prompt} disabled={disabled || pending(record)} onChange={event => setPrompt(event.target.value)} /><div className="actions"><button className="primary" disabled={disabled || pending(record) || !prompt.trim() || conversation.messages.length >= 15}>发送</button><button type="button" disabled={disabled || pending(record)} onClick={() => { clearConversation(); setResult(null); }}>开始新对话</button></div>{conversation.messages.length >= 15 && <p className="muted">本轮上下文已满，请开始新对话</p>}</form>}
    {record && <article className="registry-row vision-task" aria-label="最近文字任务"><div><strong>{task ? states[task.status] : record.rejected_code ? '请求未受理' : '结果待核实'}</strong>{task?.error_code && <p className="muted">{errorText(new ApiError(task.error_code, 422))}</p>}{result !== null && !cleared && conversation.messages.length === 0 && <p aria-label="回答结果" className="text-answer">{result}</p>}{cleared && <p className="muted">回答已清除</p>}{task?.status === 'succeeded' && !cleared && result === null && <p className="muted">查询原任务可查看回答</p>}<details><summary>任务详情</summary><dl><dt>原请求编号</dt><dd>{record.original.idempotency_key}</dd><dt>模型</dt><dd>{task?.deployment.model ?? '待核实'}</dd></dl></details></div><div className="actions"><button disabled={!online || busy || blocked} onClick={() => void run(context => resolve(record.original, context))}>查询原任务</button>{task && (['running', 'unknown'].includes(task.status) || task.status === 'succeeded' && !cleared) && <button disabled={disabled} onClick={() => setConfirmation(true)}>{task.status === 'succeeded' ? '清除回答' : '放弃生成输出'}</button>}</div></article>}
    {confirmation && <div className="notice" role="group" aria-label="确认清除文字输出"><p>{task?.status === 'succeeded' ? '清除此任务保存的回答。' : '放弃此生成输出。外部模型可能继续计算。'}</p><div className="actions"><button disabled={disabled} onClick={() => void run(discard)}>确认清除输出</button><button disabled={busy} onClick={() => setConfirmation(false)}>取消</button></div></div>}
  </section>;
}

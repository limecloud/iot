import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request, type Session } from './api';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';
import { createTranscriptionOriginal, validTranscriptionOriginal, verifyTranscriptionCapabilities, verifyTranscriptionTask, type TranscriptionCapabilities, type TranscriptionOriginal, type TranscriptionTask } from '../../../packages/protocol/transcription.mjs';
import type { MediaPage } from '../../../packages/protocol/media.mjs';

type Record = { version: 1; original: TranscriptionOriginal; rejected_code: string | null; discard_intents: string[] };
type Context = { epoch: number; signal: AbortSignal };
const states = { running: '正在识别', succeeded: '识别完成', failed: '识别失败', unknown: '结果未知', discarded: '已放弃输出' };
export function Transcription({ prefix, session, online, files, onError }: { prefix: string; session: Session; online: boolean; files: MediaPage['items']; onError: (error: unknown) => void }) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.transcription:${prefix}`;
  const [capability, setCapability] = useState<TranscriptionCapabilities | null>(null), [record, setRecord] = useState<Record | null>(null), [task, setTask] = useState<TranscriptionTask | null>(null);
  const [mediaID, setMediaID] = useState(''), [language, setLanguage] = useState('auto'), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [blocked, setBlocked] = useState(false), [confirmation, setConfirmation] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false), epoch = useRef(0), abort = useRef(new AbortController()), working = useRef<symbol | null>(null), known = useRef<string | null | undefined>(undefined), observed = useRef<TranscriptionTask | null>(null);
  const currentOnline = useRef(online); currentOnline.current = online;
  const valid = (context: Context) => active.current && currentOnline.current && !document.hidden && epoch.current === context.epoch && !context.signal.aborted;
  function read(): Record | null {
    try {
      const raw = localStorage.getItem(storage);
      if (known.current !== undefined && raw !== known.current) throw new Error();
      const value = raw === null ? null : parseBoundedJSON(raw, { maxBytes: 8192, maxDepth: 5, maxNodes: 128 }) as Record;
      if (value !== null && (!value || Object.keys(value).sort().join(',') !== 'discard_intents,original,rejected_code,version' || value.version !== 1 || !validTranscriptionOriginal(value.original, location.origin, space, value.original?.idempotency_key) || value.rejected_code !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(value.rejected_code) || !Array.isArray(value.discard_intents) || value.discard_intents.length > 8 || !value.discard_intents.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(value.discard_intents).size !== value.discard_intents.length)) throw new Error();
      known.current = raw; setRecord(value); return value;
    } catch { throw new Error('transcription_record_unavailable'); }
  }
  function save(value: Record, previous: Record | null) {
    try {
      if (!sameJSON(read(), previous)) throw new Error();
      const raw = JSON.stringify(value); localStorage.setItem(storage, raw);
      if (localStorage.getItem(storage) !== raw) throw new Error();
      known.current = raw; setRecord(value);
    } catch { throw new Error('transcription_record_unavailable'); }
  }
  async function accept(raw: unknown, original: TranscriptionOriginal, context: Context) {
    const value = await verifyTranscriptionTask(raw, space, original.idempotency_key, original);
    if (!valid(context)) return;
    const prior = observed.current;
    if (prior?.idempotency_key === value.idempotency_key && (prior.transcription_id !== value.transcription_id || !sameJSON(prior.deployment, value.deployment) || prior.created_at !== value.created_at || ['failed', 'succeeded', 'discarded'].includes(prior.status) && prior.status !== value.status || prior.status === 'unknown' && !['unknown', 'discarded'].includes(value.status) || prior.output && (!value.output || prior.output.content_digest !== value.output.content_digest || prior.output.expires_at !== value.output.expires_at || prior.output.cleared_at !== null && value.output.cleared_at !== prior.output.cleared_at))) throw new Error('invalid_transcription_response');
    observed.current = value; setTask(value);
  }
  async function resolve(original: TranscriptionOriginal, context: Context) {
    await accept(await request<unknown>(`${prefix}/audio-transcriptions/by-key/${encodeURIComponent(original.idempotency_key)}`, session, undefined, { signal: context.signal }), original, context);
  }
  async function refresh(context: Context) {
    setReady(false); const value = read();
    const raw = await request<{ transcription: unknown }>(`${prefix}/capabilities`, session, undefined, { signal: context.signal });
    const next = verifyTranscriptionCapabilities(raw.transcription); if (!valid(context)) return;
    setCapability(next);
    if (value && value.rejected_code === null) { try { await resolve(value.original, context); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; } }
    if (valid(context)) setReady(true);
  }
  async function run(work: (context: Context) => Promise<void>) {
    if (working.current || !active.current || !currentOnline.current || document.hidden) return;
    const token = Symbol(), context = { epoch: epoch.current, signal: abort.current.signal }; working.current = token; setBusy(true); setMessage('');
    try { await work(context); }
    catch (error) {
      if (!valid(context)) return;
      if (error instanceof Error && ['transcription_record_unavailable', 'invalid_transcription_response'].includes(error.message)) { setBlocked(true); setReady(false); setMessage(error.message === 'transcription_record_unavailable' ? '识别记录不可用，已暂停新请求' : '识别结果未通过校验，请保留原任务'); }
      else { setMessage(error instanceof Error && error.message === 'transcription_lock_unavailable' ? '当前浏览器不支持安全提交识别任务' : errorText(error)); if (error instanceof ApiError && error.status === 401) onError(error); }
    } finally { if (working.current === token) { working.current = null; if (valid(context)) setBusy(false); } }
  }
  useEffect(() => {
    active.current = true;
    const invalidate = () => { epoch.current++; abort.current.abort(); abort.current = new AbortController(); working.current = null; observed.current = null; setTask(null); setConfirmation(false); setBusy(false); setReady(false); };
    invalidate(); if (online && !document.hidden) void run(refresh);
    const visibility = () => { invalidate(); if (!document.hidden && currentOnline.current) void run(refresh); };
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === storage) { invalidate(); if (currentOnline.current && !document.hidden) void run(refresh); } };
    document.addEventListener('visibilitychange', visibility); addEventListener('storage', changed);
    return () => { active.current = false; epoch.current++; abort.current.abort(); working.current = null; observed.current = null; document.removeEventListener('visibilitychange', visibility); removeEventListener('storage', changed); };
  }, [online, session.csrf_token]);
  useEffect(() => {
    if (!online || !ready || busy || blocked || !record || !task) return;
    const delay = task.status === 'running' ? 1000 : task.output?.text !== null && task.output ? Math.max(0, Date.parse(task.output.expires_at) - Date.now()) : null;
    if (delay === null) return;
    const timer = setTimeout(() => { if (task.status === 'succeeded') { observed.current = null; setTask(null); } void run(context => resolve(record.original, context)); }, delay);
    return () => clearTimeout(timer);
  }, [online, ready, busy, blocked, task, record]);
  async function locked(work: () => Promise<void>) {
    if (!navigator.locks) throw new Error('transcription_lock_unavailable');
    await navigator.locks.request(storage, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new ApiError('transcription_busy', 429); await work(); });
  }
  const pending = (value: Record | null) => value !== null && value.rejected_code === null && (!observed.current || observed.current.idempotency_key !== value.original.idempotency_key || ['running', 'unknown'].includes(observed.current.status));
  async function create(context: Context) {
    await locked(async () => {
      const previous = read(); if (!valid(context)) return;
      if (blocked || pending(previous)) throw new ApiError('transcription_busy', 429);
      const source = files.find(item => item.metadata.media_id === mediaID && item.available && Date.parse(item.metadata.expires_at) > Date.now());
      if (!source) throw new ApiError('transcription_source_unavailable', 422);
      const input = { media_id: mediaID, media_digest: source.metadata.content_digest, language: language as 'auto' | 'zh' | 'en', expires_at: new Date(Date.now() + 85000).toISOString() };
      const original = await createTranscriptionOriginal(location.origin, space, crypto.randomUUID(), input);
      if (!valid(context)) return;
      const value: Record = { version: 1, original, rejected_code: null, discard_intents: [] }; save(value, previous); observed.current = null; setTask(null); setConfirmation(false);
      if (!valid(context)) return;
      try { await accept(await request<unknown>(`${prefix}/audio-transcriptions`, session, input, { signal: context.signal, key: original.idempotency_key }), original, context); }
      catch (error) { if (!valid(context)) return; if (error instanceof ApiError && error.definitiveRejection) { save({ ...value, rejected_code: error.code }, value); throw error; } setMessage('识别结果待核实，请查询原任务'); if (error instanceof ApiError && error.status === 401) onError(error); }
    });
  }
  async function discard(context: Context) {
    await locked(async () => {
      const value = read(); if (!valid(context)) return;
      if (!value || value.discard_intents.length >= 8) throw new Error('transcription_record_unavailable');
      save({ ...value, discard_intents: [...value.discard_intents, crypto.randomUUID()] }, value); setConfirmation(false);
      if (!valid(context)) return;
      await accept(await request<unknown>(`${prefix}/audio-transcriptions/by-key/${encodeURIComponent(value.original.idempotency_key)}/discard`, session, {}, { signal: context.signal }), value.original, context);
    });
  }
  const available = files.filter(item => item.available && Date.parse(item.metadata.expires_at) > Date.now()), disabled = !online || busy || blocked || !ready;
  return <section className="rule-editor audio-transcription" aria-label="语音识别"><h2>语音识别</h2><div className="actions"><button disabled={!online || busy || blocked} onClick={() => void run(refresh)}>读取识别状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}{capability && !capability.configured && <p className="muted">网关尚未配置本地识别服务</p>}
    {capability?.configured && <form onSubmit={event => { event.preventDefault(); void run(create); }}><label htmlFor="transcription-media">录音</label><select id="transcription-media" value={mediaID} disabled={disabled || pending(record)} onChange={event => setMediaID(event.target.value)}><option value="">选择已上传录音</option>{available.map(item => <option key={item.metadata.media_id} value={item.metadata.media_id}>音频 {item.metadata.media_id.slice(-8)}</option>)}</select><label htmlFor="transcription-language">语言</label><select id="transcription-language" value={language} disabled={disabled || pending(record)} onChange={event => setLanguage(event.target.value)}><option value="auto">自动识别</option><option value="zh">中文</option><option value="en">英语</option></select><button disabled={disabled || pending(record) || !available.some(item => item.metadata.media_id === mediaID)}>识别录音</button></form>}
    {record && <article className="registry-row" aria-label="最近识别任务"><div><strong>{task ? states[task.status] : record.rejected_code ? '请求未受理' : '结果待核实'}</strong>{task?.error_code && <p className="muted">{errorText(new ApiError(task.error_code, 422))}</p>}{task?.output && (task.output.text === null || Date.parse(task.output.expires_at) <= Date.now() ? <p className="muted">识别文本已清除</p> : <p aria-label="识别文本" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.output.text || '未识别到语音'}</p>)}<details><summary>任务详情</summary><dl><dt>原请求编号</dt><dd>{record.original.idempotency_key}</dd><dt>录音编号</dt><dd>{record.original.input.media_id}</dd></dl></details></div><div className="actions"><button disabled={!online || busy || blocked} onClick={() => void run(context => resolve(record.original, context))}>查询原任务</button>{task && ['running', 'unknown'].includes(task.status) && <button disabled={disabled} onClick={() => setConfirmation(true)}>放弃识别输出</button>}</div></article>}
    {confirmation && <div className="notice" role="group" aria-label="确认放弃识别输出"><p>放弃此识别输出。外部引擎可能继续计算。</p><div className="actions"><button disabled={disabled} onClick={() => void run(discard)}>确认放弃识别输出</button><button disabled={busy} onClick={() => setConfirmation(false)}>取消</button></div></div>}
  </section>;
}

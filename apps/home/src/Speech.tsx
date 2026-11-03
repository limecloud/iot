import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request, type Session } from './api';
import { createSpeechOriginal, parseSpeechInput, validSpeechOriginal, verifySpeechCapabilities, verifySpeechTask, type SpeechCapabilities, type SpeechOriginal, type SpeechTask } from '../../../packages/protocol/speech.mjs';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';

type Record = { version: 1; original: SpeechOriginal; rejected_code: string | null; discard_intents: string[] };
type Context = { epoch: number; signal: AbortSignal };
const states = { running: '正在生成', succeeded: '生成完成', failed: '生成失败', unknown: '结果未知', discarded: '已放弃输出' };
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function Speech({ prefix, session, online, onError, onGenerated }: { prefix: string; session: Session; online: boolean; onError: (error: unknown) => void; onGenerated: (id: string) => void }) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.speech:${prefix}:`;
  const [capabilities, setCapabilities] = useState<SpeechCapabilities | null>(null), [records, setRecords] = useState<Record[]>([]), [results, setResults] = useState<{ [key: string]: SpeechTask }>({});
  const [text, setText] = useState(''), [voice, setVoice] = useState(''), [retention, setRetention] = useState('600');
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState(''), [confirmation, setConfirmation] = useState<string | null>(null);
  const active = useRef(false), epoch = useRef(0), abort = useRef(new AbortController()), working = useRef<symbol | null>(null), known = useRef<Record[]>([]), observed = useRef<{ [key: string]: SpeechTask }>({});
  const currentOnline = useRef(online); currentOnline.current = online;
  const generated = useRef(onGenerated); generated.current = onGenerated;
  const valid = (context: Context) => active.current && context.epoch === epoch.current && currentOnline.current && !document.hidden && !context.signal.aborted;
  function readRecords() {
    try {
      const found: Record[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i); if (!key?.startsWith(storage)) continue;
        const item = parseBoundedJSON(localStorage.getItem(key) ?? '', { maxBytes: 8192, maxDepth: 5, maxNodes: 128 }) as Record;
        if (!item || Object.keys(item).sort().join(',') !== 'discard_intents,original,rejected_code,version' || item.version !== 1 || !validSpeechOriginal(item.original, location.origin, space, key.slice(storage.length)) || item.rejected_code !== null && (typeof item.rejected_code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item.rejected_code)) || !Array.isArray(item.discard_intents) || item.discard_intents.length > 8 || !item.discard_intents.every(identifier) || new Set(item.discard_intents).size !== item.discard_intents.length) throw new Error('speech_record_unavailable');
        found.push(item);
      }
      if (found.length > 128 || known.current.some(old => {
        const next = found.find(item => item.original.idempotency_key === old.original.idempotency_key);
        return !next || !sameJSON(old.original, next.original) || old.rejected_code !== null && next.rejected_code !== old.rejected_code || old.discard_intents.some((id, index) => next.discard_intents[index] !== id);
      })) throw new Error('speech_record_unavailable');
      found.sort((a, b) => Date.parse(b.original.expires_at) - Date.parse(a.original.expires_at));
      known.current = found; if (active.current) setRecords(found); return found;
    } catch { throw new Error('speech_record_unavailable'); }
  }
  function save(record: Record, previous?: Record) {
    try {
      const stored = readRecords().find(item => item.original.idempotency_key === record.original.idempotency_key);
      if (previous ? !stored || !sameJSON(stored, previous) : stored !== undefined) throw new Error();
      const key = storage + record.original.idempotency_key, serialized = JSON.stringify(record);
      localStorage.setItem(key, serialized);
      if (localStorage.getItem(key) !== serialized) throw new Error();
      readRecords();
    } catch { throw new Error('speech_record_unavailable'); }
  }
  function accept(task: SpeechTask, context: Context, select = false) {
    if (!valid(context)) return;
    const prior = observed.current[task.idempotency_key];
    observed.current = { ...observed.current, [task.idempotency_key]: task }; setResults(observed.current);
    if (task.status === 'succeeded' && task.media_id && (select || prior?.status === 'running')) generated.current(task.media_id);
  }
  async function resolve(original: SpeechOriginal, context: Context, select = false) {
    const value = await request<unknown>(`${prefix}/speech-syntheses/by-key/${encodeURIComponent(original.idempotency_key)}`, session, undefined, { signal: context.signal });
    accept(verifySpeechTask(value, space, original.idempotency_key, original), context, select);
  }
  async function refresh(context: Context) {
    setReady(false);
    const entries = readRecords(), raw = await request<{ speech: unknown }>(`${prefix}/capabilities`, session, undefined, { signal: context.signal });
    const capability = verifySpeechCapabilities(raw.speech);
    if (!valid(context)) return;
    setCapabilities(capability);
    setVoice(previous => capability.configured && capability.voices.includes(previous) ? previous : capability.configured ? capability.voices[0] : '');
    for (let start = 0; start < entries.length; start += 4) {
      if (!valid(context)) return;
      await Promise.all(entries.slice(start, start + 4).filter(item => item.rejected_code === null).map(async item => {
        try { await resolve(item.original, context); }
        catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      }));
    }
    if (valid(context)) setReady(true);
  }
  async function run(work: (context: Context) => Promise<void>) {
    if (working.current || !active.current || !currentOnline.current || document.hidden) return;
    const token = Symbol(), context = { epoch: epoch.current, signal: abort.current.signal }; working.current = token; setBusy(true); setMessage('');
    try { await work(context); }
    catch (error) {
      if (!valid(context)) return;
      if (error instanceof Error && error.message === 'speech_record_unavailable') { setBlocked(true); setReady(false); setMessage('语音记录不可用，已暂停新请求'); }
      else if (error instanceof Error && error.message === 'invalid_speech_request') setMessage('请填写 1000 字以内的文本，并检查声音和保留时间');
      else if (error instanceof Error && error.message === 'speech_browser_lock_unavailable') { setReady(false); setMessage('当前浏览器不支持安全提交语音任务'); }
      else if (error instanceof Error && error.message === 'invalid_speech_response') { setReady(false); setMessage('语音结果未通过校验，请查询原任务'); }
      else { setMessage(errorText(error)); if (error instanceof ApiError && error.status === 401) onError(error); }
    } finally { if (working.current === token) { working.current = null; if (valid(context)) setBusy(false); } }
  }
  useEffect(() => {
    active.current = true;
    const invalidate = () => { epoch.current++; abort.current.abort(); abort.current = new AbortController(); working.current = null; setBusy(false); setReady(false); setText(''); setConfirmation(null); };
    invalidate(); if (online && !document.hidden) void run(refresh);
    const visibility = () => { invalidate(); if (!document.hidden && currentOnline.current) void run(refresh); };
    const changed = (event: StorageEvent) => { if (event.key !== null && !event.key.startsWith(storage)) return; if (!document.hidden && currentOnline.current) void run(refresh); };
    document.addEventListener('visibilitychange', visibility); addEventListener('storage', changed);
    return () => { active.current = false; epoch.current++; abort.current.abort(); working.current = null; document.removeEventListener('visibilitychange', visibility); removeEventListener('storage', changed); };
  }, [online, session.csrf_token]);
  useEffect(() => {
    if (!online || !ready || blocked || busy) return;
    const running = records.find(item => results[item.original.idempotency_key]?.status === 'running');
    if (!running) return;
    const timer = setTimeout(() => void run(context => resolve(running.original, context)), 1000);
    return () => clearTimeout(timer);
  }, [records, results, ready, blocked, busy, online]);
  async function locked(work: () => Promise<void>) {
    if (!navigator.locks) throw new Error('speech_browser_lock_unavailable');
    await navigator.locks.request(storage, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new ApiError('speech_busy', 429); await work(); });
  }
  const pending = (entries: Record[]) => entries.some(item => item.rejected_code === null && (!observed.current[item.original.idempotency_key] || ['running', 'unknown'].includes(observed.current[item.original.idempotency_key].status)));
  async function generate(context: Context) {
    await locked(async () => {
      if (!valid(context)) return;
      const entries = readRecords(); if (blocked || entries.length >= 128) throw new Error('speech_record_unavailable');
      if (pending(entries)) throw new ApiError('speech_busy', 429);
      const input = parseSpeechInput(JSON.stringify({ text, voice, retain_seconds: Number(retention), expires_at: new Date(Date.now() + 85000).toISOString() }));
      const original = await createSpeechOriginal(location.origin, space, crypto.randomUUID(), input);
      if (!valid(context)) return;
      const record: Record = { version: 1, original, rejected_code: null, discard_intents: [] }; save(record); setText('');
      if (!valid(context)) return;
      try {
        const value = await request<unknown>(`${prefix}/speech-syntheses`, session, input, { signal: context.signal, key: original.idempotency_key });
        accept(verifySpeechTask(value, space, original.idempotency_key, original), context, true);
      } catch (error) {
        if (!valid(context)) return;
        if (error instanceof ApiError && error.definitiveRejection) { save({ ...record, rejected_code: error.code }, record); throw error; }
        setMessage('生成结果待核实，请查询原任务'); if (error instanceof ApiError && error.status === 401) onError(error);
      }
    });
  }
  async function discard(key: string, context: Context) {
    await locked(async () => {
      if (!valid(context)) return;
      const record = readRecords().find(item => item.original.idempotency_key === key);
      if (!record || record.discard_intents.length >= 8) throw new Error('speech_record_unavailable');
      save({ ...record, discard_intents: [...record.discard_intents, crypto.randomUUID()] }, record); setConfirmation(null);
      if (!valid(context)) return;
      try {
        const raw = await request<unknown>(`${prefix}/speech-syntheses/by-key/${encodeURIComponent(key)}/discard`, session, {}, { signal: context.signal });
        accept(verifySpeechTask(raw, space, key, record.original), context);
      } catch (error) { if (!valid(context)) return; if (error instanceof ApiError && error.definitiveRejection) throw error; setMessage('放弃请求结果待核实，请查询原任务'); }
    });
  }
  const disabled = !online || busy || blocked || !ready, unresolved = pending(records);
  return <section className="rule-editor speech-generation" aria-label="文字转语音"><h2>文字转语音</h2>
    <div className="actions"><button disabled={!online || busy || blocked} onClick={() => void run(refresh)}>读取语音状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}
    {capabilities && !capabilities.configured && <p className="muted">网关尚未配置本地语音服务</p>}
    {capabilities?.configured && <form onSubmit={event => { event.preventDefault(); void run(generate); }}>
      <label htmlFor="speech-text">文本</label><textarea id="speech-text" rows={3} maxLength={4096} value={text} disabled={disabled || unresolved} onChange={event => setText(event.target.value)} />
      <label htmlFor="speech-voice">声音</label><select id="speech-voice" value={voice} disabled={disabled || unresolved || capabilities.voices.length === 1} onChange={event => setVoice(event.target.value)}>{capabilities.voices.map(item => <option key={item} value={item}>{item}</option>)}</select>
      <label htmlFor="speech-retention">保留时间</label><select id="speech-retention" value={retention} disabled={disabled || unresolved} onChange={event => setRetention(event.target.value)}><option value="600">10 分钟</option><option value="3600">1 小时</option><option value="86400">24 小时</option></select>
      <button disabled={disabled || unresolved || !text.trim() || Array.from(text).length > 1000}>生成音频</button>
    </form>}
    {records.length > 0 && <div aria-label="语音任务">{records.map(item => { const key = item.original.idempotency_key, task = results[key]; return <article className="registry-row" key={key} aria-label={`语音任务 ${key}`}><div><strong>{task ? states[task.status] : item.rejected_code ? '请求未受理' : '结果待核实'}</strong><p className="muted">{item.original.input_characters} 字，{item.original.voice}</p>{task?.error_code && <p className="muted">{errorText(new ApiError(task.error_code, 422))}</p>}<details><summary>任务详情</summary><dl><dt>原请求编号</dt><dd>{key}</dd>{task?.media_id && <><dt>媒体编号</dt><dd>{task.media_id}</dd></>}</dl></details></div><div className="actions"><button disabled={!online || busy || blocked} onClick={() => void run(context => resolve(item.original, context, true))}>查询原任务</button>{task && ['running', 'unknown'].includes(task.status) && <button disabled={disabled} onClick={() => setConfirmation(key)}>放弃输出</button>}</div></article>; })}</div>}
    {confirmation && <div className="notice" role="group" aria-label="确认放弃语音输出"><p>放弃此音频输出。外部引擎可能继续计算。</p><div className="actions"><button disabled={disabled} onClick={() => void run(context => discard(confirmation, context))}>确认放弃输出</button><button disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div></div>}
  </section>;
}

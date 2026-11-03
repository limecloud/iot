import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request, type Session } from './api';
import { createVisionOriginal, validVisionOriginal, verifyVisionCapabilities, verifyVisionTask, type VisionCapabilities, type VisionOriginal, type VisionRequest, type VisionTask } from '../../../packages/protocol/vision.mjs';
import { documentDigest } from '../../../packages/protocol/model-validation.mjs';
import { sameJSON } from '../../../packages/protocol/products.mjs';

type Record = { version: 1; original: VisionOriginal; rejected_code: string | null; discard_intents: string[] };
type Context = { epoch: number; signal: AbortSignal };
type ViewTask = Omit<VisionTask, 'output'> & { output: Omit<NonNullable<VisionTask['output']>, 'text'> | null };
const states = { running: '正在观察', succeeded: '观察已完成', failed: '观察未完成', unknown: '结果待核实', discarded: '已放弃输出' };
export function Vision({ prefix, session, online, onError }: { prefix: string; session: Session; online: boolean; onError: (error: unknown) => void }) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.vision:${prefix}`;
  const [record, setRecord] = useState<Record | null>(null), [task, setTask] = useState<ViewTask | null>(null), [result, setResult] = useState<string | null>(null);
  const [image, setImage] = useState<{ base64: string; type: 'image/png' | 'image/jpeg'; name: string } | null>(null), [prompt, setPrompt] = useState('');
  const [capability, setCapability] = useState<VisionCapabilities | null>(null), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState(''), [confirmation, setConfirmation] = useState(false);
  const file = useRef<HTMLInputElement>(null), active = useRef(false), epoch = useRef(0), abort = useRef(new AbortController()), working = useRef<symbol | null>(null), observed = useRef<ViewTask | null>(null), currentOnline = useRef(online);
  currentOnline.current = online;
  const valid = (context: Context) => active.current && epoch.current === context.epoch && currentOnline.current && !document.hidden && !context.signal.aborted;
  function read(): Record | null {
    try {
      const raw = localStorage.getItem(storage); if (raw === null) { setRecord(null); return null; }
      if (raw.length > 8192) throw new Error();
      const value = JSON.parse(raw);
      if (!value || Object.keys(value).sort().join(',') !== 'discard_intents,original,rejected_code,version' || value.version !== 1 || !validVisionOriginal(value.original, location.origin, space, value.original?.idempotency_key) || !(value.rejected_code === null || typeof value.rejected_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.rejected_code)) || !Array.isArray(value.discard_intents) || value.discard_intents.length > 8 || new Set(value.discard_intents).size !== value.discard_intents.length || !value.discard_intents.every((key: unknown) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key))) throw new Error();
      setRecord(value); return value;
    } catch { throw new Error('vision_record_unavailable'); }
  }
  function save(value: Record, previous: Record | null) {
    try {
      const raw = localStorage.getItem(storage); if (raw === null ? previous !== null : previous === null || !sameJSON(JSON.parse(raw), previous)) throw new Error();
      const encoded = JSON.stringify(value); localStorage.setItem(storage, encoded); if (localStorage.getItem(storage) !== encoded) throw new Error(); setRecord(value);
    } catch { throw new Error('vision_record_unavailable'); }
  }
  async function accept(raw: unknown, original: VisionOriginal, context: Context, reveal = true) {
    const value = await verifyVisionTask(raw, space, original.idempotency_key, original); if (!valid(context)) return;
    const prior = observed.current;
    if (prior?.idempotency_key === value.idempotency_key && (prior.vision_id !== value.vision_id || !sameJSON(prior.deployment, value.deployment) || !sameJSON(prior.image, value.image) || prior.created_at !== value.created_at || ['failed', 'succeeded', 'discarded'].includes(prior.status) && prior.status !== value.status || prior.status === 'unknown' && !['unknown', 'discarded'].includes(value.status) || prior.output && (!value.output || prior.output.content_digest !== value.output.content_digest || prior.output.expires_at !== value.output.expires_at || prior.output.cleared_at !== null && value.output.cleared_at !== prior.output.cleared_at))) throw new Error('invalid_vision_response');
    const output = value.output ? { content_digest: value.output.content_digest, expires_at: value.output.expires_at, cleared_at: value.output.cleared_at } : null;
    const next = { ...value, output }; observed.current = next; setTask(next);
    setResult(reveal && value.output && Date.parse(value.output.expires_at) > Date.now() ? value.output.text : null);
  }
  async function resolve(original: VisionOriginal, context: Context, reveal = true) {
    await accept(await request<unknown>(`${prefix}/vision-observations/by-key/${encodeURIComponent(original.idempotency_key)}`, session, undefined, { signal: context.signal }), original, context, reveal);
  }
  async function refresh(context: Context) {
    setReady(false); const value = read();
    if (value && value.original.request_digest !== await documentDigest({ space_id: space, idempotency_key: value.original.idempotency_key, input: value.original.input })) throw new Error('vision_record_unavailable');
    const raw = await request<{ vision: unknown }>(`${prefix}/capabilities`, session, undefined, { signal: context.signal });
    const next = verifyVisionCapabilities(raw.vision); if (!valid(context)) return; setCapability(next);
    if (value && value.rejected_code === null) { try { await resolve(value.original, context, false); } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; } }
    if (valid(context)) setReady(true);
  }
  async function run(work: (context: Context) => Promise<void>) {
    if (working.current || !active.current || !currentOnline.current || document.hidden) return;
    const token = Symbol(), context = { epoch: epoch.current, signal: abort.current.signal }; working.current = token; setBusy(true); setMessage('');
    try { await work(context); }
    catch (error) {
      if (!valid(context)) return;
      if (error instanceof Error && ['vision_record_unavailable', 'invalid_vision_response'].includes(error.message)) { setBlocked(true); setReady(false); setResult(null); setMessage(error.message === 'vision_record_unavailable' ? '观察记录不可用，已暂停新请求' : '观察结果未通过校验，请保留原任务'); }
      else { setMessage(error instanceof Error && error.message === 'vision_lock_unavailable' ? '当前浏览器不支持安全提交观察任务' : errorText(error)); if (error instanceof ApiError && error.status === 401) onError(error); }
    } finally { if (working.current === token) { working.current = null; if (valid(context)) setBusy(false); } }
  }
  useEffect(() => {
    active.current = true;
    const invalidate = () => { epoch.current++; abort.current.abort(); abort.current = new AbortController(); working.current = null; observed.current = null; setTask(null); setResult(null); setImage(null); setPrompt(''); setConfirmation(false); setBusy(false); setReady(false); if (file.current) file.current.value = ''; };
    invalidate(); if (online && !document.hidden) void run(refresh);
    const visibility = () => { invalidate(); if (!document.hidden && currentOnline.current) void run(refresh); };
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === storage) { invalidate(); if (currentOnline.current && !document.hidden) void run(refresh); } };
    document.addEventListener('visibilitychange', visibility); addEventListener('storage', changed);
    return () => { active.current = false; epoch.current++; abort.current.abort(); working.current = null; observed.current = null; document.removeEventListener('visibilitychange', visibility); removeEventListener('storage', changed); };
  }, [online, session.csrf_token]);
  useEffect(() => {
    if (!online || !ready || busy || blocked || !record || !task) return;
    if (task.status === 'running') { const timer = setTimeout(() => void run(context => resolve(record.original, context)), 1000); return () => clearTimeout(timer); }
    if (result !== null && task.output) { const timer = setTimeout(() => setResult(null), Math.max(0, Date.parse(task.output.expires_at) - Date.now())); return () => clearTimeout(timer); }
  }, [online, ready, busy, blocked, task, record, result]);
  async function locked(work: () => Promise<void>) {
    if (!navigator.locks) throw new Error('vision_lock_unavailable');
    await navigator.locks.request(storage, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new ApiError('vision_busy', 429); await work(); });
  }
  const pending = (value: Record | null) => value !== null && value.rejected_code === null && (!observed.current || observed.current.idempotency_key !== value.original.idempotency_key || ['running', 'unknown'].includes(observed.current.status));
  async function selectImage(selected: File, context: Context) {
    setImage(null);
    if (!['image/png', 'image/jpeg'].includes(selected.type) || selected.size < 1 || selected.size > 2097152) throw new ApiError('invalid_vision_image', 422);
    const bitmap = await createImageBitmap(selected);
    const supported = bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= 1024 && bitmap.height <= 1024; bitmap.close();
    if (!supported) throw new ApiError('invalid_vision_image', 422);
    const bytes = new Uint8Array(await selected.arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    if (valid(context)) setImage({ base64: btoa(binary), type: selected.type as 'image/png' | 'image/jpeg', name: selected.name });
  }
  async function create(context: Context) {
    await locked(async () => {
      const previous = read(); if (!valid(context)) return;
      if (blocked || pending(previous)) throw new ApiError('vision_busy', 429);
      if (!image) throw new ApiError('invalid_vision_image', 422);
      const input: VisionRequest = { image_base64: image.base64, content_type: image.type, prompt, retain_seconds: 600, expires_at: new Date(Date.now() + 85000).toISOString() };
      const original = await createVisionOriginal(location.origin, space, crypto.randomUUID(), input); if (!valid(context)) return;
      const value: Record = { version: 1, original, rejected_code: null, discard_intents: [] }; save(value, previous); observed.current = null; setTask(null); setResult(null); setConfirmation(false); setImage(null); setPrompt(''); if (file.current) file.current.value = '';
      if (!valid(context)) return;
      try { await accept(await request<unknown>(`${prefix}/vision-observations`, session, input, { signal: context.signal, key: original.idempotency_key }), original, context); }
      catch (error) { if (!valid(context)) return; if (error instanceof ApiError && error.definitiveRejection) { save({ ...value, rejected_code: error.code }, value); throw error; } setMessage('观察结果待核实，请查询原任务'); if (error instanceof ApiError && error.status === 401) onError(error); }
    });
  }
  async function discard(context: Context) {
    await locked(async () => {
      const value = read(); if (!valid(context)) return;
      if (!value || value.discard_intents.length >= 8) throw new Error('vision_record_unavailable');
      save({ ...value, discard_intents: [...value.discard_intents, crypto.randomUUID()] }, value); setConfirmation(false); setResult(null);
      if (!valid(context)) return;
      await accept(await request<unknown>(`${prefix}/vision-observations/by-key/${encodeURIComponent(value.original.idempotency_key)}/discard`, session, {}, { signal: context.signal }), value.original, context);
    });
  }
  const disabled = !online || busy || blocked || !ready, cleared = task?.output && (task.output.cleared_at !== null || Date.parse(task.output.expires_at) <= Date.now());
  return <section className="vision-panel" aria-label="图片观察"><div className="section-heading"><h2>图片观察</h2><button disabled={!online || busy || blocked} onClick={() => void run(refresh)}>读取视觉状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}{capability && !capability.configured && <p className="muted">网关尚未配置本地视觉模型</p>}
    {capability?.configured && <form className="vision-form" onSubmit={event => { event.preventDefault(); void run(create); }}>
      <label htmlFor="vision-image">图片</label><div className="vision-file"><button type="button" disabled={disabled || pending(record)} onClick={() => file.current?.click()}>选择图片</button>{image && <span className="muted">{image.name}</span>}</div>
      <input ref={file} hidden id="vision-image" type="file" accept="image/png,image/jpeg" disabled={disabled || pending(record)} onChange={event => { const selected = event.target.files?.[0]; if (selected) void run(context => selectImage(selected, context)); else setImage(null); }} />
      <p className="muted">PNG 或 JPEG，最大 2 MiB，最长边 1024 像素</p><label htmlFor="vision-prompt">问题</label><textarea id="vision-prompt" maxLength={1024} rows={3} value={prompt} disabled={disabled || pending(record)} onChange={event => setPrompt(event.target.value)} />
      <button className="primary" disabled={disabled || pending(record) || !image || !prompt.trim()}>分析图片</button>
    </form>}
    {record && <article className="registry-row vision-task" aria-label="最近观察任务"><div><strong>{task ? states[task.status] : record.rejected_code ? '请求未受理' : '结果待核实'}</strong>{task?.error_code && <p className="muted">{errorText(new ApiError(task.error_code, 422))}</p>}{result !== null && !cleared && <p aria-label="观察结果" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result}</p>}{cleared && <p className="muted">观察结果已清除</p>}{task?.status === 'succeeded' && !cleared && result === null && <p className="muted">查询原任务可查看结果</p>}<details><summary>任务详情</summary><dl><dt>原请求编号</dt><dd>{record.original.idempotency_key}</dd><dt>模型</dt><dd>{task?.deployment.model ?? '待核实'}</dd></dl></details></div><div className="actions"><button disabled={!online || busy || blocked} onClick={() => void run(context => resolve(record.original, context))}>查询原任务</button>{task && (['running', 'unknown'].includes(task.status) || task.status === 'succeeded' && !cleared) && <button disabled={disabled} onClick={() => setConfirmation(true)}>{task.status === 'succeeded' ? '清除观察结果' : '放弃观察输出'}</button>}</div></article>}
    {confirmation && <div className="notice" role="group" aria-label="确认清除观察输出"><p>{task?.status === 'succeeded' ? '清除此任务保存的观察结果。' : '放弃此观察输出。外部模型可能继续计算。'}</p><div className="actions"><button disabled={disabled} onClick={() => void run(discard)}>确认清除输出</button><button disabled={busy} onClick={() => setConfirmation(false)}>取消</button></div></div>}
  </section>;
}

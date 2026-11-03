import { useEffect, useRef, useState } from 'react';
import { ApiError, deviceName, errorText, request, when, type Device, type Model, type Session } from './api';
import { createMediaOriginal, MAX_AUDIO_BYTES, validMediaOriginal, verifyMediaOperation, verifyMediaPage, verifyPcmWav, type MediaChange, type MediaOperation, type MediaOriginal, type MediaPage } from '../../../packages/protocol/media.mjs';
import { verifyExecutionAdapters, verifyExecutionBinding, type AudioAdapter } from '../../../packages/protocol/execution-bindings.mjs';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';
import { Speech } from './Speech';
import { Transcription } from './Transcription';

type Target = { device_id: string; revision: string };
export function Media({ prefix, session, online, devices, models, onError }: { prefix: string; session: Session; online: boolean; devices: Device[]; models: Record<string, Model>; onError: (error: unknown) => void }) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.media-operation:${prefix}:`;
  const [page, setPage] = useState<MediaPage | null>(null), [targets, setTargets] = useState<Target[]>([]);
  const [file, setFile] = useState<File | null>(null), [retention, setRetention] = useState('600');
  const [mediaID, setMediaID] = useState(''), [deviceID, setDeviceID] = useState(''), [duration, setDuration] = useState('300'), [approved, setApproved] = useState(false);
  const [originals, setOriginals] = useState<MediaOriginal[]>([]), [results, setResults] = useState<Record<string, MediaOperation>>({});
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState('');
  const [deletion, setDeletion] = useState<string | null>(null);
  const active = useRef(true), sending = useRef(false), known = useRef<MediaOriginal[]>([]), received = useRef<Record<string, MediaOperation>>({}), rejected = useRef(new Set<string>()), input = useRef<HTMLInputElement>(null);
  const controller = useRef(new AbortController());
  const loadGeneration = useRef(0);
  function readOriginals() {
    const found: MediaOriginal[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i); if (!key?.startsWith(storage)) continue;
      const value = parseBoundedJSON(localStorage.getItem(key) ?? '', { maxBytes: 4096, maxDepth: 4, maxNodes: 64 });
      if (!validMediaOriginal(value, location.origin, space) || key !== storage + value.idempotency_key) throw new Error('media_record_unavailable');
      found.push(value);
    }
    if (found.length > 128 || known.current.some(old => !found.some(item => sameJSON(item, old)))) throw new Error('media_record_unavailable');
    known.current = found; if (active.current) setOriginals(found); return found;
  }
  async function action(work: () => Promise<void>) {
    if (sending.current) return; sending.current = true; setBusy(true); setMessage('');
    try { await work(); }
    catch (error) {
      if (!active.current) return;
      if (error instanceof Error && error.message === 'media_record_unavailable') { setBlocked(true); setMessage('无法读取音频操作记录，请保留原记录后检查浏览器存储'); }
      else { setMessage(error instanceof Error && error.message === 'invalid_media_audio' ? '音频须为 16 位 PCM WAV，最长 60 秒、最大 4 MiB' : error instanceof Error && error.message === 'pending_media_operation' ? '音频操作尚未核实，请先查询原操作' : error instanceof Error && error.message === 'invalid_media_response' ? '音频数据未通过校验，请重新读取' : errorText(error)); if (error instanceof ApiError && error.status === 401) onError(error); }
    } finally { sending.current = false; if (active.current) setBusy(false); }
  }
  function accept(operation: MediaOperation) { received.current = { ...received.current, [operation.idempotency_key]: operation }; if (active.current) setResults(received.current); }
  async function resolve(original: MediaOriginal) {
    accept(verifyMediaOperation(await request<unknown>(`${prefix}/media-operations/by-key/${encodeURIComponent(original.idempotency_key)}`, session, undefined, { signal: controller.current.signal }), space, original.idempotency_key, original));
  }
  async function load() {
    const generation = ++loadGeneration.current;
    setApproved(false); setTargets([]);
    const options = { signal: controller.current.signal };
    const [raw, offers] = await Promise.all([request<unknown>(`${prefix}/media`, session, undefined, options), request<unknown>(`${prefix}/execution-adapters`, session, undefined, options)]);
    const value = verifyMediaPage(raw, space);
    const candidates = verifyExecutionAdapters(offers).items.filter((item): item is AudioAdapter => 'kind' in item && item.kind === 'dlna' && item.managed_media === true && item.compatible);
    const available = await Promise.all(candidates.map(async item => {
      const binding = verifyExecutionBinding(await request<unknown>(`${prefix}/devices/${encodeURIComponent(item.device_id)}/execution-binding`, session, undefined, options), item.device_id);
      const route = binding.routes['playback.play'];
      return route?.adapter_id === item.route.adapter_id && route.revision === item.route.revision ? { device_id: item.device_id, revision: binding.revision } : null;
    }));
    if (active.current && generation === loadGeneration.current) { setPage(value); setTargets(available.filter((item): item is Target => item !== null)); }
  }
  async function refresh() {
    const records = readOriginals(); await load();
    // 只读恢复分批执行，不自动补发请求或创建新授权。
    for (let offset = 0; offset < records.length; offset += 4) {
      if (!active.current) return;
      await Promise.all(records.slice(offset, offset + 4).map(async original => { try { await resolve(original); } catch (error) { if (error instanceof ApiError && error.status === 401) onError(error); } }));
    }
  }
  useEffect(() => {
    active.current = true; void action(refresh);
    const changed = () => { try { readOriginals(); } catch { setBlocked(true); setMessage('无法读取音频操作记录，请保留原记录后检查浏览器存储'); } };
    addEventListener('storage', changed);
    return () => { active.current = false; controller.current.abort(); removeEventListener('storage', changed); };
  }, []);
  async function submit(change: MediaChange) {
    const records = readOriginals();
    if (blocked || records.length >= 128) throw new Error('media_record_unavailable');
    if (!['media.delete', 'media.revoke'].includes(change.type) && records.some(item => !received.current[item.idempotency_key] && !rejected.current.has(item.idempotency_key) && item.change.type === change.type)) throw new Error('pending_media_operation');
    const original = await createMediaOriginal(location.origin, space, crypto.randomUUID(), change), key = storage + original.idempotency_key, text = JSON.stringify(original);
    try { if (localStorage.getItem(key) !== null) throw new Error(); localStorage.setItem(key, text); if (localStorage.getItem(key) !== text) throw new Error(); readOriginals(); }
    catch { setBlocked(true); setMessage('无法保存音频操作记录，尚未发送请求'); return; }
    let operation: MediaOperation;
    try { operation = verifyMediaOperation(await request<unknown>(`${prefix}/media-operations`, session, change, { key: original.idempotency_key, signal: controller.current.signal }), space, original.idempotency_key, original); }
    catch (error) {
      if (active.current) { if (error instanceof ApiError && error.definitiveRejection) { rejected.current.add(original.idempotency_key); setMessage(errorText(error)); } else setMessage('音频操作结果未知，请查询原操作'); if (error instanceof ApiError && error.status === 401) onError(error); }
      return;
    }
    if (!active.current) return; accept(operation);
    if (operation.result.type === 'uploaded') { setMediaID(operation.result.media.media_id); setFile(null); if (input.current) input.current.value = ''; }
    setDeletion(null); await load(); setMessage(operation.kind === 'media.upload' ? '音频已上传' : operation.kind === 'media.grant' ? '播放授权已创建' : operation.kind === 'media.revoke' ? '播放授权已撤销' : '音频已删除');
  }
  const available = page?.items.filter(item => item.available && Date.parse(item.metadata.expires_at) > Date.now()) ?? [], target = targets.find(item => item.device_id === deviceID);
  const disabled = !online || busy || blocked || !page?.configured;
  const pending = originals.filter(item => !results[item.idempotency_key] && !rejected.current.has(item.idempotency_key));
  return <div className="media-library">
    <div className="actions"><button disabled={!online || busy} onClick={() => void action(refresh)}>读取音频状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}
    {page && !page.configured && <p className="notice">网关尚未启用音频服务</p>}
    <Speech prefix={prefix} session={session} online={online} onError={onError} onGenerated={id => { setMediaID(id); setApproved(false); void load().catch(error => { if (active.current) { setMessage(errorText(error)); if (error instanceof ApiError && error.status === 401) onError(error); } }); }} />
    <Transcription prefix={prefix} session={session} online={online} files={page?.items ?? []} onError={onError} />
    <section className="rule-editor" aria-label="上传音频"><h2>上传音频</h2><form onSubmit={event => { event.preventDefault(); void action(async () => {
      if (!file || file.size > MAX_AUDIO_BYTES || file.size < 46) throw new Error('invalid_media_audio');
      const bytes = new Uint8Array(await file.arrayBuffer()); verifyPcmWav(bytes);
      let text = ''; for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      await submit({ type: 'media.upload', content_base64: btoa(text), retain_seconds: Number(retention) });
    }); }}>
      <label htmlFor="media-file">WAV 文件</label><div className="media-file-control"><button type="button" disabled={disabled} onClick={() => input.current?.click()}>选择文件</button><span>{file?.name ?? '未选择文件'}</span><input hidden ref={input} id="media-file" type="file" accept=".wav,audio/wav" disabled={disabled} onChange={event => setFile(event.target.files?.[0] ?? null)} /></div>
      <label htmlFor="media-retention">保留时间</label><select id="media-retention" disabled={disabled} value={retention} onChange={event => setRetention(event.target.value)}><option value="600">10 分钟</option><option value="3600">1 小时</option><option value="86400">24 小时</option></select>
      <button disabled={disabled || !file}>上传音频</button>
    </form></section>
    <section className="rule-editor" aria-label="播放授权"><h2>播放授权</h2><form onSubmit={event => { event.preventDefault(); if (target && approved) void action(() => submit({ type: 'media.grant', media_id: mediaID, device_id: target.device_id, expected_binding_revision: target.revision, valid_for_seconds: Number(duration) })); }}>
      <label htmlFor="media-object">音频</label><select id="media-object" value={mediaID} disabled={disabled} onChange={event => { setMediaID(event.target.value); setApproved(false); }}><option value="">选择音频</option>{available.map(item => <option key={item.metadata.media_id} value={item.metadata.media_id}>音频 {item.metadata.media_id.slice(-8)}，{(item.metadata.audio.frames / item.metadata.audio.sample_rate).toFixed(1)} 秒</option>)}</select>
      <label htmlFor="media-device">授权音箱</label><select id="media-device" value={deviceID} disabled={disabled} onChange={event => { setDeviceID(event.target.value); setApproved(false); }}><option value="">选择已绑定音箱</option>{targets.map(item => <option key={item.device_id} value={item.device_id}>{deviceName(devices.find(device => device.device_id === item.device_id) ?? { device_id: item.device_id, model_revision: '', ready: false, last_seen: null, reported: {} }, models)}（{item.device_id}）</option>)}</select>
      <label htmlFor="media-duration">授权时间</label><select id="media-duration" disabled={disabled} value={duration} onChange={event => { setDuration(event.target.value); setApproved(false); }}><option value="30">30 秒</option><option value="300">5 分钟</option><option value="600">10 分钟</option></select>
      <label className="media-approval"><input type="checkbox" disabled={disabled} checked={approved} onChange={event => setApproved(event.target.checked)} /><span>允许所选音箱读取此音频</span></label>
      <button disabled={disabled || !target || !approved || !available.some(item => item.metadata.media_id === mediaID)}>创建播放授权</button>
    </form>{targets.length === 0 && page?.configured && <p className="muted">请先在设备页绑定使用平台音频的音箱</p>}
      {page?.grants.map(item => <article className="registry-row" key={item.grant_id} aria-label={`播放授权 ${item.grant_id}`}><div><strong>{item.active_in_process && item.binding_current && Date.parse(item.expires_at) > Date.now() ? '当前可用' : item.revoked_at ? '已撤销' : !item.binding_current ? '绑定已变化' : '已失效'}</strong><p className="muted">{item.device_id}，到期 {when(item.expires_at)}</p><details><summary>授权详情</summary><dl><dt>音频编号</dt><dd>{item.media_id}</dd><dt>授权编号</dt><dd>{item.grant_id}</dd><dt>已准备响应</dt><dd>{item.pulls.length} 次</dd></dl></details></div>{!item.revoked_at && <button disabled={disabled} onClick={() => void action(() => submit({ type: 'media.revoke', grant_id: item.grant_id }))}>撤销播放授权</button>}</article>)}
    </section>
    <section aria-label="音频文件"><h2>音频文件</h2>{page?.items.length === 0 && <p className="muted">暂无音频</p>}{page?.items.map(item => <article className="registry-row" key={item.metadata.media_id} aria-label={`音频 ${item.metadata.media_id}`}><div><strong>音频 {item.metadata.media_id.slice(-8)}</strong><p className="muted">{(item.metadata.audio.frames / item.metadata.audio.sample_rate).toFixed(1)} 秒，{Math.ceil(item.metadata.byte_length / 1024)} KiB，{item.deleted_at ? '已删除' : item.available ? `保留至 ${when(item.metadata.expires_at)}` : '已到期'}</p><details><summary>文件详情</summary><dl><dt>媒体编号</dt><dd>{item.metadata.media_id}</dd><dt>文件摘要</dt><dd>{item.metadata.content_digest}</dd><dt>音频格式</dt><dd>{item.metadata.audio.sample_rate} Hz，{item.metadata.audio.channels === 1 ? '单声道' : '双声道'}，16 位 PCM</dd></dl></details></div>{item.available && <button disabled={disabled} onClick={() => setDeletion(item.metadata.media_id)}>删除音频</button>}</article>)}
      {deletion && <div className="notice" role="group" aria-label="确认删除音频"><p>删除音频并撤销其全部播放授权。</p><div className="actions"><button disabled={disabled} onClick={() => void action(() => submit({ type: 'media.delete', media_id: deletion }))}>确认删除音频</button><button disabled={busy} onClick={() => setDeletion(null)}>取消</button></div></div>}
    </section>
    {originals.length > 0 && <details><summary>音频操作记录{pending.length > 0 ? `，${pending.length} 项待核实` : ''}</summary>{originals.map(item => <div className="registry-row" key={item.idempotency_key}><div><strong>{({ 'media.upload': '上传音频', 'media.grant': '创建播放授权', 'media.revoke': '撤销播放授权', 'media.delete': '删除音频' })[item.change.type]}</strong><p>{results[item.idempotency_key] ? '已读取原回执' : rejected.current.has(item.idempotency_key) ? '请求已被拒绝' : '结果待核实'}</p><code>{item.idempotency_key}</code></div><button disabled={!online || busy} onClick={() => void action(async () => { await resolve(item); await load(); setMessage('已读取原音频操作'); })}>查询原操作</button></div>)}</details>}
  </div>;
}

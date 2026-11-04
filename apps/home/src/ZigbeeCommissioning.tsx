import { useEffect, useRef, useState } from 'react';
import { parseZigbeeChange, verifyZigbeeCoordinators, verifyZigbeeOperation, verifyZigbeeOperations,
  type ZigbeeChange, type ZigbeeCoordinator, type ZigbeeOperation, type ZigbeeRequest } from '../../../packages/protocol/zigbee-operations.mjs';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';
import { readOriginalRecords, saveOriginalRecord, type OriginalRecord } from './original-records';
import { ApiError, errorText, request, when, type Session } from './api';

type Record = OriginalRecord<ZigbeeRequest>;
interface Review { coordinator: ZigbeeCoordinator; change: ZigbeeChange; epoch: number; expiresAt: number }
const messages: { [code: string]: string } = {
  original_record_unavailable: '无法读取入网操作记录，请保留原记录后检查浏览器存储',
  zigbee_record_save_failed: '无法保存入网操作记录，尚未发送请求',
  zigbee_operation_unresolved: '此前入网结果未确认，请查询原操作或明确关闭',
  zigbee_operation_capacity: '入网操作记录已达上限',
  zigbee_browser_busy: '另一个页面正在处理入网操作',
  zigbee_browser_lock_unavailable: '当前浏览器不支持入网操作，请使用支持 Web Locks 的安全连接',
  zigbee_review_changed: '入网信息已变化，请重新核对',
  zigbee_review_expired: '入网确认已过期，请重新核对',
  invalid_zigbee_change: '请填写 1–120 秒的开放时长',
  invalid_zigbee_response: '入网信息未通过校验，请重新读取',
  revision_conflict: '协调器配置已变化，请重新核对',
  observation_coordinator_not_found: '协调器不可用，请重新读取',
  observation_query_busy: '协调器正在处理其他任务，请稍后再试',
  observation_query_unavailable: '协调器暂时不可用',
};
const validChange = (value: unknown) => { try { parseZigbeeChange(JSON.stringify(value)); return true; } catch { return false; } };

export function ZigbeeCommissioning({ prefix, session, online, onError }: {
  prefix: string; session: Session; online: boolean; onError: (error: unknown) => void;
}) {
  const namespace = `limeiot.zigbee-operation:${prefix}:`, space = decodeURIComponent(prefix.split('/').at(-1)!);
  const [coordinators, setCoordinators] = useState<ZigbeeCoordinator[]>([]), [coordinator, setCoordinator] = useState('');
  const [seconds, setSeconds] = useState('60'), [review, setReview] = useState<Review | null>(null);
  const [records, setRecords] = useState<Record[]>([]), [operations, setOperations] = useState<ZigbeeOperation[]>([]);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState('');
  const [foreground, setForeground] = useState(document.visibilityState === 'visible');
  const alive = useRef(true), working = useRef(false), epoch = useRef(0), loadEpoch = useRef(0), known = useRef<Record[]>([]);
  const currentReview = useRef<Review | null>(null), onlineRef = useRef(online), foregroundRef = useRef(foreground), blockedRef = useRef(false);
  const io = useRef(new AbortController()); onlineRef.current = online;
  const options = () => ({ signal: io.current.signal, parse: (text: string) => parseBoundedJSON(text, { maxBytes: 2_000_000, maxDepth: 12, maxNodes: 20000 }) });
  function clearReview() { epoch.current++; currentReview.current = null; setReview(null); }
  function report(error: unknown) {
    if (!alive.current) return;
    const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : '';
    if (code === 'original_record_unavailable' || code === 'zigbee_record_save_failed') { blockedRef.current = true; setBlocked(true); }
    setMessage(messages[code] ?? errorText(error));
    if (error instanceof ApiError && error.status === 401) onError(error);
  }
  function originals() {
    const found = readOriginalRecords(localStorage, namespace, location.origin, space, known.current, validChange, 256);
    known.current = found; if (alive.current) setRecords(found); return found;
  }
  const current = (generation: number) => alive.current && foregroundRef.current && onlineRef.current && epoch.current === generation;
  async function readServer() {
    const [catalog, history] = await Promise.all([
      request<unknown>(`${prefix}/zigbee-coordinators`, session, undefined, options()),
      request<unknown>(`${prefix}/zigbee-operations`, session, undefined, options()),
    ]);
    const available = verifyZigbeeCoordinators(catalog), page = await verifyZigbeeOperations(history, space);
    const saved = originals();
    for (const record of saved) {
      const found = page.items.find(item => item.request.idempotency_key === record.request.idempotency_key);
      if (found) await verifyZigbeeOperation(found, record.request);
    }
    return { available: available.items, items: page.items, saved };
  }
  async function load() {
    const order = ++loadEpoch.current;
    const valid = () => alive.current && foregroundRef.current && onlineRef.current && order === loadEpoch.current;
    setReady(false);
    try {
      const state = await readServer();
      if (!valid()) return;
      setCoordinators(state.available); setOperations(state.items);
      setCoordinator(previous => state.available.some(item => item.coordinator_id === previous) ? previous : state.available[0]?.coordinator_id ?? '');
      setReady(true);
    } catch (error) { if (valid()) { clearReview(); report(error); } }
  }
  async function action(work: () => Promise<void>) {
    if (working.current || !alive.current || !foregroundRef.current || !onlineRef.current) return;
    working.current = true; setBusy(true); setMessage('');
    try { await work(); } catch (error) { if (alive.current && foregroundRef.current) report(error); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    const changed = () => { try { originals(); } catch (error) { clearReview(); report(error); } };
    const visibility = () => {
      const visible = document.visibilityState === 'visible'; foregroundRef.current = visible; setForeground(visible);
      clearReview(); loadEpoch.current++; io.current.abort(); io.current = new AbortController(); setReady(false);
      if (visible && onlineRef.current) void load();
    };
    changed(); window.addEventListener('storage', changed); document.addEventListener('visibilitychange', visibility);
    return () => { alive.current = false; epoch.current++; loadEpoch.current++; io.current.abort(); window.removeEventListener('storage', changed); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    clearReview(); io.current.abort(); io.current = new AbortController(); setReady(false);
    if (online && foregroundRef.current) void load();
  }, [online]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => { if (currentReview.current === review) { clearReview(); setMessage(messages.zigbee_review_expired); } }, Math.max(0, review.expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [review]);

  function preventDuplicate(change: ZigbeeChange, saved: Record[], history: ZigbeeOperation[]) {
    if (change.duration_seconds === 0) return;
    for (const record of saved) {
      if (record.request.change.coordinator_id !== change.coordinator_id) continue;
      const result = history.find(item => item.request.idempotency_key === record.request.idempotency_key);
      if (!result || result.status === 'unknown' && Date.parse(result.blocked_until) > Date.now()) throw new Error('zigbee_operation_unresolved');
    }
    if (history.some(item => item.request.change.coordinator_id === change.coordinator_id && item.status === 'unknown'
      && Date.parse(item.blocked_until) > Date.now())) throw new Error('zigbee_operation_unresolved');
  }
  async function prepare(duration: number) {
    if (blockedRef.current) throw new Error('original_record_unavailable');
    clearReview(); const generation = epoch.current, selected = coordinator;
    const state = await readServer(); if (!current(generation)) return;
    const found = state.available.find(item => item.coordinator_id === selected);
    if (!found) throw new Error('observation_coordinator_not_found');
    const change = parseZigbeeChange(JSON.stringify({ coordinator_id: selected, expected_revision: found.revision, duration_seconds: duration }));
    preventDuplicate(change, state.saved, state.items);
    setOperations(state.items); setCoordinators(state.available);
    const prepared = { coordinator: found, change, epoch: generation, expiresAt: Date.now() + 60000 };
    currentReview.current = prepared; setReview(prepared);
  }
  async function confirm(prepared: Review) {
    if (!navigator.locks) throw new Error('zigbee_browser_lock_unavailable');
    await navigator.locks.request(namespace, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('zigbee_browser_busy');
      const valid = () => currentReview.current === prepared && current(prepared.epoch) && !blockedRef.current && Date.now() < prepared.expiresAt;
      if (!valid()) throw new Error('zigbee_review_changed');
      const state = await readServer();
      if (!valid()) throw new Error('zigbee_review_changed');
      if (!state.available.some(item => sameJSON(item, prepared.coordinator))) { clearReview(); throw new Error('revision_conflict'); }
      const saved = originals(); preventDuplicate(prepared.change, saved, state.items);
      if (saved.length >= 256) throw new Error('zigbee_operation_capacity');
      const record: Record = { version: 1, origin: location.origin, request: { space_id: space, idempotency_key: crypto.randomUUID(), change: prepared.change } };
      clearReview(); const generation = epoch.current;
      try { saveOriginalRecord(localStorage, namespace, record); originals(); }
      catch { throw new Error('zigbee_record_save_failed'); }
      try {
        const operation = await verifyZigbeeOperation(await request<unknown>(`${prefix}/zigbee-operations`, session, prepared.change,
          { ...options(), key: record.request.idempotency_key, timeoutMs: 35000 }), record.request);
        if (!current(generation)) return;
        setOperations(previous => [...previous.filter(item => item.request.idempotency_key !== record.request.idempotency_key), operation]);
        setMessage(operation.status === 'protocol_accepted' ? prepared.change.duration_seconds ? '开放入网协议已受理，请继续发现设备' : '关闭入网协议已受理' : '入网结果未知，请查询原操作');
      } catch (error) {
        if (current(generation)) { setMessage('入网结果未知，请查询原操作'); if (error instanceof ApiError && error.status === 401) onError(error); }
      }
    });
  }
  async function resolve(record: Record) {
    const generation = epoch.current;
    try {
      originals();
      const operation = await verifyZigbeeOperation(await request<unknown>(`${prefix}/zigbee-operations/by-key/${encodeURIComponent(record.request.idempotency_key)}`,
        session, undefined, options()), record.request);
      if (!current(generation)) return;
      setOperations(previous => [...previous.filter(item => item.request.idempotency_key !== record.request.idempotency_key), operation]);
      setMessage(operation.status === 'protocol_accepted' ? '已查询原操作，协议已受理' : '结果仍未知，请保留原操作记录');
    } catch (error) {
      if (current(generation)) {
        if (error instanceof Error && error.message === 'original_record_unavailable') report(error);
        else setMessage('结果仍未知，请保留原操作记录');
        if (error instanceof ApiError && error.status === 401) onError(error);
      }
    }
  }
  const entries = [...records, ...operations.filter(item => !records.some(record => record.request.idempotency_key === item.request.idempotency_key))
    .map(item => ({ version: 1 as const, origin: location.origin, request: item.request }))];
  const enabled = online && foreground && ready && !busy && !blocked;
  return <section className="rule-editor observation-sources zigbee-commissioning" aria-label="Zigbee入网管理">
    <div className="section-heading"><h2>Zigbee 入网</h2><button disabled={!online || !foreground || busy} onClick={() => void action(async () => { clearReview(); await load(); })}>读取入网状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}
    {coordinators.length === 0 ? <p className="muted">尚未配置可管理的 Zigbee 协调器</p> : <>
      <div className="rule-fields"><label>入网协调器<select value={coordinator} disabled={busy || !online} onChange={event => { clearReview(); setCoordinator(event.target.value); }}>{coordinators.map(item => <option key={item.coordinator_id} value={item.coordinator_id}>{item.coordinator_id}</option>)}</select></label>
        <label>开放时长（秒）<input type="number" min={1} max={120} step={1} value={seconds} disabled={busy || !online} onChange={event => { clearReview(); setSeconds(event.target.value); }} /></label></div>
      <div className="actions"><button disabled={!enabled} onClick={() => void action(async () => { const duration = Number(seconds); if (!Number.isInteger(duration) || duration < 1 || duration > 120) throw new Error('invalid_zigbee_change'); await prepare(duration); })}>开放入网</button>
        <button disabled={!enabled} onClick={() => void action(() => prepare(0))}>关闭入网</button></div>
    </>}
    {review && <div role="group" aria-label="核对Zigbee入网"><h3>{review.change.duration_seconds ? '确认开放入网' : '确认关闭入网'}</h3>
      <dl><dt>协调器</dt><dd>{review.coordinator.coordinator_id}</dd><dt>协调器 IEEE</dt><dd>{review.coordinator.coordinator_ieee}</dd><dt>操作</dt><dd>{review.change.duration_seconds ? `开放 ${review.change.duration_seconds} 秒` : '关闭入网'}</dd></dl>
      <p>{review.change.duration_seconds ? '允许新设备向此协调器申请加入，加入后仍需单独添加设备。' : '请求此协调器停止接受新设备，保留已接入设备。'}</p>
      <div className="actions"><button disabled={!enabled} onClick={() => void action(() => confirm(review))}>{review.change.duration_seconds ? '确认开放' : '确认关闭'}</button><button disabled={busy} onClick={clearReview}>取消入网操作</button></div>
    </div>}
    {entries.length > 0 && <details><summary>入网操作记录</summary>{entries.map(record => {
      const key = record.request.idempotency_key, operation = operations.find(item => item.request.idempotency_key === key);
      return <article className="registry-row" data-zigbee-key={key} key={key}><div><h3>{record.request.change.duration_seconds ? `开放 ${record.request.change.duration_seconds} 秒` : '关闭入网'}：{record.request.change.coordinator_id}</h3>
        <p>{operation?.status === 'protocol_accepted' ? '协议已受理' : '结果未知'}</p>
        <details><summary>入网操作详情</summary><dl><dt>原操作键</dt><dd>{key}</dd>{operation && <><dt>请求时间</dt><dd>{when(operation.created_at)}</dd></>}</dl></details></div>
        <button disabled={!online || !foreground || busy || blocked} onClick={() => void action(() => resolve(record))}>查询原入网操作</button></article>;
    })}</details>}
  </section>;
}

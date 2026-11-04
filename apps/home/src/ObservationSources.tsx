import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  parseObservationQuery, verifyObservationBinding, verifyObservationCandidate, verifyObservationCandidates, verifyObservationOperation,
  type ObservationBinding, type ObservationCandidate, type ObservationCandidates, type ObservationChange, type ObservationOperation, type ObservationQuery,
} from '../../../packages/protocol/observation-bindings.mjs';
import { readObservationRecords, saveObservationRecord, type ObservationRecord } from './observation-records';
import {
  supportsEnvironmentEndpoint, supportsOnOffEndpoint, verifyObservationDiscovery, verifyObservationEndpoints,
  type ObservationDiscovery, type ObservationEndpoints,
} from '../../../packages/protocol/observation-discovery.mjs';
import { ApiError, errorText, request, when, type Device, type Session } from './api';

interface Review { candidate: ObservationCandidate; binding: ObservationBinding; epoch: number }
const empty: ObservationCandidates = { coordinators: [], items: [], next_cursor: null };
const statuses = { applied: '已完成', rejected: '已拒绝', conflict: '状态已变化' };
const messages: Record<string, string> = {
  observation_record_unavailable: '无法保存或读取接入操作记录，请保留原记录后检查浏览器存储',
  observation_record_save_failed: '无法保存接入操作记录，尚未发送请求',
  observation_pending: '请先查询该设备或来源的原操作',
  observation_browser_lock_unavailable: '当前浏览器不支持接入操作，请使用支持 Web Locks 的安全连接',
  observation_browser_busy: '另一个页面正在处理设备接入',
  observation_review_expired: '接入信息已过期，请重新查询设备',
  observation_review_changed: '接入信息已变化，请重新核对',
  observation_device_in_use: '设备编号已被其他设备使用',
  observation_source_in_use: '此来源已被其他设备使用',
  observation_query_busy: '协调器正在查询设备，请稍后再试',
  observation_query_timeout: '设备查询超时，请确认设备可响应后再试',
  observation_query_unavailable: '协调器暂时无法查询设备',
  observation_coordinator_not_found: '协调器不可用，请重新读取接入状态',
  observation_target_in_use: '此设备已通过配置接入',
  invalid_observation_query: '请检查协调器、设备 IEEE 和端点',
  invalid_observation_response: '接入信息未通过校验，请重新读取',
  observation_candidate_expired: '候选已过期，请重新查询设备',
  observation_candidate_unavailable: '候选不可用，请重新查询设备',
  observation_binding_model_locked: '已接入设备的模型不能通过重新接入变更',
  observation_capacity: '观测来源数量已达上限',
  observation_operation_capacity: '接入操作记录已达上限',
  revision_conflict: '接入状态已变化，请重新读取后操作',
};
const identifier = (value: string) => value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const defaultID = (ieee: string) => `zigbee-${ieee}`;

export function ObservationSources({ prefix, session, online, devices, revision, refresh, onError }: {
  prefix: string; session: Session; online: boolean; devices: Device[]; revision: number; refresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const namespace = `limeiot.observation-operation:${prefix}:`, space = decodeURIComponent(prefix.split('/').at(-1)!);
  const [available, setAvailable] = useState(empty), [bindings, setBindings] = useState<ObservationBinding[]>([]);
  const [coordinator, setCoordinator] = useState(''), [ieee, setIEEE] = useState(''), [endpoint, setEndpoint] = useState('1'), [deviceID, setDeviceID] = useState('');
  const [review, setReview] = useState<Review | null>(null), [revocation, setRevocation] = useState<ObservationBinding | null>(null);
  const [profile, setProfile] = useState<'environment' | 'on_off'>('environment');
  const [discovery, setDiscovery] = useState<ObservationDiscovery | null>(null), [endpoints, setEndpoints] = useState<ObservationEndpoints | null>(null);
  const [records, setRecords] = useState<ObservationRecord[]>([]), [results, setResults] = useState<Record<string, ObservationOperation>>({});
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState('');
  const alive = useRef(true), working = useRef(false), known = useRef<ObservationRecord[]>([]), decided = useRef<Record<string, ObservationOperation>>({});
  const abort = useRef(new AbortController()), epoch = useRef(0), loadEpoch = useRef(0), onlineRef = useRef(online);
  const discoveryAbort = useRef(new AbortController());
  const restoreOriginals = useRef(true);
  const currentReview = useRef(review), currentRevocation = useRef(revocation), deviceRef = useRef(devices);
  const [now, setNow] = useState(Date.now);
  onlineRef.current = online; deviceRef.current = devices; currentReview.current = review; currentRevocation.current = revocation;
  const sourceIDs = devices.filter(device => device.observation_source).map(device => device.device_id).sort().join(',');
  const options = () => ({ signal: abort.current.signal });
  function clearReview() {
    epoch.current++; discoveryAbort.current.abort(); discoveryAbort.current = new AbortController();
    currentReview.current = null; currentRevocation.current = null;
    setReview(null); setRevocation(null); setDiscovery(null); setEndpoints(null);
  }
  function failure(error: unknown) {
    if (!alive.current) return;
    const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : '';
    setMessage(messages[code] ?? errorText(error));
    if (code === 'observation_record_unavailable' || code === 'observation_record_save_failed') setBlocked(true);
    if (error instanceof ApiError && error.status === 401) onError(error);
  }
  async function action(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setMessage('');
    try { await work(); } catch (error) { failure(error); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  function readRecords() {
    const found = readObservationRecords(localStorage, namespace, location.origin, space, known.current);
    known.current = found; if (alive.current) setRecords(found); return found;
  }
  async function getBinding(id: string) {
    return verifyObservationBinding(await request<unknown>(`${prefix}/devices/${encodeURIComponent(id)}/observation-binding`, session, undefined, options()), id);
  }
  async function load() {
    const generation = ++loadEpoch.current;
    const originals = restoreOriginals.current ? readRecords() : [];
    const page = await verifyObservationCandidates(await request<unknown>(`${prefix}/observation-candidates`, session, undefined, options()));
    const ids = deviceRef.current.filter(device => device.observation_source).map(device => device.device_id);
    const found = await Promise.all(ids.map(getBinding));
    const recovered = await Promise.allSettled(originals.map(async record => {
      const operation = await verifyObservationOperation(await request<unknown>(`${prefix}/observation-operations/by-key/${encodeURIComponent(record.request.idempotency_key)}`, session, undefined, options()), record.request);
      return [record.request.idempotency_key, operation] as const;
    }));
    if (alive.current && generation === loadEpoch.current) {
      restoreOriginals.current = false;
      decided.current = { ...decided.current, ...Object.fromEntries(recovered.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])) };
      setResults(decided.current);
      setAvailable(page); setBindings(found);
      setCoordinator(previous => page.coordinators.some(item => item.coordinator_id === previous) ? previous : page.coordinators[0]?.coordinator_id ?? '');
    }
  }
  useEffect(() => {
    alive.current = true;
    const changed = () => { try { readRecords(); } catch { failure(new Error('observation_record_unavailable')); } };
    const hidden = () => { if (document.visibilityState !== 'visible') clearReview(); };
    changed(); window.addEventListener('storage', changed); document.addEventListener('visibilitychange', hidden);
    return () => { alive.current = false; abort.current.abort(); discoveryAbort.current.abort(); epoch.current++; loadEpoch.current++; window.removeEventListener('storage', changed); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { if (online) void load().catch(failure); else clearReview(); }, [online, sourceIDs]);
  useEffect(() => { clearReview(); if (onlineRef.current) void load().catch(failure); }, [revision]);
  const coordinatorContext = available.coordinators.map(item => `${item.coordinator_id}:${item.coordinator_ieee}`).join(',');
  useEffect(() => { clearReview(); }, [coordinatorContext]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(review.candidate.expires_at) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [review]);
  useEffect(() => {
    const result = discovery ?? endpoints;
    if (!result) return;
    const timer = setTimeout(() => { clearReview(); setMessage('发现信息已过期，请重新查询'); }, Math.max(0, Date.parse(result.expires_at) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [discovery, endpoints]);
  async function discover(ieeeAddress?: string) {
    const previous = discovery;
    if (ieeeAddress !== undefined && (!previous || previous.coordinator_id !== coordinator
      || Date.parse(previous.expires_at) <= Date.now() || !previous.items.some(item => item.ieee_address === ieeeAddress))) throw new Error('observation_review_expired');
    clearReview();
    const selected = available.coordinators.find(item => item.coordinator_id === coordinator);
    if (!selected) throw new Error('observation_coordinator_not_found');
    const generation = epoch.current;
    const expected = { coordinator_id: selected.coordinator_id, coordinator_ieee: selected.coordinator_ieee, ieee_address: ieeeAddress };
    if (ieeeAddress !== undefined) { setIEEE(ieeeAddress); setEndpoint('1'); setDeviceID(defaultID(ieeeAddress)); }
    try {
      const value = await request<unknown>(`${prefix}/${ieeeAddress === undefined ? 'observation-discoveries' : 'observation-endpoints'}`, session,
        { coordinator_id: selected.coordinator_id, ...(ieeeAddress === undefined ? {} : { ieee_address: ieeeAddress }) },
        { signal: discoveryAbort.current.signal, timeoutMs: 35000 });
      const result = ieeeAddress === undefined ? verifyObservationDiscovery(value, expected) : verifyObservationEndpoints(value, expected);
      if (Date.parse(result.expires_at) <= Date.now() || Date.parse(result.observed_at) > Date.now()) throw new Error('observation_review_expired');
      if (alive.current && onlineRef.current && document.visibilityState === 'visible' && generation === epoch.current) {
        if ('items' in result) setDiscovery(result); else setEndpoints(result);
      }
    } catch (error) { if (generation === epoch.current) throw error; }
  }
  function pending(change: ObservationChange, originals: ObservationRecord[]) {
    return originals.some(item => !decided.current[item.request.idempotency_key] && (item.request.change.device_id === change.device_id ||
      change.type === 'sources.bind' && item.request.change.type === 'sources.bind' && item.request.change.source.adapter_id === change.source.adapter_id));
  }
  async function prepare(query: ObservationQuery, id: string) {
    clearReview();
    if (!identifier(id)) throw new Error('observation_device_in_use');
    const generation = epoch.current;
    const candidate = await verifyObservationCandidate(await request<unknown>(`${prefix}/observation-candidates`, session, query, { ...options(), timeoutMs: 35000 }));
    const selected = available.coordinators.find(item => item.coordinator_id === query.coordinator_id);
    if (!selected || candidate.target.coordinator_ieee !== selected.coordinator_ieee || candidate.target.ieee_address !== query.ieee_address || candidate.target.endpoint !== query.endpoint
      || Boolean(candidate.write_paths) !== (query.profile === 'on_off')) throw new Error('invalid_observation_response');
    const binding = await getBinding(id);
    if (!binding.binding && deviceRef.current.some(device => device.device_id === id)) throw new Error('observation_device_in_use');
    if (alive.current && onlineRef.current && document.visibilityState === 'visible' && generation === epoch.current) {
      setNow(Date.now()); setReview({ candidate, binding, epoch: generation });
    }
  }
  async function query(event: FormEvent) {
    event.preventDefault();
    await action(() => prepare(parseObservationQuery(JSON.stringify({ coordinator_id: coordinator, ieee_address: ieee, endpoint: Number(endpoint), ...(profile === 'on_off' ? { profile } : {}) })), deviceID));
  }
  async function resolve(record: ObservationRecord) {
    try {
      const operation = await verifyObservationOperation(await request<unknown>(`${prefix}/observation-operations/by-key/${encodeURIComponent(record.request.idempotency_key)}`, session, undefined, options()), record.request);
      if (!alive.current) return;
      decided.current = { ...decided.current, [record.request.idempotency_key]: operation }; setResults(decided.current);
      await refresh(); await load();
      setMessage('已查询原操作，当前状态已更新');
    } catch (error) { if (alive.current) setMessage('结果仍未知，请保留记录后查询原操作'); if (error instanceof ApiError && error.status === 401) onError(error); }
  }
  async function submit(change: ObservationChange, validReview: () => boolean) {
    if (!navigator.locks) throw new Error('observation_browser_lock_unavailable');
    await navigator.locks.request(namespace, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('observation_browser_busy');
      if (!alive.current || !onlineRef.current || document.visibilityState !== 'visible' || !validReview()) throw new Error('observation_review_changed');
      let originals: ObservationRecord[];
      try { originals = readRecords(); } catch { throw new Error('observation_record_unavailable'); }
      if (blocked || originals.length >= 128) throw new Error('observation_record_unavailable');
      if (pending(change, originals)) throw new Error('observation_pending');
      const record: ObservationRecord = { version: 1, origin: location.origin, request: { space_id: space, idempotency_key: crypto.randomUUID(), change } };
      clearReview();
      try { saveObservationRecord(localStorage, namespace, record); readRecords(); }
      catch { throw new Error('observation_record_save_failed'); }
      let operation: ObservationOperation;
      try { operation = await verifyObservationOperation(await request<unknown>(`${prefix}/observation-operations`, session, change, { ...options(), key: record.request.idempotency_key }), record.request); }
      catch (error) { if (alive.current) setMessage('接入结果未知，请查询原操作'); if (error instanceof ApiError && error.status === 401) onError(error); return; }
      if (!alive.current) return;
      decided.current = { ...decided.current, [record.request.idempotency_key]: operation }; setResults(decided.current);
      await refresh(); await load();
      setMessage(operation.status === 'applied' ? '接入操作已完成' : messages[operation.reason ?? ''] ?? '接入操作已被拒绝');
    });
  }
  async function bind(prepared: Review) {
    if (Date.parse(prepared.candidate.expires_at) <= Date.now() || Date.parse(prepared.candidate.observed_at) > Date.now()) throw new Error('observation_review_expired');
    await submit({ type: 'sources.bind', device_id: prepared.binding.device_id, source: prepared.candidate.source,
      expected_binding_revision: prepared.binding.revision, expected_model_revision: prepared.candidate.model_revision },
    () => currentReview.current === prepared && prepared.epoch === epoch.current && Date.parse(prepared.candidate.expires_at) > Date.now());
  }
  async function prepareRebind(binding: ObservationBinding) {
    const target = binding.binding?.manifest.target as Record<string, unknown> | undefined;
    const selected = available.coordinators.find(item => item.coordinator_ieee === target?.coordinator_ieee);
    if (!selected) throw new Error('observation_coordinator_not_found');
    const query = parseObservationQuery(JSON.stringify({ coordinator_id: selected.coordinator_id, ieee_address: target?.ieee_address, endpoint: target?.endpoint, ...(binding.binding?.write_paths ? { profile: 'on_off' } : {}) }));
    setProfile(query.profile ?? 'environment');
    setCoordinator(query.coordinator_id); setIEEE(query.ieee_address); setEndpoint(String(query.endpoint)); setDeviceID(binding.device_id);
    await prepare(query, binding.device_id);
  }
  async function prepareRevocation(binding: ObservationBinding) {
    clearReview();
    const generation = epoch.current;
    const current = await getBinding(binding.device_id);
    if (alive.current && onlineRef.current && document.visibilityState === 'visible' && generation === epoch.current) setRevocation(current);
  }
  async function revoke(binding: ObservationBinding) {
    await submit({ type: 'sources.revoke', device_id: binding.device_id, expected_binding_revision: binding.revision }, () => currentRevocation.current === binding);
  }
  const enabled = online && !busy && !blocked;
  const reviewFresh = review && Date.parse(review.candidate.expires_at) > now;
  return <section className="rule-editor observation-sources" aria-label="Zigbee设备接入"><div className="section-heading"><h2>Zigbee 设备</h2><button disabled={!online || busy} onClick={() => void action(async () => { clearReview(); readRecords(); await load(); })}>读取接入状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}
    {available.coordinators.length === 0 ? <p className="muted">尚未配置 Zigbee 协调器</p> : <form onSubmit={event => void query(event)}>
      <div className="rule-fields"><label>协调器<select required value={coordinator} disabled={busy || !online} onChange={event => { setCoordinator(event.target.value); clearReview(); }}>{available.coordinators.map(item => <option key={item.coordinator_id} value={item.coordinator_id}>{item.coordinator_id}</option>)}</select></label>
        <label>设备 IEEE<input required pattern="[0-9a-f]{16}" maxLength={16} autoComplete="off" spellCheck={false} value={ieee} disabled={busy || !online} onChange={event => { const value = event.target.value.toLowerCase(); if (!deviceID || deviceID === defaultID(ieee)) setDeviceID(defaultID(value)); setIEEE(value); clearReview(); }} /></label>
        <label>端点<input type="number" min={1} max={240} step={1} required value={endpoint} disabled={busy || !online} onChange={event => { setEndpoint(event.target.value); clearReview(); }} /></label>
        <label>设备类型<select value={profile} disabled={busy || !online} onChange={event => { setProfile(event.target.value as 'environment' | 'on_off'); clearReview(); }}><option value="environment">温湿度传感器</option><option value="on_off">开关</option></select></label>
        <label>设备编号<input required pattern="[A-Za-z0-9_-]{1,128}" maxLength={128} autoComplete="off" value={deviceID} disabled={busy || !online} onChange={event => { setDeviceID(event.target.value); clearReview(); }} /></label></div>
      <div className="actions"><button type="button" disabled={!online || busy} onClick={() => void action(() => discover())}>发现已有设备</button><button disabled={!online || busy}>查询设备</button></div>
    </form>}
    {discovery && <div role="group" aria-label="发现的Zigbee设备"><h3>协调器邻居</h3><p className="muted">邻居记录可能过期，也可能不包含路由器下的设备。</p>
      {discovery.items.length === 0 && <p>协调器尚无邻居记录</p>}
      {discovery.items.map(item => <article className="registry-row" key={item.ieee_address}><div><h3>{item.ieee_address}</h3><p>{item.device_type === 1 ? '路由器' : item.device_type === 2 ? '终端设备' : '设备'}</p></div>
        <button disabled={!online || busy} onClick={() => void action(() => discover(item.ieee_address))}>读取端点</button></article>)}
    </div>}
    {endpoints && <div role="group" aria-label="Zigbee设备端点"><h3>{endpoints.ieee_address}</h3>
      {endpoints.endpoints.length === 0 && <p>设备未提供可用端点</p>}
      {endpoints.endpoints.map(item => <article className="registry-row" key={item.endpoint}><div><h3>端点 {item.endpoint}</h3><p>{supportsEnvironmentEndpoint(item) ? '可查询温湿度' : supportsOnOffEndpoint(item) ? '可查询开关' : '暂不支持此端点'}</p></div>
        <button disabled={!online || busy || !(supportsEnvironmentEndpoint(item) || supportsOnOffEndpoint(item))} onClick={() => void action(async () => {
          if (Date.parse(endpoints.expires_at) <= Date.now() || endpoints.coordinator_id !== coordinator || endpoints.ieee_address !== ieee) throw new Error('observation_review_expired');
          const selected = supportsEnvironmentEndpoint(item) ? 'environment' : 'on_off';
          setEndpoint(String(item.endpoint)); setProfile(selected);
          await prepare({ coordinator_id: coordinator, ieee_address: ieee, endpoint: item.endpoint, ...(selected === 'on_off' ? { profile: selected } : {}) }, deviceID);
        })}>查询此端点</button></article>)}
    </div>}
    {review && <div role="group" aria-label="核对Zigbee设备"><h3>核对设备</h3><dl><dt>设备编号</dt><dd>{review.binding.device_id}</dd><dt>厂商</dt><dd>{review.candidate.signature.manufacturer}</dd><dt>型号</dt><dd>{review.candidate.signature.model}</dd><dt>设备 IEEE</dt><dd>{review.candidate.target.ieee_address}</dd><dt>端点</dt><dd>{review.candidate.target.endpoint}</dd><dt>有效至</dt><dd>{new Date(review.candidate.expires_at).toLocaleTimeString('zh-CN')}</dd></dl>
      <p>请核对实物与设备信息。IEEE 是协议识别信息，不是设备身份证明。</p>
      <p>{review.candidate.write_paths ? '接入权限：读取和控制电源' : '接入权限：只读温湿度'}</p>
      <details><summary>协议详情</summary><dl><dt>协调器 IEEE</dt><dd>{review.candidate.target.coordinator_ieee}</dd><dt>应用版本</dt><dd>{review.candidate.signature.application_version}</dd><dt>硬件版本</dt><dd>{review.candidate.signature.hardware_version}</dd><dt>模型修订</dt><dd>{review.candidate.model_revision}</dd></dl></details>
      {!reviewFresh && <p role="status">接入信息已过期，请重新查询设备</p>}
      <div className="actions"><button disabled={!enabled || !reviewFresh} onClick={() => void action(() => bind(review))}>{review.binding.binding ? '确认重新接入' : '确认添加设备'}</button><button disabled={busy} onClick={clearReview}>取消接入</button></div>
    </div>}
    <div aria-label="已接入Zigbee设备">{bindings.map(binding => <article className="registry-row" data-observation-device={binding.device_id} key={binding.device_id}><div><h3>{binding.device_id}</h3><p>{!binding.binding ? '配置接入' : binding.binding.active ? '已接入' : '已撤销'}</p></div>
      {binding.binding && <button disabled={!enabled} onClick={() => void action(() => binding.binding?.active ? prepareRevocation(binding) : prepareRebind(binding))}>{binding.binding.active ? '撤销接入' : '重新接入'}</button>}
    </article>)}</div>
    {revocation?.binding?.active && <div role="group" aria-label="确认撤销Zigbee接入">
      <h3>撤销 {revocation.device_id} 的接入</h3><p>停止采样和控制，保留设备与历史记录。</p>
      <div className="actions"><button disabled={!enabled} onClick={() => void action(() => revoke(revocation))}>确认撤销接入</button><button disabled={busy} onClick={clearReview}>取消撤销</button></div>
    </div>}
    {records.length > 0 && <details><summary>接入操作记录</summary>{records.map(record => { const key = record.request.idempotency_key, result = results[key]; return <article className="registry-row" data-observation-key={key} key={key}><div><h3>{record.request.change.type === 'sources.bind' ? '添加设备' : '撤销接入'}：{record.request.change.device_id}</h3><p>{result ? statuses[result.status] : '结果未知'}</p>{result?.reason && <p>{messages[result.reason] ?? '网关已拒绝此操作'}</p>}<details><summary>操作详情</summary><dl><dt>原操作键</dt><dd>{key}</dd>{result && <><dt>决定时间</dt><dd>{when(result.created_at)}</dd></>}</dl></details></div><button disabled={!online || busy} onClick={() => void action(() => resolve(record))}>查询原操作</button></article>; })}</details>}
  </section>;
}

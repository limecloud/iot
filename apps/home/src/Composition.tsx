import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, deviceName, errorText, request, ruleActionText, type Deployment, type Device, type Model, type Session } from './api';
import { checkCompositionModels, compileComposition, parseComposition, parseCompositionAttempt, planComposition, type CompositionAttempt, type CompositionPlan } from '../../../packages/protocol/composition.mjs';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';
import { documentDigest } from '../../../packages/protocol/model-validation.mjs';
import example from '../../../examples/compositions/reading-companion/package.json?raw';

type Context = { epoch: number; signal: AbortSignal };
const labels: Record<string, string> = { touch: '触摸模块', light: '灯光模块' };
const messages: Record<string, string> = {
  invalid_composition: '组合包格式不正确', composition_role_mismatch: '组合包中的模块与规则不一致',
  invalid_composition_bindings: '请为每个模块选择不同的兼容设备', composition_model_mismatch: '设备能力已变化，请重新选择并预演',
  device_offline: '设备当前离线，请恢复连接后重新预演',
  composition_record_unavailable: '无法核对本地提交记录，已暂停新提交', invalid_simulation: '预演结果未通过校验，请重新预演',
  composition_busy: '另一个标签正在提交组合，请稍后查询', composition_lock_unavailable: '当前浏览器不支持安全提交组合', revision_conflict: '当前部署已变化，请核对自动化列表',
};

export function Composition({ devices, models, prefix, session, online, refresh, onError }: {
  devices: Device[]; models: Record<string, Model>; prefix: string; session: Session; online: boolean; refresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.composition:${prefix}`;
  const [custom, setCustom] = useState(false), [source, setSource] = useState(''), [bindings, setBindings] = useState<Record<string, string>>({});
  const [instance, setInstance] = useState(() => `composition-${crypto.randomUUID()}`);
  const [proof, setProof] = useState<{ plan: CompositionPlan; fingerprint: string; expires: number } | null>(null);
  const [attempt, setAttempt] = useState<CompositionAttempt | null>(null), [ready, setReady] = useState(false), [blocked, setBlocked] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false), epoch = useRef(0), onlineNow = useRef(online), abort = useRef(new AbortController()), working = useRef<symbol | null>(null);
  const saved = useRef<string | null>(null), known = useRef(false);
  onlineNow.current = online;
  const packageText = custom ? source : example;
  const manifest = useMemo(() => { try { return parseComposition(packageText); } catch { return null; } }, [packageText]);
  const topology = JSON.stringify(devices.map(device => [device.device_id, device.model_revision, device.ready]).sort());
  const fingerprint = JSON.stringify([packageText, bindings, instance, topology]), current = useRef(fingerprint); current.current = fingerprint;
  const valid = (context: Context) => active.current && epoch.current === context.epoch && onlineNow.current && !document.hidden && !context.signal.aborted;
  function readLocal() { try { return localStorage.getItem(storage); } catch { throw new Error('composition_record_unavailable'); } }
  const parse = (text: string) => parseBoundedJSON(text, { maxBytes: 65536, maxDepth: 16, maxNodes: 8192 });
  function transport(context: Context) {
    return async (resource: string, input?: unknown) => {
      if (!valid(context)) throw new Error('composition_paused');
      return request<unknown>(resource, session, input, { signal: context.signal, parse });
    };
  }
  async function load(context: Context) {
    const raw = readLocal();
    if (known.current && raw === null) throw new Error('composition_record_unavailable');
    const result = raw === null ? null : await parseCompositionAttempt(raw, location.origin, space);
    if (!valid(context)) return;
    if (readLocal() !== raw) throw new Error('composition_record_unavailable');
    saved.current = raw; known.current = raw !== null; setAttempt(result?.record ?? null); setReady(true);
  }
  async function save(record: CompositionAttempt, context: Context) {
    const { checksum: _, ...body } = record;
    record = { ...body, checksum: await documentDigest(body) };
    const encoded = JSON.stringify(record);
    await parseCompositionAttempt(encoded, location.origin, space);
    if (!valid(context)) throw new Error('composition_paused');
    try {
      if (localStorage.getItem(storage) !== saved.current) throw new Error();
      localStorage.setItem(storage, encoded);
      if (localStorage.getItem(storage) !== encoded) throw new Error();
    } catch { throw new Error('composition_record_unavailable'); }
    saved.current = encoded; known.current = true; setAttempt(record);
  }
  async function run(work: (context: Context) => Promise<void>) {
    if (working.current || !active.current || !onlineNow.current || document.hidden || blocked) return;
    const token = Symbol(), context = { epoch: epoch.current, signal: abort.current.signal };
    working.current = token; setBusy(true); setMessage('');
    try { await work(context); }
    catch (error) {
      if (!valid(context)) return;
      const code = error instanceof Error ? error.message : '';
      if (code === 'composition_record_unavailable') { setBlocked(true); setReady(false); setProof(null); }
      setMessage(messages[code] ?? (error instanceof ApiError ? errorText(error) : '提交结果待核实，请查询当前部署'));
      if (error instanceof ApiError && error.status === 401) onError(error);
    } finally { if (working.current === token) { working.current = null; if (valid(context)) setBusy(false); } }
  }
  useEffect(() => {
    active.current = true;
    const pause = () => { epoch.current++; abort.current.abort(); abort.current = new AbortController(); working.current = null; setProof(null); setBusy(false); setReady(false); };
    const restore = () => { pause(); if (onlineNow.current && !document.hidden) void run(load); };
    const changed = (event: StorageEvent) => { if (event.key === storage || event.key === null) restore(); };
    restore(); document.addEventListener('visibilitychange', restore); window.addEventListener('storage', changed);
    return () => { active.current = false; epoch.current++; abort.current.abort(); working.current = null; document.removeEventListener('visibilitychange', restore); window.removeEventListener('storage', changed); };
  }, [prefix, session, online]);
  useEffect(() => { setProof(null); }, [fingerprint]);
  useEffect(() => { if (!proof) return; const timer = setTimeout(() => setProof(null), Math.max(0, proof.expires - Date.now())); return () => clearTimeout(timer); }, [proof]);
  const disabled = !online || !ready || busy || blocked;
  const mayBind = manifest && Object.keys(manifest.modules).every(role => devices.some(device => device.device_id === bindings[role] && device.ready && device.model_revision === manifest.modules[role].model_revision));
  async function preview(context: Context) {
    const frozen = fingerprint; setProof(null);
    const compiled = await compileComposition(packageText, JSON.stringify(bindings), instance);
    const plan = await planComposition(compiled, { request: transport(context), origin: location.origin, space, active: () => valid(context) && current.current === frozen });
    if (valid(context) && current.current === frozen) setProof({ plan, fingerprint: frozen, expires: Date.now() + 60000 });
  }
  async function deploy(context: Context) {
    const approved = proof;
    if (!approved || approved.expires <= Date.now() || approved.fingerprint !== current.current || attempt) return;
    setProof(null);
    await checkCompositionModels(approved.plan, transport(context), space);
    if (!valid(context) || approved.expires <= Date.now() || approved.fingerprint !== current.current) return;
    const record: CompositionAttempt = { version: 1, origin: location.origin, space_id: space, package: manifest!, bindings, instance_id: instance, rule_revision: approved.plan.rule_revision, state: 'attempted', checksum: '' };
    await save(record, context);
    try {
      const result = await request<Deployment>(`${prefix}/rule-deployments`, session, approved.plan.rule, { signal: context.signal, createOnly: true, parse });
      if (!valid(context)) return;
      if (result.revision !== approved.plan.rule_revision || !sameJSON(result.rule, approved.plan.rule)) throw new Error('invalid_deployment');
      await save({ ...record, state: 'acknowledged' }, context); setMessage('组合已启用'); await refresh();
    } catch (error) {
      if (valid(context) && error instanceof ApiError && error.definitiveRejection) await save({ ...record, state: 'rejected' }, context);
      throw error;
    }
  }
  async function locked(context: Context, work: () => Promise<void>) {
    if (!navigator.locks) throw new Error('composition_lock_unavailable');
    await navigator.locks.request(storage, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw new Error('composition_busy');
      if (valid(context)) await work();
    });
  }
  async function query(context: Context) {
    if (!attempt || readLocal() !== saved.current) throw new Error('composition_record_unavailable');
    const original = await parseCompositionAttempt(saved.current!, location.origin, space);
    const result = await request<{items: Deployment[]; next_cursor: null}>(`${prefix}/rule-deployments`, session, undefined, { signal: context.signal, parse });
    if (!valid(context)) return;
    if (!Array.isArray(result.items) || result.next_cursor !== null) throw new Error('invalid_deployment');
    const matches = result.items.filter(item => item.rule?.id === original.record.instance_id);
    if (matches.length > 1 || matches.length === 1 && (matches[0].revision !== original.record.rule_revision || !sameJSON(matches[0].rule, original.compiled.rule))) throw new ApiError('revision_conflict', 409);
    setMessage(matches.length ? original.record.state === 'acknowledged' ? '当前组合已启用' : '当前已启用，原提交结果仍待核实' : original.record.state === 'attempted' ? '暂未看到当前部署，原提交结果仍待核实' : '当前组合未启用');
    await refresh();
  }
  async function createAnother(context: Context) {
    if (disabled || !valid(context) || !attempt || attempt.state === 'attempted') return;
    try {
      if (localStorage.getItem(storage) !== saved.current) throw new Error();
      localStorage.removeItem(storage); if (localStorage.getItem(storage) !== null) throw new Error();
      saved.current = null; known.current = false; setAttempt(null); setProof(null); setBindings({}); setInstance(`composition-${crypto.randomUUID()}`); setMessage('');
    } catch { setBlocked(true); setReady(false); setMessage(messages.composition_record_unavailable); }
  }
  return <section className="rule-editor" aria-label="组合包"><details><summary>使用组合包</summary>
    {message && !blocked && <p role="status">{message}</p>}
    {blocked ? <p className="error">无法核对本地提交记录，已暂停新提交</p> : attempt ? <article aria-label="组合提交记录"><h3>{attempt.package.name}</h3><p>{attempt.state === 'acknowledged' ? '启用回执已确认' : attempt.state === 'rejected' ? '提交未获接受' : '原提交结果待核实'}</p><div className="actions"><button disabled={disabled} onClick={() => void run(query)}>查询当前部署</button>{attempt.state !== 'attempted' && <button disabled={disabled} onClick={() => void run(context => locked(context, () => createAnother(context)))}>准备其他组合</button>}</div><details><summary>原提交内容</summary><pre>{JSON.stringify(attempt, null, 2)}</pre></details></article> : <form onSubmit={event => { event.preventDefault(); void run(preview); }}>
      <label htmlFor="composition-template">组合包</label><select id="composition-template" disabled={disabled} value={custom ? 'custom' : 'reading'} onChange={event => { setCustom(event.target.value === 'custom'); setBindings({}); }}><option value="reading">触摸伴读灯</option><option value="custom">自定义组合包</option></select>
      {custom && <><label htmlFor="composition-json">组合包 JSON</label><textarea id="composition-json" rows={8} maxLength={32768} value={source} disabled={disabled} onChange={event => { setSource(event.target.value); setBindings({}); }} />{source && !manifest && <p className="error">组合包格式不正确</p>}</>}
      {manifest && <div className="rule-fields">{Object.entries(manifest.modules).map(([role, expected]) => <label key={role}>{labels[role] ?? role}<select aria-label={`组合模块 ${role}`} value={bindings[role] ?? ''} disabled={disabled} onChange={event => setBindings({ ...bindings, [role]: event.target.value })}><option value="">选择兼容设备</option>{devices.filter(device => device.model_revision === expected.model_revision && device.ready).map(device => <option key={device.device_id} value={device.device_id}>{deviceName(device, models)}（{device.device_id}）</option>)}</select></label>)}</div>}
      <div className="actions"><button disabled={disabled || !mayBind}>预演组合</button><button type="button" className="primary" disabled={disabled || !proof || proof.fingerprint !== fingerprint || proof.expires <= Date.now()} onClick={() => void run(context => locked(context, () => deploy(context)))}>启用组合</button></div>
      {proof && proof.fingerprint === fingerprint && <div role="status"><p>预演通过，设备尚未执行</p><ol>{proof.plan.rule.actions.map((action, index) => <li key={index}>{deviceName(devices.find(device => device.device_id === action.device)!, models)} {ruleActionText(action)}</li>)}</ol><details><summary>组合与权限内容</summary><pre>{JSON.stringify(proof.plan, null, 2)}</pre></details></div>}
    </form>}
  </details></section>;
}

import { useEffect, useRef, useState } from 'react';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';
import { parseOtaChange, validOtaChange, verifyFirmwareTrust, verifyOtaOperation, verifyOtaTask, type FirmwareTrust, type OtaChange, type OtaOperation, type OtaRequest, type OtaTask } from '../../../packages/protocol/ota-tasks.mjs';
import { ApiError, deviceName, errorText, request, when, type Device, type List, type Model, type Session } from './api';

interface Original { version: 1; origin: string; request: OtaRequest }
const changeNames = { 'trust.add': '信任固件签名者', 'trust.revoke': '撤销固件信任', 'tasks.plan': '创建升级计划', 'tasks.approve': '批准升级', 'tasks.execute': '开始安装', 'tasks.reconcile': '查询设备结果', 'tasks.cancel': '取消计划' };
const taskNames = { planned: '待批准', approved: '已批准，尚未安装', executing: '安装处理中', unknown: '结果未知', succeeded: '升级成功', failed: '升级失败', cancelled: '已取消', expired: '已过期', invalidated: '信任已失效' };
const operationNames = { applied: '决定已保存', rejected: '已拒绝', conflict: '状态冲突' };
const reasons: Record<string, string> = {
  revision_conflict: '状态已变化，请重新读取任务', device_info_unavailable: '设备尚未上报升级条件', device_info_stale: '设备报告已过期',
  device_offline: '设备已离线', ota_task_conflict: '设备已有升级或未决操作', ota_installer_unavailable: '设备尚未配置安装器',
  ota_trust_revoked: '固件信任已撤销', ota_task_expired: '升级期限已过', gateway_restarted: '网关重启后需要重新批准',
};
const scope = (change: OtaChange) => change.type === 'tasks.plan' ? `device:${change.device_id}` : 'task_id' in change ? `task:${change.task_id}` : change.type === 'trust.add' ? `signer:${change.expected_signing_key_id}` : `trust:${change.trust_id}`;
async function taskView(value: unknown) {
  const task = await verifyOtaTask(value);
  if (typeof task.manifest.statement?.version !== 'string' || typeof task.baseline.device.firmware_version !== 'string') throw new Error('invalid_ota_operation');
  return task;
}
async function trustView(value: unknown) {
  const trust = await verifyFirmwareTrust(value);
  if (![trust.trust.product_ids, trust.trust.download_origins].every(values => Array.isArray(values) && values.length > 0 && values.every(item => typeof item === 'string'))) throw new Error('invalid_ota_operation');
  return trust;
}

export function Firmware({ prefix, session, online, devices, models, onError }: {
  prefix: string; session: Session; online: boolean; devices: Device[]; models: Record<string, Model>; onError: (error: unknown) => void;
}) {
  const storage = `limeiot.ota-operation:${prefix}:`, space = decodeURIComponent(prefix.split('/').at(-1)!);
  const [trusts, setTrusts] = useState<FirmwareTrust[]>([]), [tasks, setTasks] = useState<OtaTask[]>([]);
  const [originals, setOriginals] = useState<Original[]>([]), [results, setResults] = useState<Record<string, OtaOperation>>({});
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [available, setAvailable] = useState(false), [message, setMessage] = useState('');
  const [trustText, setTrustText] = useState(''), [fingerprint, setFingerprint] = useState(''), [revocation, setRevocation] = useState<FirmwareTrust | null>(null);
  const [manifestText, setManifestText] = useState(''), [deviceID, setDeviceID] = useState(''), [trustID, setTrustID] = useState('');
  const [review, setReview] = useState<OtaTask | null>(null);
  const reviewPanel = useRef<HTMLElement>(null);
  const active = useRef(false), working = useRef(false), loading = useRef(false), generation = useRef(0), controller = useRef(new AbortController());
  const originalRef = useRef<Original[]>([]), resultRef = useRef<Record<string, OtaOperation>>({});
  const enabled = online && available && !busy && !blocked;
  useEffect(() => { if (review) reviewPanel.current?.focus(); }, [review]);
  function options() { return { signal: controller.current.signal }; }
  function failure(error: unknown) {
    if (!active.current) return;
    if (error instanceof ApiError) { setMessage(errorText(error)); if (error.status === 401) onError(error); return; }
    const messages: Record<string, string> = {
      local_record_unavailable: '无法保存或读取本机升级记录，请检查浏览器存储设置',
      pending_ota_operation: '请先查询同一设备或任务的原操作', invalid_ota_change: '请检查固件材料和指纹格式',
      invalid_ota_operation: '响应未通过校验，请查询原操作',
    };
    setMessage(error instanceof Error && messages[error.message] || '操作未完成，请重新读取当前状态');
  }
  async function action(run: () => Promise<void>) {
    if (working.current || !active.current) return;
    working.current = true; setBusy(true); setMessage('');
    try { await run(); } catch (error) { failure(error); }
    finally { working.current = false; if (active.current) setBusy(false); }
  }
  function readOriginals() {
    const found: Original[] = [];
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith(storage)) continue;
        const value = parseBoundedJSON(localStorage.getItem(key) ?? '', { maxBytes: 18000, maxDepth: 20, maxNodes: 2200 }) as Original;
        if (!value || Object.keys(value).sort().join(',') !== 'origin,request,version' || value.version !== 1 || value.origin !== location.origin ||
          !value.request || Object.keys(value.request).sort().join(',') !== 'change,idempotency_key,space_id' || value.request.space_id !== space ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.request.idempotency_key) || key !== storage + value.request.idempotency_key || !validOtaChange(value.request.change)) throw new Error();
        parseOtaChange(JSON.stringify(value.request.change));
        const previous = originalRef.current.find(item => item.request.idempotency_key === value.request.idempotency_key);
        if (previous && !sameJSON(previous, value)) throw new Error();
        found.push(value);
      }
      if (found.length > 128 || originalRef.current.some(item => !found.some(value => sameJSON(item, value)))) throw new Error();
    } catch { setBlocked(true); throw new Error('local_record_unavailable'); }
    found.sort((a, b) => a.request.idempotency_key.localeCompare(b.request.idempotency_key));
    originalRef.current = found; setOriginals(found); return found;
  }
  async function loadResources() {
    if (loading.current || !active.current) return;
    loading.current = true;
    const epoch = generation.current;
    try {
      const trustPage = await request<List<unknown>>(`${prefix}/firmware-trusts`, session, undefined, options());
      if (!Array.isArray(trustPage.items) || trustPage.items.length > 32 || trustPage.next_cursor !== null) throw new Error('invalid_ota_operation');
      const trusted = await Promise.all(trustPage.items.map(trustView));
      if (new Set(trusted.map(item => item.trust_id)).size !== trusted.length) throw new Error('invalid_ota_operation');
      const all: OtaTask[] = [], cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: List<unknown> = await request(`${prefix}/ota-tasks${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, session, undefined, options());
        if (!Array.isArray(page.items) || page.items.length > 16) throw new Error('invalid_ota_operation');
        all.push(...await Promise.all(page.items.map(taskView)));
        if (all.length > 128 || new Set(all.map(item => item.task_id)).size !== all.length) throw new Error('invalid_ota_operation');
        cursor = page.next_cursor;
        if (cursor !== null && (!/^ota-[A-Za-z0-9_-]+$/.test(cursor) || cursors.has(cursor))) throw new Error('invalid_ota_operation');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (active.current && epoch === generation.current) { setTrusts(trusted); setTasks(all); setAvailable(true); }
    } catch (error) { if (active.current && epoch === generation.current) { setAvailable(false); failure(error); } }
    finally { loading.current = false; }
  }
  async function resolve(original: Original) {
    const value = await request<unknown>(`${prefix}/ota-operations/by-key/${encodeURIComponent(original.request.idempotency_key)}`, session, undefined, options());
    const result = await verifyOtaOperation(value, original.request);
    if (active.current) { resultRef.current = { ...resultRef.current, [original.request.idempotency_key]: result }; setResults(resultRef.current); }
  }
  useEffect(() => {
    active.current = true; controller.current = new AbortController();
    const changed = () => { try { readOriginals(); } catch (error) { failure(error); } };
    try {
      const saved = readOriginals();
      void action(async () => { for (const original of saved) { try { await resolve(original); } catch (error) { failure(error); } } });
    } catch (error) { failure(error); }
    void loadResources();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void loadResources(); }, 5000);
    const events = new EventSource(`${prefix}/events/stream`), updated = () => { void loadResources(); };
    for (const name of ['ota.operation', 'commands.transitioned', 'device.ota_result', 'device.hello', 'gateway.recovered', 'gap']) events.addEventListener(name, updated);
    window.addEventListener('storage', changed);
    return () => { active.current = false; generation.current++; controller.current.abort(); clearInterval(interval); events.close(); window.removeEventListener('storage', changed); };
  }, []);
  async function submit(change: OtaChange) {
    if (!active.current) return;
    const saved = readOriginals();
    if (change.type !== 'trust.revoke' && saved.some(original => scope(original.request.change) === scope(change) && !resultRef.current[original.request.idempotency_key])) throw new Error('pending_ota_operation');
    if (blocked || saved.length >= 128 || !online || !available) throw new Error('local_record_unavailable');
    change = parseOtaChange(JSON.stringify(change));
    const original: Original = { version: 1, origin: location.origin, request: { space_id: space, idempotency_key: crypto.randomUUID(), change } };
    const key = storage + original.request.idempotency_key, text = JSON.stringify(original);
    try {
      if (localStorage.getItem(key) !== null) throw new Error();
      localStorage.setItem(key, text);
      if (localStorage.getItem(key) !== text) throw new Error();
      readOriginals();
    } catch { setBlocked(true); throw new Error('local_record_unavailable'); }
    setReview(null); setRevocation(null);
    try {
      const result = await verifyOtaOperation(await request<unknown>(`${prefix}/ota-operations`, session, change, { ...options(), key: original.request.idempotency_key }), original.request);
      if (!active.current) return;
      resultRef.current = { ...resultRef.current, [original.request.idempotency_key]: result }; setResults(resultRef.current);
      setMessage(result.status === 'applied' ? '' : reasons[result.reason ?? ''] ?? '网关已拒绝此操作，请重新读取当前状态');
    } catch (error) { if (active.current) { setMessage('结果未知，请查询升级原操作'); if (error instanceof ApiError && error.status === 401) onError(error); } return; }
    await loadResources();
  }
  async function readTask(id: string) {
    setReview(null);
    const task = await taskView(await request<unknown>(`${prefix}/ota-tasks/${encodeURIComponent(id)}`, session, undefined, options()));
    if (task.task_id !== id) throw new Error('invalid_ota_operation');
    if (active.current) setReview(task);
  }
  return <div className="model-registry firmware">
    {message && <p className="notice" role="status">{message}</p>}
    <section className="rule-editor" aria-label="固件信任"><h2>固件信任</h2><form onSubmit={event => { event.preventDefault(); void action(async () => {
      const trust = parseBoundedJSON(trustText, { maxBytes: 12000, maxDepth: 8, maxNodes: 1024 });
      await submit(parseOtaChange(JSON.stringify({ type: 'trust.add', trust, expected_signing_key_id: fingerprint.trim() })));
    }); }}>
      <label htmlFor="firmware-trust">固件信任材料</label><textarea id="firmware-trust" rows={4} maxLength={16000} value={trustText} spellCheck={false} disabled={busy} onChange={event => setTrustText(event.target.value)} />
      <label htmlFor="firmware-fingerprint">独立核对的固件公钥指纹</label><input id="firmware-fingerprint" value={fingerprint} maxLength={71} disabled={busy} onChange={event => setFingerprint(event.target.value)} placeholder="sha256:" autoComplete="off" />
      <div className="actions"><button disabled={!enabled || !trustText.trim() || !fingerprint.trim()}>信任固件签名者</button><button type="button" disabled={busy || !online} onClick={() => void action(loadResources)}>读取升级状态</button></div>
    </form>{trusts.map(trust => <article className="registry-row" key={trust.trust_id}><div><strong>{trust.trust.product_ids?.join(' / ') || trust.trust_id}</strong><p>{trust.active ? '已信任' : '已撤销'}</p><details><summary>固件信任详情</summary><dl><dt>公钥指纹</dt><dd>{trust.trust.signing_key_id}</dd><dt>制品来源</dt><dd>{trust.trust.download_origins?.join(' / ')}</dd></dl></details></div>{trust.active && <button disabled={!enabled} onClick={() => setRevocation(trust)}>撤销固件信任</button>}</article>)}
      {revocation && <div role="group" aria-label="确认撤销固件信任"><p>尚未执行的关联计划将失效。已经发出的安装不能通过撤销取消。</p><div className="actions"><button disabled={!enabled} onClick={() => void action(() => submit({ type: 'trust.revoke', trust_id: revocation.trust_id, expected_revision: revocation.revision }))}>确认撤销固件信任</button><button disabled={busy} onClick={() => setRevocation(null)}>返回</button></div></div>}
    </section>
    <section className="rule-editor" aria-label="创建升级计划"><h2>创建升级计划</h2><form onSubmit={event => { event.preventDefault(); void action(async () => {
      const manifest = parseBoundedJSON(manifestText, { maxBytes: 15000, maxDepth: 12, maxNodes: 1800 });
      await submit(parseOtaChange(JSON.stringify({ type: 'tasks.plan', device_id: deviceID, trust_id: trustID, manifest, expires_at: new Date(Date.now() + 600000).toISOString() })));
    }); }}>
      <label htmlFor="firmware-device">升级设备</label><select id="firmware-device" value={deviceID} disabled={busy} onChange={event => setDeviceID(event.target.value)}><option value="">请选择</option>{devices.map(device => <option key={device.device_id} value={device.device_id}>{deviceName(device, models)} / {device.device_id}</option>)}</select>
      <label htmlFor="firmware-signer">固件签名者</label><select id="firmware-signer" value={trustID} disabled={busy} onChange={event => setTrustID(event.target.value)}><option value="">请选择</option>{trusts.filter(trust => trust.active).map(trust => <option key={trust.trust_id} value={trust.trust_id}>{trust.trust.product_ids?.join(' / ') || trust.trust_id}</option>)}</select>
      <label htmlFor="firmware-manifest">签名固件清单</label><textarea id="firmware-manifest" rows={5} maxLength={16000} value={manifestText} disabled={busy} spellCheck={false} onChange={event => setManifestText(event.target.value)} />
      <p className="muted">计划有效期10分钟。创建和批准均不安装固件。</p><div className="actions"><button disabled={!enabled || !deviceID || !trustID || !manifestText.trim()}>创建升级计划</button></div>
    </form></section>
    <section aria-label="升级任务"><h2>升级任务</h2>{tasks.length === 0 && <p className="muted">暂无升级任务</p>}{tasks.map(task => <article className="registry-row" data-ota-task={task.task_id} key={task.task_id}><div><strong>{task.device_id}</strong><p>{task.baseline.device.firmware_version} → {task.manifest.statement?.version ?? '未知版本'}</p><p role="status">{taskNames[task.status]}</p>{task.reason && <p>{reasons[task.reason] ?? task.reason}</p>}<details><summary>升级详情</summary><dl><dt>任务编号</dt><dd>{task.task_id}</dd><dt>期限</dt><dd>{when(task.expires_at)}</dd><dt>清单摘要</dt><dd>{task.manifest_digest}</dd></dl></details></div><button disabled={busy || !online} onClick={() => void action(() => readTask(task.task_id))}>读取当前任务</button></article>)}</section>
    {review && <section ref={reviewPanel} tabIndex={-1} className="rule-editor" aria-label="核对升级任务"><h2>核对升级任务</h2><dl><dt>设备</dt><dd>{review.device_id}</dd><dt>计划时版本</dt><dd>{review.baseline.device.firmware_version}</dd><dt>目标版本</dt><dd>{review.manifest.statement?.version ?? '未知版本'}</dd><dt>状态</dt><dd>{taskNames[review.status]}</dd><dt>期限</dt><dd>{when(review.expires_at)}</dd></dl>
      <details><summary>完整任务材料</summary><pre>{JSON.stringify(review, null, 2)}</pre></details>
      {review.status === 'approved' && <p>开始安装后设备可能重启。连接中断时保留原任务，不能重新安装。</p>}
      <div className="actions">{(review.status === 'planned' ? ['tasks.approve', 'tasks.cancel'] : review.status === 'approved' ? ['tasks.execute', 'tasks.cancel'] : ['executing', 'unknown'].includes(review.status) ? ['tasks.reconcile'] : []).map(type => <button key={type} disabled={!enabled} onClick={() => void action(() => submit(parseOtaChange(JSON.stringify({ type, task_id: review.task_id, expected_revision: review.revision }))))}>{changeNames[type as keyof typeof changeNames]}</button>)}<button disabled={busy} onClick={() => setReview(null)}>关闭核对</button></div>
    </section>}
    <section aria-label="升级原操作"><h2>升级原操作</h2>{originals.length === 0 && <p className="muted">暂无操作</p>}{originals.map(original => {
      const key = original.request.idempotency_key, result = results[key];
      return <article className="registry-row" data-ota-key={key} key={key}><div><strong>{changeNames[original.request.change.type]}</strong><p>{result ? operationNames[result.status] : '结果未知'}</p>{result?.reason && <p>{reasons[result.reason] ?? result.reason}</p>}<details><summary>升级操作详情</summary><dl><dt>原操作键</dt><dd>{key}</dd>{result && <><dt>决定时间</dt><dd>{when(result.created_at)}</dd></>}</dl></details></div><button disabled={busy || !online} onClick={() => void action(async () => { await resolve(original); await loadResources(); })}>查询升级原操作</button></article>;
    })}</section>
  </div>;
}

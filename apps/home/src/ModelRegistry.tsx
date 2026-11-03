import { useEffect, useRef, useState } from 'react';
import { parseBoundedJSON } from '../../../packages/protocol/products.mjs';
import { validModelChange, sameModelRequest, verifyModelBinding, verifyModelInstallation, verifyModelOperation, verifyPublisherTrust, verifyModelBundles, type Artifact, type BindingView, type Installation, type ModelBundle, type ModelChange, type ModelOperation, type ModelRequest, type PublisherTrust } from '../../../packages/protocol/model-registry.mjs';
import { ApiError, errorText, request, when, type List, type Session } from './api';

interface Original { version: 1; origin: string; request: ModelRequest }
interface InstalledPage extends List<Installation> { heads: Record<string, string> }
interface InstallReview { text: string; trustID: string; artifact: Artifact; baseline: Installation | null }
const names = { 'trust.add': '信任发布者', 'trust.revoke': '撤销信任', 'models.install': '安装模型', 'devices.bind': '绑定设备', 'devices.bind-bundle': '绑定内置模型' };
const statuses = { applied: '已完成', conflict: '版本冲突', rejected: '已拒绝' };

export function ModelRegistry({ prefix, session, online, onError, refresh }: {
  prefix: string; session: Session; online: boolean; onError: (error: unknown) => void; refresh: () => Promise<void>;
}) {
  const storage = `limeiot.model-operation:${prefix}:`;
  const [trusts, setTrusts] = useState<PublisherTrust[]>([]), [installations, setInstallations] = useState<Installation[]>([]);
  const [bundles, setBundles] = useState<ModelBundle[]>([]);
  const [records, setRecords] = useState<Original[]>([]), [results, setResults] = useState<Record<string, ModelOperation>>({});
  const [blocked, setBlocked] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [trustText, setTrustText] = useState(''), [fingerprint, setFingerprint] = useState('');
  const [artifactText, setArtifactText] = useState(''), [trustID, setTrustID] = useState(''), [review, setReview] = useState<InstallReview | null>(null);
  const [deviceID, setDeviceID] = useState(''), [installationID, setInstallationID] = useState('');
  const [binding, setBinding] = useState<{ id: string; installation: string; value: BindingView } | null>(null);
  const [revocation, setRevocation] = useState<PublisherTrust | null>(null);
  const active = useRef(true), working = useRef(false), generation = useRef(0);
  const originalRef = useRef<Original[]>([]), resultRef = useRef<Record<string, ModelOperation>>({});
  const abort = useRef(new AbortController()), options = { signal: abort.current.signal };
  const space = decodeURIComponent(prefix.split('/').at(-1)!);
  function failure(error: unknown) {
    if (!active.current) return;
    setMessage(error instanceof ApiError ? errorText(error) : error instanceof Error ? ({
      local_record_unavailable: '无法保存或读取本机操作记录，请检查浏览器存储设置',
      invalid_model_input: '请检查 JSON 内容和指纹格式', invalid_model_operation: '响应未通过校验，请查询原操作',
      pending_model_operation: '请先查询同类原操作',
    }[error.message] ?? '操作未完成，请重新读取当前状态') : '操作未完成');
    if (error instanceof ApiError && error.status === 401) onError(error);
  }
  async function action(run: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setMessage('');
    try { await run(); } catch (error) { failure(error); }
    finally { working.current = false; if (active.current) setBusy(false); }
  }
  function readOriginals() {
    const found: Original[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(storage)) continue;
      const value = parseBoundedJSON(localStorage.getItem(key) ?? '', { maxBytes: 18000, maxDepth: 24, maxNodes: 2500 }) as Original;
      if (!value || Object.keys(value).sort().join(',') !== 'origin,request,version' || value.version !== 1 || value.origin !== location.origin ||
        !value.request || Object.keys(value.request).sort().join(',') !== 'change,idempotency_key,space_id' || value.request.space_id !== space ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value.request.idempotency_key) || key !== storage + value.request.idempotency_key || !validModelChange(value.request.change)) throw new Error('local_record_unavailable');
      const previous = originalRef.current.find(item => item.request.idempotency_key === value.request.idempotency_key);
      if (previous && !sameModelRequest(previous, value)) throw new Error('local_record_unavailable');
      found.push(value);
    }
    if (found.length > 128 || originalRef.current.some(item => !found.some(value => sameModelRequest(value, item)))) throw new Error('local_record_unavailable');
    found.sort((a, b) => a.request.idempotency_key.localeCompare(b.request.idempotency_key));
    originalRef.current = found; setRecords(found); return found;
  }
  async function loadResources() {
    const epoch = ++generation.current;
    const [trustPage, first, bundlePage] = await Promise.all([
      request<List<PublisherTrust>>(`${prefix}/model-trusts`, session, undefined, options),
      request<InstalledPage>(`${prefix}/model-installations`, session, undefined, options),
      request<unknown>(`${prefix}/model-bundles`, session, undefined, options).then(verifyModelBundles),
    ]);
    if (!Array.isArray(trustPage.items) || trustPage.items.length > 32 || trustPage.next_cursor !== null || !first.heads || typeof first.heads !== 'object') throw new Error('invalid_model_operation');
    const verifiedTrusts = await Promise.all(trustPage.items.map(verifyPublisherTrust));
    const all: Installation[] = [], cursors = new Set<string>();
    let page = first;
    for (;;) {
      if (!Array.isArray(page.items) || page.items.length > 16 || !sameModelRequest(page.heads, first.heads)) throw new Error('invalid_model_operation');
      all.push(...await Promise.all(page.items.map(verifyModelInstallation)));
      if (all.length > 128 || new Set(all.map(item => item.installation_id)).size !== all.length) throw new Error('invalid_model_operation');
      if (page.next_cursor === null) break;
      if (!/^install-[a-f0-9]{64}$/.test(page.next_cursor) || cursors.has(page.next_cursor)) throw new Error('invalid_model_operation');
      cursors.add(page.next_cursor);
      page = await request<InstalledPage>(`${prefix}/model-installations?after=${encodeURIComponent(page.next_cursor)}`, session, undefined, options);
    }
    const heads = Object.entries(first.heads).map(([model, id]) => {
      const installed = all.find(item => item.installation_id === id);
      if (!installed || installed.artifact.statement.model.model_id !== model) throw new Error('invalid_model_operation');
      return installed;
    });
    if (active.current && epoch === generation.current) { setTrusts(verifiedTrusts); setInstallations(heads); setBundles(bundlePage.items); }
  }
  async function resolve(original: Original) {
    const value = await request<unknown>(`${prefix}/model-operations/by-key/${encodeURIComponent(original.request.idempotency_key)}`, session, undefined, options);
    const verified = await verifyModelOperation(value, original.request);
    if (active.current) { resultRef.current = { ...resultRef.current, [original.request.idempotency_key]: verified }; setResults(resultRef.current); }
  }
  useEffect(() => {
    active.current = true;
    const changed = () => { try { readOriginals(); } catch { setBlocked(true); failure(new Error('local_record_unavailable')); } };
    try { const originals = readOriginals(); if (originals.length) void action(async () => { for (const item of originals) { try { await resolve(item); } catch (error) { failure(error); } } }); }
    catch { setBlocked(true); failure(new Error('local_record_unavailable')); }
    void loadResources().catch(failure);
    window.addEventListener('storage', changed);
    const events = new EventSource(`${prefix}/events/stream`);
    const updated = () => { void loadResources().catch(failure); };
    events.addEventListener('model.operation', updated); events.addEventListener('gap', updated);
    return () => { active.current = false; abort.current.abort(); generation.current++; events.close(); window.removeEventListener('storage', changed); };
  }, []);
  async function submit(change: ModelChange) {
    const existing = readOriginals();
    if (change.type !== 'trust.revoke' && existing.some(item => {
      if (resultRef.current[item.request.idempotency_key]) return false;
      const previous = item.request.change;
      if (change.type === 'devices.bind' || change.type === 'devices.bind-bundle') {
        return (previous.type === 'devices.bind' || previous.type === 'devices.bind-bundle') && previous.device_id === change.device_id;
      }
      return previous.type === change.type;
    })) throw new Error('pending_model_operation');
    if (blocked || existing.length >= 128 || !validModelChange(change)) throw new Error('local_record_unavailable');
    const original: Original = { version: 1, origin: location.origin, request: { space_id: space, idempotency_key: crypto.randomUUID(), change } };
    const key = storage + original.request.idempotency_key, text = JSON.stringify(original);
    try {
      if (localStorage.getItem(key) !== null) throw new Error();
      localStorage.setItem(key, text);
      if (localStorage.getItem(key) !== text) throw new Error();
      readOriginals();
    } catch { setBlocked(true); throw new Error('local_record_unavailable'); }
    try {
      const value = await request<unknown>(`${prefix}/model-operations`, session, change, { ...options, key: original.request.idempotency_key });
      const verified = await verifyModelOperation(value, original.request);
      if (!active.current) return;
      resultRef.current = { ...resultRef.current, [original.request.idempotency_key]: verified }; setResults(resultRef.current);
      setMessage(verified.status === 'applied' ? '操作已完成' : verified.status === 'conflict' ? '状态已变化，请重新读取后操作' : '网关已拒绝此操作');
    } catch (error) { if (active.current) setMessage('结果未知，请查询原操作'); if (error instanceof ApiError && error.status === 401) onError(error); return; }
    if (active.current) { setReview(null); setBinding(null); setRevocation(null); await Promise.all([loadResources(), refresh()]); }
  }
  async function prepareInstallation() {
    setReview(null);
    const parsed = parseBoundedJSON(artifactText, { maxBytes: 16000, maxDepth: 20, maxNodes: 2400 }) as Record<string, unknown>;
    const artifact = (parsed?.artifact ?? parsed) as Artifact;
    if (!artifact?.statement?.model?.model_id || !trusts.some(trust => trust.trust_id === trustID && trust.active)) throw new Error('invalid_model_input');
    const page = await request<InstalledPage>(`${prefix}/model-installations`, session, undefined, options);
    const id = page.heads[String(artifact.statement.model.model_id)];
    const baseline = id ? await verifyModelInstallation(await request<unknown>(`${prefix}/model-installations/${encodeURIComponent(id)}`, session, undefined, options)) : null;
    if (baseline && (baseline.installation_id !== id || baseline.artifact.statement.model.model_id !== artifact.statement.model.model_id)) throw new Error('invalid_model_operation');
    if (active.current) setReview({ text: artifactText, trustID, artifact, baseline });
  }
  const currentReview = review && review.text === artifactText && review.trustID === trustID ? review : null;
  const currentBinding = binding && binding.id === deviceID && binding.installation === installationID ? binding.value : null;
  return <div className="model-registry">
    {message && <p role="status" className="notice">{message}</p>}
    <section className="rule-editor" aria-label="发布者信任"><h2>发布者信任</h2>
      <form onSubmit={event => { event.preventDefault(); void action(async () => {
        const trust = parseBoundedJSON(trustText, { maxBytes: 2048, maxDepth: 2, maxNodes: 16 });
        const change = { type: 'trust.add', trust, expected_signing_key_id: fingerprint.trim() };
        if (!validModelChange(change)) throw new Error('invalid_model_input');
        await submit(change);
      }); }}>
        <label htmlFor="registry-trust-json">发布者信任材料</label><textarea id="registry-trust-json" rows={4} value={trustText} disabled={busy} onChange={event => setTrustText(event.target.value)} spellCheck={false} />
        <label htmlFor="registry-fingerprint">独立核对的公钥指纹</label><input id="registry-fingerprint" value={fingerprint} disabled={busy} onChange={event => setFingerprint(event.target.value)} placeholder="sha256:" autoComplete="off" />
        <div className="actions"><button disabled={busy || blocked || !online || !trustText.trim() || !fingerprint.trim()}>信任发布者</button><button type="button" disabled={busy || !online} onClick={() => void action(loadResources)}>读取当前状态</button></div>
      </form>
      {trusts.map(trust => <article className="registry-row" key={trust.trust_id}><div><strong>{trust.trust.issuer}</strong><p className="muted">{trust.active ? '已信任' : '已撤销'}</p><details><summary>发布者详情</summary><dl><dt>命名空间</dt><dd>{trust.trust.namespace}</dd><dt>公钥指纹</dt><dd>{trust.trust.signing_key_id}</dd></dl></details></div>{trust.active && <button disabled={busy || !online || blocked} onClick={() => setRevocation(trust)}>撤销信任</button>}</article>)}
      {revocation && <div role="group" aria-label="确认撤销"><p>撤销 {revocation.trust.issuer} 的信任后，关联设备停止接受控制。</p><div className="actions"><button disabled={busy || blocked || !online} onClick={() => void action(() => submit({ type: 'trust.revoke', trust_id: revocation.trust_id, expected_revision: revocation.revision }))}>确认撤销</button><button disabled={busy} onClick={() => setRevocation(null)}>取消</button></div></div>}
    </section>
    <section className="rule-editor" aria-label="安装模型"><h2>安装模型</h2><form onSubmit={event => { event.preventDefault(); void action(prepareInstallation); }}>
      <label htmlFor="registry-trust">信任的发布者</label><select id="registry-trust" value={trustID} disabled={busy} onChange={event => { setTrustID(event.target.value); setReview(null); }}><option value="">请选择</option>{trusts.filter(item => item.active).map(item => <option key={item.trust_id} value={item.trust_id}>{item.trust.issuer} / {item.trust.namespace}</option>)}</select>
      <label htmlFor="registry-artifact">签名模型制品</label><textarea id="registry-artifact" rows={5} value={artifactText} disabled={busy} onChange={event => { setArtifactText(event.target.value); setReview(null); }} spellCheck={false} />
      <div className="actions"><button disabled={busy || !online || !artifactText.trim() || !trustID}>读取安装基线</button>{currentReview && <button type="button" className="primary" disabled={busy || blocked || !online} onClick={() => void action(() => submit({ type: 'models.install', trust_id: currentReview.trustID, artifact: currentReview.artifact, expected_release_id: currentReview.baseline?.artifact.statement.release_id ?? null }))}>确认安装</button>}</div>
    </form>{currentReview && <dl><dt>模型</dt><dd>{String(currentReview.artifact.statement.model.model_id)}</dd><dt>待安装版本</dt><dd>{String(currentReview.artifact.statement.model.model_version)}</dd><dt>本地当前版本</dt><dd>{currentReview.baseline ? String(currentReview.baseline.artifact.statement.model.model_version) : '尚未安装'}</dd></dl>}
    </section>
    <section className="rule-editor" aria-label="绑定设备模型"><h2>绑定设备模型</h2><form onSubmit={event => { event.preventDefault(); void action(async () => {
      setBinding(null);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceID)) throw new Error('invalid_model_input');
      const value = verifyModelBinding(await request<unknown>(`${prefix}/devices/${encodeURIComponent(deviceID)}/model-binding`, session, undefined, options), deviceID);
      if (active.current) setBinding({ id: deviceID, installation: installationID, value });
    }); }}>
      <label htmlFor="registry-device">设备编号</label><input id="registry-device" value={deviceID} disabled={busy} onChange={event => { setDeviceID(event.target.value); setBinding(null); }} maxLength={128} autoComplete="off" />
      <label htmlFor="registry-installation">目标模型</label><select id="registry-installation" value={installationID} disabled={busy} onChange={event => { setInstallationID(event.target.value); setBinding(null); }}><option value="">请选择</option><optgroup label="内置模型">{bundles.map(item => <option key={item.bundle_id} value={item.bundle_id}>{String(item.model.model_id)} / {String(item.model.model_version)}</option>)}</optgroup><optgroup label="已安装模型">{installations.filter(item => trusts.some(trust => trust.trust_id === item.trust_id && trust.active)).map(item => <option key={item.installation_id} value={item.installation_id}>{String(item.artifact.statement.model.model_id)} / {String(item.artifact.statement.model.model_version)}</option>)}</optgroup></select>
      <div className="actions"><button disabled={busy || !online || !deviceID || !installationID}>读取设备当前绑定</button>{currentBinding && <button type="button" className="primary" disabled={busy || blocked || !online} onClick={() => void action(() => submit({ ...(installationID.startsWith('bundle-') ? { type: 'devices.bind-bundle' as const, bundle_id: installationID } : { type: 'devices.bind' as const, installation_id: installationID }), device_id: deviceID, expected_model_revision: currentBinding.model_revision, expected_binding_revision: currentBinding.binding?.revision ?? null }))}>确认绑定</button>}</div>
    </form>{currentBinding && <dl><dt>当前模型修订</dt><dd>{currentBinding.model_revision ?? '未注册设备'}</dd><dt>当前绑定修订</dt><dd>{currentBinding.binding?.revision ?? '无动态绑定'}</dd></dl>}</section>
    <section aria-label="模型原操作"><h2>模型原操作</h2>{records.length === 0 && <p className="muted">暂无操作</p>}{records.map(original => {
      const key = original.request.idempotency_key, result = results[key];
      return <article className="registry-row" data-model-key={key} key={key}><div><strong>{names[original.request.change.type]}</strong><p>{result ? statuses[result.status] : '结果未知'}</p><details><summary>操作详情</summary><dl><dt>原操作键</dt><dd>{key}</dd>{result && <><dt>决定时间</dt><dd>{when(result.created_at)}</dd>{result.reason && <><dt>原因</dt><dd>{result.reason}</dd></>}</>}</dl></details></div><button disabled={busy || !online} onClick={() => void action(async () => { await resolve(original); await Promise.all([loadResources(), refresh()]); })}>查询原操作</button></article>;
    })}</section>
  </div>;
}

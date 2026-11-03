import { useEffect, useRef, useState } from 'react';
import { ApiError, deviceName, errorText, request, ruleActionText, sampleEvent, type Device, type Inference, type Model, type RuleDraft, type Session } from './api';
export function RuleDrafts({ devices, models, inference, prefix, session, online, refresh, onError }: {
  devices: Device[]; models: Record<string, Model>; inference: Inference | null; prefix: string; session: Session; online: boolean; refresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const storage = `limeiot.rule-draft:${prefix}`;
  const [prompt, setPrompt] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const active = useRef(true), working = useRef(false);
  const abort = useRef(new AbortController());
  const options = { signal: abort.current.signal };
  function failure(error: unknown) {
    if (!active.current) return;
    setMessage(errorText(error));
    if (error instanceof ApiError && error.status === 401) onError(error);
  }
  async function load(original: string) {
    try {
      const result = await request<RuleDraft>(`${prefix}/rule-drafts/by-key/${encodeURIComponent(original)}`, session, undefined, options);
      if (active.current) { setDraft(result); setPrompt(result.request.prompt); setMessage(''); }
    } catch (error) { failure(error); }
  }
  useEffect(() => {
    active.current = true;
    try {
      const original = localStorage.getItem(storage);
      if (original) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(original)) throw new Error('invalid_pending_draft');
        setKey(original); void load(original);
      }
    } catch { setBlocked(true); setMessage('无法读取本地生成记录，请检查浏览器存储设置'); }
    return () => { active.current = false; abort.current.abort(); };
  }, []);
  useEffect(() => {
    if (draft?.status !== 'running' || !key || !online) return;
    const timer = setTimeout(() => void load(key), 1000);
    return () => clearTimeout(timer);
  }, [draft, key, online]);
  async function action(run: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setMessage(''); setNotice('');
    try { await run(); } catch (error) { failure(error); } finally { working.current = false; if (active.current) setBusy(false); }
  }
  async function generate() {
    const original = crypto.randomUUID();
    await action(async () => {
      try { localStorage.setItem(storage, original); }
      catch { setBlocked(true); setMessage('无法保存本地生成记录，请检查浏览器存储设置'); return; }
      setKey(original); setDraft(null); setProof(null);
      try {
        const result = await request<RuleDraft>(`${prefix}/rule-drafts`, session, { prompt: prompt.trim(), expires_at: new Date(Date.now() + 120000).toISOString() }, { ...options, key: original });
        if (active.current) setDraft(result);
      } catch (error) {
        if (error instanceof ApiError && error.definitiveRejection) {
          localStorage.removeItem(storage); setKey(null);
        }
        throw error;
      }
    });
  }
  function newDraft() {
    try { localStorage.removeItem(storage); setKey(null); setDraft(null); setProof(null); setMessage(''); setNotice(''); }
    catch { setBlocked(true); setMessage('无法更新本地生成记录，请检查浏览器存储设置'); }
  }
  const rule = draft?.rule, serialized = rule ? JSON.stringify(rule) : '';
  const trigger = rule?.trigger.event ? rule.trigger : null;
  function name(id: string) { const device = devices.find(item => item.device_id === id); return device ? deviceName(device, models) : id; }
  async function simulate() {
    if (!rule || !trigger) return;
    await action(async () => {
      setProof(null);
      const source = devices.find(item => item.device_id === trigger.device);
      const schema = source && models[source.model_revision]?.services.flatMap(service => service.events.map(event => ({ path: `${service.id}.${event.id}`, schema: event.schema }))).find(event => event.path === trigger.event)?.schema;
      if (!schema) throw new ApiError('model_mismatch', 409);
      const result = await request<{ matched: boolean; revision: string }>(`${prefix}/rules:simulate`, session, { rule, event: { device_id: trigger.device, path: trigger.event, historical: false, data: sampleEvent(schema) } }, options);
      if (result.matched && result.revision === draft.rule_revision) setProof(serialized);
      else throw new ApiError('model_mismatch', 409);
    });
  }
  const status = draft && { running: '正在生成草案', completed: notice || '草案已生成', rejected: '草案未通过', unknown: '生成结果未知', expired: '生成请求已过期' }[draft.status];
  return <section className="rule-editor ai-rule" aria-label="AI 联动草案"><h2>用一句话设置</h2>{!inference?.configured ? <p className="muted">请先在网关配置本地模型。</p> : <form onSubmit={event => { event.preventDefault(); void generate(); }}>
    <label>希望如何联动<textarea value={prompt} rows={2} maxLength={512} placeholder="按下按钮时，将环境灯亮度设为 40%" onChange={event => { setPrompt(event.target.value); setProof(null); }} disabled={busy || draft?.status === 'running'} /></label>
    <div className="actions"><button disabled={!online || blocked || busy || !prompt.trim() || (!!key && (!draft || draft.status === 'running'))}>生成草案</button>{key && <button type="button" disabled={!online || busy} onClick={() => void action(() => load(key))}>查询生成结果</button>}{key && !draft && <button type="button" disabled={busy || blocked} onClick={newDraft}>新建草案</button>}</div>
  </form>}{status && <p role="status">{status}</p>}{(message || draft?.error) && <p className="error" role="alert">{message || errorText(new ApiError(draft!.error!, 422))}</p>}
    {rule && trigger && draft?.status === 'completed' && prompt.trim() === draft.request.prompt && <div className="draft-review"><p>当{name(trigger.device!)}{trigger.event === 'button.pressed' ? '按下时' : `发生 ${trigger.event}`}：</p><ul>{rule.actions.map((action, index) => <li key={index}>{name(action.device)}{ruleActionText(action)}</li>)}</ul><p className="muted">冷却时间 {rule.cooldown_ms / 1000} 秒</p>
      <div className="actions"><button disabled={!online || busy} onClick={() => void simulate()}>预演草案</button><button className="primary" disabled={!online || busy || proof !== serialized} onClick={() => void action(async () => { await request(`${prefix}/rule-deployments`, session, rule, options); setProof(null); setNotice('自动化已启用'); await refresh(); })}>启用草案</button></div>
      {proof === serialized && <p className="simulation" role="status">预演通过，预计执行 {rule.actions.length} 个设备操作。设备尚未执行。</p>}
      <details><summary>草案内容</summary><pre>{JSON.stringify(rule, null, 2)}</pre></details>
    </div>}
  </section>;
}

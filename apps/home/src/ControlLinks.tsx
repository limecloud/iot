import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request, when, type Session } from './api';
interface Link {
  link_id: string; idempotency_key: string; control_origin: string; pairing_id: string; created_at: string;
  status: 'reviewing' | 'awaiting_approval' | 'claiming' | 'reconciling' | 'active' | 'unknown' | 'rejected' | 'expired' | 'revoked';
  review_revision: string | null; approved_at: string | null; error: string | null;
  review: { pairing: { owner: { name: string; subject: string; issuer: string }; space_id: string; scopes: string[]; expires_at: string } } | null;
}
const status: Record<Link['status'], string> = { reviewing: '正在读取配对信息', awaiting_approval: '等待本地批准', claiming: '正在配对', reconciling: '正在查询原配对', active: '已配对', unknown: '配对结果未知', rejected: '配对未通过', expired: '配对已过期', revoked: '本地连接已撤销' };
const scopes: Record<string, string> = { 'devices.read': '查看设备', 'commands.write': '控制设备', 'rules.read': '查看自动化', 'rules.write': '管理自动化' };
export function ControlLinks({ prefix, session, online, onError }: { prefix: string; session: Session; online: boolean; onError: (error: unknown) => void }) {
  const storage = `limeiot.control-pairing:${prefix}`;
  const [items, setItems] = useState<Link[]>([]), [configured, setConfigured] = useState<boolean | null>(null);
  const [text, setText] = useState(''), [original, setOriginal] = useState<string | null>(null), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const active = useRef(true), working = useRef(false), abort = useRef(new AbortController());
  function failure(error: unknown) { if (!active.current) return; setMessage(errorText(error)); if (error instanceof ApiError && error.status === 401) onError(error); }
  async function refresh() {
    try { const value = await request<{ items: Link[]; configured: boolean }>(`${prefix}/control-pairings`, session, undefined, { signal: abort.current.signal }); if (active.current) { setItems(value.items.sort((a, b) => b.created_at.localeCompare(a.created_at))); setConfigured(value.configured); } } catch (error) { failure(error); }
  }
  async function query(key: string) { const value = await request<Link>(`${prefix}/control-pairings/by-key/${encodeURIComponent(key)}`, session, undefined, { signal: abort.current.signal }); if (active.current) setItems(current => [...current.filter(item => item.link_id !== value.link_id), value]); }
  useEffect(() => {
    active.current = true;
    try { const key = localStorage.getItem(storage); if (key) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error('invalid_record'); setOriginal(key); void query(key).catch(failure); } } catch { setBlocked(true); setMessage('无法读取本地配对记录，请检查浏览器存储设置'); }
    void refresh(); const interval = setInterval(() => void refresh(), 2000);
    return () => { active.current = false; abort.current.abort(); clearInterval(interval); };
  }, []);
  async function action(run: () => Promise<void>) { if (working.current) return; working.current = true; setBusy(true); setMessage(''); try { await run(); } catch (error) { failure(error); } finally { working.current = false; if (active.current) setBusy(false); } }
  async function prepare() {
    await action(async () => {
      let input: { control_origin: string; pairing_id: string; code: string };
      try { const value = JSON.parse(text); input = { control_origin: value.control_origin, pairing_id: value.pairing_id ?? value.pairing?.pairing_id, code: value.code }; if (typeof input.control_origin !== 'string' || typeof input.pairing_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.code)) throw new Error('invalid_pairing'); }
      catch { setMessage('请粘贴控制面提供的完整配对信息'); return; }
      const key = crypto.randomUUID();
      try { localStorage.setItem(storage, key); } catch { setBlocked(true); setMessage('无法保存本地配对记录，请检查浏览器存储设置'); return; }
      setOriginal(key); setText('');
      try { const value = await request<Link>(`${prefix}/control-pairings`, session, input, { key, signal: abort.current.signal }); if (active.current) setItems(current => [...current.filter(item => item.link_id !== value.link_id), value]); }
      catch (error) { if (error instanceof ApiError && error.definitiveRejection) { localStorage.removeItem(storage); setOriginal(null); } throw error; }
    });
  }
  function reset() { try { localStorage.removeItem(storage); setOriginal(null); setMessage(''); } catch { setBlocked(true); setMessage('无法更新本地配对记录，请检查浏览器存储设置'); } }
  const hasAuthority = items.some(item => item.status !== 'revoked' && (item.status === 'active' || item.approved_at));
  const pending = original && items.find(item => item.idempotency_key === original);
  return <section aria-label="网关配对" className="control-links">
    {configured === false && <p className="muted">请先在网关配置允许连接的控制面。</p>}
    {configured && !hasAuthority && !original && <form className="rule-editor" onSubmit={event => { event.preventDefault(); void prepare(); }}><p className="pairing-instruction">粘贴控制面生成的配对信息，读取后核对账号与权限，再批准连接。</p><label>配对信息<textarea autoComplete="off" spellCheck={false} value={text} rows={3} maxLength={8192} onChange={event => setText(event.target.value)} /></label><button className="primary" disabled={!online || busy || blocked || !text.trim()}>读取配对信息</button></form>}
    {original && (!pending || ['revoked', 'rejected', 'expired'].includes(pending.status)) && <div className="actions">{!pending && <button disabled={!online || busy} onClick={() => void action(() => query(original))}>查询原配对</button>}<button disabled={busy || blocked} onClick={reset}>新建配对</button></div>}
    {message && <p role="alert" className="error">{message}</p>}
    {items.map(item => <article className="rule-editor" key={item.link_id} data-link-id={item.link_id}><h3>{item.control_origin}</h3><p role="status">{status[item.status]}</p>
      {item.review && <><dl><dt>目标账号</dt><dd>{item.review.pairing.owner.name || item.review.pairing.owner.subject}</dd><dt>授权范围</dt><dd>{item.review.pairing.scopes.map(scope => scopes[scope] ?? scope).join('、')}</dd>{item.status === 'awaiting_approval' && <><dt>配对有效期</dt><dd>{when(item.review.pairing.expires_at)}</dd></>}</dl><details><summary>配对详情</summary><dl><dt>账号标识</dt><dd>{item.review.pairing.owner.subject}</dd><dt>身份来源</dt><dd>{item.review.pairing.owner.issuer}</dd><dt>控制面空间</dt><dd>{item.review.pairing.space_id}</dd></dl></details></>}
      {item.error && <p className="error">{errorText(new ApiError(item.error, 422))}</p>}
      {item.status === 'awaiting_approval' && <div className="actions"><button className="primary" disabled={!online || busy} onClick={() => void action(async () => { await request(`${prefix}/control-pairings/${item.link_id}/approve`, session, { review_revision: item.review_revision }); await refresh(); })}>批准配对</button><button disabled={!online || busy} onClick={() => void action(async () => { await request(`${prefix}/control-pairings/${item.link_id}/revoke`, session, {}); await refresh(); })}>拒绝配对</button></div>}
      {['active', 'unknown'].includes(item.status) && <div className="actions"><button disabled={!online || busy} onClick={() => void action(async () => { await request(`${prefix}/control-pairings/${item.link_id}/reconcile`, session, {}); await refresh(); })}>核实原配对</button><button disabled={!online || busy} onClick={() => void action(async () => { await request(`${prefix}/control-pairings/${item.link_id}/revoke`, session, {}); await refresh(); })}>撤销本地连接</button></div>}
    </article>)}
  </section>;
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, commandStatus, commandSummary, deviceName, errorText, request, when, type Command, type Deployment, type Device, type Inference, type List, type Model, type Run, type Session } from './api';
import { Automation } from './Automation';
import { Devices } from './Devices';
import { ControlLinks } from './ControlLinks';
import { ModelRegistry } from './ModelRegistry';
import { ObservationSources } from './ObservationSources';
import { ZigbeeCommissioning } from './ZigbeeCommissioning';
import { Firmware } from './Firmware';
import { Media } from './Media';
import { Vision } from './Vision';
import { TextGeneration } from './TextGeneration';
import { AiServices } from './AiServices';
import { ConditionEvidence } from './Conditions';
import { conditionSources } from '../../../packages/protocol/condition-form.mjs';

interface Snapshot { space: string; devices: Device[]; models: Record<string, Model>; inference: Inference | null; commands: Command[]; deployments: Deployment[]; runs: Run[]; next: string | null }
const empty: Snapshot = { space: '', devices: [], models: {}, inference: null, commands: [], deployments: [], runs: [], next: null };
const navigation = [['devices', '设备'], ['automation', '自动化'], ['text', '对话'], ['companion', '陪伴'], ['media', '音频'], ['vision', '视觉'], ['ai', 'AI 服务'], ['activity', '执行记录'], ['connections', '网关配对'], ['models', '设备接入'], ['firmware', '固件升级']] as const;
function currentView() { const view = new URLSearchParams(location.search).get('view'); return navigation.some(([id]) => id === view) ? view! : 'devices'; }
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    devices: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
    automation: 'M5 5h5v5H5z M14 14h5v5h-5z M10 7h7v7 M7 10v7h7',
    activity: 'M12 8v4l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    connections: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
    models: 'M12 3 3 8v9l9 5 9-5V8z M3 8l9 5 9-5 M12 13v9',
    firmware: 'M12 16V3 M7 8l5-5 5 5 M4 14v6h16v-6',
    media: 'M9 18V5l11-2v13 M9 5l11-2 M9 14c-7-2-7 7 0 4 M20 12c-7-2-7 7 0 4',
    vision: 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 M16 9h.01',
    text: 'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',
    companion: 'M8 4h8l4 6-2 10H6L4 10z M9 11h.01 M15 11h.01 M9 15q3 3 6 0',
    ai: 'M7 7h10v10H7z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.devices} /></svg>;
}
export function App({ embeddedView, onExpired }: { embeddedView?: string; onExpired?: () => void }) {
  const [session, setSession] = useState<Session | null>();
  const [bootError, setBootError] = useState('');
  const check = useCallback(() => {
    setBootError('');
    void request<Session>('/api/v1/auth/session').then(setSession).catch(error => {
      if (error instanceof ApiError && error.status === 401) { setSession(null); onExpired?.(); }
      else setBootError(errorText(error));
    });
  }, []);
  useEffect(check, [check]);
  if (session === undefined) return <main className="entry"><Brand /><h1>我的家</h1><p role="status">{bootError || '正在连接家庭网关'}</p>{bootError && <button onClick={check}>重新连接</button>}</main>;
  if (session === null) return <Login onLogin={setSession} />;
  return <Home key={session.csrf_token} session={session} embeddedView={embeddedView} onExpired={() => { setSession(null); onExpired?.(); }} />;
}
function Brand() { return <a className="brand" href="/" aria-label="LimeIoT 我的家"><img src="/icon.svg" alt="" width="32" height="32" /><span>LimeIoT</span></a>; }
function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const session = await request<Session>('/api/v1/auth/session', undefined, { token });
      setToken(''); onLogin(session);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <main className="entry"><Brand /><h1>连接我的家</h1><form onSubmit={event => void submit(event)}>
    <label htmlFor="owner-token">所有者凭据</label>
    <input id="owner-token" type="password" autoComplete="current-password" required maxLength={1024} value={token} onChange={event => setToken(event.target.value)} />
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={busy}>{busy ? '正在连接' : '连接家庭网关'}</button>
  </form><details><summary>从哪里获取凭据</summary><p>使用安装时保存在 NAS 本地的所有者凭据。</p></details></main>;
}
function Home({ session, onExpired, embeddedView }: { session: Session; onExpired: () => void; embeddedView?: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [ownTab, setTab] = useState(currentView);
  const tab = embeddedView ?? ownTab;
  const [mobile, setMobile] = useState(false);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('limeiot-theme') ?? 'system'; } catch { return 'system'; } });
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<string | null>(null);
  const [observationRevision, setObservationRevision] = useState(0);
  const alive = useRef(true);
  const loading = useRef(false);
  const controller = useRef(new AbortController());
  const prefix = snapshot.space ? `/api/v1/spaces/${encodeURIComponent(snapshot.space)}` : '';
  function navigate(view: string) {
    setMobile(false);
    const url = new URL(location.href); url.searchParams.set('view', view);
    if (url.href === location.href) return;
    history.pushState(null, '', url.pathname + url.search); setTab(view);
  }
  useEffect(() => {
    const restore = () => { setTab(currentView()); setMobile(false); };
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobile(false); };
    addEventListener('popstate', restore); addEventListener('keydown', close);
    return () => { removeEventListener('popstate', restore); removeEventListener('keydown', close); };
  }, []);
  useEffect(() => { document.getElementById('home-main')?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }, [tab]);
  const expire = useCallback(() => { if (alive.current) onExpired(); }, [onExpired]);
  const handleError = useCallback((error: unknown) => {
    if (!alive.current) return;
    if (error instanceof ApiError && error.status === 401) expire();
    else { setError(errorText(error)); if (!(error instanceof ApiError)) setOnline(false); }
  }, [expire]);
  const refresh = useCallback(async () => {
    if (loading.current || !alive.current) return;
    loading.current = true;
    try {
      const options = { signal: controller.current.signal };
      const spaces = await request<List<{ space_id: string }>>('/api/v1/spaces', session, undefined, options);
      const space = spaces.items[0]?.space_id;
      if (!space) throw new Error('space_missing');
      const base = `/api/v1/spaces/${encodeURIComponent(space)}`;
      const [devices, capabilities, commands, deployments, runs] = await Promise.all([
        request<List<Device>>(`${base}/devices`, session, undefined, options),
        request<{ models: Record<string, Model>; inference: Inference }>(`${base}/capabilities`, session, undefined, options),
        request<List<Command>>(`${base}/commands`, session, undefined, options),
        request<List<Deployment>>(`${base}/rule-deployments`, session, undefined, options),
        request<List<Run>>(`${base}/runs`, session, undefined, options),
      ]);
      if (alive.current) { setSnapshot({ space, devices: devices.items, models: capabilities.models, inference: capabilities.inference, commands: commands.items, deployments: deployments.items, runs: runs.items, next: commands.next_cursor }); setOnline(true); setError(''); setUpdated(new Date().toISOString()); }
    } catch (error) { handleError(error); } finally { loading.current = false; }
  }, [session, handleError]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    alive.current = true;
    void refreshRef.current();
    const interval = setInterval(() => void refreshRef.current(), 5000);
    const reconnect = () => { void refreshRef.current(); };
    const offline = () => setOnline(false);
    window.addEventListener('online', reconnect); window.addEventListener('offline', offline); window.addEventListener('focus', reconnect);
    return () => { alive.current = false; controller.current.abort(); clearInterval(interval); window.removeEventListener('online', reconnect); window.removeEventListener('offline', offline); window.removeEventListener('focus', reconnect); };
  }, []);
  useEffect(() => {
    if (!prefix) return;
    const source = new EventSource(`${prefix}/events/stream`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => { clearTimeout(timer); timer = setTimeout(() => void refreshRef.current(), 160); };
    const types = ['gateway.recovered', 'broker.disconnected', 'command.created', 'commands.transitioned', 'device.hello', 'device.state', 'device.result', 'device.event', 'adapter.connection', 'adapter.result', 'observation.started', 'observation.received', 'observation.closed', 'observation.operation', 'execution.operation', 'rule.deployed', 'rule.stopped', 'model.operation', 'ota.operation', 'ota.dispatch', 'gap'];
    const sourcesChanged = () => { setObservationRevision(value => value + 1); update(); };
    types.forEach(type => source.addEventListener(type, ['observation.operation', 'gateway.recovered', 'gap'].includes(type) ? sourcesChanged : update));
    source.addEventListener('session.expired', expire);
    source.onopen = update;
    source.onerror = () => { if (alive.current) setOnline(false); update(); };
    return () => { source.close(); clearTimeout(timer); };
  }, [prefix, expire]);
  async function logout() {
    try { await request('/api/v1/auth/logout', session, {}, { method: 'POST' }); expire(); }
    catch (error) { handleError(error); }
  }
  async function more() {
    if (!snapshot.next) return;
    try {
      const page = await request<List<Command>>(`${prefix}/commands?cursor=${encodeURIComponent(snapshot.next)}`, session);
      if (alive.current) setSnapshot(current => ({ ...current, commands: [...new Map([...current.commands, ...page.items].map(item => [item.command_id, item])).values()], next: page.next_cursor }));
    } catch (error) { handleError(error); }
  }
  const Heading = embeddedView === 'connections' ? 'h2' : 'h1';
  const content = <><div className="page-heading"><Heading>{tab === 'devices' ? '我的设备' : tab === 'automation' ? '自动化' : tab === 'text' ? '对话' : tab === 'companion' ? '陪伴' : tab === 'media' ? '音频' : tab === 'vision' ? '视觉' : tab === 'ai' ? 'AI 服务' : tab === 'connections' ? '本地配对批准' : tab === 'models' ? '设备接入' : tab === 'firmware' ? '固件升级' : '执行记录'}</Heading><button onClick={() => void refresh()}>刷新</button></div>
    {(!online || error) && <div className="notice" role="alert">{error || '网关连接已中断，当前显示上次观测'}{updated && <span>上次更新 {when(updated)}</span>}</div>}
    {tab === 'devices' && <Devices {...snapshot} prefix={prefix} session={session} online={online} refresh={refresh} onError={handleError} />}
    {tab === 'automation' && <Automation {...snapshot} prefix={prefix} session={session} online={online} refresh={refresh} onError={handleError} />}
    {tab === 'activity' && <Activity {...snapshot} more={more} />}
    {tab === 'media' && prefix && <Media key={prefix} prefix={prefix} session={session} online={online} devices={snapshot.devices} models={snapshot.models} onError={handleError} />}
    {tab === 'companion' && prefix && <Media key={`companion:${prefix}`} mode="companion" prefix={prefix} session={session} online={online} devices={snapshot.devices} models={snapshot.models} onError={handleError} />}
    {tab === 'vision' && prefix && <Vision key={prefix} prefix={prefix} session={session} online={online} onError={handleError} />}
    {tab === 'text' && prefix && <TextGeneration key={prefix} prefix={prefix} session={session} online={online} onError={handleError} />}
    {tab === 'ai' && prefix && <AiServices key={prefix} prefix={prefix} session={session} online={online} revision={updated} onError={handleError} />}
    {tab === 'connections' && prefix && <ControlLinks prefix={prefix} session={session} online={online} onError={handleError} />}
    {tab === 'models' && prefix && <><ZigbeeCommissioning key={`zigbee:${prefix}`} prefix={prefix} session={session} online={online} onError={handleError} /><ObservationSources key={`sources:${prefix}`} prefix={prefix} session={session} online={online} devices={snapshot.devices} revision={observationRevision} onError={handleError} refresh={refresh} /><ModelRegistry key={prefix} prefix={prefix} session={session} online={online} onError={handleError} refresh={refresh} /></>}
    {tab === 'firmware' && prefix && <Firmware key={prefix} prefix={prefix} session={session} online={online} devices={snapshot.devices} models={snapshot.models} onError={handleError} />}
  </>;
  if (embeddedView) return <div className="local-workspace">{content}</div>;
  return <><a className="skip-link" href="#home-main">跳转到正文</a><header className="topbar"><button className="mobile-toggle" aria-label="家庭导航" aria-expanded={mobile} aria-controls="home-sidebar" onClick={() => setMobile(!mobile)}><Icon name="menu" /></button><Brand /><span className="local-label">本地工作台</span><span className={online ? 'connection' : 'connection disconnected'} role="status">{online ? '本地已连接' : '连接中断'}</span><label className="theme-control"><select aria-label="外观" value={theme} onChange={event => { const next = event.target.value; setTheme(next); if (next === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next; try { localStorage.setItem('limeiot-theme', next); } catch { /* 当前页仍应用所选主题。 */ } }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><button className="text-button" onClick={() => void logout()}>退出登录</button></header>
    {mobile && <button className="sidebar-overlay" aria-label="关闭导航" onClick={() => setMobile(false)} />}
    <div className="shell"><aside id="home-sidebar" className={mobile ? 'open' : undefined}><button className="sidebar-close" onClick={() => setMobile(false)}>关闭导航</button><p className="aside-note">我的家庭</p><nav aria-label="家庭导航">{navigation.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={id} />{label}</button>)}</nav></aside>
      <main id="home-main" className="content" tabIndex={-1}>{content}</main></div></>;
}
function Activity({ commands, devices, models, runs, next, more }: Snapshot & { more: () => Promise<void> }) {
  const sources = conditionSources(devices, models);
  return <><section aria-label="设备操作"><h2>设备操作</h2>{commands.length === 0 && <p className="muted">暂无操作</p>}
    <div className="activity-list">{commands.map(command => <article key={command.command_id} className="activity-row" data-command-id={command.command_id}>
      <div><strong>{devices.find(d => d.device_id === command.request.device_id) ? deviceName(devices.find(d => d.device_id === command.request.device_id)!, models) : command.request.device_id}</strong><p>{commandSummary(command)}</p></div>
      <div><span className={`command-status ${command.status}`}>{commandStatus(command)}</span><details><summary>操作详情</summary><dl><dt>操作编号</dt><dd>{command.command_id}</dd><dt>设备回执</dt><dd>{['device_result', 'action_result'].includes(command.evidence?.type ?? '') ? '已收到' : '未收到'}</dd>{command.run_id && <><dt>关联运行</dt><dd>{command.run_id}</dd></>}{command.error && <><dt>原因</dt><dd>{command.error}</dd></>}</dl></details></div>
    </article>)}</div>{next && <button onClick={() => void more()}>加载更多</button>}</section>
    <section><h2>自动化运行</h2>{runs.length === 0 && <p className="muted">暂无运行</p>}{runs.map(run => <details className="run" key={run.run_id}><summary>{run.error === 'automation_budget_exceeded' ? '自动化操作过于频繁，本次未执行' : run.error === 'rule_conditions_not_met' ? '条件未满足，本次未执行' : run.error ? '运行未完成' : `${run.command_ids.length} 个关联操作`}</summary><dl><dt>运行编号</dt><dd>{run.run_id}</dd><dt>事件编号</dt><dd>{run.event_id}</dd><dt>规则版本</dt><dd>{run.rule_revision}</dd>{run.error && <><dt>原因</dt><dd>{run.error}</dd></>}{run.command_ids.map(id => <div key={id}><dt>操作编号</dt><dd>{id}</dd></div>)}</dl>{run.condition_evaluation && <ConditionEvidence evaluation={run.condition_evaluation} sources={sources} />}</details>)}</section></>;
}

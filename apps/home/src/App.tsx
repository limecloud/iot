import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, deviceName, errorText, request, statusText, when, type Command, type Deployment, type Device, type Inference, type List, type Model, type Run, type Session } from './api';
import { Automation } from './Automation';
import { Devices } from './Devices';
import { ControlLinks } from './ControlLinks';

interface Snapshot { space: string; devices: Device[]; models: Record<string, Model>; inference: Inference | null; commands: Command[]; deployments: Deployment[]; runs: Run[]; next: string | null }
const empty: Snapshot = { space: '', devices: [], models: {}, inference: null, commands: [], deployments: [], runs: [], next: null };
export function App() {
  const [session, setSession] = useState<Session | null>();
  const [bootError, setBootError] = useState('');
  const check = useCallback(() => {
    setBootError('');
    void request<Session>('/api/v1/auth/session').then(setSession).catch(error => {
      if (error instanceof ApiError && error.status === 401) setSession(null);
      else setBootError(errorText(error));
    });
  }, []);
  useEffect(check, [check]);
  if (session === undefined) return <main className="entry"><Brand /><h1>我的家</h1><p role="status">{bootError || '正在连接家庭网关'}</p>{bootError && <button onClick={check}>重新连接</button>}</main>;
  if (session === null) return <Login onLogin={setSession} />;
  return <Home key={session.csrf_token} session={session} onExpired={() => setSession(null)} />;
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
function Home({ session, onExpired }: { session: Session; onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [tab, setTab] = useState('devices');
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<string | null>(null);
  const alive = useRef(true);
  const loading = useRef(false);
  const controller = useRef(new AbortController());
  const prefix = snapshot.space ? `/api/v1/spaces/${encodeURIComponent(snapshot.space)}` : '';
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
    const types = ['gateway.recovered', 'broker.disconnected', 'command.created', 'commands.transitioned', 'device.hello', 'device.state', 'device.result', 'device.event', 'rule.deployed', 'rule.stopped', 'gap'];
    types.forEach(type => source.addEventListener(type, update));
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
  return <><header className="topbar"><Brand /><span className={online ? 'connection' : 'connection disconnected'} role="status">{online ? '本地已连接' : '连接中断'}</span><button className="text-button" onClick={() => void logout()}>退出登录</button></header>
    <div className="shell"><aside><nav aria-label="家庭导航">{[['devices', '设备'], ['automation', '自动化'], ['activity', '执行记录'], ['connections', '网关配对']].map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav><p className="aside-note">我的家庭</p></aside>
      <main className="content"><div className="page-heading"><h1>{tab === 'devices' ? '我的设备' : tab === 'automation' ? '自动化' : tab === 'connections' ? '网关配对' : '执行记录'}</h1><button className="text-button" onClick={() => void refresh()}>刷新</button></div>
        {(!online || error) && <div className="notice" role="alert">{error || '网关连接已中断，当前显示上次观测'}{updated && <span>上次更新 {when(updated)}</span>}</div>}
        {tab === 'devices' && <Devices {...snapshot} prefix={prefix} session={session} online={online} refresh={refresh} onError={handleError} />}
        {tab === 'automation' && <Automation {...snapshot} prefix={prefix} session={session} online={online} refresh={refresh} onError={handleError} />}
        {tab === 'activity' && <Activity {...snapshot} more={more} />}
        {tab === 'connections' && prefix && <ControlLinks prefix={prefix} session={session} online={online} onError={handleError} />}
      </main></div></>;
}
function Activity({ commands, devices, models, runs, next, more }: Snapshot & { more: () => Promise<void> }) {
  return <><section aria-label="设备操作"><h2>设备操作</h2>{commands.length === 0 && <p className="muted">暂无操作</p>}
    <div className="activity-list">{commands.map(command => <article key={command.command_id} className="activity-row" data-command-id={command.command_id}>
      <div><strong>{devices.find(d => d.device_id === command.request.device_id) ? deviceName(devices.find(d => d.device_id === command.request.device_id)!, models) : command.request.device_id}</strong><p>{command.request.operation.path === 'light.power' ? (command.request.operation.value ? '打开' : '关闭') : `${command.request.operation.path === 'light.brightness' ? '亮度' : command.request.operation.path} ${String(command.request.operation.value)}`}</p></div>
      <div><span className={`command-status ${command.status}`}>{statusText[command.status] ?? command.status}</span><details><summary>操作详情</summary><dl><dt>操作编号</dt><dd>{command.command_id}</dd><dt>设备回执</dt><dd>{command.evidence?.type === 'device_result' ? '已收到' : '未收到'}</dd>{command.run_id && <><dt>关联运行</dt><dd>{command.run_id}</dd></>}{command.error && <><dt>原因</dt><dd>{command.error}</dd></>}</dl></details></div>
    </article>)}</div>{next && <button onClick={() => void more()}>加载更多</button>}</section>
    <section><h2>自动化运行</h2>{runs.length === 0 && <p className="muted">暂无运行</p>}{runs.map(run => <details className="run" key={run.run_id}><summary>{run.error ? '运行未完成' : `${run.command_ids.length} 个关联操作`}</summary><dl><dt>运行编号</dt><dd>{run.run_id}</dd><dt>事件编号</dt><dd>{run.event_id}</dd><dt>规则版本</dt><dd>{run.rule_revision}</dd>{run.command_ids.map(id => <div key={id}><dt>操作编号</dt><dd>{id}</dd></div>)}</dl></details>)}</section></>;
}

import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiError, request, type Session } from './api';
import '@limeiot/control-ui/tokens.css';
import './styles.css';

try {
  const theme = localStorage.getItem('limeiot-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* 无法读取偏好时跟随系统。 */ }
const root = createRoot(document.getElementById('root')!);
async function privateWorkspace() {
  const [{ default: Workspace }, { APIError }] = await Promise.all([
    import('@limeiot/control-ui/workspace/App.tsx'),
    import('@limeiot/control-ui/workspace/api.ts'),
    import('@limeiot/control-ui/workspace/styles.css'),
  ]);
  const local = {
    render: (view: string, onExpired: () => void) => <div className="home-app"><App embeddedView={view} onExpired={onExpired} /></div>,
    async check() {
      try { await request<Session>('/api/v1/auth/session'); }
      catch (error) {
        if (error instanceof ApiError && error.status === 401) throw new APIError('identity_rejected', 401);
        throw error;
      }
    },
    async login(token: string) { await request<Session>('/api/v1/auth/session', undefined, { token }); },
    async logout() {
      try {
        const session = await request<Session>('/api/v1/auth/session');
        await request('/api/v1/auth/logout', session, {});
      } catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
    },
  };
  root.render(<Workspace audience="console" locale="zh-CN" deployment={{ basePath: '/', local }} />);
}
async function start() {
  if (location.pathname === '/local/' || location.pathname === '/local') {
    root.render(<div className="home-app"><App /></div>);
    return;
  }
  root.render(<div className="home-app"><main className="entry" role="status">正在连接工作台</main></div>);
  try {
    const response = await fetch('/platform.json', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('installation_unavailable');
    const config: unknown = await response.json();
    if (!config || typeof config !== 'object' || !('mode' in config) || !['private', 'gateway'].includes(String(config.mode))) throw new Error('invalid_installation');
    if (config.mode === 'private') await privateWorkspace();
    else root.render(<div className="home-app"><App /></div>);
  } catch {
    root.render(<div className="home-app"><main className="entry"><h1>无法读取工作台配置</h1><button onClick={() => void start()}>重试</button><a href="/local/">本地维护</a></main></div>);
  }
}
void start();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

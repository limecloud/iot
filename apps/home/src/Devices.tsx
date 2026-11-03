import { useEffect, useRef, useState } from 'react';
import { ApiError, commandStatus, deviceName, request, when, type Command, type Device, type Model, type Session } from './api';
import { ActionControl } from './capabilities/ActionControl';
import { PropertyControl } from './capabilities/PropertyControl';
import { DeviceIntegrations, hasPlaybackControl } from './integrations/DeviceIntegrations';

type Pending = Record<string, { key: string; space: string }>;
function remembered(): Pending { try { return JSON.parse(sessionStorage.getItem('limeiot.pending') ?? '{}') as Pending; } catch { return {}; } }
export function Devices({ devices, models, commands, prefix, session, online, refresh, onError }: {
  devices: Device[]; models: Record<string, Model>; commands: Command[]; prefix: string; session: Session; online: boolean; refresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [pending, setPending] = useState<Pending>(remembered);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  function save(next: Pending) { sessionStorage.setItem('limeiot.pending', JSON.stringify(next)); setPending(next); }
  async function recover(device: string) {
    const old = pending[device]; if (!old || sending.current) return;
    sending.current = true; setBusy(device); setMessage('');
    try {
      await request<Command>(`${prefix}/commands/by-key/${encodeURIComponent(old.key)}`, session);
      if (alive.current) { const next = { ...pending }; delete next[device]; save(next); await refresh(); }
    } catch (error) {
      if (alive.current) {
        if (error instanceof ApiError && error.status === 404) setMessage('尚未查到原操作，请稍后再次查询');
        else onError(error);
      }
    } finally { sending.current = false; if (alive.current) setBusy(null); }
  }
  async function control(device: Device, path: string, value: unknown, type = 'property.set') {
    if (sending.current || pending[device.device_id]) return;
    sending.current = true; setBusy(device.device_id); setMessage('');
    const key = crypto.randomUUID();
    let submitted = false;
    try {
      save({ ...pending, [device.device_id]: { key, space: prefix } });
      submitted = true;
      await request<Command>(`${prefix}/commands`, session, { device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type, path, value } }, { key });
      if (alive.current) { const next = { ...pending }; delete next[device.device_id]; save(next); await refresh(); }
    } catch (error) {
      if (alive.current) {
        if (error instanceof ApiError && error.definitiveRejection) {
          const next = { ...pending }; delete next[device.device_id];
          try { save(next); } catch { setMessage('无法更新本地操作记录，请查询原操作'); }
          onError(error);
        }
        else setMessage(submitted ? '操作结果尚未确认，请查询原操作' : '无法保存本地操作记录，请检查浏览器存储设置');
      }
    } finally { sending.current = false; if (alive.current) setBusy(null); }
  }
  return <>{message && <p className="notice" role="status">{message}</p>}{devices.length === 0 && <p className="muted">尚未连接设备</p>}<div className="device-grid">{devices.map(device => {
    const properties = models[device.model_revision]?.services.flatMap(service => service.properties.map(property => ({ ...property, path: `${service.id}.${property.id}` }))) ?? [];
    const actions = models[device.model_revision]?.services.flatMap(service => (service.actions ?? []).map(action => ({ ...action, path: `${service.id}.${action.id}` }))) ?? [];
    const latest = commands.find(command => command.request.device_id === device.device_id);
    const recovering = !!pending[device.device_id] && pending[device.device_id].space === prefix;
    const active = latest && ['accepted', 'dispatched'].includes(latest.status);
    const disabled = !online || !device.ready || busy !== null || recovering || !!active;
    return <article key={device.device_id} className="device" aria-label={deviceName(device, models)}><div className="device-top"><div className="device-icon" aria-hidden="true">{properties.some(p => p.id === 'power') ? '☼' : '○'}</div><span className={device.ready && online ? 'muted' : 'offline'}>{online && device.ready ? '在线' : '离线'}</span></div><h2>{deviceName(device, models)}</h2>
      {properties.length === 0 && actions.length === 0 && <p className="muted">等待设备事件</p>}
      {properties.map(property => <PropertyControl key={property.path} property={property} device={device} disabled={disabled} onSet={value => void control(device, property.path, value)} />)}
      {actions.filter(action=>!hasPlaybackControl(models[device.model_revision],action)).map(action => <ActionControl key={action.path} action={action} disabled={disabled || device.action_availability?.[action.path] === false} onInvoke={value => void control(device, action.path, value, 'action.invoke')} />)}
      <DeviceIntegrations device={device} model={models[device.model_revision]} prefix={prefix} session={session} online={online} refresh={refresh} disabled={disabled} onInvoke={(path,value)=>void control(device,path,value,'action.invoke')}/>
      {recovering && <button disabled={!online || busy !== null} onClick={() => void recover(device.device_id)}>查询原操作</button>}
      {latest && <p className={`command-status ${latest.status}`} role="status">最近操作：{commandStatus(latest)}</p>}
      <details><summary>设备详情</summary><dl><dt>设备编号</dt><dd>{device.device_id}</dd><dt>最后连接</dt><dd>{when(device.last_seen)}</dd>{Object.entries(device.reported).map(([path, item]) => <div key={path}><dt>{path}</dt><dd>{String(item.value)} / {item.quality === 'stale' ? '已过期' : '有效'}<br />{when(item.observed_at)}<br />来源：{item.source}</dd></div>)}</dl></details>
    </article>;
  })}</div></>;
}

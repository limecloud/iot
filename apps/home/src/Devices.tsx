import { useEffect, useRef, useState } from 'react';
import { ApiError, commandStatus, deviceName, remoteKeyLabels, request, when, type Action, type Command, type Device, type Model, type Property, type Session } from './api';
import { ExecutionBindingControls } from './Television';

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
      {actions.map(action => <ActionControl key={action.path} action={action} disabled={disabled || device.action_availability?.[action.path] === false} onInvoke={value => void control(device, action.path, value, 'action.invoke')} />)}
      {actions.some(action=>action.semantic_id==='urn:limeiot:action:remote-press:1')&&<ExecutionBindingControls device={device} prefix={prefix} session={session} online={online} refresh={refresh} disabled={disabled} onLaunch={id=>void control(device,'apps.launch',{application_id:id},'action.invoke')}/>}
      {actions.some(action=>action.semantic_id.startsWith('urn:limeiot:action:audio-'))&&<ExecutionBindingControls kind="dlna" audioPaths={actions.map(action=>action.path)} device={device} prefix={prefix} session={session} online={online} refresh={refresh} disabled={disabled} onAudio={(path,value)=>void control(device,path,value,'action.invoke')}/>}
      {recovering && <button disabled={!online || busy !== null} onClick={() => void recover(device.device_id)}>查询原操作</button>}
      {latest && <p className={`command-status ${latest.status}`} role="status">最近操作：{commandStatus(latest)}</p>}
      <details><summary>设备详情</summary><dl><dt>设备编号</dt><dd>{device.device_id}</dd><dt>最后连接</dt><dd>{when(device.last_seen)}</dd>{Object.entries(device.reported).map(([path, item]) => <div key={path}><dt>{path}</dt><dd>{String(item.value)} / {item.quality === 'stale' ? '已过期' : '有效'}<br />{when(item.observed_at)}<br />来源：{item.source}</dd></div>)}</dl></details>
    </article>;
  })}</div></>;
}
function ActionControl({ action, disabled, onInvoke }: { action: Action & { path: string }; disabled: boolean; onInvoke: (value: unknown) => void }) {
  const [draft, setDraft] = useState(action.semantic_id === 'urn:limeiot:action:application-launch:1' ? '' : '{}');
  const [error, setError] = useState('');
  function invoke(value: unknown) {
    if (action.risk !== 'low' && !window.confirm(`确认执行 ${action.path}？此操作可能影响设备运行。`)) return;
    onInvoke(value);
  }
  if (['urn:limeiot:action:audio-play:1','urn:limeiot:action:audio-stop:1','urn:limeiot:action:audio-set-volume:1'].includes(action.semantic_id)) return null;
  if (action.semantic_id === 'urn:limeiot:action:remote-press:1') {
    const keys = action.input.properties?.key?.enum?.filter((key): key is string => typeof key === 'string' && Object.hasOwn(remoteKeyLabels, key)) ?? [];
    return <fieldset className="remote-control" disabled={disabled}><legend>遥控器</legend>{keys.map(key => <button className={`remote-key remote-${key}`} type="button" key={key} onClick={() => invoke({ key })}>{remoteKeyLabels[key]}</button>)}</fieldset>;
  }
  if (action.semantic_id === 'urn:limeiot:action:application-launch:1') return <form className="property-form" onSubmit={event => { event.preventDefault(); invoke({ application_id: draft }); }}><label>启动应用<input aria-label="应用标识" value={draft} required maxLength={255} disabled={disabled} onChange={event => setDraft(event.target.value)} placeholder="已获准的应用标识" /></label><button disabled={disabled}>启动应用</button></form>;
  return <form className="property-form" onSubmit={event => { event.preventDefault(); try { const value: unknown = JSON.parse(draft); setError(''); invoke(value); } catch { setError('请输入有效的 JSON 参数'); } }}><label>{action.path}<textarea aria-label={`${action.path} 参数`} value={draft} maxLength={4096} disabled={disabled} onChange={event => setDraft(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<button disabled={disabled}>执行</button></form>;
}
function PropertyControl({ property, device, disabled, onSet }: { property: Property & { path: string }; device: Device; disabled: boolean; onSet: (value: unknown) => void }) {
  const observation = device.reported[property.path];
  const [draft, setDraft] = useState(String(observation?.value ?? property.schema.minimum ?? 0));
  useEffect(() => { setDraft(String(observation?.value ?? property.schema.minimum ?? 0)); }, [observation?.value, property.schema.minimum]);
  const writable = property.access.includes('write');
  const name = property.id === 'power' ? '电源' : property.id === 'brightness' ? '亮度' : property.id === 'volume' ? '音量' : property.id === 'muted' ? '静音' : property.id;
  if (!writable) {
    const label = property.semantic_id === 'urn:limeiot:property:temperature:1' ? '温度' : property.semantic_id === 'urn:limeiot:property:relative-humidity:1' ? '相对湿度' : name;
    const value = observation?.value;
    const display = value === undefined ? '暂无状态' : typeof value === 'number' && property.unit === 'celsius_x100' ? `${(value / 100).toFixed(2)} ℃` : typeof value === 'number' && property.unit === 'percent_x100' ? `${(value / 100).toFixed(2)} %RH` : String(value);
    return <div className="property-row"><span>{label}</span><div><output aria-label={label}>{display}</output>{observation?.quality === 'stale' && <span className="muted"> 已过期</span>}</div></div>;
  }
  if (property.schema.type === 'boolean') return <div className="property-row"><span>{name}</span><button role="switch" aria-label={name} aria-checked={observation?.value === true} disabled={disabled || !writable || !observation} onClick={() => onSet(observation?.value !== true)}>{observation ? (observation.value ? '已开启' : '已关闭') : '暂无状态'}</button></div>;
  if (['integer', 'number'].includes(property.schema.type)) return <form className="property-form" onSubmit={event => { event.preventDefault(); onSet(Number(draft)); }}><label htmlFor={`${device.device_id}-${property.path}`}>{name}</label><div className="input-group"><input id={`${device.device_id}-${property.path}`} type="number" min={property.schema.minimum} max={property.schema.maximum} step={property.schema.type === 'integer' ? 1 : 'any'} required value={draft} disabled={disabled || !writable} onChange={event => setDraft(event.target.value)} /><button disabled={disabled || !writable}>设置</button></div></form>;
  return <p>{name}：{String(observation?.value ?? '暂无状态')}</p>;
}

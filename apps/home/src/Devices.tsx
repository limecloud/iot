import { useEffect, useRef, useState } from 'react';
import { ApiError, commandStatus, deviceName, request, when, type Command, type Device, type Model, type Session } from './api';
import { ActionControl } from './capabilities/ActionControl';
import { PropertyControl } from './capabilities/PropertyControl';
import { DeviceIntegrations, hasPlaybackControl } from './integrations/DeviceIntegrations';
import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';
import { verifyLocalCommand } from '../../../packages/protocol/command-receipts.mjs';
import { readCommandRecords, writeCommandRecords, type PendingCommands } from './command-records';

function remembered(): { records: PendingCommands; blocked: boolean } {
  try { return { records: readCommandRecords(localStorage, sessionStorage), blocked: false }; }
  catch { return { records: {}, blocked: true }; }
}
export function Devices({ devices, models, commands, prefix, session, online, refresh, onError }: {
  devices: Device[]; models: Record<string, Model>; commands: Command[]; prefix: string; session: Session; online: boolean; refresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [initial] = useState(remembered);
  const [pending, setPending] = useState(initial.records);
  const [blocked, setBlocked] = useState(initial.blocked);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    const changed = () => { try { const current = readCommandRecords(localStorage, sessionStorage); setPending(old => ({ ...old, ...current })); } catch { setBlocked(true); } };
    addEventListener('storage', changed); return () => removeEventListener('storage', changed);
  }, []);
  function save(next: PendingCommands) { writeCommandRecords(localStorage, sessionStorage, next); if (alive.current) setPending(next); }
  async function exclusive(action: () => Promise<void>) {
    if (!navigator.locks) throw new Error('command_record_unavailable');
    await navigator.locks.request('limeiot.commands', action);
  }
  function expected(record: PendingCommands[string], response?: Command) {
    // 旧记录只有原键；只读查询时仍核对空间、键和服务端完整回执，不补造原输入。
    const input = record.input ?? response?.request;
    return { ...input, space_id: record.space.split('/').pop(), idempotency_key: record.key };
  }
  function complete(device: string, original: PendingCommands[string]) {
    const next = readCommandRecords(localStorage, sessionStorage);
    if (next[device] && !sameJSON(next[device], original)) throw new Error('command_record_unavailable');
    delete next[device]; save(next);
  }
  async function recover(device: string) {
    const old = pending[device]; if (!old || sending.current) return;
    sending.current = true; setBusy(device); setMessage('');
    try {
      await exclusive(async () => {
        const response = await request<Command>(`${prefix}/commands/by-key/${encodeURIComponent(old.key)}`, session, undefined, { parse: parseBoundedJSON });
        await verifyLocalCommand(response, { ...expected(old, response), device_id: device });
        complete(device, old);
      });
      if (alive.current) await refresh();
    } catch (error) {
      if (alive.current) {
        if (error instanceof ApiError && error.status === 404) setMessage('尚未查到原操作，请稍后再次查询');
        else if (error instanceof ApiError) onError(error);
        else setMessage('原操作尚未核实，请保留记录后再次查询');
      }
    } finally { sending.current = false; if (alive.current) setBusy(null); }
  }
  async function control(device: Device, path: string, value: unknown, type = 'property.set') {
    if (sending.current || blocked || pending[device.device_id]) return;
    sending.current = true; setBusy(device.device_id); setMessage('');
    let submitted = false;
    try {
      await exclusive(async () => {
        const current = readCommandRecords(localStorage, sessionStorage);
        if (current[device.device_id]) { if (alive.current) setPending(current); return; }
        if (!alive.current) return;
        const key = crypto.randomUUID();
        const original = { key, space: prefix, input: { device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type, path, value } } };
        save({ ...current, [device.device_id]: original });
        submitted = true;
        try {
          const response = await request<Command>(`${prefix}/commands`, session, original.input, { key, parse: parseBoundedJSON });
          await verifyLocalCommand(response, expected(original));
          complete(device.device_id, original);
        } catch (error) {
          if (error instanceof ApiError && error.definitiveRejection) complete(device.device_id, original);
          throw error;
        }
      });
      if (alive.current) await refresh();
    } catch (error) {
      if (alive.current) {
        if (error instanceof ApiError && error.definitiveRejection) {
          onError(error);
        }
        else { if (!submitted) setBlocked(true); setMessage(submitted ? '操作结果尚未确认，请查询原操作' : '无法核对本地操作记录，尚未发送请求'); }
      }
    } finally { sending.current = false; if (alive.current) setBusy(null); }
  }
  return <>{blocked && <p className="notice" role="alert">无法核对本地操作记录，请保留记录后检查浏览器存储</p>}{message && <p className="notice" role="status">{message}</p>}{devices.length === 0 && <p className="muted">尚未连接设备</p>}<div className="device-grid">{devices.map(device => {
    const properties = models[device.model_revision]?.services.flatMap(service => service.properties.map(property => ({ ...property, path: `${service.id}.${property.id}` }))) ?? [];
    const actions = models[device.model_revision]?.services.flatMap(service => (service.actions ?? []).map(action => ({ ...action, path: `${service.id}.${action.id}` }))) ?? [];
    const latest = commands.find(command => command.request.device_id === device.device_id);
    const recovering = !!pending[device.device_id] && pending[device.device_id].space === prefix;
    const active = latest && ['accepted', 'dispatched'].includes(latest.status);
    const disabled = blocked || !online || !device.ready || busy !== null || recovering || !!active;
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

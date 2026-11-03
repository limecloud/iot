import { useState } from 'react';
import { remoteKeyLabels, type Action } from '../api';
import { AudioActionControl, supportsAudioControl } from './AudioActionControl';

export function ActionControl({ action, disabled, onInvoke }: { action: Action & { path: string }; disabled: boolean; onInvoke: (value: unknown) => void }) {
  const [draft, setDraft] = useState(action.semantic_id === 'urn:limeiot:action:application-launch:1' ? '' : '{}');
  const [error, setError] = useState('');
  function invoke(value: unknown) {
    if (action.risk !== 'low' && !window.confirm(`确认执行 ${action.path}？此操作可能影响设备运行。`)) return;
    onInvoke(value);
  }
  if (supportsAudioControl(action)) return <AudioActionControl action={action} disabled={disabled} onInvoke={invoke}/>;
  if (action.semantic_id === 'urn:limeiot:action:remote-press:1') {
    const keys = action.input.properties?.key?.enum?.filter((key): key is string => typeof key === 'string' && Object.hasOwn(remoteKeyLabels, key)) ?? [];
    return <fieldset className="remote-control" disabled={disabled}><legend>遥控器</legend>{keys.map(key => <button className={`remote-key remote-${key}`} type="button" key={key} onClick={() => invoke({ key })}>{remoteKeyLabels[key]}</button>)}</fieldset>;
  }
  if (action.semantic_id === 'urn:limeiot:action:application-launch:1') return <form className="property-form" onSubmit={event => { event.preventDefault(); invoke({ application_id: draft }); }}><label>启动应用<input aria-label="应用标识" value={draft} required maxLength={255} disabled={disabled} onChange={event => setDraft(event.target.value)} placeholder="已获准的应用标识" /></label><button disabled={disabled}>启动应用</button></form>;
  return <form className="property-form" onSubmit={event => { event.preventDefault(); try { const value: unknown = JSON.parse(draft); setError(''); invoke(value); } catch { setError('请输入有效的 JSON 参数'); } }}><label>{action.path}<textarea aria-label={`${action.path} 参数`} value={draft} maxLength={4096} disabled={disabled} onChange={event => setDraft(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<button disabled={disabled}>执行</button></form>;
}

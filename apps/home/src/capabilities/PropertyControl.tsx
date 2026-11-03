import { useEffect, useState } from 'react';
import { type Device, type Property } from '../api';

export function PropertyControl({ property, device, disabled, onSet }: { property: Property & { path: string }; device: Device; disabled: boolean; onSet: (value: unknown) => void }) {
  const observation = device.reported[property.path];
  const [draft, setDraft] = useState(String(observation?.value ?? property.schema.minimum ?? 0));
  useEffect(() => { setDraft(String(observation?.value ?? property.schema.minimum ?? 0)); }, [observation?.value, property.schema.minimum]);
  const writable = property.access.includes('write');
  const name = property.id === 'power' ? '电源' : property.id === 'brightness' ? '亮度' : property.id === 'volume' ? '音量' : property.id === 'muted' ? '静音' : property.id;
  if (!writable) {
    const label = property.semantic_id === 'urn:limeiot:property:temperature:1' ? '温度' : property.semantic_id === 'urn:limeiot:property:relative-humidity:1' ? '相对湿度' : name;
    const value = observation?.value;
    const display = value === undefined ? '暂无状态' : typeof value === 'number' && property.unit === 'celsius_x100' ? `${(value / 100).toFixed(2)} ℃` : typeof value === 'number' && property.unit === 'percent_x100' ? `${(value / 100).toFixed(2)} %RH` : typeof value === 'number' && property.unit === 'percent' ? `${value} %` : typeof value === 'boolean' && property.semantic_id === 'urn:limeiot:property:muted:1' ? (value ? '已静音' : '未静音') : String(value);
    return <div className="property-row"><span>{label}</span><div><output aria-label={label}>{display}</output>{observation?.quality === 'stale' && <span className="muted"> 已过期</span>}</div></div>;
  }
  if (property.schema.type === 'boolean') return <div className="property-row"><span>{name}</span><button role="switch" aria-label={name} aria-checked={observation?.value === true} disabled={disabled || !writable || !observation} onClick={() => onSet(observation?.value !== true)}>{observation ? (observation.value ? '已开启' : '已关闭') : '暂无状态'}</button></div>;
  if (['integer', 'number'].includes(property.schema.type)) return <form className="property-form" onSubmit={event => { event.preventDefault(); onSet(Number(draft)); }}><label htmlFor={`${device.device_id}-${property.path}`}>{name}</label><div className="input-group"><input id={`${device.device_id}-${property.path}`} type="number" min={property.schema.minimum} max={property.schema.maximum} step={property.schema.type === 'integer' ? 1 : 'any'} required value={draft} disabled={disabled || !writable} onChange={event => setDraft(event.target.value)} /><button disabled={disabled || !writable}>设置</button></div></form>;
  return <p>{name}：{String(observation?.value ?? '暂无状态')}</p>;
}

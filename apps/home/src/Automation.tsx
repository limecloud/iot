import { useRef, useState } from 'react';
import { deviceName, request, sampleEvent, when, type Deployment, type Device, type Inference, type Model, type Rule, type Session } from './api';
import { RuleDrafts } from './RuleDrafts';

export function Automation({ devices, models, inference, deployments, prefix, session, online, refresh, onError }: {
  devices: Device[]; models: Record<string, Model>; inference: Inference | null; deployments: Deployment[]; prefix: string; session: Session; online: boolean; refresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const sources = devices.flatMap(device => models[device.model_revision]?.services.flatMap(service => service.events.map(event => ({ key: `${device.device_id}/${service.id}.${event.id}`, device: device.device_id, path: `${service.id}.${event.id}`, name: `${deviceName(device, models)} ${event.id === 'pressed' ? '按下时' : event.id}`, schema: event.schema }))) ?? []);
  const targets = devices.flatMap(device => models[device.model_revision]?.services.flatMap(service => service.properties.filter(property => property.access.includes('write') && ['boolean', 'integer', 'number'].includes(property.schema.type)).map(property => ({ key: `${device.device_id}/${service.id}.${property.id}`, device: device.device_id, path: `${service.id}.${property.id}`, name: `${deviceName(device, models)} ${property.id === 'power' ? '电源' : property.id === 'brightness' ? '亮度' : property.id}`, property }))) ?? []);
  const [id, setId] = useState(() => `rule-${crypto.randomUUID()}`);
  const [sourceKey, setSourceKey] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [value, setValue] = useState('true');
  const [cooldown, setCooldown] = useState('10');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [proof, setProof] = useState<{ serialized: string; revision: string; matched: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const source = sources.find(item => item.key === sourceKey) ?? sources[0];
  const target = targets.find(item => item.key === targetKey) ?? targets[0];
  const rule: Rule = { version: 1, id, trigger: { device: source?.device ?? '', event: source?.path ?? '' }, conditions: [], actions: [{ device: target?.device ?? '', set: { path: target?.path ?? '', value: target?.property.schema.type === 'boolean' ? value === 'true' : Number(value) } }], cooldown_ms: Number(cooldown) * 1000 };
  const serialized = JSON.stringify(rule);
  const valid = source && target && Number.isFinite(Number(cooldown)) && Number(cooldown) >= 0 && Number(cooldown) <= 86400 && (target.property.schema.type === 'boolean' || (value !== '' && Number.isFinite(Number(value)) && (target.property.schema.minimum === undefined || Number(value) >= target.property.schema.minimum) && (target.property.schema.maximum === undefined || Number(value) <= target.property.schema.maximum)));
  async function action(run: () => Promise<void>) {
    if (working.current) return; working.current = true; setBusy(true); setMessage('');
    try { await run(); } catch (error) { onError(error); } finally { working.current = false; setBusy(false); }
  }
  async function simulate() {
    if (!valid) return;
    await action(async () => {
      setProof(null);
      await request(`${prefix}/rules:validate`, session, rule);
      const result = await request<{ revision: string; matched: boolean; executed: false }>(`${prefix}/rules:simulate`, session, { rule, event: { device_id: source.device, path: source.path, historical: false, data: sampleEvent(source.schema) } });
      setProof({ serialized, revision: result.revision, matched: result.matched });
    });
  }
  async function deploy() {
    if (!proof?.matched || proof.serialized !== serialized) return;
    await action(async () => { await request(`${prefix}/rule-deployments`, session, rule); setMessage('自动化已启用'); setProof(null); await refresh(); });
  }
  function edit(deployment: Deployment) {
    setId(deployment.rule.id); setSourceKey(`${deployment.rule.trigger.device}/${deployment.rule.trigger.event}`);
    const first = deployment.rule.actions[0]; setTargetKey(`${first.device}/${first.set.path}`); setValue(String(first.set.value)); setCooldown(String(deployment.rule.cooldown_ms / 1000)); setProof(null); setMessage('');
  }
  return <><RuleDrafts key={prefix} devices={devices} models={models} inference={inference} prefix={prefix} session={session} online={online} refresh={refresh} onError={onError} /><section className="rule-editor"><h2>设置联动</h2>{(!source || !target) ? <p className="muted">连接支持事件和控制的设备后，可以创建联动。</p> : <form onSubmit={event => { event.preventDefault(); void simulate(); }}>
    <div className="rule-fields"><label>当<select value={source?.key ?? ''} onChange={event => setSourceKey(event.target.value)} disabled={busy}>{sources.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
      <label>执行<select value={target?.key ?? ''} onChange={event => { const next = targets.find(item => item.key === event.target.value)!; setTargetKey(next.key); setValue(next.property.schema.type === 'boolean' ? 'true' : String(next.property.schema.minimum ?? 0)); }} disabled={busy}>{targets.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
      <label>设为{target?.property.schema.type === 'boolean' ? <select value={value} onChange={event => setValue(event.target.value)} disabled={busy}><option value="true">开启</option><option value="false">关闭</option></select> : <input type="number" required value={value} min={target?.property.schema.minimum} max={target?.property.schema.maximum} step={target?.property.schema.type === 'integer' ? 1 : 'any'} onChange={event => setValue(event.target.value)} disabled={busy} />}</label>
      <label>冷却时间（秒）<input type="number" value={cooldown} min="0" max="86400" step="1" required onChange={event => setCooldown(event.target.value)} disabled={busy} /></label>
    </div><div className="actions"><button disabled={!online || busy || !valid}>{busy ? '处理中' : '校验并预演'}</button><button type="button" className="primary" disabled={!online || busy || !proof?.matched || proof.serialized !== serialized} onClick={() => void deploy()}>启用自动化</button></div>
    {proof && proof.serialized === serialized && <p className="simulation" role="status">{proof.matched ? '预演通过，预计执行 1 个设备操作。设备尚未执行。' : '预演未匹配，请调整设置。'}</p>}
    <details><summary>规则内容</summary><pre>{JSON.stringify(rule, null, 2)}</pre></details>
  </form>}{message && <p role="status">{message}</p>}</section>
    <section><div className="section-heading"><h2>已启用</h2><button className="text-button" onClick={() => { setId(`rule-${crypto.randomUUID()}`); setProof(null); setMessage('已切换到新自动化'); }}>新建自动化</button></div>{deployments.length === 0 && <p className="muted">暂无自动化</p>}{deployments.map(deployment => <article className="deployment" key={deployment.rule.id}><div><h3>{sources.find(item => item.device === deployment.rule.trigger.device && item.path === deployment.rule.trigger.event)?.name ?? deployment.rule.id}</h3><p className="muted">最近触发 {when(deployment.last_run)}</p></div><div className="actions"><button disabled={busy} onClick={() => edit(deployment)}>编辑</button><button disabled={!online || busy} onClick={() => void action(async () => { await request(`${prefix}/rule-deployments/${encodeURIComponent(deployment.rule.id)}/stop`, session, { revision: deployment.revision }); setMessage('自动化已停用'); await refresh(); })}>停用</button></div></article>)}</section>
  </>;
}

import { useRef, useState } from 'react';
import { ApiError, deviceName, request, ruleActionText, ruleTriggerText, sampleEvent, when, type Deployment, type Device, type Inference, type Model, type Rule, type Session, type Schema } from './api';
import { RuleDrafts } from './RuleDrafts';
import { displayNumber, thresholdSamples, thresholdTrigger, unitLabel, unitScale } from './threshold';
import { compileConditions, conditionSources, restoreConditions, type ConditionForm } from '../../../packages/protocol/condition-form.mjs';
import { verifyRuleSimulation, type RuleSimulation } from '../../../packages/protocol/rule-simulation.mjs';
import { ConditionEditor, ConditionEvidence, ConditionSummary } from './Conditions';
import { scheduleTrigger } from '../../../packages/protocol/schedule-form.mjs';
import { Composition } from './Composition';

export function Automation({ devices, models, inference, deployments, prefix, session, online, refresh, onError }: {
  devices: Device[]; models: Record<string, Model>; inference: Inference | null; deployments: Deployment[]; prefix: string; session: Session; online: boolean; refresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const sources = devices.flatMap(device => models[device.model_revision]?.services.flatMap(service => [
    ...service.events.map(event => ({ key: `${device.device_id}/${service.id}.${event.id}`, device: device.device_id, path: `${service.id}.${event.id}`, name: `${deviceName(device, models)} ${event.id === 'pressed' ? '按下时' : event.id}`, schema: event.schema, kind: 'event' as const, unit: '' })),
    ...service.properties.filter(property => ['integer', 'number'].includes(property.schema.type) && property.access.includes('read') && property.access.includes('notify') && property.unit).map(property => ({ key: `${device.device_id}/property/${service.id}.${property.id}`, device: device.device_id, path: `${service.id}.${property.id}`, name: `${deviceName(device, models)} ${property.id === 'temperature' ? '温度' : property.id === 'humidity' ? '相对湿度' : property.id === 'brightness' ? '亮度' : property.id}`, schema: property.schema, kind: 'property' as const, unit: property.unit! })),
  ]) ?? []).sort((a, b) => Number(a.kind === 'property') - Number(b.kind === 'property'));
  const targets = devices.flatMap(device => models[device.model_revision]?.services.flatMap(service => [
    ...service.properties.filter(property => property.access.includes('write') && ['boolean', 'integer', 'number'].includes(property.schema.type)).map(property => ({ key: `${device.device_id}/set/${service.id}.${property.id}`, device: device.device_id, path: `${service.id}.${property.id}`, name: `${deviceName(device, models)} ${property.id === 'power' ? '电源' : property.id === 'brightness' ? '亮度' : property.id}`, kind: 'set' as const, schema: property.schema as Schema })),
    ...(service.actions ?? []).map(action => ({ key: `${device.device_id}/invoke/${service.id}.${action.id}`, device: device.device_id, path: `${service.id}.${action.id}`, name: `${deviceName(device, models)} ${service.id}.${action.id}`, kind: 'invoke' as const, schema: action.input })),
  ]) ?? []);
  const [id, setId] = useState(() => `rule-${crypto.randomUUID()}`);
  const [sourceKey, setSourceKey] = useState('');
  const [scheduled, setScheduled] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('22:00');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6, 7]);
  const [targetKey, setTargetKey] = useState('');
  const [value, setValue] = useState('true');
  const [input, setInput] = useState('');
  const [cooldown, setCooldown] = useState('10');
  const [edge, setEdge] = useState<'rising' | 'falling'>('rising');
  const [threshold, setThreshold] = useState('28');
  const [hysteresis, setHysteresis] = useState('1');
  const [busy, setBusy] = useState(false);
  const [conditions, setConditions] = useState<ConditionForm[]>([]);
  const [editing, setEditing] = useState(false);
  const working = useRef(false);
  const [proof, setProof] = useState<{ serialized: string; simulation: RuleSimulation; scheduledAt?: string } | null>(null);
  const [message, setMessage] = useState('');
  const source = sourceKey ? sources.find(item => item.key === sourceKey) : sources[0];
  const target = targetKey ? targets.find(item => item.key === targetKey) : targets[0];
  const conditionOptions = conditionSources(devices, models).map(source => ({ ...source, name: `${deviceName(devices.find(device => device.device_id === source.device)!, models)} ${source.path}` }));
  const compiledConditions = compileConditions(conditions, conditionOptions);
  let actionInput: unknown; let inputValid = false;
  try { actionInput = JSON.parse(input); inputValid = true; } catch { /* 保留用户未完成的输入，由预演校验最终 Schema。 */ }
  const property = !scheduled && source?.kind === 'property' ? thresholdTrigger(source.path, source.unit, source.schema, edge, threshold, hysteresis) : null;
  const schedule = scheduleTrigger(scheduleTime, timeZone, weekdays);
  const [seconds, milliseconds = ''] = cooldown.trim().split('.');
  const cooldownMs = /^\d+(?:\.\d{0,3})?$/.test(cooldown.trim()) ? Number(seconds) * 1000 + Number(milliseconds.padEnd(3, '0')) : null;
  const rule: Rule = { version: 1, id, trigger: scheduled ? { schedule: schedule ?? { time: scheduleTime, time_zone: timeZone, weekdays } } : source?.kind === 'property' ? { device: source.device, property: property ?? { path: source.path, unit: source.unit, edge, threshold: 0, hysteresis: 0 } } : { device: source?.device ?? '', event: source?.path ?? '' }, conditions: compiledConditions ?? [], actions: [target?.kind === 'invoke' ? { device: target.device, invoke: { path: target.path, input: actionInput ?? null } } : { device: target?.device ?? '', set: { path: target?.path ?? '', value: target?.schema.type === 'boolean' ? value === 'true' : Number(value) } }], cooldown_ms: cooldownMs ?? 0 };
  const serialized = JSON.stringify(rule);
  const valid = compiledConditions !== null && target && (scheduled ? schedule !== null : source && (source.kind === 'event' || property && thresholdSamples(property, source.schema))) && cooldownMs !== null && Number.isSafeInteger(cooldownMs) && cooldownMs <= 86400000 && (target.kind === 'invoke' ? inputValid : target.schema.type === 'boolean' || (value !== '' && Number.isFinite(Number(value)) && (target.schema.type !== 'integer' || Number.isInteger(Number(value))) && (target.schema.minimum === undefined || Number(value) >= target.schema.minimum) && (target.schema.maximum === undefined || Number(value) <= target.schema.maximum)));
  async function action(run: () => Promise<void>) {
    if (working.current) return; working.current = true; setBusy(true); setMessage('');
    try { await run(); } catch (error) { onError(error); } finally { working.current = false; setBusy(false); }
  }
  async function simulate() {
    if (!valid) return;
    await action(async () => {
      setProof(null);
      const validation = await request<{valid: boolean; revision: string; schedule_preview?: { scheduled_at: string }}>(`${prefix}/rules:validate`, session, rule);
      if (scheduled && !validation.schedule_preview?.scheduled_at) throw new ApiError('invalid_simulation', 502);
      const samples = property && source ? thresholdSamples(property, source.schema) : null;
      const event = scheduled ? { scheduled_at: validation.schedule_preview!.scheduled_at } : { device_id: source!.device, path: source!.path, historical: false, ...(property ? samples : { data: sampleEvent(source!.schema) }) };
      const result = await request<RuleSimulation>(`${prefix}/rules:simulate`, session, { rule, event });
      try { await verifyRuleSimulation(rule, result, validation); } catch { throw new ApiError('invalid_simulation', 502); }
      setProof({ serialized, simulation: result, scheduledAt: validation.schedule_preview?.scheduled_at });
    });
  }
  async function deploy() {
    if (!valid || !proof || proof.serialized !== serialized) return;
    await action(async () => { await request(`${prefix}/rule-deployments`, session, rule); setMessage('自动化已启用'); setProof(null); await refresh(); });
  }
  function edit(deployment: Deployment) {
    if (!editable(deployment)) return;
    const first = deployment.rule.actions[0];
    const kind = first.invoke ? 'invoke' : 'set';
    const path = first.invoke?.path ?? first.set!.path;
    const trigger = deployment.rule.trigger;
    setId(deployment.rule.id); setScheduled(!!trigger.schedule);
    if (trigger.schedule) { setScheduleTime(trigger.schedule.time); setTimeZone(trigger.schedule.time_zone); setWeekdays([...trigger.schedule.weekdays]); }
    else setSourceKey(`${trigger.device}/${trigger.property ? `property/${trigger.property.path}` : trigger.event}`);
    if (trigger.property) { setEdge(trigger.property.edge); setThreshold(displayNumber(trigger.property.threshold, trigger.property.unit)); setHysteresis(displayNumber(trigger.property.hysteresis, trigger.property.unit)); }
    setTargetKey(`${first.device}/${kind}/${path}`); setValue(String(first.set?.value)); setInput(JSON.stringify(first.invoke?.input ?? null)); setCooldown(String(deployment.rule.cooldown_ms / 1000)); setConditions(restoreConditions(deployment.rule.conditions, conditionOptions)!); setEditing(true); setProof(null); setMessage('');
  }
  function editable(deployment: Deployment) {
    const { rule } = deployment;
    if (rule.version !== 1 || restoreConditions(rule.conditions, conditionOptions) === null || rule.actions.length !== 1) return false;
    const first = rule.actions[0], trigger = rule.trigger;
    return targets.some(item => item.key === `${first.device}/${first.invoke ? 'invoke' : 'set'}/${first.invoke?.path ?? first.set!.path}`) && (trigger.schedule ? scheduleTrigger(trigger.schedule.time, trigger.schedule.time_zone, trigger.schedule.weekdays) !== null : sources.some(item => item.key === `${trigger.device}/${trigger.property ? `property/${trigger.property.path}` : trigger.event}`));
  }
  function newRule() { setId(`rule-${crypto.randomUUID()}`); setSourceKey(''); setScheduled(false); setScheduleTime('22:00'); setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone); setWeekdays([1,2,3,4,5,6,7]); setTargetKey(''); setValue('true'); setInput(''); setCooldown('10'); setEdge('rising'); setThreshold('28'); setHysteresis('1'); setConditions([]); setEditing(false); setProof(null); setMessage(''); }
  return <><Composition key={`composition:${prefix}`} devices={devices} models={models} prefix={prefix} session={session} online={online} refresh={refresh} onError={onError} /><RuleDrafts key={prefix} devices={devices} models={models} inference={inference} prefix={prefix} session={session} online={online} refresh={refresh} onError={onError} /><section className="rule-editor"><h2>设置联动</h2>{!target ? <p className="muted">连接支持控制的设备后，可以创建联动。</p> : <form onSubmit={event => { event.preventDefault(); void simulate(); }}>
    <div className="rule-fields"><label>触发方式<select aria-label="触发方式" value={scheduled ? 'schedule' : 'device'} onChange={event => setScheduled(event.target.value === 'schedule')} disabled={busy}><option value="device">设备事件或属性</option><option value="schedule">定时</option></select></label>
      {scheduled ? <><label>时间<input type="time" required value={scheduleTime} onChange={event => setScheduleTime(event.target.value)} disabled={busy} /></label><label>时区<input required value={timeZone} onChange={event => setTimeZone(event.target.value)} placeholder="Asia/Shanghai" disabled={busy} /></label><fieldset className="schedule-weekdays"><legend>重复</legend>{['周一','周二','周三','周四','周五','周六','周日'].map((name, index) => <label key={name}><input type="checkbox" checked={weekdays.includes(index + 1)} onChange={event => setWeekdays(event.target.checked ? [...weekdays, index + 1] : weekdays.filter(day => day !== index + 1))} disabled={busy} />{name}</label>)}</fieldset></> : <label>当<select aria-label="当" value={source?.key ?? ''} onChange={event => setSourceKey(event.target.value)} disabled={busy}>{sources.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>}
      {!scheduled && source?.kind === 'property' && <><label>变化方向<select aria-label="变化方向" value={edge} onChange={event => setEdge(event.target.value as 'rising' | 'falling')} disabled={busy}><option value="rising">上升越过</option><option value="falling">下降越过</option></select></label><label>阈值（{unitLabel(source.unit)}）<input type="number" required value={threshold} min={source.schema.minimum === undefined ? undefined : source.schema.minimum / unitScale(source.unit)} max={source.schema.maximum === undefined ? undefined : source.schema.maximum / unitScale(source.unit)} step={source.schema.type === 'integer' ? 1 / unitScale(source.unit) : 'any'} onChange={event => setThreshold(event.target.value)} disabled={busy} /></label><label>滞回（{unitLabel(source.unit)}）<input type="number" required value={hysteresis} min="0" step={source.schema.type === 'integer' ? 1 / unitScale(source.unit) : 'any'} onChange={event => setHysteresis(event.target.value)} disabled={busy} /></label></>}
      <label>执行<select aria-label="执行" value={target?.key ?? ''} onChange={event => { const next = targets.find(item => item.key === event.target.value)!; setTargetKey(next.key); setValue(next.schema.type === 'boolean' ? 'true' : String(next.schema.minimum ?? 0)); setInput(JSON.stringify(sampleEvent(next.schema))); }} disabled={busy}>{targets.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
      {target.kind === 'invoke' ? <label>动作参数（JSON）<textarea aria-label="动作参数（JSON）" required value={input} onChange={event => setInput(event.target.value)} disabled={busy} rows={3} /></label> : <label>设为{target.schema.type === 'boolean' ? <select value={value} onChange={event => setValue(event.target.value)} disabled={busy}><option value="true">开启</option><option value="false">关闭</option></select> : <input type="number" required value={value} min={target.schema.minimum} max={target.schema.maximum} step={target.schema.type === 'integer' ? 1 : 'any'} onChange={event => setValue(event.target.value)} disabled={busy} />}</label>}
      <label>冷却时间（秒）<input type="number" value={cooldown} min="0" max="86400" step="0.001" required onChange={event => setCooldown(event.target.value)} disabled={busy} /></label>
    </div><ConditionEditor forms={conditions} sources={conditionOptions} onChange={setConditions} disabled={busy} />{compiledConditions === null && <p className="error" role="status">请检查条件值、组合层级和数量。每组最多 16 项，共 32 项，最多 4 层。</p>}<div className="actions"><button disabled={!online || busy || !valid}>{busy ? '处理中' : '校验并预演'}</button><button type="button" className="primary" disabled={!online || busy || !valid || !proof || proof.serialized !== serialized} onClick={() => void deploy()}>启用自动化</button>{editing && <button type="button" disabled={busy} onClick={newRule}>取消编辑</button>}</div>
    {proof && valid && proof.serialized === serialized && <><p className="simulation" role="status">{proof.simulation.matched ? '预演通过，预计执行 1 个设备操作。设备尚未执行。' : '触发样例有效，当前条件未满足。启用后等待新的触发，不会补执行。'}</p>{proof.simulation.condition_evaluation && <ConditionEvidence evaluation={proof.simulation.condition_evaluation} sources={conditionOptions} />}</>}
    {proof?.serialized === serialized && proof.scheduledAt && <p className="muted">下次执行 {new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(proof.scheduledAt))}，{timeZone}</p>}
    {!scheduled && source?.kind === 'property' && <p className="muted">预演使用示例采样，不控制设备。</p>}<details><summary>规则内容</summary><pre>{JSON.stringify(rule, null, 2)}</pre></details>
  </form>}{message && <p role="status">{message}</p>}</section>
    <section><div className="section-heading"><h2>已启用</h2><button className="text-button" disabled={busy} onClick={newRule}>新建自动化</button></div>{deployments.length === 0 && <p className="muted">暂无自动化</p>}{deployments.map(deployment => <article className="deployment" key={deployment.rule.id}><div><h3>{deployment.rule.trigger.property || deployment.rule.trigger.schedule ? ruleTriggerText(deployment.rule.trigger) : sources.find(item => item.device === deployment.rule.trigger.device && item.path === deployment.rule.trigger.event)?.name ?? deployment.rule.id}</h3><ol className="deployment-actions">{deployment.rule.actions.map((item, index) => <li key={index}>{deviceName(devices.find(device => device.device_id === item.device) ?? { device_id: item.device } as Device, models)} {ruleActionText(item)}</li>)}</ol><ConditionSummary conditions={deployment.rule.conditions} sources={conditionOptions} /><p className="muted">最近触发 {when(deployment.last_run)}</p></div><div className="actions"><button disabled={busy || !editable(deployment)} onClick={() => edit(deployment)}>编辑</button><button disabled={!online || busy} onClick={() => void action(async () => { await request(`${prefix}/rule-deployments/${encodeURIComponent(deployment.rule.id)}/stop`, session, { revision: deployment.revision }); setMessage('自动化已停用'); await refresh(); })}>停用</button></div></article>)}</section>
  </>;
}

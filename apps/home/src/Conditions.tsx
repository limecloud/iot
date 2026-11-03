import { conditionOperators, newCondition, operatorsFor, type Condition, type ConditionForm, type ConditionSource } from '../../../packages/protocol/condition-form.mjs';
import type { ConditionEvaluation, ConditionResult } from '../../../packages/protocol/rule-simulation.mjs';
import { displayNumber, unitLabel } from './threshold';
import { when } from './api';

const countNodes = (forms: ConditionForm[]): number => forms.reduce((count, form) => count + 1 + (form.kind === 'compare' ? 0 : countNodes(form.children)), 0);
export function ConditionEditor({ forms, sources, onChange, disabled }: { forms: ConditionForm[]; sources: ConditionSource[]; onChange: (forms: ConditionForm[]) => void; disabled: boolean }) {
  const total = countNodes(forms);
  function list(nodes: ConditionForm[], update: (nodes: ConditionForm[]) => void, depth = 1, prefix = '') {
    const replace = (index: number, value: ConditionForm) => update(nodes.map((node, i) => i === index ? value : node));
    return <div className="condition-list">{nodes.map((node, index) => {
      const label = `条件 ${prefix}${index + 1}`;
      const source = node.kind === 'compare' ? sources.find(source => source.key === node.source) : undefined;
      return <fieldset key={index} className="condition-node" aria-label={label}><legend>{label}</legend>
        {node.kind === 'compare' ? <div className="condition-fields"><label>属性<select aria-label={`${label} 属性`} value={node.source} disabled={disabled} onChange={event => { const source = sources.find(source => source.key === event.target.value); if (source) replace(index, newCondition(source)); }}>{sources.map(source => <option value={source.key} key={source.key}>{source.name ?? `${source.device} ${source.path}`}</option>)}</select></label>
          <label>比较<select aria-label={`${label} 比较`} value={node.operator} disabled={disabled} onChange={event => replace(index, { ...node, operator: event.target.value as typeof node.operator })}>{operatorsFor(source?.schema ?? { type: 'string' }).map(operator => <option key={operator} value={operator}>{conditionOperators[operator]}</option>)}</select></label>
          <label>比较值{source?.unit ? `（${unitLabel(source.unit)}）` : ''}{source?.schema.type === 'boolean' ? <select aria-label={`${label} 比较值`} value={node.value} disabled={disabled} onChange={event => replace(index, { ...node, value: event.target.value })}><option value="true">是</option><option value="false">否</option></select> : <input aria-label={`${label} 比较值`} type="text" inputMode={['integer', 'number'].includes(source?.schema.type ?? '') ? 'decimal' : 'text'} value={node.value} disabled={disabled} onChange={event => replace(index, { ...node, value: event.target.value })} />}</label>
        </div> : <><label>组合方式<select aria-label={`${label} 组合方式`} value={node.kind} disabled={disabled} onChange={event => replace(index, { ...node, kind: event.target.value as 'all' | 'any' })}><option value="all">全部满足</option><option value="any">任一满足</option></select></label>{list(node.children, children => replace(index, { ...node, children }), depth + 1, `${prefix}${index + 1}-`)}</>}
        <button type="button" className="text-button" disabled={disabled} onClick={() => update(nodes.filter((_, i) => i !== index))}>移除{label}</button>
      </fieldset>;
    })}<div className="actions">{(['compare', 'all', 'any'] as const).map(kind => <button type="button" key={kind} disabled={disabled || !sources.length || nodes.length >= 16 || total + (kind === 'compare' ? 1 : 2) > 32 || kind !== 'compare' && depth >= 4} onClick={() => update([...nodes, kind === 'compare' ? newCondition(sources[0]) : { kind, children: [newCondition(sources[0])] }])}>{kind === 'compare' ? '添加条件' : kind === 'all' ? '添加全部满足组' : '添加任一满足组'}</button>)}</div></div>;
  }
  return <fieldset className="conditions-editor"><legend>仅当</legend>{!forms.length && <p className="muted">未设置条件</p>}{list(forms, onChange)}</fieldset>;
}
function valueText(value: unknown, unit?: string) { return typeof value === 'number' && unit ? `${displayNumber(value, unit)} ${unitLabel(unit)}` : JSON.stringify(value); }
const reasons: Record<string, string> = { device_not_found: '未找到设备', model_authority_unavailable: '设备能力未获授权', device_offline: '设备离线', invalid_condition: '属性与条件不兼容', unconfirmed_observation: '观测尚未确认', future_observation: '观测时间超前', stale_observation: '观测已过期', missing_observation: '暂无观测' };
function conditionList(conditions: Condition[], sources: ConditionSource[], results?: ConditionResult[]) {
  return <ol className="condition-summary">{conditions.map((condition, index) => {
    const result = results?.[index];
    const children = 'all' in condition ? condition.all : 'any' in condition ? condition.any : null;
    return <li key={index}>{children ? <><span>{'all' in condition ? '全部满足' : '任一满足'}{result && `：${result.matched ? '已满足' : '未满足'}`}</span>{conditionList(children, sources, result?.children)}</> : 'property' in condition && <><span>{sources.find(source => source.device === condition.device && source.path === condition.property)?.name ?? `${condition.device} ${condition.property}`} {conditionOperators[condition.operator]} {valueText(condition.value, condition.unit)}</span>{result && <p className="muted">{result.matched ? '已满足' : '未满足'}{result.reason ? `，${reasons[result.reason] ?? result.reason}` : ''}{result.observation && `；观测值 ${valueText(result.observation.value, condition.unit)}，${when(result.observation.observed_at)}`}</p>}</>}</li>;
  })}</ol>;
}
export function ConditionSummary({ conditions, sources }: { conditions: Condition[]; sources: ConditionSource[] }) { return conditions.length ? <div>条件：全部满足{conditionList(conditions, sources)}</div> : null; }
export function ConditionEvidence({ evaluation, sources }: { evaluation: ConditionEvaluation; sources: ConditionSource[] }) {
  return <details className="condition-evidence"><summary>条件判断：{evaluation.matched ? '已满足' : '未满足'}</summary><p className="muted">判断时间 {when(evaluation.evaluated_at)}</p>{conditionList(evaluation.conditions, sources, evaluation.results)}<details><summary>原始条件证据</summary><pre>{JSON.stringify(evaluation, null, 2)}</pre></details></details>;
}

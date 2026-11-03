import { displayNumber, parseNumber } from './threshold-form.mjs';
import { canonicalJSON } from './model-validation.mjs';

export const conditionOperators = { eq: '等于', ne: '不等于', lt: '小于', lte: '小于或等于', gt: '大于', gte: '大于或等于' };
export function operatorsFor(schema) { return ['integer', 'number'].includes(schema.type) ? Object.keys(conditionOperators) : ['eq', 'ne']; }
export function conditionSources(devices, models) {
  return devices.flatMap(device => (models[device.model_revision]?.services ?? []).flatMap(service => service.properties
    .filter(property => property.access.includes('read') && ['integer', 'number', 'boolean', 'string'].includes(property.schema.type))
    .map(property => ({ key: `${device.device_id}/${service.id}.${property.id}`, device: device.device_id, path: `${service.id}.${property.id}`, schema: property.schema, ...(property.unit === undefined ? {} : { unit: property.unit }) }))));
}
export function newCondition(source) {
  const value = source.schema.enum?.[0] ?? (source.schema.type === 'boolean' ? true : ['integer', 'number'].includes(source.schema.type) ? source.schema.minimum ?? 0 : '');
  return { kind: 'compare', source: source.key, operator: 'eq', value: typeof value === 'number' ? displayNumber(value, source.unit ?? '') : String(value) };
}
function comparison(form, sources) {
  const source = sources.find(source => source.key === form.source);
  if (!source || !operatorsFor(source.schema).includes(form.operator)) return null;
  const { schema, unit } = source;
  const value = ['integer', 'number'].includes(schema.type) ? parseNumber(form.value, schema, unit) : schema.type === 'boolean' ? (form.value === 'true' ? true : form.value === 'false' ? false : null) : form.value;
  if (value === null || schema.enum && !schema.enum.some(item => item === value) || typeof value === 'string' && ([...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? 4096))) return null;
  return { device: source.device, property: source.path, operator: form.operator, value, ...(unit === undefined ? {} : { unit }) };
}
// 只做编辑器输入检查；设备授权、观测新鲜度与领域语义仍由Rust判断。
export function compileConditions(forms, sources) {
  let count = 0;
  function walk(nodes, depth) {
    if (!Array.isArray(nodes) || nodes.length > 16 || nodes.length && depth > 4) return null;
    const result = [];
    for (const form of nodes) {
      if (++count > 32) return null;
      if (form.kind === 'compare') { const item = comparison(form, sources); if (!item) return null; result.push(item); }
      else if (['all', 'any'].includes(form.kind) && form.children?.length) {
        const children = walk(form.children, depth + 1); if (!children) return null; result.push({ [form.kind]: children });
      } else return null;
    }
    return result;
  }
  return walk(forms, 1);
}
export function restoreConditions(conditions, sources) {
  function walk(nodes, depth = 1) {
    if (!Array.isArray(nodes) || depth > 4 && nodes.length) return null;
    const forms = [];
    for (const node of nodes) {
      if (node && (Array.isArray(node.all) || Array.isArray(node.any))) {
        const kind = Array.isArray(node.all) ? 'all' : 'any'; const children = walk(node[kind], depth + 1);
        if (!children) return null; forms.push({ kind, children });
      } else {
        const source = sources.find(source => source.device === node?.device && source.path === node?.property);
        if (!source) return null;
        forms.push({ kind: 'compare', source: source.key, operator: node.operator, value: typeof node.value === 'number' ? displayNumber(node.value, source.unit ?? '') : String(node.value) });
      }
    }
    return forms;
  }
  const forms = walk(conditions);
  return forms && canonicalJSON(compileConditions(forms, sources)) === canonicalJSON(conditions) ? forms : null;
}

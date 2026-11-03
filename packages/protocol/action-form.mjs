import { canonicalJSON } from './model-validation.mjs';

const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function sampleValue(schema) {
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(key => [key, sampleValue(schema.properties[key])]));
  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 0;
  return '';
}
// 表单输入提示，不取代Rust的物模型、授权、路由与执行校验。
export function checkFormValue(value, schema) {
  let valid = schema.type === 'boolean' ? typeof value === 'boolean' : schema.type === 'string' ? typeof value === 'string' && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? 4096) :
    schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) :
      schema.type === 'object' && object(value) && (schema.required ?? []).every(key => Object.hasOwn(value, key)) && Object.entries(value).every(([key, child]) => Object.hasOwn(schema.properties ?? {}, key) ? checkFormValue(child, schema.properties[key]) : schema.additionalProperties === true);
  if (typeof value === 'number') valid &&= value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  return !!valid && (!schema.enum || schema.enum.some(item => same(item, value)));
}

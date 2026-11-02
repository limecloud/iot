import { parseDraftJSON } from './products.mjs';
import { MODEL_VALIDATOR, LEGACY_VALIDATOR, legacyModel } from './model-contracts.mjs';

// 仅核对报告合同与正文绑定；物模型语义只由Rust校验器判断。
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function documentDigest(value) {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** @typedef {{version:number,validator:string,valid:boolean,document_digest:string|null,model_revision:string|null,normalized_model:Record<string,unknown>|null,issues:Array<{path:string,code:string}>}} ModelReport */
/** @returns {Promise<ModelReport>} */
export async function verifyModelReport(value, source) {
	return verifyModelReportDigest(value, source === undefined ? null : await documentDigest(source));
}

// 历史发布只保留冻结正文摘要时，仍使用同一套报告和规范投影绑定检查。
export async function verifyModelReportDigest(value, sourceDigest) {
  const invalid = () => { throw new Error('invalid_model_report'); };
  if (!value || value.version !== 1 || ![MODEL_VALIDATOR, LEGACY_VALIDATOR].includes(value.validator) || typeof value.valid !== 'boolean' ||
      Object.keys(value).sort().join(',') !== 'document_digest,issues,model_revision,normalized_model,valid,validator,version' ||
      !Array.isArray(value.issues) || value.issues.length > 32 ||
      value.issues.some(issue => !issue || Object.keys(issue).sort().join(',') !== 'code,path' ||
        typeof issue.path !== 'string' || issue.path.length > 1024 || !/^(?:\/(?:[^~/]|~[01])*)*$/.test(issue.path) || !/^[a-z][a-z0-9_]{0,63}$/.test(issue.code ?? ''))) invalid();
  if (value.document_digest !== sourceDigest) invalid();
  if (value.valid) {
    if (value.validator === LEGACY_VALIDATOR && !legacyModel(value.normalized_model)) invalid();
    if (sourceDigest === null || !/^sha256:[a-f0-9]{64}$/.test(sourceDigest) || value.issues.length || !value.normalized_model || typeof value.normalized_model !== 'object' || Array.isArray(value.normalized_model)) invalid();
    parseDraftJSON(JSON.stringify(value.normalized_model));
    if (value.model_revision !== await documentDigest(value.normalized_model)) invalid();
  } else if (!value.issues.length || value.model_revision !== null || value.normalized_model !== null) invalid();
  return value;
}

import { parseBoundedJSON, parseDraftJSON } from './products.mjs';
import { canonicalJSON, documentDigest, verifyModelReport } from './model-validation.mjs';
import { MODEL_CHECKER, LEGACY_CHECKER, LEGACY_VALIDATOR } from './model-contracts.mjs';

export function parseComparisonJSON(text) {
  const value = parseBoundedJSON(text,{maxBytes:16416,maxDepth:17,maxNodes:4097});
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'baseline,candidate' ||
      new TextEncoder().encode(canonicalJSON(value)).length > 16416) throw new Error('invalid_comparison_document');
  return value;
}
function modelSource(value) {
  try { return parseDraftJSON(JSON.stringify(value)); } catch { return undefined; }
}
// 只核对合同与两份输入的绑定；不在JavaScript中复制Rust兼容性规则。
export async function verifyComparisonReport(value, source) {
  const invalid = () => { throw new Error('invalid_comparison_report'); };
  if (!value || Object.keys(value).sort().join(',') !== 'baseline,candidate,checker,comparison_digest,compatible,issues,valid,version' ||
      value.version !== 1 || ![MODEL_CHECKER, LEGACY_CHECKER].includes(value.checker) || typeof value.valid !== 'boolean' ||
      !Array.isArray(value.issues) || value.issues.length > 32 ||
      value.issues.some(issue => !issue || Object.keys(issue).sort().join(',') !== 'code,path' ||
        typeof issue.path !== 'string' || issue.path.length > 1024 || !/^(?:\/(?:[^~/]|~[01])*)*$/.test(issue.path) || !/^[a-z][a-z0-9_]{0,63}$/.test(issue.code ?? ''))) invalid();
  if (source === undefined) {
    if (value.valid || value.compatible !== null || value.comparison_digest !== null || value.baseline !== null || value.candidate !== null || !value.issues.length) invalid();
  } else {
    if (value.comparison_digest !== await documentDigest(source)) invalid();
    await verifyModelReport(value.baseline, modelSource(source.baseline));
    await verifyModelReport(value.candidate, modelSource(source.candidate));
    if (value.checker === LEGACY_CHECKER &&
        (value.baseline.validator !== LEGACY_VALIDATOR || value.candidate.validator !== LEGACY_VALIDATOR)) invalid();
    if (value.valid !== (value.baseline.valid && value.candidate.valid)) invalid();
    if (value.valid) {
      if (typeof value.compatible !== 'boolean' || value.compatible !== (value.issues.length === 0)) invalid();
    } else if (value.compatible !== null || !value.issues.length) invalid();
  }
  return value;
}

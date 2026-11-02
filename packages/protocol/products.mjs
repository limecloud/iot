// Console 与 CLI 共用的草稿输入边界；正式模型语义仍由发布流程校验。
export function parseDraftJSON(text, envelope = false) {
  const value = parseBoundedJSON(text, envelope ? {maxBytes:16384,maxDepth:17,maxNodes:2053} : {});
  const model = envelope ? value?.model : value;
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('invalid_draft_document');
  // JSON.stringify与JCS在键序上不同，长度边界相同；服务端仍独立执行JCS。
  if (new TextEncoder().encode(JSON.stringify(model)).length > 8192) throw new Error('invalid_draft_document');
  if (envelope) parseDraftJSON(JSON.stringify(model));
  return value;
}
export function parseBoundedJSON(text, {maxBytes=8192,maxDepth=16,maxNodes=2048} = {}) {
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error('invalid_draft_document');
  const value = JSON.parse(text), stack = [];
  let nodes = 0;
  for (const [token] of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)) {
    const top = stack.at(-1);
    if (token === ':' ) continue;
    if (token === ',') { if (top?.keys) top.key = true; continue; }
    if (token === '}' || token === ']') { stack.pop(); continue; }
    if (token.startsWith('"')) {
      const string = JSON.parse(token);
      if (!string.isWellFormed()) throw new Error('invalid_draft_document');
      if (top?.keys && top.key) {
        if (top.keys.has(string)) throw new Error('invalid_draft_document');
        top.keys.add(string); top.key = false; continue;
      }
    }
    if (++nodes > maxNodes || stack.length > maxDepth) throw new Error('invalid_draft_document');
    if (token === '{' || token === '[') stack.push({ keys: token === '{' ? new Set() : null, key: true });
    else if (/^-?\d/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)) throw new Error('invalid_draft_document');
    }
  }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const sameJSON = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function validProductInput(value, saving) {
  if (!value || typeof value !== 'object' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.request_key ?? '') ||
    typeof value.name !== 'string' || value.name.trim() !== value.name || Array.from(value.name).length < 1 || Array.from(value.name).length > 80 ||
    Object.keys(value).some(key => !['request_key','name','model',...(saving ? ['expected_revision'] : [])].includes(key)) ||
    saving && !/^prodrev-[a-f0-9]{64}$/.test(value.expected_revision ?? '')) return false;
  try { parseDraftJSON(JSON.stringify(value.model)); return true; } catch { return false; }
}
export function validProduct(value, principal) {
  return !!value && /^product-[a-f0-9]{64}$/.test(value.product_id ?? '') && value.principal_id === principal &&
    /^prodrev-[a-f0-9]{64}$/.test(value.revision ?? '') && /^sha256:[a-f0-9]{64}$/.test(value.document_digest ?? '') &&
    typeof value.name === 'string' && value.status === 'draft' && value.validation === 'unvalidated' &&
    value.model !== null && typeof value.model === 'object' && !Array.isArray(value.model) &&
    Number.isFinite(Date.parse(value.created_at)) && Number.isFinite(Date.parse(value.updated_at));
}
export function validProductOperation(value, principal, expected) {
  return !!value && /^prodop-[a-f0-9]{64}$/.test(value.operation_id ?? '') && value.principal_id === principal &&
    ['products.create', 'products.save'].includes(value.kind) && ['saved', 'conflict'].includes(value.status) &&
    (value.kind !== 'products.create' || value.status === 'saved') && /^[a-f0-9]{64}$/.test(value.request_digest ?? '') &&
    validProduct(value.product, principal) && value.product_id === value.product.product_id &&
    validProductInput(value.request, value.kind === 'products.save') && Number.isFinite(Date.parse(value.created_at)) &&
    (value.status === 'conflict' ? value.kind === 'products.save' && value.product.revision !== value.request.expected_revision :
      value.product.name === value.request.name && sameJSON(value.product.model,value.request.model) && value.product.revision !== value.request.expected_revision) &&
    (!expected || value.kind === expected.kind && (!expected.product_id || value.product_id === expected.product_id) && sameJSON(value.request, expected.request));
}

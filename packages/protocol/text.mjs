import { parseBoundedJSON, sameJSON } from './products.mjs';
import { documentDigest } from './model-validation.mjs';
const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const time = v => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const bytes = v => new TextEncoder().encode(v);
const clean = v => typeof v === 'string' && v.isWellFormed() && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(v);
const text = v => clean(v) && v.trim().length > 0 && Array.from(v).length <= 2048 && bytes(v).length <= 8192;
const deployment = v => fields(v, 'adapter,revision,model,data_location') && v.adapter === 'ollama-text-v1' && hash(v.revision) && typeof v.model === 'string' && /^[A-Za-z0-9_:./-]{1,128}$/.test(v.model) && v.data_location === 'local';
const digest = async value => 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), b => b.toString(16).padStart(2, '0')).join('');
const fail = () => { throw new Error('invalid_text_request'); };
export const textRequestBytes = 65536;
function validInput(v) {
  return fields(v, 'context_digest,context_bytes,message_count,retain_seconds,expires_at') && hash(v.context_digest) && Number.isInteger(v.context_bytes) && v.context_bytes > 0 && v.context_bytes <= 8192 && Number.isInteger(v.message_count) && v.message_count > 0 && v.message_count <= 15 && v.message_count % 2 === 1 && Number.isInteger(v.retain_seconds) && v.retain_seconds >= 60 && v.retain_seconds <= 3600 && time(v.expires_at) && !/\.\d{4,}/.test(v.expires_at);
}
export function parseTextInput(raw) {
  let value; try { value = parseBoundedJSON(raw, { maxBytes: textRequestBytes, maxDepth: 4, maxNodes: 128 }); } catch { fail(); }
  if (!fields(value, 'instructions,messages,retain_seconds,expires_at') || !clean(value.instructions) || Array.from(value.instructions).length > 1024 || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 15 || value.messages.length % 2 !== 1 || !value.messages.every((m, i) => fields(m, 'role,content') && m.role === (i % 2 === 0 ? 'user' : 'assistant') && text(m.content)) || !Number.isInteger(value.retain_seconds) || value.retain_seconds < 60 || value.retain_seconds > 3600 || !time(value.expires_at) || /\.\d{4,}/.test(value.expires_at)) fail();
  if (bytes(value.instructions).length + value.messages.reduce((n, m) => n + bytes(m.content).length, 0) > 8192) fail();
  return { ...value, expires_at: new Date(value.expires_at).toISOString() };
}
export async function createTextOriginal(origin, space, key, raw) {
  if (!id(space) || !id(key)) fail();
  const value = parseTextInput(JSON.stringify(raw));
  const input = { context_digest: await documentDigest({ instructions: value.instructions, messages: value.messages }), context_bytes: bytes(value.instructions).length + value.messages.reduce((n, m) => n + bytes(m.content).length, 0), message_count: value.messages.length, retain_seconds: value.retain_seconds, expires_at: value.expires_at };
  return { version: 1, origin, space_id: space, idempotency_key: key, input, request_digest: await documentDigest({ space_id: space, idempotency_key: key, input }) };
}
export function validTextOriginal(v, origin, space, key) {
  return fields(v, 'version,origin,space_id,idempotency_key,input,request_digest') && v.version === 1 && v.origin === origin && id(space) && v.space_id === space && id(key) && v.idempotency_key === key && hash(v.request_digest) && validInput(v.input) && v.input.expires_at === new Date(v.input.expires_at).toISOString();
}
export async function verifyTextTask(v, space, key, expected) {
  const fail = () => { throw new Error('invalid_text_response'); };
  if (!fields(v, 'text_id,space_id,idempotency_key,request_digest,input,deployment,created_at,updated_at,status,output,usage,error_code') || !id(v.text_id) || !v.text_id.startsWith('text-') || !id(space) || v.space_id !== space || !id(key) || v.idempotency_key !== key || !hash(v.request_digest) || !validInput(v.input) || !deployment(v.deployment) || !time(v.created_at) || !time(v.updated_at)) fail();
  const input = { ...v.input, expires_at: new Date(v.input.expires_at).toISOString() };
  if (await documentDigest({ space_id: space, idempotency_key: key, input }) !== v.request_digest || expected && (expected.request_digest !== v.request_digest || !sameJSON(expected.input, input))) fail();
  const start = Date.parse(v.created_at), updated = Date.parse(v.updated_at), end = Date.parse(input.expires_at);
  if (updated < start || end <= start || end - start > 90000) fail();
  if (v.usage !== null && (v.status !== 'succeeded' || !fields(v.usage, 'input_tokens,output_tokens') || !Number.isInteger(v.usage.input_tokens) || v.usage.input_tokens < 0 || v.usage.input_tokens > 65536 || !Number.isInteger(v.usage.output_tokens) || v.usage.output_tokens < 1 || v.usage.output_tokens > 1024)) fail();
  switch (v.status) {
    case 'running': if (v.output !== null || v.error_code !== null || v.updated_at !== v.created_at) fail(); break;
    case 'succeeded': {
      const out = v.output;
      if (!fields(out, 'text,content_digest,expires_at,cleared_at') || !hash(out.content_digest) || !time(out.expires_at) || Date.parse(out.expires_at) !== updated + input.retain_seconds * 1000 || v.error_code !== null || updated >= end) fail();
      if (out.text !== null) { if (!text(out.text) || out.cleared_at !== null || await digest(bytes(out.text)) !== out.content_digest) fail(); }
      else if (!time(out.cleared_at) || Date.parse(out.cleared_at) < updated) fail();
      break;
    }
    case 'discarded': if (v.output !== null || v.error_code !== 'text_output_discarded') fail(); break;
    case 'unknown': if (v.output !== null || !['text_provider_unknown', 'text_deadline_exceeded', 'text_interrupted'].includes(v.error_code)) fail(); break;
    case 'failed': if (v.output !== null || !['text_provider_rejected', 'invalid_text_output', 'text_output_too_large', 'text_origin_not_local', 'text_provider_unavailable'].includes(v.error_code)) fail(); break;
    default: fail();
  }
  return { ...v, input };
}
export function verifyTextCapabilities(v) {
  if (fields(v, 'configured,capability') && v.configured === false && v.capability === 'text.generate') return v;
  if (!fields(v, 'configured,capability,deployment,max_messages,max_context_bytes,max_instructions_characters,max_text_bytes,max_characters,max_output_tokens,max_deadline_seconds,max_retain_seconds,concurrency,streaming,provider_cancellation,input_storage,server_memory,device_execution') || v.configured !== true || v.capability !== 'text.generate' || !deployment(v.deployment) || v.max_messages !== 15 || v.max_context_bytes !== 8192 || v.max_instructions_characters !== 1024 || v.max_text_bytes !== 8192 || v.max_characters !== 2048 || v.max_output_tokens !== 1024 || v.max_deadline_seconds !== 90 || v.max_retain_seconds !== 3600 || v.concurrency !== 1 || v.streaming !== false || v.provider_cancellation !== false || v.input_storage !== 'digest_only' || v.server_memory !== false || v.device_execution !== false) throw new Error('invalid_text_response');
  return v;
}

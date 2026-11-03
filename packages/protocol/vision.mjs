import { parseBoundedJSON, sameJSON } from './products.mjs';
import { documentDigest } from './model-validation.mjs';
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const time = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 && Array.from(value).length <= 2048 && new TextEncoder().encode(value).length <= 8192 && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value);
const deployment = value => fields(value, 'adapter,revision,model,data_location') && value.adapter === 'ollama-vision-v1' && hash(value.revision) && typeof value.model === 'string' && /^[A-Za-z0-9_:./-]{1,128}$/.test(value.model) && value.data_location === 'local';
export const visionRequestBytes = 2804396;
const digest = async bytes => 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const fail = () => { throw new Error('invalid_vision_request'); };
function validInput(value) {
  return fields(value, 'image_digest,image_bytes,content_type,prompt_digest,retain_seconds,expires_at') && hash(value.image_digest) && hash(value.prompt_digest) && Number.isInteger(value.image_bytes) && value.image_bytes > 0 && value.image_bytes <= 2097152 && ['image/png', 'image/jpeg'].includes(value.content_type) && Number.isInteger(value.retain_seconds) && value.retain_seconds >= 60 && value.retain_seconds <= 3600 && time(value.expires_at) && !/\.\d{4,}/.test(value.expires_at);
}
export function parseVisionInput(raw) {
  let value; try { value = parseBoundedJSON(raw, { maxBytes: visionRequestBytes, maxDepth: 3, maxNodes: 32 }); } catch { fail(); }
  if (!fields(value, 'image_base64,content_type,prompt,retain_seconds,expires_at') || !['image/png', 'image/jpeg'].includes(value.content_type) || typeof value.image_base64 !== 'string' || value.image_base64.length > 2796204 || value.image_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.image_base64) || !text(value.prompt) || Array.from(value.prompt).length > 512 || new TextEncoder().encode(value.prompt).length > 2048 || !Number.isInteger(value.retain_seconds) || value.retain_seconds < 60 || value.retain_seconds > 3600 || !time(value.expires_at) || /\.\d{4,}/.test(value.expires_at)) fail();
  let bytes; try { bytes = atob(value.image_base64); } catch { fail(); }
  if (bytes.length < 3 || bytes.length > 2097152 || btoa(bytes) !== value.image_base64 || (value.content_type === 'image/png' ? bytes.slice(0, 8) !== '\x89PNG\r\n\x1a\n' : bytes.slice(0, 3) !== '\xff\xd8\xff')) fail();
  return { ...value, expires_at: new Date(value.expires_at).toISOString() };
}
export async function createVisionOriginal(origin, space, key, raw) {
  if (!id(space) || !id(key)) fail();
  const value = parseVisionInput(JSON.stringify(raw)), bytes = Uint8Array.from(atob(value.image_base64), c => c.charCodeAt(0));
  const input = { image_digest: await digest(bytes), image_bytes: bytes.length, content_type: value.content_type, prompt_digest: await digest(new TextEncoder().encode(value.prompt)), retain_seconds: value.retain_seconds, expires_at: value.expires_at };
  return { version: 1, origin, space_id: space, idempotency_key: key, input, request_digest: await documentDigest({ space_id: space, idempotency_key: key, input }) };
}
export function validVisionOriginal(value, origin, space, key) {
  return fields(value, 'version,origin,space_id,idempotency_key,input,request_digest') && value.version === 1 && value.origin === origin && id(space) && value.space_id === space && id(key) && value.idempotency_key === key && hash(value.request_digest) && validInput(value.input) && value.input.expires_at === new Date(value.input.expires_at).toISOString();
}
export async function verifyVisionTask(value, space, key, expected) {
  const fail = () => { throw new Error('invalid_vision_response'); };
  if (!fields(value, 'vision_id,space_id,idempotency_key,request_digest,input,image,deployment,created_at,updated_at,status,output,error_code') || !id(value.vision_id) || !value.vision_id.startsWith('vision-') || !id(space) || value.space_id !== space || !id(key) || value.idempotency_key !== key || !hash(value.request_digest) || !validInput(value.input) || !deployment(value.deployment) || !time(value.created_at) || !time(value.updated_at) || !fields(value.image, 'width,height') || !['width', 'height'].every(k => Number.isInteger(value.image[k]) && value.image[k] > 0 && value.image[k] <= 1024)) fail();
  const input = { ...value.input, expires_at: new Date(value.input.expires_at).toISOString() };
  if (await documentDigest({ space_id: space, idempotency_key: key, input }) !== value.request_digest || expected && (expected.request_digest !== value.request_digest || !sameJSON(expected.input, input))) fail();
  const start = Date.parse(value.created_at), updated = Date.parse(value.updated_at), end = Date.parse(input.expires_at);
  if (updated < start || end <= start || end - start > 90000) fail();
  switch (value.status) {
    case 'running': if (value.output !== null || value.error_code !== null || value.updated_at !== value.created_at) fail(); break;
    case 'succeeded': {
      const output = value.output;
      if (!fields(output, 'text,content_digest,expires_at,cleared_at') || !hash(output.content_digest) || !time(output.expires_at) || Date.parse(output.expires_at) !== updated + input.retain_seconds * 1000 || value.error_code !== null || updated >= end) fail();
      if (output.text !== null) { if (!text(output.text) || output.cleared_at !== null || await digest(new TextEncoder().encode(output.text)) !== output.content_digest) fail(); }
      else if (!time(output.cleared_at) || Date.parse(output.cleared_at) < updated) fail();
      break;
    }
    case 'discarded': if (value.output !== null || value.error_code !== 'vision_output_discarded') fail(); break;
    case 'unknown': if (value.output !== null || !['vision_provider_unknown', 'vision_deadline_exceeded', 'vision_interrupted'].includes(value.error_code)) fail(); break;
    case 'failed': if (value.output !== null || !['vision_provider_rejected', 'invalid_vision_output', 'vision_output_too_large', 'vision_origin_not_local', 'vision_provider_unavailable'].includes(value.error_code)) fail(); break;
    default: fail();
  }
  return { ...value, input };
}
export function verifyVisionCapabilities(value) {
  if (fields(value, 'configured,capability') && value.configured === false && value.capability === 'vision.understand') return value;
  if (!fields(value, 'configured,capability,deployment,content_types,max_image_bytes,max_edge,max_prompt_characters,max_text_bytes,max_characters,max_deadline_seconds,max_retain_seconds,concurrency,streaming,provider_cancellation,input_storage,device_execution') || value.configured !== true || value.capability !== 'vision.understand' || !deployment(value.deployment) || !sameJSON(value.content_types, ['image/png', 'image/jpeg']) || value.max_image_bytes !== 2097152 || value.max_edge !== 1024 || value.max_prompt_characters !== 512 || value.max_text_bytes !== 8192 || value.max_characters !== 2048 || value.max_deadline_seconds !== 90 || value.max_retain_seconds !== 3600 || value.concurrency !== 1 || value.streaming !== false || value.provider_cancellation !== false || value.input_storage !== 'digest_only' || value.device_execution !== false) throw new Error('invalid_vision_response');
  return value;
}

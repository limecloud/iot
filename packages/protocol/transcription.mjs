import { parseBoundedJSON, sameJSON } from './products.mjs';
import { documentDigest } from './model-validation.mjs';
const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const time = v => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const deployment = v => fields(v, 'adapter,revision,model,data_location') && v.adapter === 'local-http-transcription-v1' && hash(v.revision) && typeof v.model === 'string' && /^[A-Za-z0-9_:./-]{1,128}$/.test(v.model) && v.data_location === 'local';
const text = v => typeof v === 'string' && v.isWellFormed() && Array.from(v).length <= 2048 && new TextEncoder().encode(v).length <= 8192 && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(v);
const contentDigest = async value => 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
export function parseTranscriptionInput(raw) {
  let value; try { value = parseBoundedJSON(raw, { maxBytes: 4096, maxDepth: 3, maxNodes: 32 }); } catch { throw new Error('invalid_transcription_request'); }
  if (!fields(value, 'media_id,media_digest,language,expires_at') || !id(value.media_id) || !value.media_id.startsWith('media-') || !hash(value.media_digest) || !['auto', 'zh', 'en'].includes(value.language) || !time(value.expires_at) || /\.\d{4,}/.test(value.expires_at)) throw new Error('invalid_transcription_request');
  return { ...value, expires_at: new Date(value.expires_at).toISOString() };
}
export async function createTranscriptionOriginal(origin, space, key, input) {
  if (!id(space) || !id(key)) throw new Error('invalid_transcription_request');
  input = parseTranscriptionInput(JSON.stringify(input));
  return { version: 1, origin, space_id: space, idempotency_key: key, input, request_digest: await documentDigest({ space_id: space, idempotency_key: key, input }) };
}
export function validTranscriptionOriginal(value, origin, space, key) {
  try { return fields(value, 'version,origin,space_id,idempotency_key,input,request_digest') && value.version === 1 && value.origin === origin && id(space) && value.space_id === space && id(key) && value.idempotency_key === key && hash(value.request_digest) && sameJSON(parseTranscriptionInput(JSON.stringify(value.input)), value.input); } catch { return false; }
}
export function verifyTranscriptionCapabilities(value) {
  if (fields(value, 'configured,capability') && value.configured === false && value.capability === 'audio.transcribe') return value;
  if (!fields(value, 'configured,capability,deployment,languages,concurrency,max_audio_bytes,max_audio_seconds,max_text_bytes,max_characters,max_deadline_seconds,streaming,provider_cancellation') || value.configured !== true || value.capability !== 'audio.transcribe' || !deployment(value.deployment) || !sameJSON(value.languages, ['auto', 'zh', 'en']) || value.concurrency !== 1 || value.max_audio_bytes !== 4194304 || value.max_audio_seconds !== 60 || value.max_text_bytes !== 8192 || value.max_characters !== 2048 || value.max_deadline_seconds !== 90 || value.streaming !== false || value.provider_cancellation !== false) throw new Error('invalid_transcription_response');
  return value;
}
export async function verifyTranscriptionTask(value, space, key, expected) {
  const fail = () => { throw new Error('invalid_transcription_response'); };
  if (!fields(value, 'transcription_id,space_id,idempotency_key,request_digest,input,deployment,created_at,updated_at,status,output,error_code') || !id(value.transcription_id) || !value.transcription_id.startsWith('transcription-') || !id(space) || value.space_id !== space || !id(key) || value.idempotency_key !== key || !hash(value.request_digest) || !deployment(value.deployment) || !time(value.created_at) || !time(value.updated_at)) fail();
  let input; try { input = parseTranscriptionInput(JSON.stringify(value.input)); } catch { fail(); }
  if (await documentDigest({ space_id: space, idempotency_key: key, input }) !== value.request_digest || expected && (expected.request_digest !== value.request_digest || !sameJSON(expected.input, input))) fail();
  const start = Date.parse(value.created_at), updated = Date.parse(value.updated_at), end = Date.parse(input.expires_at);
  if (updated < start || end <= start || end - start > 90000) fail();
  switch (value.status) {
    case 'running': if (value.output !== null || value.error_code !== null || value.updated_at !== value.created_at) fail(); break;
    case 'succeeded': {
      const output = value.output;
      if (!fields(output, 'text,content_digest,expires_at,cleared_at') || !hash(output.content_digest) || !time(output.expires_at) || Date.parse(output.expires_at) <= updated || Date.parse(output.expires_at) > start + 86400000 || value.error_code !== null || updated >= end) fail();
      if (output.text !== null) { if (!text(output.text) || output.cleared_at !== null || await contentDigest(output.text) !== output.content_digest) fail(); }
      else if (!time(output.cleared_at) || Date.parse(output.cleared_at) < updated) fail();
      break;
    }
    case 'discarded': if (value.output !== null || value.error_code !== 'transcription_output_discarded') fail(); break;
    case 'unknown': if (value.output !== null || !['transcription_provider_unknown', 'transcription_deadline_exceeded', 'transcription_interrupted'].includes(value.error_code)) fail(); break;
    case 'failed': if (value.output !== null || !['transcription_provider_rejected', 'invalid_transcription_output', 'transcription_output_too_large', 'transcription_source_unavailable', 'transcription_origin_not_local', 'transcription_provider_unavailable'].includes(value.error_code)) fail(); break;
    default: fail();
  }
  return value;
}

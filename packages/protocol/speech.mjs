import { parseBoundedJSON } from './products.mjs';
import { documentDigest } from './model-validation.mjs';

const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const time = v => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const voice = v => id(v) && v.length <= 64;
const deployment = d => fields(d, 'adapter,revision,model,data_location') && d.adapter === 'local-http-speech-v1' && hash(d.revision) && typeof d.model === 'string' && /^[A-Za-z0-9_:./-]{1,128}$/.test(d.model) && d.data_location === 'local';
export function verifySpeechCapabilities(v) {
  if (fields(v, 'configured,capability') && v.configured === false && v.capability === 'audio.synthesize') return v;
  if (!fields(v, 'configured,capability,deployment,voices,concurrency,max_text_bytes,max_characters,max_output_bytes,max_audio_seconds,max_deadline_seconds,streaming,provider_cancellation') || v.configured !== true || v.capability !== 'audio.synthesize' || !deployment(v.deployment) || !Array.isArray(v.voices) || v.voices.length < 1 || v.voices.length > 32 || !v.voices.every(voice) || new Set(v.voices).size !== v.voices.length || v.concurrency !== 1 || v.max_text_bytes !== 4096 || v.max_characters !== 1000 || v.max_output_bytes !== 4194304 || v.max_audio_seconds !== 60 || v.max_deadline_seconds !== 90 || v.streaming !== false || v.provider_cancellation !== false) throw new Error('invalid_speech_response');
  return v;
}
export function parseSpeechInput(text) {
  let v;
  try { v = parseBoundedJSON(text, { maxBytes: 8192, maxDepth: 3, maxNodes: 32 }); }
  catch { throw new Error('invalid_speech_request'); }
  if (!fields(v, 'text,voice,retain_seconds,expires_at') || typeof v.text !== 'string' || !v.text.isWellFormed() || !v.text.trim() || new TextEncoder().encode(v.text).length > 4096 || Array.from(v.text).length > 1000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(v.text) || !voice(v.voice) || !integer(v.retain_seconds, 60, 86400) || !time(v.expires_at) || /\.\d{4,}/.test(v.expires_at)) throw new Error('invalid_speech_request');
  return { ...v, expires_at: new Date(v.expires_at).toISOString() };
}
export async function createSpeechOriginal(origin, space, key, input) {
  const normalized = parseSpeechInput(JSON.stringify(input));
  if (!id(space) || !id(key)) throw new Error('invalid_speech_request');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized.text)));
  return { version: 1, origin, space_id: space, idempotency_key: key, request_digest: await documentDigest({ space_id: space, idempotency_key: key, input: normalized }), input_digest: 'sha256:' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), input_characters: Array.from(normalized.text).length, voice: normalized.voice, retain_seconds: normalized.retain_seconds, expires_at: normalized.expires_at };
}
export function validSpeechOriginal(v, origin, space, key) {
  return fields(v, 'version,origin,space_id,idempotency_key,request_digest,input_digest,input_characters,voice,retain_seconds,expires_at') && v.version === 1 && v.origin === origin && v.space_id === space && id(space) && v.idempotency_key === key && id(key) && hash(v.request_digest) && hash(v.input_digest) && integer(v.input_characters, 1, 1000) && voice(v.voice) && integer(v.retain_seconds, 60, 86400) && time(v.expires_at);
}
export function verifySpeechTask(v, space, key, expected) {
  const fail = () => { throw new Error('invalid_speech_response'); };
  if (!fields(v, 'synthesis_id,space_id,idempotency_key,request_digest,input_digest,input_characters,voice,retain_seconds,expires_at,deployment,created_at,updated_at,status,media_id,error_code') || !id(v.synthesis_id) || !v.synthesis_id.startsWith('speech-') || v.space_id !== space || !id(space) || v.idempotency_key !== key || !id(key) || !hash(v.request_digest) || !hash(v.input_digest) || !integer(v.input_characters, 1, 1000) || !voice(v.voice) || !integer(v.retain_seconds, 60, 86400) || !time(v.expires_at) || !time(v.created_at) || !time(v.updated_at)) fail();
  if (!deployment(v.deployment)) fail();
  const start = Date.parse(v.created_at), end = Date.parse(v.expires_at), updated = Date.parse(v.updated_at);
  if (updated < start || end <= start || end - start > 90000) fail();
  switch (v.status) {
    case 'running': if (v.media_id !== null || v.error_code !== null || v.updated_at !== v.created_at) fail(); break;
    case 'succeeded': if (!id(v.media_id) || !v.media_id.startsWith('media-') || v.error_code !== null || updated >= end) fail(); break;
    case 'discarded': if (v.media_id !== null || v.error_code !== 'speech_output_discarded') fail(); break;
    case 'unknown': if (v.media_id !== null || !['speech_provider_unknown', 'speech_deadline_exceeded', 'speech_interrupted'].includes(v.error_code)) fail(); break;
    case 'failed': if (v.media_id !== null || !['speech_provider_rejected', 'invalid_speech_audio', 'speech_output_too_large', 'speech_output_unavailable', 'speech_origin_not_local', 'speech_provider_unavailable'].includes(v.error_code)) fail(); break;
    default: fail();
  }
  if (expected && (v.request_digest !== expected.request_digest || v.input_digest !== expected.input_digest || v.input_characters !== expected.input_characters || v.voice !== expected.voice || v.retain_seconds !== expected.retain_seconds || Date.parse(v.expires_at) !== Date.parse(expected.expires_at))) fail();
  return v;
}

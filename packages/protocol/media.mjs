import { parseBoundedJSON, sameJSON } from './products.mjs';
import { documentDigest } from './model-validation.mjs';

export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const time = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const invalid = () => { throw new Error('invalid_media_response'); };
function base64(value) {
  if (typeof value !== 'string' || value.length < 64 || value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0, body = value.slice(0, value.length - padding);
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(body.at(-1));
  return !body.includes('=') && (padding === 2 ? (last & 15) === 0 : padding === 1 ? (last & 3) === 0 : true);
}
export function validMediaChange(value) {
  if (!value || typeof value !== 'object') return false;
  switch (value.type) {
    case 'media.upload': return fields(value, 'type,content_base64,retain_seconds') && base64(value.content_base64) && integer(value.retain_seconds, 60, 86400);
    case 'media.delete': return fields(value, 'type,media_id') && id(value.media_id);
    case 'media.grant': return fields(value, 'type,media_id,device_id,expected_binding_revision,valid_for_seconds') && id(value.media_id) && id(value.device_id) && digest(value.expected_binding_revision) && integer(value.valid_for_seconds, 5, 600);
    case 'media.revoke': return fields(value, 'type,grant_id') && id(value.grant_id);
    default: return false;
  }
}
export function parseMediaChange(text) {
  const value = parseBoundedJSON(text, { maxBytes: Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4096, maxDepth: 5, maxNodes: 64 });
  if (!validMediaChange(value)) throw new Error('invalid_media_change');
  return value;
}
export function verifyPcmWav(bytes) {
  const fail = () => { throw new Error('invalid_media_audio'); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 46 || bytes.length > MAX_AUDIO_BYTES) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.length - 8) fail();
  let position = 12, audio, length;
  while (position < bytes.length) {
    if (bytes.length - position < 8) fail();
    const size = view.getUint32(position + 4, true), end = position + 8 + size, start = position + 8;
    if (end > bytes.length) fail();
    if (tag(position) === 'fmt ') {
      if (audio || length !== undefined || size !== 16) fail();
      const channels = view.getUint16(start + 2, true), rate = view.getUint32(start + 4, true);
      if (view.getUint16(start, true) !== 1 || !integer(channels, 1, 2) || !integer(rate, 8000, 48000) || view.getUint16(start + 14, true) !== 16 || view.getUint16(start + 12, true) !== channels * 2 || view.getUint32(start + 8, true) !== rate * channels * 2) fail();
      audio = { sample_rate: rate, channels, bits_per_sample: 16, frames: 0 };
    } else if (tag(position) === 'data') {
      if (!audio || length !== undefined || !size) fail(); length = size;
    } else fail();
    position = end + size % 2;
    if (position > bytes.length) fail();
  }
  if (!audio || length === undefined || length % (audio.channels * 2) || length / (audio.channels * 2) > audio.sample_rate * 60) fail();
  return { ...audio, frames: length / (audio.channels * 2) };
}
function validAudio(value) {
  return fields(value, 'sample_rate,channels,bits_per_sample,frames') && integer(value.sample_rate, 8000, 48000) && integer(value.channels, 1, 2) && value.bits_per_sample === 16 && integer(value.frames, 1, value.sample_rate * 60);
}
function metadata(value, space) {
  return fields(value, 'media_id,space_id,content_type,purpose,actor,byte_length,content_digest,audio,created_at,expires_at') && id(value.media_id) && value.media_id.startsWith('media-') && value.space_id === space && value.content_type === 'audio/wav' && value.purpose === 'device_playback' && value.actor === 'local_owner' && integer(value.byte_length, 46, MAX_AUDIO_BYTES) && digest(value.content_digest) && validAudio(value.audio) && value.byte_length === 44 + value.audio.frames * value.audio.channels * 2 && time(value.created_at) && time(value.expires_at) && Date.parse(value.expires_at) - Date.parse(value.created_at) >= 60000 && Date.parse(value.expires_at) - Date.parse(value.created_at) <= 86400000;
}
function grant(value) {
  return id(value.grant_id) && value.grant_id.startsWith('grant-') && id(value.media_id) && id(value.device_id) && digest(value.binding_revision) && time(value.created_at) && time(value.expires_at) && Date.parse(value.expires_at) > Date.parse(value.created_at) && Date.parse(value.expires_at) - Date.parse(value.created_at) <= 600000;
}
export function verifyMediaPage(value, space) {
  if (!fields(value, 'space_id,configured,items,grants,next_cursor') || value.space_id !== space || !id(space) || typeof value.configured !== 'boolean' || !Array.isArray(value.items) || value.items.length > 256 || !Array.isArray(value.grants) || value.grants.length > 512 || value.next_cursor !== null || !value.configured && (value.items.length || value.grants.length)) invalid();
  const objects = new Map(), grants = new Set();
  for (const item of value.items) {
    if (!fields(item, 'metadata,available,deleted_at') || !metadata(item.metadata, space) || typeof item.available !== 'boolean' || item.deleted_at !== null && (!time(item.deleted_at) || Date.parse(item.deleted_at) < Date.parse(item.metadata.created_at) || item.available) || objects.has(item.metadata.media_id)) invalid();
    objects.set(item.metadata.media_id, item.metadata);
  }
  for (const item of value.grants) {
    const media = objects.get(item.media_id);
    if (!fields(item, 'grant_id,media_id,device_id,binding_revision,created_at,expires_at,active_in_process,binding_current,revoked_at,pulls') || !grant(item) || grants.has(item.grant_id) || !media || Date.parse(item.created_at) < Date.parse(media.created_at) || Date.parse(item.expires_at) > Date.parse(media.expires_at) || typeof item.active_in_process !== 'boolean' || typeof item.binding_current !== 'boolean' || item.revoked_at !== null && (!time(item.revoked_at) || Date.parse(item.revoked_at) < Date.parse(item.created_at) || item.active_in_process) || !Array.isArray(item.pulls) || item.pulls.length > 16) invalid();
    for (const pull of item.pulls) if (!fields(pull, 'prepared_at,method,range_start,range_end,status') || !time(pull.prepared_at) || !['GET', 'HEAD'].includes(pull.method) || ![200, 206].includes(pull.status) || !integer(pull.range_start, 0, media.byte_length - 1) || !integer(pull.range_end, pull.range_start, media.byte_length - 1)) invalid();
    grants.add(item.grant_id);
  }
  return value;
}
// 客户端保留摘要与输入身份，音频正文和下载凭证均不写原操作记录。
export async function createMediaOriginal(origin, space, key, change) {
  if (!id(space) || !id(key) || !validMediaChange(change)) throw new Error('invalid_media_change');
  let summary = change;
  if (change.type === 'media.upload') {
    const bytes = Uint8Array.from(atob(change.content_base64), char => char.charCodeAt(0)), audio = verifyPcmWav(bytes);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    summary = { type: change.type, content_digest: 'sha256:' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join(''), byte_length: bytes.length, audio, retain_seconds: change.retain_seconds };
  }
  return { version: 1, origin, space_id: space, idempotency_key: key, request_digest: await documentDigest({ space_id: space, idempotency_key: key, change }), change: summary };
}
export function validMediaOriginal(value, origin, space) {
  if (!fields(value, 'version,origin,space_id,idempotency_key,request_digest,change') || value.version !== 1 || value.origin !== origin || value.space_id !== space || !id(space) || !id(value.idempotency_key) || !digest(value.request_digest)) return false;
  const c = value.change;
  return c?.type === 'media.upload' ? fields(c, 'type,content_digest,byte_length,audio,retain_seconds') && digest(c.content_digest) && integer(c.byte_length, 46, MAX_AUDIO_BYTES) && validAudio(c.audio) && c.byte_length === 44 + c.audio.frames * c.audio.channels * 2 && integer(c.retain_seconds, 60, 86400) : validMediaChange(c);
}
export function verifyMediaOperation(value, space, key, original) {
  if (!fields(value, 'space_id,operation_id,idempotency_key,request_digest,kind,created_at,result') || value.space_id !== space || !id(space) || !id(value.operation_id) || !value.operation_id.startsWith('mediaop-') || value.idempotency_key !== key || !id(key) || !digest(value.request_digest) || !time(value.created_at)) invalid();
  const r = value.result;
  switch (value.kind) {
    case 'media.upload': if (!fields(r, 'type,media') || r.type !== 'uploaded' || !metadata(r.media, space) || r.media.created_at !== value.created_at) invalid(); break;
    case 'media.delete': if (!fields(r, 'type,media_id') || r.type !== 'deleted' || !id(r.media_id)) invalid(); break;
    case 'media.grant': if (!fields(r, 'type,grant_id,media_id,device_id,binding_revision,created_at,expires_at,issued_in_process') || r.type !== 'granted' || !grant(r) || r.created_at !== value.created_at || typeof r.issued_in_process !== 'boolean') invalid(); break;
    case 'media.revoke': if (!fields(r, 'type,grant_id') || r.type !== 'revoked' || !id(r.grant_id)) invalid(); break;
    default: invalid();
  }
  if (original) {
    if (!validMediaOriginal(original, original.origin, space) || original.idempotency_key !== key || original.request_digest !== value.request_digest || original.change.type !== value.kind) invalid();
    const c = original.change;
    if (c.type === 'media.upload' && (r.media.content_digest !== c.content_digest || r.media.byte_length !== c.byte_length || !sameJSON(r.media.audio, c.audio) || Date.parse(r.media.expires_at) - Date.parse(r.media.created_at) !== c.retain_seconds * 1000) || c.type === 'media.delete' && r.media_id !== c.media_id || c.type === 'media.revoke' && r.grant_id !== c.grant_id || c.type === 'media.grant' && (r.media_id !== c.media_id || r.device_id !== c.device_id || r.binding_revision !== c.expected_binding_revision || Date.parse(r.expires_at) - Date.parse(r.created_at) > c.valid_for_seconds * 1000)) invalid();
  }
  return value;
}

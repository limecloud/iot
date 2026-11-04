import { documentDigest } from './model-validation.mjs';
import { parseBoundedJSON, sameJSON } from './products.mjs';

const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const id = value => typeof value === 'string' && value === value.trim() && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
const digest = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const ieee = value => typeof value === 'string' && value.length === 16 && /^[a-f0-9]{16}$/.test(value) && !['0000000000000000', 'ffffffffffffffff'].includes(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const time = value => typeof value === 'string' && value === value.trim() && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const fail = () => { throw new Error('invalid_zigbee_response'); };
const validChange = value => fields(value, 'coordinator_id,expected_revision,duration_seconds') && id(value.coordinator_id)
  && digest(value.expected_revision) && integer(value.duration_seconds, 0, 120);
const coordinator = value => fields(value, 'coordinator_id,coordinator_ieee,revision,timeout_ms')
  && id(value.coordinator_id) && ieee(value.coordinator_ieee) && digest(value.revision) && integer(value.timeout_ms, 100, 30000);

export function parseZigbeeChange(text) {
  const value = parseBoundedJSON(text, { maxBytes: 4096, maxDepth: 4, maxNodes: 64 });
  if (!validChange(value)) throw new Error('invalid_zigbee_change');
  return value;
}
export function verifyZigbeeCoordinators(value) {
  if (!fields(value, 'items,next_cursor') || value.next_cursor !== null || !Array.isArray(value.items) || value.items.length > 4
    || !value.items.every(coordinator) || new Set(value.items.map(item => item.coordinator_id)).size !== value.items.length
    || new Set(value.items.map(item => item.coordinator_ieee)).size !== value.items.length) fail();
  return value;
}
export async function verifyZigbeeOperation(value, expected) {
  if (!fields(value, 'operation_id,sequence,request,request_digest,coordinator,status,reason,result,created_at,blocked_until,completed_at')
    || !id(value.operation_id) || !integer(value.sequence, 1, 256) || !fields(value.request, 'space_id,idempotency_key,change')
    || !id(value.request.space_id) || !id(value.request.idempotency_key) || !validChange(value.request.change)
    || value.request_digest !== await documentDigest(value.request) || expected && !sameJSON(value.request, expected)
    || !coordinator(value.coordinator) || value.coordinator.coordinator_id !== value.request.change.coordinator_id
    || value.coordinator.revision !== value.request.change.expected_revision || !time(value.created_at) || !time(value.blocked_until)
    || Date.parse(value.blocked_until) - Date.parse(value.created_at) !== value.coordinator.timeout_ms + value.request.change.duration_seconds * 1000
    || value.completed_at !== null && (!time(value.completed_at) || Date.parse(value.completed_at) < Date.parse(value.created_at))) fail();
  if (value.status === 'protocol_accepted') {
    if (value.reason !== null || !fields(value.result, 'coordinator_ieee,duration_seconds,observed_at')
      || value.result.coordinator_ieee !== value.coordinator.coordinator_ieee || value.result.duration_seconds !== value.request.change.duration_seconds
      || !time(value.completed_at) || value.result.observed_at !== value.completed_at) fail();
  } else if (value.status !== 'unknown' || value.result !== null || typeof value.reason !== 'string'
    || value.reason !== value.reason.trim() || value.reason.length > 64 || !/^[a-z0-9_]+$/.test(value.reason)
    || value.completed_at === null && value.reason !== 'not_confirmed') fail();
  return value;
}
export async function verifyZigbeeOperations(value, space) {
  if (!fields(value, 'items,next_cursor') || value.next_cursor !== null || !Array.isArray(value.items) || value.items.length > 256) fail();
  const ids = new Set(), keys = new Set();
  for (const [index, item] of value.items.entries()) {
    await verifyZigbeeOperation(item);
    if (item.sequence !== index + 1 || ids.has(item.operation_id) || keys.has(item.request.idempotency_key)
      || space !== undefined && item.request.space_id !== space) fail();
    ids.add(item.operation_id); keys.add(item.request.idempotency_key);
  }
  return value;
}

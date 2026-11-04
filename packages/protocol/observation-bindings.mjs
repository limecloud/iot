import { documentDigest } from './model-validation.mjs';
import { parseBoundedJSON, sameJSON } from './products.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const id = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const source = value => fields(value, 'adapter_id,revision') && id(value.adapter_id) && digest(value.revision);
const ieee = value => typeof value === 'string' && value.length === 16 && /^[a-f0-9]{16}$/.test(value) && !['0000000000000000', 'ffffffffffffffff'].includes(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = () => { throw new Error('invalid_observation_response'); };
const writePaths = value => sameJSON(value, ['light.power']);
const onOffRevision = 'sha256:a5ed590038c2d0c13e183a1cc7aeb166fbb9dc529d92366631978943c47433b0';
const target = value => fields(value, 'coordinator_ieee,ieee_address,endpoint') && ieee(value.coordinator_ieee) && ieee(value.ieee_address)
  && value.coordinator_ieee !== value.ieee_address && Number.isInteger(value.endpoint) && value.endpoint >= 1 && value.endpoint <= 240;
const signature = value => fields(value, 'manufacturer,model,application_version,hardware_version')
  && ['manufacturer', 'model'].every(key => typeof value[key] === 'string' && value[key].trim() && new TextEncoder().encode(value[key]).length <= 32 && !/[\u0000-\u001f\u007f-\u009f]/.test(value[key]))
  && ['application_version', 'hardware_version'].every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 255);
export function validObservationChange(value) {
  if (!object(value) || !id(value.device_id) || !digest(value.expected_binding_revision)) return false;
  return value.type === 'sources.revoke' ? fields(value, 'type,device_id,expected_binding_revision')
    : value.type === 'sources.bind' && fields(value, 'type,device_id,source,expected_binding_revision,expected_model_revision') && source(value.source) && digest(value.expected_model_revision);
}
export function parseObservationChange(text) {
  const value = parseBoundedJSON(text, { maxBytes: 4096, maxDepth: 4, maxNodes: 64 });
  if (!validObservationChange(value)) throw new Error('invalid_observation_change');
  return value;
}
export function parseObservationQuery(text) {
  const value = parseBoundedJSON(text, { maxBytes: 4096, maxDepth: 4, maxNodes: 64 });
  if (!fields(value, 'coordinator_id,ieee_address,endpoint' + (object(value) && Object.hasOwn(value, 'profile') ? ',profile' : ''))
    || Object.hasOwn(value, 'profile') && value.profile !== 'on_off' || !id(value.coordinator_id) || !ieee(value.ieee_address)
    || !Number.isInteger(value.endpoint) || value.endpoint < 1 || value.endpoint > 240) throw new Error('invalid_observation_query');
  return value;
}
export async function verifyObservationCandidate(value) {
  const writable = object(value) && Object.hasOwn(value, 'write_paths');
  if (!fields(value, 'source,model_revision,target,manufacturer_code,signature,observed_at,expires_at,protocol,evidence' + (writable ? ',write_paths' : ''))
    || writable && (!writePaths(value.write_paths) || value.model_revision !== onOffRevision)
    || !source(value.source) || !digest(value.model_revision) || !target(value.target) || !signature(value.signature)
    || !Number.isInteger(value.manufacturer_code) || value.manufacturer_code < 0 || value.manufacturer_code > 65535
    || !time(value.observed_at) || !time(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.observed_at)
    || Date.parse(value.expires_at) - Date.parse(value.observed_at) > 60000 || value.protocol !== 'zigbee-znp' || value.evidence !== 'unauthenticated_protocol') fail();
  if (value.source.adapter_id !== 'znp-' + (await documentDigest(value.target)).slice(7)
    || value.source.revision !== await documentDigest({ mapping: writable ? 'znp-on-off-v1' : 'znp-environment-v1', target: value.target,
      manufacturer_code: value.manufacturer_code, signature: value.signature, model_revision: value.model_revision })) fail();
  return value;
}
export async function verifyObservationCandidates(value) {
  if (!fields(value, 'coordinators,items,next_cursor') || value.next_cursor !== null || !Array.isArray(value.coordinators) || value.coordinators.length > 4
    || value.coordinators.some(item => !fields(item, 'coordinator_id,coordinator_ieee,timeout_ms,protocol') || !id(item.coordinator_id) || !ieee(item.coordinator_ieee)
      || !Number.isInteger(item.timeout_ms) || item.timeout_ms < 100 || item.timeout_ms > 30000 || item.protocol !== 'zigbee-znp')
    || new Set(value.coordinators.map(item => item.coordinator_id)).size !== value.coordinators.length
    || new Set(value.coordinators.map(item => item.coordinator_ieee)).size !== value.coordinators.length
    || !Array.isArray(value.items) || value.items.length > 64 || new Set(value.items.map(item => item?.source?.adapter_id)).size !== value.items.length) fail();
  for (const item of value.items) {
    await verifyObservationCandidate(item);
    if (!value.coordinators.some(coordinator => coordinator.coordinator_ieee === item.target.coordinator_ieee)) fail();
  }
  return value;
}
export async function verifyObservationBinding(value, device) {
  if (!fields(value, 'device_id,revision,binding') || !id(value.device_id) || device !== undefined && value.device_id !== device || !digest(value.revision)) fail();
  const binding = value.binding;
  if (binding !== null) {
    const writable = object(binding) && Object.hasOwn(binding, 'write_paths');
    if (!fields(binding, 'policy,manifest,active,generation,changed_at' + (writable ? ',write_paths' : '')) || !fields(binding.policy, 'device_id,model_revision,source')
      || writable && (!writePaths(binding.write_paths) || binding.policy.model_revision !== onOffRevision || binding.manifest?.mapping !== 'znp-on-off-v1'
        || binding.manifest?.model_revision !== onOffRevision)
      || binding.policy.device_id !== value.device_id || !digest(binding.policy.model_revision) || !source(binding.policy.source)
      || !object(binding.manifest) || Object.keys(binding.manifest).length === 0 || typeof binding.active !== 'boolean'
      || !id(binding.generation) || !/^observationop-[A-Za-z0-9_-]{1,100}$/.test(binding.generation) || !time(binding.changed_at)) fail();
    parseBoundedJSON(JSON.stringify(binding.manifest), { maxBytes: 4096, maxDepth: 8, maxNodes: 256 });
    if (await documentDigest(binding.manifest) !== binding.policy.source.revision) fail();
  }
  if (await documentDigest(['observation-binding-v1', value.device_id, binding]) !== value.revision) fail();
  return value;
}
export async function verifyObservationOperation(value, expected) {
  if (!fields(value, 'operation_id,sequence,request,request_digest,status,reason,result,created_at') || !id(value.operation_id) || !/^observationop-[A-Za-z0-9_-]{1,100}$/.test(value.operation_id)
    || !Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > 256 || !fields(value.request, 'space_id,idempotency_key,change')
    || !id(value.request.space_id) || !id(value.request.idempotency_key) || !validObservationChange(value.request.change)
    || value.request_digest !== await documentDigest(value.request) || !time(value.created_at) || expected && !sameJSON(value.request, expected)) fail();
  const change = value.request.change;
  if (value.status === 'applied') {
    const view = await verifyObservationBinding(value.result, change.device_id), binding = view.binding;
    if (value.reason !== null || !binding || binding.generation !== value.operation_id || binding.changed_at !== value.created_at || view.revision === change.expected_binding_revision
      || change.type === 'sources.bind' && (!binding.active || !sameJSON(binding.policy.source, change.source) || binding.policy.model_revision !== change.expected_model_revision)
      || change.type === 'sources.revoke' && binding.active) fail();
  } else if (!['rejected', 'conflict'].includes(value.status) || value.result !== null || typeof value.reason !== 'string'
    || value.reason !== value.reason.trim() || !/^[a-z][a-z0-9_]{0,63}$/.test(value.reason) || (value.status === 'conflict') !== (value.reason === 'revision_conflict')) fail();
  return value;
}

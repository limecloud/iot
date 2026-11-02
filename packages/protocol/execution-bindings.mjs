import { documentDigest } from './model-validation.mjs';
import { parseBoundedJSON, sameJSON } from './products.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const fields = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const route = value => fields(value, 'adapter_id,revision') && id(value.adapter_id) && digest(value.revision);
const actionPath = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}$/.test(value);
const nativePaths = value => Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every((path, index) => actionPath(path) && (index === 0 || value[index - 1] < path));
const fail = () => { throw new Error('invalid_execution_operation'); };
export function validExecutionChange(value) {
  if (!object(value) || !id(value.device_id) || !digest(value.expected_binding_revision)) return false;
  if (value.type === 'bindings.revoke') return fields(value, 'type,device_id,expected_binding_revision');
  if (value.type === 'bindings.compose') return fields(value, 'type,device_id,route,native_paths,expected_native_session,expected_binding_revision,expected_model_revision') && route(value.route) && nativePaths(value.native_paths) && id(value.expected_native_session) && digest(value.expected_model_revision);
  return value.type === 'bindings.bind' && fields(value, 'type,device_id,route,expected_binding_revision,expected_model_revision') && route(value.route) && digest(value.expected_model_revision);
}
export function parseExecutionChange(text) {
  const value = parseBoundedJSON(text, { maxBytes: 4096, maxDepth: 4, maxNodes: 256 });
  if (!validExecutionChange(value)) throw new Error('invalid_execution_change');
  return value;
}
export function verifyExecutionBinding(value, deviceID) {
  if (!fields(value, value?.state === 'composed' ? 'device_id,model_revision,revision,state,routes,native_paths' : 'device_id,model_revision,revision,state,routes') || !id(value.device_id) || deviceID !== undefined && value.device_id !== deviceID || !digest(value.model_revision) || !digest(value.revision) ||
    !['native', 'bound', 'composed', 'revoked'].includes(value.state) || !object(value.routes) || Object.keys(value.routes).length > 512 ||
    Object.entries(value.routes).some(([path, value]) => !actionPath(path) || !route(value)) ||
    (['bound', 'composed'].includes(value.state)) !== (Object.keys(value.routes).length > 0) ||
    value.state === 'composed' && (!nativePaths(value.native_paths) || value.native_paths.some(path => Object.hasOwn(value.routes, path)))) fail();
  return value;
}
export function verifyExecutionAdapters(value) {
  if (!fields(value, 'items,next_cursor') || value.next_cursor !== null || !Array.isArray(value.items) || value.items.length > 16 ||
    value.items.some(item => !fields(item, 'device_id,route,compatible,target,fingerprint,device_serial,applications') || !id(item.device_id) || !route(item.route) || typeof item.compatible !== 'boolean' ||
      !['target', 'fingerprint', 'device_serial'].every(key => typeof item[key] === 'string' && item[key].length > 0 && item[key].length <= 512) ||
      !Array.isArray(item.applications) || item.applications.length > 32 || item.applications.some(app => !fields(app, 'application_id,category') || typeof app.application_id !== 'string' || app.application_id.length > 255 || !['leanback', 'launcher'].includes(app.category))) ||
    new Set(value.items.map(item => item.route.adapter_id)).size !== value.items.length || new Set(value.items.map(item => item.device_id)).size !== value.items.length) fail();
  return value;
}
export function verifyApplications(value, deviceID) {
  if (!fields(value, 'device_id,binding_revision,fresh,observed_at,items,next_cursor') || value.device_id !== deviceID || !id(value.device_id) || !digest(value.binding_revision) || typeof value.fresh !== 'boolean' || value.next_cursor !== null ||
    !Array.isArray(value.items) || value.items.length > 2048 || value.items.some(item => !fields(item, 'application_id,authorized') || typeof item.application_id !== 'string' || item.application_id.length > 255 || typeof item.authorized !== 'boolean') ||
    new Set(value.items.map(item => item.application_id)).size !== value.items.length || value.fresh && (typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))) || !value.fresh && (value.observed_at !== null || value.items.length)) fail();
  return value;
}
export async function verifyExecutionOperation(value, expected) {
  if (!fields(value, 'operation_id,request,request_digest,status,reason,result,created_at') || !id(value.operation_id) || !/^executionop-[A-Za-z0-9_-]{1,100}$/.test(value.operation_id) ||
    !fields(value.request, 'space_id,idempotency_key,change') || !id(value.request.space_id) || !id(value.request.idempotency_key) || !validExecutionChange(value.request.change) ||
    value.request_digest !== await documentDigest(value.request) || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at)) || expected && !sameJSON(value.request, expected)) fail();
  if (value.status === 'applied') {
    if (value.reason !== null || value.result?.revision === value.request.change.expected_binding_revision) fail();
    const binding = verifyExecutionBinding(value.result, value.request.change.device_id), change = value.request.change;
    if (change.type === 'bindings.bind' && (binding.state !== 'bound' || binding.model_revision !== change.expected_model_revision || Object.values(binding.routes).some(value => !sameJSON(value, change.route))) ||
      change.type === 'bindings.compose' && (binding.state !== 'composed' || binding.model_revision !== change.expected_model_revision || !sameJSON(binding.native_paths, change.native_paths) || Object.values(binding.routes).some(value => !sameJSON(value, change.route))) ||
      change.type === 'bindings.revoke' && binding.state !== 'revoked') fail();
  } else if (!['rejected', 'conflict'].includes(value.status) || value.result !== null || typeof value.reason !== 'string' || value.reason !== value.reason.trim() || !/^[a-z][a-z0-9_]{0,63}$/.test(value.reason) || (value.status === 'conflict') !== (value.reason === 'revision_conflict')) fail();
  return value;
}

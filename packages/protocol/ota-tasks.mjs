import { documentDigest } from './model-validation.mjs';
import { parseBoundedJSON, sameJSON } from './products.mjs';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hex = (value, prefix) => typeof value === 'string' && new RegExp('^' + prefix + '[a-f0-9]{64}$').test(value);
const fields = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = () => { throw new Error('invalid_ota_operation'); };
export function validOtaChange(value) {
  if (!object(value)) return false;
  switch (value.type) {
    case 'trust.add': return fields(value, 'type,trust,expected_signing_key_id') && object(value.trust) && hex(value.expected_signing_key_id, 'sha256:');
    case 'trust.revoke': return fields(value, 'type,trust_id,expected_revision') && hex(value.trust_id, 'fwtrust-') && id(value.expected_revision);
    case 'tasks.plan': return fields(value, 'type,device_id,trust_id,manifest,expires_at') && id(value.device_id) && hex(value.trust_id, 'fwtrust-') && object(value.manifest) && time(value.expires_at);
    case 'tasks.approve':
    case 'tasks.execute':
    case 'tasks.reconcile':
    case 'tasks.cancel': return fields(value, 'type,task_id,expected_revision') && id(value.task_id) && value.task_id.startsWith('ota-') && id(value.expected_revision);
    default: return false;
  }
}
export function parseOtaChange(text) {
  const value = parseBoundedJSON(text, { maxBytes: 16384, maxDepth: 16, maxNodes: 2048 });
  if (!validOtaChange(value)) throw new Error('invalid_ota_change');
  return value;
}
export function parseOtaResponse(text) {
  return parseBoundedJSON(text, { maxBytes: 2_000_000, maxDepth: 24, maxNodes: 65536 });
}
// 客户端核对原请求、摘要和资源身份；签名与升级条件由可信本地Rust执行。
export async function verifyFirmwareTrust(value) {
  if (!fields(value, 'trust_id,revision,trust,active,created_at,revoked_at') || !hex(value.trust_id, 'fwtrust-') || !id(value.revision) ||
      !object(value.trust) || value.trust.schema !== 'limeiot.ota-trust' || value.trust.version !== 1 || value.trust.purpose !== 'device-firmware' ||
      !hex(value.trust.signing_key_id, 'sha256:') || value.trust_id !== 'fwtrust-' + (await documentDigest(value.trust)).slice(7) ||
      typeof value.active !== 'boolean' || value.active !== (value.revoked_at === null) || !time(value.created_at) ||
      !value.active && (!time(value.revoked_at) || Date.parse(value.revoked_at) < Date.parse(value.created_at))) fail();
  return value;
}
function verifyInfo(info) {
  if (!fields(info, 'device,boot_id,session_id,seq,received_at') || !id(info.boot_id) || !id(info.session_id) ||
      !Number.isSafeInteger(info.seq) || info.seq < 0 || !time(info.received_at) ||
      !fields(info.device, 'device_id,product_id,architecture,chip,board,hardware_revision,firmware_version,bootloader_version,protocol_version,model_revision,security_epoch,ota_capacity_bytes,external_power,battery_percent,safe_to_update,pending_update') ||
      !id(info.device.device_id) || !hex(info.device.model_revision, 'sha256:') || info.device.protocol_version !== 1 ||
      !['external_power', 'safe_to_update', 'pending_update'].every(key => typeof info.device[key] === 'boolean') ||
      info.device.battery_percent !== null && (!Number.isInteger(info.device.battery_percent) || info.device.battery_percent < 0 || info.device.battery_percent > 100)) fail();
}
export async function verifyOtaTask(value) {
  if (!fields(value, 'task_id,revision,device_id,trust_id,trust_revision,manifest,manifest_digest,baseline,created_at,expires_at,status,approval,execution,reason') ||
      !id(value.task_id) || !value.task_id.startsWith('ota-') || !id(value.revision) || !id(value.device_id) || !hex(value.trust_id, 'fwtrust-') || !id(value.trust_revision) ||
      !object(value.manifest) || value.manifest_digest !== await documentDigest(value.manifest) ||
      !time(value.created_at) || !time(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.created_at) ||
      !['planned', 'approved', 'cancelled', 'expired', 'invalidated', 'executing', 'unknown', 'succeeded', 'failed'].includes(value.status) ||
      value.reason !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(value.reason) ||
      (value.status === 'approved' || value.execution !== null) !== (value.approval !== null)) fail();
  verifyInfo(value.baseline);
  if (value.baseline.device.device_id !== value.device_id) fail();
  if (value.approval !== null) {
    if (!fields(value.approval, 'approved_at,device_info') || !time(value.approval.approved_at)) fail();
    verifyInfo(value.approval.device_info);
    if (value.approval.device_info.device.device_id !== value.device_id) fail();
  }
  await verifyExecution(value);
  return value;
}
function envelope(value, kind, task, upstream = false) {
  if (!fields(value, 'v,kind,message_id,device_id,model_revision,boot_id,session_id,body' + (upstream ? ',seq' : '')) ||
      value.v !== 1 || value.kind !== kind || !id(value.message_id) || !id(value.boot_id) || !id(value.session_id) ||
      value.device_id !== task.device_id || value.model_revision !== task.baseline.device.model_revision || !object(value.body) ||
      upstream && (!Number.isSafeInteger(value.seq) || value.seq < 0)) fail();
}
async function verifyExecution(task) {
  const execution = task.execution;
  if (execution === null) {
    if (['executing', 'unknown', 'succeeded', 'failed'].includes(task.status)) fail();
    return;
  }
  if (!['executing', 'unknown', 'succeeded', 'failed'].includes(task.status) ||
      !fields(execution, 'envelope,request_digest,prepared_at,attempted_at,receipt,query,query_count') || !time(execution.prepared_at) ||
      execution.attempted_at !== null && (!time(execution.attempted_at) || Date.parse(execution.attempted_at) < Date.parse(execution.prepared_at) || Date.parse(execution.attempted_at) >= Date.parse(task.expires_at)) ||
      Date.parse(execution.prepared_at) < Date.parse(task.approval.approved_at) || Date.parse(execution.prepared_at) >= Date.parse(task.expires_at) ||
      !Number.isInteger(execution.query_count) || execution.query_count < 0 || execution.query_count > 32 || (execution.query_count > 0) !== (execution.query !== null)) fail();
  const install = execution.envelope;
  envelope(install, 'ota_install', task);
  if (execution.request_digest !== await documentDigest(install) || !fields(install.body, 'task_id,execution_id,manifest_digest,manifest,expires_at') ||
      install.boot_id !== task.approval.device_info.boot_id || install.session_id !== task.approval.device_info.session_id ||
      install.body.task_id !== task.task_id || !id(install.body.execution_id) || !install.body.execution_id.startsWith('otaexec-') ||
      install.body.manifest_digest !== task.manifest_digest || !sameJSON(install.body.manifest, task.manifest) || install.body.expires_at !== task.expires_at ||
      task.status === 'unknown' && execution.attempted_at === null) fail();
  const evidence = execution.receipt;
  if (evidence !== null) {
    if (!fields(evidence, 'envelope,received_at') || execution.attempted_at === null || !time(evidence.received_at) || Date.parse(evidence.received_at) < Date.parse(execution.attempted_at)) fail();
    envelope(evidence.envelope, 'ota_result', task, true);
    const body = evidence.envelope.body, success = body.status === 'succeeded';
    const failed = ['rejected', 'failed', 'rolled_back'].includes(body.status);
    if (!fields(body, 'task_id,execution_id,request_digest,manifest_digest,status,firmware_version,security_epoch,image_sha256,pending_update,error') ||
        body.task_id !== task.task_id || body.execution_id !== install.body.execution_id || body.request_digest !== execution.request_digest || body.manifest_digest !== task.manifest_digest ||
        !['installing', 'awaiting_boot', 'succeeded', 'rejected', 'failed', 'rolled_back'].includes(body.status) || !hex(body.image_sha256, 'sha256:') || body.pending_update !== false ||
        failed !== (body.error !== null) || failed && !/^[a-z][a-z0-9_]{0,63}$/.test(body.error) ||
        body.firmware_version !== (success ? task.manifest.statement.version : task.baseline.device.firmware_version) ||
        body.security_epoch !== (success ? task.manifest.statement.security_epoch : task.baseline.device.security_epoch) ||
        success && (body.image_sha256 !== task.manifest.statement.sha256 || evidence.envelope.boot_id === install.boot_id) ||
        body.status === 'rolled_back' && evidence.envelope.boot_id === install.boot_id ||
        !success && !failed && evidence.envelope.boot_id !== install.boot_id ||
        task.status !== (success ? 'succeeded' : failed ? 'failed' : 'executing') && !(task.status === 'unknown' && !success && !failed)) fail();
  } else if (task.status === 'succeeded' || task.status === 'failed' && execution.attempted_at !== null) fail();
  if (execution.query !== null) {
    const query = execution.query;
    if (!fields(query, 'envelope,prepared_at,attempted') || !time(query.prepared_at) || typeof query.attempted !== 'boolean' ||
        execution.attempted_at === null || Date.parse(query.prepared_at) < Date.parse(execution.attempted_at)) fail();
    envelope(query.envelope, 'ota_query', task);
    const body = query.envelope.body;
    if (!fields(body, 'task_id,execution_id,request_digest,manifest_digest,expires_at') || body.task_id !== task.task_id ||
        body.execution_id !== install.body.execution_id || body.request_digest !== execution.request_digest || body.manifest_digest !== task.manifest_digest ||
        !time(body.expires_at) || Date.parse(body.expires_at) !== Date.parse(query.prepared_at) + 30000) fail();
  }
}
export async function verifyOtaOperation(value, expected) {
  if (!fields(value, 'operation_id,request,request_digest,status,reason,resource,created_at') || !id(value.operation_id) || !value.operation_id.startsWith('otaop-') ||
      !fields(value.request, 'space_id,idempotency_key,change') || !id(value.request.space_id) || !id(value.request.idempotency_key) || !validOtaChange(value.request.change) ||
      value.request_digest !== await documentDigest(value.request) || !time(value.created_at) || expected && !sameJSON(expected, value.request)) fail();
  if (value.status !== 'applied') {
    if (!['rejected', 'conflict'].includes(value.status) || value.resource !== null || !/^[a-z][a-z0-9_]{0,63}$/.test(value.reason ?? '') ||
        (value.status === 'conflict') !== (value.reason === 'revision_conflict')) fail();
    return value;
  }
  const resource = value.resource, change = value.request.change;
  if (value.reason !== null || !fields(resource, 'kind,id,revision') || !id(resource.revision)) fail();
  if (change.type.startsWith('trust.')) {
    if (resource.kind !== 'firmware_trust' || !hex(resource.id, 'fwtrust-')) fail();
    if (change.type === 'trust.add' && (resource.id !== 'fwtrust-' + (await documentDigest(change.trust)).slice(7) || change.expected_signing_key_id !== change.trust.signing_key_id) ||
        change.type === 'trust.revoke' && resource.id !== change.trust_id) fail();
  } else {
    if (resource.kind !== 'ota_task' || !id(resource.id) || !resource.id.startsWith('ota-') || change.type !== 'tasks.plan' && resource.id !== change.task_id) fail();
  }
  return value;
}

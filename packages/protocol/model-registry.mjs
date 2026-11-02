import { canonicalJSON, documentDigest } from './model-validation.mjs';
import { parseBoundedJSON, sameJSON } from './products.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hex = (value, prefix) => typeof value === 'string' && new RegExp('^' + prefix + '[a-f0-9]{64}$').test(value);
const fields = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const fail = () => { throw new Error('invalid_model_operation'); };
export function validModelChange(value) {
  if (!object(value)) return false;
  switch (value.type) {
    case 'trust.add': return fields(value, 'type,trust,expected_signing_key_id') && object(value.trust) && hex(value.expected_signing_key_id, 'sha256:');
    case 'trust.revoke': return fields(value, 'type,trust_id,expected_revision') && hex(value.trust_id, 'trust-') && identifier(value.expected_revision);
    case 'models.install': return fields(value, 'type,trust_id,artifact,expected_release_id') && hex(value.trust_id, 'trust-') && object(value.artifact) && (value.expected_release_id === null || hex(value.expected_release_id, 'release-'));
    case 'devices.bind': return fields(value, 'type,device_id,installation_id,expected_model_revision,expected_binding_revision') && identifier(value.device_id) && hex(value.installation_id, 'install-') &&
      (value.expected_model_revision === null || hex(value.expected_model_revision, 'sha256:')) && (value.expected_binding_revision === null || identifier(value.expected_binding_revision));
    default: return false;
  }
}
export function parseModelChange(text) {
  const value = parseBoundedJSON(text, { maxBytes: 16384, maxDepth: 20, maxNodes: 2400 });
  if (!validModelChange(value)) throw new Error('invalid_model_change');
  return value;
}

export async function verifyPublisherTrust(resource) {
  if (!fields(resource, 'trust_id,revision,trust,active,created_at,revoked_at') || !hex(resource.trust_id, 'trust-') || !identifier(resource.revision) ||
    !fields(resource.trust, 'version,issuer,publisher_id,namespace,signing_key_id,public_key') || resource.trust.version !== 1 ||
    !hex(resource.trust.signing_key_id, 'sha256:') || typeof resource.active !== 'boolean' ||
    resource.trust_id !== 'trust-' + (await documentDigest(resource.trust)).slice(7) ||
    !Number.isFinite(Date.parse(resource.created_at)) || resource.active !== (resource.revoked_at === null) ||
    !resource.active && !Number.isFinite(Date.parse(resource.revoked_at))) fail();
  return resource;
}
export async function verifyModelInstallation(resource) {
  if (!fields(resource, 'installation_id,trust_id,artifact,installed_at') || !hex(resource.trust_id, 'trust-') ||
    resource.installation_id !== 'install-' + (await documentDigest({ artifact: resource.artifact, trust_id: resource.trust_id })).slice(7) ||
    !Number.isFinite(Date.parse(resource.installed_at)) || !object(resource.artifact?.statement?.model) ||
    resource.artifact.statement.model_revision !== await documentDigest(resource.artifact.statement.model) ||
    !hex(resource.artifact.statement.release_id, 'release-') || typeof resource.artifact.statement.model.model_id !== 'string') fail();
  return resource;
}
function verifyBinding(resource) {
  if (!fields(resource, 'device_id,model_revision,installation_id,revision,bound_at') || !identifier(resource.device_id) ||
    !hex(resource.installation_id, 'install-') || !hex(resource.model_revision, 'sha256:') || !identifier(resource.revision) ||
    !Number.isFinite(Date.parse(resource.bound_at))) fail();
  return resource;
}
export function verifyModelBinding(value, deviceID) {
  if (!fields(value, 'device_id,model_revision,binding,trust_active') || value.device_id !== deviceID || !identifier(value.device_id) ||
    value.model_revision !== null && !hex(value.model_revision, 'sha256:') || typeof value.trust_active !== 'boolean') fail();
  if (value.binding !== null) {
    const binding = verifyBinding(value.binding);
    if (binding.device_id !== value.device_id || binding.model_revision !== value.model_revision) fail();
  }
  if (value.model_revision === null && (value.trust_active || value.binding !== null)) fail();
  return value;
}

// 客户端只核对可信本地API的原请求、摘要和资源；验签和规则由Rust执行。
export async function verifyModelOperation(value, expected) {
  if (!fields(value, 'operation_id,request,request_digest,status,reason,result,created_at') || !identifier(value.operation_id) || !value.operation_id.startsWith('modelop-') ||
    !fields(value.request, 'space_id,idempotency_key,change') || !identifier(value.request.space_id) || !identifier(value.request.idempotency_key) || !validModelChange(value.request.change) ||
    !hex(value.request_digest, 'sha256:') || value.request_digest !== await documentDigest(value.request) || !Number.isFinite(Date.parse(value.created_at)) ||
    expected && !sameJSON(value.request, expected)) fail();
  if (value.status !== 'applied') {
    if (!['rejected', 'conflict'].includes(value.status) || value.result !== null || typeof value.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.reason) ||
      (value.status === 'conflict') !== (value.reason === 'revision_conflict')) fail();
    return value;
  }
  if (value.reason !== null || !fields(value.result, 'type,value')) fail();
  const change = value.request.change, resource = value.result.value;
  if (!object(resource)) fail();
  if (change.type.startsWith('trust.')) {
    if (value.result.type !== 'trust') fail();
    await verifyPublisherTrust(resource);
    if (change.type === 'trust.add' && (!resource.active || !sameJSON(change.trust, resource.trust) || change.expected_signing_key_id !== resource.trust.signing_key_id) ||
      change.type === 'trust.revoke' && (resource.active || resource.trust_id !== change.trust_id)) fail();
  } else if (change.type === 'models.install') {
    if (value.result.type !== 'installation' || resource.trust_id !== change.trust_id || !sameJSON(resource.artifact, change.artifact)) fail();
    await verifyModelInstallation(resource);
  } else if (change.type === 'devices.bind') {
    if (value.result.type !== 'binding' || resource.device_id !== change.device_id || resource.installation_id !== change.installation_id) fail();
    verifyBinding(resource);
  } else fail();
  return value;
}
export const sameModelRequest = (one, two) => canonicalJSON(one) === canonicalJSON(two);

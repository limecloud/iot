import { canonicalJSON, documentDigest } from './model-validation.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected;

// 本地命令允许读取受理和未知状态；每种状态均须对应原完整请求。
export async function verifyLocalCommand(receipt, expected) {
  const invalid = () => { throw new Error('invalid_command_receipt'); };
  if (!object(receipt) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.command_id ?? '') ||
      !['accepted', 'dispatched', 'confirmed', 'unknown', 'failed', 'expired', 'rejected'].includes(receipt.status) ||
      !keys(receipt.request, 'device_id,expires_at,idempotency_key,model_revision,operation,space_id') ||
      !Number.isFinite(Date.parse(receipt.request.expires_at)) || !Number.isFinite(Date.parse(expected?.expires_at)) ||
      canonicalJSON({ ...receipt.request, expires_at: Date.parse(receipt.request.expires_at) }) !== canonicalJSON({ ...expected, expires_at: Date.parse(expected.expires_at) }) ||
      !keys(expected.operation, 'path,type,value') || !['property.set', 'action.invoke'].includes(expected.operation.type) ||
      receipt.request_digest !== await documentDigest(receipt.request)) invalid();
  if (receipt.status === 'confirmed') {
    const { command_id, error, evidence, request, request_digest, status } = receipt;
    await verifyConfirmedReceipt({ command_id, error, evidence, request, request_digest, status }, expected);
  }
  return receipt;
}

// 只验证回执与原操作绑定；模型、授权和真实执行效果仍由设备及Rust网关检查。
export async function verifyConfirmedReceipt(receipt, expected) {
  const invalid = () => { throw new Error('invalid_command_receipt'); };
  if (!keys(receipt, 'command_id,error,evidence,request,request_digest,status') ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.command_id ?? '') || receipt.status !== 'confirmed' || receipt.error !== null ||
      !keys(receipt.request, 'device_id,expires_at,idempotency_key,model_revision,operation,space_id') ||
      !Number.isFinite(Date.parse(receipt.request.expires_at)) ||
      canonicalJSON({ ...receipt.request, expires_at: Date.parse(receipt.request.expires_at) }) !== canonicalJSON({ ...expected, expires_at: Date.parse(expected.expires_at) }) ||
      receipt.request_digest !== await documentDigest(receipt.request)) invalid();
  const operation = expected.operation, evidence = receipt.evidence;
  if (operation.type === 'property.set') {
    if (!object(evidence) || evidence.type !== 'device_result' || !object(evidence.reported) ||
        !Object.hasOwn(evidence.reported, operation.path) || canonicalJSON(evidence.reported[operation.path]) !== canonicalJSON(operation.value)) invalid();
  } else if (operation.type === 'action.invoke') {
    if (!keys(evidence, 'completion,input_digest,observed_at,output,path,type') || evidence.type !== 'action_result' ||
        evidence.path !== operation.path || evidence.input_digest !== await documentDigest(operation.value) ||
        evidence.output === null || !['submitted', 'observed'].includes(evidence.completion) ||
        !Number.isFinite(Date.parse(evidence.observed_at)) || Date.parse(evidence.observed_at) < Date.parse(expected.expires_at) - 32000 ||
        Date.parse(evidence.observed_at) > Date.now() + 2000) invalid();
  } else invalid();
  return receipt;
}

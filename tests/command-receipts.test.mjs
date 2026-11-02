import test from 'node:test';
import assert from 'node:assert/strict';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { verifyConfirmedReceipt } from '../packages/protocol/command-receipts.mjs';

test('跨端动作回执绑定原输入、完成范围、时间和完整命令摘要', async () => {
  const now = Date.now();
  const request = { space_id: 'home', idempotency_key: 'original', device_id: 'tv', model_revision: 'sha256:' + 'a'.repeat(64), expires_at: new Date(now + 5000).toISOString(), operation: { type: 'action.invoke', path: 'remote.press', value: { key: 'home' } } };
  const evidence = { type: 'action_result', path: 'remote.press', input_digest: await documentDigest(request.operation.value), output: {}, completion: 'submitted', observed_at: new Date(now).toISOString() };
  const receipt = { command_id: 'command-original', status: 'confirmed', error: null, request, request_digest: await documentDigest(request), evidence };
  assert.equal(await verifyConfirmedReceipt(receipt, request), receipt);
  for (const change of [
    { type: 'device_result' }, { path: 'other.press' }, { input_digest: 'sha256:' + 'b'.repeat(64) }, { completion: 'done' },
    { output: null }, { extra: true }, { observed_at: new Date(now + 5000).toISOString() }, { observed_at: new Date(now - 60000).toISOString() },
  ]) await assert.rejects(verifyConfirmedReceipt({ ...receipt, evidence: { ...evidence, ...change } }, request), /invalid_command_receipt/);
  const missing = { ...evidence }; delete missing.output;
  await assert.rejects(verifyConfirmedReceipt({ ...receipt, evidence: missing }, request), /invalid_command_receipt/);
  for (const change of [{ device_id: 'other' }, { idempotency_key: 'new-key' }, { operation: { ...request.operation, value: { key: 'back' } } }]) {
    const changed = { ...request, ...change };
    await assert.rejects(verifyConfirmedReceipt({ ...receipt, request: changed, request_digest: await documentDigest(changed) }, request), /invalid_command_receipt/);
  }
  await assert.rejects(verifyConfirmedReceipt({ ...receipt, request_digest: 'sha256:' + '0'.repeat(64) }, request), /invalid_command_receipt/);
  const property = { ...request, operation: { type: 'property.set', path: 'audio.volume', value: 75 } };
  const propertyReceipt = { ...receipt, request: property, request_digest: await documentDigest(property), evidence: { type: 'device_result', reported: { 'audio.volume': 75 } } };
  assert.equal(await verifyConfirmedReceipt(propertyReceipt, property), propertyReceipt);
  await assert.rejects(verifyConfirmedReceipt({ ...propertyReceipt, evidence: { type: 'device_result', reported: { 'audio.volume': 0 } } }, property), /invalid_command_receipt/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parseBoundedJSON } from '../packages/protocol/products.mjs';
import { parseZigbeeChange, verifyZigbeeCoordinators, verifyZigbeeOperation, verifyZigbeeOperations } from '../packages/protocol/zigbee-operations.mjs';

test('网页与Swift/Kotlin使用同一入网正反向向量，支持256条正式历史容量', async () => {
  const v = JSON.parse(await readFile(new URL('./fixtures/zigbee/commissioning-native.json', import.meta.url)));
  verifyZigbeeCoordinators(v.coordinators); parseZigbeeChange(JSON.stringify(v.change));
  await verifyZigbeeOperation(v.unknown); await verifyZigbeeOperation(v.accepted);
  for (const { type, document } of v.invalid) {
    await assert.rejects(async () => {
      if (type === 'change') parseZigbeeChange(JSON.stringify(document));
      else if (type === 'coordinators') verifyZigbeeCoordinators(document);
      else if (type === 'operation') await verifyZigbeeOperation(document);
      else await verifyZigbeeOperations(document, 'space-demo');
    });
  }
  const items = await Promise.all(Array.from({ length: 256 }, async (_, index) => {
    const value = structuredClone(v.accepted);
    value.sequence = index + 1; value.operation_id = `join-${index}`; value.request.idempotency_key = `original-${index}`;
    value.request_digest = await documentDigest(value.request); return value;
  }));
  const page = { items, next_cursor: null };
  const parsed = parseBoundedJSON(JSON.stringify(page), { maxBytes: 2_000_000, maxDepth: 12, maxNodes: 20000 });
  assert.equal((await verifyZigbeeOperations(parsed, 'space-demo')).items.length, 256);
});

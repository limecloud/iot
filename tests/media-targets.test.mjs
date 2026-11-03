import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyExecutionAdapters, verifyExecutionBinding } from '../packages/protocol/execution-bindings.mjs';

test('原生音频目标共享向量遵循当前执行绑定合同', async () => {
  const vector = JSON.parse(await readFile(new URL('./fixtures/media/targets.json', import.meta.url), 'utf8'));
  const candidates = verifyExecutionAdapters(vector.page).items.filter(item => item.kind === 'dlna' && item.managed_media === true && item.compatible);
  const targets = candidates.filter(candidate => {
    const binding = verifyExecutionBinding(vector.bindings[candidate.device_id], candidate.device_id);
    return JSON.stringify(binding.routes['playback.play']) === JSON.stringify(candidate.route);
  });
  assert.deepEqual(targets.map(item => item.device_id), vector.expected);
  for (const item of vector.invalid_pages) assert.throws(() => verifyExecutionAdapters(item.page), item.name);
  for (const item of vector.invalid_bindings) assert.throws(() => verifyExecutionBinding(item.binding, 'speaker-bound'), item.name);
});

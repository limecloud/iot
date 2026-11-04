import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyLocalCommand } from '../packages/protocol/command-receipts.mjs';
import { commandStorageKey, readCommandRecords, writeCommandRecords } from '../apps/home/src/command-records.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/commands/recovery.json', import.meta.url)));
test('本地命令三端共享向量：完整原请求、状态与成功证据', async () => {
  for (const row of fixture.cases) {
    if (row.valid) assert.equal(await verifyLocalCommand(row.response, row.expected), row.response, row.name);
    else await assert.rejects(verifyLocalCommand(row.response, row.expected), /invalid_command_receipt/, row.name);
  }
  const row = structuredClone(fixture.cases[0]);
  row.response.request_digest = 'sha256:' + 'f'.repeat(64);
  await assert.rejects(verifyLocalCommand(row.response, row.expected), /invalid_command_receipt/);
});

class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
const input = fixture.cases[0].expected;
const original = { key: input.idempotency_key, space: '/api/v1/spaces/' + input.space_id,
  input: Object.fromEntries(Object.entries(input).filter(([key]) => !['space_id', 'idempotency_key'].includes(key))) };
test('浏览器关闭后读取完整请求；旧会话记录只在耐久回读成功后迁移', () => {
  const local = new Storage(), legacy = new Storage();
  legacy.setItem(commandStorageKey, JSON.stringify({ 'device-lamp': { key: original.key, space: original.space } }));
  assert.equal(readCommandRecords(local, legacy)['device-lamp'].input, undefined);
  writeCommandRecords(local, legacy, { 'device-lamp': original });
  assert.equal(legacy.getItem(commandStorageKey), null);
  assert.deepEqual(readCommandRecords(local, new Storage()), { 'device-lamp': original });
});
test('损坏、冲突及未真正保存的记录均不能被当作空记录', () => {
  const local = new Storage(), legacy = new Storage();
  for (const text of ['{', '[]', '{"device-lamp":null}', '{"device-lamp":{"key":"a","key":"b","space":"/api/v1/spaces/space-demo"}}']) {
    local.setItem(commandStorageKey, text);
    assert.throws(() => readCommandRecords(local, legacy));
  }
  local.setItem(commandStorageKey, JSON.stringify({ 'device-lamp': original }));
  legacy.setItem(commandStorageKey, JSON.stringify({ 'device-lamp': { ...original, key: 'another-key' } }));
  assert.throws(() => readCommandRecords(local, legacy), /command_record_unavailable/);
  const ignored = new Storage(); ignored.setItem = () => {};
  assert.throws(() => writeCommandRecords(ignored, legacy, { 'device-lamp': original }), /command_record_unavailable/);
  assert.notEqual(legacy.getItem(commandStorageKey), null);
});

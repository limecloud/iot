import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseTextInput, createTextOriginal, verifyTextTask, verifyTextCapabilities } from '../packages/protocol/text.mjs';

test('文字原生共享合同：Unicode、时区、摘要、usage 与无效向量', async () => {
  const vector = JSON.parse(await readFile(new URL('./fixtures/text/contract.json', import.meta.url)));
  const schema = JSON.parse(await readFile(new URL('../contracts/text.schema.json', import.meta.url)));
  const ajv = new Ajv({ strict: false }); addFormats(ajv); ajv.addSchema(schema);
  const request = ajv.getSchema(schema.$id), task = ajv.compile({ $ref: schema.$id + '#/$defs/task' });
  assert.equal(request(vector.input), true, JSON.stringify(request.errors));
  assert.deepEqual(parseTextInput(JSON.stringify(vector.input)), vector.normalized);
  assert.deepEqual(await createTextOriginal('https://nas.local', 'space-demo', 'original', vector.input), vector.original);
  verifyTextCapabilities(vector.capabilities);
  for (const value of Object.values(vector.tasks)) { assert.equal(task(value), true, JSON.stringify(task.errors)); await verifyTextTask(value, 'space-demo', 'original', vector.original); }
  for (const [name, value] of Object.entries(vector.invalid_inputs)) assert.throws(() => parseTextInput(JSON.stringify(value)), name);
  for (const [name, raw] of Object.entries(vector.invalid_input_json)) assert.throws(() => parseTextInput(raw), name);
  for (const [name, value] of Object.entries(vector.invalid_tasks)) await assert.rejects(() => verifyTextTask(value, 'space-demo', 'original', vector.original), undefined, name);
  for (const [name, raw] of Object.entries(vector.invalid_task_json)) await assert.rejects(() => verifyTextTask(JSON.parse(raw), 'space-demo', 'original', vector.original), undefined, name);
});

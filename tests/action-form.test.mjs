import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFormValue, sampleValue } from '../packages/protocol/action-form.mjs';
import { checkFormValue as terminalCheck, sampleValue as terminalSample } from '../packages/cli/src/task-session.mjs';

test('浏览器与终端共用有界动作字段，保留原终端导出', () => {
  assert.equal(terminalCheck, checkFormValue); assert.equal(terminalSample, sampleValue);
  const schema = { type: 'object', properties: {
    key: { type: 'string', enum: ['home', 'back'] },
    duration: { type: 'integer', minimum: 1, maximum: 1000 },
    enabled: { type: 'boolean' }, title: { type: 'string', minLength: 2, maxLength: 4 },
  }, required: ['key', 'duration'], additionalProperties: false };
  assert.deepEqual(sampleValue(schema), { key: 'home', duration: 1 });
  assert(checkFormValue({ key: 'back', duration: 10, enabled: false, title: '你好' }, schema));
  for (const value of [{ key: 'home' }, { key: 'invalid', duration: 10 }, { key: 'home', duration: 0 }, { key: 'home', duration: 1.5 }, { key: 'home', duration: 10, extra: true }, { key: 'home', duration: 10, enabled: 'true' }, { key: 'home', duration: 10, title: '过长的名称' }]) assert.equal(checkFormValue(value, schema), false);
  assert.equal(checkFormValue(Number.MAX_SAFE_INTEGER + 1, { type: 'integer' }), false);
  assert.equal(checkFormValue(Infinity, { type: 'number' }), false);
  assert(checkFormValue('😀😀', { type: 'string', minLength: 2, maxLength: 2 }));
  const first = sampleValue(schema); first.key = 'back'; assert.equal(sampleValue(schema).key, 'home');
});

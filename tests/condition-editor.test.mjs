import test from 'node:test';
import assert from 'node:assert/strict';
import { compileConditions, conditionSources, newCondition, restoreConditions } from '../packages/protocol/condition-form.mjs';
import { verifyRuleSimulation } from '../packages/protocol/rule-simulation.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const sources = [
  { key: 'sensor/environment.temperature', device: 'sensor', path: 'environment.temperature', schema: { type: 'integer', minimum: -4500, maximum: 13000 }, unit: 'celsius_x100' },
  { key: 'lamp/light.power', device: 'lamp', path: 'light.power', schema: { type: 'boolean' } },
  { key: 'pet/voice.mode', device: 'pet', path: 'voice.mode', schema: { type: 'string', minLength: 1, maxLength: 8, enum: ['Talk', 'quiet'] } },
];
const form = () => ({ ...newCondition(sources[0]), operator: 'gte', value: '28.03' });
test('条件发现接受全部可读标量，不要求notify或单位', () => {
  const model = { services: [{ id: 'environment', properties: sources.map((source, i) => ({ id: `p${i}`, access: ['read'], schema: source.schema, ...(source.unit ? { unit: source.unit } : {}) })).concat([{ id: 'write_only', access: ['write'], schema: { type: 'boolean' } }, { id: 'object', access: ['read'], schema: { type: 'object' } }]) }] };
  const result = conditionSources([{ device_id: 'sensor', model_revision: 'rev' }], { rev: model });
  assert.equal(result.length, 3); assert.equal(result[1].unit, undefined); assert.equal(result[2].schema.type, 'string');
});
test('条件表单精确换算与完整树往返，拒绝隐式转换和无效编辑', () => {
  const forms = [{ kind: 'all', children: [form(), { kind: 'any', children: [newCondition(sources[1]), newCondition(sources[2])] }] }];
  const tree = compileConditions(forms, sources);
  assert.equal(tree[0].all[0].value, 2803); assert(!Object.hasOwn(tree[0].all[1].any[0], 'unit'));
  assert.deepEqual(restoreConditions(tree, sources), forms);
  for (const value of ['28.001', 'NaN', '131', '1e2', '']) assert.equal(compileConditions([{ ...form(), value }], sources), null, value);
  assert.equal(compileConditions([{ ...newCondition(sources[1]), value: '1' }], sources), null);
  assert.equal(compileConditions([{ ...newCondition(sources[2]), value: 'talk' }], sources), null);
  for (const patch of [{ unit: 'kelvin' }, { extra: true }, { value: '2803' }]) assert.equal(restoreConditions([{ ...tree[0].all[0], ...patch }], sources), null);
});
test('条件表单限额不截断，原树缺失来源或超限时拒绝编辑', () => {
  let nested = form(); for (let depth = 0; depth < 3; depth++) nested = { kind: 'all', children: [nested] };
  assert(compileConditions([nested], sources)); assert.equal(compileConditions([{ kind: 'any', children: [nested] }], sources), null);
  assert.equal(compileConditions([{ kind: 'all', children: [] }], sources), null);
  assert.equal(compileConditions(Array.from({ length: 17 }, form), sources), null);
  assert.equal(compileConditions(Array.from({ length: 16 }, () => ({ kind: 'any', children: [form(), form()] })), sources), null);
  assert.equal(restoreConditions([{ device: 'missing', property: 'light.power', operator: 'eq', value: true }], sources), null);
});

async function preview(matched = false) {
  const rule = { version: 1, id: 'conditional-rule', trigger: { device: 'button', event: 'button.pressed' }, conditions: [{ all: [{ device: 'lamp', property: 'light.power', operator: 'eq', value: true }] }], actions: [{ device: 'lamp', set: { path: 'light.power', value: true } }], cooldown_ms: 0 };
  const revision = await documentDigest(rule), now = new Date().toISOString();
  const evaluation = { evaluated_at: now, conditions: rule.conditions, matched, results: [{ matched, children: [{ matched, model_revision: 'sha256:' + 'a'.repeat(64), observation: { value: matched, observed_at: now, quality: 'confirmed', source: 'device' } }] }] };
  return { rule, validation: { valid: true, revision }, proof: { executed: false, simulation: true, revision, trigger_matched: true, matched, proposed_actions: matched ? rule.actions : [], condition_evaluation: evaluation } };
}
test('条件未满足仅在触发有效且完整证据绑定时可进入明确部署', async () => {
  for (const matched of [false, true]) { const { rule, proof, validation } = await preview(matched); assert.equal(await verifyRuleSimulation(rule, proof, validation), proof); }
});
test('预演拒绝无效触发、错误修订、条件截断、伪造匹配和非空预计操作', async () => {
  const mutations = [p => delete p.trigger_matched, p => p.trigger_matched = false, p => p.executed = true, p => p.revision = 'wrong', p => p.proposed_actions = [{ device: 'lamp' }], p => p.condition_evaluation.conditions = [], p => p.condition_evaluation.results = [], p => p.condition_evaluation.results[0].matched = true, p => p.condition_evaluation.results[0].children[0].matched = true, p => p.condition_evaluation.results[0].children[0].observation.quality = 'unknown'];
  for (const mutate of mutations) {
    const { rule, proof, validation } = await preview(); const changed = structuredClone(proof); mutate(changed);
    await assert.rejects(verifyRuleSimulation(rule, changed, validation), /invalid_simulation/);
  }
});

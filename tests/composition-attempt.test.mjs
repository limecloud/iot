import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileComposition, parseCompositionAttempt, planComposition } from '../packages/protocol/composition.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const source = await readFile(new URL('../examples/compositions/reading-companion/package.json', import.meta.url), 'utf8');
const bindings = { touch: 'device-button', light: 'device-lamp' }, origin = 'http://127.0.0.1:4567', space = 'space-demo';
const compiled = await compileComposition(source, JSON.stringify(bindings), 'reading-web');
const original = { version: 1, origin, space_id: space, package: JSON.parse(source), bindings, instance_id: compiled.rule.id, rule_revision: compiled.rule_revision, state: 'attempted' };
const encode = async body => JSON.stringify({ ...body, checksum: await documentDigest(body) });

test('组合提交恢复精确绑定原请求，拒绝损坏、跨实例和不一致修订', async () => {
  for (const state of ['attempted', 'acknowledged', 'rejected']) {
    const parsed = await parseCompositionAttempt(await encode({ ...original, state }), origin, space);
    assert.equal(parsed.record.state, state); assert.deepEqual(parsed.compiled.rule, compiled.rule);
  }
  const raw = await encode(original);
  await assert.rejects(parseCompositionAttempt(raw, 'http://127.0.0.1:4568', space), /composition_record_unavailable/);
  await assert.rejects(parseCompositionAttempt(raw, origin, 'another-space'), /composition_record_unavailable/);
  for (const change of [
    record => { record.state = 'acknowledged'; },
    record => { record.bindings.light = 'different-lamp'; },
    record => { record.package.rule.actions[0].set.value = false; },
    record => { record.instance_id = 'different-instance'; },
    record => { record.rule_revision = 'sha256:' + '0'.repeat(64); },
  ]) {
    const changed = JSON.parse(raw); change(changed);
    await assert.rejects(parseCompositionAttempt(JSON.stringify(changed), origin, space), /composition_record_unavailable/);
    // 即使重新计算校验和，原规则修订仍必须与包、绑定和实例一致。
    if (changed.state !== 'acknowledged') {
      delete changed.checksum;
      await assert.rejects(parseCompositionAttempt(await encode(changed), origin, space), /composition_record_unavailable/);
    }
  }
  for (const body of [{ ...original, extra: true }, { ...original, version: 2 }, { ...original, state: 'current' }]) {
    await assert.rejects(parseCompositionAttempt(await encode(body), origin, space), /composition_record_unavailable/);
  }
  for (const bad of ['{', raw.replace('"version":1', '"version":1,"version":1'), raw + '{}', ' '.repeat(65537)]) {
    await assert.rejects(parseCompositionAttempt(bad, origin, space), /composition_record_unavailable/);
  }
});

test('组合规划取消后不进入预演或部署阶段', async () => {
  let active = true;
  const calls = [];
  await assert.rejects(planComposition(compiled, { origin, space, active: () => active, request: async resource => {
    calls.push(resource);
    if (calls.length === 2) active = false;
    const expected = compiled.expected_models.find(item => resource.endsWith('/' + item.device_id));
    assert(expected); return { ...expected, ready: true };
  } }), /composition_paused/);
  assert.equal(calls.length, 2); assert(calls.every(resource => resource.includes('/devices/')));
});

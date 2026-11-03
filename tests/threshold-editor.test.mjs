import test from 'node:test';
import assert from 'node:assert/strict';
import { thresholdTrigger, thresholdSamples, parseNumber } from '../apps/home/src/threshold.ts';

test('阈值编辑按十进制换算单位，拒绝超精度、滞回越界和不可越过的预演', () => {
  const schema = { type: 'integer', minimum: -4500, maximum: 13000 };
  const make = (threshold, hysteresis = '1', edge = 'rising') => thresholdTrigger('environment.temperature', 'celsius_x100', schema, edge, threshold, hysteresis);
  const property = make('28.03');
  assert.equal(property.threshold, 2803); assert.equal(property.hysteresis, 100);
  assert.equal(thresholdSamples(property, schema).current.value, 2804);
  assert.equal(parseNumber('0.29', schema, property.unit), 29);
  for (const input of ['', 'NaN', 'Infinity', '28.001', '1e2', '131']) assert.equal(make(input), null, input);
  assert.equal(make('-45'), null); assert.equal(make('28', '-1'), null);
  assert.equal(thresholdSamples(make('130'), schema), null);
  const falling = thresholdSamples(make('-44', '1', 'falling'), schema);
  assert.equal(falling.previous.value, -4300); assert.equal(falling.current.value, -4401);
  assert.equal(parseNumber('0.5', { type: 'integer' }), null);
  const terminal = thresholdSamples(property, schema, { source: 'simulation.tui', now: Date.parse('2026-11-03T00:00:00Z') });
  assert.equal(terminal.current.source, 'simulation.tui'); assert.equal(terminal.current.quality, 'confirmed');
  assert.equal(Date.parse(terminal.current.observed_at) - Date.parse(terminal.previous.observed_at), 1);
  assert.equal(thresholdSamples(property, schema).current.source, 'simulation.ui');
});

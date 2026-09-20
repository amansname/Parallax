import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioRunKey } from './scenarioRunKey.js';

test('input keys preserve distinctions lost by ordinary JSON serialization', () => {
  const values = [null, undefined, NaN, Infinity, -Infinity, 0, -0, 'NaN', {}, { x: undefined }, [], Array(1), [undefined]];
  const keys = values.map(value => scenarioRunKey({ value }, 2026));
  assert.ok(keys.every(key => typeof key === 'string'));
  assert.equal(new Set(keys).size, values.length);
  assert.notEqual(scenarioRunKey({}, 2026), scenarioRunKey({}, 2027));
});

test('unsupported or cyclic input disables reuse instead of suppressing a calculation', () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [cycle, new Map(), new Date(), () => {}, { [Symbol('key')]: 1 }]) assert.equal(scenarioRunKey(value, 2026), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, shouldRunUnitSuite } from './verification-runtime.mjs';

test('unit verification remains enabled unless CI explicitly supplies the skip signal', () => {
  assert.equal(shouldRunUnitSuite({}), true);
  assert.equal(shouldRunUnitSuite({ PARALLAX_VERIFY_SKIP_UNIT_TESTS: '0' }), true);
  assert.equal(shouldRunUnitSuite({ PARALLAX_VERIFY_SKIP_UNIT_TESTS: '1' }), false);
});

test('verification durations use stable seconds in logs', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(1234), '1.2s');
});

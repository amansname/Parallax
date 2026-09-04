import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BROWSER_VERIFICATION_SHARDS,
  formatDuration,
  selectedBrowserShard,
  shouldRunBrowserShard,
  shouldRunUnitSuite
} from './verification-runtime.mjs';

test('unit verification remains enabled unless CI explicitly supplies the skip signal', () => {
  assert.equal(shouldRunUnitSuite({}), true);
  assert.equal(shouldRunUnitSuite({ PARALLAX_VERIFY_SKIP_UNIT_TESTS: '0' }), true);
  assert.equal(shouldRunUnitSuite({ PARALLAX_VERIFY_SKIP_UNIT_TESTS: '1' }), false);
});

test('verification durations use stable seconds in logs', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(1234), '1.2s');
});

test('browser verification defaults to the complete campaign and selects one known CI shard', () => {
  assert.deepEqual(BROWSER_VERIFICATION_SHARDS, ['startup', 'wizard', 'planning', 'persistence']);
  assert.equal(selectedBrowserShard({}), 'all');
  assert.equal(selectedBrowserShard({ PARALLAX_VERIFY_SHARD: 'planning' }), 'planning');
  assert.equal(shouldRunBrowserShard('all', 'wizard'), true);
  assert.equal(shouldRunBrowserShard('planning', 'planning'), true);
  assert.equal(shouldRunBrowserShard('planning', 'wizard'), false);
  assert.throws(() => shouldRunBrowserShard('typo', 'startup'), /Unknown browser verification shard/);
});

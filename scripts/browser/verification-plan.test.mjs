import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBrowserShards } from './verification-plan.mjs';

test('browser planning always keeps the short startup smoke shard', () => {
  assert.deepEqual(planBrowserShards(['docs/README.md']), ['startup']);
});

test('browser planning adds only shards owned by the changed surface', () => {
  assert.deepEqual(planBrowserShards(['ui/goalsHorizon.js']), ['startup', 'planning']);
  assert.deepEqual(planBrowserShards(['src/household/deleteHousehold.js']), ['startup', 'wizard', 'persistence']);
});

test('cross-cutting verifier and runtime changes require all parallel shards', () => {
  assert.deepEqual(planBrowserShards(['scripts/verify.mjs']), ['startup', 'wizard', 'planning', 'persistence']);
  assert.deepEqual(planBrowserShards([], { full: true }), ['startup', 'wizard', 'planning', 'persistence']);
});

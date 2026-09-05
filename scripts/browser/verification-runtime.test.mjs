import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BROWSER_GROUPS, formatDuration, selectedBrowserGroup, shouldRunBrowserGroup, shouldRunUnitSuite,
} from './verification-runtime.mjs';

test('browser verification defaults to every contract and rejects unknown or empty selections', () => {
  assert.equal(selectedBrowserGroup({}), 'all');
  assert.equal(selectedBrowserGroup({ PARALLAX_VERIFY_BROWSER_GROUP: 'all' }), 'all');
  for(const group of BROWSER_GROUPS){
    assert.equal(selectedBrowserGroup({ PARALLAX_VERIFY_BROWSER_GROUP: group }), group);
  }
  for(const group of ['', 'wizard', 'scenario', 'ALL']){
    assert.throws(() => selectedBrowserGroup({ PARALLAX_VERIFY_BROWSER_GROUP: group }), /Unknown browser verification group/);
  }
});

test('browser group routing includes shared prerequisites only in their declared groups', () => {
  assert.equal(shouldRunBrowserGroup('all', 'entry'), true);
  for(const group of BROWSER_GROUPS){
    assert.equal(shouldRunBrowserGroup(group, group), true);
    assert.equal(shouldRunBrowserGroup(group, ...BROWSER_GROUPS.filter(other => other !== group)), false);
  }
  assert.equal(shouldRunBrowserGroup('wizard-forms', 'wizard-runtime', 'wizard-forms'), true);
});

test('unit verification remains enabled unless CI explicitly supplies the skip signal', () => {
  assert.equal(shouldRunUnitSuite({}), true);
  assert.equal(shouldRunUnitSuite({ PARALLAX_VERIFY_SKIP_UNIT_TESTS: '0' }), true);
  assert.equal(shouldRunUnitSuite({ PARALLAX_VERIFY_SKIP_UNIT_TESTS: '1' }), false);
});

test('verification durations use stable seconds in logs', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(1234), '1.2s');
});

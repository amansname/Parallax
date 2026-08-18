import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableRuntimeCopy } from './runtimeHouseholdSave.js';

test('runtime template becomes a distinct durable household without mutating the template', () => {
  const runtime = {
    meta: {
      householdId: 'default-pre-retirement-solo',
      name: 'Pre-Retirement Solo',
      isDemo: false,
      isSelectableDefault: true,
    },
    netWorth: { schemaVersion: 1, shellEntries: [] },
  };
  const snapshot = structuredClone(runtime);

  const copy = createDurableRuntimeCopy(runtime, {
    sourceHouseholdId: runtime.meta.householdId,
    targetHouseholdId: 'hh-saved-copy',
  });

  assert.deepEqual(runtime, snapshot);
  assert.equal(copy.meta.householdId, 'hh-saved-copy');
  assert.equal(copy.meta.name, 'Pre-Retirement Solo copy');
  assert.equal(copy.meta.isDemo, false);
  assert.equal(copy.meta.isSelectableDefault, false);
  assert.equal(copy.meta.runtimeSourceHouseholdId, 'default-pre-retirement-solo');
  assert.notEqual(copy.netWorth, runtime.netWorth);
});

test('runtime copy refuses missing or reused identity', () => {
  const runtime = { meta: { householdId: 'demo', name: 'Demo Household' } };
  assert.throws(
    () => createDurableRuntimeCopy(runtime, {
      sourceHouseholdId: 'demo',
      targetHouseholdId: 'demo',
    }),
    /new household id/,
  );
});

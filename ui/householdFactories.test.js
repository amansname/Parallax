import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultPlan } from '../engine.js';
import { prepareHouseholdRecordForSave } from '../src/household/persistence.js';
import {
  SHIPPED_DEFAULT_HOUSEHOLD_IDS,
  createSelectableDefaultHouseholds,
} from './householdFactories.js';

test('selectable defaults are ordinary funded households with current production schemas', () => {
  const defaults = createSelectableDefaultHouseholds(defaultPlan, 2026);

  assert.deepEqual(
    defaults.map(household => household.meta.householdId),
    SHIPPED_DEFAULT_HOUSEHOLD_IDS,
  );
  assert.deepEqual(
    defaults.map(household => household.meta.name),
    ['Pre-Retirement Solo', 'Pre-Retirement Couple'],
  );
  for(const household of defaults){
    assert.equal(household.meta.isSelectableDefault, true);
    assert.doesNotMatch(household.meta.name, /basis|gain|loss/i);
    assert.deepEqual(
      new Set(household.portfolio.extraAccounts.map(account => account.bucket)),
      new Set(['taxable', 'traditional', 'roth']),
    );
    const brokerage = household.portfolio.extraAccounts.find(
      account => account.bucket === 'taxable',
    );
    assert.equal(brokerage.basis.status, 'unknown');
    assert.equal(brokerage.basis.amount, null);
    assert.doesNotThrow(() => prepareHouseholdRecordForSave(
      household,
      household.meta.householdId,
    ));
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultPlan } from '../engine.js';
import { buildCurrentAnnualFederalTaxBaseline } from '../src/household/buildWizardIncomeTaxSummary.js';
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
    ['Pre-Retirement Solo', 'Pre-Retirement Couple', 'Morgan Household'],
  );
  assert.deepEqual(
    defaults.map(household => household.incomeTax.current1040.incomeSourcesComplete),
    [true, true, true],
  );
  assert.deepEqual(
    defaults.map(household => {
      const baseline = buildCurrentAnnualFederalTaxBaseline(household);
      return [baseline.status, baseline.summary.federalTaxLiability];
    }),
    [['ready', 3_820], ['ready', 8_840], ['ready', 0]],
  );
  for(const [index, household] of defaults.entries()){
    assert.equal(household.meta.isSelectableDefault, true);
    assert.doesNotMatch(household.meta.name, /basis|gain|loss/i);
    assert.deepEqual(
      new Set(household.portfolio.extraAccounts.map(account => account.bucket)),
      new Set(['taxable', 'traditional', 'roth']),
    );
    const brokerage = household.portfolio.extraAccounts.find(
      account => account.bucket === 'taxable',
    );
    if(index < 2){
      assert.equal(brokerage.basis.status, 'unknown');
      assert.equal(brokerage.basis.amount, null);
    }
    assert.doesNotThrow(() => prepareHouseholdRecordForSave(
      household,
      household.meta.householdId,
    ));
  }
});

test('Morgan Household carries the requested plan-ready facts', () => {
  const household = createSelectableDefaultHouseholds(defaultPlan, 2026)
    .find(candidate => candidate.meta.householdId === 'default-retired-household');

  assert.equal(household.meta.name, 'Morgan Household');
  assert.equal(household.meta.primaryName, 'Alex Morgan');
  assert.equal(household.meta.spouseName, 'Jamie Morgan');
  assert.deepEqual(
    household.portfolio.extraAccounts.map(account => [account.typeId, account.owner, account.balance]),
    [
      ['joint_brokerage', 'joint', 1_200_000],
      ['rollover_ira', 'client', 1_400_000],
      ['roth_ira', 'spouse', 600_000],
    ],
  );
  assert.deepEqual(
    household.goals.map(goal => [goal.name, goal.amount, goal.endAge]),
    [['Essentials', 156_000, 999], ['Healthcare', 11_000, 999], ['Travel', 25_000, 75]],
  );
  assert.deepEqual(household.incomeTax.irmaa.lookbackByTaxYear, {
    2024: { magi: 110_000, filingStatus: 'marriedFilingJointly' },
    2025: { magi: 40_000, filingStatus: 'marriedFilingJointly' },
  });
  assert.deepEqual(
    household.income.other.map(source => [source.typeId, source.amount]),
    [['interest', 4_000], ['dividends', 15_000], ['long_term_capital_gain', 10_000]],
  );
  assert.equal(household.income.other[1].qualifiedPct, 1);
  assert.equal(household.incomeTax.current1040.incomeSourcesComplete, true);
  assert.doesNotThrow(() => prepareHouseholdRecordForSave(
    household,
    household.meta.householdId,
  ));
});

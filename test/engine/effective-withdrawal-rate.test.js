// Engine contract: annual draw pressure reflects the selected year's return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan, resolveInputs, runSinglePath } from '../../engine.js';
import { effectiveWithdrawalRate } from '../../src/projection/engine/withdrawalMetrics.js';
import { flatAssetReturnRow } from './fixtures.js';

test('effective withdrawal rate uses return-adjusted capital', () => {
  assert.equal(effectiveWithdrawalRate({
    withdrawal: 180_000,
    startBalance: 2_000_000,
    returnDollars: 400_000,
  }), 7.5);
  assert.equal(effectiveWithdrawalRate({
    withdrawal: 180_000,
    startBalance: 2_000_000,
    returnDollars: -400_000,
  }), 11.25);
});

test('single-path rows expose effective withdrawal rate without changing legacy wdRate', () => {
  const plan = structuredClone(defaultPlan);
  plan.meta = { ...plan.meta, spendingSchemaVersion: 1 };
  plan.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  plan.household.spouse = null;
  plan.portfolio.accounts = {
    taxable: { balance: 2_000_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  plan.goals = [{
    name: 'Annual spending',
    system: 'essentials',
    amount: 180_000,
    startAge: 65,
    endAge: 65,
    realGrowth: 0,
  }];
  plan.income.socialSecurity.primary = { pia: 0, claimAge: 67 };
  plan.taxes = { ordinary: 0, capitalGains: 0 };

  const inputs = resolveInputs(plan, {});
  const positiveRow = runSinglePath(inputs, [flatAssetReturnRow(2026, 0.2)]).rows[0];
  const negativeRow = runSinglePath(inputs, [flatAssetReturnRow(2026, -0.2)]).rows[0];

  assert.equal(positiveRow.withdrawal, 180_000);
  assert.equal(positiveRow.wdRate, 9);
  assert.equal(positiveRow.effectiveWdRate, 7.5);
  assert.equal(negativeRow.withdrawal, 180_000);
  assert.equal(negativeRow.wdRate, 9);
  assert.equal(negativeRow.effectiveWdRate, 11.25);

  const federallyFundedRow = runSinglePath(
    inputs,
    [flatAssetReturnRow(2026, 0.2)],
    {
      taxPolicy: (_row, { shortcutTax }) => shortcutTax,
      fundTaxPolicyDelta: true,
    },
  ).rows[0];
  assert.equal(federallyFundedRow.wdRate, 9);
  assert.equal(federallyFundedRow.effectiveWdRate, 7.5);
});

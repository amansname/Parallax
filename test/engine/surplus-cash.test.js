import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInputs, runSinglePath } from '../../engine.js';
import { currentAllocationPlan, flatAssetReturnRow, typedInvestmentAccount } from './fixtures.js';
import { snapshotPresetAllocation } from '../../src/household/investmentAllocation.js';
import { createFederalTaxResolver } from '../../src/planning/tax/createFederalTaxResolver.js';

function surplusPlan(){
  const plan = currentAllocationPlan();
  plan.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65, birthYear: 1961 };
  plan.household.spouse = null;
  plan.meta.planningAsOfYear = 2026;
  plan.portfolio.accounts.taxable.balance = 0;
  plan.portfolio.accounts.taxable.basisPct = 1;
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.accounts.roth.balance = 0;
  const brokerage = typedInvestmentAccount('brokerage_taxable', 'surplus-brokerage', 100_000, snapshotPresetAllocation('balanced'));
  brokerage.basis = {
    amount: 100_000, method: 'reported-cost-basis', status: 'confirmed',
    source: 'household-entry', confirmedAt: '2026-09-08T12:00:00Z', version: 1,
  };
  plan.portfolio.extraAccounts = [brokerage];
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  plan.income.other = [{ label: 'Retirement income', amount: 100_000, startAge: 65, endAge: 65, taxablePct: 1 }];
  plan.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  plan.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, extra: [] };
  plan.goals = [{ id: 'essentials', system: 'essentials', amount: 50_000, startAge: 65, endAge: 65 }];
  plan.properties = [];
  plan.liabilities = [];
  plan.ltc = { amount: 0, onsetAge: 99 };
  return plan;
}

function project(ordinary, { returnRate = 0, overrides = {}, finalTax = 10_000 } = {}){
  const params = resolveInputs(surplusPlan(), {});
  assert.equal(params.accounts.taxable.basis, 100_000);
  params.taxRates = { ...params.taxRates, ordinary };
  Object.assign(params, overrides);
  return runSinglePath(params, [flatAssetReturnRow(2026, returnRate)], {
    taxPolicy: () => finalTax,
    fundTaxPolicyDelta: true,
  }).rows[0];
}

test('F01: identical final cash flows produce identical wealth regardless of preliminary tax rate', () => {
  for(const ordinary of [0, 0.1, 0.22, 0.4, 0.6]){
    const row = project(ordinary);
    assert.equal(row.taxes, 10_000);
    assert.equal(row.withdrawal, 0);
    assert.equal(row.netCashflow, 40_000);
    assert.ok(Math.abs(row.balance - 140_000) < 0.01, `shortcut rate ${ordinary}: ${row.balance}`);
    assert.ok(Math.abs(row.taxableEndingBasis - 140_000) < 0.01);
    assert.ok(Math.abs(row.taxFundingConvergence.taxSavingsReinvested - 40_000) < 0.01);
    assert.equal(row.taxableCapitalGain, 0);
  }
});

test('F01: the production federal resolver reconciles actual surplus independently of shortcut estimates', () => {
  const results = [0, 0.1, 0.22, 0.4, 0.6].map(ordinary => {
    const params = resolveInputs(surplusPlan(), {});
    params.taxRates = { ...params.taxRates, ordinary };
    const row = runSinglePath(params, [flatAssetReturnRow(2026)], {
      taxPolicy: createFederalTaxResolver(params, { baseTaxYear: 2026, filingStatus: 'single' }),
      fundTaxPolicyDelta: true,
    }).rows[0];
    assert.equal(row.withdrawal, 0);
    assert.ok(row.taxes > 0 && row.netCashflow > 0);
    assert.ok(Math.abs(row.balance - (row.startBalance + row.netCashflow)) < 0.01);
    assert.ok(Math.abs(row.taxableEndingBasis - row.balance) < 0.01);
    return { taxes: row.taxes, cash: row.netCashflow, balance: row.balance };
  });
  for(const result of results) assert.deepEqual(result, results[0]);
});

test('F01: return and one-time outlay reconcile without counting asset-sale cash twice', () => {
  const row = project(0.1, {
    returnRate: 0.05,
    overrides: { lumpSum: 10_000, lumpSumYear: 0, assetSale: { age: 65, netProceeds: 20_000 } },
  });
  assert.equal(row.startBalance, 120_000, 'sale proceeds enter the opening portfolio once');
  assert.equal(row.assetSale, 20_000);
  assert.equal(row.lumpSum, 10_000);
  assert.ok(Math.abs(row.balance - 156_000) < 0.01, '120,000 opening + 6,000 return + 30,000 surplus');
  assert.ok(Math.abs(row.taxableEndingBasis - 150_000) < 0.01);
});

test('F01: zero surplus and a funding deficit retain the existing cash-flow identity', () => {
  for(const finalTax of [50_000, 60_000]){
    const row = project(0.1, { finalTax });
    assert.ok(Math.abs(row.withdrawal - (finalTax - 50_000)) < 0.01);
    assert.ok(Math.abs(row.balance - (150_000 - finalTax)) < 0.01);
    assert.equal(row.taxFundingConvergence.taxSavingsReinvested, 0);
  }
});

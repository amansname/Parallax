import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInputs, runSinglePath } from '../../engine.js';
import { addFamilyFinanceEntry } from '../../src/household/familyFinanceEntries.js';
import { snapshotPresetAllocation } from '../../src/household/investmentAllocation.js';
import { currentAllocationPlan, flatAssetReturnRow, typedInvestmentAccount } from './fixtures.js';
import { createFederalTaxResolver } from '../../src/planning/tax/createFederalTaxResolver.js';
import { buildHistoricalCashFlowResult } from '../../src/scenarios/buildHistoricalCashFlowResult.js';
import { migrateHouseholdRecordSchema } from '../../src/household/householdRecordSchema.js';
import { prepareHouseholdRecordForSave } from '../../src/household/persistence.js';
import { scenarioRunFailureMessage } from '../../src/scenarios/projectionMessages.js';
import { createBlankTaxProfiles } from '../../src/household/factEnvelope.js';

function staggeredPlan(){
  const plan = currentAllocationPlan();
  plan.meta.planningAsOfYear = 2026;
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.household.primary = { currentAge: 50, retirementAge: 65, planEndAge: 70, birthYear: 1976 };
  plan.household.spouse = { currentAge: 60, retirementAge: 65, planEndAge: 80, birthYear: 1966 };
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: { pia: 0, claimAge: 67 } };
  plan.income.other = [];
  plan.goals = [];
  plan.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, extra: [] };
  plan.properties = [];
  plan.liabilities = [];
  plan.ltc = { amount: 0, onsetAge: 99 };
  for(const account of Object.values(plan.portfolio.accounts)) account.balance = 0;
  plan.portfolio.extraAccounts = ['client', 'spouse'].map(owner => ({
    ...typedInvestmentAccount('401k', `${owner}-401k`, 100_000, snapshotPresetAllocation('balanced')),
    owner,
  }));
  plan.savings = { annual: 0 };
  for(const owner of ['client', 'spouse']){
    addFamilyFinanceEntry(plan, { mode: 'savings', typeId: '401k', owner, amount: 20_000 });
  }
  return plan;
}

function project(plan, overrides = {}){
  // Exercise the persisted shape without mutating the Family inputs.
  const saved = JSON.stringify(plan);
  const params = resolveInputs(JSON.parse(saved), overrides);
  const result = runSinglePath(params, Array.from(
    { length: params.horizonYears }, (_, index) => flatAssetReturnRow(2026 + index),
  ));
  assert.equal(JSON.stringify(plan), saved);
  return result;
}

test('F02: a retired spouse receives no unsupported contributions during ten more working years', () => {
  const result = project(staggeredPlan());
  const workingRows = result.rows.filter(row => row.phase === 'accum');
  assert.equal(workingRows.length, 15);
  assert.equal(workingRows.filter(row => row.people.spouse.retired).length, 10);
  for(const row of workingRows){
    const spouseContribution = row.people.spouse.age < 65 ? 20_000 : 0;
    assert.equal(row.accountContributionsById['client-401k'], 20_000);
    assert.equal(row.accountContributionsById['spouse-401k'], spouseContribution);
    assert.equal(row.savings, 20_000 + spouseContribution);
    assert.equal(row.balance - row.startBalance, row.savings);
  }
  assert.equal(workingRows.at(-1).accountBalancesById['client-401k'], 400_000);
  assert.equal(workingRows.at(-1).accountBalancesById['spouse-401k'], 200_000);
});

test('F02: primary retirement stops primary contributions while the spouse keeps saving', () => {
  const plan = staggeredPlan();
  plan.household.primary.retirementAge = 52;
  const rows = project(plan).rows.filter(row => row.phase === 'accum');
  assert.equal(rows.length, 5);
  for(const row of rows){
    assert.equal(row.accountContributionsById['client-401k'], row.age < 52 ? 20_000 : 0);
    assert.equal(row.accountContributionsById['spouse-401k'], 20_000);
    assert.equal(row.balance - row.startBalance, row.savings);
  }
});

test('F02: already-retired contributors stop immediately and scenario scaling does not reallocate their savings', () => {
  const plan = staggeredPlan();
  plan.household.spouse.retirementAge = 60;
  const first = project(plan, { savingsAnnual: 60_000 }).rows[0];
  assert.equal(first.accountContributionsById['client-401k'], 30_000);
  assert.equal(first.accountContributionsById['spouse-401k'], 0);
  assert.equal(first.savings, 30_000);
  assert.equal(first.balance, 230_000);

  // Missing ownership is unresolved input, not evidence that somebody retired.
  const missingOwner = migrateHouseholdRecordSchema(staggeredPlan(), 'missing-owner').plan;
  missingOwner.household.spouse = null;
  missingOwner.income.socialSecurity.spouse = null;
  missingOwner.meta.filingStatus = 'single';
  missingOwner.taxProfiles = createBlankTaxProfiles();
  missingOwner.portfolio.extraAccounts = missingOwner.portfolio.extraAccounts.filter(account => account.owner === 'client');
  for(const currentAge of [50, 65, 66]){
    missingOwner.household.primary.currentAge = currentAge;
    missingOwner.household.primary.birthYear = 2026 - currentAge;
    const saved = prepareHouseholdRecordForSave(missingOwner, 'missing-owner');
    assert.throws(() => project(saved), error => (
      error.code === 'SAVINGS_OWNER_TIMELINE_UNAVAILABLE'
        && /Family/.test(scenarioRunFailureMessage(error))
    ), `Missing savings owners must fail before, at and after retirement (age ${currentAge})`);
  }
});

test('F02: scenario retirement delay moves both contribution cutoffs on the person timeline', () => {
  const rows = project(staggeredPlan(), { retireDelay: 2 }).rows.filter(row => row.phase === 'accum');
  assert.equal(rows.length, 17);
  for(const row of rows){
    assert.equal(row.accountContributionsById['client-401k'], 20_000);
    assert.equal(row.accountContributionsById['spouse-401k'], row.people.spouse.age < 67 ? 20_000 : 0);
  }
});

test('F02: simultaneous retirement preserves existing contributions and balances', () => {
  const plan = staggeredPlan();
  plan.household.primary.retirementAge = 55;
  const rows = project(plan).rows.filter(row => row.phase === 'accum');
  assert.equal(rows.length, 5);
  for(const row of rows){
    assert.equal(row.savings, 40_000);
    assert.equal(row.accountContributionsById['client-401k'], 20_000);
    assert.equal(row.accountContributionsById['spouse-401k'], 20_000);
  }
  assert.equal(rows.at(-1).balance, 400_000);
});

test('F02: savings cutoffs also apply to Roth and taxable entries without restoring stopped amounts', () => {
  const plan = staggeredPlan();
  plan.household.spouse.retirementAge = 60;
  for(const typeId of ['roth_401k', 'brokerage_taxable']){
    plan.portfolio.extraAccounts.push({
      ...typedInvestmentAccount(typeId, `spouse-${typeId}`, 100_000, snapshotPresetAllocation('balanced')),
      owner: 'spouse',
    });
    addFamilyFinanceEntry(plan, { mode: 'savings', typeId, owner: 'spouse', amount: 10_000 });
  }
  const first = project(plan).rows[0];
  // Normalized thirds introduce machine-precision residue across tax sleeves.
  assert.ok(Math.abs(first.accountContributionsById['spouse-roth_401k']) < 1e-8);
  assert.ok(Math.abs(first.accountContributionsById['spouse-brokerage_taxable']) < 1e-8);
  assert.ok(Math.abs(first.savings - 20_000) < 1e-8);
  assert.equal(first.balance, 420_000);
});

test('F02: corrected account balances reach federal-funded and historical retirement paths', () => {
  const plan = staggeredPlan();
  const params = resolveInputs(plan, {});
  const simulation = runSinglePath(params, Array.from(
    { length: params.horizonYears }, (_, index) => flatAssetReturnRow(2026 + index),
  ), {
    taxPolicy: createFederalTaxResolver(params, { baseTaxYear: 2026, filingStatus: plan.meta.filingStatus }),
    fundTaxPolicyDelta: true,
  });
  const lastWorking = simulation.rows.filter(row => row.phase === 'accum').at(-1);
  assert.equal(lastWorking.balance, 600_000);
  assert.equal(lastWorking.accountBalancesById['spouse-401k'], 200_000);
  const historical = buildHistoricalCashFlowResult({
    plan, analysis: {}, accumulationSimulation: simulation, periodId: 'historical-1937',
  });
  const firstRetirement = historical.rows.find(row => row.phase !== 'accum');
  assert.equal(firstRetirement.startBalance, 600_000);
  assert.equal(firstRetirement.accountStartingBalances.traditional, 600_000);
  assert.equal(historical.rows.find(row => row.age === 64).accountBalancesById['spouse-401k'], 200_000);
});

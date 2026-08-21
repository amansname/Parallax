import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs, runSimulation } from '../../engine.js';
import { createAccount } from '../household/createAccount.js';
import {
  buildHistoricalCashFlowResult,
  createHistoricalCashFlowCache,
} from './buildHistoricalCashFlowResult.js';

function fixture({ taxableBalance = 50_000, annualNeed = 100_000 } = {}){
  const plan = structuredClone(defaultPlan);
  plan.meta = {
    ...plan.meta,
    filingStatus: 'single',
    planningAsOfYear: 2026,
    spendingSchemaVersion: 1,
  };
  plan.household.primary = { currentAge: 64, retirementAge: 66, planEndAge: 70 };
  plan.household.spouse = null;
  plan.portfolio.accounts = {
    taxable: { balance: taxableBalance, basisPct: 0.5 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  plan.portfolio.extraAccounts = [];
  plan.savings = { ...plan.savings, annual: 0 };
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  plan.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  plan.income.other = [];
  plan.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  plan.goals = [{ name: 'Living needs', amount: annualNeed, startAge: 66, endAge: 70 }];
  plan.liabilities = [];
  plan.properties = [];
  plan.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(plan, {});
  const returnPath = Array.from({ length: params.horizonYears }, (_, index) => ({
    y: 1995 + index,
    proxyReturn: 0,
  }));
  const analysis = runSimulation(plan, {}, [returnPath]);
  return { plan, analysis };
}

function spouseRolloverFixture(){
  const plan = structuredClone(defaultPlan);
  plan.meta = {
    ...plan.meta,
    filingStatus: 'marriedFilingJointly',
    planningAsOfYear: 2026,
    spendingSchemaVersion: 1,
  };
  plan.household.primary = {
    currentAge: 72, retirementAge: 75, planEndAge: 80, birthYear: 1954,
  };
  plan.household.spouse = {
    currentAge: 60, retirementAge: 60, planEndAge: 60, birthYear: 1966,
  };
  plan.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const spouseIra = createAccount('traditional_ira', {
    balance: 265_000,
    owner: 'spouse',
  });
  spouseIra.id = 'spouse-only-ira';
  plan.portfolio.extraAccounts = [spouseIra];
  plan.savings = { ...plan.savings, annual: 0 };
  plan.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  plan.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  plan.income.other = [];
  plan.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  plan.goals = [];
  plan.liabilities = [];
  plan.properties = [];
  plan.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(plan, {});
  const returnPath = Array.from({ length: params.horizonYears }, (_, index) => ({
    y: 1995 + index,
    proxyReturn: 0,
  }));
  const analysis = runSimulation(plan, {}, [returnPath]);
  return { plan, analysis };
}

test('historical Cash Flow stops at and reports the first underfunded retirement year', () => {
  const { plan, analysis } = fixture();
  const result = buildHistoricalCashFlowResult({
    analysis,
    plan,
    periodId: 'historical-1973',
    scenarioId: 'continuity_test',
  });
  const lastAccumulation = result.rows[1];
  const firstRetirement = result.rows[2];

  assert.deepEqual(result.rows.map(row => row.age), [64, 65, 66]);
  assert.deepEqual(result.rows.map(row => row.year), [1, 2, 3]);
  assert.equal(firstRetirement.source, 1973);
  assert.deepEqual(firstRetirement.accountStartingBalances, lastAccumulation.accountBalances);
  assert.equal(firstRetirement.taxableStartingBasis, lastAccumulation.taxableEndingBasis);
  assert.equal(result.rows.slice(2).every(row => row.source !== null), true);
  assert.equal(result.summary.outcome, 'underfunded');
  assert.equal(result.summary.failed, true);
  assert.equal(result.summary.firstUnderfundedAge, 66);
  assert.equal(result.summary.firstUnderfundedYear, 2028);
  assert.equal(result.summary.fundedThroughAge, null);
  assert.equal(result.summary.fundedThroughYear, null);
  assert.equal(result.summary.endingBalance, null);
  assert.equal(result.summary.endingAge, null);
  assert.equal(result.summary.peakWdRate, firstRetirement.wdRate);
  assert.equal(result.summary.peakWdAge, firstRetirement.age);
  assert.equal(result.summary.peakWdYear, 2028);
  assert.equal('totalModeledShortfall' in result.summary, false);
  assert.equal(result.taxScope, 'MODELED_FEDERAL_LINE_24');
});

test('surviving historical Cash Flow reports plan end and peak withdrawal from the same rows', () => {
  const { plan, analysis } = fixture({
    taxableBalance: 500_000,
    annualNeed: 10_000,
  });
  const result = buildHistoricalCashFlowResult({
    analysis,
    plan,
    periodId: 'historical-1973',
    scenarioId: 'survivor_test',
  });
  const retirementRows = result.rows.slice(2);
  const endingRow = retirementRows.at(-1);
  const peakRow = retirementRows.reduce(
    (peak, row) => row.wdRate > (peak?.wdRate ?? 0) ? row : peak,
    null
  );

  assert.equal(result.summary.outcome, 'survives');
  assert.equal(result.summary.failed, false);
  assert.equal(result.summary.firstUnderfundedAge, null);
  assert.equal(result.summary.firstUnderfundedYear, null);
  assert.equal(result.summary.fundedThroughAge, endingRow.age);
  assert.equal(result.summary.fundedThroughYear, 2032);
  assert.equal(result.summary.endingBalance, endingRow.balance);
  assert.equal(result.summary.endingAge, endingRow.age);
  assert.equal(result.summary.endingYear, 2032);
  assert.equal(result.summary.peakWdRate, peakRow.wdRate);
  assert.equal(result.summary.peakWdAge, peakRow.age);
  assert.equal(result.summary.peakWdYear, 2026 + (peakRow.age - 64));
  assert.equal(retirementRows.some(row => row.fundingShortfall > 0.01), false);
});

test('approved boundary periods execute with an authoritative outcome boundary', () => {
  const { plan, analysis } = fixture({
    taxableBalance: 500_000,
    annualNeed: 10_000,
  });

  for(const [periodId, startYear] of [
    ['historical-1937', 1937],
    ['historical-2022', 2022],
  ]){
    const result = buildHistoricalCashFlowResult({
      analysis,
      plan,
      periodId,
      scenarioId: `boundary_${startYear}`,
    });
    const retirementRows = result.rows.slice(result.accumulationYears);
    assert.equal(retirementRows[0].source, startYear);
    assert.match(result.summary.outcome, /^(underfunded|survives)$/);
    if(result.summary.outcome === 'underfunded'){
      const boundary = retirementRows.at(-1);
      assert.ok(boundary.fundingShortfall > 0.01);
      assert.equal(result.summary.firstUnderfundedAge, boundary.age);
      assert.equal(result.summary.firstUnderfundedYear, 2026 + (boundary.age - 64));
    }else{
      const ending = retirementRows.at(-1);
      assert.equal(retirementRows.some(row => row.fundingShortfall > 0.01), false);
      assert.equal(result.summary.endingBalance, ending.balance);
      assert.equal(result.summary.endingAge, ending.age);
    }
  }
});

test('a spouse-only IRA rollover keeps its exact owner and first historical RMD contract', () => {
  const { plan, analysis } = spouseRolloverFixture();
  const result = buildHistoricalCashFlowResult({
    analysis,
    plan,
    periodId: 'historical-1937',
    scenarioId: 'spouse_rollover_handoff',
  });
  const lastAccumulation = result.rows[result.accumulationYears - 1];
  const firstRetirement = result.rows[result.accumulationYears];

  assert.ok(lastAccumulation.traditionalEndingBalancesByOwner.client > 0);
  assert.equal(lastAccumulation.traditionalEndingBalancesByOwner.spouse, 0);
  assert.equal(lastAccumulation.traditionalEndingBalancesByOwner.unattributed, 0);
  assert.equal(
    Object.values(lastAccumulation.traditionalEndingBalancesByOwner)
      .reduce((sum, balance) => sum + balance, 0),
    lastAccumulation.accountBalances.traditional
  );
  assert.equal(
    firstRetirement.accountStartingBalances.traditional,
    lastAccumulation.accountBalances.traditional
  );
  assert.equal(firstRetirement.rmdOwner, 'client');
  assert.equal(firstRetirement.rmdAvailable, true);
  assert.ok(firstRetirement.rmdRequired > 0);
});

test('historical Cash Flow cache reuses period switches and invalidates with a new scenario result', () => {
  const { plan, analysis } = fixture();
  const cache = createHistoricalCashFlowCache();
  const args = { analysis, plan, periodId: 'historical-1973' };
  const first = cache.get(args);

  assert.equal(cache.get(args), first);
  assert.notEqual(
    cache.get({ ...args, scenarioId: 'different_cache_input' }),
    first,
    'a changed accepted input must not reuse the prior cached result'
  );
  assert.notEqual(
    cache.get({ ...args, taxOptions: { baseTaxYear: 2026 } }),
    first,
    'tax options participate in cache invalidation'
  );
  assert.notEqual(
    cache.get({ ...args, periodId: 'historical-2008' }),
    first,
    'each selected period owns a separate derived result'
  );

  const nextAnalysis = { ...analysis };
  assert.notEqual(
    cache.get({ ...args, analysis: nextAnalysis }),
    first,
    'a scenario rerun replaces the analysis identity and invalidates the cache'
  );
});

test('historical retirement taxes stay independent of current-return 1040 completeness', () => {
  const { plan, analysis } = fixture();
  const incomplete = structuredClone(plan);
  const completed = structuredClone(plan);
  incomplete.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: false,
    income: {},
  };
  completed.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    income: { wages: 1_000_000 },
  };

  const first = buildHistoricalCashFlowResult({
    analysis,
    plan: incomplete,
    periodId: 'historical-1973',
    scenarioId: 'current_1040_independence',
  });
  const second = buildHistoricalCashFlowResult({
    analysis,
    plan: completed,
    periodId: 'historical-1973',
    scenarioId: 'current_1040_independence',
  });
  const retirementFacts = result => result.rows
    .filter(row => row.phase !== 'accum')
    .map(row => ({
      taxes: row.taxes,
      withdrawal: row.withdrawal,
      balance: row.balance,
      fundingShortfall: row.fundingShortfall,
    }));

  assert.deepEqual(retirementFacts(first), retirementFacts(second));
  assert.deepEqual(first.summary, second.summary);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs, runSimulation } from '../../engine.js';
import { flatAssetReturnRow } from '../../test/fixtures/assetReturnRows.js';
import { createAccount } from '../household/createAccount.js';
import { ACCOUNT_SCHEMA_VERSION } from '../household/accountTypes.js';
import {
  ASSET_ALLOCATION_PRESETS,
  resolveCashOnlyAllocation,
  snapshotLegacyRiskProfileAllocation,
  snapshotPresetAllocation,
} from '../household/investmentAllocation.js';
import { applyScenarioPlanInputs } from './scenarioPlanInputs.js';
import { HISTORICAL_PERIODS } from './historicalPeriods.js';
import {
  buildHistoricalCashFlowResult,
  createHistoricalCashFlowCache,
} from './buildHistoricalCashFlowResult.js';
import {
  buildRetirementEntryPlan,
  deriveRetirementEntryAccounts,
} from './buildRetirementEntryPlan.js';

function fixture({ taxableBalance = 50_000, annualNeed = 100_000, planEndAge = 70 } = {}){
  const plan = structuredClone(defaultPlan);
  plan.meta = {
    ...plan.meta,
    filingStatus: 'single',
    planningAsOfYear: 2026,
    spendingSchemaVersion: 1,
  };
  plan.household.primary = { currentAge: 64, retirementAge: 66, planEndAge };
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
  plan.goals = [{ name: 'Living needs', amount: annualNeed, startAge: 66, endAge: planEndAge }];
  plan.liabilities = [];
  plan.properties = [];
  plan.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(plan, {});
  const returnPath = Array.from(
    { length: params.horizonYears },
    (_, index) => flatAssetReturnRow(1995 + index),
  );
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
  const returnPath = Array.from(
    { length: params.horizonYears },
    (_, index) => flatAssetReturnRow(1995 + index),
  );
  const analysis = runSimulation(plan, {}, [returnPath]);
  return { plan, analysis };
}

function currentAccountScenarioFixture(allocationPresetId = 'defensive'){
  const plan = structuredClone(defaultPlan);
  plan.meta = {
    ...plan.meta,
    accountSchemaVersion: ACCOUNT_SCHEMA_VERSION,
    filingStatus: 'single',
    planningAsOfYear: 2026,
    spendingSchemaVersion: 1,
  };
  plan.household.primary = { currentAge: 64, retirementAge: 66, planEndAge: 72 };
  plan.household.spouse = null;
  const legacyAllocation = snapshotLegacyRiskProfileAllocation(3);
  plan.portfolio.accounts = {
    taxable: { id: 'base-taxable', balance: 0, basisPct: 1, investmentAllocation: legacyAllocation },
    traditional: { id: 'base-traditional', balance: 0, investmentAllocation: legacyAllocation },
    roth: { id: 'base-roth', balance: 0, investmentAllocation: legacyAllocation },
  };
  const brokerage = createAccount('brokerage_taxable', {
    balance: 300_000,
    owner: 'client',
    investmentAllocation: snapshotPresetAllocation('balanced'),
  });
  brokerage.id = 'client-brokerage';
  brokerage.basis = { ...brokerage.basis, amount: 180_000 };
  const traditional = createAccount('traditional_ira', {
    balance: 400_000,
    owner: 'client',
    investmentAllocation: snapshotPresetAllocation('balanced'),
  });
  traditional.id = 'client-ira';
  const roth = createAccount('roth_ira', {
    balance: 200_000,
    owner: 'client',
    investmentAllocation: snapshotPresetAllocation('balanced'),
  });
  roth.id = 'client-roth';
  const checking = createAccount('checking', {
    balance: 25_000,
    owner: 'client',
  });
  checking.id = 'client-checking';
  plan.portfolio.extraAccounts = [brokerage, traditional, roth, checking];
  plan.savings = { ...plan.savings, annual: 0 };
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
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
  return applyScenarioPlanInputs(plan, {
    retireAge: 66,
    ssAge: 70,
    allocationPresetId,
  });
}

test('current-schema account identities and scenario allocation survive the historical handoff', () => {
  const plan = currentAccountScenarioFixture();
  const params = resolveInputs(plan, {});
  const returnPath = Array.from(
    { length: params.horizonYears },
    (_, index) => flatAssetReturnRow(1995 + index),
  );
  const analysis = runSimulation(plan, {}, [returnPath]);

  const result = buildHistoricalCashFlowResult({
    analysis,
    plan,
    periodId: 'historical-1929',
    scenarioId: 'current_account_handoff',
  });
  const lastAccumulation = result.rows[result.accumulationYears - 1];
  const firstRetirement = result.rows[result.accumulationYears];
  const expectedIds = [
    'base-taxable',
    'base-traditional',
    'base-roth',
    'client-brokerage',
    'client-ira',
    'client-roth',
    'client-checking',
  ];

  assert.deepEqual(Object.keys(lastAccumulation.accountBalancesById).sort(), expectedIds.sort());
  assert.deepEqual(Object.keys(firstRetirement.accountReturns).sort(), expectedIds.sort());
  assert.equal(firstRetirement.taxableStartingBasis, lastAccumulation.taxableEndingBasis);
  for(const id of expectedIds.filter(id => id !== 'client-checking')){
    assert.deepEqual(
      firstRetirement.accountReturns[id].requestedWeights,
      snapshotPresetAllocation('defensive').weights,
    );
  }
  assert.deepEqual(
    firstRetirement.accountReturns['client-checking'].requestedWeights,
    resolveCashOnlyAllocation().weights,
  );
});

test('every allocation preset remains authoritative across Typical and all Historical paths', () => {
  for(const preset of ASSET_ALLOCATION_PRESETS){
    const plan = currentAccountScenarioFixture(preset.id);
    const params = resolveInputs(plan, {});
    const returnPath = Array.from(
      { length: params.horizonYears },
      (_, index) => flatAssetReturnRow(1995 + index),
    );
    const analysis = runSimulation(plan, {}, [returnPath]);
    const accumulationYears = params.retirementAge - params.currentAge;
    const typicalRetirement = analysis.paths.p50.rows[accumulationYears];
    const expectedInvestmentIds = [
      'base-taxable',
      'base-traditional',
      'base-roth',
      'client-brokerage',
      'client-ira',
      'client-roth',
    ];
    for(const id of expectedInvestmentIds){
      assert.deepEqual(
        typicalRetirement.accountReturns[id].requestedWeights,
        snapshotPresetAllocation(preset.id).weights,
        `Typical ${preset.id} allocation for ${id}`,
      );
    }
    assert.deepEqual(
      typicalRetirement.accountReturns['client-checking'].requestedWeights,
      resolveCashOnlyAllocation().weights,
      `Typical ${preset.id} cash allocation`,
    );

    const sequencingEntry = deriveRetirementEntryAccounts(
      analysis,
      accumulationYears,
      params.accounts,
      params.projectionAccounts,
    );
    const sequencingPlan = buildRetirementEntryPlan(plan, {
      entryAccounts: sequencingEntry,
      currentAge: params.currentAge,
      retirementAge: params.retirementAge,
    });
    const sequencingInputs = resolveInputs(sequencingPlan, {});
    const sequencingById = new Map(
      sequencingInputs.projectionAccounts.map(accountRecord => [accountRecord.id, accountRecord]),
    );
    assert.deepEqual([...sequencingById.keys()].sort(), [
      ...expectedInvestmentIds,
      'client-checking',
    ].sort());
    for(const id of expectedInvestmentIds){
      assert.deepEqual(
        sequencingById.get(id).investmentAllocation.weights,
        snapshotPresetAllocation(preset.id).weights,
        `Sequencing ${preset.id} allocation for ${id}`,
      );
    }
    assert.deepEqual(
      sequencingById.get('client-checking').investmentAllocation.weights,
      resolveCashOnlyAllocation().weights,
      `Sequencing ${preset.id} cash allocation`,
    );
    assert.ok(Math.abs(
      sequencingInputs.projectionAccounts.reduce((sum, accountRecord) => sum + accountRecord.balance, 0)
        - analysis.envelope[accumulationYears].p50
    ) <= 0.01, `Sequencing ${preset.id} balance must match the p50 entry envelope`);

    for(const period of HISTORICAL_PERIODS){
      const result = buildHistoricalCashFlowResult({
        analysis,
        plan,
        periodId: period.id,
        scenarioId: `allocation_matrix_${preset.id}_${period.startYear}`,
      });
      const firstRetirement = result.rows[result.accumulationYears];
      for(const id of expectedInvestmentIds){
        assert.deepEqual(
          firstRetirement.accountReturns[id].requestedWeights,
          snapshotPresetAllocation(preset.id).weights,
          `${period.id} ${preset.id} allocation for ${id}`,
        );
      }
      assert.deepEqual(
        firstRetirement.accountReturns['client-checking'].requestedWeights,
        resolveCashOnlyAllocation().weights,
        `${period.id} ${preset.id} cash allocation`,
      );
    }
  }
});

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
  assert.equal(result.digest.maxRealDrawdownPct, 100);
  assert.equal(result.digest.maxRealDrawdownTroughAge, 66);
  assert.equal(result.digest.portfolioRecoveryPeriodStatus, 'never');
  assert.equal(result.digest.portfolioRecoveryPeriodYears, null);
  assert.equal(result.digest.realBalanceAtAge80, null);
  assert.equal(result.digest.fundedThroughAge, 65);
  assert.equal(result.digest.planEndAge, 70);
  assert.equal(result.digest.fundingMarginYears, -5);
  assert.equal(result.digest.fundingMarginKind, 'years-short');
  assert.equal(Object.isFrozen(result.digest), true);
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
  assert.equal(result.digest.fundedThroughAge, 70);
  assert.equal(result.digest.planEndAge, 70);
  assert.ok(result.digest.fundingMarginYears > 0);
  assert.equal(result.digest.fundingMarginKind, 'zero-return-runway');
});

test('historical Cash Flow digest binds age-80 balance to the exact selected-path row', () => {
  const { plan, analysis } = fixture({
    taxableBalance: 2_000_000,
    annualNeed: 40_000,
    planEndAge: 85,
  });
  const result = buildHistoricalCashFlowResult({
    analysis,
    plan,
    periodId: 'historical-1973',
    scenarioId: 'age_80_metric_test',
  });
  const age80 = result.rows.find(row => row.age === 80);

  assert.ok(age80);
  assert.equal(age80.source, 1987);
  assert.equal(result.digest.realBalanceAtAge80, age80.balance);
  assert.equal(result.digest.maxRealDrawdownTroughAge >= 66, true);
  assert.equal(result.digest.planEndAge, 85);
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
  assert.equal(cache.peek(args), first);
  assert.equal(
    cache.peek({ ...args, scenarioId: 'different_cache_input' }),
    null,
    'a read-only peek must enforce the complete accepted-input identity'
  );
  assert.equal(
    cache.peek({ ...args, periodId: 'historical-2008' }),
    null,
    'an uncalculated period has no known outcome'
  );
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

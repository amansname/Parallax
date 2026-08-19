import { test } from 'node:test';
import assert from 'node:assert';
import { defaultPlan, runSimulation } from '../../../engine.js';
import { createAccount } from '../../household/createAccount.js';
import { promoteTaxFundedProbability } from '../../scenarios/promoteTaxFundedProbability.js';
import { rerunMonteCarloWithFederalTax } from './rerunMonteCarloWithFederalTax.js';
import {
  runFederalFundingSimulation,
  runMonteCarloWithFederalFunding,
} from './runMonteCarloWithFederalFunding.js';

function controlledFixture(){
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'single';
  plan.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  plan.household.spouse = null;
  plan.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 400000 },
    roth: { balance: 0 },
  };
  plan.portfolio.extraAccounts = [];
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  plan.income.other = [];
  plan.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  plan.expenses = {
    living: 300000,
    housing: 0,
    debt: 0,
    healthcare: 0,
    healthcareRealGrowth: 0,
    extra: [],
  };
  plan.liabilities = [];
  plan.properties = [];
  plan.goals = [];
  plan.ltc = { amount: 0, onsetAge: 85 };
  plan.simulation.iterations = 40;

  const returnPaths = Array.from(
    { length: 40 },
    () => [{ y: 2025, proxyReturn: 0 }]
  );
  return { plan, returnPaths };
}

function shortcutSnapshot(analysis){
  return {
    successRate: analysis.successRate,
    survived: analysis.survived,
    total: analysis.total,
    terminal: analysis.terminal,
    envelope: analysis.envelope,
    medianCagr: analysis.medianCagr,
    medianLifetimeTax: analysis.medianLifetimeTax,
    metrics: analysis.metrics,
  };
}

function projectedIncomeFixture(){
  const { plan } = controlledFixture();
  plan.household.primary = {
    currentAge: 60,
    retirementAge: 65,
    planEndAge: 65,
    employmentStatus: 'employed',
  };
  plan.income.other = [{
    id: 'planned-wages',
    typeId: 'wages',
    owner: 'client',
    amount: 75_000,
    startAge: 60,
    endAge: 64,
    realGrowth: 0,
    taxablePct: 1,
  }];
  const horizon = 6;
  const returnPaths = Array.from(
    { length: 40 },
    () => Array.from({ length: horizon }, (_, index) => ({
      y: 2026 + index,
      proxyReturn: 0,
    }))
  );
  return { plan, returnPaths };
}

function taxableWithdrawalFixture(basis = null){
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'single';
  plan.meta.planningAsOfYear = 2026;
  plan.household.primary = {
    currentAge: 65,
    retirementAge: 65,
    planEndAge: 65,
    employmentStatus: 'retired',
  };
  plan.household.spouse = null;
  plan.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const brokerage = createAccount('brokerage_taxable', {
    owner: 'client',
    balance: 200_000,
  });
  brokerage.id = 'actual-taxable-pool';
  if(basis) brokerage.basis = basis;
  plan.portfolio.extraAccounts = [brokerage];
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  plan.income.other = [];
  plan.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  plan.expenses = {
    living: 196_000,
    housing: 0,
    debt: 0,
    healthcare: 0,
    healthcareRealGrowth: 0,
    extra: [],
  };
  plan.liabilities = [];
  plan.properties = [];
  plan.goals = [];
  plan.ltc = { amount: 0, onsetAge: 85 };
  plan.simulation.iterations = 1;
  return {
    plan,
    returnPaths: [[{ y: 2026, proxyReturn: 0 }]],
  };
}

test('returns one coherent federally funded Monte Carlo analysis', () => {
  const { plan, returnPaths } = controlledFixture();
  const shortcutAnalysis = runSimulation(plan, {}, returnPaths);
  const result = runMonteCarloWithFederalFunding(shortcutAnalysis, plan, {}, {
    filingStatus: 'single',
    baseTaxYear: 2025,
    scenarioId: 't8_federal_success_rate_test',
  });

  assert.notDeepStrictEqual(shortcutSnapshot(result), shortcutSnapshot(shortcutAnalysis));
  assert.strictEqual(shortcutAnalysis.successRate, 100,
    'controlled shortcut paths must survive before federal funding');
  assert.strictEqual(result.successRate, 0,
    'the returned analysis must use federally funded survival truth');
  assert.strictEqual(result.federalSuccessRate, result.successRate);
  assert.strictEqual(result.survived, result.federalFunding.survived);
  assert.strictEqual(result.total, result.federalFunding.total);
  assert.strictEqual(result.federalFunding.paths.p50.terminalBalance, 0,
    'sidecar must retain the federally funded depletion path');
  assert.ok(shortcutAnalysis.paths.p50.terminalBalance > 0,
    'controlled shortcut path must remain funded before the federal delta');
  assert.strictEqual(result.federalFunding.successRate, result.federalSuccessRate);
  assert.deepStrictEqual(Object.keys(result.federalFunding.paths), [
    'p10', 'p25', 'p50', 'p75', 'p90',
  ]);
  for(const pathKey of Object.keys(result.federalFunding.paths)){
    const selected = result.paths[pathKey];
    const selectedSim = result.sims.find((sim) =>
      sim.simIndex === selected.simIndex && sim.returnPath === selected.returnPath
    );
    assert.strictEqual(selected, selectedSim,
      `${pathKey} must reference a sim from the same funded analysis`);
    assert.strictEqual(
      result.federalFunding.paths[pathKey].simIndex,
      selected.simIndex,
      `${pathKey} sidecar must compact the funded analysis selection`
    );
    assert.strictEqual(
      result.federalFunding.paths[pathKey].terminalBalance,
      selected.terminalBalance
    );
    selected.rows.forEach((row, index) => {
      const compact = result.federalFunding.paths[pathKey].rows[index];
      assert.strictEqual(
        compact.convergedFederalTax,
        row.phase === 'accum' || row.source === null ? null : row.taxes,
        `${pathKey} year ${row.year} must expose the same annual federal tax to Cash Flow and Scenarios`
      );
    });
    assert.ok(selected.rows
      .filter((row) => row.source !== null && row.phase !== 'accum')
      .every((row) => row.taxFundingConvergence?.status === 'converged'));
  }
  assert.strictEqual(
    result.federalFunding.semantics.pathSelection,
    'federal-funded-selected-anchors'
  );
  assert.strictEqual(shortcutAnalysis.federalSuccessRate, undefined,
    'sidecar attachment must not mutate the shortcut analysis');
  assert.strictEqual(shortcutAnalysis.federalFunding, undefined,
    'sidecar attachment must not mutate the shortcut analysis');
});

test('federal funding evidence survives helper composition without splitting analysis truth', () => {
  const { plan, returnPaths } = controlledFixture();
  const shortcutAnalysis = runSimulation(plan, {}, returnPaths);
  const options = {
    filingStatus: 'single',
    baseTaxYear: 2025,
    scenarioId: 'phase_3_composition_test',
  };
  const funded = runMonteCarloWithFederalFunding(shortcutAnalysis, plan, {}, options);
  const promoted = promoteTaxFundedProbability(funded);
  const reported = rerunMonteCarloWithFederalTax(promoted, options);

  assert.strictEqual(promoted.federalFunding, funded.federalFunding);
  assert.strictEqual(reported.federalFunding, funded.federalFunding);
  assert.strictEqual(promoted.successRate, funded.successRate);
  assert.strictEqual(reported.successRate, funded.successRate);
  for(const pathKey of ['p10', 'p25', 'p50', 'p75', 'p90']){
    assert.strictEqual(
      reported.paths[pathKey],
      reported.sims.find((sim) =>
        sim.simIndex === reported.paths[pathKey].simIndex
        && sim.returnPath === reported.paths[pathKey].returnPath
      )
    );
  }
});

test('direct production run matches the shortcut-anchored compatibility wrapper', () => {
  const { plan, returnPaths } = controlledFixture();
  const options = {
    filingStatus: 'single',
    baseTaxYear: 2025,
    scenarioId: 'direct_federal_funding_test',
  };
  const shortcutAnalysis = runSimulation(plan, {}, returnPaths);
  const compatibility = runMonteCarloWithFederalFunding(
    shortcutAnalysis,
    plan,
    {},
    options
  );
  const direct = runFederalFundingSimulation(plan, {}, returnPaths, options);

  assert.deepStrictEqual(shortcutSnapshot(direct), shortcutSnapshot(compatibility));
  assert.deepStrictEqual(direct.sims, compatibility.sims);
  assert.deepStrictEqual(direct.federalFunding, compatibility.federalFunding);
});

test('future federal planning is independent of current-return Tax facts', () => {
  const { plan, returnPaths } = projectedIncomeFixture();
  const firstPlan = structuredClone(plan);
  const secondPlan = structuredClone(plan);
  firstPlan.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    income: { wages: 1 },
  };
  secondPlan.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    income: { wages: 1_000_000 },
  };
  const options = {
    filingStatus: 'single',
    baseTaxYear: 2026,
    scenarioId: 'future_current_tax_independence',
  };

  const first = runFederalFundingSimulation(firstPlan, {}, returnPaths, options);
  const second = runFederalFundingSimulation(secondPlan, {}, returnPaths, options);

  assert.equal(first.params.incomeContractAvailable, true);
  assert.equal(first.sims[0].rows[0].incomeTaxFacts.wages, 75_000);
  assert.deepStrictEqual(first.params, second.params);
  assert.deepStrictEqual(first.sims, second.sims);
  assert.deepStrictEqual(first.federalFunding, second.federalFunding);
  assert.equal(first.successRate, second.successRate);
});

test('unknown taxable basis applies 50/50 to withdrawals and propagates tax, balance, success, and assumption metadata', () => {
  const assumedFixture = taxableWithdrawalFixture();
  const confirmedFixture = taxableWithdrawalFixture({
    amount: 200_000,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-08-18T12:00:00.000Z',
    version: 1,
  });
  const options = {
    filingStatus: 'single',
    baseTaxYear: 2026,
    scenarioId: 'actual_taxable_withdrawal_basis',
  };
  const assumed = runFederalFundingSimulation(
    assumedFixture.plan, {}, assumedFixture.returnPaths, options
  );
  const confirmed = runFederalFundingSimulation(
    confirmedFixture.plan, {}, confirmedFixture.returnPaths, options
  );
  const assumedRow = assumed.sims[0].rows[0];
  const confirmedRow = confirmed.sims[0].rows[0];

  assert.equal(assumed.params.accounts.taxable.basis, 100_000);
  assert.equal(confirmed.params.accounts.taxable.basis, 200_000);
  assert.ok(assumedRow.accountBreakdown.taxable > 0);
  assert.ok(assumedRow.taxableCapitalGain > confirmedRow.taxableCapitalGain);
  assert.ok(assumedRow.taxes > confirmedRow.taxes);
  assert.ok(assumedRow.balance < confirmedRow.balance);
  assert.equal(assumed.successRate, 0);
  assert.equal(confirmed.successRate, 100);
  assert.equal(assumed.federalFunding.successRate, assumed.successRate);
  assert.equal(confirmed.federalFunding.successRate, confirmed.successRate);
  assert.equal(
    assumed.federalFunding.taxFacts.calculationInputs.taxableBasisMode,
    'assumed-50-50'
  );
  assert.deepStrictEqual(
    assumed.federalFunding.taxFacts.calculationInputs.taxableBasisAssumptions
      .map(item => item.code),
    ['TAXABLE_BASIS_ASSUMED_50_50']
  );
  assert.deepStrictEqual(
    confirmed.federalFunding.taxFacts.calculationInputs.taxableBasisAssumptions,
    []
  );
});

test('federal funding rejects tax overrides that contradict its Household fact contract', () => {
  const { plan, returnPaths } = controlledFixture();
  const shortcutAnalysis = runSimulation(plan, {}, returnPaths);

  assert.throws(
    () => runMonteCarloWithFederalFunding(shortcutAnalysis, plan, {}, {
      filingStatus: 'marriedFilingJointly',
      baseTaxYear: 2025,
    }),
    /filingStatus override conflicts with Household/
  );
  assert.throws(
    () => runMonteCarloWithFederalFunding(shortcutAnalysis, plan, {}, {
      filingStatus: 'single',
      taxableGainFraction: 0.25,
      baseTaxYear: 2025,
    }),
    /must use each engine row taxableGainFraction/
  );
  assert.throws(
    () => runMonteCarloWithFederalFunding(shortcutAnalysis, plan, {}, {
      filingStatus: 'single',
      treatWithdrawalsAsFullyTaxable: false,
      baseTaxYear: 2025,
    }),
    /cannot override Traditional withdrawal tax character/
  );
  assert.throws(
    () => runMonteCarloWithFederalFunding(shortcutAnalysis, plan, {}, {
      filingStatus: 'single',
      resolved: { taxableIra: 0 },
      baseTaxYear: 2025,
    }),
    /cannot override resolved taxable portions/
  );

  const missingStatusPlan = structuredClone(plan);
  delete missingStatusPlan.meta.filingStatus;
  assert.throws(
    () => runMonteCarloWithFederalFunding(shortcutAnalysis, missingStatusPlan, {}, {
      filingStatus: 'single',
      baseTaxYear: 2025,
    }),
    /must match Household and shortcut inputs/
  );
});

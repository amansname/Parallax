import { test } from 'node:test';
import assert from 'node:assert';
import { defaultPlan, runSimulation } from '../../../engine.js';
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

import { test } from 'node:test';
import assert from 'node:assert';
import {
  analyzeResults,
  defaultPlan,
  generateReturnPath,
  resetSeed,
  resolveInputs,
  runSimulation,
} from '../../../engine.js';
import { attachPathFederalTax } from './attachTypicalPathFederalTax.js';
import { createFederalTaxResolver } from './createFederalTaxResolver.js';
import { rerunMonteCarloWithFederalTax } from './rerunMonteCarloWithFederalTax.js';

const PATH_KEYS = ['p10', 'p25', 'p50', 'p75', 'p90'];

function fixture(){
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'single';
  plan.household.primary = { currentAge: 60, retirementAge: 65, planEndAge: 95 };
  plan.income.other = [{ label: 'Wages', amount: 120000, startAge: 60, endAge: 64, taxablePct: 1 }];
  const horizon = resolveInputs(plan, {}).horizonYears;
  resetSeed(20260711);
  const returnPaths = Array.from({ length: 40 }, () => generateReturnPath(horizon));
  const analysis = runSimulation(plan, {}, returnPaths);
  const options = {
    filingStatus: 'single',
    baseTaxYear: 2026,
    scenarioId: 't7_monte_carlo_test',
  };
  const federalAnalysis = rerunMonteCarloWithFederalTax(analysis, options);
  return { analysis, federalAnalysis, options };
}

function aggregateSnapshot(analysis){
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

function fundingSnapshot(sim){
  return sim.rows.map((row) => ({
    withdrawal: row.withdrawal,
    rmd: row.rmd,
    balance: row.balance,
    accountBreakdown: row.accountBreakdown,
    accountBalances: row.accountBalances,
  }));
}

test('all 40 Monte Carlo sims report federal line 24 from their final funded rows', () => {
  const { analysis, federalAnalysis, options } = fixture();
  const resolveFederalTax = createFederalTaxResolver(analysis.params, options);

  assert.strictEqual(federalAnalysis.sims.length, 40);
  for(let index = 0; index < analysis.sims.length; index++){
    const shortcutSim = analysis.sims[index];
    const federalSim = federalAnalysis.sims[index];
    assert.notStrictEqual(federalSim, shortcutSim);
    assert.strictEqual(federalSim.simIndex, shortcutSim.simIndex);
    assert.strictEqual(federalSim.returnPath, shortcutSim.returnPath);

    for(let rowIndex = 0; rowIndex < federalSim.rows.length; rowIndex++){
      const federalRow = federalSim.rows[rowIndex];
      if(federalRow.source == null){
        assert.strictEqual(federalRow.taxes, 0);
        continue;
      }
      const expectedLine24 = resolveFederalTax(federalRow);
      assert.ok(
        Math.abs(federalRow.taxes - expectedLine24) < 0.01,
        `sim ${shortcutSim.simIndex} row ${rowIndex} must report federal line 24`
      );
      if(federalRow.phase !== 'accum'){
        assert.strictEqual(federalRow.taxFundingConvergence?.status, 'converged');
        assert.ok(
          Math.abs(federalRow.taxFundingConvergence.residual)
            <= federalRow.taxFundingConvergence.tolerance
        );
      }
    }
  }
});

test('full-MC rerun recomputes aggregates and percentile paths from funded sims', () => {
  const { analysis, federalAnalysis } = fixture();
  const independentlyAnalyzed = analyzeResults(federalAnalysis.sims, federalAnalysis.params);

  assert.notStrictEqual(federalAnalysis, analysis);
  assert.notStrictEqual(federalAnalysis.sims, analysis.sims);
  assert.deepStrictEqual(
    aggregateSnapshot(federalAnalysis),
    aggregateSnapshot(independentlyAnalyzed)
  );

  for(const pathKey of PATH_KEYS){
    const federalPath = federalAnalysis.paths[pathKey];
    assert.strictEqual(
      federalPath,
      independentlyAnalyzed.paths[pathKey],
      `${pathKey} must be selected by the funded analysis`
    );
    assert.strictEqual(federalPath, federalAnalysis.sims.find((sim) =>
      sim.simIndex === federalPath.simIndex && sim.returnPath === federalPath.returnPath
    ));
  }

  assert.ok(analysis.sims.some((shortcutSim, index) => {
    try{
      assert.deepStrictEqual(
        fundingSnapshot(federalAnalysis.sims[index]),
        fundingSnapshot(shortcutSim)
      );
      return false;
    }catch{
      return true;
    }
  }), 'the federal fixed point must be allowed to change funding and balances');
});

test('funded lifetime-tax aggregates and attached story paths share the same federal truth', () => {
  const { federalAnalysis, options } = fixture();
  const federalLifetimeTaxes = federalAnalysis.sims
    .map((sim) => sim.lifetimeTax)
    .sort((a, b) => a - b);
  const expectedMedian = federalLifetimeTaxes[Math.floor(federalLifetimeTaxes.length * 0.50)];

  assert.strictEqual(federalAnalysis.medianLifetimeTax, expectedMedian);
  assert.strictEqual(federalAnalysis.federalMedianLifetimeTax, expectedMedian);
  assert.ok(Number.isFinite(federalAnalysis.federalMedianLifetimeTax));
  for(const pathKey of ['p10', 'p50', 'p90']){
    const summary = attachPathFederalTax(federalAnalysis, pathKey, options);
    assert.ok(Math.abs(summary.totals.deltaVsEnginePath) < 0.01);
  }
});

test('duplicate simIndex and returnPath pairs are rerun once and reused', () => {
  const { analysis, options } = fixture();
  const repeated = analysis.sims[0];
  const duplicateAnalysis = {
    ...analysis,
    sims: [repeated, repeated],
    paths: Object.fromEntries(PATH_KEYS.map((pathKey) => [pathKey, repeated])),
  };
  const federalAnalysis = rerunMonteCarloWithFederalTax(duplicateAnalysis, options);

  assert.strictEqual(federalAnalysis.sims[0], federalAnalysis.sims[1]);
  for(const pathKey of PATH_KEYS){
    assert.strictEqual(federalAnalysis.paths[pathKey], federalAnalysis.sims[0]);
  }
});

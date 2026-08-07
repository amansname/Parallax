import { test } from 'node:test';
import assert from 'node:assert';
import {
  defaultPlan,
  generateReturnPath,
  resetSeed,
  resolveInputs,
  runSimulation,
} from '../../../engine.js';
import { attachPathFederalTax } from './attachTypicalPathFederalTax.js';
import { rerunTypicalPathWithFederalTax } from './rerunTypicalPathWithFederalTax.js';

function fixture(){
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'single';
  const horizon = resolveInputs(plan, {}).horizonYears;
  resetSeed(20260710);
  const paths = Array.from({ length: 40 }, () => generateReturnPath(horizon));
  const analysis = runSimulation(plan, {}, paths);
  const options = {
    filingStatus: 'single',
    baseTaxYear: 2026,
    scenarioId: 't6_typical_path_test',
  };
  const federalAnalysis = rerunTypicalPathWithFederalTax(analysis, options);
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

function fundingSnapshot(path){
  return path.rows.map((row) => ({
    withdrawal: row.withdrawal,
    rmd: row.rmd,
    balance: row.balance,
    accountBreakdown: row.accountBreakdown,
    accountBalances: row.accountBalances,
  }));
}

test('p10, p50, and p90 retirement row taxes equal federal Form 1040 line 24', () => {
  const { federalAnalysis, options } = fixture();
  for(const pathKey of ['p10', 'p50', 'p90']){
    const summary = attachPathFederalTax(federalAnalysis, pathKey, options);
    assert.strictEqual(summary.path, pathKey);
    assert.ok(summary.years.length > 0);
    assert.ok(summary.years.every((year) =>
      Math.abs(year.engineTax - year.federalTaxLiability) < 0.01
    ));
    assert.ok(federalAnalysis.paths[pathKey].rows
      .filter((row) => row.source !== null && row.phase !== 'accum')
      .every((row) => row.taxFundingConvergence?.status === 'converged'));
  }
});

test('story-path federal reruns keep selected paths, matching sims, and funded rows coherent', () => {
  const { analysis, federalAnalysis } = fixture();
  const federalKeys = ['p10', 'p50', 'p90'];
  const federalIndexes = new Set(federalKeys.map((key) => analysis.paths[key].simIndex));

  assert.notStrictEqual(federalAnalysis, analysis);
  assert.notStrictEqual(federalAnalysis.sims, analysis.sims);
  for(const key of federalKeys){
    assert.notStrictEqual(federalAnalysis.paths[key], analysis.paths[key]);
    assert.strictEqual(federalAnalysis.paths[key].simIndex, analysis.paths[key].simIndex);
    assert.strictEqual(federalAnalysis.paths[key].returnPath, analysis.paths[key].returnPath);
    assert.strictEqual(
      federalAnalysis.sims.find((sim) => sim.simIndex === analysis.paths[key].simIndex),
      federalAnalysis.paths[key]
    );
  }
  for(const key of ['p25', 'p75']){
    assert.strictEqual(federalAnalysis.paths[key], analysis.paths[key]);
  }
  for(const sim of analysis.sims){
    if(!federalIndexes.has(sim.simIndex)){
      assert.strictEqual(
        federalAnalysis.sims.find((candidate) => candidate.simIndex === sim.simIndex),
        sim
      );
    }
  }
  assert.deepStrictEqual(aggregateSnapshot(federalAnalysis), aggregateSnapshot(analysis));
  assert.ok(federalKeys.some((pathKey) => {
    try{
      assert.deepStrictEqual(
        fundingSnapshot(federalAnalysis.paths[pathKey]),
        fundingSnapshot(analysis.paths[pathKey])
      );
      return false;
    }catch{
      return true;
    }
  }), 'converged federal tax must be allowed to change selected-path funding');
});

test('attached federal-vs-path deltas are approximately zero after story-path reruns', () => {
  const { analysis, federalAnalysis, options } = fixture();
  for(const pathKey of ['p10', 'p50', 'p90']){
    const before = attachPathFederalTax(analysis, pathKey, options);
    const after = attachPathFederalTax(federalAnalysis, pathKey, options);
    assert.ok(Math.abs(before.totals.deltaVsEnginePath) > 0.01,
      `${pathKey} fixture must begin with a real shortcut-vs-federal delta`);
    assert.ok(Math.abs(after.totals.deltaVsEnginePath) < 0.01);
  }
});

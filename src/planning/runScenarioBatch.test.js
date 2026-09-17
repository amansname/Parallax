import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan, generateReturnPath, resetSeed, resolveInputs } from '../../engine.js';
import { createSelectableDefaultHouseholds } from '../../ui/householdFactories.js';
import { runFederalFundingSimulation } from './tax/runMonteCarloWithFederalFunding.js';
import { runScenarioBatch, runHistoricalStressBatch } from './runScenarioBatch.js';
import { computeHistoricalStress, STRESS_ERAS } from '../scenarios/historicalStress.js';

test('worker batch retains complete canonical results and baseline account-detail selection', () => {
  const records = createSelectableDefaultHouseholds(defaultPlan, 2026);
  const plan = structuredClone(records.find(record => record.meta.householdId === 'joe-household'));
  plan.simulation.iterations = 8;
  resetSeed(90210);
  const returnPaths = Array.from({ length: 8 }, () => generateReturnPath(resolveInputs(plan, {}).horizonYears));
  const entries = [
    { name: 'Base', base: true, plan, overrides: {} },
    { name: 'Alternative', base: false, plan: structuredClone(plan), overrides: { livingAnnual: 240_000 } },
    { name: 'Invalid', base: false, plan: { ...plan, meta: { ...plan.meta, filingStatus: 'invalid' } }, overrides: {} },
  ];
  const expectedBase = runFederalFundingSimulation(plan, {}, returnPaths, {
    baseTaxYear: 2026, scenarioId: 'Base', filingStatus: plan.meta.filingStatus, accountDiagnosticsSimIndices: [],
  });
  const expectedAlternative = runFederalFundingSimulation(entries[1].plan, entries[1].overrides, returnPaths, {
    baseTaxYear: 2026, scenarioId: 'Alternative', filingStatus: plan.meta.filingStatus,
    accountDiagnosticsSimIndices: [expectedBase.paths.p50.simIndex],
  });
  assert.notDeepEqual(expectedAlternative.envelope, expectedBase.envelope, 'the alternative must exercise a changed financial result');
  const output = [];
  runScenarioBatch({ entries, returnPaths, baseTaxYear: 2026 }, response => output.push(structuredClone(response)));
  assert.deepEqual(output[0].result, expectedBase);
  assert.deepEqual(output[1].result, expectedAlternative);
  assert.match(output[2].error.message, /filing status|filingStatus/i);
  assert.equal(output[0].result.stress, undefined);
  const historical = [];
  runHistoricalStressBatch({ entries: [{
    ...entries[0],
    analysis: { envelope: expectedBase.envelope, paths: { p50: expectedBase.paths.p50 } },
  }] }, response => historical.push(structuredClone(response)));
  const expectedStress = computeHistoricalStress({ name: entries[0].name, res: expectedBase }, plan, {});
  assert.equal(expectedStress.length, STRESS_ERAS.length);
  assert.deepEqual(historical[0].result.stress, expectedStress);
});

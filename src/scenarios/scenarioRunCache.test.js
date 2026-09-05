import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPlan } from '../../engine.js';
import { createSelectableDefaultHouseholds } from '../../ui/householdFactories.js';
import { flatAssetReturnRow } from '../../test/fixtures/assetReturnRows.js';
import { runFederalFundingSimulation } from '../planning/tax/runMonteCarloWithFederalFunding.js';
import { registerTransientProjectionAccountState } from '../household/transientProjectionAccountState.js';
import { snapshotPresetAllocation } from '../household/investmentAllocation.js';
import { createScenarioRunCache } from './scenarioRunCache.js';

function fixture(){
  const plan = createSelectableDefaultHouseholds(defaultPlan, 2026)
    .find(household => household.meta.householdId === 'joe-household');
  const paths = Array.from({ length: 3 }, (_, index) => (
    Array.from({ length: 41 }, (_, year) => flatAssetReturnRow(1980 + year, index / 100))
  ));
  const taxOptions = { baseTaxYear: 2026, scenarioId: 'Baseline', filingStatus: 'marriedFilingJointly' };
  return { plan, paths, taxOptions };
}

test('unchanged Joe inputs reuse the exact funded result; fresh calculation reconciles', () => {
  const { plan, paths, taxOptions } = fixture();
  const cache = createScenarioRunCache();
  const key = cache.key(plan, {}, taxOptions);
  const scenario = { res: runFederalFundingSimulation(plan, {}, paths, taxOptions), runError: null };
  assert.notEqual(scenario.res.projectionStatus, 'unavailable');
  cache.remember(scenario, paths, key);
  assert.equal(cache.matches(scenario, paths, cache.key(structuredClone(plan), {}, { ...taxOptions })), true);
  const fresh = runFederalFundingSimulation(plan, {}, paths, taxOptions);
  assert.deepEqual(scenario.res, fresh);
});

test('saved facts, tax options, and transient allocation all invalidate a prior run', () => {
  const { plan, paths, taxOptions } = fixture();
  const cache = createScenarioRunCache();
  const scenario = { res: {}, runError: null };
  const key = cache.key(plan, {}, taxOptions);
  cache.remember(scenario, paths, key);
  const changes = [
    p => { p.portfolio.extraAccounts[0].balance += 100; },
    p => { p.household.primary.retirementAge += 1; },
    p => { p.goals[0].amount += 100; },
    p => { p.income.other[0].amount += 100; },
    p => { p.meta.name = 'Another household'; },
    p => registerTransientProjectionAccountState(p, [{
      id: p.portfolio.extraAccounts[0].id,
      investmentAllocation: snapshotPresetAllocation('all-equity'),
    }]),
  ];
  for(const change of changes){
    const changed = structuredClone(plan);
    change(changed);
    assert.equal(cache.matches(scenario, paths, cache.key(changed, {}, taxOptions)), false);
  }
  assert.equal(cache.matches(scenario, paths, cache.key(plan, { livingAnnual: 12345 }, taxOptions)), false);
  for(const options of [
    { ...taxOptions, baseTaxYear: 2025 },
    { ...taxOptions, scenarioId: 'Renamed' },
    { ...taxOptions, accountDiagnosticsSimIndices: [2] },
  ]){
    assert.equal(cache.matches(scenario, paths, cache.key(plan, {}, options)), false);
  }
});

test('household reselection, new paths, cleared results, and failures cannot reuse a run', () => {
  const { plan, paths, taxOptions } = fixture();
  const cache = createScenarioRunCache();
  const key = cache.key(plan, {}, taxOptions);
  const result = {};
  const scenario = { res: result, runError: null };
  cache.remember(scenario, paths, key);
  assert.equal(cache.matches({ ...scenario }, paths, key), false);
  assert.equal(cache.matches(scenario, structuredClone(paths), key), false);
  scenario.res = null;
  assert.equal(cache.matches(scenario, paths, key), false);
  scenario.res = result;
  scenario.runError = 'Failed';
  assert.equal(cache.matches(scenario, paths, key), false);
  scenario.runError = null;
  result.projectionStatus = 'unavailable';
  assert.equal(cache.matches(scenario, paths, key), false);
});

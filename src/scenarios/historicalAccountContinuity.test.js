import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan, resolveInputs } from '../../engine.js';
import { runFederalFundingSimulation } from '../planning/tax/runMonteCarloWithFederalFunding.js';
import { createAccount } from '../household/createAccount.js';
import { ACCOUNT_SCHEMA_VERSION } from '../household/accountTypes.js';
import {
  ASSET_ALLOCATION_PRESETS, resolveCashOnlyAllocation,
  snapshotLegacyRiskProfileAllocation, snapshotPresetAllocation,
} from '../household/investmentAllocation.js';
import { flatAssetReturnRow } from '../../test/fixtures/assetReturnRows.js';
import { applyScenarioPlanInputs } from './scenarioPlanInputs.js';
import { createCashFlowController } from './createCashFlowController.js';
import { buildHistoricalCashFlowResult } from './buildHistoricalCashFlowResult.js';
import { HISTORICAL_PERIODS } from './historicalPeriods.js';
import { buildRetirementEntryPlan, deriveExactRetirementEntryAccounts } from './buildRetirementEntryPlan.js';
import { resolveTaxableStartingBasis } from '../household/resolveTaxableStartingBasis.js';
import { registerTransientProjectionAccountState, readTransientProjectionAccountState } from '../household/transientProjectionAccountState.js';

// Synthetic current-schema fixture preserving the observed Parker trigger:
// retired household, typed investments, empty legacy sleeves, scenario preset.
// This is not an export of the user's saved household.
function household({ working = false } = {}){
  const plan = structuredClone(defaultPlan);
  Object.assign(plan.meta, {
    accountSchemaVersion: ACCOUNT_SCHEMA_VERSION,
    planningAsOfYear: 2026, filingStatus: 'single', spendingSchemaVersion: 1,
  });
  plan.household.primary = {
    currentAge: working ? 64 : 68, retirementAge: 67, planEndAge: 75,
  };
  plan.household.spouse = null;
  plan.portfolio.accounts = Object.fromEntries(['taxable', 'traditional', 'roth'].map(bucket => [
    bucket, { id: `base-${bucket}`, balance: 0, investmentAllocation: snapshotLegacyRiskProfileAllocation(3) },
  ]));
  plan.portfolio.extraAccounts = [
    ['brokerage', 'brokerage_taxable', 500_000, 'growth'],
    ['ira', 'traditional_ira', 900_000, 'balanced'],
    ['roth', 'roth_ira', 500_000, 'aggressive'],
    ['cash', 'checking', 50_000, null],
  ].map(([id, typeId, balance, preset]) => ({
    ...createAccount(typeId, { balance, owner: 'client',
      ...(preset ? { investmentAllocation: snapshotPresetAllocation(preset) } : {}),
    }), id,
  }));
  plan.savings.annual = 0;
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  plan.income.other = [];
  plan.expenses = { living: 0, housing: 0, healthcare: 0, debt: 0, healthcareRealGrowth: 0, extra: [] };
  plan.goals = [{ name: 'Spending', amount: 30_000, startAge: 67, endAge: 75 }];
  return plan;
}

function run(plan, preset, overrides = {}){
  const scenarioPlan = applyScenarioPlanInputs(plan, {
    retireAge: plan.household.primary.retirementAge, ssAge: 70, allocationPresetId: preset,
  });
  const params = resolveInputs(scenarioPlan, overrides);
  const market = Array.from({ length: params.horizonYears }, (_, i) => ({
    ...flatAssetReturnRow(1995 + i), usLarge: 0.12, usBonds: 0.025, cash: 0.01,
  }));
  const analysis = runFederalFundingSimulation(scenarioPlan, overrides, [market], {
    baseTaxYear: plan.meta.planningAsOfYear, filingStatus: plan.meta.filingStatus,
    scenarioId: 'account_handoff_regression',
  });
  assert.ok(analysis.federalFunding, 'fixture must exercise the production federal-funding route');
  return { plan: scenarioPlan, overrides, analysis, params };
}

test('Parker-shaped scenario switching: historical -> Typical -> historical keeps the chosen account mix', () => {
  const source = household();
  const before = JSON.stringify(source);
  const inputs = new WeakMap();
  const scenarios = [['Baseline', 'current'], ['Spend Less', 'current'], ['Aggressive', 'aggressive']]
    .map(([name, preset], index) => {
      const entry = run(source, preset, index === 1 ? { spendCut: 0.1 } : {});
      inputs.set(entry.analysis, entry);
      return { name, base: index === 0, res: entry.analysis };
    });
  const errors = [];
  const controller = createCashFlowController({
    getScenarios: () => scenarios, scenarioInputsByResult: inputs,
    selection: { id: 'historical-1929' }, buildRows: simulation => simulation.rows,
    onError: (...args) => errors.push(args.at(-1).message), onHeaderDiagnostic: () => {},
  });
  for(const [index, path] of [[0, 'historical-1929'], [1, 'historical-1929'],
    [2, 'typical'], [2, 'historical-1929'], [2, 'typical'], [2, 'historical-1995'],
    [0, 'historical-1929'], [2, 'historical-1929']]){
    controller.setPathId(path);
    const result = controller.resultForScenario(scenarios[index]);
    assert.equal(result.error, undefined, `${scenarios[index].name}/${path}: ${errors.at(-1)}`);
    assert.ok(result.rows.length > 0);
    assert.equal(result.pathId, path);
  }
  assert.deepEqual(errors, []);
  assert.equal(JSON.stringify(source), before);
});

test('all scenario presets preserve account returns across all historical periods and working/retired entries', () => {
  for(const working of [false, true]){
    const source = household({ working });
    for(const preset of [{ id: 'current' }, ...ASSET_ALLOCATION_PRESETS]){
      const { plan, analysis, params } = run(source, preset.id);
      const before = JSON.stringify(plan);
      for(const period of HISTORICAL_PERIODS){
        const result = buildHistoricalCashFlowResult({ plan, analysis, periodId: period.id });
        const first = result.rows[result.accumulationYears];
        assert.equal(first.source, period.startYear);
        assert.equal(first.age, Math.max(params.currentAge, params.retirementAge));
        assert.equal(result.retirementBaseYear, 2026 + result.accumulationYears);
        assert.deepEqual(Object.keys(first.accountReturns).sort(), params.projectionAccounts.map(a => a.id).sort());
        const previous = result.rows[result.accumulationYears - 1];
        for(const account of previous?.accountStates ?? params.projectionAccounts){
          const diagnostics = first.accountReturns[account.id];
          assert.deepEqual(diagnostics.requestedWeights, account.investmentAllocation.weights);
          assert.ok(Math.abs(diagnostics.returnDollars - account.balance * diagnostics.appliedReturn) < 0.01);
        }
        assert.deepEqual(first.accountReturns.cash.requestedWeights, resolveCashOnlyAllocation().weights);
        assert.equal(first.taxableStartingBasis, previous?.taxableEndingBasis ?? params.accounts.taxable.basis);
      }
      assert.equal(JSON.stringify(plan), before);
    }
  }
});

test('scenario overrides leave recorded allocation provenance unchanged, including funded legacy accounts', () => {
  const source = household();
  source.portfolio.extraAccounts = [];
  source.portfolio.accounts.taxable.balance = 500_000;
  const before = JSON.stringify(source.portfolio);
  const { plan, params } = run(source, 'aggressive');
  assert.equal(JSON.stringify(plan.portfolio), before);
  assert.deepEqual(params.projectionAccounts[0].investmentAllocation.weights, snapshotPresetAllocation('aggressive').weights);
});

test('historical entry does not apply an initial shock twice', () => {
  for(const working of [false, true]){
    const { plan, analysis, params, overrides } = run(household({ working }), 'aggressive', { initialShock: 0.2 });
    const result = buildHistoricalCashFlowResult({ plan, analysis, overrides, periodId: 'historical-1995' });
    const first = result.rows[result.accumulationYears];
    const previous = result.rows[result.accumulationYears - 1];
    assert.deepEqual(first.accountStartingBalances, previous?.accountBalances ?? Object.fromEntries(
      ['taxable', 'traditional', 'roth'].map(bucket => [bucket, params.accounts[bucket].balance]),
    ));
  }
});

test('projected basis is per-account, nonserializable, and cannot bypass reporting or saved allocation validation', () => {
  const { plan, analysis, params } = run(household({ working: true }), 'aggressive');
  const count = params.retirementAge - params.currentAge;
  const entry = deriveExactRetirementEntryAccounts(analysis, count, params.accounts, params.projectionAccounts);
  const rebased = buildRetirementEntryPlan(plan, { entryAccounts: entry,
    currentAge: params.currentAge, retirementAge: params.retirementAge });
  const resolved = resolveInputs(rebased, {});
  for(const state of entry.accountStates){
    const actual = resolved.projectionAccounts.find(account => account.id === state.id);
    assert.equal(actual.balance, state.balance);
    assert.equal(actual.basis, state.basis);
  }
  assert.deepEqual(rebased.portfolio.extraAccounts.map(account => account.basis),
    plan.portfolio.extraAccounts.map(account => account.basis));
  const serializedClone = JSON.parse(JSON.stringify(rebased));
  assert.equal(readTransientProjectionAccountState(serializedClone, 'brokerage'), null);
  serializedClone.transientProjectionAccountState = { brokerage: { basis: 1 } };
  assert.equal(readTransientProjectionAccountState(serializedClone, 'brokerage'), null);
  rebased.portfolio.extraAccounts[0].taxReporting.inclusion = 'unknown';
  assert.equal(resolveTaxableStartingBasis(rebased).basisOverride, null);

  const invalid = household();
  invalid.portfolio.extraAccounts[0].investmentAllocation = null;
  assert.throws(() => run(invalid, 'aggressive'), /investmentAllocation is required/);
  assert.throws(() => registerTransientProjectionAccountState({}, [{ id: 'x', basis: -1 }]), /basis/);
  assert.throws(() => registerTransientProjectionAccountState({}, [{ id: 'x' }, { id: 'x' }]), /unique/);
  const bankOverride = household();
  registerTransientProjectionAccountState(bankOverride, [{ id: 'cash', investmentAllocation: snapshotPresetAllocation('aggressive') }]);
  assert.throws(() => resolveInputs(bankOverride, {}), /must be cash-only/);
});

test('historical entry rejects missing, duplicate, or mismatched account state instead of reconstructing it', () => {
  const { plan, analysis, params } = run(household(), 'aggressive');
  const entry = deriveExactRetirementEntryAccounts(analysis, 0, params.accounts, params.projectionAccounts);
  const build = entryAccounts => buildRetirementEntryPlan(plan, {
    entryAccounts, currentAge: params.currentAge, retirementAge: params.retirementAge,
  });
  assert.throws(() => build({ ...entry, accountStates: undefined }), /states are required/);
  assert.throws(() => build({ ...entry, accountStates: [...entry.accountStates, entry.accountStates[0]] }), /unique/);
  assert.throws(() => build({ ...entry, accountStates: entry.accountStates.map(state => (
    state.id === 'brokerage' ? { ...state, id: 'different-account' } : state
  )) }), /identity changed/);
  assert.throws(() => build({ ...entry, accountStates: entry.accountStates.map(state => (
    state.id === 'brokerage' ? { ...state, owner: 'spouse' } : state
  )) }), /owner changed/);
});

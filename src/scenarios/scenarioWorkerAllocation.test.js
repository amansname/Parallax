import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan, generateReturnPath, resetSeed, resolveInputs } from '../../engine.js';
import { createSelectableDefaultHouseholds } from '../../ui/householdFactories.js';
import { applyScenarioPlanInputs } from './scenarioPlanInputs.js';
import { createScenarioWorkerClient } from './createScenarioWorkerClient.js';
import { runScenarioBatch } from '../planning/runScenarioBatch.js';
import { registerTransientProjectionAccountState, snapshotTransientProjectionAccountState, readTransientProjectionAccountState } from '../household/transientProjectionAccountState.js';

function fixture() {
  const plan = createSelectableDefaultHouseholds(defaultPlan, 2026).find(p => p.meta.householdId === 'joe-household');
  plan.simulation.iterations = 8;
  resetSeed(90210);
  const returnPaths = Array.from({ length: 8 }, () => generateReturnPath(resolveInputs(plan, {}).horizonYears));
  const entries = ['current', 'balanced', 'aggressive'].map((allocationPresetId, index) => ({
    name: allocationPresetId, base: index === 0, overrides: {},
    plan: applyScenarioPlanInputs(plan, { retireAge: 64, spouseRetireAge: 64, ssAge: 67, spouseSsAge: 67, allocationPresetId }),
  }));
  return { entries, returnPaths, baseTaxYear: 2026 };
}

function transferredClient() {
  return createScenarioWorkerClient({ createWorker: () => ({
    terminate() {},
    postMessage(message) {
      // Match actual Worker postMessage isolation: WeakMap state does not
      // survive this boundary. Both requests and results are cloned.
      const { requestId, batch } = structuredClone(message);
      queueMicrotask(() => {
        runScenarioBatch(batch, result => this.onmessage({ data: structuredClone({ kind: 'scenario', requestId, ...result }) }));
        this.onmessage({ data: { kind: 'complete', requestId } });
      });
    },
  }) });
}

test('worker transport preserves complete allocation and baseline account-detail results without changing saved facts', async () => {
  const batch = fixture();
  const before = JSON.stringify(batch.entries.map(e => e.plan));
  const expected = [];
  runScenarioBatch(batch, r => expected.push(structuredClone(r)));
  assert.notDeepEqual(expected[1].result, expected[2].result, 'Different selected allocations must produce different canonical outputs');
  const actual = await transferredClient().run(batch);
  assert.ok(JSON.stringify(actual.map(r => ({ index: r.index, result: r.result }))) === JSON.stringify(expected), 'Complete transferred allocation results differ from canonical direct calculation');
  assert.equal(JSON.stringify(batch.entries.map(e => e.plan)), before, 'Transport must not serialize overrides into saved plan facts');
});

test('worker transport retains transient basis as well as allocation', async () => {
  const batch = fixture();
  const entry = batch.entries[1];
  const states = snapshotTransientProjectionAccountState(entry.plan);
  const taxable = entry.plan.portfolio.extraAccounts.find(account => account.typeId === 'joint_brokerage');
  assert.ok(taxable, 'fixture needs a taxable account');
  const id = taxable.id;
  const state = states.find(value => value.id === id);
  assert.ok(state);
  state.basis = 12345;
  registerTransientProjectionAccountState(entry.plan, states);
  assert.equal(readTransientProjectionAccountState(structuredClone(entry.plan), id), null);
  const expected = [];
  runScenarioBatch(batch, r => expected.push(structuredClone(r)));
  const actual = await transferredClient().run(batch);
  assert.ok(JSON.stringify(actual.map(r => ({ index: r.index, result: r.result }))) === JSON.stringify(expected), 'Complete transferred basis results differ from canonical direct calculation');
  assert.equal(readTransientProjectionAccountState(entry.plan, id).basis, 12345);
});

test('invalid transported account state fails the affected scenario explicitly', () => {
  const batch = fixture();
  batch.entries[1].projectionAccountState = [{ id: 'invalid', basis: -1 }];
  const results = [];
  runScenarioBatch(batch, r => results.push(r));
  assert.match(results[1].error.message, /basis/);
  assert.equal(results[1].result, undefined);
  assert.ok(results[0].result && results[2].result);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan } from '../../engine.js';
import { createSelectableDefaultHouseholds } from '../../ui/householdFactories.js';
import { createScenarioRunController } from './createScenarioRunController.js';

function fixture(options = {}) {
  const plan = createSelectableDefaultHouseholds(defaultPlan, 2026).find(record => record.meta.householdId === 'joe-household');
  let scenarios = [{ name: 'Joe', base: true, res: { old: true } }];
  const jobs = [], states = [];
  let marked = 0;
  const inputs = new WeakMap();
  const controller = createScenarioRunController({
    getPlan: () => plan, getScenarios: () => scenarios, canRun: () => true,
    prepareScenario: () => ({ plan: structuredClone(plan), overrides: {} }),
    ensurePaths: () => ['shared-markets'], inputsByResult: inputs,
    onState: (state, message) => states.push({ state, message }), onResults() {},
    markCurrent: () => marked++,
    // Deliberately does not implement cancellation: the controller must also
    // reject a stale completion at the state boundary.
    client: { cancel() {}, run: batch => new Promise((resolve, reject) => jobs.push({ batch, resolve, reject })) },
    ...options,
  });
  return { controller, jobs, states, plan, inputs, get scenarios() { return scenarios; },
    replace() { scenarios = [{ name: 'New household', base: true }]; controller.invalidate(); },
    get marked() { return marked; } };
}

test('an edit cancels visible results and late completion cannot overwrite a new household', async () => {
  const f = fixture();
  const oldRun = f.controller.run();
  assert.equal(f.scenarios[0].res, null);
  assert.equal(f.scenarios[0].runError, 'Calculating…');
  f.replace();
  const nextRun = f.controller.run();
  f.jobs[0].resolve([{ result: { identity: 'old' } }]);
  await oldRun;
  assert.equal(f.scenarios[0].res, null);
  assert.equal(f.marked, 0);
  f.jobs[1].resolve([{ result: { identity: 'new' } }]);
  await nextRun;
  assert.equal(f.scenarios[0].res.identity, 'new');
  assert.equal(f.scenarios[0].res.stress, undefined, 'historical stress must remain lazy');
  assert.equal(f.marked, 1);
  assert.equal(f.states.at(-1).state, 'complete');
  assert.equal(f.inputs.get(f.scenarios[0].res).plan.meta.householdId, f.plan.meta.householdId);
});

test('historical-only failures restore a visible retry state while retaining the current projection', async () => {
  for (const stressResponse of [
    { error: { message: 'module unavailable' } },
    { result: { stress: [] } },
    { result: { stress: [{ year: 1966 }] } },
  ]) {
    const f = fixture({ createStressClient: () => ({ cancel() {}, run: async () => [stressResponse] }) });
    const run = f.controller.run();
    f.jobs[0].resolve([{ result: { paths: { p50: {} }, envelope: [] } }]);
    await run;
    const projection = f.scenarios[0].res;
    await f.controller.requestStress(f.scenarios[0]);
    assert.equal(f.scenarios[0].res, projection);
    assert.equal(projection.stressState, 'error');
    assert.equal(f.states.at(-1).state, 'error');
    assert.match(f.states.at(-1).message, /Run the plan to retry/);
  }
});

test('repeated navigation does not restart an unchanged in-flight calculation', async () => {
  const f = fixture();
  const run = f.controller.run();
  await f.controller.run();
  assert.equal(f.jobs.length, 1);
  f.jobs[0].resolve([{ result: {} }]);
  await run;
});

test('worker failure leaves explicit unavailable results and permits a later run', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  const run = f.controller.run();
  f.jobs[0].reject(new Error('Calculation worker could not run: module unavailable'));
  await run;
  assert.equal(f.scenarios[0].res, null);
  assert.match(f.scenarios[0].runError, /module unavailable/);
  assert.equal(f.states.at(-1).state, 'error');
  assert.equal(f.marked, 0);
  const retry = f.controller.run();
  f.jobs[1].resolve([{ result: {} }]);
  await retry;
  assert.equal(f.states.at(-1).state, 'complete');
});

test('state invalidation notifies on edits and household replacement but not completion', async () => {
  const { uiState, onScenarioInputsInvalidated } = await import('../state.js');
  let calls = 0;
  const unsubscribe = onScenarioInputsInvalidated(() => calls++);
  uiState.scenarios = [];
  uiState.plansDirty = true;
  uiState.plansDirty = true;
  uiState.plansDirty = false;
  unsubscribe();
  uiState.plansDirty = true;
  assert.equal(calls, 3);
});

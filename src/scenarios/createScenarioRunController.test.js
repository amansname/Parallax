import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan } from '../../engine.js';
import { createSelectableDefaultHouseholds } from '../../ui/householdFactories.js';
import { createScenarioRunController } from './createScenarioRunController.js';
import { generateReturnPath, resetSeed, resolveInputs } from '../../engine.js';
import { runScenarioBatch } from '../planning/runScenarioBatch.js';
import { applyScenarioPlanInputs } from './scenarioPlanInputs.js';
import { ACCOUNT_SCHEMA_VERSION } from '../household/accountTypes.js';

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
  assert.equal(f.scenarios[0].res.stress, undefined, 'retired Focus stress is not calculated');
  assert.equal(f.marked, 1);
  assert.equal(f.states.at(-1).state, 'complete');
  assert.equal(f.inputs.get(f.scenarios[0].res).plan.meta.householdId, f.plan.meta.householdId);
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

function reuseFixture() {
  const scenarios = [
    { name: 'Baseline', base: true, spend: 156000 },
    { name: 'Alternative', spend: 180000 },
    { name: 'Third', spend: 200000 },
  ];
  let paths = ['session-market-paths'];
  const f = fixture({ getScenarios: () => scenarios, ensurePaths: () => paths,
    prepareScenario: scenario => ({ plan: structuredClone(f.plan), overrides: { livingAnnual: scenario.spend } }),
  });
  return { ...f, scenarios, plan: f.plan, replacePaths() { paths = [...paths]; } };
}

async function complete(f, responses) {
  const run = f.controller.run();
  const job = f.jobs.at(-1);
  job.resolve(responses || job.batch.entries.map((entry, index) => ({ result: {
    name: entry.name, paths: { p50: { simIndex: index + 3 } }, value: entry.overrides.livingAnnual,
  } })));
  await run;
}

test('one edited alternative reruns alone and a fully unchanged run uses no worker', async () => {
  const f = reuseFixture();
  await complete(f);
  const original = f.scenarios.map(scenario => scenario.res);
  f.scenarios[1].spend++;
  f.controller.invalidate();
  await complete(f);
  assert.deepEqual(f.jobs[1].batch.entries.map(entry => entry.name), ['Alternative']);
  assert.equal(f.jobs[1].batch.baselineTypicalIndex, original[0].paths.p50.simIndex);
  assert.equal(f.scenarios[0].res, original[0]);
  assert.equal(f.scenarios[2].res, original[2]);
  assert.notEqual(f.scenarios[1].res, original[1]);
  f.controller.invalidate();
  await f.controller.run();
  assert.equal(f.jobs.length, 2);
  assert.equal(f.inputs.get(f.scenarios[0].res).overrides.livingAnnual, 156000);
});

test('baseline, shared plan, tax year, market bundle and household changes invalidate reuse', async () => {
  const f = reuseFixture();
  await complete(f);
  const changes = [
    () => f.scenarios[0].spend++,
    () => f.plan.goals[0].amount++,
    () => f.plan.meta.planningAsOfYear++,
    () => f.replacePaths(),
    () => { f.plan.meta.householdId = 'different-household'; },
  ];
  for (const change of changes) {
    change(); f.controller.invalidate(); await complete(f);
    assert.equal(f.jobs.at(-1).batch.entries.length, 3);
  }
});

test('a failed or unavailable alternative after a baseline edit cannot reuse its old anchor', async t => {
  t.mock.method(console, 'error', () => {});
  for (const failure of [{ error: { message: 'broken' } }, { result: { projectionStatus: 'unavailable' } }]) {
    const f = reuseFixture();
    await complete(f);
    const old = f.scenarios[1].res;
    f.scenarios[0].spend++;
    f.controller.invalidate();
    await complete(f, [
      { result: { paths: { p50: { simIndex: 99 } } } }, failure, { result: {} },
    ]);
    await complete(f);
    assert.deepEqual(f.jobs.at(-1).batch.entries.map(entry => entry.name), ['Alternative']);
    assert.equal(f.jobs.at(-1).batch.baselineTypicalIndex, 99);
    assert.notEqual(f.scenarios[1].res, old);
  }
});

test('cancelled completions never seed reuse; removal and renaming cannot misassign cached results', async () => {
  const f = reuseFixture();
  const cancelled = f.controller.run();
  f.controller.cancel();
  f.jobs[0].resolve(f.scenarios.map(() => ({ result: { cancelled: true } })));
  await cancelled;
  await complete(f);
  assert.equal(f.jobs[1].batch.entries.length, 3);
  const third = f.scenarios[2].res;
  f.scenarios.splice(1, 1);
  f.controller.invalidate();
  await f.controller.run();
  assert.equal(f.jobs.length, 2);
  assert.equal(f.scenarios[1].res, third);
  f.scenarios[1].name = 'Renamed';
  f.controller.invalidate(); await complete(f);
  assert.deepEqual(f.jobs.at(-1).batch.entries.map(entry => entry.name), ['Renamed']);
});

test('reused results match complete fresh canonical batches, including baseline account diagnostics', async () => {
  const f = reuseFixture();
  f.plan.simulation.iterations = 8;
  resetSeed(90210);
  const paths = Array.from({ length: 8 }, () => generateReturnPath(resolveInputs(f.plan, {}).horizonYears));
  const sizes = [];
  const controller = createScenarioRunController({
    getPlan: () => f.plan, getScenarios: () => f.scenarios, canRun: () => true,
    ensurePaths: () => paths,
    prepareScenario: scenario => ({ plan: structuredClone(f.plan), overrides: { livingAnnual: scenario.spend } }),
    inputsByResult: new WeakMap(), onState() {}, onResults() {}, markCurrent() {},
    client: { cancel() {}, async run(batch) {
      sizes.push(batch.entries.length);
      const results = []; runScenarioBatch(batch, response => results.push(structuredClone(response)));
      return results;
    } },
  });
  for (const change of [() => {}, () => f.scenarios[1].spend += 50000, () => {}, () => f.scenarios[0].spend += 70000]) {
    change(); controller.invalidate(); await controller.run();
    const expected = [];
    runScenarioBatch({ entries: f.scenarios.map(s => ({ name: s.name, base: s.base, plan: structuredClone(f.plan), overrides: { livingAnnual: s.spend } })), returnPaths: paths, baseTaxYear: 2026 }, r => expected.push(r.result));
    assert.deepEqual(f.scenarios.map(s => s.res), expected);
  }
  assert.deepEqual(sizes, [3, 1, 3]);
});

test('current-schema allocation lever changes rerun despite identical enumerable prepared plans', async () => {
  const scenarios = ['Baseline', 'Alternative'].map((name, index) => ({
    name, base: index === 0, lev: { retireAge: 65, ssAge: 67, spouseRetireAge: 65, spouseSsAge: 67, allocationPresetId: index ? 'balanced' : 'current' },
  }));
  const paths = ['shared-markets'];
  const f = fixture({ getScenarios: () => scenarios, ensurePaths: () => paths,
    prepareScenario: scenario => ({ plan: applyScenarioPlanInputs(f.plan, scenario.lev), overrides: {} }),
  });
  f.plan.meta.accountSchemaVersion = ACCOUNT_SCHEMA_VERSION;
  const first = f.controller.run();
  f.jobs[0].resolve([{ result: { paths: { p50: { simIndex: 2 } } } }, { result: { allocation: 'balanced' } }]);
  await first;
  const before = JSON.stringify(f.jobs[0].batch.entries[1].plan);
  scenarios[1].lev.allocationPresetId = 'aggressive';
  f.controller.invalidate();
  const changed = f.controller.run();
  assert.equal(f.jobs.length, 2, 'Allocation change must launch a new worker');
  assert.deepEqual(f.jobs[1].batch.entries.map(entry => entry.name), ['Alternative']);
  assert.equal(JSON.stringify(f.jobs[1].batch.entries[0].plan), before, 'Fixture must exercise transient allocation state');
  f.jobs[1].resolve([{ result: { allocation: 'aggressive' } }]);
  await changed;
  assert.equal(scenarios[1].res.allocation, 'aggressive');
});

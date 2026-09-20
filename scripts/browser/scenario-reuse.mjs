import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// Real visible edits, full 1,000 paths. Worker inventory proves avoided work;
// complete serialized outputs prove reuse is numerically identical.
export async function verifyScenarioReuse(page, artifactId) {
  const evidence = { editMs: [] };
  await page.evaluate(async id => {
    const { scenarios } = await import('/src/state.js?v=' + id);
    window.reuseOriginalResults = scenarios.map(s => JSON.stringify(s.res));
    window.reuseOriginalReferences = scenarios.map(s => s.res);
  }, artifactId);
  for (const direction of [1, -1, 1, -1]) {
    const workerCount = await page.evaluate(() => window.observedWorkers.length);
    const start = performance.now();
    await page.click(`.cmp-step-btn[data-scn-id="1"][data-lever-key="retireAge"][data-dir="${direction}"]`);
    await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'complete', { timeout: 30000 });
    evidence.editMs.push(performance.now() - start);
    const observed = await page.evaluate(async id => {
      const { scenarios } = await import('/src/state.js?v=' + id);
      return {
        workerCount: window.observedWorkers.length,
        names: window.observedWorkers.at(-1).names,
        unchangedReferences: [0, 2].every(index => scenarios[index].res === window.reuseOriginalReferences[index]),
        unchangedOutputs: [0, 2].every(index => JSON.stringify(scenarios[index].res) === window.reuseOriginalResults[index]),
      };
    }, artifactId);
    assert.equal(observed.workerCount, workerCount + 1);
    assert.deepEqual(observed.names, ['Scenario B']);
    assert.ok(observed.unchangedReferences && observed.unchangedOutputs, 'Unchanged scenarios were recomputed or changed outputs');
  }
  assert.equal(await page.evaluate(async id => {
    const { scenarios } = await import('/src/state.js?v=' + id);
    return scenarios.every((s, index) => JSON.stringify(s.res) === window.reuseOriginalResults[index]);
  }, artifactId), true, 'Restoring the edit must restore the full canonical results');

  const allocation = '.cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]';
  const currentValue = await page.$eval(allocation, select => select.value);
  const workersBefore = await page.evaluate(() => window.observedWorkers.length);
  const repeatStart = performance.now();
  await page.select(allocation, currentValue);
  await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'complete', { timeout: 30000 });
  evidence.unchangedMs = performance.now() - repeatStart;
  assert.equal(await page.evaluate(() => window.observedWorkers.length), workersBefore, 'Identical inputs must not launch another worker');

  evidence.allocations = [];
  for (const preset of ['balanced', 'aggressive']) {
    await page.select(allocation, preset);
    await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'complete', { timeout: 30000 });
    const observation = await page.evaluate(async ({ id, preset }) => {
      const { scenarios, sharedPaths } = await import('/src/state.js?v=' + id);
      const { defaultPlan: plan } = await import('/engine.js?v=' + id);
      const { planForScenario, leversToOverrides } = await import('/src/scenarios/scenarioConfiguration.js?v=' + id);
      const { runFederalFundingSimulation } = await import('/src/planning/tax/runMonteCarloWithFederalFunding.js?v=' + id);
      const scenario = scenarios[1];
      const prepared = planForScenario(scenario.lev);
      const expected = runFederalFundingSimulation(prepared, leversToOverrides(scenario.lev), sharedPaths, {
        baseTaxYear: plan.meta.planningAsOfYear, scenarioId: scenario.name, filingStatus: prepared.meta.filingStatus,
        accountDiagnosticsSimIndices: [scenarios[0].res.paths.p50.simIndex],
      });
      return { preset, identical: JSON.stringify(expected) === JSON.stringify(scenario.res),
        column: document.querySelectorAll('#scn-view .scol')[1].textContent,
        result: JSON.stringify(scenario.res), names: window.observedWorkers.at(-1).names };
    }, { id: artifactId, preset });
    assert.equal(observation.identical, true, `${preset} worker result must equal complete direct canonical result`);
    assert.deepEqual(observation.names, ['Scenario B']);
    evidence.allocations.push(observation);
  }
  assert.notEqual(evidence.allocations[0].result, evidence.allocations[1].result, 'Selected allocations must change calculated results');
  assert.notEqual(evidence.allocations[0].column, evidence.allocations[1].column, 'Selected allocations must change visible financial output');
  for (const observation of evidence.allocations) delete observation.result;
  await page.select(allocation, currentValue);
  await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'complete', { timeout: 30000 });

  // A baseline edit must rebuild every alternative's baseline account anchor.
  await page.click('.cmp-step-btn[data-scn-id="0"][data-lever-key="retireAge"][data-dir="1"]');
  await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'complete', { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => window.observedWorkers.at(-1).names), ['Baseline', 'Scenario B', 'Aggressive']);
  await page.click('.cmp-step-btn[data-scn-id="0"][data-lever-key="retireAge"][data-dir="-1"]');
  await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'complete', { timeout: 30000 });
  assert.equal(await page.evaluate(async id => {
    const { scenarios, sharedPaths } = await import('/src/state.js?v=' + id);
    return sharedPaths.length === 1000 && scenarios.every((s, index) => JSON.stringify(s.res) === window.reuseOriginalResults[index]);
  }, artifactId), true, 'A full rebuild must retain the same 1,000-path outputs');
  return evidence;
}

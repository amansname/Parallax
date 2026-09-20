import { resolveInputs } from '../../engine.js';
import { scenarioWorkerError } from '../planning/runScenarioBatch.js';
import { createScenarioWorkerClient } from './createScenarioWorkerClient.js';
import { scenarioProjectionIssueMessage, scenarioRunFailureMessage } from './projectionMessages.js';
import { scenarioRunKey } from './scenarioRunKey.js';
import { snapshotTransientProjectionAccountState } from '../household/transientProjectionAccountState.js';

export function createScenarioRunController({
  getPlan, getScenarios, canRun, prepareScenario, ensurePaths, inputsByResult,
  onState, onResults, markCurrent,
  client = createScenarioWorkerClient(),
}) {
  let generation = 0;
  let running = false;
  let cachedPaths, cachedHousehold, cachedBaseline;
  const completed = new Map();
  function clearResults(message) {
    for (const scenario of getScenarios()) {
      scenario.res = null;
      scenario.runError = message;
    }
  }
  function invalidate(state = 'stale', message = 'Inputs changed · run to update') {
    generation++;
    running = false;
    client.cancel();
    clearResults(message);
    onState(state, message);
    onResults();
  }
  async function run() {
    if (running) return;
    const current = ++generation;
    client.cancel();
    if (!canRun()) { onState('unavailable', 'Restore household storage before running projections'); return; }
    running = true;
    const scenarios = getScenarios();
    const plan = getPlan();
    try {
      clearResults('Calculating…');
      onState('running', 'Running…');
      onResults();
      const preflight = resolveInputs(plan, {});
      if (preflight.simulationAvailable === false) {
        clearResults('Complete Family dates before running projections');
        markCurrent();
        onState('unavailable', 'Plan updated · using available inputs');
        onResults();
        return;
      }
      if (!(preflight.horizonYears > 0)) {
        clearResults('End age must be after current age');
        onState('error', 'Check plan: end age must be after current age');
        onResults();
        return;
      }
      const returnPaths = ensurePaths(preflight);
      const entries = scenarios.map(scenario => {
        try { return { name: scenario.name, base: scenario.base, ...prepareScenario(scenario) }; }
        catch (error) { return { name: scenario.name, base: scenario.base, error: scenarioWorkerError(error) }; }
      });
      const baseTaxYear = Number.isInteger(plan.meta?.planningAsOfYear) ? plan.meta.planningAsOfYear : new Date().getFullYear();
      // Include the source levers as well: allocation presets can be attached
      // to the prepared plan through transient (non-enumerable) account state.
      const keys = entries.map((entry, index) => entry.error ? null : scenarioRunKey({
        entry, levers: scenarios[index].lev, projectionAccountState: snapshotTransientProjectionAccountState(entry.plan),
      }, baseTaxYear));
      // Alternatives retain account detail for the baseline-selected path. A
      // baseline change invalidates the entire set, even if an alternative's
      // own inputs did not change. Never mix generations after a partial run.
      const baselineKey = entries[0]?.base && entries.filter(entry => entry.base).length === 1 ? keys[0] : null;
      const household = plan.meta?.householdId;
      if (!baselineKey || cachedPaths !== returnPaths || cachedHousehold !== household || cachedBaseline !== baselineKey) completed.clear();
      cachedPaths = returnPaths;
      cachedHousehold = household;
      cachedBaseline = baselineKey;
      for (const scenario of completed.keys()) if (!scenarios.includes(scenario)) completed.delete(scenario);
      const baseline = completed.get(scenarios[0]);
      if (!baseline || baseline.key !== baselineKey) completed.clear();
      const results = [];
      const pending = [];
      for (const [index, scenario] of scenarios.entries()) {
        const hit = completed.get(scenario);
        if (keys[index] && hit?.key === keys[index]) results[index] = { result: hit.result };
        else {
          completed.delete(scenario);
          pending.push(index);
        }
      }
      const responses = pending.length ? await client.run({ entries: pending.map(index => entries[index]), returnPaths,
        baseTaxYear, baselineTypicalIndex: baseline?.result.paths?.p50?.simIndex,
      }, (done, total) => {
        if (current === generation) onState('running', `Running… ${done} of ${total} scenarios`);
      }) : [];
      if (current !== generation) return;
      for (const [index, response] of responses.entries()) results[pending[index]] = response;
      let failed = 0;
      for (const [index, response] of results.entries()) {
        const scenario = scenarios[index];
        const entry = entries[index];
        if (response.error) {
          scenario.res = null;
          scenario.runError = scenarioRunFailureMessage(response.error);
          failed++;
          console.error('Scenario failed:', scenario.name, response.error);
          continue;
        }
        const result = response.result;
        inputsByResult.set(result, Object.freeze({ plan: entry.plan, overrides: Object.freeze({ ...entry.overrides }) }));
        scenario.res = result;
        if (result.projectionStatus === 'unavailable') {
          scenario.runError = scenarioProjectionIssueMessage(result);
          failed++;
          console.error('Scenario unavailable:', scenario.name, result.issue, 'age', result.issueAge);
          continue;
        }
        scenario.runError = null;
        if (keys[index]) completed.set(scenario, { key: keys[index], result });
      }
      markCurrent();
      const firstFailure = scenarios.find(scenario => scenario.runError)?.runError;
      onState(failed ? 'error' : 'complete', failed
        ? `Partial run · ${failed} scenario${failed > 1 ? 's' : ''} could not run${firstFailure ? `: ${firstFailure}` : ''}`
        : 'Plan updated · using available inputs');
      onResults({ completed: true });
    } catch (error) {
      if (current !== generation || error?.code === 'SCENARIO_RUN_SUPERSEDED') return;
      const reason = error.message?.startsWith('Calculation worker') ? error.message : scenarioRunFailureMessage(error);
      clearResults(reason);
      onState('error', `Check plan: ${reason}`);
      onResults();
      console.error(error);
    } finally {
      if (current === generation) running = false;
    }
  }
  return {
    run, invalidate,
    cancel: () => invalidate('cancelled', 'Calculation cancelled · run to update'),
    get running() { return running; },
  };
}

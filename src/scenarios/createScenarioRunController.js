import { resolveInputs } from '../../engine.js';
import { scenarioWorkerError } from '../planning/runScenarioBatch.js';
import { createScenarioWorkerClient } from './createScenarioWorkerClient.js';
import { scenarioProjectionIssueMessage, scenarioRunFailureMessage } from './projectionMessages.js';

export function createScenarioRunController({
  getPlan, getScenarios, canRun, prepareScenario, ensurePaths, inputsByResult,
  onState, onResults, markCurrent,
  client = createScenarioWorkerClient(),
}) {
  let generation = 0;
  let running = false;
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
      const results = await client.run({ entries, returnPaths,
        baseTaxYear: Number.isInteger(plan.meta?.planningAsOfYear) ? plan.meta.planningAsOfYear : new Date().getFullYear(),
      }, (done, total) => {
        if (current === generation) onState('running', `Running… ${done} of ${total} scenarios`);
      });
      if (current !== generation) return;
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

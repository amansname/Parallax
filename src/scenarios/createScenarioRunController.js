import { resolveInputs } from '../../engine.js';
import { scenarioWorkerError } from '../planning/runScenarioBatch.js';
import { createScenarioWorkerClient } from './createScenarioWorkerClient.js';
import { scenarioProjectionIssueMessage, scenarioRunFailureMessage } from './projectionMessages.js';
import { STRESS_ERAS } from './historicalStress.js';

export function createScenarioRunController({
  getPlan, getScenarios, canRun, prepareScenario, ensurePaths, inputsByResult,
  onState, onResults, markCurrent,
  client = createScenarioWorkerClient(),
  createStressClient = createScenarioWorkerClient,
}) {
  let generation = 0;
  let running = false;
  const stressJobs = new Set();
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
    for (const job of stressJobs) job.cancel();
    stressJobs.clear();
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
  async function requestStress(scenario) {
    const result = scenario?.res;
    const inputs = result && inputsByResult.get(result);
    if (!inputs || result.projectionStatus === 'unavailable' || result.stressState) return;
    const current = generation;
    const job = createStressClient();
    stressJobs.add(job);
    result.stressState = 'running';
    try {
      // Historical handoff reads only the selected path and envelope. Carry
      // their exact engine output without copying the full Monte Carlo batch.
      const [response] = await job.run({ kind: 'stress', entries: [{
        name: scenario.name, ...inputs,
        analysis: { paths: { p50: result.paths.p50 }, envelope: result.envelope },
      }] });
      if (current !== generation || scenario.res !== result) return;
      if (response.error) throw new Error(response.error.message);
      if (response.result.stress?.length !== STRESS_ERAS.length) {
        throw new Error(`Expected ${STRESS_ERAS.length} historical periods; received ${response.result.stress?.length || 0}`);
      }
      result.stress = response.result.stress;
      result.stressState = 'complete';
    } catch (error) {
      if (current !== generation || scenario.res !== result) return;
      result.stressState = 'error';
      result.stressError = `Historical stress could not run: ${error.message}. Run the plan to retry.`;
      onState('error', result.stressError);
    } finally {
      stressJobs.delete(job);
      if (current === generation && scenario.res === result) onResults();
    }
  }
  return {
    run, invalidate, requestStress,
    cancel: () => invalidate('cancelled', 'Calculation cancelled · run to update'),
    get running() { return running; },
  };
}

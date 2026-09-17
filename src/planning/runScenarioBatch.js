import { runFederalFundingSimulation } from './tax/runMonteCarloWithFederalFunding.js';
import { computeHistoricalStress } from '../scenarios/historicalStress.js';

export function scenarioWorkerError(error) {
  return {
    name: error?.name || 'Error', message: error?.message || String(error),
    code: error?.code, rmdIssue: error?.rmdIssue, age: error?.age,
  };
}

// Execute the existing canonical calculation, in the same scenario order.
// The baseline-selected path remains the account-detail anchor for alternatives.
export function runScenarioBatch({ entries, returnPaths, baseTaxYear }, emit) {
  let baselineTypicalIndex;
  for (const [index, entry] of entries.entries()) {
    if (entry.error) { emit({ index, error: entry.error }); continue; }
    try {
      const result = runFederalFundingSimulation(entry.plan, entry.overrides, returnPaths, {
        baseTaxYear, scenarioId: entry.name, filingStatus: entry.plan.meta?.filingStatus,
        accountDiagnosticsSimIndices: !entry.base && Number.isInteger(baselineTypicalIndex) ? [baselineTypicalIndex] : [],
      });
      if (entry.base) baselineTypicalIndex = result.paths?.p50?.simIndex;
      emit({ index, result });
    } catch (error) {
      emit({ index, error: scenarioWorkerError(error) });
    }
  }
}

export function runHistoricalStressBatch({ entries }, emit) {
  for (const [index, entry] of entries.entries()) {
    try {
      const stress = computeHistoricalStress(
        { name: entry.name, res: entry.analysis }, entry.plan, entry.overrides,
      );
      emit({ index, result: { stress } });
    } catch (error) {
      emit({ index, error: scenarioWorkerError(error) });
    }
  }
}

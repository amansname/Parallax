import { runScenarioBatch, runHistoricalStressBatch, scenarioWorkerError } from './runScenarioBatch.js';

self.onmessage = ({ data }) => {
  const { requestId, batch } = data;
  try {
    const run = batch.kind === 'stress' ? runHistoricalStressBatch : runScenarioBatch;
    run(batch, result => self.postMessage({ kind: 'scenario', requestId, ...result }));
    self.postMessage({ kind: 'complete', requestId });
  } catch (error) {
    self.postMessage({ kind: 'error', requestId, error: scenarioWorkerError(error) });
  }
};

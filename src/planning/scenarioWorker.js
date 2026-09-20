import { runScenarioBatch, scenarioWorkerError } from './runScenarioBatch.js';

self.onmessage = ({ data }) => {
  const { requestId, batch } = data;
  try {
    if (batch.kind && batch.kind !== 'scenarios') {
      throw new Error(`Unsupported scenario batch kind: ${batch.kind}`);
    }
    runScenarioBatch(batch, result => self.postMessage({ kind: 'scenario', requestId, ...result }));
    self.postMessage({ kind: 'complete', requestId });
  } catch (error) {
    self.postMessage({ kind: 'error', requestId, error: scenarioWorkerError(error) });
  }
};

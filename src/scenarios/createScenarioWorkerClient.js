function superseded() {
  const error = new Error('Calculation superseded by newer inputs');
  error.name = 'AbortError';
  error.code = 'SCENARIO_RUN_SUPERSEDED';
  return error;
}

function defaultWorker() {
  return new Worker(new URL('../planning/scenarioWorker.js?v=__PARALLAX_ARTIFACT_ID__', import.meta.url), {
    type: 'module', name: 'parallax-scenarios',
  });
}

export function createScenarioWorkerClient({ createWorker = defaultWorker } = {}) {
  let active = null;
  let sequence = 0;
  function cancel() {
    if (active) active.finish(superseded());
  }
  function run(batch, onProgress = () => {}) {
    cancel();
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = createWorker(); }
      catch (error) { reject(new Error(`Calculation worker could not start: ${error.message}`)); return; }
      const requestId = ++sequence;
      const results = new Map();
      const job = { finish(error) {
        if (active !== job) return;
        active = null;
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        if (error) reject(error);
        else resolve(batch.entries.map((_, index) => results.get(index)));
      } };
      active = job;
      worker.onmessage = ({ data }) => {
        if (active !== job || data?.requestId !== requestId) return;
        if (data.kind === 'scenario') {
          const hasResult = data.result !== null && typeof data.result === 'object';
          const hasError = typeof data.error?.message === 'string';
          if (!Number.isInteger(data.index) || data.index < 0 || data.index >= batch.entries.length
              || results.has(data.index) || hasResult === hasError) {
            job.finish(new Error('Calculation worker returned an invalid scenario response'));
          } else {
            results.set(data.index, data);
            onProgress(results.size, batch.entries.length);
          }
        } else if (data.kind === 'complete') {
          job.finish(results.size === batch.entries.length ? null : new Error('Calculation worker returned an incomplete scenario batch'));
        } else if (data.kind === 'error') {
          job.finish(Object.assign(new Error(data.error?.message || 'Calculation worker failed'), data.error));
        } else job.finish(new Error('Calculation worker returned an unknown response'));
      };
      worker.onerror = event => {
        event.preventDefault?.();
        job.finish(new Error(`Calculation worker could not run: ${event.message || 'worker startup failed'}`));
      };
      worker.onmessageerror = () => job.finish(new Error('Calculation worker response could not be read'));
      try { worker.postMessage({ requestId, batch }); }
      catch (error) { job.finish(new Error(`Calculation worker inputs could not be sent: ${error.message}`)); }
    });
  }
  return { run, cancel };
}

// Presentation for the asynchronous calculation lifecycle. No financial math.
export function syncScenarioRunStatus(state, message) {
  document.documentElement.dataset.scenarioRunState = state;
  const run = document.querySelector('#run-btn');
  run.disabled = state === 'running';
  const panel = document.querySelector('#scn-calculation');
  panel.hidden = state === 'complete';
  panel.dataset.state = state;
  document.querySelector('#scn-calculation-status').textContent = message;
  const action = document.querySelector('#scn-run-action');
  action.textContent = state === 'running' ? 'Cancel' : 'Run';
  action.disabled = state === 'unavailable';
}

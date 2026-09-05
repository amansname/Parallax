const REMOVED_SCENARIO_LEVER_KEYS = Object.freeze(['sellAge']);

export function withoutRemovedScenarioLevers(levers){
  const clean = (levers && typeof levers === 'object' && !Array.isArray(levers))
    ? { ...levers }
    : {};
  REMOVED_SCENARIO_LEVER_KEYS.forEach(key => { delete clean[key]; });
  return clean;
}

export function baselineSnapshotForScenarios(defaults, scenarios){
  const currentDefaults = withoutRemovedScenarioLevers(defaults);
  const savedBaseline = Array.isArray(scenarios)
    ? scenarios.find(scenario => scenario?.base === true)?.lev
    : null;
  const priorSavings = Number(savedBaseline?.savings);
  if(!Number.isFinite(priorSavings)) return currentDefaults;
  return { ...currentDefaults, savings: priorSavings };
}

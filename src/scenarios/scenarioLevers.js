const REMOVED_SCENARIO_LEVER_KEYS = Object.freeze(['sellAge']);

export function withoutRemovedScenarioLevers(levers){
  const clean = (levers && typeof levers === 'object' && !Array.isArray(levers))
    ? { ...levers }
    : {};
  REMOVED_SCENARIO_LEVER_KEYS.forEach(key => { delete clean[key]; });
  return clean;
}

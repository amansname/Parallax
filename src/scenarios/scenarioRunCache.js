import { resolveInputs } from '../../engine.js';

/** Reuse only a scenario's last successful run on its unchanged session paths. */
export function createScenarioRunCache(){
  const runs = new WeakMap();
  return {
    key(plan, overrides, taxOptions){
      // Allocation overrides can live outside the plan in a WeakMap. Include
      // engine-resolved inputs as well as saved facts and tax-sidecar options.
      return JSON.stringify({
        plan,
        overrides,
        taxOptions,
        resolved: resolveInputs(plan, overrides),
      });
    },
    matches(scenario, paths, key){
      const previous = runs.get(scenario);
      return Boolean(previous
        && previous.paths === paths
        && previous.pathCount === paths.length
        && previous.key === key
        && previous.result === scenario.res
        && scenario.res
        && scenario.res.projectionStatus !== 'unavailable'
        && !scenario.runError);
    },
    remember(scenario, paths, key){
      runs.set(scenario, { paths, pathCount: paths.length, key, result: scenario.res });
    },
  };
}

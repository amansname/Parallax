import { defaultPlan as plan } from '../../engine.js';
import { scenarios } from '../state.js';
function remapGoalOverridesForRemoval(index) {
  if (!Array.isArray(scenarios)) return [];
  return scenarios.map((scenario, scenarioIndex) => {
    const current = scenario?.lev?.goalOv;
    if (!current) return {
      scenarioIndex,
      override: null
    };
    const next = {};
    let removed = null;
    Object.entries(current).forEach(([key, value]) => {
      const goalIndex = +key;
      if (goalIndex === index) {
        removed = JSON.parse(JSON.stringify(value));
        return;
      }
      next[goalIndex > index ? goalIndex - 1 : goalIndex] = value;
    });
    if (Object.keys(next).length) scenario.lev.goalOv = next;else delete scenario.lev.goalOv;
    return {
      scenarioIndex,
      override: removed
    };
  });
}
export function insertGoalAt(index, goal, restoredOverrides = []) {
  if (!Array.isArray(plan.goals)) plan.goals = [];
  const at = Math.max(0, Math.min(index, plan.goals.length));
  plan.goals.splice(at, 0, goal);
  if (!Array.isArray(scenarios)) return;
  const restoredByScenario = new Map(restoredOverrides.map(item => [item.scenarioIndex, item.override]));
  scenarios.forEach((scenario, scenarioIndex) => {
    if (!scenario?.lev) return;
    const current = scenario.lev.goalOv || {};
    const next = {};
    Object.entries(current).forEach(([key, value]) => {
      const goalIndex = +key;
      next[goalIndex >= at ? goalIndex + 1 : goalIndex] = value;
    });
    const restored = restoredByScenario.get(scenarioIndex);
    if (restored) next[at] = restored;
    if (Object.keys(next).length) scenario.lev.goalOv = next;else delete scenario.lev.goalOv;
  });
}
export function removeGoalAt(index) {
  if (!Array.isArray(plan.goals) || !plan.goals[index]) return {
    goal: null,
    overrides: []
  };
  const [goal] = plan.goals.splice(index, 1);
  return {
    goal,
    overrides: remapGoalOverridesForRemoval(index)
  };
}

import { resolveEffectiveGoal } from '../src/goals/horizonModel.js';

export function effectiveGoalForView(goal, span){
  const resolved = resolveEffectiveGoal(goal, null, span.retirementAge);
  const startAge = Number.isFinite(Number(resolved.startAge))
    ? Number(resolved.startAge) : span.retirementAge;
  const requestedEnd = Number.isFinite(Number(resolved.endAge))
    ? Number(resolved.endAge) : span.planEndAge;
  return { ...goal, startAge, endAge: Math.max(startAge, Math.min(requestedEnd, span.planEndAge)) };
}

export function materializeGoalTiming(goal, span, { detachFromRetirement = false } = {}){
  const effective = effectiveGoalForView(goal, span);
  goal.startAge = effective.startAge;
  goal.endAge = effective.endAge;
  if(detachFromRetirement) goal.startsAtRetirement = false;
  return goal;
}

import {
  GOAL_CATEGORY_MAP, goalDisplayAmount, isOneTimeGoal, resolveEffectiveGoal,
  setGoalDisplayAmount, setGoalKind, setGoalPer, setGoalRange,
} from './horizonModel.js';

export function effectiveGoalForView(goal, span){
  const resolved = resolveEffectiveGoal(goal, null, span.retirementAge);
  const startAge = Number.isFinite(Number(resolved.startAge)) ? Number(resolved.startAge) : span.retirementAge;
  const requestedEnd = Number.isFinite(Number(resolved.endAge)) ? Number(resolved.endAge) : span.planEndAge;
  return { ...goal, startAge, endAge: Math.max(startAge, Math.min(requestedEnd, span.planEndAge)) };
}

function materializeTiming(goal, span){
  const effective = effectiveGoalForView(goal, span);
  goal.startAge = effective.startAge;
  goal.endAge = effective.endAge;
  goal.startsAtRetirement = false;
}

// Shared typed edits for durable desktop changes and unsaved phone drafts.
// These use the existing goal model; they do not calculate projected spending.
export function applyGoalEdit(goal, edit, span){
  switch(edit.type){
    case 'name': goal.name = String(edit.value); break;
    case 'amount': setGoalDisplayAmount(goal, edit.value); break;
    case 'amount-step': {
      const once = isOneTimeGoal(effectiveGoalForView(goal, span));
      const step = once ? (goalDisplayAmount(goal) >= 100000 ? 25000 : 5000) : goal.per === 'mo' ? 250 : 1000;
      setGoalDisplayAmount(goal, Math.max(0, goalDisplayAmount(goal) + step * edit.direction));
      break;
    }
    case 'per': setGoalPer(goal, edit.value); break;
    case 'funding': goal.fundFromPortfolioBeforeRetirement = edit.value === true; break;
    case 'category': {
      const category = GOAL_CATEGORY_MAP[edit.value] ? edit.value : 'custom';
      goal.cat = category; goal.area = category; break;
    }
    case 'kind':
      materializeTiming(goal, span);
      setGoalKind(goal, edit.value, span.planEndAge);
      break;
    case 'range': {
      const effective = effectiveGoalForView(goal, span);
      if(edit.edge === 'end' && goal.startsAtRetirement === true && edit.value < effective.startAge){
        throw new Error(`End age must be ${effective.startAge} or later for a goal that starts at retirement.`);
      }
      if(edit.edge !== 'end') goal.startsAtRetirement = false;
      const start = edit.edge === 'end' ? effective.startAge : edit.value;
      const end = edit.edge === 'end' ? edit.value : edit.edge === 'once' || isOneTimeGoal(effective) ? edit.value : effective.endAge;
      setGoalRange(goal, start, end, span.planEndAge, edit.edge);
      if(isOneTimeGoal(goal)) setGoalPer(goal, 'yr');
      break;
    }
    case 'preset':
      goal.startsAtRetirement = false;
      setGoalRange(goal, edit.from, edit.to, span.planEndAge);
      if(isOneTimeGoal(goal)) setGoalPer(goal, 'yr');
      break;
    case 'age-step': {
      materializeTiming(goal, span);
      const age = goal.startAge + edit.direction;
      setGoalRange(goal, age, age, span.planEndAge);
      setGoalPer(goal, 'yr'); break;
    }
    default: throw new Error(`Unknown goal edit: ${edit.type}`);
  }
  return goal;
}

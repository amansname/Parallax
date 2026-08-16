export const GOAL_CATEGORIES = Object.freeze([
  Object.freeze({ key:'travel', label:'Travel', color:'#c6a662' }),
  Object.freeze({ key:'home', label:'Home', color:'#8fa57e' }),
  Object.freeze({ key:'vehicle', label:'Vehicle', color:'#7f98ab' }),
  Object.freeze({ key:'education', label:'Education', color:'#9a8fc0' }),
  Object.freeze({ key:'family', label:'Family', color:'#c0795f' }),
  Object.freeze({ key:'giving', label:'Giving', color:'#cd9a52' }),
  Object.freeze({ key:'health', label:'Healthcare', color:'#7ea5a0' }),
  Object.freeze({ key:'custom', label:'Custom', color:'#878e96' }),
]);

export const GOAL_CATEGORY_MAP = Object.freeze(
  Object.fromEntries(GOAL_CATEGORIES.map(category => [category.key, category]))
);

const LEGACY_CATEGORY_MAP = Object.freeze({
  purpose: 'custom',
  other: 'custom',
});

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function resolveGoalSpan(plan){
  const household = plan?.household || {};
  const primary = household.primary || {};
  const currentAge = Number.isFinite(+primary.currentAge) ? +primary.currentAge : 62;
  let retireAge = Number.isFinite(+primary.retirementAge) ? +primary.retirementAge : 65;
  let planEndAge = Number.isFinite(+primary.planEndAge) ? +primary.planEndAge : 95;
  const spouse = household.spouse;
  if(spouse && Number.isFinite(+spouse.currentAge) && Number.isFinite(+spouse.retirementAge)){
    retireAge = Math.max(retireAge, currentAge + (+spouse.retirementAge - +spouse.currentAge));
  }
  if(spouse && Number.isFinite(+spouse.planEndAge)){
    planEndAge = Math.max(planEndAge, +spouse.planEndAge);
  }
  const endAge = Math.max(50, Math.round(planEndAge));
  const retirementAge = clamp(Math.round(retireAge), 50, endAge);
  return {
    currentAge: Math.max(50, Math.round(currentAge)),
    retirementAge,
    planEndAge: endAge,
    axisMin: 62,
    axisMax: Math.max(96, endAge + 1),
  };
}

export function resolveScenarioHouseholdRetirementAge(plan, scenarioPrimaryRetirementAge){
  const planPrimaryRetirementAge = Number(plan?.household?.primary?.retirementAge);
  const scenarioRetirementAge = Number(scenarioPrimaryRetirementAge);
  const householdRetirementAge = resolveGoalSpan(plan).retirementAge;
  if(!Number.isFinite(planPrimaryRetirementAge) || !Number.isFinite(scenarioRetirementAge)){
    return householdRetirementAge;
  }
  return householdRetirementAge + (scenarioRetirementAge - planPrimaryRetirementAge);
}

export function goalHasFutureWorkingYears(goal, span){
  const currentAge = Number(span?.currentAge);
  const retirementAge = Number(span?.retirementAge);
  const startAge = Number(goal?.startAge);
  const endAge = Number(goal?.endAge);
  if(![currentAge, retirementAge, startAge, endAge].every(Number.isFinite)){
    return false;
  }
  return Math.max(currentAge,startAge) <= Math.min(endAge,retirementAge - 1);
}

export function resolveEffectiveGoal(baseGoal, override, householdRetirementAge){
  return {
    amount: override?.amount != null ? override.amount : (baseGoal.amount || 0),
    startAge: override?.startAge != null
      ? override.startAge
      : (baseGoal.startsAtRetirement === true
          ? householdRetirementAge
          : baseGoal.startAge),
    endAge: override?.endAge != null ? override.endAge : baseGoal.endAge,
  };
}

export function normalizeGoalCategory(goal){
  const requested = goal?.cat || goal?.area || '';
  if(GOAL_CATEGORY_MAP[requested]) return requested;
  const name=String(goal?.name || '').toLowerCase();
  if(/travel|vacation|trip|cruise/.test(name)) return 'travel';
  if(/home|house|renovat|remodel|property/.test(name)) return 'home';
  if(/vehicle|car|auto|boat/.test(name)) return 'vehicle';
  if(/education|college|school|tuition/.test(name)) return 'education';
  if(/family|wedding|grandchild|child/.test(name)) return 'family';
  if(/giving|charity|donat|gift/.test(name)) return 'giving';
  if(/health|medical|care/.test(name)) return 'health';
  const mapped = LEGACY_CATEGORY_MAP[requested] || requested;
  return GOAL_CATEGORY_MAP[mapped] ? mapped : 'custom';
}

export function ensureGoalMetadata(goals, idFactory = defaultGoalId){
  let changed = false;
  const seen = new Set();
  goals.forEach((goal, index) => {
    let id = typeof goal.id === 'string' && goal.id.trim() ? goal.id.trim() : '';
    if(!id || seen.has(id)){
      id = idFactory(index);
      goal.id = id;
      changed = true;
    }
    seen.add(id);
    const cat = normalizeGoalCategory(goal);
    if(goal.cat !== cat){ goal.cat = cat; changed = true; }
    if(goal.area !== cat){ goal.area = cat; changed = true; }
    const per = goal.per === 'mo' ? 'mo' : 'yr';
    if(goal.per !== per){ goal.per = per; changed = true; }
  });
  return changed;
}

export function defaultGoalId(index = 0){
  if(globalThis.crypto?.randomUUID) return `goal_${globalThis.crypto.randomUUID()}`;
  return `goal_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2,8)}`;
}

export const isOneTimeGoal = goal => +goal.startAge === +goal.endAge;
export const goalAnnualAmount = goal => Math.max(0, Math.round(+goal.amount || 0));
export const goalDisplayAmount = goal => goal?.per === 'mo'
  ? Math.round(goalAnnualAmount(goal) / 12)
  : goalAnnualAmount(goal);

export function setGoalDisplayAmount(goal, value){
  const entered = clamp(Math.round(+value || 0), 0, 99_000_000);
  goal.amount = goal.per === 'mo' ? entered * 12 : entered;
  return goal;
}

export function setGoalPer(goal, nextPer){
  if(isOneTimeGoal(goal)){
    goal.per = 'yr';
    return goal;
  }
  // Cadence is presentation only. The canonical amount always remains annual;
  // switching views must never round or rewrite the plan's economics.
  goal.per = nextPer === 'mo' ? 'mo' : 'yr';
  return goal;
}

export function setGoalKind(goal, kind, planEndAge){
  const end = Math.max(50, Math.round(+planEndAge || 95));
  const start = clamp(Math.round(+goal.startAge || 65), 50, end);
  goal.startAge = start;
  if(kind === 'once'){
    goal.endAge = start;
    goal.per = 'yr';
  }else if(isOneTimeGoal(goal)){
    goal.endAge = Math.min(start + 9, end);
  }
  return goal;
}

export function setGoalRange(goal, startAge, endAge, planEndAge, changedEdge = 'start'){
  const max = Math.max(50, Math.round(+planEndAge || 95));
  let start = clamp(Math.round(+startAge || 50), 50, max);
  let end = clamp(Math.round(+endAge || start), 50, max);
  if(start > end){
    if(changedEdge === 'end') start = end;
    else end = start;
  }
  goal.startAge = start;
  goal.endAge = end;
  return goal;
}

export function shiftGoal(goal, deltaYears, { dragMin = 62, planEndAge = 95 } = {}){
  const max = Math.max(dragMin, Math.round(+planEndAge || 95));
  const delta = Math.round(+deltaYears || 0);
  if(isOneTimeGoal(goal)){
    const age = clamp(Math.round(+goal.startAge || dragMin) + delta, dragMin, max);
    goal.startAge = age;
    goal.endAge = age;
    return goal;
  }
  const duration = Math.max(0, Math.round(+goal.endAge || 0) - Math.round(+goal.startAge || 0));
  const from = clamp(Math.round(+goal.startAge || dragMin) + delta, dragMin, Math.max(dragMin, max - duration));
  goal.startAge = from;
  goal.endAge = from + duration;
  return goal;
}

export function goalPct(age, axisMin = 62, axisMax = 96){
  const min = +axisMin;
  const max = Math.max(min + 1, +axisMax);
  return ((clamp(+age, min, max) - min) / (max - min)) * 100;
}

export function goalTimingLabel(goal){
  return isOneTimeGoal(goal)
    ? `At age ${goal.startAge}`
    : `Every year, ages ${goal.startAge}–${goal.endAge}`;
}

export function formatGoalAmount(goal){
  const value = goalDisplayAmount(goal);
  let amount;
  if(value >= 995_000) amount = `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  else if(value >= 1_000) amount = `$${Math.round(value / 1_000)}k`;
  else amount = `$${Math.round(value)}`;
  if(isOneTimeGoal(goal)) return amount;
  return `${amount} / ${goal.per === 'mo' ? 'mo' : 'yr'}`;
}

export function createGoalForCategory(categoryKey, span, idFactory = defaultGoalId){
  const cat = GOAL_CATEGORY_MAP[categoryKey] ? categoryKey : 'custom';
  const retirement = span.retirementAge;
  const end = span.planEndAge;
  const once = (name, amount, age) => ({
    id:idFactory(), name, cat, area:cat, per:'yr', amount,
    startAge:clamp(age, 50, end), endAge:clamp(age, 50, end),
  });
  const recurring = (name, amount, from, to) => ({
    id:idFactory(), name, cat, area:cat, per:'yr', amount,
    startAge:clamp(from, 50, end), endAge:clamp(to, 50, end),
  });
  if(cat === 'travel') return recurring('Travel', 10_000, retirement, Math.min(retirement + 9, end));
  if(cat === 'home') return once('Home improvements', 25_000, retirement + 3);
  if(cat === 'vehicle') return once('Vehicle', 40_000, retirement + 5);
  if(cat === 'education') return once('Education', 20_000, retirement + 1);
  if(cat === 'family') return recurring('Family', 5_000, retirement, end);
  if(cat === 'giving') return recurring('Giving', 5_000, retirement, end);
  if(cat === 'health') return recurring('Healthcare', 8_000, Math.max(retirement, end - 10), end);
  return once('', 10_000, retirement + 5);
}

export function duplicateGoal(goal, idFactory = defaultGoalId){
  return {
    ...goal,
    id:idFactory(),
    name:`${goal.name || 'Untitled goal'} copy`,
  };
}

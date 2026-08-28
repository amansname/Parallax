import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoalForCategory,
  duplicateGoal,
  ensureGoalMetadata,
  formatGoalAmount,
  goalAgeToPeriodValue,
  goalDisplayAmount,
  goalHasFutureWorkingYears,
  goalPct,
  goalPeriodValueToAge,
  normalizeGoalCategory,
  resolveEffectiveGoal,
  resolveScenarioHouseholdRetirementAge,
  resolveGoalSpan,
  resolveGoalTimingLens,
  setGoalDisplayAmount,
  setGoalKind,
  setGoalPer,
  setGoalRange,
  shiftGoal,
} from './horizonModel.js';

test('goal timing lens converts canonical ages through client, co-client, and calendar-year views', () => {
  const plan = {
    household: {
      primary: { birthYear: 1961, currentAge: 65 },
      spouse: { birthYear: 1963, currentAge: 63 },
    },
  };

  assert.deepEqual(
    resolveGoalTimingLens(plan, { mode:'age', owner:'spouse', currentYear:2026 }),
    {
      mode:'age', owner:'spouse', currentYear:2026,
      primaryBirthYear:1961, ownerBirthYear:1963,
    },
  );
  assert.equal(goalAgeToPeriodValue(67, plan, { mode:'age', owner:'primary', currentYear:2026 }), 67);
  assert.equal(goalAgeToPeriodValue(67, plan, { mode:'age', owner:'spouse', currentYear:2026 }), 65);
  assert.equal(goalAgeToPeriodValue(67, plan, { mode:'year', owner:'spouse', currentYear:2026 }), 2028);
  assert.equal(goalPeriodValueToAge(70, plan, { mode:'age', owner:'spouse', currentYear:2026 }), 72);
  assert.equal(goalPeriodValueToAge(2030, plan, { mode:'year', owner:'spouse', currentYear:2026 }), 69);
});

test('goal timing lens falls back to current ages and cannot select an absent co-client', () => {
  const plan = { household: { primary: { currentAge:65 } } };
  const lens = resolveGoalTimingLens(plan, { mode:'age', owner:'spouse', currentYear:2026 });
  assert.equal(lens.owner, 'primary');
  assert.equal(goalAgeToPeriodValue(70, plan, { mode:'year', currentYear:2026 }), 2031);
  assert.equal(goalPeriodValueToAge(2031, plan, { mode:'year', currentYear:2026 }), 70);
});

test('resolveGoalSpan uses the later spouse retirement on the primary timeline', () => {
  const plan={ household:{ primary:{ currentAge:64, retirementAge:66, planEndAge:95 }, spouse:{ currentAge:63, retirementAge:68 } } };
  assert.deepEqual(resolveGoalSpan(plan), { currentAge:64, retirementAge:69, planEndAge:95, axisMin:62, axisMax:96 });
});

test('resolveGoalSpan uses the latest entered planning age without translating it', () => {
  const plan={ household:{ primary:{ currentAge:64, retirementAge:66, planEndAge:95 }, spouse:{ currentAge:60, retirementAge:68, planEndAge:100 } } };
  assert.deepEqual(resolveGoalSpan(plan), { currentAge:64, retirementAge:72, planEndAge:100, axisMin:62, axisMax:101 });
});

test('matching age-90 planning inputs keep the Goals horizon at age 90', () => {
  const plan={ household:{ primary:{ currentAge:62, retirementAge:66, planEndAge:90 }, spouse:{ currentAge:59, retirementAge:63, planEndAge:90 } } };
  assert.equal(resolveGoalSpan(plan).planEndAge, 90);
});

test('goal ranges preserve a household horizon beyond age 100', () => {
  const goal={ amount:10000, per:'yr', startAge:115, endAge:124 };
  setGoalKind(goal,'once',124);
  assert.deepEqual([goal.startAge,goal.endAge],[115,115]);
  setGoalKind(goal,'rec',124);
  assert.deepEqual([goal.startAge,goal.endAge],[115,124]);
  setGoalRange(goal,115,124,124);
  assert.deepEqual([goal.startAge,goal.endAge],[115,124]);
  shiftGoal(goal,10,{dragMin:62,planEndAge:124});
  assert.deepEqual([goal.startAge,goal.endAge],[115,124]);
});

test('legacy goals gain stable metadata without changing engine fields', () => {
  const goals=[{ name:'Trip', amount:12000, startAge:65, endAge:74, area:'travel' }];
  assert.equal(ensureGoalMetadata(goals, ()=>'goal_fixed'), true);
  assert.deepEqual(goals[0], { name:'Trip', amount:12000, startAge:65, endAge:74, area:'travel', id:'goal_fixed', cat:'travel', per:'yr' });
  assert.equal(ensureGoalMetadata(goals, ()=>'unused'), false);
});

test('legacy generic categories infer a visual category from the goal name', () => {
  assert.equal(normalizeGoalCategory({name:'Travel & leisure',area:'purpose'}),'travel');
  assert.equal(normalizeGoalCategory({name:'Kitchen renovation',area:'other'}),'home');
  assert.equal(normalizeGoalCategory({name:'Open-ended reserve',area:'other'}),'custom');
});

test('monthly display conversion preserves the annual engine contract', () => {
  const goal={ amount:12000, per:'yr', startAge:65, endAge:74 };
  setGoalPer(goal, 'mo');
  assert.equal(goalDisplayAmount(goal), 1000);
  assert.equal(goal.amount, 12000);
  setGoalDisplayAmount(goal, 1250);
  assert.equal(goal.amount, 15000);
  setGoalPer(goal, 'yr');
  assert.equal(goalDisplayAmount(goal), 15000);
});

test('future working-year overlap follows the household retirement boundary', () => {
  const span={ currentAge:64, retirementAge:69 };
  assert.equal(goalHasFutureWorkingYears({startAge:67,endAge:67},span),true);
  assert.equal(goalHasFutureWorkingYears({startAge:63,endAge:63},span),false);
  assert.equal(goalHasFutureWorkingYears({startAge:69,endAge:70},span),false);
  assert.equal(goalHasFutureWorkingYears({startAge:65,endAge:64},span),false);
  assert.equal(goalHasFutureWorkingYears(
    {startAge:64,endAge:65},
    {currentAge:69,retirementAge:69}
  ),false);
});

test('starts-at-retirement goals use the later household boundary', () => {
  const plan={
    household:{
      primary:{currentAge:64,retirementAge:66,planEndAge:95},
      spouse:{currentAge:63,retirementAge:68,planEndAge:95},
    },
  };
  const span=resolveGoalSpan(plan);
  const baselineHouseholdRetirementAge=resolveScenarioHouseholdRetirementAge(plan,66);
  const delayedHouseholdRetirementAge=resolveScenarioHouseholdRetirementAge(plan,68);
  const goal=resolveEffectiveGoal(
    {amount:30000,startAge:66,endAge:95,startsAtRetirement:true},
    null,
    baselineHouseholdRetirementAge
  );
  assert.equal(baselineHouseholdRetirementAge,69);
  assert.equal(delayedHouseholdRetirementAge,71);
  assert.equal(goal.startAge,69);
  assert.equal(goalHasFutureWorkingYears(goal,span),false);
});

test('scenario household retirement follows independent client and spouse ages', () => {
  const plan={
    household:{
      primary:{currentAge:64,retirementAge:66,planEndAge:95},
      spouse:{currentAge:60,retirementAge:68,planEndAge:95},
    },
  };

  assert.equal(resolveScenarioHouseholdRetirementAge(plan,67,65),69);
  assert.equal(resolveScenarioHouseholdRetirementAge(plan,67,70),74);
});

test('changing cadence never rounds or rewrites the canonical annual amount', () => {
  const goal={ amount:10000, per:'yr', startAge:65, endAge:74 };
  setGoalPer(goal, 'mo');
  assert.equal(goalDisplayAmount(goal), 833);
  assert.equal(goal.amount, 10000);
  setGoalPer(goal, 'yr');
  assert.equal(goalDisplayAmount(goal), 10000);
  assert.equal(goal.amount, 10000);
});

test('kind and ranges preserve one contiguous engine window', () => {
  const goal={ amount:10000, per:'yr', startAge:70, endAge:79 };
  setGoalKind(goal, 'once', 95);
  assert.deepEqual([goal.startAge,goal.endAge,goal.per],[70,70,'yr']);
  setGoalKind(goal, 'rec', 75);
  assert.deepEqual([goal.startAge,goal.endAge],[70,75]);
  setGoalRange(goal, 90, 88, 95, 'start');
  assert.deepEqual([goal.startAge,goal.endAge],[90,90]);
  setGoalRange(goal, 90, 88, 95, 'end');
  assert.deepEqual([goal.startAge,goal.endAge],[88,88]);
});

test('dragging keeps recurring duration and clamps to the plan horizon', () => {
  const goal={ startAge:65, endAge:74 };
  shiftGoal(goal, 40, {dragMin:62,planEndAge:95});
  assert.deepEqual([goal.startAge,goal.endAge],[86,95]);
  shiftGoal(goal, -40, {dragMin:62,planEndAge:95});
  assert.deepEqual([goal.startAge,goal.endAge],[62,71]);
});

test('category defaults derive timing from the live household span', () => {
  const span={retirementAge:66,planEndAge:90};
  const travel=createGoalForCategory('travel',span,()=> 'travel_id');
  const health=createGoalForCategory('health',span,()=> 'health_id');
  assert.deepEqual([travel.startAge,travel.endAge,travel.amount],[66,75,10000]);
  assert.deepEqual([health.startAge,health.endAge,health.amount],[80,90,8000]);
});

test('formatting, percentages and duplicates are deterministic', () => {
  const goal={id:'a',name:'Beach house',amount:500000,per:'yr',startAge:70,endAge:70};
  assert.equal(formatGoalAmount(goal),'$500k');
  assert.equal(goalPct(79,62,96),50);
  assert.deepEqual(duplicateGoal(goal,()=> 'b'),{...goal,id:'b',name:'Beach house copy'});
});

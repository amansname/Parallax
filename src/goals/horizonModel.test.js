import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoalForCategory,
  duplicateGoal,
  ensureGoalMetadata,
  formatGoalAmount,
  goalDisplayAmount,
  goalPct,
  normalizeGoalCategory,
  resolveGoalSpan,
  setGoalDisplayAmount,
  setGoalKind,
  setGoalPer,
  setGoalRange,
  shiftGoal,
} from './horizonModel.js';

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

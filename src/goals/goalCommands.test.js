import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalCommands } from './goalCommands.js';
import { createGoalEditSession, applyGoalSessionEdit, prepareGoalSessionSave } from './goalEditSession.js';
import { defaultPlan } from '../../engine.js';
import { scenarios as runtimeScenarios, uiState } from '../state.js';
import { insertGoalAt, removeGoalAt } from './scenarioGoalOverrides.js';

function fixture(){
  let plan = { household: { primary: { currentAge: 60, retirementAge: 65, planEndAge: 95 } },
    goals: [{ id: 'travel', name: 'Travel', amount: 24001, per: 'yr', cat: 'travel', area: 'travel', startsAtRetirement: true, endAge: 999 }] };
  let householdId = 'household-a';
  let scenarios = [{ name: 'Baseline', base: true, lev: {} }];
  let guard = () => true;
  let failed = false;
  let readOnly = false;
  const publications = [];
  const deps = {
    getPlan: () => plan, getHouseholdId: () => householdId, getScenarios: () => scenarios,
    guardMutation: () => guard(), isSaveFailed: () => failed, isReadOnly: () => readOnly,
    arm: () => publications.push('arm'), commit: () => publications.push('commit'),
    insertGoal: (index, goal) => plan.goals.splice(index, 0, goal),
    removeGoal: index => ({ goal: plan.goals.splice(index, 1)[0], overrides: [] }),
  };
  const commands = createGoalCommands(deps);
  const session = () => createGoalEditSession({ goal: plan.goals[0], id: 'travel', isNew: false, householdId, currentYear: 2026 });
  return { commands, session, publications, get plan(){ return plan; }, set plan(value){ plan = value; },
    set guard(value){ guard = value; }, set householdId(value){ householdId = value; },
    set scenarios(value){ scenarios = value; }, get scenarios(){ return scenarios; }, set failed(value){ failed = value; }, set readOnly(value){ readOnly = value; } };
}

test('immediate and draft cadence-only edits preserve annual dollars and retirement sentinels', () => {
  const desktop = fixture(); const mobile = fixture();
  desktop.commands.publish(desktop.commands.update('travel', { type: 'per', value: 'mo' }));
  const session = mobile.session();
  applyGoalSessionEdit(session, { type: 'frequency', value: 'monthly' }, mobile.plan);
  assert.equal(mobile.plan.goals[0].per, 'yr');
  mobile.commands.publish(mobile.commands.applyDraft(session));
  assert.deepEqual(mobile.plan, desktop.plan);
  assert.equal(mobile.plan.goals[0].amount, 24001);
  assert.equal(mobile.plan.goals[0].endAge, 999);
  assert.equal(mobile.plan.goals[0].startAge, undefined);
});

test('the command reacquires an id-bearing goal after a guard replaces the live plan', () => {
  const f = fixture(); const original = f.plan;
  f.guard = () => { f.plan = structuredClone(f.plan); return true; };
  const receipt = f.commands.update('travel', { type: 'name', value: 'New name' });
  f.commands.publish(receipt, 'arm');
  assert.equal(original.goals[0].name, 'Travel');
  assert.equal(f.plan.goals[0].name, 'New name');
  assert.deepEqual(f.publications, ['arm']);
});

test('a guard switching household or rearranging legacy goals cannot apply an old operation', () => {
  const switched = fixture(); const original = structuredClone(switched.plan);
  switched.guard = () => { switched.householdId = 'household-b'; return true; };
  assert.equal(switched.commands.update('travel', { type: 'amount', value: 90000 }), null);
  assert.deepEqual(switched.plan, original);
  const legacy = fixture(); delete legacy.plan.goals[0].id;
  legacy.plan.goals.push({ name: 'Other', amount: 1000 });
  legacy.guard = () => { legacy.plan.goals.reverse(); return true; };
  assert.equal(legacy.commands.update('legacy_0', { type: 'amount', value: 90000 }), null);
  assert.deepEqual(legacy.plan.goals.map(goal => goal.amount), [1000, 24001]);
});

test('draft invalid End remains blocking even when another edit collapses timing to once', () => {
  const f = fixture(); const session = f.session();
  session.raw.end = 'invalid';
  session.raw.start = '95';
  assert.equal(prepareGoalSessionSave(session, f.plan), false);
  assert.equal(session.draft.value.startAge, 95);
  assert.equal(session.draft.value.endAge, 95);
  assert.equal(session.raw.end, 'invalid');
  assert.match(session.errors.end, /number/);
  const before = structuredClone(f.plan);
  assert.throws(() => f.commands.applyDraft(session), /number/);
  assert.deepEqual(f.plan, before);
});

test('Save revalidates linked End against Household changes made while the editor is open', () => {
  const f = fixture(); f.plan.goals[0].endAge = 70;
  const session = f.session(); session.draft.value.name = 'Changed name';
  f.plan.household.primary.retirementAge = 75;
  assert.throws(() => f.commands.applyDraft(session), /75 or later/);
  assert.equal(f.plan.goals[0].name, 'Travel');
  assert.equal(f.plan.goals[0].endAge, 70);
});

test('stale draft amount and timing conflicts reject the entire operation', () => {
  const f = fixture(); const session = f.session();
  session.draft.value.name = 'Unsaved name'; session.draft.value.amount = 30000;
  f.plan.goals[0].per = 'mo';
  assert.throws(() => f.commands.applyDraft(session), /changed while/);
  assert.equal(f.plan.goals[0].amount, 24001);
  assert.equal(f.plan.goals[0].name, 'Travel');
});

test('a one-time conversion preserves annual dollars and shows the full one-time amount', () => {
  const f = fixture(); f.plan.goals[0].per = 'mo';
  f.commands.update('travel', { type: 'range', edge: 'start', value: 95 });
  assert.equal(f.plan.goals[0].amount, 24001);
  assert.equal(f.plan.goals[0].startAge, 95);
  assert.equal(f.plan.goals[0].endAge, 95);
  assert.equal(f.plan.goals[0].per, 'yr');
});

test('system goals cannot be deleted or duplicated through shared commands', () => {
  const f = fixture(); f.plan.goals[0].system = true;
  assert.equal(f.commands.remove('travel'), null);
  assert.equal(f.commands.duplicate('travel'), null);
  assert.equal(f.plan.goals.length, 1);
});

test('Undo rejects a same-valued replacement scenario and restores an unchanged scenario context', () => {
  const f = fixture(); const removed = f.commands.remove('travel');
  f.commands.publish(removed);
  f.scenarios = structuredClone(f.scenarios);
  assert.throws(() => f.commands.restore(removed), /plan changed/);
  assert.equal(f.plan.goals.length, 0);
  const valid = fixture(); const token = valid.commands.remove('travel'); valid.commands.publish(token);
  const restored = valid.commands.restore(token); valid.commands.publish(restored);
  assert.equal(valid.plan.goals[0].amount, 24001);
  assert.deepEqual(valid.publications, ['commit', 'commit']);
});

test('drag publishes once at its first real move and once on finish, with no write on pointer down', () => {
  const f = fixture(); const before = structuredClone(f.plan);
  const token = f.commands.beginMove('travel');
  assert.deepEqual(f.plan, before); assert.deepEqual(f.publications, []);
  const first = f.commands.move(token, 1); assert.equal(first.firstMove, true);
  f.commands.publish(first, 'arm');
  const last = f.commands.move(token, 2); assert.equal(last.firstMove, false);
  f.commands.publish(last);
  assert.deepEqual(f.publications, ['arm', 'commit']);
  assert.equal(f.plan.goals[0].startsAtRetirement, false);
});

test('drafts and active drag receipts cannot mutate or publish another household', () => {
  const f = fixture(); const session = f.session(); const token = f.commands.beginMove('travel');
  session.raw.amount = '5000'; f.householdId = 'household-b';
  const before = structuredClone(f.plan);
  assert.equal(f.commands.applyDraft(session), null);
  assert.equal(f.commands.move(token, 2), null);
  assert.deepEqual(f.plan, before); assert.deepEqual(f.publications, []);
});

test('publication exposes a failed durable save instead of reporting success', () => {
  const f = fixture(); const receipt = f.commands.update('travel', { type: 'name', value: 'Saved name' });
  f.failed = true; assert.equal(f.commands.publish(receipt), false);
  f.failed = false; assert.equal(f.commands.publish(receipt), true);
});

test('an armed drag stops mutating immediately when the household becomes read-only', () => {
  const f = fixture(); const token = f.commands.beginMove('travel');
  f.commands.publish(f.commands.move(token, 1), 'arm');
  const before = structuredClone(f.plan);
  f.readOnly = true;
  assert.equal(f.commands.move(token, 5), null);
  assert.deepEqual(f.plan, before);
  assert.deepEqual(f.publications, ['arm']);
});

test('shared deletion and Undo preserve actual production scenario override associations', () => {
  const priorGoals = defaultPlan.goals;
  const priorScenarios = runtimeScenarios;
  try{
    defaultPlan.goals = [
      { id: 'first', name: 'First', amount: 1000 },
      { id: 'second', name: 'Second', amount: 2000 },
      { id: 'third', name: 'Third', amount: 3000 },
    ];
    uiState.scenarios = [
      { name: 'Base', base: true, lev: { goalOv: { 0: { amount: 1100 }, 1: { amount: 2200 }, 2: { amount: 3300 } } } }];
    const before = structuredClone(runtimeScenarios);
    const commands = createGoalCommands({ getPlan: () => defaultPlan, getHouseholdId: () => 'production-fixture',
      getScenarios: () => runtimeScenarios, guardMutation: () => true, insertGoal: insertGoalAt, removeGoal: removeGoalAt });
    const token = commands.remove('second'); commands.publish(token);
    assert.deepEqual(defaultPlan.goals.map(goal => goal.id), ['first', 'third']);
    assert.deepEqual(runtimeScenarios[0].lev.goalOv, { 0: { amount: 1100 }, 1: { amount: 3300 } });
    commands.publish(commands.restore(token));
    assert.deepEqual(defaultPlan.goals.map(goal => goal.id), ['first', 'second', 'third']);
    assert.deepEqual(runtimeScenarios, before);
  }finally{
    defaultPlan.goals = priorGoals;
    uiState.scenarios = priorScenarios;
  }
});

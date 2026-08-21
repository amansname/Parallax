import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalsHorizonController } from './goalsHorizon.js';

test('Goals horizon renders retirement-linked goals from the effective retirement age without persisting a substitute', () => {
  const goal = {
    id: 'goal_essentials',
    name: 'Essentials',
    amount: 144_000,
    per: 'yr',
    cat: 'custom',
    system: true,
    startsAtRetirement: true,
    endAge: 999,
  };
  const plan = {
    household: {
      primary: { currentAge: 65, retirementAge: 67, planEndAge: 95 },
    },
    goals: [goal],
  };
  const controller = createGoalsHorizonController({
    getPlan: () => plan,
    isReadOnly: () => false,
  });

  const html = controller.render();

  assert.doesNotMatch(html, /NaN|undefined/);
  assert.doesNotMatch(html, /Always part of the plan/);
  assert.doesNotMatch(html, /Never mind/);
  assert.doesNotMatch(html, /gh-add-panel/);
  assert.match(html, /data-action="toggle-add"[^>]*><span>\+<\/span>Add a goal/);
  assert.match(html, /--gh-start:14\.706%/);
  assert.match(html, /Every year, ages 67/);
  assert.equal(goal.startAge, undefined);
  assert.equal(goal.endAge, 999);
  assert.equal(goal.startsAtRetirement, true);
});

test('Goals horizon resolves the live goal after a runtime household becomes a durable copy', () => {
  const runtimeGoal = {
    id: 'goal_essentials',
    name: 'Essentials',
    amount: 12_000,
    per: 'yr',
    cat: 'custom',
    system: true,
    startsAtRetirement: true,
    endAge: 999,
  };
  let plan = {
    household: {
      primary: { currentAge: 65, retirementAge: 67, planEndAge: 95 },
    },
    goals: [runtimeGoal],
  };
  let guardCalls = 0;
  let armCalls = 0;
  const handlers = {};
  const root = {
    innerHTML: '',
    addEventListener(type, handler){ handlers[type] = handler; },
    querySelector(){ return null; },
  };
  const controller = createGoalsHorizonController({
    getPlan: () => plan,
    isReadOnly: () => false,
    guardMutation: () => {
      guardCalls += 1;
      plan = structuredClone(plan);
      return true;
    },
    arm: () => { armCalls += 1; },
  });
  controller.bind(root);

  const chip = { dataset: { goalChip: runtimeGoal.id } };
  handlers.click({
    detail: 0,
    target: { closest: selector => selector === '[data-goal-chip]' ? chip : null },
  });
  const originalCss = globalThis.CSS;
  globalThis.CSS = { escape: value => String(value) };
  try{
    handlers.input({
      target: {
        value: 'Updated essentials',
        matches: selector => selector === '.gh-name-input',
      },
    });
  }finally{
    if(originalCss) globalThis.CSS = originalCss;
    else delete globalThis.CSS;
  }

  assert.equal(guardCalls, 1);
  assert.equal(armCalls, 1);
  assert.equal(runtimeGoal.name, 'Essentials');
  assert.equal(plan.goals[0].name, 'Updated essentials');
  assert.notEqual(plan.goals[0], runtimeGoal);
});

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
  assert.match(html, /--gh-start:14\.706%/);
  assert.match(html, /Every year, ages 67/);
  assert.equal(goal.startAge, undefined);
  assert.equal(goal.endAge, 999);
  assert.equal(goal.startsAtRetirement, true);
});

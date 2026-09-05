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
  const handlers = {};
  const root = {
    innerHTML: controller.render(),
    addEventListener(type, handler){ handlers[type] = handler; },
    querySelector(){ return null; },
  };
  controller.bind(root);
  const chip = { dataset: { goalChip: goal.id } };
  handlers.click({
    detail: 0,
    target: { closest: selector => selector === '[data-goal-chip]' ? chip : null },
  });

  const html = root.innerHTML;

  assert.doesNotMatch(html, /NaN|undefined/);
  assert.doesNotMatch(html, /Always part of the plan/);
  assert.doesNotMatch(html, /Never mind/);
  assert.doesNotMatch(html, /gh-add-panel/);
  assert.match(html, /data-action="toggle-add"[^>]*><span>\+<\/span>Add a goal/);
  assert.match(html, /data-goal-rail="goal_essentials"/);
  assert.match(html, /class="gh-name-input"[^>]*value="Essentials"/);
  assert.match(html, /--gh-start:14\.706%/);
  assert.match(html, /Every year, ages 67/);
  assert.equal(goal.startAge, undefined);
  assert.equal(goal.endAge, 999);
  assert.equal(goal.startsAtRetirement, true);
});

test('Goals horizon resolves the live goal after the mutation guard replaces the plan', () => {
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

test('Goals horizon opens the goal category chooser first and respects a later close', () => {
  const plan = {
    household: {
      primary: { currentAge: 65, retirementAge: 67, planEndAge: 95 },
    },
    goals: [{
      id: 'goal_essentials',
      name: 'Essentials',
      amount: 12_000,
      per: 'yr',
      cat: 'custom',
      system: true,
      startsAtRetirement: true,
      endAge: 999,
    }],
  };
  const handlers = {};
  const root = {
    innerHTML: '',
    addEventListener(type, handler){ handlers[type] = handler; },
    querySelector(){ return null; },
  };
  const controller = createGoalsHorizonController({
    getPlan: () => plan,
    isReadOnly: () => false,
  });

  root.innerHTML = controller.render();
  controller.bind(root);
  assert.match(root.innerHTML, /class="gh-rail gh-add-rail"/);
  assert.match(root.innerHTML, /data-action="toggle-add"[^>]*aria-expanded="true"/);
  assert.deepEqual(
    [...root.innerHTML.matchAll(/data-add-category="([^"]+)"/g)].map(match => match[1]),
    ['travel', 'home', 'vehicle', 'education', 'family', 'giving', 'health', 'custom'],
  );
  assert.doesNotMatch(root.innerHTML, /data-goal-rail=/);

  handlers.click({
    detail: 1,
    target: {
      closest(selector){
        if(selector === '[data-action]') return { dataset: { action: 'close' } };
        return null;
      },
    },
  });

  assert.doesNotMatch(root.innerHTML, /class="gh-rail/);
  assert.doesNotMatch(controller.render(), /class="gh-rail/);
});

test('Goals horizon keeps the retirement label clear of the next five-year tick', () => {
  const controller = createGoalsHorizonController({
    getPlan: () => ({
      household: {
        primary: { currentAge: 60, retirementAge: 64, planEndAge: 95 },
      },
      goals: [],
    }),
    isReadOnly: () => false,
  });
  const tickLabels = [...controller.render().matchAll(
    /class="gh-tick[^"]*"[^>]*>([^<]+)<\/span>/g,
  )].map(match => match[1]);

  assert.deepEqual(tickLabels, ['64 · retire', '70', '75', '80', '85', '90', '95']);
});

test('Goals horizon switches between client or co-client ages and calendar years without changing the saved shape', () => {
  const plan = {
    meta: { primaryName:'Alexandra', spouseName:'Jordan' },
    household: {
      primary: { birthYear:1961, currentAge:65, retirementAge:67, planEndAge:95 },
      spouse: { birthYear:1963, currentAge:63, retirementAge:67, planEndAge:95 },
    },
    goals: [{
      id:'goal_travel', name:'Travel', amount:10_000, per:'yr', cat:'travel',
      startAge:67, endAge:74,
    }],
  };
  const handlers = {};
  let guardCalls = 0;
  let commitCalls = 0;
  const root = {
    innerHTML:'',
    addEventListener(type,handler){ handlers[type]=handler; },
    querySelector(){ return null; },
  };
  const controller = createGoalsHorizonController({
    getPlan:()=>plan,
    isReadOnly:()=>false,
    guardMutation:()=>{ guardCalls += 1; return true; },
    commit:()=>{ commitCalls += 1; },
    currentYear:2026,
  });

  root.innerHTML=controller.render();
  controller.bind(root);
  const chip={dataset:{goalChip:'goal_travel'}};
  handlers.click({
    detail:0,
    target:{closest:selector=>selector==='[data-goal-chip]' ? chip : null},
  });
  assert.match(root.innerHTML,/data-action="timing-age"[^>]*aria-pressed="true"/);
  assert.match(root.innerHTML,/data-field="timing-owner"/);
  assert.match(root.innerHTML,/data-field="start-age"[^>]*value="67"/);
  assert.match(root.innerHTML,/data-field="end-age"[^>]*value="74"/);

  handlers.click({
    detail:1,
    target:{ closest:selector=>selector==='[data-action]' ? {dataset:{action:'timing-year'}} : null },
  });
  assert.equal(guardCalls,0);
  assert.match(root.innerHTML,/data-field="start-year"[^>]*value="2028"/);
  assert.match(root.innerHTML,/data-field="end-year"[^>]*value="2035"/);

  handlers.input({ target:{ matches:()=>false } });
  assert.equal(guardCalls,0);
  handlers.change({ target:{ dataset:{field:'start-year'}, value:'2030' } });
  assert.equal(plan.goals[0].startAge,69);
  assert.equal(plan.goals[0].endAge,74);
  assert.equal(plan.goals[0].timingMode,undefined);
  assert.equal(guardCalls,1);
  assert.equal(commitCalls,1);

  handlers.click({
    detail:1,
    target:{ closest:selector=>selector==='[data-action]' ? {dataset:{action:'timing-age'}} : null },
  });
  handlers.change({ target:{ dataset:{field:'timing-owner'}, value:'spouse' } });
  assert.match(root.innerHTML,/data-field="timing-owner"[^>]*>[\s\S]*value="spouse" selected/);
  assert.match(root.innerHTML,/data-field="start-age"[^>]*value="67"/);
  assert.match(root.innerHTML,/data-field="end-age"[^>]*value="72"/);
  assert.deepEqual(
    Object.keys(plan.goals[0]).filter(key=>key.startsWith('timing')),
    [],
  );
});

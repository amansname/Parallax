import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderCompare, renderFocus } from './scenarios.js';

const esc = value => String(value);
const deps = {
  esc,
  fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
  checkIcon: () => 'check',
  stressEraCount: 0,
};

test('Focus renders goal state as read-only status instead of an inert switch', () => {
  const scenario = {
    id: 'baseline',
    name: 'Baseline',
    isBaseline: true,
    prob: 80,
    probStr: '80.0',
    tone: '#8fa57e',
    median: '$0',
    viability: 'Review',
    levers: [],
    goals: [
      { name: 'Travel', amount: 10_000, cadence: '/yr', meta: 'age 65-70', on: true },
      { name: 'Gift', amount: 0, cadence: 'disabled', meta: 'at age 75', on: false },
    ],
    stress: [],
    range: null,
  };

  const html = renderFocus([scenario], scenario, scenario.id, false, deps);

  assert.doesNotMatch(html, /class="goal-toggle"|role="switch"/);
  assert.match(html, /class="goal-state goal-state--on">Active<\/span>/);
  assert.match(html, /class="goal-state goal-state--off">Off<\/span>/);
});

test('Compare discloses pre-retirement funding for the base row and every plan', () => {
  const goal = {
    idx: 0,
    name: 'College',
    amount: 10_000,
    startAge: 64,
    endAge: 65,
    once: false,
    on: true,
    overridden: false,
    sameAsBase: true,
    amountDelta: 0,
    fundingNote: 'portfolio funded before retirement',
  };
  const scenarios = ['Baseline', 'Alternative'].map((name, index) => ({
    id: String(index),
    name,
    isBaseline: index === 0,
    prob: 80,
    probStr: '80.0',
    tone: '#8fa57e',
    median: '$0',
    levers: [],
    goals: [{ ...goal }],
  }));

  const html = renderCompare(scenarios, scenarios[0], {
    plan: {}, planEndAge: 95, goalsExpandedState: true, esc, downTri: '',
  });

  assert.equal((html.match(/portfolio funded before retirement/g) || []).length, 3);
  assert.match(html, /base: age 64[^<]*portfolio funded before retirement/);
});

test('Compare presents the through-plan-end sentinel as the actual plan-end age', () => {
  const goal = {
    idx: 0,
    name: 'Healthcare',
    amount: 5_500,
    startAge: 65,
    endAge: 999,
    once: false,
    on: true,
    overridden: false,
    sameAsBase: true,
    amountDelta: 0,
    fundingNote: '',
  };
  const scenario = {
    id: 'baseline',
    name: 'Baseline',
    isBaseline: true,
    prob: 80,
    probStr: '80.0',
    tone: '#8fa57e',
    median: '$0',
    levers: [],
    goals: [{ ...goal }],
  };

  const html = renderCompare([scenario], scenario, {
    plan: {}, planEndAge: 95, goalsExpandedState: true, esc, downTri: '',
  });

  assert.doesNotMatch(html, /999/);
  assert.match(html, /base: age 65[^<]*95/);
  assert.match(html, /data-goal-field="endAge" value="95"/);
});

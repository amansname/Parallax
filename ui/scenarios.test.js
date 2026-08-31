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

test('Compare and Focus preserve the direction of probability deltas versus Baseline', () => {
  const scenarios = [
    { id: 'baseline', name: 'Baseline', isBaseline: true, prob: 70, probStr: '70.0' },
    { id: 'better', name: 'Better', isBaseline: false, prob: 80, probStr: '80.0' },
    { id: 'worse', name: 'Worse', isBaseline: false, prob: 60, probStr: '60.0' },
    { id: 'same', name: 'Same', isBaseline: false, prob: 70, probStr: '70.0' },
    { id: 'pending', name: 'Pending', isBaseline: false, prob: null, probStr: '' },
  ].map(scenario => ({
    ...scenario,
    tone: '#8fa57e',
    median: '$0',
    viability: 'Review',
    levers: [],
    goals: [],
    stress: [],
    range: null,
  }));
  const baseline = scenarios[0];

  const compare = renderCompare(scenarios, baseline, {
    plan: {}, planEndAge: 95, goalsExpandedState: false, esc, downTri: '▼',
  });
  const focus = renderFocus(scenarios, baseline, baseline.id, false, deps);

  assert.ok(compare.includes('<span class="tag-delta">+10.0 pts</span>'));
  assert.ok(compare.includes('<span class="tag-delta">▼10.0 pts</span>'));
  assert.ok(compare.includes('<span class="tag-delta">0.0 pts</span>'));
  assert.ok(focus.includes('<span class="rail-card__tag rail-card__tag--delta">+10.0 pts</span>'));
  assert.ok(focus.includes('<span class="rail-card__tag rail-card__tag--delta">−10.0 pts</span>'));
  assert.ok(focus.includes('<span class="rail-card__tag rail-card__tag--delta">0.0 pts</span>'));
  assert.ok(focus.includes('<span class="rail-card__tag rail-card__tag--delta"></span>'));
  for(const html of [compare, focus]){
    assert.ok(!html.includes('NaN pts'));
    assert.ok(!html.includes('−0.0 pts'));
    assert.ok(!html.includes('▼0.0 pts'));
  }
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

test('Compare and Focus render the canonical allocation model as an in-place selector', () => {
  const allocation = {
    key: 'allocationPresetId',
    label: 'Allocation',
    value: 'Balanced',
    delta: null,
    controlType: 'select',
    selectedValue: 'balanced',
    options: [
      { value: 'current', label: 'Current mix' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'aggressive', label: 'Aggressive' },
    ],
  };
  const scenario = {
    id: '0',
    name: 'Baseline',
    isBaseline: true,
    prob: 80,
    probStr: '80.0',
    tone: '#8fa57e',
    median: '$0',
    viability: 'Review',
    levers: [allocation],
    goals: [],
    stress: [],
    range: null,
  };

  const compare = renderCompare([scenario], scenario, {
    plan: {}, planEndAge: 95, goalsExpandedState: false, esc, downTri: '',
  });
  const focus = renderFocus([scenario], scenario, scenario.id, false, deps);

  assert.match(compare, /class="cmp-lev-select"/);
  assert.match(compare, /data-scn-id="0" data-lever-key="allocationPresetId"/);
  assert.match(compare, /<option value="balanced" selected>Balanced<\/option>/);
  assert.doesNotMatch(compare, /data-lever-key="allocationPresetId"[^>]*data-dir/);
  assert.match(focus, /class="assum__select"/);
  assert.match(focus, /<option value="aggressive">Aggressive<\/option>/);
});

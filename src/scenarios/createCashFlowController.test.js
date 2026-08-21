import test from 'node:test';
import assert from 'node:assert/strict';

import { createCashFlowController } from './createCashFlowController.js';

function simulation(simIndex, balance){
  return {
    simIndex,
    rows: [{
      age: 65,
      phase: 'ret',
      source: 2026,
      returnRate: 0,
      balance,
      startBalance: balance,
      fundingShortfall: 0,
      taxes: 0,
    }],
  };
}

function buildRows(selected){
  return selected.rows.map(row => ({ ...row, ending: row.balance }));
}

test('Typical Cash Flow compares every scenario on the baseline p50 market index', () => {
  const baselineTypical = simulation(7, 700_000);
  const baselineOther = simulation(3, 300_000);
  const scenarioSharedMarket = simulation(7, 650_000);
  const scenarioOwnP50 = simulation(3, 900_000);
  const baseline = {
    base: true,
    name: 'Baseline',
    res: {
      sims: [baselineOther, baselineTypical],
      paths: { p50: { simIndex: 7 } },
    },
  };
  const alternative = {
    base: false,
    name: 'Alternative',
    res: {
      sims: [scenarioSharedMarket, scenarioOwnP50],
      paths: { p50: { simIndex: 3 } },
    },
  };
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const inputs = new WeakMap([
    [baseline.res, { plan, overrides: {} }],
    [alternative.res, { plan, overrides: {} }],
  ]);
  const controller = createCashFlowController({
    getScenarios: () => [baseline, alternative],
    scenarioInputsByResult: inputs,
    selection: { id: 'typical' },
    digest: selected => ({ endingBalance: selected.rows.at(-1).balance }),
    buildRows,
  });

  const result = controller.resultForScenario(alternative);

  assert.equal(result.simulation, scenarioSharedMarket);
  assert.notEqual(result.simulation, scenarioOwnP50);
  assert.equal(result.summary.endingBalance, 650_000);
  assert.equal(result.summary.federalTotal, 0);
  assert.equal(result.rows[0].ending, 650_000);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rows), true);
});

test('Typical Cash Flow totals authoritative federal tax from the selected simulation rows', () => {
  const selected = simulation(4, 700_000);
  selected.rows.push({ ...selected.rows[0], age: 66, taxes: 2_800 });
  selected.rows[0].taxes = 1_200;
  const scenario = {
    base: true,
    name: 'Baseline',
    res: {
      sims: [selected],
      paths: { p50: { simIndex: 4 } },
    },
  };
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const controller = createCashFlowController({
    getScenarios: () => [scenario],
    scenarioInputsByResult: new WeakMap([[scenario.res, { plan, overrides: {} }]]),
    selection: { id: 'typical' },
    digest: () => ({ peakWdRate: 4.1 }),
    buildRows,
  });

  const result = controller.resultForScenario(scenario);

  assert.equal(result.summary.federalTotal, 4_000);
  assert.equal(result.summary.peakWdRate, 4.1);
});

test('Typical Cash Flow fails closed when the baseline p50 identity is absent', () => {
  const baseline = {
    base: true,
    name: 'Baseline',
    res: { sims: [simulation(0, 700_000)], paths: { p50: {} } },
  };
  const alternative = {
    base: false,
    name: 'Alternative',
    res: { sims: [simulation(0, 650_000)], paths: { p50: { simIndex: 0 } } },
  };
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const controller = createCashFlowController({
    getScenarios: () => [baseline, alternative],
    scenarioInputsByResult: new WeakMap([
      [baseline.res, { plan, overrides: {} }],
      [alternative.res, { plan, overrides: {} }],
    ]),
    selection: { id: 'typical' },
    buildRows,
    onError: () => {},
  });

  const result = controller.resultForScenario(alternative);

  assert.match(result.error, /retirement handoff could not be verified/);
  assert.deepEqual(result.rows, []);
  assert.equal(result.simulation, undefined);
});

test('Typical Cash Flow fails closed when a scenario lacks the exact shared simIndex', () => {
  const baseline = {
    base: true,
    name: 'Baseline',
    res: {
      sims: [simulation(7, 700_000)],
      paths: { p50: { simIndex: 7 } },
    },
  };
  const unrelatedAtPositionSeven = simulation(99, 990_000);
  const alternativeSims = Array.from({ length: 8 }, (_, index) => (
    index === 7 ? unrelatedAtPositionSeven : simulation(index + 20, 600_000 + index)
  ));
  const alternative = {
    base: false,
    name: 'Alternative',
    res: {
      sims: alternativeSims,
      paths: { p50: { simIndex: 99 } },
    },
  };
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const controller = createCashFlowController({
    getScenarios: () => [baseline, alternative],
    scenarioInputsByResult: new WeakMap([
      [baseline.res, { plan, overrides: {} }],
      [alternative.res, { plan, overrides: {} }],
    ]),
    selection: { id: 'typical' },
    buildRows,
    onError: () => {},
  });

  const result = controller.resultForScenario(alternative);

  assert.match(result.error, /retirement handoff could not be verified/);
  assert.deepEqual(result.rows, []);
  assert.notEqual(result.simulation, unrelatedAtPositionSeven);
});

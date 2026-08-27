import test from 'node:test';
import assert from 'node:assert/strict';

import { createCashFlowController } from './createCashFlowController.js';
import { RANDOM_CASH_FLOW_PATH_ID } from './historicalPeriods.js';

function simulation(simIndex, balance){
  return {
    simIndex,
    rows: [{
      year: 1,
      age: 65,
      phase: 'ret',
      source: 2026,
      returnRate: 0,
      balance,
      startBalance: balance,
      wdRate: 4,
      fundingShortfall: 0,
      failed: false,
      taxes: 0,
      people: { client: { age: 65, alive: true }, spouse: null },
    }],
  };
}

function buildRows(selected, { plan, currentYear = 2026 } = {}){
  const currentAge = plan?.household?.primary?.currentAge ?? 65;
  return selected.rows.map(row => ({
    ...row,
    year: currentYear + (row.age - currentAge),
    accum: row.phase === 'accum',
    ending: row.balance,
  }));
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
    digest: selected => ({
      endingBalance: selected.rows.at(-1).balance,
      peakWdRate: 4,
      peakWdAge: 65,
    }),
    buildRows,
  });

  const result = controller.resultForScenario(alternative);

  assert.equal(result.simulation, scenarioSharedMarket);
  assert.notEqual(result.simulation, scenarioOwnP50);
  assert.equal(result.summary.endingBalance, 650_000);
  assert.equal(result.rows[0].ending, 650_000);
  assert.equal(result.headerMetrics.endingPosition, 650_000);
  assert.equal(result.headerMetrics.fundedThroughAge, 65);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rows), true);
  assert.equal(Object.isFrozen(result.headerMetrics), true);
});

test('Random Cash Flow retains and regenerates one shared session index without mutating analyses', () => {
  const baseline = {
    base: true,
    name: 'Baseline',
    res: {
      sims: [simulation(3, 300_000), simulation(7, 700_000), simulation(11, 1_100_000)],
      paths: { p50: { simIndex: 3 } },
      successRate: 80,
      envelope: [{ year: 1, p10: 100_000, p50: 300_000, p90: 1_100_000 }],
      iterations: 3,
    },
  };
  const alternative = {
    base: false,
    name: 'Alternative',
    res: {
      sims: [simulation(3, 250_000), simulation(7, 650_000), simulation(11, 1_050_000)],
      paths: { p50: { simIndex: 11 } },
      successRate: 75,
      envelope: [{ year: 1, p10: 90_000, p50: 250_000, p90: 1_050_000 }],
      iterations: 3,
    },
  };
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const selection = { id: 'typical' };
  const saved = [];
  const analysesBefore = JSON.stringify([baseline.res, alternative.res]);
  const controller = createCashFlowController({
    getScenarios: () => [baseline, alternative],
    scenarioInputsByResult: new WeakMap([
      [baseline.res, { plan, overrides: {} }],
      [alternative.res, { plan, overrides: {} }],
    ]),
    selection,
    saveSelection: () => saved.push(selection.id),
    random: () => 0,
    digest: selected => ({ endingBalance: selected.rows.at(-1).balance }),
    buildRows,
  });

  assert.equal(controller.regenerateRandomPath(), null);
  controller.setPathId(RANDOM_CASH_FLOW_PATH_ID, { persist: true });
  const firstBaseline = controller.resultForScenario(baseline);
  const firstAlternative = controller.resultForScenario(alternative);

  assert.equal(controller.activePathId(), RANDOM_CASH_FLOW_PATH_ID);
  assert.equal(firstBaseline.simIndex, 7);
  assert.equal(firstAlternative.simIndex, 7);
  assert.equal(firstAlternative.simulation, alternative.res.sims[1]);
  assert.equal(selection.id, 'typical');
  assert.deepEqual(saved, []);

  controller.setPathId('typical');
  assert.equal(controller.resultForScenario(baseline).simIndex, 3);
  controller.setPathId(RANDOM_CASH_FLOW_PATH_ID);
  assert.equal(controller.resultForScenario(alternative).simIndex, 7);

  assert.equal(controller.regenerateRandomPath(), 3);
  assert.equal(controller.resultForScenario(baseline).simIndex, 3);
  assert.equal(controller.resultForScenario(alternative).simIndex, 3);
  assert.equal(JSON.stringify([baseline.res, alternative.res]), analysesBefore);

  controller.resetSessionPath();
  assert.equal(controller.activePathId(), 'typical');
  assert.equal(controller.randomSimulationIndex(), null);
  assert.equal(controller.regenerateRandomPath(), null);
});

test('Typical Cash Flow replaces probability and federal total with the same-path header contract', () => {
  const selected = simulation(4, 700_000);
  selected.rows.push({
    ...selected.rows[0],
    age: 98,
    taxes: 2_800,
    people: {
      client: { age: 98, alive: false },
      spouse: { age: 95, alive: true },
    },
  });
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
    digest: () => ({ peakWdRate: 4.1, peakWdAge: 66 }),
    buildRows,
  });

  const result = controller.resultForScenario(scenario);

  assert.equal(result.summary.peakWdRate, 4.1);
  assert.equal('federalTotal' in result.summary, false);
  assert.deepEqual(result.headerMetrics, {
    kind: 'typical',
    outcome: 'survives',
    fundedThroughAge: 95,
    fundedThroughSupport: 'Plan end',
    endingPosition: 700_000,
  });
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

test('historical Cash Flow attaches the comparison contract to the same ledger result', () => {
  const typical = {
    simIndex: 7,
    rows: [
      {
        year: 1, age: 65, phase: 'ret', source: 1995, startBalance: 750_000,
        balance: 700_000, fundingShortfall: 0, failed: false, wdRate: 4, taxes: 0,
      },
      {
        year: 2, age: 66, phase: 'ret', source: 1996, startBalance: 700_000,
        balance: 600_000, fundingShortfall: 0, failed: false, wdRate: 5, taxes: 0,
      },
    ],
  };
  const scenario = {
    base: true,
    name: 'Baseline',
    res: {
      sims: [typical],
      paths: { p50: { simIndex: 7 } },
    },
  };
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const cases = [{
    summary: { outcome: 'survives', endingBalance: 650_000 },
    rows: [{
      year: 2, age: 66, phase: 'ret', source: 1974, startBalance: 690_000,
      balance: 650_000, fundingShortfall: 0, failed: false, wdRate: 4.2, taxes: 0,
    }],
    expectedOutcome: 'survives',
    expectedMetric: 'ending-portfolio',
    expectedDelta: 50_000,
  }, {
    summary: { outcome: 'underfunded' },
    rows: [{
      year: 1, age: 65, phase: 'ret', source: 1973, startBalance: 90_000,
      balance: 50_000, fundingShortfall: 0, failed: false, wdRate: 6, taxes: 0,
    }, {
      year: 2, age: 66, phase: 'ret', source: 1974, startBalance: 50_000,
      balance: 0, fundingShortfall: 20_000, failed: true, wdRate: 100, taxes: 0,
      people: { client: { age: 66, alive: true }, spouse: null },
    }],
    expectedOutcome: 'underfunded',
    expectedMetric: 'portfolio-at-underfunding',
    expectedDelta: -650_000,
  }];

  for(const entry of cases){
    const historical = {
      kind: 'historical',
      pathId: 'historical-1973',
      simulation: { rows: entry.rows },
      summary: entry.summary,
      taxScope: 'MODELED_FEDERAL_LINE_24',
    };
    const controller = createCashFlowController({
      getScenarios: () => [scenario],
      scenarioInputsByResult: new WeakMap([[scenario.res, { plan, overrides: {} }]]),
      selection: { id: 'historical-1973' },
      historicalCache: { get: () => historical },
      buildRows,
    });

    const result = controller.resultForScenario(scenario);

    assert.equal(result.error, undefined);
    assert.equal(result.headerMetrics.outcome, entry.expectedOutcome);
    const metric = result.headerMetrics.rows.find(row => row.id === entry.expectedMetric);
    assert.equal(metric.delta, entry.expectedDelta);
    assert.equal(result.rows.length, entry.rows.length);
    assert.equal(Object.isFrozen(result.summary), true);
    assert.equal(Object.isFrozen(result.headerMetrics), true);
  }
});

test('a header-only metric failure preserves the authoritative historical ledger', () => {
  const typical = simulation(7, 700_000);
  const scenario = {
    base: true,
    name: 'Baseline',
    res: { sims: [typical], paths: { p50: { simIndex: 7 } } },
  };
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const historical = {
    kind: 'historical',
    pathId: 'historical-1995',
    simulation: { rows: [{
      year: 1, age: 65, phase: 'ret', source: 1995, startBalance: 750_000,
      balance: 700_000, fundingShortfall: 0, failed: false, wdRate: 0, taxes: 0,
    }] },
    summary: { outcome: 'survives', endingBalance: 700_000 },
  };
  const errors = [];
  const headerDiagnostics = [];
  const controller = createCashFlowController({
    getScenarios: () => [scenario],
    scenarioInputsByResult: new WeakMap([[scenario.res, { plan, overrides: {} }]]),
    selection: { id: 'historical-1995' },
    historicalCache: { get: () => historical },
    buildRows,
    onError: (...args) => errors.push(args),
    onHeaderDiagnostic: (...args) => headerDiagnostics.push(args),
  });

  const result = controller.resultForScenario(scenario);

  assert.equal(result.error, undefined);
  assert.equal(result.kind, 'historical');
  assert.equal(result.summary.outcome, 'survives');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].ending, 700_000);
  assert.equal('headerMetrics' in result, false);
  assert.equal(errors.length, 0);
  assert.equal(headerDiagnostics.length, 1);
  assert.equal(headerDiagnostics[0][0], 'Cash Flow header unavailable:');
});

test('selector shows only active-scenario known outcomes without running another period', () => {
  const plan = {
    meta: { planningAsOfYear: 2026 },
    household: { primary: { currentAge: 65 } },
    goals: [],
  };
  const scenario = {
    base: true,
    name: 'Baseline',
    res: { sims: [simulation(7, 700_000)], paths: { p50: { simIndex: 7 } } },
  };
  const secondScenario = {
    name: 'Scenario B',
    res: { sims: [simulation(7, 600_000)], paths: { p50: { simIndex: 7 } } },
  };
  const outcomesByAnalysis = new WeakMap([
    [scenario.res, new Map([
      ['historical-1973', 'underfunded'],
      ['historical-1995', 'survives'],
    ])],
    [secondScenario.res, new Map([
      ['historical-1973', 'survives'],
    ])],
  ]);
  let getCalls = 0;
  const historicalCache = {
    get: () => { getCalls += 1; throw new Error('sync must not calculate'); },
    peek: args => {
      const outcome = outcomesByAnalysis.get(args.analysis)?.get(args.periodId);
      return outcome ? { summary: { outcome } } : null;
    },
  };
  const selection = { id: 'historical-1973' };
  const controller = createCashFlowController({
    getScenarios: () => [scenario, secondScenario],
    scenarioInputsByResult: new WeakMap([
      [scenario.res, { plan, overrides: {} }],
      [secondScenario.res, { plan, overrides: {} }],
    ]),
    selection,
    historicalCache,
    buildRows,
  });
  const classes = new Set();
  const attributes = new Map();
  const status = {
    textContent: '',
    hidden: true,
    classList: {
      toggle(name, enabled){
        if(enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value){ attributes.set(name, value); },
    removeAttribute(name){ attributes.delete(name); },
  };
  const ownerDocument = {
    createElement: () => ({ value: '', textContent: '', dataset: {} }),
    getElementById: id => id === 'cashflow-path-status' ? status : null,
  };
  const select = {
    options: [],
    value: '',
    ownerDocument,
    replaceChildren(...options){ this.options = options; },
  };

  controller.syncSelect(select, scenario);

  assert.equal(getCalls, 0);
  assert.equal(select.value, 'historical-1973');
  assert.equal(select.options.find(option => option.value === 'historical-1973').textContent, '1973 \u00b7 Stagflation');
  assert.match(select.options.find(option => option.value === 'historical-1995').textContent, /^✓ /);
  assert.doesNotMatch(select.options.find(option => option.value === 'historical-2008').textContent, /^[✓!] /);
  assert.equal(status.textContent, '!');
  assert.equal(status.hidden, false);
  assert.equal(classes.has('is-underfunded'), true);
  assert.equal(classes.has('is-success'), false);
  assert.equal(attributes.get('aria-label'), 'Historical path becomes underfunded');

  selection.id = 'historical-1995';
  controller.syncSelect(select, scenario);
  assert.equal(select.value, 'historical-1995');
  assert.match(select.options.find(option => option.value === 'historical-1973').textContent, /^! /);
  assert.equal(select.options.find(option => option.value === 'historical-1995').textContent, '1995 \u00b7 90s Boom');
  assert.equal(status.textContent, '✓');
  assert.equal(status.hidden, false);
  assert.equal(classes.has('is-underfunded'), false);
  assert.equal(classes.has('is-success'), true);
  assert.equal(attributes.get('aria-label'), 'Historical path funded through plan end');

  selection.id = 'typical';
  controller.syncSelect(select, scenario);
  assert.equal(select.value, 'typical');
  assert.equal(status.textContent, '');
  assert.equal(status.hidden, true);
  assert.equal(classes.has('is-underfunded'), false);
  assert.equal(classes.has('is-success'), false);
  assert.equal(attributes.has('aria-label'), false);

  controller.syncSelect(select, secondScenario);
  assert.match(select.options.find(option => option.value === 'historical-1973').textContent, /^✓ /);
  assert.doesNotMatch(select.options.find(option => option.value === 'historical-1995').textContent, /^[✓!] /);
  assert.equal(getCalls, 0);

  selection.id = 'historical-1973';
  controller.syncSelect(select, secondScenario);
  assert.equal(status.textContent, '✓');
  assert.equal(attributes.get('aria-label'), 'Historical path funded through plan end');
  assert.equal(getCalls, 0);
});

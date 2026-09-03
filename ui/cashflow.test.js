import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPlan, resolveInputs, runSimulation } from '../engine.js';
import { flatAssetReturnRow } from '../test/fixtures/assetReturnRows.js';
import { createBlankHousehold, createSelectableDefaultHouseholds } from './householdFactories.js';
import {
  ACTIVE_KEY, HHDB_KEY, commitPreparedHouseholdStore, createMemoryStorage,
  prepareHouseholdRecordForSave, prepareHouseholdStore, readHouseholdStore,
} from '../src/household/persistence.js';

import {
  buildPathRows,
  buildSimulationRows,
  formatCashFlowHeaderMoney,
  groupPhases,
  renderCashflow,
} from './cashflow.js';

const plan = { household: { primary: { currentAge: 65 } }, goals: [] };
const deps = {
  simByIndex: result => result.sim,
  baselineResult: () => null,
  plan,
  currentYear: 2026,
};

test('Cash Flow does not infer annual shortfall from zero balance or sticky path failure', () => {
  const scenario = { res: { sim: { rows: [{
    age: 65,
    phase: 'ret',
    withdrawal: 100_000,
    balance: 0,
    fundingShortfall: 0,
    failed: true,
  }] } } };

  const [row] = buildPathRows(scenario, deps);

  assert.equal(row.draw, 100_000);
  assert.equal(row.ending, 0);
  assert.equal(row.shortfall, false);
});

test('Cash Flow consumes the engine funding shortfall contract', () => {
  const scenario = { res: { sim: { rows: [{
    age: 65,
    phase: 'ret',
    withdrawal: 25_000,
    balance: 0,
    fundingShortfall: 5_000,
    failed: true,
  }] } } };

  const [row] = buildPathRows(scenario, deps);

  assert.equal(row.fundingShortfall, 5_000);
  assert.equal(row.shortfall, true);
  assert.equal(row.effectiveWdRate, null, 'missing engine metric must not become a displayed zero');
});

test('Cash Flow displays gross required RMD when an ordinary IRA withdrawal already satisfies it', () => {
  const simulation = { rows: [{
    age: 73,
    phase: 'ret',
    withdrawal: 80_000,
    accountBreakdown: { traditional: 80_000 },
    rmdRequired: 30_000,
    rmd: 0,
    taxes: 15_000,
    balance: 620_000,
    fundingShortfall: 0,
  }] };

  const [row] = buildSimulationRows(simulation, { plan, currentYear: 2026 });

  assert.equal(row.rmd, 30_000);
  assert.equal(row.draw, 80_000);
  assert.equal(row.tax, 15_000);
});

test('Cash Flow renders the engine effective withdrawal rate and preserves legacy diagnostic data', () => {
  const [row] = buildSimulationRows({ rows: [{
    age: 65,
    source: 2026,
    phase: 'ret',
    returnRate: 0.2,
    returnDollars: 400_000,
    withdrawal: 180_000,
    startBalance: 2_000_000,
    wdRate: 9,
    effectiveWdRate: 7.5,
    balance: 2_220_000,
    fundingShortfall: 0,
  }] }, { plan, currentYear: 2026 });
  const scenario = {
    id: 'baseline', name: 'Baseline', tone: '#8fa57e', prob: 100,
    probStr: '100.0', median: '$2.2M', raw: { res: {} },
  };
  const html = renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'typical', pathId: 'typical', rows: [row], summary: {},
    }),
    cashFromRetirement: false,
    isTypicalPath: () => true,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  });

  assert.equal(row.wdRate, 9);
  assert.equal(row.effectiveWdRate, 7.5);
  assert.match(html, /data-wd-rate="9"/);
  assert.match(html, /data-effective-wd-rate="7\.5"/);
  assert.match(html, /cf-cell--wd[^>]*>7\.5%<\/span>/);
  assert.doesNotMatch(html, /cf-cell--wd[^>]*>9%<\/span>/);
  assert.match(html, /title="Draw divided by the portfolio after this year's return, before the draw"/);
});

test('Future demo Cash Flow starts its RMD phase at the first engine-required RMD, age 75', () => {
  const future = createSelectableDefaultHouseholds(defaultPlan, 2026)
    .find(household => household.meta.householdId === 'future-household');
  const before = JSON.stringify(future);
  const params = resolveInputs(future, {});
  const market = Array.from({ length: params.horizonYears }, (_, i) => flatAssetReturnRow(2026 + i));
  const simulation = runSimulation(future, {}, [market]).paths.p50;
  const rows = buildSimulationRows(simulation, { plan: future, currentYear: 2026 });

  assert.equal(simulation.rows.find(row => row.rmdRequired > 0)?.age, 75);
  assert.equal(rows.find(row => row.age === 73).rmd, 0);
  assert.equal(rows.find(row => row.age === 74).rmd, 0);
  assert.deepEqual(groupPhases(rows).map(phase => phase.rows.map(row => row.age)), [
    rows.filter(row => row.age < 75).map(row => row.age),
    rows.filter(row => row.age >= 75).map(row => row.age),
  ]);
  assert.equal(JSON.stringify(future), before, 'render preparation must not mutate household facts');
});

test('Cash Flow phase grouping follows required RMD rows without inventing an age threshold', () => {
  const cases = [
    { ages: [], required: [], expected: [] },
    { ages: [72, 73, 74], required: [0, 100, 90], expected: [[72], [73, 74]] },
    { ages: [72, 73, 74, 75], required: [0, 0, 0, 100], expected: [[72, 73, 74], [75]] },
    { ages: [72, 73, 74, 75], required: [0, 0, 0, 0], expected: [[72, 73, 74, 75]] },
    // An older spouse can require RMDs before the primary turns 73.
    { ages: [69, 70, 71], required: [0, 100, 90], expected: [[69], [70, 71]] },
    // If RMDs already apply at the first visible year, there is no invented pre-RMD band.
    { ages: [72, 73, 74], required: [100, 90, 80], expected: [[72, 73, 74]] },
    // A later zero requirement does not move years back into the pre-RMD phase.
    { ages: [72, 73, 74, 75], required: [0, 100, 0, 0], expected: [[72], [73, 74, 75]] },
  ];
  for(const { ages, required, expected } of cases){
    const simulation = { rows: ages.map((age, i) => ({
      age, phase: 'accum', rmdRequired: required[i], rmd: 0,
    })) };
    const rows = buildSimulationRows(simulation, { plan, currentYear: 2026 });
    assert.deepEqual(groupPhases(rows).map(phase => phase.rows.map(row => row.age)), expected,
      `ages ${ages}; required RMDs ${required}`);
  }
});

test('a saved Future-derived household retains exact RMD rows through canonical reloads', () => {
  // Synthetic current-schema saved household, not an export of the user's Parker record.
  const defaults = createSelectableDefaultHouseholds(defaultPlan, 2026);
  const source = structuredClone(defaults.find(household => household.meta.householdId === 'future-household'));
  const id = 'hh_rmdfixture';
  Object.assign(source.meta, {
    householdId: id, name: 'RMD reload fixture', isSelectableDefault: false, isDemo: false,
  });
  const saved = prepareHouseholdRecordForSave(source, id);
  const savedBytes = JSON.stringify(saved);
  const database = Object.fromEntries(defaults.map(household => [household.meta.householdId, household]));
  database[id] = saved;
  const databaseBytes = JSON.stringify(database);
  const storage = createMemoryStorage({ [HHDB_KEY]: databaseBytes, [ACTIVE_KEY]: id });
  const params = resolveInputs(saved, {});
  const market = Array.from({ length: params.horizonYears }, (_, i) => flatAssetReturnRow(2026 + i));
  const projectedRows = household => buildSimulationRows(
    runSimulation(household, {}, [market]).paths.p50,
    { plan: household, currentYear: 2026 },
  );
  const before = projectedRows(saved);
  assert.equal(before.find(row => row.rmd > 0)?.age, 75);

  for(let reload = 0; reload < 2; reload++){
    const prepared = prepareHouseholdStore(readHouseholdStore(storage), {
      createBlankHousehold, createSelectableDefaultHouseholds,
      pristinePlan: defaultPlan, currentYear: () => 2026,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, 'normal');
    assert.equal(prepared.activeHouseholdId, null, 'startup requires explicit household selection');
    assert.equal(JSON.stringify(prepared.db[id]), savedBytes);
    assert.deepEqual(projectedRows(prepared.db[id]), before);
    assert.equal(commitPreparedHouseholdStore(storage, prepared).ok, true);
    assert.equal(storage.getItem(HHDB_KEY), databaseBytes);
    assert.equal(storage.getItem(ACTIVE_KEY), null);
  }
});

test('Cash Flow visibly labels the engine-owned annual shortfall for Typical', () => {
  const row = {
    year: 2026, age: 65, accum: false, ret: 0, income: 0, rmd: 0,
    essential: 0, goals: 30_000, tax: 0, draw: 25_000, wdRate: 0,
    ending: 0, fundingShortfall: 5_000, shortfall: true, startPort: 25_000,
    goalTag: null,
  };
  const scenario = {
    id: 'baseline', name: 'Baseline', tone: '#8fa57e', prob: 0,
    probStr: '0.0', median: '$0', raw: { res: {} },
  };
  const html = renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'typical',
      pathId: 'typical',
      rows: [row],
      summary: {},
    }),
    cashFromRetirement: false,
    isTypicalPath: () => true,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    toneGlow: () => '',
    ring: () => '',
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  });

  assert.match(html, /data-funding-shortfall="5000"/);
  assert.match(html, /class="cf-row__shortfall">Short \$5,000<\/span>/);
});

test('Typical Cash Flow uses one selector and the locked two-metric header', () => {
  const row = {
    year: 2026, age: 65, accum: false, ret: 0, income: 0, rmd: 0,
    essential: 0, goals: 0, tax: 4_000, draw: 0, wdRate: 0,
    ending: 700_000, fundingShortfall: 0, shortfall: false, startPort: 700_000,
    goalTag: null,
  };
  const baseline = {
    id: 'baseline', name: 'Baseline', tone: '#829A78', prob: 99.5,
    probStr: '99.5', median: '$4.1M', raw: { res: {} },
  };
  const alternative = {
    id: 'alternative', name: 'Scenario B', tone: '#B1845C', prob: 90,
    probStr: '90.0', median: '$3.2M', raw: { res: {} },
  };
  const selected = {
    kind: 'typical',
    pathId: 'typical',
    simIndex: 7,
    rows: [row],
    summary: { peakWdRate: 7.4, peakWdAge: 69 },
    headerMetrics: {
      kind: 'typical',
      outcome: 'survives',
      fundedThroughAge: 95,
      fundedThroughSupport: 'Plan end',
      endingPosition: 2_410_000,
    },
    taxScope: 'MODELED_FEDERAL_LINE_24',
  };
  const renderDeps = {
    cashFlowResult: () => selected,
    cashFromRetirement: false,
    isTypicalPath: () => true,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  };
  const html = renderCashflow(baseline, [baseline, alternative], renderDeps);

  assert.match(html, /<select data-cash-select aria-label="Cash Flow scenario">/);
  assert.match(html, /<option value="baseline" selected>Baseline<\/option>/);
  assert.match(html, /<option value="alternative">Scenario B<\/option>/);
  assert.doesNotMatch(html, /data-cash-pick|class="cf-pill/);
  assert.match(html, /Funded through/);
  assert.match(html, /Age 95/);
  assert.match(html, /Plan end/);
  assert.match(html, /Ending position/);
  assert.match(html, /\$2\.41M/);
  assert.match(html, /Median path/);
  assert.match(html, /data-sim-index="7"/);
  assert.doesNotMatch(html, /data-cash-path-metrics|cf-path-rail/);
  assert.doesNotMatch(html, /Random path|Sampled path|data-cash-path-kind="random"/);
  assert.doesNotMatch(html, /Peak withdrawal/);
  assert.doesNotMatch(html, /Probability of success|Median Ending|Federal total|data-federal-total/);

  selected.headerMetrics = {
    ...selected.headerMetrics,
    outcome: 'underfunded',
    fundedThroughAge: 87,
    fundedThroughSupport: 'Plan underfunded',
    endingPosition: 0,
  };
  const underfundedHtml = renderCashflow(baseline, [baseline, alternative], renderDeps);
  assert.match(underfundedHtml, /data-outcome="underfunded"/);
  assert.match(underfundedHtml, /Age 87/);
  assert.match(underfundedHtml, /Plan underfunded/);
  assert.match(underfundedHtml, /Ending position[\s\S]*\$0/);
});

test('underfunded historical Cash Flow keeps the path rail traceable to engine metrics', () => {
  const row = {
    year: 2051, age: 89, sourceYear: 1973, accum: false, ret: -0.12,
    income: 0, rmd: 0, essential: 0, goals: 30_000, tax: 0,
    draw: 25_000, wdRate: 8.1, ending: 0, fundingShortfall: 5_000,
    shortfall: true, startPort: 25_000, goalTag: null,
  };
  const scenario = {
    id: 'baseline', name: 'Baseline', tone: '#8fa57e', prob: 84,
    probStr: '84.0', median: '$900K', raw: { res: {} },
  };
  const html = renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'historical',
      pathId: 'historical-1973',
      period: {
        id: 'historical-1973',
        startYear: 1973,
        name: 'Stagflation',
        label: '1973 · Stagflation',
      },
      rows: [row],
      summary: {
        outcome: 'underfunded',
        firstUnderfundedAge: 89,
        firstUnderfundedYear: 2051,
        fundedThroughAge: 88,
        fundedThroughYear: 2050,
        peakWdRate: 8.1,
        peakWdAge: 89,
        peakWdYear: 2051,
        endingBalance: null,
        endingAge: null,
        comparisonYear: 2051,
        comparisonBalance: 0,
        typicalComparisonBalance: 450_000,
        deltaVsTypical: -450_000,
      },
      headerMetrics: {
        kind: 'historical',
        outcome: 'underfunded',
        rows: [{
          id: 'lowest-balance-first-10-years', label: '10-year Low', format: 'money',
          thisPath: 200_000, typicalPath: 1_900_000, delta: -1_700_000,
          thisPathAge: 80, typicalPathAge: 74,
        }, {
          id: 'average-effective-withdrawal-rate', label: 'Effective WD Rate', format: 'percentage',
          thisPath: 8.2, typicalPath: 5.4, delta: 2.8,
        }, {
          id: 'recovery-period', label: 'Recovery', format: 'recovery',
          thisPath: null, typicalPath: 5, delta: null,
          thisPathRecoveryStatus: 'not-observed', typicalPathRecoveryStatus: 'recovered',
          thisPathRecoveryAge: null, typicalPathRecoveryAge: 90,
        }, {
          id: 'balance-at-age-80', label: 'Real balance at age 80', format: 'money',
          thisPath: 620_000, typicalPath: 1_900_000, delta: -1_280_000,
        }, {
          id: 'funded-through-margin', label: 'Funded through · margin', format: 'funding',
          description: 'If funded through plan end, margin is zero-return years at the final modeled portfolio draw; otherwise it is years short of plan end.',
          thisPath: 88, typicalPath: 95, delta: -7, marginDelta: -19,
          thisPathMargin: -7, typicalPathMargin: 12,
          thisPathMarginKind: 'years-short', typicalPathMarginKind: 'zero-return-runway',
          planEndAge: 95,
        }],
      },
      taxScope: 'MODELED_FEDERAL_LINE_24',
    }),
    cashFromRetirement: false,
    isTypicalPath: () => false,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    toneGlow: () => '',
    ring: () => '',
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  });

  assert.match(html, /data-cash-path-id="historical-1973"/);
  assert.match(html, /data-source-year="1973"/);
  assert.match(html, /data-outcome="underfunded"/);
  assert.match(html, /class="cf-path-rail" data-cash-path-metrics/);
  assert.match(html, /aria-label="Path comparison"/);
  assert.match(html, /data-cash-path-selected-period="historical-1973"/);
  assert.match(html, /cf-path-rail__selected-period-year">1973<\/span> · <span class="cf-path-rail__selected-period-name">Stagflation<\/span>/);
  assert.ok(
    html.indexOf('data-cash-path-selected-period="historical-1973"')
      < html.indexOf('data-historical-metric="lowest-balance-first-10-years"')
  );
  assert.equal((html.match(/data-path-reference-metric=/g) || []).length, 5);
  assert.equal((html.match(/data-historical-metric=/g) || []).length, 5);
  assert.match(html, />Typical</);
  assert.match(html, /10-year Low[\s\S]*\$1\.9M/);
  assert.match(html, /10-year Low[\s\S]*\$200K[\s\S]*−\$1\.7M/);
  assert.match(html, /Effective WD Rate[\s\S]*5\.4%/);
  assert.match(html, /Effective WD Rate[\s\S]*8\.2%[\s\S]*\+2\.8 pts/);
  assert.match(html, /Recovery[\s\S]*5 yrs · Age 90/);
  assert.match(html, /data-historical-metric="recovery-period"[\s\S]*>Not observed<[\s\S]*cf-path-rail__delta--muted"><\/div>/);
  assert.match(html, /Age 80[\s\S]*\$1\.9M/);
  assert.match(html, /Age 80[\s\S]*\$620K[\s\S]*−\$1\.28M/);
  assert.match(html, /Funded through[\s\S]*Age 95/);
  assert.match(html, /Funded through[\s\S]*Age 88[\s\S]*−7 yrs/);
  assert.equal((html.match(/data-delta-tone="negative"/g) || []).length, 4);
  assert.equal((html.match(/data-delta-tone="muted"/g) || []).length, 1);
  assert.match(html, /class="cf-path-rail__selected" data-cash-path-selected/);
  assert.doesNotMatch(html, /Max Drawdown|Years above 6% WD rate|Deepest dip in savings|Years below starting balance|Max real drawdown|Underwater duration|Real balance at age 80|Funded through · margin/);
  assert.doesNotMatch(html, /cf-summary--historical|cf-comparison|role="columnheader"|role="rowheader"|role="cell"/);
  assert.doesNotMatch(html, /Dips |Recovers | less| more|Lasts | · no trough|computed-delta|delta-pill/);
  assert.match(html, /cf-cell cf-cell--ending[^>]*><span>Underfunded<\/span>/);
  assert.doesNotMatch(html, /modeled shortfall|Short \$5,000/);
  assert.doesNotMatch(html, /Median withdrawal rate|Ending portfolio|Portfolio at age|First underfunded age|Ending position/);
  assert.doesNotMatch(html, /Probability of success/);
  assert.doesNotMatch(html, /Median Ending/);
  assert.doesNotMatch(html, /Federal tax scope|data-tax-scope-disclosure/);
});

test('surviving historical Cash Flow renders the Option 3a reference fixture in exact order', () => {
  const row = {
    year: 2032, age: 70, sourceYear: 1977, accum: false, ret: 0.08,
    income: 0, rmd: 0, essential: 10_000, goals: 0, tax: 0,
    draw: 10_000, wdRate: 4.2, ending: 450_000, fundingShortfall: 0,
    shortfall: false, startPort: 475_000, goalTag: null,
  };
  const scenario = {
    id: 'baseline', name: 'Baseline', tone: '#8fa57e', prob: 84,
    probStr: '84.0', median: '$900K', raw: { res: {} },
  };
  const html = renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'historical',
      pathId: 'historical-1966',
      period: {
        id: 'historical-1966',
        startYear: 1966,
        name: 'Lost Decade',
        label: '1966 · Lost Decade',
      },
      rows: [row],
      summary: {
        outcome: 'survives',
        firstUnderfundedAge: null,
        firstUnderfundedYear: null,
        fundedThroughAge: 70,
        fundedThroughYear: 2032,
        endingBalance: 450_000,
        endingAge: 70,
        endingYear: 2032,
        peakWdRate: 4.2,
        peakWdAge: 68,
        peakWdYear: 2030,
        comparisonYear: 2032,
        comparisonBalance: 450_000,
        typicalComparisonBalance: 400_000,
        deltaVsTypical: 50_000,
      },
      headerMetrics: {
        kind: 'historical',
        outcome: 'survives',
        rows: [{
          id: 'lowest-balance-first-10-years', label: '10-year Low', format: 'money',
          thisPath: 7_990_000, typicalPath: 9_810_000, delta: -1_820_000,
          thisPathAge: 72, typicalPathAge: null,
        }, {
          id: 'average-effective-withdrawal-rate', label: 'Effective WD Rate', format: 'percentage',
          thisPath: 6.4, typicalPath: 5.1, delta: 1.3,
        }, {
          id: 'recovery-period', label: 'Recovery', format: 'recovery',
          thisPath: 8, typicalPath: 2, delta: 6,
          thisPathRecoveryStatus: 'recovered', typicalPathRecoveryStatus: 'recovered',
          thisPathRecoveryAge: 80, typicalPathRecoveryAge: 70,
        }, {
          id: 'balance-at-age-80', label: 'Real balance at age 80', format: 'money',
          thisPath: 7_990_000, typicalPath: 9_810_000, delta: -1_820_000,
        }, {
          id: 'funded-through-margin', label: 'Funded through · margin', format: 'funding',
          thisPath: 95, typicalPath: 95, delta: 0, marginDelta: 0,
          thisPathMargin: 12, typicalPathMargin: 12,
          thisPathMarginKind: 'zero-return-runway', typicalPathMarginKind: 'zero-return-runway',
          planEndAge: 95,
        }],
      },
      taxScope: 'MODELED_FEDERAL_LINE_24',
    }),
    cashFromRetirement: false,
    isTypicalPath: () => false,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    toneGlow: () => '',
    ring: () => '',
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  });

  assert.match(html, /data-outcome="survives"/);
  assert.match(html, /data-cash-path-selected-period="historical-1966"/);
  assert.match(html, /cf-path-rail__selected-period-year">1966<\/span> · <span class="cf-path-rail__selected-period-name">Lost Decade<\/span>/);
  assert.ok(
    html.indexOf('data-cash-path-selected-period="historical-1966"')
      < html.indexOf('data-historical-metric="lowest-balance-first-10-years"')
  );
  assert.equal((html.match(/data-path-reference-metric=/g) || []).length, 5);
  assert.equal((html.match(/data-historical-metric=/g) || []).length, 5);
  const labels = [...html.matchAll(/class="cf-path-rail__(?:reference-label|metric-name)">([^<]+)/g)]
    .map(match => match[1]);
  assert.deepEqual(labels, [
    '10-year Low',
    'Effective WD Rate',
    'Recovery',
    'Age 80',
    'Funded through',
    '10-year Low',
    'Effective WD Rate',
    'Recovery',
    'Age 80',
    'Funded through',
  ]);
  assert.match(html, />Typical[\s\S]*\$9\.81M[\s\S]*5\.1%[\s\S]*2 yrs · Age 70[\s\S]*\$9\.81M[\s\S]*Age 95/);
  assert.match(html, /6\.4%[\s\S]*\+1\.3 pts/);
  assert.match(html, /8 yrs · Age 80[\s\S]*\+6 yrs/);
  assert.match(html, /\$7\.99M[\s\S]*−\$1\.82M/);
  assert.match(html, /Age 95[\s\S]*Same/);
  assert.equal((html.match(/data-delta-tone="negative"/g) || []).length, 4);
  assert.equal((html.match(/data-delta-tone="muted"/g) || []).length, 1);
  assert.doesNotMatch(html, /cf-path-rail__delta--positive|var\(--pos\)/);
  assert.doesNotMatch(html, /Max Drawdown|Years above 6% WD rate|cf-summary--historical|cf-comparison|This path|>Delta</);
  assert.doesNotMatch(html, /Median withdrawal rate|Ending portfolio|Peak withdrawal rate/);
  assert.doesNotMatch(html, /Funded through plan end|Through age 70|age 68|Plan funding|Ending position| · no trough/);
  assert.doesNotMatch(html, /Probability of success|Median Ending|modeled shortfall|Federal tax scope|data-tax-scope-disclosure/);

  const nearZeroRows = [
    {
      id: 'lowest-balance-first-10-years', label: '10-year Low', format: 'money',
      thisPath: 9_809_999.6, typicalPath: 9_810_000, delta: -0.4,
      thisPathAge: 72, typicalPathAge: 72,
    },
    {
      id: 'average-effective-withdrawal-rate', label: 'Effective WD Rate', format: 'percentage',
      thisPath: 5.24, typicalPath: 5.25, delta: -0.01,
    },
    {
      id: 'recovery-period', label: 'Recovery', format: 'recovery',
      thisPath: 2, typicalPath: 2, delta: 0,
      thisPathRecoveryStatus: 'recovered', typicalPathRecoveryStatus: 'recovered',
      thisPathRecoveryAge: 70, typicalPathRecoveryAge: 70,
    },
    {
      id: 'balance-at-age-80', label: 'Real balance at age 80', format: 'money',
      thisPath: 9_809_999.6, typicalPath: 9_810_000, delta: -0.4,
    },
    {
      id: 'funded-through-margin', label: 'Funded through · margin', format: 'funding',
      thisPath: 95, typicalPath: 95, delta: 0, marginDelta: 0,
      thisPathMargin: 12, typicalPathMargin: 12,
      thisPathMarginKind: 'zero-return-runway', typicalPathMarginKind: 'zero-return-runway',
      planEndAge: 95,
    },
  ];
  const renderMetricRows = rows => renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'historical', pathId: 'historical-1966',
      period: {
        id: 'historical-1966',
        startYear: 1966,
        name: 'Lost Decade',
        label: '1966 · Lost Decade',
      },
      rows: [row],
      summary: { outcome: 'survives' },
      headerMetrics: { kind: 'historical', outcome: 'survives', rows },
      taxScope: 'MODELED_FEDERAL_LINE_24',
    }),
    cashFromRetirement: false,
    isTypicalPath: () => false,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    toneGlow: () => '',
    ring: () => '',
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  });
  const nearZeroHtml = renderMetricRows(nearZeroRows);
  assert.match(nearZeroHtml, /data-path-reference-metric="average-effective-withdrawal-rate"[\s\S]*>5\.3%<[\s\S]*data-historical-metric="average-effective-withdrawal-rate"[\s\S]*>5\.2%<[\s\S]*>−0\.1 pts<\/div>/);
  assert.equal((nearZeroHtml.match(/>Same<\/div>/g) || []).length, 4);
  assert.doesNotMatch(nearZeroHtml, /0\.0 pts|[−+]\$0/);

  const bothNeverHtml = renderMetricRows(nearZeroRows.map(metric => (
    metric.id === 'recovery-period'
      ? {
          ...metric,
          thisPath: null,
          typicalPath: null,
          delta: 0,
          thisPathRecoveryStatus: 'never',
          typicalPathRecoveryStatus: 'never',
          thisPathRecoveryAge: null,
          typicalPathRecoveryAge: null,
        }
      : metric
  )));
  assert.match(bothNeverHtml, /data-path-reference-metric="recovery-period"[\s\S]*>Never</);
  assert.match(bothNeverHtml, /data-historical-metric="recovery-period"[\s\S]*>Never<[\s\S]*>Same<\/div>/);

  const truncatedRecoveryHtml = renderMetricRows(nearZeroRows.map(metric => (
    metric.id === 'recovery-period'
      ? {
          ...metric,
          thisPath: null,
          delta: null,
          thisPathRecoveryStatus: 'not-observed',
          thisPathRecoveryAge: null,
        }
      : metric
  )));
  assert.match(truncatedRecoveryHtml, /data-path-reference-metric="recovery-period"[\s\S]*>2 yrs · Age 70</);
  assert.match(truncatedRecoveryHtml, /data-historical-metric="recovery-period"[\s\S]*>Not observed<[\s\S]*cf-path-rail__delta--muted"><\/div>/);
});

test('Cash Flow comparison money formatter uses deterministic dollars, K, and M bands', () => {
  assert.equal(formatCashFlowHeaderMoney(0), '$0');
  assert.equal(formatCashFlowHeaderMoney(999), '$999');
  assert.equal(formatCashFlowHeaderMoney(1_000), '$1K');
  assert.equal(formatCashFlowHeaderMoney(999_499), '$999K');
  assert.equal(formatCashFlowHeaderMoney(999_999), '$999K');
  assert.equal(formatCashFlowHeaderMoney(1_000_000), '$1M');
  assert.equal(formatCashFlowHeaderMoney(2_860_000), '$2.86M');
  assert.equal(formatCashFlowHeaderMoney(-850_000, { signed: true }), '−$850K');
  assert.equal(formatCashFlowHeaderMoney(50_000), '$50K');
  assert.notEqual(formatCashFlowHeaderMoney(50_000), '$0.05M');
});

test('unavailable historical Cash Flow suppresses all financial summary claims', () => {
  const scenario = {
    id: 'baseline', name: 'Baseline', tone: '#8fa57e', prob: 84,
    probStr: '84.0', median: '$900K', raw: { res: {} },
  };
  const html = renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'historical',
      pathId: 'historical-1973',
      rows: [],
      summary: {},
      error: 'This path is unavailable because its retirement handoff could not be verified.',
    }),
    cashFromRetirement: false,
    isTypicalPath: () => false,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    toneGlow: () => '',
    ring: () => '',
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  });

  assert.match(html, /retirement handoff could not be verified/);
  assert.doesNotMatch(html, /cf-summary--historical|data-cash-path-metrics/);
  assert.doesNotMatch(html, /Ending portfolio at plan end|First underfunded year|Delta vs\. Typical|Peak withdrawal rate/);
});

test('historical Cash Flow keeps a valid ledger when only its header metrics are unavailable', () => {
  const row = {
    year: 2032, age: 70, sourceYear: 1995, accum: false, ret: 0.08,
    income: 0, rmd: 0, essential: 10_000, goals: 0, tax: 0,
    draw: 10_000, wdRate: 0, ending: 450_000, fundingShortfall: 0,
    shortfall: false, startPort: 475_000, goalTag: null,
  };
  const scenario = {
    id: 'baseline', name: 'Baseline', tone: '#8fa57e', prob: 84,
    probStr: '84.0', median: '$900K', raw: { res: {} },
  };
  const html = renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'historical',
      pathId: 'historical-1995',
      rows: [row],
      summary: { outcome: 'survives', endingBalance: 450_000 },
    }),
    cashFromRetirement: false,
    isTypicalPath: () => false,
    typicalPathFederalTax: () => null,
    pathFederalTax: () => null,
    toneGlow: () => '',
    ring: () => '',
    wdColor: () => '',
    num: value => String(value),
    esc: value => String(value),
    fmtMoney: value => `$${Number(value).toLocaleString('en-US')}`,
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'],
  });

  assert.match(html, /data-cash-path-id="historical-1995"/);
  assert.match(html, /data-source-year="1995"/);
  assert.match(html, /\$450,000/);
  assert.doesNotMatch(html, /cf-summary--historical|data-cash-path-metrics|retirement handoff could not be verified/);
});

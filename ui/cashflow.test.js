import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPathRows,
  buildSimulationRows,
  formatCashFlowHeaderMoney,
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
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
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
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
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
          id: 'max-real-drawdown', label: 'Max real drawdown', format: 'drawdown',
          thisPath: 100, typicalPath: 35.2, delta: 64.8,
          thisPathAge: 89, typicalPathAge: 74,
        }, {
          id: 'years-above-6-wd-rate', label: 'Years above 6% WD rate', format: 'years',
          thisPath: 8, typicalPath: 2, delta: 6,
        }, {
          id: 'underwater-duration', label: 'Underwater duration', format: 'years',
          thisPath: 14, typicalPath: 5, delta: 9,
        }, {
          id: 'balance-at-age-80', label: 'Real balance at age 80', format: 'money',
          thisPath: 620_000, typicalPath: 1_900_000, delta: -1_280_000,
        }, {
          id: 'funded-through-margin', label: 'Funded through · margin', format: 'funding',
          description: 'If funded through plan end, margin is zero-return years at the final modeled portfolio draw; otherwise it is years short of plan end.',
          thisPath: 88, typicalPath: 95, delta: -19,
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
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
  });

  assert.match(html, /data-cash-path-id="historical-1973"/);
  assert.match(html, /data-source-year="1973"/);
  assert.match(html, /data-outcome="underfunded"/);
  assert.match(html, /class="cf-path-rail" data-cash-path-metrics/);
  assert.match(html, /aria-label="Selected path metrics compared with Typical path"/);
  assert.equal((html.match(/data-path-reference-metric=/g) || []).length, 4);
  assert.equal((html.match(/data-historical-metric=/g) || []).length, 4);
  assert.match(html, /Typical path/);
  assert.match(html, /Deepest dip in savings[\s\S]*−35\.2%/);
  assert.match(html, /Deepest dip in savings[\s\S]*−100\.0%[\s\S]*Dips 64\.8 pts further/);
  assert.match(html, /Years below starting balance[\s\S]*5 yrs/);
  assert.match(html, /Years below starting balance[\s\S]*14 yrs[\s\S]*Recovers 9 yrs later/);
  assert.match(html, /Savings left at age 80[\s\S]*\$1\.9M/);
  assert.match(html, /Savings left at age 80[\s\S]*\$620K[\s\S]*\$1\.28M less/);
  assert.match(html, /Money lasts through[\s\S]*Age 95/);
  assert.match(html, /Money lasts through[\s\S]*Age 88[\s\S]*Lasts 7 yrs less/);
  assert.equal((html.match(/data-verdict-tone="negative"/g) || []).length, 4);
  assert.doesNotMatch(html, /Years above 6% WD rate|Max real drawdown|Underwater duration|Real balance at age 80|Funded through · margin/);
  assert.doesNotMatch(html, /cf-summary--historical|cf-comparison|role="columnheader"|role="rowheader"|role="cell"/);
  assert.doesNotMatch(html, / · age | · no trough|computed-delta|delta-pill/);
  assert.match(html, /cf-cell cf-cell--ending[^>]*><span>Underfunded<\/span>/);
  assert.doesNotMatch(html, /modeled shortfall|Short \$5,000/);
  assert.doesNotMatch(html, /Early withdrawal pressure|Median withdrawal rate|Ending portfolio|Portfolio at age|First underfunded age|Ending position/);
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
      pathId: 'historical-1973',
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
          id: 'max-real-drawdown', label: 'Max real drawdown', format: 'drawdown',
          thisPath: 36.5, typicalPath: 31.7, delta: 4.8,
          thisPathAge: 72, typicalPathAge: null,
        }, {
          id: 'years-above-6-wd-rate', label: 'Years above 6% WD rate', format: 'years',
          thisPath: 4, typicalPath: 1, delta: 3,
        }, {
          id: 'underwater-duration', label: 'Underwater duration', format: 'years',
          thisPath: 8, typicalPath: 2, delta: 6,
        }, {
          id: 'balance-at-age-80', label: 'Real balance at age 80', format: 'money',
          thisPath: 7_990_000, typicalPath: 9_810_000, delta: -1_820_000,
        }, {
          id: 'funded-through-margin', label: 'Funded through · margin', format: 'funding',
          thisPath: 95, typicalPath: 95, delta: 0,
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
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
  });

  assert.match(html, /data-outcome="survives"/);
  assert.equal((html.match(/data-path-reference-metric=/g) || []).length, 4);
  assert.equal((html.match(/data-historical-metric=/g) || []).length, 4);
  const labels = [...html.matchAll(/class="cf-path-rail__(?:reference-label|metric-name)">([^<]+)/g)]
    .map(match => match[1]);
  assert.deepEqual(labels, [
    'Deepest dip in savings',
    'Years below starting balance',
    'Savings left at age 80',
    'Money lasts through',
    'Deepest dip in savings',
    'Years below starting balance',
    'Savings left at age 80',
    'Money lasts through',
  ]);
  assert.match(html, /Typical path[\s\S]*−31\.7%[\s\S]*2 yrs[\s\S]*\$9\.81M[\s\S]*Age 95/);
  assert.match(html, /−36\.5%[\s\S]*Dips 4\.8 pts further/);
  assert.match(html, /8 yrs[\s\S]*Recovers 6 yrs later/);
  assert.match(html, /\$7\.99M[\s\S]*\$1\.82M less/);
  assert.match(html, /Age 95[\s\S]*Lasts just as long/);
  assert.equal((html.match(/data-verdict-tone="negative"/g) || []).length, 3);
  assert.equal((html.match(/data-verdict-tone="muted"/g) || []).length, 1);
  assert.doesNotMatch(html, /cf-path-rail__verdict--positive|var\(--pos\)/);
  assert.doesNotMatch(html, /Years above 6% WD rate|cf-summary--historical|cf-comparison|This path|>Delta</);
  assert.doesNotMatch(html, /Median withdrawal rate|Ending portfolio|Peak withdrawal rate/);
  assert.doesNotMatch(html, /Funded through plan end|Through age 70|age 68|Plan funding|Ending position| · age | · no trough/);
  assert.doesNotMatch(html, /Probability of success|Median Ending|modeled shortfall|Federal tax scope|data-tax-scope-disclosure/);

  const nearZeroRows = [
    {
      id: 'max-real-drawdown', label: 'Max real drawdown', format: 'drawdown',
      thisPath: 31.74, typicalPath: 31.66, delta: 0.08,
      thisPathAge: 72, typicalPathAge: 72,
    },
    {
      id: 'years-above-6-wd-rate', label: 'Years above 6% WD rate', format: 'years',
      thisPath: 1, typicalPath: 1, delta: 0,
    },
    {
      id: 'underwater-duration', label: 'Underwater duration', format: 'years',
      thisPath: 2, typicalPath: 2, delta: 0,
    },
    {
      id: 'balance-at-age-80', label: 'Real balance at age 80', format: 'money',
      thisPath: 9_809_999.6, typicalPath: 9_810_000, delta: -0.4,
    },
    {
      id: 'funded-through-margin', label: 'Funded through · margin', format: 'funding',
      thisPath: 95, typicalPath: 95, delta: 0,
      thisPathMargin: 12, typicalPathMargin: 12,
      thisPathMarginKind: 'zero-return-runway', typicalPathMarginKind: 'zero-return-runway',
      planEndAge: 95,
    },
  ];
  const nearZeroHtml = renderCashflow(scenario, [scenario], {
    cashFlowResult: () => ({
      kind: 'historical', pathId: 'historical-1973', rows: [row],
      summary: { outcome: 'survives' },
      headerMetrics: { kind: 'historical', outcome: 'survives', rows: nearZeroRows },
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
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
  });
  assert.match(nearZeroHtml, /Dips just as far/);
  assert.match(nearZeroHtml, /Same amount left/);
  assert.doesNotMatch(nearZeroHtml, /Dips 0\.0 pts further|\$0 less/);
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
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
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
    cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
  });

  assert.match(html, /data-cash-path-id="historical-1995"/);
  assert.match(html, /data-source-year="1995"/);
  assert.match(html, /\$450,000/);
  assert.doesNotMatch(html, /cf-summary--historical|data-cash-path-metrics|retirement handoff could not be verified/);
});

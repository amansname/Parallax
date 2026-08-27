import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPathRows,
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
  assert.doesNotMatch(html, /Peak withdrawal/);
  assert.doesNotMatch(html, /Probability of success|Median Ending|Federal total|data-federal-total/);

  selected.kind = 'random';
  selected.pathId = 'random';
  selected.simIndex = 11;
  const randomHtml = renderCashflow(baseline, [baseline, alternative], renderDeps);
  assert.match(randomHtml, /data-cash-path-id="random"/);
  assert.match(randomHtml, /data-cash-path-kind="random"/);
  assert.match(randomHtml, /data-sim-index="11"/);
  assert.match(randomHtml, /Sampled path/);
  assert.doesNotMatch(randomHtml, /Median path/);

  selected.kind = 'typical';
  selected.pathId = 'typical';
  selected.simIndex = 7;

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

test('underfunded historical Cash Flow shows three compact outcome metrics', () => {
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
          id: 'early-withdrawal-pressure',
          label: 'Early withdrawal pressure',
          format: 'percent',
          thisPath: 6.9,
          typicalPath: 4.3,
          delta: 2.6,
          planYear: 2,
        }, {
          id: 'portfolio-at-underfunding',
          label: 'Portfolio at age 89',
          format: 'money',
          thisPath: 50_000,
          typicalPath: 2_860_000,
          delta: -2_810_000,
          planYear: 26,
        }, {
          id: 'first-underfunded-age',
          label: 'First underfunded age',
          format: 'age',
          thisPath: 89,
          typicalPath: null,
          delta: null,
          planYear: 26,
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
  assert.match(html, /class="cf-comparison" role="table" aria-label="Historical path comparison"/);
  assert.match(html, /class="cf-comparison__head" role="row"/);
  assert.equal((html.match(/role="columnheader"/g) || []).length, 4);
  assert.equal((html.match(/role="rowheader"/g) || []).length, 3);
  assert.equal((html.match(/role="cell"/g) || []).length, 9);
  assert.doesNotMatch(html, /cf-comparison__head" aria-hidden/);
  assert.equal((html.match(/data-historical-metric=/g) || []).length, 3);
  assert.match(html, /Early withdrawal pressure/);
  assert.match(html, /Portfolio at age 89/);
  assert.match(html, /First underfunded age/);
  assert.match(html, /6\.9%/);
  assert.match(html, /4\.3%/);
  assert.match(html, /\+2\.6 pts/);
  assert.match(html, /\$50K/);
  assert.match(html, /\$2\.86M/);
  assert.match(html, /−\$2\.81M/);
  assert.match(html, /cf-cell cf-cell--ending[^>]*><span>Underfunded<\/span>/);
  assert.doesNotMatch(html, /modeled shortfall|Short \$5,000/);
  assert.doesNotMatch(html, /Peak withdrawal rate|First underfunded year|Underfunded at age|funded through age|Plan funding|Ending position/);
  assert.doesNotMatch(html, /Probability of success/);
  assert.doesNotMatch(html, /Median Ending/);
  assert.doesNotMatch(html, /Federal tax scope|data-tax-scope-disclosure/);
});

test('surviving historical Cash Flow shows only the locked two-row comparison', () => {
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
          id: 'median-withdrawal-rate',
          label: 'Median withdrawal rate',
          format: 'percent',
          thisPath: 2.8,
          typicalPath: 4.1,
          delta: -1.3,
        }, {
          id: 'ending-portfolio',
          label: 'Ending portfolio',
          format: 'money',
          thisPath: 5_860_000,
          typicalPath: 2_410_000,
          delta: 3_450_000,
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
  assert.equal((html.match(/data-historical-metric=/g) || []).length, 2);
  assert.match(html, /Median withdrawal rate/);
  assert.match(html, /Ending portfolio/);
  assert.match(html, /2\.8%/);
  assert.match(html, /4\.1%/);
  assert.match(html, /−1\.3 pts/);
  assert.match(html, /\$5\.86M/);
  assert.match(html, /\$2\.41M/);
  assert.match(html, /\+\$3\.45M/);
  assert.doesNotMatch(html, /Peak withdrawal rate/);
  assert.doesNotMatch(html, /Funded through plan end|Through age 70|age 68|Plan funding|Ending position/);
  assert.doesNotMatch(html, /Probability of success|Median Ending|modeled shortfall|Federal tax scope|data-tax-scope-disclosure/);
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
  assert.doesNotMatch(html, /cf-summary--historical/);
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
  assert.doesNotMatch(html, /cf-summary--historical|retirement handoff could not be verified/);
});

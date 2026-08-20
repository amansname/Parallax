import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPathRows, renderCashflow } from './cashflow.js';

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

test('underfunded historical Cash Flow shows only the authoritative failure boundary', () => {
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
        peakWdRate: null,
        peakWdAge: null,
        endingBalance: null,
        endingAge: null,
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
  assert.match(html, /data-first-underfunded-age="89"/);
  assert.match(html, /data-first-underfunded-year="2051"/);
  assert.match(html, /Underfunded at age 89/);
  assert.match(html, /First underfunded year 2051 · funded through age 88/);
  assert.match(html, /cf-cell cf-cell--ending[^>]*><span>Underfunded<\/span>/);
  assert.doesNotMatch(html, /modeled shortfall|Short \$5,000/);
  assert.doesNotMatch(html, /Ending position/);
  assert.doesNotMatch(html, /Peak withdrawal/);
  assert.doesNotMatch(html, /Probability of success/);
  assert.doesNotMatch(html, /Median Ending/);
});

test('surviving historical Cash Flow shows plan end, ending value, and peak withdrawal', () => {
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
  assert.match(html, /Funded through plan end/);
  assert.match(html, /Through age 70 · 2032/);
  assert.match(html, /Ending position/);
  assert.match(html, /\$450,000/);
  assert.match(html, /Peak withdrawal/);
  assert.match(html, /4.2%/);
  assert.match(html, /age 68 · 2030/);
  assert.doesNotMatch(html, /Probability of success|Median Ending|modeled shortfall/);
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
  assert.doesNotMatch(html, /Funded through plan end|Underfunded at age|Ending position|Peak withdrawal/);
});

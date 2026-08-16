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

test('Cash Flow does not infer a shortfall from a fully funded zero ending balance', () => {
  const scenario = { res: { sim: { rows: [{
    age: 65,
    phase: 'ret',
    withdrawal: 100_000,
    balance: 0,
    fundingShortfall: 0,
    failed: false,
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

test('Cash Flow visibly labels the engine-owned shortfall amount', () => {
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
    pathRows: () => [row],
    cashSummary: () => ({}),
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

  assert.match(html, /data-funding-shortfall="5000"/);
  assert.match(html, /class="cf-row__shortfall">Short \$5,000<\/span>/);
});

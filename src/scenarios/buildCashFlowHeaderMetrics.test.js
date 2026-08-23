import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCashFlowHeaderMetrics } from './buildCashFlowHeaderMetrics.js';

function row({
  year,
  age = 65 + year - 1,
  phase = 'ret',
  source = 1995 + year - 1,
  wdRate = 0,
  startBalance = 1_000_000,
  balance = 900_000,
  fundingShortfall = 0,
  failed = false,
  people,
} = {}){
  return {
    year,
    age,
    phase,
    source,
    wdRate,
    startBalance,
    balance,
    fundingShortfall,
    failed,
    ...(people ? { people } : {}),
  };
}

function historicalResult(outcome, rows){
  return {
    kind: 'historical',
    simulation: { rows },
    summary: {
      outcome,
      endingBalance: outcome === 'survives' ? rows.at(-1).balance : null,
    },
  };
}

test('Typical header reports the living household plan-end age and ending position only', () => {
  const metrics = buildCashFlowHeaderMetrics({
    typicalSimulation: {
      rows: [
        row({ year: 1, phase: 'accum', age: 64, wdRate: 0 }),
        row({ year: 2, age: 65, wdRate: 3.4, balance: 940_000 }),
        row({
          year: 3,
          age: 98,
          wdRate: 4.1,
          balance: 910_000,
          people: {
            client: { age: 98, alive: false },
            spouse: { age: 95, alive: true },
          },
        }),
      ],
    },
    typicalDigest: { peakWdRate: 4.1, peakWdAge: 66 },
  });

  assert.deepEqual(metrics, {
    kind: 'typical',
    outcome: 'survives',
    fundedThroughAge: 95,
    fundedThroughSupport: 'Plan end',
    endingPosition: 910_000,
  });
  assert.equal(Object.isFrozen(metrics), true);
});

test('underfunded Typical reports its last funded age and same-path boundary position', () => {
  const metrics = buildCashFlowHeaderMetrics({
    typicalSimulation: {
      rows: [
        row({ year: 1, age: 65, wdRate: 4, balance: 80_000 }),
        row({
          year: 2,
          age: 66,
          wdRate: 100,
          startBalance: 80_000,
          balance: 0,
          fundingShortfall: 20_000,
          failed: true,
        }),
        row({ year: 3, age: 67, source: null, balance: 0, fundingShortfall: 0, failed: true }),
      ],
    },
    typicalDigest: { peakWdRate: 100, peakWdAge: 66 },
  });

  assert.equal(metrics.outcome, 'underfunded');
  assert.equal(metrics.fundedThroughAge, 65);
  assert.equal(metrics.fundedThroughSupport, 'Plan underfunded');
  assert.equal(metrics.endingPosition, 0);
  assert.equal('peakWithdrawalRate' in metrics, false);
  assert.equal('peakWithdrawalAge' in metrics, false);
});

test('underfunded Typical never counts accumulation as funded through retirement', () => {
  assert.throws(() => buildCashFlowHeaderMetrics({
    typicalSimulation: {
      rows: [
        row({ year: 1, phase: 'accum', age: 64, wdRate: 9, balance: 80_000 }),
        row({
          year: 2,
          age: 65,
          wdRate: 100,
          startBalance: 80_000,
          balance: 0,
          fundingShortfall: 20_000,
          failed: true,
        }),
      ],
    },
    typicalDigest: { peakWdRate: 100, peakWdAge: 65 },
  }), /Typical last funded age is unavailable/);
});

test('successful Historical header excludes invalid rows from odd/even medians and uses real plan end', () => {
  const historicalRows = [
    row({ year: -4, phase: 'accum', wdRate: 99 }),
    row({ year: -3, source: null, wdRate: 98 }),
    row({ year: -2, wdRate: 97, failed: true }),
    row({ year: -1, wdRate: 0 }),
    row({ year: 0, wdRate: -6 }),
    row({ year: 1, wdRate: 8, balance: 900_000 }),
    row({ year: 2, wdRate: 2, balance: 860_000 }),
    row({ year: 3, wdRate: 4, balance: 820_000 }),
  ];
  const typicalRows = [
    row({ year: -4, phase: 'accum', wdRate: 96 }),
    row({ year: -3, source: null, wdRate: 95 }),
    row({ year: -2, wdRate: 94, failed: true }),
    row({ year: -1, wdRate: 0 }),
    row({ year: 0, wdRate: -5 }),
    row({ year: 1, wdRate: 1, balance: 1_100_000 }),
    row({ year: 2, wdRate: 7, balance: 1_050_000 }),
    row({ year: 3, wdRate: 3, balance: 1_020_000 }),
    row({ year: 4, wdRate: 5, balance: 1_000_000 }),
  ];
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', historicalRows),
    typicalSimulation: { rows: typicalRows },
  });

  assert.equal(metrics.rows[0].id, 'median-withdrawal-rate');
  assert.equal(metrics.rows[0].thisPath, 4);
  assert.equal(metrics.rows[0].typicalPath, 4);
  assert.equal(metrics.rows[0].delta, 0);
  assert.equal(metrics.rows[1].id, 'ending-portfolio');
  assert.equal(metrics.rows[1].thisPath, 820_000);
  assert.equal(metrics.rows[1].typicalPath, 1_000_000);
  assert.equal(metrics.rows[1].delta, -180_000);
  assert.equal(Object.isFrozen(metrics.rows), true);
  assert.equal(Object.isFrozen(metrics.rows[0]), true);
});

test('successful Historical comparison rejects a Typical filler as plan end', () => {
  const historicalRows = [row({ year: 1, wdRate: 4, balance: 800_000 })];
  const typicalRows = [
    row({ year: 1, wdRate: 4, balance: 700_000 }),
    row({ year: 2, source: null, balance: 0, fundingShortfall: 0, failed: true }),
  ];

  assert.throws(() => buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', historicalRows),
    typicalSimulation: { rows: typicalRows },
  }), /Typical funded plan-end row is unavailable/);
});

test('underfunded Historical header uses first-decade pressure and exact opening portfolios', () => {
  const people = {
    client: { age: 87, alive: true },
    spouse: { age: 88, alive: true },
  };
  const historicalRows = Array.from({ length: 11 }, (_, index) => row({
    year: index + 1,
    wdRate: index === 1 || index === 3 ? 6.9 : (index === 10 ? 99 : 4 + index / 10),
    startBalance: 1_000_000 - index * 70_000,
    balance: 950_000 - index * 70_000,
  }));
  historicalRows.push(row({
    year: 12,
    age: 87,
    wdRate: 100,
    startBalance: 50_000,
    balance: 0,
    fundingShortfall: 25_000,
    failed: true,
    people,
  }));
  const typicalRows = Array.from({ length: 12 }, (_, index) => row({
    year: index + 1,
    age: 65 + index,
    wdRate: index === 1 ? 4.3 : 3.5,
    startBalance: index === 11 ? 2_860_000 : 2_000_000 + index * 50_000,
    balance: 2_050_000 + index * 50_000,
  }));

  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', historicalRows),
    typicalSimulation: { rows: typicalRows },
  });

  assert.equal(metrics.outcome, 'underfunded');
  assert.deepEqual(metrics.rows[0], {
    id: 'early-withdrawal-pressure',
    label: 'Early withdrawal pressure',
    format: 'percent',
    thisPath: 6.9,
    typicalPath: 4.3,
    delta: 2.6000000000000005,
    planYear: 2,
  });
  assert.deepEqual(metrics.rows[1], {
    id: 'portfolio-at-underfunding',
    label: 'Portfolio at age 88',
    format: 'money',
    thisPath: 50_000,
    typicalPath: 2_860_000,
    delta: -2_810_000,
    planYear: 12,
  });
  assert.equal(metrics.rows[2].thisPath, 88);
  assert.equal(metrics.rows[2].typicalPath, null);
  assert.equal(metrics.rows[2].delta, null);
});

test('early pressure excludes accumulation, filler, failed, nonpositive, and first-underfunded rows', () => {
  const people = { client: { age: 71, alive: true }, spouse: null };
  const historicalRows = [
    row({ year: 1, phase: 'accum', age: 64, wdRate: 99 }),
    row({ year: 2, age: 65, wdRate: 0 }),
    row({ year: 3, age: 66, wdRate: -4 }),
    row({ year: 4, age: 67, wdRate: 5 }),
    row({ year: 5, age: 68, source: null, wdRate: 98 }),
    row({ year: 6, age: 69, wdRate: 97, failed: true }),
    row({ year: 7, age: 70, wdRate: 4 }),
    row({
      year: 8,
      age: 71,
      wdRate: 100,
      startBalance: 50_000,
      balance: 0,
      fundingShortfall: 25_000,
      failed: true,
      people,
    }),
  ];
  const typicalRows = Array.from({ length: 8 }, (_, index) => row({
    year: index + 1,
    age: 64 + index,
    phase: index === 0 ? 'accum' : 'ret',
    wdRate: index === 3 ? 3 : 4,
    startBalance: index === 7 ? 900_000 : 1_000_000,
  }));

  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', historicalRows),
    typicalSimulation: { rows: typicalRows },
  });

  assert.equal(metrics.rows[0].planYear, 4);
  assert.equal(metrics.rows[0].thisPath, 5);
  assert.equal(metrics.rows[0].typicalPath, 3);
  assert.equal(metrics.rows[1].planYear, 8);
  assert.equal(metrics.rows[2].thisPath, 71);
});

test('underfunded Historical comparison fails closed on missing household age evidence', () => {
  const historicalRows = [
    row({ year: 1, wdRate: 5 }),
    row({
      year: 2,
      wdRate: 100,
      startBalance: 50_000,
      balance: 0,
      fundingShortfall: 10_000,
      failed: true,
      people: {
        client: { age: 70, alive: true },
        spouse: { age: null, alive: true },
      },
    }),
  ];

  assert.throws(() => buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', historicalRows),
    typicalSimulation: { rows: [row({ year: 1, wdRate: 4 }), row({ year: 2, wdRate: 4 })] },
  }), /household ages are incomplete/);
});

test('underfunded Historical comparison never falls back from an absent exact Typical index', () => {
  const historicalRows = [
    row({ year: 1, wdRate: 5 }),
    row({
      year: 2,
      wdRate: 100,
      startBalance: 50_000,
      balance: 0,
      fundingShortfall: 10_000,
      failed: true,
      people: { client: { age: 66, alive: true }, spouse: null },
    }),
  ];

  assert.throws(() => buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', historicalRows),
    typicalSimulation: { rows: [row({ year: 1, wdRate: 4 }), row({ year: 3, wdRate: 4 })] },
  }), /exact plan-year row is unavailable/);
});

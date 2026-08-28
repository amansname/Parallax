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

function digest(overrides = {}){
  return {
    maxRealDrawdownPct: 18.4,
    maxRealDrawdownTroughAge: 74,
    yearsAboveSixPctWdRate: 1,
    portfolioUnderwaterYearsMax: 3,
    realBalanceAtAge80: 1_600_000,
    fundedThroughAge: 95,
    planEndAge: 95,
    fundingMarginYears: 12,
    fundingMarginKind: 'zero-return-runway',
    ...overrides,
  };
}

function historicalResult(outcome, pathDigest){
  return {
    kind: 'historical',
    summary: { outcome },
    digest: pathDigest,
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
    typicalDigest: digest(),
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
    typicalDigest: digest(),
  });

  assert.equal(metrics.outcome, 'underfunded');
  assert.equal(metrics.fundedThroughAge, 65);
  assert.equal(metrics.fundedThroughSupport, 'Plan underfunded');
  assert.equal(metrics.endingPosition, 0);
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
    typicalDigest: digest(),
  }), /Typical last funded age is unavailable/);
});

test('Historical header exposes the fixed five-metric comparison in decision order', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({
      maxRealDrawdownPct: 41.2,
      maxRealDrawdownTroughAge: 72,
      yearsAboveSixPctWdRate: 4,
      portfolioUnderwaterYearsMax: 9,
      realBalanceAtAge80: 800_000,
      fundingMarginYears: 5.5,
    })),
    typicalDigest: digest(),
  });

  assert.deepEqual(metrics.rows.map(metric => metric.id), [
    'max-real-drawdown',
    'years-above-6-wd-rate',
    'underwater-duration',
    'balance-at-age-80',
    'funded-through-margin',
  ]);
  assert.deepEqual(metrics.rows[0], {
    id: 'max-real-drawdown',
    label: 'Max real drawdown',
    format: 'drawdown',
    thisPath: 41.2,
    typicalPath: 18.4,
    delta: 22.800000000000004,
    thisPathAge: 72,
    typicalPathAge: 74,
  });
  assert.deepEqual(metrics.rows[1], {
    id: 'years-above-6-wd-rate',
    label: 'Years above 6% WD rate',
    format: 'years',
    thisPath: 4,
    typicalPath: 1,
    delta: 3,
  });
  assert.deepEqual(metrics.rows[2], {
    id: 'underwater-duration',
    label: 'Underwater duration',
    format: 'years',
    thisPath: 9,
    typicalPath: 3,
    delta: 6,
  });
  assert.deepEqual(metrics.rows[3], {
    id: 'balance-at-age-80',
    label: 'Real balance at age 80',
    format: 'money',
    thisPath: 800_000,
    typicalPath: 1_600_000,
    thisPathUnavailable: null,
    typicalPathUnavailable: null,
    delta: -800_000,
  });
  assert.deepEqual(metrics.rows[4], {
    id: 'funded-through-margin',
    label: 'Funded through · margin',
    description: 'If funded through plan end, margin is zero-return years at the final modeled portfolio draw; otherwise it is years short of plan end.',
    format: 'funding',
    thisPath: 95,
    typicalPath: 95,
    delta: -6.5,
    thisPathMargin: 5.5,
    typicalPathMargin: 12,
    thisPathMarginKind: 'zero-return-runway',
    typicalPathMarginKind: 'zero-return-runway',
    planEndAge: 95,
  });
  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(Object.isFrozen(metrics.rows), true);
  assert.equal(Object.isFrozen(metrics.rows[0]), true);
});

test('underfunded Historical keeps all five metrics and expresses funding margin as years short', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', digest({
      maxRealDrawdownPct: 100,
      maxRealDrawdownTroughAge: 86,
      yearsAboveSixPctWdRate: 7,
      portfolioUnderwaterYearsMax: 10,
      realBalanceAtAge80: 200_000,
      fundedThroughAge: 85,
      fundingMarginYears: -10,
      fundingMarginKind: 'years-short',
    })),
    typicalDigest: digest(),
  });

  assert.equal(metrics.outcome, 'underfunded');
  assert.equal(metrics.rows.length, 5);
  assert.deepEqual(metrics.rows[4], {
    id: 'funded-through-margin',
    label: 'Funded through · margin',
    description: 'If funded through plan end, margin is zero-return years at the final modeled portfolio draw; otherwise it is years short of plan end.',
    format: 'funding',
    thisPath: 85,
    typicalPath: 95,
    delta: -22,
    thisPathMargin: -10,
    typicalPathMargin: 12,
    thisPathMarginKind: 'years-short',
    typicalPathMarginKind: 'zero-return-runway',
    planEndAge: 95,
  });
});

test('Historical age-80 balance fails closed per metric after earlier underfunding', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', digest({
      realBalanceAtAge80: null,
      fundedThroughAge: 78,
      fundingMarginYears: -17,
      fundingMarginKind: 'years-short',
    })),
    typicalDigest: digest(),
  });

  const age80 = metrics.rows.find(metric => metric.id === 'balance-at-age-80');
  assert.deepEqual(age80, {
    id: 'balance-at-age-80',
    label: 'Real balance at age 80',
    format: 'money',
    thisPath: null,
    typicalPath: 1_600_000,
    thisPathUnavailable: 'Underfunded before 80',
    typicalPathUnavailable: null,
    delta: null,
  });
});

test('Historical no-draw plan end does not invent infinite funding cushion', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({
      fundingMarginYears: null,
      fundingMarginKind: 'no-portfolio-draw',
    })),
    typicalDigest: digest(),
  });

  const funding = metrics.rows.find(metric => metric.id === 'funded-through-margin');
  assert.equal(funding.thisPathMargin, null);
  assert.equal(funding.thisPathMarginKind, 'no-portfolio-draw');
  assert.equal(funding.delta, null);
});

test('Historical header fails closed when engine digest evidence is absent', () => {
  assert.throws(() => buildCashFlowHeaderMetrics({
    historicalResult: { kind: 'historical', summary: { outcome: 'survives' } },
    typicalDigest: digest(),
  }), /Historical path digest is unavailable/);
});

test('Historical comparison rejects mismatched plan horizons', () => {
  assert.throws(() => buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({ planEndAge: 95 })),
    typicalDigest: digest({ planEndAge: 96, fundedThroughAge: 96 }),
  }), /plan-end ages do not match/);
});

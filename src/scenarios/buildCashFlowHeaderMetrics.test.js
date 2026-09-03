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
    lowestRealBalanceFirst10Years: 1_600_000,
    lowestRealBalanceFirst10Age: 74,
    yearsAboveFivePctWdRateFirst10Years: 1,
    yearsAboveFivePctEffectiveWdRateFirst10Years: 1,
    avgEffectiveWdRate: 5.25,
    earlyWindowYears: 10,
    marketRecoveryPeriodStatus: 'recovered',
    marketRecoveryPeriodYears: 3,
    marketRecoveryAge: 77,
    realBalanceAtAge80: 1_600_000,
    fundedThroughAge: 95,
    planEndAge: 95,
    fundingMarginYears: 12,
    fundingMarginKind: 'zero-return-runway',
    ...overrides,
  };
}

function singlePersonSimulation(...ages){
  const modeledAges = [...new Set(ages.length > 0 ? ages : [77, 95])].sort((a, b) => a - b);
  return {
    rows: modeledAges.map((age, index) => (
      row({
        year: index + 1,
        age,
        people: {
          client: { age, alive: true },
          spouse: null,
        },
      })
    )),
  };
}

function historicalResult(
  outcome,
  pathDigest,
  simulation = singlePersonSimulation(
    ...[
      pathDigest.marketRecoveryPeriodStatus === 'recovered' ? pathDigest.marketRecoveryAge : null,
      pathDigest.fundedThroughAge,
    ].filter(Number.isInteger)
  )
){
  return {
    kind: 'historical',
    summary: { outcome },
    digest: pathDigest,
    ...(simulation ? { simulation } : {}),
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
    typicalDigest: digest({ fundedThroughAge: 98, planEndAge: 98 }),
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

test('Historical rail translates a younger surviving spouse horizon to the living household age', () => {
  const rawHistoricalDigest = digest({ fundedThroughAge: 98, planEndAge: 98 });
  const rawTypicalDigest = digest({ fundedThroughAge: 98, planEndAge: 98 });
  const jointSimulation = {
    rows: [
      row({
        year: 1,
        age: 65,
        people: {
          client: { age: 65, alive: true },
          spouse: { age: 62, alive: true },
        },
      }),
      row({
        year: 13,
        age: 77,
        people: {
          client: { age: 77, alive: true },
          spouse: { age: 74, alive: true },
        },
      }),
      row({
        year: 34,
        age: 98,
        people: {
          client: { age: 98, alive: false },
          spouse: { age: 95, alive: true },
        },
      }),
    ],
  };

  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', rawHistoricalDigest, jointSimulation),
    typicalSimulation: jointSimulation,
    typicalDigest: rawTypicalDigest,
  });
  const funding = metrics.rows.find(metric => metric.id === 'funded-through-margin');
  const recovery = metrics.rows.find(metric => metric.id === 'recovery-period');

  assert.equal(funding.thisPath, 95);
  assert.equal(funding.typicalPath, 95);
  assert.equal(funding.planEndAge, 95);
  assert.equal(funding.delta, 0);
  assert.equal(recovery.thisPathRecoveryAge, 77, 'recovery keeps the oldest living age on its row');
  assert.equal(recovery.typicalPathRecoveryAge, 77, 'Typical recovery uses the same row-local age rule');
  assert.equal(rawHistoricalDigest.fundedThroughAge, 98, 'engine timeline remains unchanged');
  assert.equal(rawTypicalDigest.planEndAge, 98, 'engine plan horizon remains unchanged');
});

test('underfunded Typical reports its last funded age and same-path boundary position', () => {
  const metrics = buildCashFlowHeaderMetrics({
    typicalSimulation: {
      rows: [
        row({
          year: 1,
          age: 65,
          wdRate: 4,
          balance: 80_000,
          people: {
            client: { age: 65, alive: true },
            spouse: null,
          },
        }),
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
        row({
          year: 31,
          age: 95,
          source: null,
          balance: 0,
          fundingShortfall: 0,
          failed: true,
          people: {
            client: { age: 95, alive: true },
            spouse: null,
          },
        }),
      ],
    },
    typicalDigest: digest(),
  });

  assert.equal(metrics.outcome, 'underfunded');
  assert.equal(metrics.fundedThroughAge, 65);
  assert.equal(metrics.fundedThroughSupport, 'Plan underfunded');
  assert.equal(metrics.endingPosition, 0);
});

test('underfunded Typical holds the terminal spouse lens across the client-death boundary', () => {
  const metrics = buildCashFlowHeaderMetrics({
    typicalSimulation: {
      rows: [
        row({
          year: 31,
          age: 95,
          balance: 80_000,
          people: {
            client: { age: 95, alive: true },
            spouse: { age: 92, alive: true },
          },
        }),
        row({
          year: 32,
          age: 96,
          balance: 0,
          fundingShortfall: 20_000,
          failed: true,
          people: {
            client: { age: 96, alive: false },
            spouse: { age: 93, alive: true },
          },
        }),
        row({
          year: 34,
          age: 98,
          source: null,
          balance: 0,
          fundingShortfall: 0,
          failed: true,
          people: {
            client: { age: 98, alive: false },
            spouse: { age: 95, alive: true },
          },
        }),
      ],
    },
    typicalDigest: digest({ fundedThroughAge: 95, planEndAge: 98 }),
  });

  assert.equal(metrics.outcome, 'underfunded');
  assert.equal(metrics.fundedThroughAge, 92);
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
        row({
          year: 31,
          age: 95,
          source: null,
          balance: 0,
          fundingShortfall: 0,
          failed: true,
          people: {
            client: { age: 95, alive: true },
            spouse: null,
          },
        }),
      ],
    },
    typicalDigest: digest(),
  }), /Typical last funded age is unavailable/);
});

test('Historical header exposes the fixed five-metric comparison in decision order', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({
      lowestRealBalanceFirst10Years: 800_000,
      lowestRealBalanceFirst10Age: 72,
      yearsAboveFivePctWdRateFirst10Years: 4,
      yearsAboveFivePctEffectiveWdRateFirst10Years: 4,
      avgEffectiveWdRate: 7.75,
      marketRecoveryPeriodStatus: 'recovered',
      marketRecoveryPeriodYears: 9,
      marketRecoveryAge: 81,
      realBalanceAtAge80: 800_000,
      fundingMarginYears: 5.5,
    })),
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest(),
  });

  assert.deepEqual(metrics.rows.map(metric => metric.id), [
    'lowest-balance-first-10-years',
    'average-effective-withdrawal-rate',
    'recovery-period',
    'balance-at-age-80',
    'funded-through-margin',
  ]);
  assert.deepEqual(metrics.rows[0], {
    id: 'lowest-balance-first-10-years',
    label: '10-year Low',
    format: 'money',
    thisPath: 800_000,
    typicalPath: 1_600_000,
    delta: -800_000,
    thisPathAge: 72,
    typicalPathAge: 74,
  });
  assert.deepEqual(metrics.rows[1], {
    id: 'average-effective-withdrawal-rate',
    label: 'Effective WD Rate',
    format: 'percentage',
    thisPath: 7.75,
    typicalPath: 5.25,
    delta: 2.5,
  });
  assert.deepEqual(metrics.rows[2], {
    id: 'recovery-period',
    label: 'Recovery',
    format: 'recovery',
    thisPath: 9,
    typicalPath: 3,
    thisPathRecoveryStatus: 'recovered',
    typicalPathRecoveryStatus: 'recovered',
    thisPathRecoveryAge: 81,
    typicalPathRecoveryAge: 77,
    delta: 6,
  });
  assert.deepEqual(metrics.rows[3], {
    id: 'balance-at-age-80',
    label: 'Age 80',
    format: 'money',
    thisPath: 800_000,
    typicalPath: 1_600_000,
    thisPathUnavailable: null,
    typicalPathUnavailable: null,
    delta: -800_000,
  });
  assert.deepEqual(metrics.rows[4], {
    id: 'funded-through-margin',
    label: 'Funded through',
    description: 'If funded through plan end, margin is zero-return years at the final modeled portfolio draw; otherwise it is years short of plan end.',
    format: 'funding',
    thisPath: 95,
    typicalPath: 95,
    delta: 0,
    marginDelta: -6.5,
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

test('Historical comparison uses average effective withdrawal rate, not the legacy threshold count', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({
      yearsAboveFivePctWdRateFirst10Years: 0,
      yearsAboveFivePctEffectiveWdRateFirst10Years: 1,
      avgEffectiveWdRate: 6.4,
    })),
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest({
      yearsAboveFivePctWdRateFirst10Years: 0,
      yearsAboveFivePctEffectiveWdRateFirst10Years: 0,
      avgEffectiveWdRate: 4.9,
    }),
  });

  const rate = metrics.rows.find(metric => metric.id === 'average-effective-withdrawal-rate');
  assert.equal(rate.thisPath, 6.4);
  assert.equal(rate.typicalPath, 4.9);
  assert.equal(rate.delta, 1.5);
});

test('underfunded Historical keeps all five metrics and expresses funding margin as years short', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', digest({
      lowestRealBalanceFirst10Years: 200_000,
      lowestRealBalanceFirst10Age: 80,
      yearsAboveFivePctWdRateFirst10Years: 7,
      yearsAboveFivePctEffectiveWdRateFirst10Years: 7,
      marketRecoveryPeriodStatus: 'never',
      marketRecoveryPeriodYears: null,
      marketRecoveryAge: null,
      realBalanceAtAge80: 200_000,
      fundedThroughAge: 85,
      fundingMarginYears: -10,
      fundingMarginKind: 'years-short',
    })),
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest(),
  });

  assert.equal(metrics.outcome, 'underfunded');
  assert.equal(metrics.rows.length, 5);
  assert.deepEqual(metrics.rows[2], {
    id: 'recovery-period',
    label: 'Recovery',
    format: 'recovery',
    thisPath: null,
    typicalPath: 3,
    thisPathRecoveryStatus: 'never',
    typicalPathRecoveryStatus: 'recovered',
    thisPathRecoveryAge: null,
    typicalPathRecoveryAge: 77,
    delta: null,
  });
  assert.deepEqual(metrics.rows[4], {
    id: 'funded-through-margin',
    label: 'Funded through',
    description: 'If funded through plan end, margin is zero-return years at the final modeled portfolio draw; otherwise it is years short of plan end.',
    format: 'funding',
    thisPath: 85,
    typicalPath: 95,
    delta: -10,
    marginDelta: -22,
    thisPathMargin: -10,
    typicalPathMargin: 12,
    thisPathMarginKind: 'years-short',
    typicalPathMarginKind: 'zero-return-runway',
    planEndAge: 95,
  });
});

test('stable terminal-survivor lens does not switch to a living client before client death', () => {
  const historicalDigest = digest({
    fundedThroughAge: 95,
    planEndAge: 98,
    fundingMarginYears: -3,
    fundingMarginKind: 'years-short',
    marketRecoveryPeriodStatus: 'never',
    marketRecoveryPeriodYears: null,
    marketRecoveryAge: null,
  });
  const typicalPathDigest = digest({
    fundedThroughAge: 98,
    planEndAge: 98,
    marketRecoveryPeriodStatus: 'no-dip',
    marketRecoveryPeriodYears: 0,
    marketRecoveryAge: null,
  });
  const historicalSimulation = {
    rows: [
      row({
        year: 31,
        age: 95,
        people: {
          client: { age: 95, alive: true },
          spouse: { age: 92, alive: true },
        },
      }),
      row({
        year: 32,
        age: 96,
        balance: 0,
        fundingShortfall: 20_000,
        failed: true,
        people: {
          client: { age: 96, alive: false },
          spouse: { age: 93, alive: true },
        },
      }),
    ],
  };
  const typicalSimulation = {
    rows: [
      row({
        year: 34,
        age: 98,
        people: {
          client: { age: 98, alive: false },
          spouse: { age: 95, alive: true },
        },
      }),
    ],
  };

  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', historicalDigest, historicalSimulation),
    typicalSimulation,
    typicalDigest: typicalPathDigest,
  });
  const funding = metrics.rows.find(metric => metric.id === 'funded-through-margin');

  assert.equal(funding.thisPath, 92);
  assert.equal(funding.typicalPath, 95);
  assert.equal(funding.planEndAge, 95);
  assert.equal(funding.delta, -3);
  assert.equal(funding.thisPathMargin, -3, 'calendar-year engine margin remains unchanged');
  assert.equal(historicalDigest.fundedThroughAge, 95, 'raw timeline age remains unchanged');
});

test('Historical and Typical terminal recovery ages use the living spouse age', () => {
  const historicalDigest = digest({
    fundedThroughAge: 98,
    planEndAge: 98,
    marketRecoveryPeriodYears: 8,
    marketRecoveryAge: 98,
  });
  const typicalPathDigest = digest({
    fundedThroughAge: 98,
    planEndAge: 98,
    marketRecoveryPeriodYears: 5,
    marketRecoveryAge: 98,
  });
  const jointSimulation = {
    rows: [
      row({
        year: 34,
        age: 98,
        people: {
          client: { age: 98, alive: false },
          spouse: { age: 95, alive: true },
        },
      }),
    ],
  };

  const recovery = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', historicalDigest, jointSimulation),
    typicalSimulation: jointSimulation,
    typicalDigest: typicalPathDigest,
  }).rows.find(metric => metric.id === 'recovery-period');

  assert.equal(recovery.thisPathRecoveryAge, 95);
  assert.equal(recovery.typicalPathRecoveryAge, 95);
  assert.equal(recovery.delta, 3);
  assert.equal(historicalDigest.marketRecoveryAge, 98, 'Historical raw recovery age remains unchanged');
  assert.equal(typicalPathDigest.marketRecoveryAge, 98, 'Typical raw recovery age remains unchanged');
});

test('terminal-survivor translation fails closed on missing or inconsistent target evidence', () => {
  const historicalDigest = digest({
    fundedThroughAge: 95,
    planEndAge: 98,
    marketRecoveryPeriodStatus: 'never',
    marketRecoveryPeriodYears: null,
    marketRecoveryAge: null,
  });
  const typicalPathDigest = digest({
    fundedThroughAge: 98,
    planEndAge: 98,
    marketRecoveryPeriodStatus: 'no-dip',
    marketRecoveryPeriodYears: 0,
    marketRecoveryAge: null,
  });
  const typicalSimulation = {
    rows: [row({
      year: 34,
      age: 98,
      people: {
        client: { age: 98, alive: false },
        spouse: { age: 95, alive: true },
      },
    })],
  };

  assert.throws(() => buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', historicalDigest, {
      rows: [row({
        year: 31,
        age: 95,
        people: { client: { age: 95, alive: true }, spouse: null },
      })],
    }),
    typicalSimulation,
    typicalDigest: typicalPathDigest,
  }), /Historical funded-through terminal survivor is unavailable/);

  assert.throws(() => buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', historicalDigest, {
      rows: [row({
        year: 31,
        age: 95,
        people: {
          client: { age: 95, alive: true },
          spouse: { age: 93, alive: true },
        },
      })],
    }),
    typicalSimulation,
    typicalDigest: typicalPathDigest,
  }), /Historical funded-through terminal-survivor age is inconsistent/);
});

test('Historical recovery comparison preserves no-dip and both-never engine states', () => {
  const noDip = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({
      marketRecoveryPeriodStatus: 'no-dip',
      marketRecoveryPeriodYears: 0,
      marketRecoveryAge: null,
    })),
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest(),
  }).rows.find(metric => metric.id === 'recovery-period');

  assert.deepEqual(noDip, {
    id: 'recovery-period',
    label: 'Recovery',
    format: 'recovery',
    thisPath: 0,
    typicalPath: 3,
    thisPathRecoveryStatus: 'no-dip',
    typicalPathRecoveryStatus: 'recovered',
    thisPathRecoveryAge: null,
    typicalPathRecoveryAge: 77,
    delta: -3,
  });

  const bothNever = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({
      marketRecoveryPeriodStatus: 'never',
      marketRecoveryPeriodYears: null,
      marketRecoveryAge: null,
    })),
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest({
      marketRecoveryPeriodStatus: 'never',
      marketRecoveryPeriodYears: null,
      marketRecoveryAge: null,
    }),
  }).rows.find(metric => metric.id === 'recovery-period');

  assert.equal(bothNever.thisPath, null);
  assert.equal(bothNever.typicalPath, null);
  assert.equal(bothNever.thisPathRecoveryStatus, 'never');
  assert.equal(bothNever.typicalPathRecoveryStatus, 'never');
  assert.equal(bothNever.delta, 0);

  const bothNotObserved = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('survives', digest({
      marketRecoveryPeriodStatus: 'not-observed',
      marketRecoveryPeriodYears: null,
      marketRecoveryAge: null,
    })),
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest({
      marketRecoveryPeriodStatus: 'not-observed',
      marketRecoveryPeriodYears: null,
      marketRecoveryAge: null,
    }),
  }).rows.find(metric => metric.id === 'recovery-period');

  assert.equal(bothNotObserved.thisPathRecoveryStatus, 'not-observed');
  assert.equal(bothNotObserved.typicalPathRecoveryStatus, 'not-observed');
  assert.equal(bothNotObserved.thisPathRecoveryAge, null);
  assert.equal(bothNotObserved.typicalPathRecoveryAge, null);
  assert.equal(bothNotObserved.delta, 0);
});

test('Historical age-80 balance fails closed per metric after earlier underfunding', () => {
  const metrics = buildCashFlowHeaderMetrics({
    historicalResult: historicalResult('underfunded', digest({
      realBalanceAtAge80: null,
      fundedThroughAge: 78,
      fundingMarginYears: -17,
      fundingMarginKind: 'years-short',
    })),
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest(),
  });

  const age80 = metrics.rows.find(metric => metric.id === 'balance-at-age-80');
  assert.deepEqual(age80, {
    id: 'balance-at-age-80',
    label: 'Age 80',
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
    typicalSimulation: singlePersonSimulation(),
    typicalDigest: digest(),
  });

  const funding = metrics.rows.find(metric => metric.id === 'funded-through-margin');
  assert.equal(funding.thisPathMargin, null);
  assert.equal(funding.thisPathMarginKind, 'no-portfolio-draw');
  assert.equal(funding.delta, 0);
  assert.equal(funding.marginDelta, null);
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

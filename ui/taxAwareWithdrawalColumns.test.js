import test from 'node:test';
import assert from 'node:assert/strict';

import { buildThresholdColumns, formatWithdrawalMoney } from './taxAwareWithdrawalColumns.js';

test('formatWithdrawalMoney renders dash for non-finite values', () => {
  assert.equal(formatWithdrawalMoney(null), '—');
  assert.equal(formatWithdrawalMoney(12000), '$12,000');
});

test('buildThresholdColumns returns four threshold columns', () => {
  const cols = buildThresholdColumns({
    result: {
      ordinary: { rate: 0.22, income: 100000, roomToNext: 5000, ceiling: 105000 },
      ltcg: { rate: 0.15, stackedOn: 100000, gains: 10000, roomToZeroCeiling: 2000 },
      socialSecurity: { taxablePct: 0.85, provisionalIncome: 80000, roomToNext: 1000 },
      baseline: { ordinaryIncome: 80000, provisionalIncome: 60000 },
      ladders: {
        ordinary: [{ rate: 0.1, upTo: 10000 }, { rate: 0.22, upTo: 100000 }],
        ltcg: { zeroRateMax: 90000, fifteenRateMax: 500000 },
        socialSecurity: { tier1: 32000, tier2: 44000 },
      },
    },
    hoverMark: null,
  });
  assert.equal(cols.length, 4);
  assert.equal(cols[0].name, 'Income Tax');
  assert.match(cols[0].current, /%/);
  assert.ok(cols[0].marks.length >= 1);
});

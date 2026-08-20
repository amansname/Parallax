import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CASH_FLOW_PATH_OPTIONS,
  HISTORICAL_PERIODS,
  TYPICAL_CASH_FLOW_PATH_ID,
  historicalPeriodById,
  normalizeCashFlowPathId,
} from './historicalPeriods.js';

test('Cash Flow keeps Typical and exposes the nine approved historical periods', () => {
  assert.equal(CASH_FLOW_PATH_OPTIONS[0].id, TYPICAL_CASH_FLOW_PATH_ID);
  assert.deepEqual(
    HISTORICAL_PERIODS.map(period => period.startYear),
    [1929, 1937, 1966, 1973, 1995, 2000, 2008, 2009, 2022]
  );
  assert.equal(HISTORICAL_PERIODS.some(period => period.startYear === 1987), false);
  assert.equal(historicalPeriodById('historical-1973')?.name, 'Stagflation');
});

test('missing, invalid, removed, and legacy generic selections migrate to Typical', () => {
  for(const value of [
    null,
    '',
    'stressed',
    'favorable',
    'sequence-stress',
    'historical-1987',
    'black-monday',
    { mode: 'stressed' },
    { id: 'unknown' },
  ]){
    assert.equal(normalizeCashFlowPathId(value), TYPICAL_CASH_FLOW_PATH_ID);
  }
  assert.equal(normalizeCashFlowPathId({ mode: 'Typical' }), TYPICAL_CASH_FLOW_PATH_ID);
  assert.equal(normalizeCashFlowPathId({ pathId: 'historical-2008' }), 'historical-2008');
});

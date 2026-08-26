import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { RETURN_DATA } from '../../engine.js';
import {
  ASSET_KEYS,
  snapshotLegacyRiskProfileAllocation,
} from '../household/investmentAllocation.js';
import {
  INVALID_RETURN_ROW,
  RETURN_SERIES_PROVENANCE,
  resolveEffectiveAssetAllocation,
  validateAssetReturnRow,
  weightedAssetReturn,
} from './portfolioReturns.js';

const hash = value => crypto
  .createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

test('the return dataset observations, years, keys, and coverage stay frozen', () => {
  assert.equal(
    hash(RETURN_DATA),
    '4a4fa018fe4d1542ea0fcc5d3d1502103db7d84552334c0a8ff376e6c9e4ccc3',
  );
  assert.deepEqual(
    RETURN_DATA.map(row => row.y),
    Array.from({ length: 98 }, (_, index) => 1928 + index),
  );
  for(const row of RETURN_DATA){
    assert.deepEqual(Object.keys(row), ['y', ...ASSET_KEYS]);
    assert.equal(validateAssetReturnRow(row), true);
  }
  const coverage = RETURN_DATA.map(row => ({
    y: row.y,
    keys: Object.keys(row).filter(key => key !== 'y' && row[key] != null),
  }));
  assert.equal(
    hash(coverage),
    'c3fc0cbadf2417a425cf555d63e3e5aac2b5ac4fafa147aa1bc292ab90e85f35',
  );
});

test('return provenance separates source attribution from representative tickers', () => {
  assert.equal(RETURN_SERIES_PROVENANCE.version, `sha256:${hash(RETURN_DATA)}`);
  assert.equal(RETURN_SERIES_PROVENANCE.representativeTickersAreIllustrations, true);
  assert.deepEqual(
    RETURN_SERIES_PROVENANCE.segments.map(segment => [segment.startYear, segment.endYear, segment.status]),
    [
      [1928, 1984, 'verified-derivation'],
      [1985, 2024, 'verified-source'],
      [2025, 2025, 'unverified'],
    ],
  );
  assert.equal(RETURN_SERIES_PROVENANCE.segments[1].sourceUpdated, '2025-01-08');
  assert.equal(RETURN_SERIES_PROVENANCE.segments[2].source, 'source not recorded');
  assert.equal(RETURN_SERIES_PROVENANCE.assets.usLarge.representativeTicker, 'VFIAX');
});

test('early missing classes redistribute only inside their requested sleeve', () => {
  const requested = snapshotLegacyRiskProfileAllocation(3).weights;
  const row = RETURN_DATA.find(value => value.y === 1973);
  const resolved = resolveEffectiveAssetAllocation(row, requested);
  const growth = keys => keys.reduce((sum, key) => sum + resolved.effectiveWeights[key], 0);

  assert.equal(resolved.redistributionKind, 'within-sleeve');
  assert.deepEqual(resolved.unavailableAssetKeys, ['intlDev', 'emerging', 'reit']);
  assert.ok(Math.abs(growth(['usLarge', 'usSmall', 'intlDev', 'emerging', 'reit']) - 0.6) < 1e-12);
  assert.ok(Math.abs(growth(['usBonds', 'cash', 'gold']) - 0.4) < 1e-12);
  assert.equal(resolved.effectiveWeights.intlDev, 0);
  assert.equal(resolved.effectiveWeights.emerging, 0);
  assert.equal(resolved.effectiveWeights.reit, 0);
  assert.equal(resolved.baseRealReturn, weightedAssetReturn(row, requested));
});

test('modern years use the requested weights directly', () => {
  const requested = snapshotLegacyRiskProfileAllocation(4).weights;
  const row = RETURN_DATA.find(value => value.y === 2024);
  const resolved = resolveEffectiveAssetAllocation(row, requested);
  const manual = ASSET_KEYS.reduce((sum, key) => sum + requested[key] * row[key], 0);

  assert.equal(resolved.redistributionKind, 'none');
  assert.deepEqual(resolved.unavailableAssetKeys, []);
  assert.deepEqual(resolved.effectiveWeights, requested);
  assert.ok(Math.abs(resolved.baseRealReturn - manual) < 1e-15);
});

test('malformed annual rows fail closed with one deterministic code', () => {
  const requested = snapshotLegacyRiskProfileAllocation(3).weights;
  const valid = { ...RETURN_DATA[0] };
  for(const mutate of [
    row => { delete row.cash; },
    row => { row.y = 2025.5; },
    row => { row.gold = Number.NaN; },
    row => { row.usLarge = -1; },
  ]){
    const row = { ...valid };
    mutate(row);
    assert.throws(
      () => resolveEffectiveAssetAllocation(row, requested),
      error => error?.code === INVALID_RETURN_ROW,
    );
  }
});

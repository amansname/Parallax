import test from 'node:test';
import assert from 'node:assert/strict';
import { composeIrmaaMagi } from '../composers/irmaaMagi.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { irmaa } from './irmaa.js';

const context = {
  calculatedAt: '2026-08-14T12:00:00.000Z',
  runId: 'irmaa_test',
  scenarioId: 'irmaa_test',
};

test('IRMAA MAGI requires calculated AGI and accepts blank optional components as zero', () => {
  assert.deepEqual(composeIrmaaMagi({ adjustedGrossIncome: 218000 }), {
    magi: 218000,
    components: {
      adjustedGrossIncome: 218000,
      taxExemptInterest: 0,
      uncommonAddbacks: 0,
    },
  });
  assert.deepEqual(composeIrmaaMagi({
    adjustedGrossIncome: 218000,
    taxExemptInterest: '',
    uncommonAddbacks: null,
  }).components, {
    adjustedGrossIncome: 218000,
    taxExemptInterest: 0,
    uncommonAddbacks: 0,
  });
  assert.throws(
    () => composeIrmaaMagi({ taxExemptInterest: 1000 }),
    /adjustedGrossIncome/,
  );
});

test('MFJ thresholds resolve the current and next tier with room remaining', () => {
  const { result } = irmaa.calculate({
    magi: 218001,
    filingStatus: 'marriedFilingJointly',
    premiumYear: 2028,
  }, context);
  assert.equal(result.tier, 1);
  assert.equal(result.nextTier, 2);
  assert.equal(result.roomToNext, 55999);
  assert.equal(result.premiumYear, 2028);
  assert.equal(result.tableYear, 2026);
  assert.equal(result.annualAdjustmentPerPerson, 1148.40);
});

test('published inclusive and exclusive boundaries select the correct tier', () => {
  assert.equal(irmaa.calculate({
    magi: 109000,
    filingStatus: 'single',
    premiumYear: 2026,
  }, context).result.tier, 0);
  assert.equal(irmaa.calculate({
    magi: 109000.01,
    filingStatus: 'single',
    premiumYear: 2026,
  }, context).result.tier, 1);
  assert.equal(irmaa.calculate({
    magi: 500000,
    filingStatus: 'single',
    premiumYear: 2026,
  }, context).result.tier, 5);
});

test('MFS uses the special table only when the taxpayer lived with the spouse', () => {
  const together = irmaa.calculate({
    magi: 200000,
    filingStatus: 'marriedFilingSeparately',
    mfsLivingArrangement: 'lived-together-at-any-time',
    premiumYear: 2026,
  }, context).result;
  const apart = irmaa.calculate({
    magi: 200000,
    filingStatus: 'marriedFilingSeparately',
    mfsLivingArrangement: 'lived-apart-all-year',
    premiumYear: 2026,
  }, context).result;
  assert.equal(together.tier, 4);
  assert.equal(apart.tier, 3);
  assert.throws(() => irmaa.calculate({
    magi: 200000,
    filingStatus: 'marriedFilingSeparately',
    premiumYear: 2026,
  }, context), /mfsLivingArrangement/);
});

test('IRMAA audit carries the verified CMS source and internal table year', () => {
  const source = getDataSource('CMS_2026_MEDICARE_IRMAA_v1.0');
  const { audit } = irmaa.calculate({
    magi: 600000,
    filingStatus: 'single',
    premiumYear: 2032,
  }, context);
  assert.equal(source.status, 'verified');
  assert.equal(source.premiumYear, 2026);
  assert.deepEqual(audit.dataSourcesUsed, [source.id]);
  assert.equal(audit.tableYear, 2026);
  assert.equal(audit.premiumYear, 2032);
  assert.equal(audit.calculatedAt, context.calculatedAt);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIrmaaPlanningResult,
  resolveIrmaaPremiumYear,
} from './buildIrmaaPlanningResult.js';

const context = Object.freeze({
  calculatedAt: '2026-08-14T12:00:00.000Z',
  runId: 'irmaa_planning_test',
  scenarioId: 'irmaa_planning_test',
});

test('modeled IRMAA requires AGI and accepts blank tax-exempt interest as zero', () => {
  assert.equal(buildIrmaaPlanningResult({
    filingStatus: 'single',
    taxYear: 2026,
    adjustedGrossIncome: null,
  }), null);
  const result = buildIrmaaPlanningResult({
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    adjustedGrossIncome: 218001,
    taxExemptInterest: '',
    context,
  });
  assert.equal(result.magi, 218001);
  assert.equal(result.tier, 1);
  assert.equal(result.nextTier, 2);
  assert.equal(result.roomToNext, 55999);
  assert.equal(result.premiumYear, 2028);
});

test('annual household adjustment multiplies full-year Parts B and D by eligible members', () => {
  const result = buildIrmaaPlanningResult({
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    adjustedGrossIncome: 218001,
    eligibleMembers: 2,
    context,
  });
  assert.equal(result.tier, 1);
  assert.equal(result.annualAdjustmentPerPerson, 1148.40);
  assert.equal(result.annualHouseholdAdjustment, 2296.80);
});

test('the first two premium years use manual lookback MAGI and do not fall back', () => {
  const plan = {
    meta: { planningAsOfYear: 2026, filingStatus: 'single' },
    incomeTax: {
      irmaa: {
        schemaVersion: 1,
        lookbackByTaxYear: {
          2024: { magi: 120000, filingStatus: 'single' },
        },
      },
    },
  };
  const modeledByTaxYear = {
    2024: { adjustedGrossIncome: 50000, filingStatus: 'single' },
    2025: { adjustedGrossIncome: 50000, filingStatus: 'single' },
  };
  const first = resolveIrmaaPremiumYear({
    plan,
    premiumYear: 2026,
    modeledByTaxYear,
    context,
  });
  assert.equal(first.source, 'manual-lookback');
  assert.equal(first.magi, 120000);
  assert.equal(first.taxYear, 2024);
  assert.equal(resolveIrmaaPremiumYear({
    plan,
    premiumYear: 2027,
    modeledByTaxYear,
    context,
  }), null);
});

test('premium years after the lookback window use calculated modeled AGI', () => {
  const result = resolveIrmaaPremiumYear({
    plan: {
      meta: { planningAsOfYear: 2026, filingStatus: 'single' },
      incomeTax: { irmaa: { lookbackByTaxYear: {} } },
    },
    premiumYear: 2028,
    modeledByTaxYear: {
      2026: {
        adjustedGrossIncome: 108000,
        taxExemptInterest: 2000,
      },
    },
    context,
  });
  assert.equal(result.source, 'modeled');
  assert.equal(result.magi, 110000);
  assert.equal(result.tier, 1);
  assert.equal(result.premiumYear, 2028);
});

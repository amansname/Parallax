import { test } from 'node:test';
import assert from 'node:assert';
import {
  OVERALL_ITEMIZED_DEPENDENCIES_MISSING,
  overallItemizedDeductionLimit,
  meta,
} from './overallItemizedDeductionLimit.js';

const ctx = (taxYear = 2026, overrides = {}) => ({
  calculatedAt: '2026-07-28T12:00:00.000Z',
  runId: 'overall_itemized_test',
  scenarioId: 'overall_itemized_scenario',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
  ...overrides,
});

function calculate(overrides = {}, taxYear = 2026){
  return overallItemizedDeductionLimit.calculate({
    filingStatus: 'single',
    itemizedDeductionsBeforeOverallLimit: 100000,
    adjustedGrossIncome: 640600,
    qualifiedBusinessIncomeDeduction: 0,
    schedule1ADeduction: 0,
    ...overrides,
  }, ctx(taxYear));
}

test('2025 reports no overall limit and preserves the pre-limit deduction', () => {
  const { result, audit } = calculate({
    itemizedDeductionsBeforeOverallLimit: 123456.78,
    adjustedGrossIncome: 1000000,
  }, 2025);

  assert.deepStrictEqual(result, {
    allowedItemizedDeductions: 123456.78,
    overallLimitationReduction: 0,
    preItemizedTaxableIncome: null,
    exactReductionFraction: null,
    limitationApplied: false,
  });
  assert.deepStrictEqual(
    audit.dataSourcesUsed,
    ['IRS_2025_SCHEDULE_A_ITEMIZED_v1.0']
  );
});

test('2026 uses the exact 2/37 fraction at filing-status thresholds', () => {
  const thresholdCalculation = calculate();
  const threshold = thresholdCalculation.result;
  assert.strictEqual(threshold.overallLimitationReduction, 0);
  assert.strictEqual(threshold.excessOverThreshold, 0);
  assert.deepStrictEqual(threshold.exactReductionFraction, {
    numerator: 2,
    denominator: 37,
  });
  assert.strictEqual(threshold.exactReductionRate, 2 / 37);
  assert.deepStrictEqual(thresholdCalculation.audit.dataSourcesUsed, [
    'IRC_68_2026_ITEMIZED_LIMIT_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70111_2026_v1.0',
  ]);
  assert.ok(meta.dataSourcesRequired.includes(
    'PUBLIC_LAW_119_21_SECTION_70111_2026_v1.0'
  ));

  const thirtySeven = calculate({
    itemizedDeductionsBeforeOverallLimit: 37,
    adjustedGrossIncome: 640637,
  }).result;
  assert.strictEqual(thirtySeven.overallLimitationReduction, 2);
  assert.strictEqual(thirtySeven.allowedItemizedDeductions, 35);

  const large = calculate({
    itemizedDeductionsBeforeOverallLimit: 370000,
    adjustedGrossIncome: 1010600,
  }).result;
  assert.strictEqual(large.overallLimitationReduction, 20000);
  assert.strictEqual(large.allowedItemizedDeductions, 350000);
  assert.notStrictEqual(large.overallLimitationReduction, 370000 * 0.054);

  const mfs = calculate({
    filingStatus: 'marriedFilingSeparately',
    itemizedDeductionsBeforeOverallLimit: 37,
    adjustedGrossIncome: 384387,
  }).result;
  assert.strictEqual(mfs.threshold, 384350);
  assert.strictEqual(mfs.overallLimitationReduction, 2);

  for(const [filingStatus, filingThreshold] of [
    ['marriedFilingJointly', 768700],
    ['headOfHousehold', 640600],
  ]){
    const atThreshold = calculate({
      filingStatus,
      itemizedDeductionsBeforeOverallLimit: 37,
      adjustedGrossIncome: filingThreshold,
    }).result;
    assert.strictEqual(atThreshold.threshold, filingThreshold, filingStatus);
    assert.strictEqual(atThreshold.overallLimitationReduction, 0);
    assert.strictEqual(atThreshold.allowedItemizedDeductions, 37);

    const aboveThreshold = calculate({
      filingStatus,
      itemizedDeductionsBeforeOverallLimit: 37,
      adjustedGrossIncome: filingThreshold + 37,
    }).result;
    assert.strictEqual(aboveThreshold.overallLimitationReduction, 2);
    assert.strictEqual(aboveThreshold.allowedItemizedDeductions, 35);
  }
});

test('zero pre-limit itemized deductions never require missing QBI or Schedule 1-A facts', () => {
  const { result, audit } = overallItemizedDeductionLimit.calculate({
    filingStatus: 'marriedFilingJointly',
    itemizedDeductionsBeforeOverallLimit: 0,
    adjustedGrossIncome: 2000000,
  }, ctx());

  assert.strictEqual(result.allowedItemizedDeductions, 0);
  assert.strictEqual(result.overallLimitationReduction, 0);
  assert.strictEqual(result.preItemizedTaxableIncome, null);
  assert.strictEqual(result.excessOverThreshold, null);
  assert.deepStrictEqual(result.exactReductionFraction, {
    numerator: 2,
    denominator: 37,
  });
  assert.deepStrictEqual(audit.calculationSteps[0].missing, [
    'qualifiedBusinessIncomeDeduction',
    'schedule1ADeduction',
  ]);
});

test('positive itemized deductions still fail closed when missing facts can change 2026 result', () => {
  assert.throws(
    () => overallItemizedDeductionLimit.calculate({
      filingStatus: 'single',
      itemizedDeductionsBeforeOverallLimit: 1,
      adjustedGrossIncome: 700000,
    }, ctx()),
    error => error.name === 'TaxInputError'
      && error.details.code === OVERALL_ITEMIZED_DEPENDENCIES_MISSING
      && error.details.missing.includes('qualifiedBusinessIncomeDeduction')
      && error.details.missing.includes('schedule1ADeduction')
  );

  const safelyBelowThreshold = overallItemizedDeductionLimit.calculate({
    filingStatus: 'single',
    itemizedDeductionsBeforeOverallLimit: 1,
    adjustedGrossIncome: 640600,
  }, ctx()).result;
  assert.strictEqual(safelyBelowThreshold.preItemizedTaxableIncome, null);
  assert.strictEqual(safelyBelowThreshold.excessOverThreshold, 0);
  assert.strictEqual(safelyBelowThreshold.overallLimitationReduction, 0);
  assert.strictEqual(safelyBelowThreshold.allowedItemizedDeductions, 1);
});

test('QSS is explicitly deferred and is not added as a supported filing status', () => {
  assert.ok(meta.limitations.some(
    limitation => limitation.includes('QSS') && limitation.includes('deferred')
  ));
  assert.throws(() => overallItemizedDeductionLimit.calculate({
    filingStatus: 'qualifyingSurvivingSpouse',
    itemizedDeductionsBeforeOverallLimit: 1000,
    adjustedGrossIncome: 100000,
  }, ctx()), /must be one of/);
});

test('overall itemized rule rejects malformed inputs and year-law mismatches', () => {
  assert.throws(() => calculate({
    itemizedDeductionsBeforeOverallLimit: -1,
  }), /must be >= 0/);
  assert.throws(() => calculate({
    adjustedGrossIncome: Number.POSITIVE_INFINITY,
  }), /must be finite/);
  assert.throws(() => overallItemizedDeductionLimit.calculate({
    filingStatus: 'single',
    itemizedDeductionsBeforeOverallLimit: 1000,
    adjustedGrossIncome: 100000,
  }, ctx(2025, { lawVersion: '2026_FINAL' })), /context does not match/);
});

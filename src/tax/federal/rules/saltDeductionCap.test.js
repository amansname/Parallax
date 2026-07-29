import { test } from 'node:test';
import assert from 'node:assert';
import {
  saltDeductionCap,
  meta,
} from './saltDeductionCap.js';

const ctx = (taxYear = 2026, overrides = {}) => ({
  calculatedAt: '2026-07-28T12:00:00.000Z',
  runId: 'salt_test',
  scenarioId: 'salt_scenario',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
  ...overrides,
});

function calculate({
  taxYear = 2026,
  filingStatus = 'single',
  eligibleTaxesPaid = 100000,
  modifiedAdjustedGrossIncome = 0,
} = {}){
  return saltDeductionCap.calculate({
    filingStatus,
    eligibleTaxesPaid,
    modifiedAdjustedGrossIncome,
  }, ctx(taxYear));
}

test('SALT caps and authoritative sources route by tax year', () => {
  const cases = [
    [
      2025,
      40000,
      [
        'IRS_2025_SCHEDULE_A_SALT_v1.0',
        'PUBLIC_LAW_119_21_SECTION_70120_2025_v1.0',
      ],
    ],
    [
      2026,
      40400,
      [
        'IRS_2026_PUBLICATION_505_SALT_v1.0',
        'PUBLIC_LAW_119_21_SECTION_70120_2026_v1.0',
      ],
    ],
  ];

  for(const [taxYear, expectedCap, expectedSources] of cases){
    const { result, audit } = calculate({ taxYear });
    assert.strictEqual(result.filingStatusLimit, expectedCap);
    assert.strictEqual(result.saltDeduction, expectedCap);
    assert.deepStrictEqual(audit.dataSourcesUsed, expectedSources);
  }

  assert.deepStrictEqual(meta.supportedTaxYears, [2025, 2026]);
});

test('SALT phaseout and floor apply to non-MFS returns', () => {
  const phased2025 = calculate({
    taxYear: 2025,
    modifiedAdjustedGrossIncome: 550000,
  }).result;
  assert.strictEqual(phased2025.phaseoutReduction, 15000);
  assert.strictEqual(phased2025.filingStatusLimit, 25000);

  const floor2025 = calculate({
    taxYear: 2025,
    modifiedAdjustedGrossIncome: 700000,
  }).result;
  assert.strictEqual(floor2025.filingStatusLimit, 10000);

  const phased2026 = calculate({
    taxYear: 2026,
    modifiedAdjustedGrossIncome: 555000,
  }).result;
  assert.strictEqual(phased2026.phaseoutReduction, 15000);
  assert.strictEqual(phased2026.filingStatusLimit, 25400);

  const floor2026 = calculate({
    taxYear: 2026,
    modifiedAdjustedGrossIncome: 705000,
  }).result;
  assert.strictEqual(floor2026.filingStatusLimit, 10000);
});

test('MFS computes the full worksheet cap and floor before halving', () => {
  const cases = [
    [2025, 250000, 20000],
    [2025, 300000, 12500],
    [2025, 350000, 5000],
    [2026, 252500, 20200],
    [2026, 302500, 12700],
    [2026, 400000, 5000],
  ];

  for(const [taxYear, magi, expectedLimit] of cases){
    const { result } = calculate({
      taxYear,
      filingStatus: 'marriedFilingSeparately',
      modifiedAdjustedGrossIncome: magi,
    });
    assert.strictEqual(
      result.filingStatusLimit,
      expectedLimit,
      `${taxYear} MFS MAGI ${magi}`
    );
  }
});

test('SALT deduction cannot exceed eligible taxes paid', () => {
  const { result } = calculate({
    eligibleTaxesPaid: 1234.56,
    modifiedAdjustedGrossIncome: 0,
  });
  assert.strictEqual(result.saltDeduction, 1234.56);
});

test('SALT rule rejects malformed inputs and year-law mismatches', () => {
  assert.throws(() => saltDeductionCap.calculate({
    filingStatus: 'qualifyingSurvivingSpouse',
    eligibleTaxesPaid: 1000,
    modifiedAdjustedGrossIncome: 0,
  }, ctx()), /must be one of/);
  assert.throws(() => saltDeductionCap.calculate({
    filingStatus: 'single',
    eligibleTaxesPaid: -1,
    modifiedAdjustedGrossIncome: 0,
  }, ctx()), /must be >= 0/);
  assert.throws(() => saltDeductionCap.calculate({
    filingStatus: 'single',
    eligibleTaxesPaid: 1000,
    modifiedAdjustedGrossIncome: Number.NaN,
  }, ctx()), /must be finite/);
  assert.throws(() => saltDeductionCap.calculate({
    filingStatus: 'single',
    eligibleTaxesPaid: 1000,
    modifiedAdjustedGrossIncome: 0,
  }, ctx(2025, { lawVersion: '2026_FINAL' })), /context does not match/);
});

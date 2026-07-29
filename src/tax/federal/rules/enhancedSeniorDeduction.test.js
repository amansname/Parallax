import { test } from 'node:test';
import assert from 'node:assert';
import {
  enhancedSeniorDeduction,
  meta,
} from './enhancedSeniorDeduction.js';

const ctx = (taxYear = 2026) => ({
  calculatedAt: '2026-07-28T12:00:00.000Z',
  runId: 'enhanced_senior_test',
  scenarioId: 'enhanced_senior_scenario',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
});

test('meta names annual IRS and direct statutory sources', () => {
  assert.strictEqual(meta.ruleId, 'FED_ENHANCED_SENIOR_DEDUCTION');
  assert.ok(meta.dataSourcesRequired.includes(
    'IRS_2025_SCHEDULE_1A_SENIOR_v1.0'
  ));
  assert.ok(meta.dataSourcesRequired.includes(
    'PUBLIC_LAW_119_21_SECTION_70103_2025_v1.0'
  ));
  assert.ok(meta.dataSourcesRequired.includes(
    'IRS_2026_PUBLICATION_505_SENIOR_v1.0'
  ));
  assert.ok(meta.dataSourcesRequired.includes(
    'PUBLIC_LAW_119_21_SECTION_70103_2026_v1.0'
  ));
});

test('enhanced senior deduction routes the $6,000 amount for 2025 and 2026', () => {
  const cases = [
    [
      2025,
      '1961-01-01',
      [
        'IRS_2025_SCHEDULE_1A_SENIOR_v1.0',
        'PUBLIC_LAW_119_21_SECTION_70103_2025_v1.0',
      ],
    ],
    [
      2026,
      '1962-01-01',
      [
        'IRS_2026_PUBLICATION_505_SENIOR_v1.0',
        'PUBLIC_LAW_119_21_SECTION_70103_2026_v1.0',
      ],
    ],
  ];

  for(const [taxYear, birthDate, dataSources] of cases){
    const { result, audit } = enhancedSeniorDeduction.calculate({
      filingStatus: 'single',
      modifiedAdjustedGrossIncome: 75000,
      taxpayers: {
        client: {
          birthDate,
          validSsnForEnhancedSeniorDeduction: true,
        },
      },
    }, ctx(taxYear));
    assert.strictEqual(result.enhancedSeniorDeduction, 6000);
    assert.strictEqual(result.eligiblePersonCount, 1);
    assert.deepStrictEqual(audit.dataSourcesUsed, dataSources);
  }
});

test('younger MFJ spouse does not require an enhanced-senior SSN confirmation', () => {
  const { result, audit } = enhancedSeniorDeduction.calculate({
    filingStatus: 'marriedFilingJointly',
    modifiedAdjustedGrossIncome: 150000,
    taxpayers: {
      client: {
        birthDate: '1960-01-01',
        validSsnForEnhancedSeniorDeduction: true,
      },
      spouse: {
        birthDate: '1965-01-01',
      },
    },
  }, ctx());

  assert.strictEqual(result.eligiblePersonCount, 1);
  assert.strictEqual(result.enhancedSeniorDeduction, 6000);
  assert.strictEqual(result.eligibility[1].age65OrOlder, false);
  assert.strictEqual(result.eligibility[1].validSsn, undefined);
  assert.ok(audit.dataSourcesUsed.includes(
    'PUBLIC_LAW_119_21_SECTION_70103_2026_v1.0'
  ));
});

test('age-eligible person requires explicit SSN eligibility confirmation', () => {
  assert.throws(
    () => enhancedSeniorDeduction.calculate({
      filingStatus: 'single',
      modifiedAdjustedGrossIncome: 50000,
      taxpayers: {
        client: {
          birthDate: '1962-01-01',
        },
      },
    }, ctx()),
    /validSsnForEnhancedSeniorDeduction is required/
  );
});

test('January 1 birthday is age eligible and phaseout is per eligible person', () => {
  const { result } = enhancedSeniorDeduction.calculate({
    filingStatus: 'single',
    modifiedAdjustedGrossIncome: 100000,
    taxpayers: {
      client: {
        birthDate: '1962-01-01',
        validSsnForEnhancedSeniorDeduction: true,
      },
    },
  }, ctx());
  assert.strictEqual(result.eligiblePersonCount, 1);
  assert.strictEqual(result.perPersonPhaseout, 1500);
  assert.strictEqual(result.enhancedSeniorDeduction, 4500);
});

test('January 2 birthday is not age eligible by the preceding year end', () => {
  const { result } = enhancedSeniorDeduction.calculate({
    filingStatus: 'single',
    modifiedAdjustedGrossIncome: 75000,
    taxpayers: {
      client: {
        birthDate: '1962-01-02',
      },
    },
  }, ctx());
  assert.strictEqual(result.eligiblePersonCount, 0);
  assert.strictEqual(result.enhancedSeniorDeduction, 0);
});

test('MFJ phaseout is per eligible person and explicit false excludes only that person', () => {
  const input = {
    filingStatus: 'marriedFilingJointly',
    modifiedAdjustedGrossIncome: 160000,
    taxpayers: {
      client: {
        birthDate: '1955-01-01',
        validSsnForEnhancedSeniorDeduction: true,
      },
      spouse: {
        birthDate: '1956-01-01',
        validSsnForEnhancedSeniorDeduction: false,
      },
    },
  };
  const oneEligible = enhancedSeniorDeduction.calculate(input, ctx()).result;
  assert.strictEqual(oneEligible.perPersonPhaseout, 600);
  assert.strictEqual(oneEligible.deductionPerEligiblePerson, 5400);
  assert.strictEqual(oneEligible.eligiblePersonCount, 1);
  assert.strictEqual(oneEligible.enhancedSeniorDeduction, 5400);

  const bothEligible = enhancedSeniorDeduction.calculate({
    ...input,
    taxpayers: {
      ...input.taxpayers,
      spouse: {
        ...input.taxpayers.spouse,
        validSsnForEnhancedSeniorDeduction: true,
      },
    },
  }, ctx()).result;
  assert.strictEqual(bothEligible.eligiblePersonCount, 2);
  assert.strictEqual(bothEligible.enhancedSeniorDeduction, 10800);
});

test('single-filer phaseout reaches zero at $175,000 MAGI', () => {
  const { result } = enhancedSeniorDeduction.calculate({
    filingStatus: 'single',
    modifiedAdjustedGrossIncome: 175000,
    taxpayers: {
      client: {
        birthDate: '1955-01-01',
        validSsnForEnhancedSeniorDeduction: true,
      },
    },
  }, ctx());
  assert.strictEqual(result.deductionPerEligiblePerson, 0);
  assert.strictEqual(result.enhancedSeniorDeduction, 0);
});

test('MFS is ineligible', () => {
  assert.throws(
    () => enhancedSeniorDeduction.calculate({
      filingStatus: 'marriedFilingSeparately',
      modeledTaxpayer: 'client',
      modifiedAdjustedGrossIncome: 50000,
      taxpayers: {
        client: {
          birthDate: '1960-01-01',
          validSsnForEnhancedSeniorDeduction: true,
        },
      },
    }, ctx()),
    /unavailable for married filing separately/
  );
});

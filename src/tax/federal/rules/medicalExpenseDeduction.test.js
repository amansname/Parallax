import { test } from 'node:test';
import assert from 'node:assert';
import {
  medicalExpenseDeduction,
  meta,
} from './medicalExpenseDeduction.js';

const ctx = (taxYear = 2026, overrides = {}) => ({
  calculatedAt: '2026-07-28T12:00:00.000Z',
  runId: 'medical_expense_test',
  scenarioId: 'medical_expense_scenario',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
  ...overrides,
});

test('medical expense rule routes the 7.5% floor for 2025 and 2026', () => {
  const cases = [
    [2025, 'IRS_2025_SCHEDULE_A_MEDICAL_v1.0'],
    [2026, 'IRS_2026_SCHEDULE_A_MEDICAL_v1.0'],
  ];

  for(const [taxYear, sourceId] of cases){
    const { result, audit } = medicalExpenseDeduction.calculate({
      medicalExpensesPaid: 12000,
      adjustedGrossIncome: 100000,
    }, ctx(taxYear));

    assert.deepStrictEqual(result, {
      medicalExpensesPaid: 12000,
      adjustedGrossIncomeFloor: 7500,
      deductibleMedicalExpenses: 4500,
    });
    assert.deepStrictEqual(audit.dataSourcesUsed, [sourceId]);
    assert.strictEqual(audit.calculationSteps[0].rate, 0.075);
  }

  assert.deepStrictEqual(meta.supportedTaxYears, [2025, 2026]);
});

test('medical expenses at or below the AGI floor deduct zero', () => {
  for(const medicalExpensesPaid of [0, 7000, 7500]){
    const { result } = medicalExpenseDeduction.calculate({
      medicalExpensesPaid,
      adjustedGrossIncome: 100000,
    }, ctx());
    assert.strictEqual(result.deductibleMedicalExpenses, 0);
  }
});

test('negative AGI uses a zero floor without reducing paid expenses', () => {
  const { result } = medicalExpenseDeduction.calculate({
    medicalExpensesPaid: 1234.56,
    adjustedGrossIncome: -10000,
  }, ctx(2025));

  assert.strictEqual(result.adjustedGrossIncomeFloor, 0);
  assert.strictEqual(result.deductibleMedicalExpenses, 1234.56);
});

test('medical expense rule rejects malformed inputs and year-law mismatches', () => {
  assert.throws(() => medicalExpenseDeduction.calculate({
    medicalExpensesPaid: -1,
    adjustedGrossIncome: 100000,
  }, ctx()), /must be >= 0/);
  assert.throws(() => medicalExpenseDeduction.calculate({
    medicalExpensesPaid: 1000,
    adjustedGrossIncome: Number.POSITIVE_INFINITY,
  }, ctx()), /must be finite/);
  assert.throws(() => medicalExpenseDeduction.calculate({
    adjustedGrossIncome: 100000,
  }, ctx()), /medicalExpensesPaid/);
  assert.throws(() => medicalExpenseDeduction.calculate({
    medicalExpensesPaid: 1000,
    adjustedGrossIncome: 100000,
  }, ctx(2025, { lawVersion: '2026_FINAL' })), /context does not match/);
});

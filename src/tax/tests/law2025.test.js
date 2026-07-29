import { test } from 'node:test';
import assert from 'node:assert';
import { ORDINARY_BRACKETS, STANDARD_DEDUCTION, CAPITAL_GAINS_THRESHOLDS } from '../core/constants.js';
import { getDataSource } from '../core/dataSourceRegistry.js';
import { resolveLawVersionForTaxYear, supportedTaxYears } from '../core/lawRegistry.js';
import { ordinaryIncomeTax } from '../federal/rules/ordinaryIncomeTax.js';
import { buildDefaultTaxContext, runClient1040Intake } from '../annual1040.js';

test('2025 tax year resolves to 2025_FINAL law tables', () => {
  assert.strictEqual(resolveLawVersionForTaxYear(2025), '2025_FINAL');
  assert.strictEqual(resolveLawVersionForTaxYear(2026), '2026_FINAL');
  assert.deepStrictEqual(supportedTaxYears(), [2025, 2026]);
});

test('2025 ordinary brackets match IRS Revenue Procedure 2024-40', () => {
  const mfj = ORDINARY_BRACKETS['2025_FINAL'].marriedFilingJointly;
  assert.strictEqual(mfj[0].upTo, 23850);
  assert.strictEqual(mfj[6].rate, 0.37);
  assert.strictEqual(mfj[5].upTo, 751600);
});

test('2025 standard deduction and LTCG thresholds match verified annual sources', () => {
  assert.strictEqual(STANDARD_DEDUCTION['2025_FINAL'].marriedFilingJointly, 31500);
  assert.strictEqual(CAPITAL_GAINS_THRESHOLDS['2025_FINAL'].single.zeroRateMax, 48350);
  assert.strictEqual(CAPITAL_GAINS_THRESHOLDS['2025_FINAL'].marriedFilingJointly.fifteenRateMax, 600050);
});

test('2025 data sources align with taxYear and lawVersion', () => {
  for(const sourceId of [
    'IRS_2025_TAX_TABLES_v1.0',
    'IRS_2025_CAPITAL_GAINS_RATES_v1.0',
  ]){
    const source = getDataSource(sourceId);
    assert.strictEqual(source.taxYear, 2025);
    assert.strictEqual(source.lawVersion, '2025_FINAL');
    assert.strictEqual(source.status, 'verified');
    assert.strictEqual(
      source.url,
      'https://www.irs.gov/pub/irs-drop/rp-24-40.pdf'
    );
    assert.strictEqual(source.retrievedAt, '2026-07-29');
  }
});

test('2025 MFJ wages-only return uses 2025 brackets without tax-year warning', () => {
  const context = buildDefaultTaxContext({ taxYear: 2025, scenarioId: 'law2025' });
  assert.strictEqual(context.lawVersion, '2025_FINAL');

  const intake = {
    id: 'law2025-smoke',
    filingStatus: 'marriedFilingJointly',
    taxYear: 2025,
    income: { wages: 120000 },
    deductions: { useStandard: true },
  };

  const { annual1040Result } = runClient1040Intake(intake, context);
  assert.strictEqual(annual1040Result.metadata.lawVersion, '2025_FINAL');
  assert.strictEqual(annual1040Result.lines.line15.value, 88500);
  assert.ok(!annual1040Result.warnings.some((w) => w.code === 'TAX_YEAR_LAW_MISMATCH'));

  const { result } = ordinaryIncomeTax.calculate(
    { filingStatus: 'marriedFilingJointly', taxableOrdinaryIncome: 88500 },
    context
  );
  assert.strictEqual(result.ordinaryTax, annual1040Result.lines.line16.value);
});

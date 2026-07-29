import { test } from 'node:test';
import assert from 'node:assert';
import { selfEmploymentTax, meta } from './selfEmploymentTax.js';

const ctx = (over = {}) => ({
  calculatedAt: '2026-07-10T12:00:00.000Z',
  runId: 'test_run',
  scenarioId: 'test_schedule_se',
  taxYear: 2025,
  lawVersion: '2025_FINAL',
  ...over,
});

test('annual-08 Schedule SE facts calculate $1,028 of self-employment tax', () => {
  const { result, audit } = selfEmploymentTax.calculate({
    taxpayer: 'spouse',
    netEarningsFromSelfEmployment: 6717,
    socialSecurityWagesAndTips: 6717,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx());

  assert.deepStrictEqual(result, {
    remainingSocialSecurityWageBase: 169383,
    socialSecurityTaxableEarnings: 6717,
    socialSecurityTax: 833,
    medicareTax: 195,
    selfEmploymentTax: 1028,
    deductiblePartOfSelfEmploymentTax: 514,
  });
  assert.strictEqual(audit.ruleId, 'FED_SELF_EMPLOYMENT_TAX');
  assert.deepStrictEqual(audit.dataSourcesUsed, ['IRS_2025_SCHEDULE_SE_v1.0']);
  assert.strictEqual(audit.inputsUsed.taxpayer, 'spouse');
});

test('social security wages reduce the remaining wage base', () => {
  const { result } = selfEmploymentTax.calculate({
    netEarningsFromSelfEmployment: 10000,
    socialSecurityWagesAndTips: 170000,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx());

  assert.strictEqual(result.remainingSocialSecurityWageBase, 6100);
  assert.strictEqual(result.socialSecurityTaxableEarnings, 6100);
  assert.strictEqual(result.socialSecurityTax, 756);
  assert.strictEqual(result.medicareTax, 290);
  assert.strictEqual(result.selfEmploymentTax, 1046);
  assert.strictEqual(result.deductiblePartOfSelfEmploymentTax, 523);
});

test('wages at the social security ceiling leave only Medicare tax', () => {
  const { result } = selfEmploymentTax.calculate({
    netEarningsFromSelfEmployment: 10000,
    socialSecurityWagesAndTips: 176100,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx());

  assert.strictEqual(result.socialSecurityTax, 0);
  assert.strictEqual(result.medicareTax, 290);
  assert.strictEqual(result.selfEmploymentTax, 290);
  assert.strictEqual(result.deductiblePartOfSelfEmploymentTax, 145);
});

test('invalid or missing Schedule SE inputs throw', () => {
  assert.throws(() => selfEmploymentTax.calculate({
    netEarningsFromSelfEmployment: -1,
    socialSecurityWagesAndTips: 0,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx()));
  assert.throws(() => selfEmploymentTax.calculate({
    netEarningsFromSelfEmployment: 1000,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx()));
});

test('Schedule SE supports the authoritative 2026 wage base and uncapped Medicare tax', () => {
  const { result, audit } = selfEmploymentTax.calculate({
    netEarningsFromSelfEmployment: 200000,
    socialSecurityWagesAndTips: 0,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx({ taxYear: 2026, lawVersion: '2026_FINAL' }));

  assert.deepStrictEqual(result, {
    remainingSocialSecurityWageBase: 184500,
    socialSecurityTaxableEarnings: 184500,
    socialSecurityTax: 22878,
    medicareTax: 5800,
    selfEmploymentTax: 28678,
    deductiblePartOfSelfEmploymentTax: 14339,
  });
  assert.deepStrictEqual(
    audit.dataSourcesUsed,
    ['IRS_2026_PUBLICATION_505_SCHEDULE_SE_v1.0']
  );

  const aboveWageBase = selfEmploymentTax.calculate({
    netEarningsFromSelfEmployment: 1000000,
    socialSecurityWagesAndTips: 184500,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx({ taxYear: 2026, lawVersion: '2026_FINAL' })).result;
  assert.strictEqual(aboveWageBase.socialSecurityTax, 0);
  assert.strictEqual(aboveWageBase.medicareTax, 29000);
  assert.strictEqual(aboveWageBase.selfEmploymentTax, 29000);
});

test('resolved Schedule SE line 6 is not subjected to a second $400 threshold', () => {
  const { result, audit } = selfEmploymentTax.calculate({
    netEarningsFromSelfEmployment: 399,
    socialSecurityWagesAndTips: 0,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }, ctx());

  assert.strictEqual(result.socialSecurityTax, 49);
  assert.strictEqual(result.medicareTax, 12);
  assert.strictEqual(result.selfEmploymentTax, 61);
  assert.strictEqual(result.deductiblePartOfSelfEmploymentTax, 31);
  assert.strictEqual(audit.inputsUsed.netEarningsFromSelfEmployment, 399);
  assert.ok(meta.limitations.some(limitation =>
    limitation.includes('resolved Schedule SE line 6')
      && limitation.includes('$400-threshold')
  ));
});

test('Schedule SE line 8d provenance must be explicitly confirmed', () => {
  const base = {
    netEarningsFromSelfEmployment: 10000,
    socialSecurityWagesAndTips: 0,
  };
  assert.throws(
    () => selfEmploymentTax.calculate(base, ctx()),
    /socialSecurityWagesAndTipsIsScheduleSELine8d/
  );
  assert.throws(
    () => selfEmploymentTax.calculate({
      ...base,
      socialSecurityWagesAndTipsIsScheduleSELine8d: false,
    }, ctx()),
    /requires confirmation/
  );
});

test('Schedule SE does not silently cross tax-year data sources', () => {
  const input = {
    netEarningsFromSelfEmployment: 6717,
    socialSecurityWagesAndTips: 6717,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  };
  assert.throws(
    () => selfEmploymentTax.calculate(
      input,
      ctx({ taxYear: 2025, lawVersion: '2026_FINAL' })
    ),
    /context does not match/
  );
  assert.throws(
    () => selfEmploymentTax.calculate(
      input,
      ctx({ taxYear: 2027, lawVersion: '2027_FINAL' })
    ),
    /No self-employment tax data/
  );
});

test('Schedule SE metadata covers both supported tax years', () => {
  assert.deepStrictEqual(meta.supportedTaxYears, [2025, 2026]);
  assert.ok(meta.dataSourcesRequired.includes('IRS_2025_SCHEDULE_SE_v1.0'));
  assert.ok(meta.dataSourcesRequired.includes(
    'IRS_2026_PUBLICATION_505_SCHEDULE_SE_v1.0'
  ));
});

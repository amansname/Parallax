import { test } from 'node:test';
import assert from 'node:assert';
import { taxableSocialSecurity } from './taxableSocialSecurity.js';

const ctx = (taxYear = 2026) => ({
  calculatedAt: '2026-06-21T12:00:00.000Z',
  runId: 'ss_test',
  scenarioId: 'ss_scenario',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
});

test('benefits below the base amount are not taxable', () => {
  const { result } = taxableSocialSecurity.calculate({
    filingStatus: 'single',
    socialSecurityBenefits: 10000,
    otherIncome: 5000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: false,
  }, ctx());
  assert.strictEqual(result.taxableBenefits, 0);
});

test('single filer in the 50% band taxes half of excess over base amount', () => {
  const { result } = taxableSocialSecurity.calculate({
    filingStatus: 'single',
    socialSecurityBenefits: 20000,
    otherIncome: 20000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: false,
  }, ctx());
  assert.strictEqual(result.taxableBenefits, 2500);
});

test('single filer in the 85% zone is capped at 85% of benefits', () => {
  const { result } = taxableSocialSecurity.calculate({
    filingStatus: 'single',
    socialSecurityBenefits: 30000,
    otherIncome: 50000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: false,
  }, ctx());
  assert.strictEqual(result.taxableBenefits, 25500);
});

test('MFJ worksheet example combines other income and tax-exempt interest', () => {
  const { result } = taxableSocialSecurity.calculate({
    filingStatus: 'marriedFilingJointly',
    socialSecurityBenefits: 10000,
    otherIncome: 38000,
    taxExemptInterest: 2500,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: true,
  }, ctx());
  assert.strictEqual(result.taxableBenefits, 6275);
});

test('MFS lived with spouse uses the special 85% worksheet treatment', () => {
  const { result } = taxableSocialSecurity.calculate({
    filingStatus: 'marriedFilingSeparately',
    socialSecurityBenefits: 10000,
    otherIncome: 10000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: true,
  }, ctx());
  assert.strictEqual(result.taxableBenefits, 8500);
});

test('adjustments can eliminate worksheet income', () => {
  const { result } = taxableSocialSecurity.calculate({
    filingStatus: 'single',
    socialSecurityBenefits: 10000,
    otherIncome: 30000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 30000,
    livedWithSpouse: false,
  }, ctx());
  assert.strictEqual(result.taxableBenefits, 0);
});

test('signed worksheet other income accepts losses', () => {
  const { result } = taxableSocialSecurity.calculate({
    filingStatus: 'single',
    socialSecurityBenefits: 30000,
    otherIncome: -5000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: false,
  }, ctx());
  assert.strictEqual(result.combinedIncomeBeforeAdjustments, 10000);
  assert.strictEqual(result.taxableBenefits, 0);
});

test('audit is serializable and carries the data source', () => {
  const { audit } = taxableSocialSecurity.calculate({
    filingStatus: 'single',
    socialSecurityBenefits: 10000,
    otherIncome: 0,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: false,
  }, ctx());
  assert.doesNotThrow(() => JSON.stringify(audit));
  assert.ok(audit.dataSourcesUsed.includes(
    'IRS_2026_PUBLICATION_505_SOCIAL_SECURITY_v1.0'
  ));
});

test('2025 calculation uses the Publication 915 source', () => {
  const { result, audit } = taxableSocialSecurity.calculate({
    filingStatus: 'single',
    socialSecurityBenefits: 20000,
    otherIncome: 20000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: false,
  }, ctx(2025));
  assert.strictEqual(result.taxableBenefits, 2500);
  assert.strictEqual(audit.taxYear, 2025);
  assert.strictEqual(audit.lawVersion, '2025_FINAL');
  assert.deepStrictEqual(
    audit.dataSourcesUsed,
    ['IRS_2025_PUBLICATION_915_SOCIAL_SECURITY_v1.0']
  );
});

test('bad Social Security inputs throw', () => {
  assert.throws(() => taxableSocialSecurity.calculate({
    filingStatus: 'martian',
    socialSecurityBenefits: 1000,
    otherIncome: 0,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
    livedWithSpouse: false,
  }, ctx()));
});

import { test } from 'node:test';
import assert from 'node:assert';
import { capitalGainsStacking, meta } from './capitalGainsStacking.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';

const ctx = (overrides = {}) => ({
  calculatedAt: '2026-06-21T12:00:00.000Z',
  runId: 'cg_test',
  scenarioId: 'cg_scenario',
  taxYear: 2026,
  lawVersion: '2026_FINAL',
  ...overrides,
});

test('preferential income inside the 0% band produces no capital gains tax', () => {
  const { result } = capitalGainsStacking.calculate({
    filingStatus: 'single',
    ordinaryTaxableIncome: 48000,
    netLongTermCapitalGains: 1000,
    qualifiedDividends: 0,
  }, ctx());
  assert.strictEqual(result.preferentialIncomeTax, 0);
});

test('single filer straddles the 0% and 15% capital gains bands', () => {
  const { result } = capitalGainsStacking.calculate({
    filingStatus: 'single',
    ordinaryTaxableIncome: 49000,
    netLongTermCapitalGains: 1000,
    qualifiedDividends: 0,
  }, ctx());
  assert.strictEqual(result.preferentialIncomeTax, 82.50);
});

test('single filer straddles the 15% and 20% capital gains bands', () => {
  const { result } = capitalGainsStacking.calculate({
    filingStatus: 'single',
    ordinaryTaxableIncome: 540000,
    netLongTermCapitalGains: 20000,
    qualifiedDividends: 0,
  }, ctx());
  assert.strictEqual(result.preferentialIncomeTax, 3725);
});

test('ordinary income above the 20% threshold puts all preferred income at 20%', () => {
  const { result } = capitalGainsStacking.calculate({
    filingStatus: 'single',
    ordinaryTaxableIncome: 600000,
    netLongTermCapitalGains: 5000,
    qualifiedDividends: 0,
  }, ctx());
  assert.strictEqual(result.preferentialIncomeTax, 1000);
  assert.strictEqual(result.marginalPreferentialRate, 0.20);
});

test('audit is serializable and carries the data source', () => {
  const { audit } = capitalGainsStacking.calculate({
    filingStatus: 'single',
    ordinaryTaxableIncome: 49000,
    netLongTermCapitalGains: 1000,
    qualifiedDividends: 0,
  }, ctx());
  assert.doesNotThrow(() => JSON.stringify(audit));
  assert.ok(audit.dataSourcesUsed.includes('IRS_2026_CAPITAL_GAINS_RATES_v1.0'));
  assert.strictEqual(meta.ruleId, 'FED_CAPITAL_GAINS_STACKING');
});

test('metadata and audits route verified primary authority for 2025 and 2026', () => {
  assert.strictEqual(meta.ruleVersion, '1.0.1');
  assert.deepStrictEqual(meta.supportedTaxYears, [2025, 2026]);
  assert.deepStrictEqual(
    meta.supportedLawVersions,
    ['2025_FINAL', '2026_FINAL']
  );
  assert.deepStrictEqual(meta.dataSourcesRequired, [
    'IRS_2025_CAPITAL_GAINS_RATES_v1.0',
    'IRS_2026_CAPITAL_GAINS_RATES_v1.0',
  ]);

  for(const {
    taxYear,
    lawVersion,
    sourceId,
    url,
  } of [
    {
      taxYear: 2025,
      lawVersion: '2025_FINAL',
      sourceId: 'IRS_2025_CAPITAL_GAINS_RATES_v1.0',
      url: 'https://www.irs.gov/pub/irs-drop/rp-24-40.pdf',
    },
    {
      taxYear: 2026,
      lawVersion: '2026_FINAL',
      sourceId: 'IRS_2026_CAPITAL_GAINS_RATES_v1.0',
      url: 'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf',
    },
  ]){
    const source = getDataSource(sourceId);
    assert.strictEqual(source.status, 'verified');
    assert.strictEqual(source.url, url);
    assert.strictEqual(source.retrievedAt, '2026-07-29');
    assert.strictEqual(source.taxYear, taxYear);
    assert.strictEqual(source.lawVersion, lawVersion);

    const { audit } = capitalGainsStacking.calculate({
      filingStatus: 'single',
      ordinaryTaxableIncome: 40000,
      netLongTermCapitalGains: 1000,
      qualifiedDividends: 0,
    }, ctx({ taxYear, lawVersion }));
    assert.strictEqual(audit.taxYear, taxYear);
    assert.strictEqual(audit.lawVersion, lawVersion);
    assert.deepStrictEqual(audit.dataSourcesUsed, [sourceId]);
    assert.deepStrictEqual(audit.authority, [source.authority]);
  }
});

test('crossed 2025 and 2026 contexts fail closed', () => {
  for(const overrides of [
    { taxYear: 2025, lawVersion: '2026_FINAL' },
    { taxYear: 2026, lawVersion: '2025_FINAL' },
  ]){
    assert.throws(() => capitalGainsStacking.calculate({
      filingStatus: 'single',
      ordinaryTaxableIncome: 40000,
      netLongTermCapitalGains: 1000,
      qualifiedDividends: 0,
    }, ctx(overrides)), /context does not match/);
  }
});

test('bad capital gains inputs throw', () => {
  assert.throws(() => capitalGainsStacking.calculate({
    filingStatus: 'single',
    ordinaryTaxableIncome: -1,
    netLongTermCapitalGains: 0,
    qualifiedDividends: 0,
  }, ctx()));
});

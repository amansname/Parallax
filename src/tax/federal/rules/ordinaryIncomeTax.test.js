/* Unit tests for the federal ordinary income tax rule.
   Run with: node --test  (Node 18+)

   Expected tax figures are computed BY HAND from the 2026 bracket tables in
   core/constants.js, so these tests lock the bracket-STACKING math independent
   of whether the table values themselves are finalized (those are flagged for
   source verification separately). */

import { test } from 'node:test';
import assert from 'node:assert';
import { ordinaryIncomeTax, meta } from './ordinaryIncomeTax.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';

// A fixed, caller-supplied context. calculatedAt is injected (never generated
// inside the rule), so results are deterministic and replayable.
const ctx = (over = {}) => ({
  calculatedAt: '2026-06-14T12:00:00.000Z',
  runId: 'test_run',
  scenarioId: 'test_scenario',
  taxYear: 2026,
  lawVersion: '2026_FINAL',
  ...over,
});

// ── $0 income: no tax, no breakdown, marginal = first-dollar rate ───────────
test('$0 income across all filing statuses → zero tax, 10% marginal, empty breakdown', () => {
  for(const filingStatus of ['single', 'marriedFilingJointly', 'headOfHousehold', 'marriedFilingSeparately']){
    const { result } = ordinaryIncomeTax.calculate({ filingStatus, taxableOrdinaryIncome: 0 }, ctx());
    assert.strictEqual(result.ordinaryTax, 0);
    assert.strictEqual(result.effectiveRate, 0);
    assert.strictEqual(result.marginalRate, 0.10);
    assert.deepStrictEqual(result.bracketBreakdown, []);
  }
});

// ── Bracket-edge cases (single: 10% upTo 12400, 12% upTo 50400) ─────────────
test('single income $1 below first threshold stays in the 10% bracket', () => {
  const { result } = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 12399 }, ctx());
  assert.strictEqual(result.ordinaryTax, 1239.90);
  assert.strictEqual(result.marginalRate, 0.10);
  assert.strictEqual(result.bracketBreakdown.length, 1);
});

test('single income exactly at the first threshold is fully in the 10% bracket', () => {
  const { result } = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 12400 }, ctx());
  assert.strictEqual(result.ordinaryTax, 1240);
  assert.strictEqual(result.marginalRate, 0.10);
  assert.strictEqual(result.bracketBreakdown.length, 1);
});

test('single income $1 above the first threshold spills into the 12% bracket', () => {
  const { result } = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 12401 }, ctx());
  assert.strictEqual(result.ordinaryTax, 1240.12);   // 12400*.10 + 1*.12
  assert.strictEqual(result.marginalRate, 0.12);
  assert.strictEqual(result.bracketBreakdown.length, 2);
});

// ── Mid-bracket stacking ────────────────────────────────────────────────────
test('single $100,000 stacks 10/12/22 correctly', () => {
  const { result } = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 100000 }, ctx());
  // 12400*.10 + 38000*.12 + 49600*.22 = 1240 + 4560 + 10912 = 16712
  assert.strictEqual(result.ordinaryTax, 16712);
  assert.strictEqual(result.marginalRate, 0.22);
  assert.strictEqual(result.effectiveRate, 0.16712);
});

test('MFJ $180,000 stacks 10/12/22 correctly', () => {
  const { result } = ordinaryIncomeTax.calculate({ filingStatus: 'marriedFilingJointly', taxableOrdinaryIncome: 180000 }, ctx());
  // 24800*.10 + 76000*.12 + 79200*.22 = 2480 + 9120 + 17424 = 29024
  assert.strictEqual(result.ordinaryTax, 29024);
  assert.strictEqual(result.marginalRate, 0.22);
  assert.strictEqual(result.effectiveRate, 0.161244);
});

test('headOfHousehold $50,000 stacks 10/12 correctly', () => {
  const { result } = ordinaryIncomeTax.calculate({ filingStatus: 'headOfHousehold', taxableOrdinaryIncome: 50000 }, ctx());
  // 17700*.10 + 32300*.12 = 1770 + 3876 = 5646
  assert.strictEqual(result.ordinaryTax, 5646);
  assert.strictEqual(result.marginalRate, 0.12);
});

// ── High income spanning every bracket (single, top 37%) ────────────────────
test('single $700,000 reaches the top bracket', () => {
  const { result } = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 700000 }, ctx());
  // 1240 + 4560 + 12166 + 23058 + 17424 + 134531.25 + 21978 = 214957.25
  assert.strictEqual(result.ordinaryTax, 214957.25);
  assert.strictEqual(result.marginalRate, 0.37);
  assert.strictEqual(result.effectiveRate, 0.307082);
  assert.strictEqual(result.bracketBreakdown.length, 7);
});

// ── Audit trail ─────────────────────────────────────────────────────────────
test('audit is JSON-serializable and round-trips', () => {
  const { audit } = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 100000 }, ctx());
  const json = JSON.stringify(audit);
  assert.ok(typeof json === 'string' && json.length > 0);
  const back = JSON.parse(json);
  assert.deepStrictEqual(back, audit);   // no functions/Dates/circular refs lost
});

test('audit carries provenance from context and data source', () => {
  const { audit } = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 100000 }, ctx());
  assert.strictEqual(audit.ruleId, 'FED_ORDINARY_INCOME_TAX');
  assert.strictEqual(audit.ruleVersion, meta.ruleVersion);
  assert.strictEqual(audit.calculatedAt, '2026-06-14T12:00:00.000Z');  // injected, not generated
  assert.strictEqual(audit.runId, 'test_run');
  assert.strictEqual(audit.scenarioId, 'test_scenario');
  assert.deepStrictEqual(audit.dataSourcesUsed, ['IRS_2026_TAX_TABLES_v1.0']);
  assert.ok(Array.isArray(audit.calculationSteps) && audit.calculationSteps.length === 3);
});

test('metadata and audits route verified primary authority for 2025 and 2026', () => {
  assert.strictEqual(meta.ruleVersion, '1.0.1');
  assert.deepStrictEqual(meta.supportedTaxYears, [2025, 2026]);
  assert.deepStrictEqual(
    meta.supportedLawVersions,
    ['2025_FINAL', '2026_FINAL']
  );
  assert.deepStrictEqual(meta.dataSourcesRequired, [
    'IRS_2025_TAX_TABLES_v1.0',
    'IRS_2026_TAX_TABLES_v1.0',
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
      sourceId: 'IRS_2025_TAX_TABLES_v1.0',
      url: 'https://www.irs.gov/pub/irs-drop/rp-24-40.pdf',
    },
    {
      taxYear: 2026,
      lawVersion: '2026_FINAL',
      sourceId: 'IRS_2026_TAX_TABLES_v1.0',
      url: 'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf',
    },
  ]){
    const source = getDataSource(sourceId);
    assert.strictEqual(source.status, 'verified');
    assert.strictEqual(source.url, url);
    assert.strictEqual(source.retrievedAt, '2026-07-29');
    assert.strictEqual(source.taxYear, taxYear);
    assert.strictEqual(source.lawVersion, lawVersion);

    const { audit } = ordinaryIncomeTax.calculate({
      filingStatus: 'single',
      taxableOrdinaryIncome: 100000,
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
    assert.throws(() => ordinaryIncomeTax.calculate(
      { filingStatus: 'single', taxableOrdinaryIncome: 100000 },
      ctx(overrides)
    ), /taxYear does not match/);
  }
});

// ── Reproducibility & purity ────────────────────────────────────────────────
test('same inputs + same context produce identical output', () => {
  const a = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 123456 }, ctx());
  const b = ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: 123456 }, ctx());
  assert.deepStrictEqual(a, b);
});

test('calculate does not mutate its input', () => {
  const input = { filingStatus: 'single', taxableOrdinaryIncome: 100000 };
  const snapshot = { ...input };
  ordinaryIncomeTax.calculate(input, ctx());
  assert.deepStrictEqual(input, snapshot);
});

// ── Bad inputs throw (no silent defaults) ───────────────────────────────────
test('negative income throws', () => {
  assert.throws(() => ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: -1 }, ctx()));
});

test('unknown filing status throws', () => {
  assert.throws(() => ordinaryIncomeTax.calculate({ filingStatus: 'martian', taxableOrdinaryIncome: 100000 }, ctx()));
});

test('missing required input field throws', () => {
  assert.throws(() => ordinaryIncomeTax.calculate({ filingStatus: 'single' }, ctx()));
});

test('non-number income throws', () => {
  assert.throws(() => ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: '100000' }, ctx()));
});

test('NaN income throws', () => {
  assert.throws(() => ordinaryIncomeTax.calculate({ filingStatus: 'single', taxableOrdinaryIncome: NaN }, ctx()));
});

test('missing context field throws', () => {
  assert.throws(() => ordinaryIncomeTax.calculate(
    { filingStatus: 'single', taxableOrdinaryIncome: 100000 },
    { runId: 'x', scenarioId: 'y', taxYear: 2026, lawVersion: '2026_FINAL' }  // no calculatedAt
  ));
});

test('unsupported lawVersion throws a data error', () => {
  assert.throws(() => ordinaryIncomeTax.calculate(
    { filingStatus: 'single', taxableOrdinaryIncome: 100000 },
    ctx({ lawVersion: '2099_IMAGINARY' })
  ));
});

test('taxYear contradicting lawVersion throws (e.g. 2027 with 2026_FINAL)', () => {
  assert.throws(() => ordinaryIncomeTax.calculate(
    { filingStatus: 'single', taxableOrdinaryIncome: 100000 },
    ctx({ taxYear: 2027 })   // lawVersion stays 2026_FINAL → contradiction
  ), /taxYear does not match/);
});

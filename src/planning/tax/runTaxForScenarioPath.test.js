import { test } from 'node:test';
import assert from 'node:assert';
import { runTaxForScenarioPath } from './runTaxForScenarioPath.js';

test('runTaxForScenarioPath returns annual1040Result keyed by row year', () => {
  const rows = [
    {
      year: 1,
      socialSecurity: 36000,
      pension: 24000,
      accountBreakdown: { taxable: 0, traditional: 40000, roth: 0 },
      rmd: 0,
    },
    {
      year: 2,
      socialSecurity: 36000,
      pension: 24000,
      accountBreakdown: { taxable: 20000, traditional: 30000, roth: 0 },
      rmd: 10000,
    },
  ];

  const { results, byYear } = runTaxForScenarioPath(rows, {
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    wages: 12000,
    taxableGainFraction: 0.35,
    resolved: {
      taxableIra: 32000,
      taxablePensions: 18000,
      taxableSocialSecurity: 9000,
    },
    deductions: { useStandard: true },
  }, { contextOverrides: { scenarioId: 'path_test' } });

  assert.strictEqual(results.length, 2);
  assert.strictEqual(byYear[1].lines.line24.value, 4160);
  assert.strictEqual(byYear[2].lines.line24.value, 4160);
  assert.strictEqual(results[0].year, 1);
  assert.strictEqual(results[1].year, 2);
  assert.strictEqual(results[0].annual1040Result.metadata.lawVersion, '2026_FINAL');
});

test('runTaxForScenarioPath throws when rows or filingStatus are invalid', () => {
  assert.throws(
    () => runTaxForScenarioPath(null, { filingStatus: 'single' }),
    /rows must be an array/
  );
  assert.throws(
    () => runTaxForScenarioPath([{ accountBreakdown: { taxable: 0, traditional: 0, roth: 0 } }], {}),
    /filingStatus/
  );
});

test('runTaxForScenarioPath calculates zero-income years and skips failed filler rows', () => {
  const rows = [
    {
      year: 1,
      source: 2025,
      socialSecurity: 0,
      pension: 0,
      otherIncome: 0,
      accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
      rmd: 0,
      taxes: 0,
    },
    {
      year: 2,
      source: 2026,
      failed: true,
      socialSecurity: 0,
      pension: 0,
      otherIncome: 0,
      accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
      rmd: 0,
      taxes: 0,
    },
    {
      year: 3,
      source: null,
      failed: true,
      socialSecurity: 0,
      otherIncome: 0,
      accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
      taxes: 0,
    },
  ];

  const { results, byYear } = runTaxForScenarioPath(rows, {
    filingStatus: 'single',
    taxYear: 2026,
  });

  assert.deepStrictEqual(results.map((entry) => entry.year), [1, 2]);
  assert.strictEqual(results[0].annual1040Result.lines.line24.value, 0);
  assert.strictEqual(results[1].annual1040Result.lines.line24.value, 0);
  assert.strictEqual(byYear[1].lines.line24.value, 0);
  assert.strictEqual(byYear[2].lines.line24.value, 0);
  assert.strictEqual(byYear[3], undefined);
});

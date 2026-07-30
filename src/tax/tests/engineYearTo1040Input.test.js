import { test } from 'node:test';
import assert from 'node:assert';
import {
  engineYearTo1040Input,
  mapSimulationRowToYearFacts,
} from '../adapters/engineYearTo1040Input.js';
import {
  buildDefaultTaxContext,
  runClient1040Intake,
  runEngineYearTax,
} from '../annual1040.js';

test('engineYearTo1040Input maps Phase-1 shortcut taxableOrdinaryIncome', () => {
  const intake = engineYearTo1040Input({
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    taxableOrdinaryIncome: 180000,
  });
  assert.deepStrictEqual(intake, {
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    taxableOrdinaryIncome: 180000,
  });
});

test('engineYearTo1040Input maps detailed income to client1040 intake', () => {
  const intake = engineYearTo1040Input({
    id: 'engine-wages',
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    income: { wages: 120000 },
    deductions: { useStandard: true },
  });
  assert.deepStrictEqual(intake, {
    id: 'engine-wages',
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    income: { wages: 120000 },
    deductions: { useStandard: true },
  });
});

test('engineYearTo1040Input passes resolved taxable portions through', () => {
  const intake = engineYearTo1040Input({
    filingStatus: 'marriedFilingJointly',
    income: {
      iraDistributions: 40000,
      pensionAmount: 24000,
      socialSecurityBenefits: 36000,
    },
    resolved: {
      taxableIra: 32000,
      taxablePensions: 18000,
      taxableSocialSecurity: 9000,
    },
    deductions: { useStandard: true },
  });
  assert.strictEqual(intake.income.taxableIra, 32000);
  assert.strictEqual(intake.income.taxablePensions, 18000);
  assert.strictEqual(intake.income.taxableSocialSecurity, 9000);
  assert.strictEqual(intake.income.socialSecurityBenefits, 36000);
  assert.strictEqual(intake.socialSecurity, undefined);
});

test('engineYearTo1040Input builds Social Security worksheet facts from mapped taxable income', () => {
  const intake = engineYearTo1040Input({
    filingStatus: 'marriedFilingJointly',
    income: {
      wages: 12000,
      taxableInterest: 1000,
      ordinaryDividends: 2000,
      qualifiedDividends: 500,
      socialSecurityBenefits: 36000,
      pensionAmount: 24000,
      otherIncome: 5000,
      iraDistributions: 40000,
      capitalGain: 7000,
    },
    resolved: {
      taxableIra: 32000,
      taxablePensions: 18000,
    },
    adjustments: { total: 3000 },
    socialSecurityWorksheet: { adjustments: 3000 },
  });

  assert.deepStrictEqual(intake.socialSecurity, {
    socialSecurityBenefits: 36000,
    otherIncome: 77000,
    taxExemptInterest: 0,
    excludedIncomeAddBacks: 0,
    adjustments: 3000,
    livedWithSpouse: false,
  });
});

test('engine-year Social Security never substitutes the full line-10 total for worksheet adjustments', () => {
  assert.throws(
    () => engineYearTo1040Input({
      filingStatus: 'single',
      income: {
        wages: 50000,
        socialSecurityBenefits: 20000,
      },
      adjustments: { total: 3000 },
    }),
    /socialSecurityWorksheet\.adjustments/
  );

  const intake = engineYearTo1040Input({
    filingStatus: 'single',
    income: {
      wages: 50000,
      socialSecurityBenefits: 20000,
    },
    adjustments: { total: 3000 },
    socialSecurityWorksheet: { adjustments: 1000 },
  });
  assert.strictEqual(intake.socialSecurity.adjustments, 1000);
  assert.strictEqual(intake.adjustments.total, 3000);
});

test('engineYearTo1040Input requires the MFS lived-with-spouse worksheet fact', () => {
  assert.throws(
    () => engineYearTo1040Input({
      filingStatus: 'marriedFilingSeparately',
      income: { socialSecurityBenefits: 12000 },
    }),
    /livedWithSpouse/
  );

  const intake = engineYearTo1040Input({
    filingStatus: 'marriedFilingSeparately',
    income: { socialSecurityBenefits: 12000 },
    socialSecurityWorksheet: { livedWithSpouse: true },
  });
  assert.strictEqual(intake.socialSecurity.livedWithSpouse, true);
});

test('engineYearTo1040Input throws when filingStatus or income detail is missing', () => {
  assert.throws(
    () => engineYearTo1040Input({ income: { wages: 1 } }),
    /filingStatus/
  );
  assert.throws(
    () => engineYearTo1040Input({ filingStatus: 'single' }),
    /taxableOrdinaryIncome or at least one income/
  );
});

test('engineYearTo1040Input accepts an explicit zero-income year', () => {
  const facts = {
    filingStatus: 'single',
    taxYear: 2026,
    income: {},
    deductions: { useStandard: true },
  };
  const intake = engineYearTo1040Input(facts);
  const context = buildDefaultTaxContext({ taxYear: 2026, scenarioId: 'zero-income-year' });
  const { annual1040Result } = runEngineYearTax(facts, context);

  assert.deepStrictEqual(intake.income, {});
  assert.strictEqual(annual1040Result.lines.line11.value, 0);
  assert.strictEqual(annual1040Result.lines.line15.value, 0);
  assert.strictEqual(annual1040Result.lines.line24.value, 0);
});

test('mapSimulationRowToYearFacts reshapes row cash flows without importing engine.js', () => {
  const facts = mapSimulationRowToYearFacts({
    age: 68,
    socialSecurity: 36000,
    pension: 24000,
    otherIncome: 5000,
    accountBreakdown: { taxable: 20000, traditional: 30000, roth: 0 },
    rmd: 10000,
  }, {
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    wages: 12000,
    taxableGainFraction: 0.35,
  });

  assert.strictEqual(facts.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(facts.income.wages, 12000);
  assert.strictEqual(facts.income.socialSecurityBenefits, 36000);
  assert.strictEqual(facts.income.pensionAmount, 24000);
  assert.strictEqual(facts.income.otherIncome, 5000);
  assert.strictEqual(facts.income.iraDistributions, 40000);
  assert.strictEqual(facts.income.capitalGain, 7000);
  assert.strictEqual(facts.resolved.taxableIra, 40000);
  assert.strictEqual(facts.resolved.taxablePensions, 24000);
  assert.deepStrictEqual(facts.deductions, { useStandard: true });
});

test('exact row taxable capital gain takes precedence over a fraction or override', () => {
  const facts = mapSimulationRowToYearFacts({
    accountBreakdown: { taxable: 100000, traditional: 0, roth: 0 },
    taxableCapitalGain: 23456.78,
  }, {
    filingStatus: 'single',
    taxableGainFraction: 0.9,
    capitalGain: 99999,
  });
  assert.strictEqual(facts.income.capitalGain, 23456.78);
});

test('mapSimulationRowToYearFacts requires gain split when taxable withdrawals exist', () => {
  assert.throws(
    () => mapSimulationRowToYearFacts(
      { accountBreakdown: { taxable: 10000, traditional: 0, roth: 0 } },
      { filingStatus: 'single' }
    ),
    /taxableGainFraction/
  );
});

test('mapSimulationRowToYearFacts uses taxable other income on Form 1040 line 8', () => {
  const context = buildDefaultTaxContext({ taxYear: 2026, scenarioId: 'taxable-other-income' });
  const halfTaxableFacts = mapSimulationRowToYearFacts({
    socialSecurity: 12000,
    otherIncome: 40000,
    otherIncomeTaxable: 20000,
    accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
  }, {
    filingStatus: 'single',
    taxYear: 2026,
  });
  const grossFallbackFacts = mapSimulationRowToYearFacts({
    socialSecurity: 12000,
    otherIncome: 40000,
    accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
  }, {
    filingStatus: 'single',
    taxYear: 2026,
  });

  const halfTaxable = runEngineYearTax(halfTaxableFacts, context);
  const grossFallback = runEngineYearTax(grossFallbackFacts, context);
  const intake = engineYearTo1040Input(halfTaxableFacts);

  assert.strictEqual(halfTaxableFacts.income.otherIncome, 20000);
  assert.strictEqual(halfTaxable.result.form1040.line8.value, 20000);
  assert.strictEqual(grossFallback.result.form1040.line8.value, 40000);
  assert.strictEqual(intake.socialSecurity.otherIncome, 20000);
  assert.ok(
    halfTaxable.annual1040Result.lines.line24.value
      < grossFallback.annual1040Result.lines.line24.value
  );
});

test('runEngineYearTax matches direct intake for wages-only MFJ standard deduction', () => {
  const context = buildDefaultTaxContext({ taxYear: 2026, scenarioId: 'engine-adapter' });
  const facts = {
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    income: { wages: 120000 },
    deductions: { useStandard: true },
  };

  const direct = runClient1040Intake(facts, context);
  const viaAdapter = runEngineYearTax(facts, context);

  assert.strictEqual(
    viaAdapter.annual1040Result.lines.line15.value,
    direct.annual1040Result.lines.line15.value
  );
  assert.strictEqual(
    viaAdapter.annual1040Result.lines.line24.value,
    direct.annual1040Result.lines.line24.value
  );
  assert.strictEqual(viaAdapter.annual1040Result.lines.line24.value, 10040);
});

test('runEngineYearTax pipeline matches annual-04 retiree fixture via row mapping', () => {
  const context = buildDefaultTaxContext({ taxYear: 2026, scenarioId: 'engine-retiree' });
  const facts = mapSimulationRowToYearFacts({
    socialSecurity: 36000,
    pension: 24000,
    accountBreakdown: { taxable: 0, traditional: 40000, roth: 0 },
    rmd: 0,
  }, {
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
    wages: 12000,
    resolved: {
      taxableIra: 32000,
      taxablePensions: 18000,
      taxableSocialSecurity: 9000,
    },
    deductions: { useStandard: true },
  });

  const { annual1040Result } = runEngineYearTax(facts, context);
  assert.strictEqual(annual1040Result.lines.line11.value, 71000);
  assert.strictEqual(annual1040Result.lines.line15.value, 38800);
  assert.strictEqual(annual1040Result.lines.line24.value, 4160);
});

test('planner row Social Security reaches calculated Form 1040 line 6b', () => {
  const context = buildDefaultTaxContext({ taxYear: 2026, scenarioId: 'engine-ss-worksheet' });
  const facts = mapSimulationRowToYearFacts({
    socialSecurity: 36000,
    pension: 24000,
    otherIncome: 0,
    accountBreakdown: { taxable: 0, traditional: 40000, roth: 0 },
    rmd: 0,
  }, {
    filingStatus: 'marriedFilingJointly',
    taxYear: 2026,
  });

  const { result, annual1040Result } = runEngineYearTax(facts, context);
  assert.strictEqual(result.form1040.line6a.value, 36000);
  assert.strictEqual(result.form1040.line6b.value, 30600);
  assert.strictEqual(result.form1040.line6b.status, 'CALCULATED');
  assert.strictEqual(result.form1040.line6b.ruleId, 'FED_TAXABLE_SOCIAL_SECURITY');
  assert.strictEqual(annual1040Result.lines.line11.value, 94600);
});

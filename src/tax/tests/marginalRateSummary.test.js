import { test } from 'node:test';
import assert from 'node:assert';
import { buildDefaultTaxContext, runClient1040Intake } from '../annual1040.js';
import { ordinaryIncomeTax } from '../federal/rules/ordinaryIncomeTax.js';
import { resolvePreferentialComponents } from '../federal/composers/form1040Spine.js';
import { client1040IntakeToComposerInput } from '../adapters/client1040Intake.js';

const ctx = (overrides = {}) => buildDefaultTaxContext({
  calculatedAt: '2026-06-22T12:00:00.000Z',
  runId: 'marginal_rate_summary',
  scenarioId: 'marginal_rate_summary',
  taxYear: 2026,
  ...overrides,
});

function ordinaryAudit(run){
  return run.audits.find((a) => a.ruleId === 'FED_ORDINARY_INCOME_TAX');
}

function expectedOrdinaryMarginal(filingStatus, taxableOrdinaryIncome, context){
  return ordinaryIncomeTax.calculate(
    { filingStatus, taxableOrdinaryIncome },
    context
  ).result.marginalRate;
}

test('marginal rate summary: wages only uses final ordinary bracket on taxable wages', () => {
  const context = ctx();
  const run = runClient1040Intake({
    filingStatus: 'marriedFilingJointly',
    income: { wages: 120000 },
    deductions: { useStandard: true },
  }, context);

  const ordinary = ordinaryAudit(run);
  assert.strictEqual(ordinary.inputsUsed.taxableOrdinaryIncome, 87800);
  assert.strictEqual(
    run.annual1040Result.federalSummary.marginalRate,
    expectedOrdinaryMarginal('marriedFilingJointly', 87800, context)
  );
  assert.strictEqual(run.annual1040Result.federalSummary.marginalRate, 0.12);
});

test('marginal rate summary: QD/LTCG present uses carved-out ordinary taxable income', () => {
  const context = ctx();
  const intake = {
    filingStatus: 'single',
    income: {
      wages: 80000,
      ordinaryDividends: 3500,
      qualifiedDividends: 2000,
      capitalGain: 1500,
    },
    deductions: { useStandard: true },
  };
  const run = runClient1040Intake(intake, context);
  const preferential = resolvePreferentialComponents(client1040IntakeToComposerInput(intake)).total;

  const ordinary = ordinaryAudit(run);
  const carvedOrdinaryIncome = run.result.form1040.line15.value - preferential;
  assert.strictEqual(preferential, 3500);
  assert.strictEqual(ordinary.inputsUsed.taxableOrdinaryIncome, carvedOrdinaryIncome);
  assert.strictEqual(ordinary.inputsUsed.taxableOrdinaryIncome, 65400);
  assert.ok(ordinary.calculationSteps.length > 0);
  assert.strictEqual(
    run.annual1040Result.federalSummary.marginalRate,
    expectedOrdinaryMarginal('single', carvedOrdinaryIncome, context)
  );
  assert.strictEqual(
    run.annual1040Result.federalSummary.marginalRate,
    ordinary.calculationSteps[ordinary.calculationSteps.length - 1].rate
  );
  assert.strictEqual(run.annual1040Result.federalSummary.marginalRate, 0.22);
});

test('marginal rate summary: all-preferential return has no ordinary marginal rate', () => {
  const context = ctx();
  const run = runClient1040Intake({
    filingStatus: 'single',
    income: { capitalGain: 5000 },
    deductions: { useStandard: true },
  }, context);

  const ordinary = ordinaryAudit(run);
  assert.strictEqual(run.result.form1040.line15.value, 0);
  assert.strictEqual(ordinary.inputsUsed.taxableOrdinaryIncome, 0);
  assert.deepStrictEqual(ordinary.calculationSteps, []);
  assert.strictEqual(run.annual1040Result.federalSummary.marginalRate, null);
});

test('marginal rate summary: zero income has no ordinary marginal rate', () => {
  const context = ctx();
  const run = runClient1040Intake({
    filingStatus: 'single',
    income: { wages: 0 },
    deductions: { useStandard: true },
  }, context);

  const ordinary = ordinaryAudit(run);
  assert.strictEqual(run.result.form1040.line15.value, 0);
  assert.strictEqual(ordinary.inputsUsed.taxableOrdinaryIncome, 0);
  assert.deepStrictEqual(ordinary.calculationSteps, []);
  assert.strictEqual(run.annual1040Result.federalSummary.marginalRate, null);
});

test('marginal rate summary: demo-wages stacked return matches carved ordinary bracket', () => {
  const context = ctx({ taxYear: 2025, scenarioId: 'demo-wages-marginal' });
  const run = runClient1040Intake({
    filingStatus: 'marriedFilingJointly',
    taxYear: 2025,
    income: {
      wages: 348867,
      ordinaryDividends: 111,
      capitalGain: 983,
    },
    deductions: { itemizedAmount: 58763 },
  }, context);

  const ordinary = ordinaryAudit(run);
  assert.strictEqual(ordinary.inputsUsed.taxableOrdinaryIncome, 290215);
  assert.strictEqual(
    run.annual1040Result.federalSummary.marginalRate,
    expectedOrdinaryMarginal('marriedFilingJointly', 290215, context)
  );
  assert.strictEqual(run.annual1040Result.federalSummary.marginalRate, 0.24);
});

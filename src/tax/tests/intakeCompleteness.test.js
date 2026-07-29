import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDefaultTaxContext,
  runClient1040Intake,
} from '../annual1040.js';
import { buildIntakeReport } from '../adapters/intakeReport.js';
import { client1040IntakeToComposerInput } from '../adapters/client1040Intake.js';
import { validateClient1040Intake } from '../adapters/client1040IntakeValidate.js';
import { composeAnnualFederalTax } from '../federal/composers/annualFederalTax.js';

const here = dirname(fileURLToPath(import.meta.url));
const annualFixturesDir = join(here, 'fixtures', 'annual');

const ctx = (overrides = {}) => buildDefaultTaxContext({
  calculatedAt: '2026-06-22T12:00:00.000Z',
  runId: 'intake_completeness',
  scenarioId: 'intake',
  ...overrides,
});

test('committed mock return fixture loads through intake pipeline', () => {
  const raw = readFileSync(join(annualFixturesDir, 'annual-07-mfj-itemized-mock.json'), 'utf8');
  const intake = JSON.parse(raw);
  const { result, report, annual1040Result } = runClient1040Intake(intake, ctx({ taxYear: intake.taxYear ?? 2026 }));

  assert.strictEqual(intake.filingStatus, 'marriedFilingJointly');
  assert.ok(result.form1040.line15.value > 0);
  assert.ok(report.captured.some((row) => row.intakePath === 'income.wages'));
  assert.strictEqual(annual1040Result.federalSummary.federalTaxLiability, result.totalFederalTax);
  assert.strictEqual(annual1040Result.lines.line24.value, intake.expected.line24);
});

test('line 3a and line 7 both affect line 16 preferential stacking', () => {
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

  const allOrdinary = runClient1040Intake({
    filingStatus: 'single',
    income: { wages: 80000, ordinaryDividends: 3500 },
    deductions: { useStandard: true },
  }, ctx()).result.form1040.line16.value;

  const { result, audits } = runClient1040Intake(intake, ctx());
  assert.match(result.form1040.line16.ruleId, /FED_CAPITAL_GAINS_STACKING/);
  assert.ok(audits.some((a) => a.ruleId === 'FED_CAPITAL_GAINS_STACKING'));
  assert.strictEqual(result.form1040.line3a.value, 2000);
  assert.strictEqual(result.form1040.line7a.value, 1500);
  assert.notStrictEqual(result.form1040.line16.value, allOrdinary);
});

test('pass-through tax lines appear in report and roll into line 24', () => {
  const intake = {
    filingStatus: 'single',
    income: { wages: 50000 },
    deductions: { useStandard: true },
    passThrough: {
      line17: 250,
      line19: 1000,
      line20: 0,
      line23: 500,
      payments: 12000,
    },
  };

  const { result, report } = runClient1040Intake(intake, ctx());
  const incomeTaxOnly = runClient1040Intake({
    filingStatus: 'single',
    income: { wages: 50000 },
    deductions: { useStandard: true },
  }, ctx()).result.form1040.line24.value;

  assert.ok(report.passThrough.some((row) => row.lineId === 'line17' && row.value === 250));
  assert.ok(report.passThrough.some((row) => row.lineId === 'line23' && row.value === 500));
  assert.ok(report.passThrough.some((row) => row.lineId === 'payments'));
  assert.strictEqual(result.form1040.line17.ruleId, 'INTAKE_PASS_THROUGH');
  assert.strictEqual(result.form1040.line24.value, incomeTaxOnly + 250 + 500 - 1000);
  assert.strictEqual(result.taxTotalScope, 'FULL_1040');
});

test('pass-through QBI deduction appears on line 13a without disappearing', () => {
  const intake = {
    filingStatus: 'single',
    income: { wages: 100000 },
    deductions: { useStandard: true, qbi: 5000 },
  };
  const { result, report } = runClient1040Intake(intake, ctx());

  assert.strictEqual(result.form1040.line13a.value, 5000);
  assert.strictEqual(result.form1040.line13a.ruleId, 'INTAKE_PASS_THROUGH');
  assert.ok(report.passThrough.some((row) => row.lineId === 'line13a'));
  assert.strictEqual(result.form1040.line15.value, 78900);
});

test('invalid and contradictory intake inputs are flagged', () => {
  const validation = validateClient1040Intake({
    filingStatus: 'single',
    income: { ordinaryDividends: 100, qualifiedDividends: 500 },
    deductions: { useStandard: true, itemizedAmount: 10000 },
  });

  assert.ok(validation.errors.some((e) => e.code === 'QD_EXCEEDS_ORDINARY'));
  assert.ok(validation.errors.some((e) => e.code === 'DEDUCTION_CONFLICT'));

  assert.throws(() => runClient1040Intake({
    filingStatus: 'single',
    income: { ordinaryDividends: 50, qualifiedDividends: 500 },
  }, ctx()), /qualifiedDividends cannot exceed/);
});

test('passThrough line15 mismatch produces warning not silent drop', () => {
  const intake = {
    filingStatus: 'single',
    income: { wages: 50000 },
    deductions: { useStandard: true },
    passThrough: { line15: 999999 },
  };
  const validation = validateClient1040Intake(intake);
  const input = client1040IntakeToComposerInput(intake);
  const { result } = composeAnnualFederalTax(input, ctx());
  const report = buildIntakeReport(intake, result, validation, ctx());

  assert.notStrictEqual(result.form1040.line15.value, 999999);
  assert.ok(report.validation.warnings.some((w) => w.code === 'TAXABLE_INCOME_MISMATCH'));
});

test('captured gross income lines appear on form1040 detail', () => {
  const intake = {
    filingStatus: 'single',
    income: {
      wages: 40000,
      iraDistributions: 10000,
      taxableIra: 8000,
      pensionAmount: 12000,
      taxablePensions: 9000,
      socialSecurityBenefits: 20000,
    },
    deductions: { useStandard: true },
  };
  const { result } = runClient1040Intake(intake, ctx());

  assert.strictEqual(result.form1040.line4a.value, 10000);
  assert.strictEqual(result.form1040.line5a.value, 12000);
  assert.strictEqual(result.form1040.line6a.value, 20000);
});

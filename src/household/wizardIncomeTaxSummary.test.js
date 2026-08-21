import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCurrent1040Intake } from '../planning/tax/buildCurrent1040Intake.js';
import { ACCOUNT_SCHEMA_VERSION } from './accountTypes.js';
import { createBlankTaxProfiles } from './factEnvelope.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from './householdRecordSchema.js';
import { createEmptyNetWorthRecords } from './netWorthRecords.js';
import {
  buildCurrentAnnualFederalTaxBaseline,
  buildWizardIncomeTaxSummary,
} from './buildWizardIncomeTaxSummary.js';
import {
  buildWizardTaxPlan,
  ensureWizardCurrent1040,
  syncWizardTaxpayerFacts,
} from './wizardCurrent1040.js';
import { confirmWizardTaxInputs } from './wizardTaxCompletion.js';
import { createHouseholdWizard } from '../../ui/householdWizard.js';
import { getWizardAccountTypes } from './accountTypes.js';

function fact(value){
  return {
    value,
    status: value == null ? 'unknown' : 'confirmed',
    source: value == null ? null : 'household-entry',
    confirmedAt: value == null ? null : '2026-07-29T12:00:00.000Z',
    version: 1,
  };
}

function blankWizardPlan({
  filingStatus = 'single',
  clientBirthDate = '1960-06-15',
  spouseBirthDate = '1961-01-01',
} = {}){
  const taxProfiles = createBlankTaxProfiles();
  taxProfiles.client.birthDate = fact(clientBirthDate);
  taxProfiles.spouse.birthDate = fact(
    filingStatus === 'marriedFilingJointly' ? spouseBirthDate : null,
  );
  return {
    meta: {
      householdId: 'hh_summary_test',
      name: 'Summary test',
      filingStatus,
      state: 'VA',
      accountSchemaVersion: ACCOUNT_SCHEMA_VERSION,
      householdRecordSchemaVersion: HOUSEHOLD_RECORD_SCHEMA_VERSION,
    },
    household: {
      primary: { currentAge: 65, retirementAge: 65, planEndAge: 90 },
      spouse: filingStatus === 'marriedFilingJointly'
        ? { currentAge: 63, retirementAge: 65, planEndAge: 90 }
        : null,
      children: [],
    },
    taxProfiles,
    income: { other: [], socialSecurity: { primary: { pia: 0, claimAge: 67 } } },
    incomeTax: {},
    portfolio: { accounts: {}, extraAccounts: [] },
    netWorth: createEmptyNetWorthRecords(),
  };
}

test('blank Tax summary estimates on clone without mutating saved plan', () => {
  const saved = blankWizardPlan();
  ensureWizardCurrent1040(saved);
  const snapshot = structuredClone(saved.incomeTax.current1040);

  const summary = buildWizardIncomeTaxSummary(saved);

  assert.equal(summary.status, 'ready');
  assert.equal(typeof summary.federalTaxLiability, 'number');
  assert.deepEqual(saved.incomeTax.current1040, snapshot);
});

test('missing taxable IRA facts preserve other known income without inventing tax', () => {
  const saved = blankWizardPlan();
  ensureWizardCurrent1040(saved);
  saved.incomeTax.current1040.income.wages = 125000;
  saved.incomeTax.current1040.income.iraDistributions = 20000;
  const snapshot = structuredClone(saved.incomeTax.current1040);

  const summary = buildWizardIncomeTaxSummary(saved);

  assert.equal(summary.status, 'needs_facts');
  assert.match(summary.message, /taxable IRA/i);
  assert.equal(summary.totalIncome, 125000);
  assert.equal(summary.federalTaxLiability, null);
  assert.deepEqual(saved.incomeTax.current1040, snapshot);
});

test('known income survives a non-income tax gap without mutating saved facts', () => {
  const saved = blankWizardPlan({ clientBirthDate: null });
  ensureWizardCurrent1040(saved);
  saved.incomeTax.current1040.income.wages = 125000;
  const snapshot = structuredClone(saved.incomeTax.current1040);

  const summary = buildWizardIncomeTaxSummary(saved);

  assert.equal(summary.status, 'partial');
  assert.equal(summary.calculationScope, 'available-inputs');
  assert.equal(summary.totalIncome, 125000);
  assert.equal(summary.deductionUsed, 16100);
  assert.equal(summary.deductionSource, 'supplied-line12e');
  assert.equal(summary.federalTaxLiability, 18734);
  assert.deepEqual(saved.incomeTax.current1040, snapshot);
});

test('blank income remains unavailable instead of becoming a modeled zero', () => {
  const saved = blankWizardPlan({ clientBirthDate: null });
  ensureWizardCurrent1040(saved);

  const summary = buildWizardIncomeTaxSummary(saved);

  assert.equal(summary.status, 'needs_facts');
  assert.equal(summary.totalIncome, null);
  assert.equal(summary.federalTaxLiability, null);
});

test('planning income reaches the available-input tax calculation', () => {
  const saved = blankWizardPlan({ clientBirthDate: null });
  saved.income.other.push({
    id: 'planning_wages',
    typeId: 'wages',
    owner: 'client',
    label: 'Salary',
    amount: 75000,
    startAge: 0,
    endAge: 999,
    realGrowth: 0,
    taxablePct: 1,
  });
  ensureWizardCurrent1040(saved);
  const snapshot = structuredClone(saved);

  const summary = buildWizardIncomeTaxSummary(saved);

  assert.equal(summary.status, 'partial');
  assert.equal(summary.calculationScope, 'available-inputs');
  assert.equal(summary.totalIncome, 75000);
  assert.equal(typeof summary.federalTaxLiability, 'number');
  assert.ok(summary.federalTaxLiability > 0);
  assert.deepEqual(saved, snapshot);
});

test('MFJ without spouse DOB keeps taxpayers.spouse and reports DOB issue only', () => {
  const saved = blankWizardPlan({
    filingStatus: 'marriedFilingJointly',
    spouseBirthDate: null,
  });
  ensureWizardCurrent1040(saved);
  syncWizardTaxpayerFacts(saved);
  assert.deepEqual(saved.incomeTax.current1040.taxpayers, {
    client: { birthDate: '1960-06-15' },
    spouse: {},
  });

  const summary = buildWizardIncomeTaxSummary(saved);

  assert.equal(summary.status, 'needs_facts');
  assert.match(summary.message, /taxpayers\.spouse\.birthDate/);
  assert.doesNotMatch(summary.message, /Confirm that current1040 income/i);
  assert.equal(summary.totalIncome, null);
});

test('buildCurrent1040Intake still requires incomeSourcesComplete on saved envelope', () => {
  const saved = blankWizardPlan();
  ensureWizardCurrent1040(saved);
  const built = buildCurrent1040Intake(saved);
  assert.ok(built.gaps.some(gap => gap.code === 'CURRENT_1040_INCOME_SOURCES_INCOMPLETE'));
});

test('authoritative baseline rejects a saved unconfirmed return without materializing defaults', () => {
  const saved = blankWizardPlan();
  ensureWizardCurrent1040(saved);
  confirmWizardTaxInputs(saved);
  saved.incomeTax.current1040.incomeSourcesComplete = false;
  const snapshot = structuredClone(saved);

  const baseline = buildCurrentAnnualFederalTaxBaseline(saved);

  assert.equal(baseline.status, 'needs_facts');
  assert.equal(baseline.input, null);
  assert.ok(baseline.issues.some(issue => (
    issue.code === 'CURRENT_1040_INCOME_SOURCES_INCOMPLETE'
  )));
  assert.deepEqual(saved, snapshot);
});

test('authoritative baseline rejects a DOB-only record without creating zero income or Schedule D', () => {
  const saved = blankWizardPlan();
  ensureWizardCurrent1040(saved);
  const snapshot = structuredClone(saved);

  const baseline = buildCurrentAnnualFederalTaxBaseline(saved);

  assert.equal(baseline.status, 'needs_facts');
  assert.equal(baseline.input, null);
  assert.ok(baseline.issues.some(issue => (
    issue.code === 'CURRENT_1040_INCOME_SOURCES_INCOMPLETE'
  )));
  assert.equal(Object.hasOwn(saved.incomeTax.current1040, 'scheduleD'), false);
  assert.deepEqual(saved, snapshot);
});

test('authoritative baseline requires a fully ready age-dependent deduction result', () => {
  const saved = blankWizardPlan();
  ensureWizardCurrent1040(saved);
  confirmWizardTaxInputs(saved);
  saved.taxProfiles.client.birthDate = fact(null);
  delete saved.incomeTax.current1040.taxpayers.client;
  const snapshot = structuredClone(saved);

  const baseline = buildCurrentAnnualFederalTaxBaseline(saved);

  assert.equal(baseline.status, 'needs_facts');
  assert.equal(baseline.input, null);
  assert.notEqual(baseline.summary.status, 'ready');
  assert.deepEqual(saved, snapshot);
});

test('wizard summary helper does not introduce circular imports', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const completionSource = readFileSync(
    `${root}/src/household/wizardTaxCompletion.js`,
    'utf8',
  );
  assert.doesNotMatch(
    completionSource,
    /buildWizardIncomeTaxSummary/,
    'wizardTaxCompletion must not import buildWizardIncomeTaxSummary',
  );
});

test('Summary Continue to Scenarios is never blocked by tax readiness', () => {
  const plan = blankWizardPlan();
  ensureWizardCurrent1040(plan);
  const wizard = createHouseholdWizard({
    get plan(){ return plan; },
    uiState: { taxView: 'simplified', optionalTaxItems: new Set(), optionalMenuOpen: false },
    states: [['VA', 'Virginia']],
    accountTypes: getWizardAccountTypes(),
    taxState: () => ({
      current: plan.incomeTax.current1040,
      deductionMode: 'standard',
      planningIncome: { groups: {} },
    }),
    taxBucketSnapshot: () => ({
      totalBalance: 0,
      buckets: {
        taxable: { label: 'Taxable', balance: 0, accountCount: 0 },
        traditional: { label: 'Traditional', balance: 0, accountCount: 0 },
        roth: { label: 'Roth', balance: 0, accountCount: 0 },
      },
    }),
    incomeTaxSummary: () => buildWizardIncomeTaxSummary(plan),
  });

  const footer = wizard.footer('summary');
  assert.doesNotMatch(footer, /data-tax-completion-required/);
  assert.doesNotMatch(footer, /aria-disabled="true"/);
  assert.match(footer, /Continue to Scenarios/);
});

test('buildWizardTaxPlan stays a non-confirming clone', () => {
  const saved = blankWizardPlan();
  const clone = buildWizardTaxPlan(saved);
  assert.notEqual(clone, saved);
  assert.equal(clone.incomeTax.current1040.incomeSourcesComplete, false);
  assert.equal(saved.incomeTax?.current1040?.incomeSourcesComplete ?? false, false);
});

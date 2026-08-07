import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrent1040Intake } from '../planning/tax/buildCurrent1040Intake.js';
import { buildCurrentIncomeTaxSummary } from '../planning/tax/buildCurrentIncomeTaxSummary.js';
import * as wizardIntakeFacade from './wizardIntake.js';
import {
  buildWizardTaxPlan,
  clearWizardTaxConfirmation,
  confirmWizardTaxInputs,
  ensureWizardCurrent1040,
  invalidateWizardTaxCompletion,
  overrideWizardIncomeGroup,
  readWizardTaxState,
  removeWizardTaxItem,
  revertWizardIncomeGroup,
  setWizardTaxField,
  syncWizardTaxpayerFacts,
} from './wizardIntake.js';
import { isWizardTaxComplete } from './wizardTaxCompletion.js';
import { readWizardPlanningIncome } from './wizardPlanningIncome.js';
import { parseWizardNumber } from './wizardTaxMutations.js';

test('wizard intake facade exposes only the stable acyclic production surface', () => {
  assert.deepEqual(Object.keys(wizardIntakeFacade).sort(), [
    'buildWizardIncomeTaxSummary',
    'buildWizardTaxPlan',
    'clearWizardTaxConfirmation',
    'confirmWizardTaxInputs',
    'ensureWizardCurrent1040',
    'invalidateWizardTaxCompletion',
    'overrideWizardIncomeGroup',
    'readWizardTaxState',
    'removeWizardTaxItem',
    'revertWizardIncomeGroup',
    'setWizardTaxField',
    'syncWizardTaxpayerFacts',
  ]);
});

function fact(value){
  return {
    value,
    status: value == null ? 'unknown' : 'confirmed',
    source: value == null ? null : 'household-entry',
    confirmedAt: value == null ? null : '2026-07-29T12:00:00.000Z',
    version: 1,
  };
}

function plan(filingStatus = 'single'){
  return {
    meta: { filingStatus },
    household: {
      primary: { currentAge: 65 },
      spouse: filingStatus === 'marriedFilingJointly' ? { currentAge: 65 } : null,
    },
    taxProfiles: {
      client: { birthDate: fact('1960-06-15') },
      spouse: { birthDate: fact('1961-01-01') },
    },
    income: { other: [] },
    incomeTax: {},
    portfolio: { extraAccounts: [] },
  };
}

test('initializes the canonical base-and-age route without inventing missing tax facts', () => {
  const subject = plan();
  const current = ensureWizardCurrent1040(subject);

  assert.deepEqual(current.returnScope, { modeledTaxpayer: 'client' });
  assert.deepEqual(current.taxpayers, { client: { birthDate: '1960-06-15' } });
  assert.deepEqual(current.deductions, {
    method: 'standard',
    source: 'calculated',
    standardScope: 'base-and-age',
  });
  assert.equal(current.incomeSourcesComplete, false);
  assert.equal(Object.hasOwn(current, 'scheduleD'), false);
  assert.equal(Object.hasOwn(current.deductions, 'qbi'), false);
  assert.equal(Object.hasOwn(current.deductions, 'schedule1A'), false);
});

test('manual long-term gain/loss preserves blank versus explicit zero end to end', () => {
  const subject = plan();
  ensureWizardCurrent1040(subject);

  setWizardTaxField(subject, 'scheduleD.netLongTermGainOrLoss', '');
  assert.equal(Object.hasOwn(subject.incomeTax.current1040, 'scheduleD'), false);

  setWizardTaxField(subject, 'scheduleD.netLongTermGainOrLoss', 0);
  assert.deepEqual(subject.incomeTax.current1040.scheduleD, {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 0,
  });
  assert.equal(buildCurrent1040Intake(subject).intake.scheduleD.netLongTermGainOrLoss, 0);

  setWizardTaxField(subject, 'scheduleD.netLongTermGainOrLoss', -3000);
  assert.equal(subject.incomeTax.current1040.scheduleD.netLongTermGainOrLoss, -3000);
});

test('income fields preserve explicit zero and reject negative non-signed amounts', () => {
  const subject = plan();
  ensureWizardCurrent1040(subject);
  subject.incomeTax.current1040.incomeSourcesComplete = true;
  setWizardTaxField(subject, 'income.wages', 0);
  setWizardTaxField(subject, 'income.otherIncome', -1200);

  assert.equal(subject.incomeTax.current1040.incomeSourcesComplete, false);
  assert.equal(subject.incomeTax.current1040.income.wages, 0);
  assert.equal(subject.incomeTax.current1040.income.otherIncome, -1200);
  setWizardTaxField(subject, 'income.wages', '');
  assert.equal(Object.hasOwn(subject.incomeTax.current1040.income, 'wages'), false);
  assert.throws(
    () => setWizardTaxField(subject, 'income.taxableInterest', -1),
    /zero or a positive amount/,
  );
});

test('Tax member wages save as owner-specific planning rows and derive one 1040 total', () => {
  const subject = plan('marriedFilingJointly');
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary.retirementAge = 70;
  subject.household.spouse.retirementAge = 68;
  ensureWizardCurrent1040(subject);

  setWizardTaxField(subject, 'income.wages.client', 80_000);
  setWizardTaxField(subject, 'income.wages.spouse', 60_000);

  assert.deepEqual(
    subject.income.other.map(row => ({
      owner: row.owner,
      amount: row.amount,
      startAge: row.startAge,
      endAge: row.endAge,
    })),
    [
      { owner: 'client', amount: 80_000, startAge: undefined, endAge: undefined },
      { owner: 'spouse', amount: 60_000, startAge: undefined, endAge: undefined },
    ],
  );
  assert.equal(
    Object.hasOwn(subject.incomeTax.current1040.income, 'wages'),
    false,
  );
  assert.equal(buildCurrent1040Intake(subject).intake.income.wages, 140_000);
  assert.deepEqual(
    readWizardPlanningIncome(subject).wagesByOwner.client.value,
    80_000,
  );
  assert.deepEqual(
    readWizardPlanningIncome(subject).wagesByOwner.spouse.value,
    60_000,
  );
});

test('prior-year member wages remain return facts and do not create projected wage rows', () => {
  const subject = plan('marriedFilingJointly');
  subject.meta.planningAsOfYear = 2026;
  const current = ensureWizardCurrent1040(subject);
  current.taxYear = 2025;

  setWizardTaxField(subject, 'income.wages.client', 70_000);
  setWizardTaxField(subject, 'income.wages.spouse', 50_000);

  assert.deepEqual(subject.income.other, []);
  assert.deepEqual(current.wagesByOwner, { client: 70_000, spouse: 50_000 });
  assert.equal(current.income.wages, 120_000);
  assert.deepEqual(current.planningIncomeOverrides, ['wages']);
});

test('current-year wages entered after retirement stay on the return but do not project', () => {
  const subject = plan();
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary.currentAge = 65;
  subject.household.primary.retirementAge = 65;
  subject.household.primary.employmentStatus = 'retired';
  ensureWizardCurrent1040(subject);

  setWizardTaxField(subject, 'income.wages.client', 25_000);

  assert.deepEqual(
    subject.income.other.map(row => ({
      owner: row.owner,
      amount: row.amount,
      startAge: row.startAge,
      endAge: row.endAge,
    })),
    [{ owner: 'client', amount: 25_000, startAge: 65, endAge: 65 }],
  );
  assert.equal(buildCurrent1040Intake(subject).intake.income.wages, 25_000);
  assert.equal(readWizardPlanningIncome(subject).wagesByOwner.client.value, 25_000);
});

test('switches among standard, calculated itemized, and supplied line 12e without mixing sources', () => {
  const subject = plan();
  setWizardTaxField(subject, 'deductions.qbi', 0);
  setWizardTaxField(subject, 'deductions.line13b', 0);
  setWizardTaxField(subject, 'deductionMode', 'itemized-details');
  setWizardTaxField(subject, 'deductions.itemized.medicalExpensesPaid', 12000);
  setWizardTaxField(subject, 'deductions.itemized.salt.eligibleTaxesPaid', 18000);
  setWizardTaxField(subject, 'deductions.itemized.salt.magi', 250000);
  setWizardTaxField(subject, 'deductions.itemized.mortgageInterestDeductible', 14000);

  assert.deepEqual(subject.incomeTax.current1040.deductions.itemized.salt, {
    eligibleTaxesPaid: 18000,
    magi: { mode: 'supplied-magi', amount: 250000 },
  });
  assert.equal(subject.incomeTax.current1040.deductions.itemized.medicalExpensesPaid, 12000);

  setWizardTaxField(subject, 'deductionMode', 'itemized-total');
  setWizardTaxField(subject, 'deductions.line12e', 32000);
  assert.equal(subject.incomeTax.current1040.deductions.source, 'supplied-line12e');
  assert.equal(Object.hasOwn(subject.incomeTax.current1040.deductions, 'itemized'), false);
  assert.equal(subject.incomeTax.current1040.deductions.line12e, 32000);

  setWizardTaxField(subject, 'deductionMode', 'standard');
  assert.equal(subject.incomeTax.current1040.deductions.standardScope, 'base-and-age');
  assert.equal(Object.hasOwn(subject.incomeTax.current1040.deductions, 'line12e'), false);
  assert.equal(subject.incomeTax.current1040.deductions.qbi, 0);
  assert.deepEqual(subject.incomeTax.current1040.deductions.schedule1A, {
    mode: 'supplied-line13b',
    amount: 0,
  });
});

test('Social Security source modes never mix supplied line 6b with worksheet facts', () => {
  const subject = plan();
  setWizardTaxField(subject, 'income.socialSecurityBenefits', 42000);
  setWizardTaxField(subject, 'income.taxableSS', 18000);
  assert.deepEqual(subject.incomeTax.current1040.income.socialSecurity, {
    mode: 'supplied-form1040-lines',
  });

  setWizardTaxField(subject, 'socialSecurity.mode', 'calculate-taxable-benefits');
  setWizardTaxField(subject, 'socialSecurity.otherIncome', 85000);
  setWizardTaxField(subject, 'socialSecurity.excludedIncomeAddBacks', 0);
  setWizardTaxField(subject, 'socialSecurity.adjustments', 0);
  assert.equal(Object.hasOwn(subject.incomeTax.current1040.income, 'taxableSS'), false);
  assert.deepEqual(subject.incomeTax.current1040.income.socialSecurity, {
    mode: 'calculate-taxable-benefits',
    otherIncome: 85000,
    excludedIncomeAddBacks: 0,
    adjustments: 0,
  });
});

test('line 23 conflicts fail closed at the UI mapping boundary and Schedule SE uses resolved lines', () => {
  const subject = plan('marriedFilingJointly');
  setWizardTaxField(subject, 'passThrough.line23', 900);
  assert.throws(
    () => setWizardTaxField(
      subject,
      'schedule2.netInvestmentIncomeTax',
      500,
    ),
    error => error.code === 'SCHEDULE_2_SOURCE_CONFLICT',
  );
  removeWizardTaxItem(subject, 'line23');

  setWizardTaxField(subject, 'schedule2.netInvestmentIncomeTax', 500);
  setWizardTaxField(subject, 'schedule2.additionalMedicareTax', 0);
  setWizardTaxField(subject, 'schedule2.otherPartIITaxes', 0);
  setWizardTaxField(subject, 'scheduleSE.enabled', true);
  setWizardTaxField(subject, 'scheduleSE.taxpayerOwner', 'spouse');
  setWizardTaxField(subject, 'scheduleSE.netEarningsFromSelfEmployment', 10000);
  setWizardTaxField(subject, 'scheduleSE.socialSecurityWagesAndTips', 0);

  assert.deepEqual(subject.incomeTax.current1040.scheduleSE, [{
    taxpayerOwner: 'spouse',
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
    netEarningsFromSelfEmployment: 10000,
    socialSecurityWagesAndTips: 0,
  }]);
  removeWizardTaxItem(subject, 'scheduleSE');
  assert.equal(Object.hasOwn(subject.incomeTax.current1040, 'scheduleSE'), false);
});

test('taxpayer facts stay synchronized with filing status and exact DOBs', () => {
  const subject = plan('marriedFilingJointly');
  ensureWizardCurrent1040(subject);
  assert.deepEqual(subject.incomeTax.current1040.returnScope, {
    modeledTaxpayer: 'jointReturn',
  });
  assert.deepEqual(subject.incomeTax.current1040.taxpayers, {
    client: { birthDate: '1960-06-15' },
    spouse: { birthDate: '1961-01-01' },
  });

  subject.meta.filingStatus = 'headOfHousehold';
  syncWizardTaxpayerFacts(subject);
  assert.deepEqual(subject.incomeTax.current1040.returnScope, {
    modeledTaxpayer: 'client',
  });
  assert.deepEqual(subject.incomeTax.current1040.taxpayers, {
    client: { birthDate: '1960-06-15' },
  });
});

test('unrelated tax edits preserve existing active taxpayer facts', () => {
  const subject = plan('marriedFilingJointly');
  ensureWizardCurrent1040(subject);
  subject.incomeTax.current1040.taxpayers.client.blind = true;
  subject.incomeTax.current1040.taxpayers.client.validSsnForEnhancedSeniorDeduction = true;
  subject.incomeTax.current1040.taxpayers.spouse.blind = false;

  setWizardTaxField(subject, 'income.wages', 100000);

  assert.deepEqual(subject.incomeTax.current1040.taxpayers, {
    client: {
      birthDate: '1960-06-15',
      blind: true,
      validSsnForEnhancedSeniorDeduction: true,
    },
    spouse: {
      birthDate: '1961-01-01',
      blind: false,
    },
  });
});

test('an explicit base-and-age selection narrows canonical taxpayer facts to DOB', () => {
  const subject = plan();
  ensureWizardCurrent1040(subject);
  subject.incomeTax.current1040.taxpayers.client.blind = true;
  subject.incomeTax.current1040.deductions = {
    method: 'standard',
    source: 'calculated',
  };

  setWizardTaxField(subject, 'deductionMode', 'standard');

  assert.deepEqual(subject.incomeTax.current1040.taxpayers, {
    client: { birthDate: '1960-06-15' },
  });
  assert.equal(
    subject.incomeTax.current1040.deductions.standardScope,
    'base-and-age',
  );
});

test('clearing supplied line 13b removes the source instead of leaving a malformed shell', () => {
  const subject = plan();
  setWizardTaxField(subject, 'deductions.line13b', 0);
  setWizardTaxField(subject, 'deductions.line13b', '');
  assert.equal(
    Object.hasOwn(subject.incomeTax.current1040.deductions, 'schedule1A'),
    false,
  );
});

test('UI-only view reads defaults without mutating the plan', () => {
  const subject = plan();
  const before = structuredClone(subject);
  const state = readWizardTaxState(subject);
  assert.equal(state.deductionMode, 'standard');
  assert.deepEqual(subject, before);
  assert.equal(parseWizardNumber('0'), 0);
  assert.equal(parseWizardNumber(''), undefined);
});

test('an untouched household uses canonical needs-facts readiness without mutating storage state', () => {
  const subject = plan();
  const before = structuredClone(subject);
  const wizardPlan = buildWizardTaxPlan(subject);
  const summary = buildCurrentIncomeTaxSummary(wizardPlan);

  assert.equal(summary.status, 'needs_facts');
  assert.equal(summary.sourceMode, 'canonical-v1');
  assert.equal(summary.totalIncome, null);
  assert.ok(summary.reasonCodes.includes('CURRENT_1040_INCOME_SOURCES_INCOMPLETE'));
  assert.deepEqual(subject, before);
});

test('planning income groups aggregate rows and override or revert one source atomically', () => {
  const subject = plan();
  subject.income.other = [
    {
      id: 'income-wage-1',
      typeId: 'wages',
      owner: 'client',
      amount: 50000,
      startAge: 65,
      endAge: 65,
    },
    {
      id: 'income-wage-2',
      typeId: 'bonus',
      owner: 'client',
      amount: 15000,
      startAge: 65,
      endAge: 65,
    },
    {
      id: 'income-interest-1',
      typeId: 'interest',
      owner: 'client',
      amount: 1000,
      taxablePct: 0.75,
      startAge: 65,
      endAge: 65,
    },
  ];
  const current = ensureWizardCurrent1040(subject);
  const planning = readWizardPlanningIncome(subject, current);
  assert.equal(planning.groups.wages.values.wages, 65000);
  assert.equal(planning.groups.interest.values.taxableInterest, 750);
  assert.equal(planning.groups.interest.values.taxExemptInterest, 250);
  assert.equal(planning.groups.wages.rowSourced, true);

  overrideWizardIncomeGroup(subject, 'wages');
  assert.deepEqual(current.planningIncomeOverrides, ['wages']);
  assert.equal(current.income.wages, 65000);
  assert.equal(readWizardPlanningIncome(subject, current).groups.wages.overridden, true);
  assert.throws(
    () => setWizardTaxField(subject, 'income.wages', ''),
    /Enter 0 or use planning income again/,
  );

  revertWizardIncomeGroup(subject, 'wages');
  assert.equal(Object.hasOwn(current, 'planningIncomeOverrides'), false);
  assert.equal(Object.hasOwn(current.income, 'wages'), false);
  assert.equal(readWizardPlanningIncome(subject, current).groups.wages.rowSourced, true);
});

test('confirmWizardTaxInputs materializes Schedule D zero when blank', () => {
  const subject = plan();
  ensureWizardCurrent1040(subject);
  confirmWizardTaxInputs(subject);
  assert.equal(
    subject.incomeTax.current1040.scheduleD?.netLongTermGainOrLoss,
    0,
  );
  assert.equal(subject.incomeTax.current1040.incomeSourcesComplete, true);
  const current = subject.incomeTax.current1040;
  for(const field of [
    'wages',
    'taxableInterest',
    'taxExemptInterest',
    'ordinaryDividends',
    'qualifiedDividends',
    'iraDistributions',
    'taxableIra',
    'rothConversion',
    'pensionAmount',
    'taxablePensions',
    'socialSecurityBenefits',
    'taxableSS',
    'otherIncome',
  ]){
    assert.equal(current.income[field], 0, field);
    assert.equal(Object.hasOwn(current.income, field), true, field);
  }
  assert.deepEqual(current.adjustments, {
    mode: 'supplied-line10',
    amount: 0,
  });
  assert.equal(current.deductions.qbi, 0);
  assert.deepEqual(current.deductions.schedule1A, {
    mode: 'supplied-line13b',
    amount: 0,
  });
  assert.deepEqual(current.passThrough, {
    line17: 0,
    line19: 0,
    line20: 0,
    line23: 0,
  });
  assert.equal(isWizardTaxComplete(subject), true);

  clearWizardTaxConfirmation(subject);
  assert.equal(isWizardTaxComplete(subject), false);
  assert.equal(current.income.wages, 0);
});

test('Tax confirmation never fills required IRA, pension, or Social Security companions', () => {
  for(const [field, amount, expectedCode] of [
    ['income.iraDistributions', 20000, 'CURRENT_1040_TAXABLE_IRA_REQUIRED'],
    ['income.pensionAmount', 15000, 'CURRENT_1040_TAXABLE_PENSION_REQUIRED'],
    [
      'income.socialSecurityBenefits',
      30000,
      'CURRENT_1040_SOCIAL_SECURITY_RETURN_FACTS_REQUIRED',
    ],
  ]){
    const subject = plan();
    setWizardTaxField(subject, 'scheduleD.netLongTermGainOrLoss', 0);
    setWizardTaxField(subject, field, amount);
    assert.throws(
      () => confirmWizardTaxInputs(subject),
      error => error.code === expectedCode,
      field,
    );
  }
});

test('Schedule SE completion owns line 23 and fills only the supplied Schedule 2 trio', () => {
  const subject = plan();
  setWizardTaxField(subject, 'scheduleD.netLongTermGainOrLoss', 0);
  setWizardTaxField(subject, 'scheduleSE.enabled', true);
  setWizardTaxField(subject, 'scheduleSE.taxpayerOwner', 'client');
  setWizardTaxField(subject, 'scheduleSE.netEarningsFromSelfEmployment', 18000);
  setWizardTaxField(subject, 'scheduleSE.socialSecurityWagesAndTips', 0);

  confirmWizardTaxInputs(subject);

  const current = subject.incomeTax.current1040;
  assert.equal(Object.hasOwn(current.passThrough, 'line23'), false);
  assert.deepEqual(current.schedule2, {
    netInvestmentIncomeTax: 0,
    additionalMedicareTax: 0,
    otherPartIITaxes: 0,
  });
  assert.equal(isWizardTaxComplete(subject), true);
});

test('planning-income mutations invalidate a previously confirmed Tax intake', () => {
  const subject = plan();
  setWizardTaxField(subject, 'scheduleD.netLongTermGainOrLoss', 0);
  confirmWizardTaxInputs(subject);
  assert.equal(isWizardTaxComplete(subject), true);

  invalidateWizardTaxCompletion(subject);

  assert.equal(subject.incomeTax.current1040.incomeSourcesComplete, false);
  assert.equal(isWizardTaxComplete(subject), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateYear,
  attributeSleeves,
  householdIncome,
  sleeveBalances,
  withdrawalAccountState,
  approveWithdrawalPlannerLeverChange,
} from './taxEngineAdapter.js';
import {
  defaultPlan as plan,
  householdIncomeAtYear,
  resolveInputs,
} from '../../../engine.js';
import {
  buildDefaultTaxContext,
  runEngineYearTax,
} from '../../tax/annual1040.js';
import { createAccount } from '../../household/createAccount.js';
import { applyHouseholdWizardEdit } from '../../household/wizardEdits.js';
import { createBlankHousehold } from '../../../ui/householdFactories.js';

test('taxEngineAdapter evaluates a focus year from demo-shaped plan', async () => {
  const facts = {
    filingStatus: plan.meta?.filingStatus || 'marriedFilingJointly',
    livedWithSpouse: false,
    socialSecurityBenefits: 0,
    wages: 0,
    otherIncome: 0,
  };
  const levers = {
    realizedGain: 0,
    deferredWithdrawal: 0,
    rothConversion: 0,
    rothWithdrawal: 0,
    qcd: 0,
  };
  const result = await evaluateYear({ plan, taxYear: 2026, facts, levers });
  assert.ok(result);
  assert.equal(result.error, undefined);
  assert.equal(typeof result.lawVersion, 'string');
  assert.equal(typeof result.ordinary?.rate, 'number');
  assert.equal(result.irmaa?.premiumYear, 2028);
  assert.equal(result.irmaa?.tier, 0);
  assert.equal(result.irmaa?.scope, undefined);
});

test('taxEngineAdapter returns null when filing status is missing', async () => {
  const result = await evaluateYear({
    plan,
    taxYear: 2026,
    facts: { filingStatus: null, wages: 0 },
    levers: { realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0, rothWithdrawal: 0, qcd: 0 },
  });
  assert.equal(result, null);
});

test('taxEngineAdapter attributes incremental tax to withdrawal sleeves', async () => {
  const facts = {
    filingStatus: 'marriedFilingJointly',
    livedWithSpouse: false,
    socialSecurityBenefits: 0,
    wages: 120_000,
    otherIncome: 0,
  };
  const levers = {
    realizedGain: 0,
    deferredWithdrawal: 50_000,
    rothConversion: 0,
    rothWithdrawal: 0,
    qcd: 0,
  };
  const att = await attributeSleeves({ plan, taxYear: 2026, facts, levers });
  assert.ok(att);
  assert.equal(att.error, undefined);
  assert.equal(typeof att.incrementalTax, 'number');
  assert.equal(typeof att.byBucket?.traditional, 'number');
});

test('sleeveBalances reads portfolio fold balances', async () => {
  const caps = await sleeveBalances(plan);
  assert.equal(typeof caps.taxable, 'number');
  assert.equal(typeof caps.traditional, 'number');
  assert.equal(typeof caps.roth, 'number');
});

test('evaluateYear returns engine-owned threshold dollars and incremental net cash', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.accounts = {
    taxable: { balance: 1_000_000, basisPct: 0.6 },
    traditional: { balance: 1_000_000 },
    roth: { balance: 1_000_000 },
  };
  subject.portfolio.extraAccounts = [];
  const facts = {
    filingStatus: 'single',
    livedWithSpouse: false,
    socialSecurityBenefits: 0,
    wages: 50_000,
    otherIncome: 0,
  };
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0,
      deferredWithdrawal: 20_000,
      rothConversion: 0,
      rothWithdrawal: 0,
      qcd: 0,
    },
  });

  assert.deepEqual(result.thresholdTaxDollars, {
    ordinaryIncomeTax: 6_570,
    preferentialIncomeTax: 0,
    irmaaPremium: 0,
    socialSecurityIncrementalModeledFederalIncomeTax: 0,
  });
  assert.deepEqual(result.ladders.ltcg.rates, {
    zero: 0,
    middle: 0.15,
    top: 0.20,
  });
  assert.deepEqual(result.ladders.socialSecurity.rates, {
    lowerTier: 0.50,
    upperTier: 0.85,
  });
  assert.deepEqual(result.modeledFederalIncomeTax, {
    baseline: 3_820,
    selected: 6_570,
    incremental: 2_750,
    taxTotalScope: 'INCOME_TAX_ONLY',
  });
  assert.deepEqual(result.cash, {
    grossWithdrawalCash: 20_000,
    incrementalModeledFederalIncomeTax: 2_750,
    netAfterIncrementalModeledFederalIncomeTax: 17_250,
  });
  assert.equal(result.totals.netCash, 17_250);
});

test('Withdrawal Planner IRMAA uses selected MAGI, annual premium delta, room, and premium year', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary = {
    ...subject.household.primary,
    currentAge: 65,
    planEndAge: 95,
  };
  subject.household.spouse = null;
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 0 },
    traditional: { balance: 1_000_000 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [];
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      filingStatus: 'single',
      socialSecurityBenefits: 0,
      wages: 108_000,
      taxExemptInterest: 1_000,
      otherIncome: 0,
      ages: { client: 65 },
      people: { client: { age: 65, alive: true }, spouse: null },
    },
    levers: {
      realizedGain: 0,
      deferredWithdrawal: 1,
      rothConversion: 0,
      rothWithdrawal: 0,
      qcd: 0,
    },
  });

  assert.equal(result.totals.agi, 108001);
  assert.equal(result.totals.magi, 109001);
  assert.equal(result.irmaa.tier, 1);
  assert.equal(result.irmaa.nextTier, 2);
  assert.equal(result.irmaa.roomToNext, 27999);
  assert.equal(result.irmaa.premiumYear, 2028);
  assert.equal(result.irmaa.baselineAnnualHouseholdAdjustment, 0);
  assert.equal(result.irmaa.incrementalAnnualHouseholdAdjustment, 1148.40);
  assert.equal(result.thresholdTaxDollars.irmaaPremium, 1148.40);
  assert.equal(
    result.cash.netAfterIncrementalModeledFederalIncomeTax,
    1 - result.modeledFederalIncomeTax.incremental,
  );
});

test('Realized Gain is taxed directly without being counted as withdrawal cash', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.accounts = {
    taxable: { balance: 1_000_000, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [];
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      filingStatus: 'single', livedWithSpouse: false,
      socialSecurityBenefits: 0, wages: 50_000, otherIncome: 0,
    },
    levers: {
      realizedGain: 100_000,
      deferredWithdrawal: 0,
      rothConversion: 0,
      rothWithdrawal: 0,
      qcd: 0,
    },
  });
  assert.equal(result.thresholdTaxDollars.ordinaryIncomeTax, 3_820);
  assert.equal(result.thresholdTaxDollars.preferentialIncomeTax, 12_667.50);
  assert.equal(result.modeledFederalIncomeTax.selected, 16_487.50);
  assert.equal(result.modeledFederalIncomeTax.incremental, 12_667.50);
  assert.deepEqual(result.cash, {
    grossWithdrawalCash: 0,
    incrementalModeledFederalIncomeTax: 12_667.50,
    netAfterIncrementalModeledFederalIncomeTax: -12_667.50,
  });
  assert.deepEqual(result.accountState.pools.taxable, {
    available: 1_000_000,
    used: 0,
    remaining: 1_000_000,
  });
});

test('Realized Gain uses taxable-investment balances without reporting filters or depletion', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.accounts = {
    taxable: { balance: 40_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const brokerage = createAccount('brokerage_taxable', {
    owner: 'client', balance: 50_000,
  });
  const joint = createAccount('joint_brokerage', { balance: 60_000 });
  const tod = createAccount('tod_brokerage', {
    owner: 'client', balance: 70_000,
  });
  const trust = createAccount('trust_brokerage', { balance: 80_000 });
  const checking = createAccount('checking', {
    owner: 'client', balance: 900_000,
  });
  assert.equal(joint.taxReporting.inclusion, 'unknown');
  subject.portfolio.extraAccounts = [brokerage, joint, tod, trust, checking];
  const state = await withdrawalAccountState(subject);
  const approval = await approveWithdrawalPlannerLeverChange(
    subject,
    { realizedGain: 0 },
    'realizedGain',
    400_000,
  );
  assert.equal(state.limits.realizedGain.max, 300_000);
  assert.equal(state.balances.taxable, 300_000);
  assert.deepEqual(state.pools.taxable, {
    available: 300_000,
    used: 0,
    remaining: 300_000,
  });
  assert.equal(approval.approved, true);
  assert.equal(approval.approvedValue, 300_000);
  assert.equal(approval.clamped, true);
  assert.deepEqual(approval.state.pools.taxable, {
    available: 300_000,
    used: 0,
    remaining: 300_000,
  });

  subject.portfolio.accounts.taxable.balance = 900_000;
  const ceilingState = await withdrawalAccountState(subject);
  assert.equal(ceilingState.limits.realizedGain.max, 500_000);
});

test('saved Tax-module Schedule D is the baseline and Planner Realized Gain is additive', async () => {
  let subject = createBlankHousehold(plan, 'hh_schedule_d_baseline', 2026);
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', action: 'add-income-source', typeId: 'wages', owner: 'client',
  });
  const wageRowId = subject.income.other.at(-1).id;
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'source.amount', rowId: wageRowId, value: 50_000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax', action: 'set', field: 'income.wages.client', value: 50_000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax', action: 'set',
    field: 'scheduleD.netLongTermGainOrLoss', value: 20_000,
  });
  subject.portfolio.accounts.taxable.balance = 200_000;
  subject.portfolio.extraAccounts = [];
  const facts = await householdIncome(subject, 2026, { baseYear: 2026 });
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 10_000,
      deferredWithdrawal: 0,
      rothConversion: 0,
      rothWithdrawal: 0,
      qcd: 0,
    },
  });

  assert.equal(facts.capitalGain, 20_000);
  assert.equal(result.ltcg.gains, 30_000);
  assert.equal(result.modeledFederalIncomeTax.baseline, 4_487.50);
  assert.equal(result.modeledFederalIncomeTax.selected, 5_987.50);
  assert.equal(result.modeledFederalIncomeTax.incremental, 1_500);
});

test('Brokerage basis and loss evidence do not change Planner Realized Gain behavior', async () => {
  const basisVariants = [
    null,
    { amount: 120_000, method: 'reported-cost-basis', status: 'confirmed' },
    { amount: 250_000, method: 'reported-cost-basis', status: 'confirmed' },
    { amount: 250_000, method: 'principal', status: 'confirmed' },
  ];
  const observed = [];

  for (const basis of basisVariants) {
    const subject = structuredClone(plan);
    subject.meta.filingStatus = 'single';
    subject.household.spouse = null;
    subject.portfolio.accounts = {
      taxable: { balance: 0, basisPct: 1 },
      traditional: { balance: 100_000 },
      roth: { balance: 100_000 },
    };
    const brokerage = createAccount('brokerage_taxable', {
      owner: 'client', balance: 200_000,
    });
    if (basis) brokerage.basis = { ...brokerage.basis, ...basis };
    subject.portfolio.extraAccounts = [brokerage];
    const facts = {
      filingStatus: 'single', livedWithSpouse: false,
      socialSecurityBenefits: 0, wages: 50_000, otherIncome: 0,
    };
    const state = await withdrawalAccountState(subject);
    const result = await evaluateYear({
      plan: subject,
      taxYear: 2026,
      facts,
      levers: {
        realizedGain: 50_000,
        deferredWithdrawal: 0,
        rothConversion: 0,
        rothWithdrawal: 0,
        qcd: 0,
      },
    });
    observed.push({
      max: state.limits.realizedGain.max,
      hasBasisContract: Object.hasOwn(state, 'taxableBasis'),
      gains: result.ltcg.gains,
      federalTax: result.totals.federalTax,
      ordinaryAvailable: state.limits.deferredWithdrawal.available,
      rothAvailable: state.limits.rothWithdrawal.available,
    });
  }

  assert.deepEqual(observed, basisVariants.map(() => ({
    max: 200_000,
    hasBasisContract: false,
    gains: 50_000,
    federalTax: 8_987.50,
    ordinaryAvailable: true,
    rothAvailable: true,
  })));
});

test('Social Security threshold dollars use a full tax-engine counterfactual', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.accounts = {
    taxable: { balance: 1_000_000, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [];
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      filingStatus: 'single', livedWithSpouse: false,
      socialSecurityBenefits: 30_000, wages: 20_000, otherIncome: 0,
    },
    levers: {
      realizedGain: 40_000,
      deferredWithdrawal: 0,
      rothConversion: 0,
      rothWithdrawal: 0,
      qcd: 0,
    },
  });
  assert.equal(result.thresholdTaxDollars.ordinaryIncomeTax, 3_280);
  assert.equal(result.thresholdTaxDollars.preferentialIncomeTax, 2_992.50);
  assert.equal(
    result.thresholdTaxDollars.socialSecurityIncrementalModeledFederalIncomeTax,
    5_882.50
  );
});

test('evaluateYear fails closed when shared traditional levers exceed one balance', async () => {
  const subject = structuredClone(plan);
  subject.portfolio.accounts.traditional.balance = 100_000;
  subject.portfolio.extraAccounts = [];
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      filingStatus: 'marriedFilingJointly', livedWithSpouse: false,
      socialSecurityBenefits: 0, wages: 0, otherIncome: 0,
    },
    levers: {
      realizedGain: 0,
      deferredWithdrawal: 100_000,
      rothConversion: 100_000,
      rothWithdrawal: 0,
      qcd: 100_000,
    },
  });
  assert.equal(result.code, 'WITHDRAWAL_ACCOUNT_LIMIT_EXCEEDED');
  assert.ok(result.accountState.issues.some(issue => issue.code === 'TRADITIONAL_POOL_EXCEEDED'));
});

test('fixed IRA distributions reserve the shared traditional balance', async () => {
  const subject = structuredClone(plan);
  subject.portfolio.accounts.traditional.balance = 100_000;
  subject.portfolio.extraAccounts = [];
  const facts = {
    filingStatus: 'single',
    iraDistributions: 80_000,
    taxableIra: 80_000,
    wages: 0,
    socialSecurityBenefits: 0,
  };
  const levers = {
    realizedGain: 0,
    deferredWithdrawal: 0,
    rothConversion: 80_000,
    rothWithdrawal: 0,
    qcd: 0,
  };

  const state = await withdrawalAccountState(subject, levers, facts);
  assert.strictEqual(state.valid, false);
  assert.strictEqual(state.limits.rothConversion.max, 20_000);
  assert.deepStrictEqual(state.reservations, {
    traditional: 80_000,
    traditionalTotal: 80_000,
    rmdEligibleCash: 0,
    taxYear: 2026,
  });

  const approval = await approveWithdrawalPlannerLeverChange(
    subject,
    { rothConversion: 0 },
    'rothConversion',
    80_000,
    facts
  );
  assert.strictEqual(approval.approvedValue, 20_000);
  assert.strictEqual(approval.clamped, true);

  const result = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  assert.strictEqual(result.code, 'WITHDRAWAL_ACCOUNT_LIMIT_EXCEEDED');
});

test('matching Tax-page IRA distributions and Roth conversions reach tax, cash, and account reservations once', async () => {
  const subject = structuredClone(plan);
  subject.meta.planningAsOfYear = 2026;
  subject.meta.filingStatus = 'single';
  subject.household.primary = {
    currentAge: 60, retirementAge: 65, planEndAge: 95,
  };
  subject.household.spouse = null;
  subject.income.socialSecurity = { primary: null, spouse: null };
  subject.income.other = [];
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 200_000 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [];
  subject.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    returnScope: { modeledTaxpayer: 'client' },
    income: {
      wages: 0,
      taxableInterest: 0,
      taxExemptInterest: 0,
      ordinaryDividends: 0,
      qualifiedDividends: 0,
      iraDistributions: 40_000,
      taxableIra: 30_000,
      rothConversion: 20_000,
      pensionAmount: 0,
      taxablePensions: 0,
      otherIncome: 0,
      socialSecurityBenefits: 0,
      taxableSS: 0,
      socialSecurity: { mode: 'supplied-form1040-lines' },
    },
  };

  const facts = await householdIncome(subject, 2026, { baseYear: 2026 });
  assert.strictEqual(facts.iraDistributions, 60_000);
  assert.strictEqual(facts.iraCashDistributions, 40_000);
  assert.strictEqual(facts.taxableIra, 50_000);
  assert.strictEqual(facts.rothConversion, 20_000);
  assert.strictEqual(facts.grossOtherIncome, 40_000);
  assert.deepStrictEqual(facts.iraDistributionsByOwner, {
    client: 60_000, spouse: 0,
  });
  assert.deepStrictEqual(facts.iraCashDistributionsByOwner, {
    client: 40_000, spouse: 0,
  });

  const state = await withdrawalAccountState(subject, {}, facts);
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.reservations.traditionalTotal, 60_000);
  assert.strictEqual(state.reservations.rmdEligibleCash, 40_000);
  assert.strictEqual(state.limits.rothConversion.max, 140_000);
  assert.strictEqual(state.pools.traditional.remaining, 140_000);

  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.code, undefined);
  assert.strictEqual(result.totals.agi, 50_000);
  assert.strictEqual(result.modeledFederalIncomeTax.selected, 3_820);
  assert.strictEqual(result.modeledFederalIncomeTax.incremental, 0);
  assert.strictEqual(result.cash.grossWithdrawalCash, 0);

  const future = await householdIncome(subject, 2027, { baseYear: 2026 });
  assert.strictEqual(Object.hasOwn(future, 'iraDistributions'), false);
  assert.strictEqual(Object.hasOwn(future, 'iraCashDistributions'), false);
  assert.strictEqual(Object.hasOwn(future, 'taxableIra'), false);
  assert.strictEqual(future.grossOtherIncome, 0);
});

test('MFJ current-return IRA totals stay taxable without inventing owner attribution', async () => {
  const subject = structuredClone(plan);
  subject.meta.planningAsOfYear = 2026;
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.household.primary = {
    currentAge: 60, retirementAge: 65, planEndAge: 95, birthYear: 1966,
  };
  subject.household.spouse = {
    currentAge: 58, retirementAge: 64, planEndAge: 95, birthYear: 1968,
  };
  subject.income.socialSecurity = { primary: null, spouse: null };
  subject.income.other = [];
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 150_000, valuationDate: '2025-12-31',
    }),
    createAccount('traditional_ira', {
      owner: 'spouse', balance: 150_000, valuationDate: '2025-12-31',
    }),
  ];
  subject.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    returnScope: { modeledTaxpayer: 'jointReturn' },
    income: {
      wages: 0,
      taxableInterest: 0,
      taxExemptInterest: 0,
      ordinaryDividends: 0,
      qualifiedDividends: 0,
      iraDistributions: 40_000,
      taxableIra: 40_000,
      rothConversion: 20_000,
      pensionAmount: 0,
      taxablePensions: 0,
      otherIncome: 0,
      socialSecurityBenefits: 0,
      taxableSS: 0,
      socialSecurity: { mode: 'supplied-form1040-lines' },
    },
  };

  const facts = await householdIncome(subject, 2026, { baseYear: 2026 });
  assert.strictEqual(facts.iraDistributions, 60_000);
  assert.strictEqual(facts.iraCashDistributions, 40_000);
  assert.strictEqual(facts.taxableIra, 60_000);
  assert.strictEqual(Object.hasOwn(facts, 'iraDistributionsByOwner'), false);
  assert.strictEqual(Object.hasOwn(facts, 'iraCashDistributionsByOwner'), false);

  const state = await withdrawalAccountState(subject, {}, facts);
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.rmd.status, 'not-required');
  assert.strictEqual(state.reservations.traditionalTotal, 60_000);
  assert.strictEqual(state.limits.deferredWithdrawal.max, null);
  assert.strictEqual(state.limits.rothConversion.max, null);
  assert.strictEqual(state.limits.qcd.max, null);

  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.code, undefined);
  assert.strictEqual(result.totals.agi, 60_000);
  assert.ok(result.modeledFederalIncomeTax.selected > 0);

  const blocked = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 1,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(blocked.code, 'WITHDRAWAL_ACCOUNT_LIMIT_EXCEEDED');
  assert.ok(blocked.accountState.issues.some(issue => (
    issue.code === 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE'
  )));
});

test('known current-year RMD is enforced before tax and net-cash calculations', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  subject.household.spouse = null;
  subject.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
  ];
  const facts = {
    available: true,
    filingStatus: 'single',
    taxYear: 2026,
    wages: 50_000,
    socialSecurityBenefits: 0,
    otherIncome: 0,
  };
  const levers = {
    realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
    rothWithdrawal: 0, qcd: 0,
  };

  const result = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  assert.strictEqual(result.rmd.status, 'known');
  assert.ok(Math.abs(result.rmd.required - 10_000) < 0.01);
  assert.ok(Math.abs(result.rmd.satisfied - 10_000) < 0.01);
  assert.strictEqual(result.rmd.remaining, 0);
  assert.strictEqual(result.accountState.levers.deferredWithdrawal, 10_000);
  assert.strictEqual(result.accountState.limits.rothConversion.max, 255_000);
  assert.strictEqual(result.cash.grossWithdrawalCash, 10_000);
  assert.ok(result.modeledFederalIncomeTax.selected > result.modeledFederalIncomeTax.baseline);
});

test('a spouse IRA distribution does not satisfy or consume the client IRA RMD', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  subject.household.spouse = {
    currentAge: 70, retirementAge: 70, planEndAge: 92, birthYear: 1956,
  };
  subject.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  subject.income.other = [{
    typeId: 'ira_distribution', owner: 'spouse', amount: 10_000,
    startAge: 70, endAge: 70, taxablePct: 1,
  }];
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
  ];

  const facts = await householdIncome(subject, 2026);
  assert.deepStrictEqual(facts.iraDistributionsByOwner, { client: 0, spouse: 10_000 });
  assert.deepStrictEqual(facts.iraCashDistributionsByOwner, { client: 0, spouse: 10_000 });
  const state = await withdrawalAccountState(subject, {}, facts);
  assert.strictEqual(state.rmd.status, 'known');
  assert.strictEqual(state.rmd.owner, 'client');
  assert.strictEqual(state.rmd.satisfiedByFixedCash, 0);
  assert.strictEqual(state.limits.deferredWithdrawal.min, 10_000);
  assert.strictEqual(state.reservations.traditionalTotal, 0);
  assert.strictEqual(state.limits.rothConversion.max, 255_000);
});

test('dual-owner IRA RMDs flow through owner-safe limits, tax, and cash', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  subject.household.spouse = {
    currentAge: 75, retirementAge: 75, planEndAge: 95, birthYear: 1951,
  };
  subject.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  subject.income.other = [{
    typeId: 'ira_distribution', owner: 'spouse', amount: 5_000,
    startAge: 75, endAge: 75, taxablePct: 1,
  }];
  subject.savings.annual = 0;
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
    createAccount('traditional_ira', {
      owner: 'spouse', balance: 246_000, valuationDate: '2025-12-31',
    }),
  ];

  const facts = await householdIncome(subject, 2026);
  const levers = {
    realizedGain: 0,
    deferredWithdrawal: 0,
    rothConversion: 491_000,
    rothWithdrawal: 0,
    qcd: 0,
  };
  const result = await evaluateYear({
    plan: subject, taxYear: 2026, facts, levers,
  });

  assert.strictEqual(result.code, undefined);
  assert.strictEqual(result.rmd.status, 'known');
  assert.ok(Math.abs(result.rmd.required - 20_000) < 0.01);
  assert.strictEqual(result.rmd.satisfiedByFixedCash, 5_000);
  assert.strictEqual(result.rmd.byOwner.client.satisfiedByPlannerCash, 10_000);
  assert.strictEqual(result.rmd.byOwner.spouse.satisfiedByPlannerCash, 5_000);
  assert.strictEqual(result.accountState.levers.deferredWithdrawal, 15_000);
  assert.strictEqual(result.accountState.limits.rothConversion.max, 491_000);
  assert.strictEqual(result.cash.grossWithdrawalCash, 15_000);
  assert.ok(Number.isFinite(result.modeledFederalIncomeTax.incremental));
  assert.strictEqual(
    result.cash.netAfterIncrementalModeledFederalIncomeTax,
    result.cash.grossWithdrawalCash
      - result.cash.incrementalModeledFederalIncomeTax
  );
});

test('mixed IRA and employer-plan RMDs fail closed through the adapter', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  subject.household.spouse = {
    currentAge: 75, retirementAge: 75, planEndAge: 95, birthYear: 1951,
  };
  subject.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  subject.income.other = [{
    typeId: 'ira_distribution', owner: 'spouse', amount: 5_000,
    startAge: 75, endAge: 75, taxablePct: 1,
  }];
  subject.savings.annual = 0;
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 100_000, valuationDate: '2025-12-31',
    }),
    createAccount('401k', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
    createAccount('traditional_ira', {
      owner: 'spouse', balance: 246_000, valuationDate: '2025-12-31',
    }),
  ];

  const facts = await householdIncome(subject, 2026);
  assert.deepStrictEqual(facts.iraDistributionsByOwner, {
    client: 0, spouse: 5_000,
  });
  assert.deepStrictEqual(facts.iraCashDistributionsByOwner, {
    client: 0, spouse: 5_000,
  });

  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0,
      deferredWithdrawal: 10_000,
      rothConversion: 0,
      rothWithdrawal: 0,
      qcd: 0,
    },
  });

  assert.strictEqual(
    result.code,
    'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
  );
  assert.strictEqual(result.accountState.valid, true);
  assert.strictEqual(result.rmd.status, 'unavailable');
  assert.strictEqual(result.rmd.required, null);
  assert.strictEqual(
    result.rmd.byOwner.client.issue,
    'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
  );
  assert.strictEqual(result.rmd.byOwner.spouse.status, 'known');
  assert.strictEqual(result.rmd.byOwner.spouse.required, 10_000);
  assert.strictEqual(result.accountState.limits.rothConversion.max, null);
  assert.strictEqual(result.accountState.limits.rothConversion.available, false);
  assert.strictEqual(result.accountState.limits.deferredWithdrawal.max, 606_000);
  assert.strictEqual(result.accountState.limits.deferredWithdrawal.available, true);
  assert.strictEqual(result.cash.grossWithdrawalCash, 10_000);
  assert.strictEqual(result.cash.netAfterIncrementalModeledFederalIncomeTax, null);
  assert.strictEqual(result.modeledFederalIncomeTax.selected, null);
  assert.deepStrictEqual(result.thresholdTaxDollars, {
    ordinaryIncomeTax: null,
    preferentialIncomeTax: null,
    irmaaPremium: null,
    socialSecurityIncrementalModeledFederalIncomeTax: null,
  });
  assert.strictEqual(result.totals.netCash, null);
});

test('missing prior-year-end IRA balance leaves only the affected results blank', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.meta.planningAsOfYear = 2026;
  subject.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  subject.household.spouse = null;
  subject.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      available: true, filingStatus: 'single', taxYear: 2026,
      wages: 50_000, socialSecurityBenefits: 0, otherIncome: 0,
    },
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });

  assert.strictEqual(result.code, 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE');
  assert.strictEqual(result.rmd.status, 'unavailable');
  assert.strictEqual(result.rmd.required, null);
  assert.strictEqual(result.modeledFederalIncomeTax.selected, null);
  assert.strictEqual(result.totals.netCash, null);
  assert.strictEqual(result.accountState.limits.deferredWithdrawal.max, 265_000);
  assert.strictEqual(result.accountState.limits.rothConversion.max, null);
});

test('adapter exposes engine-approved dynamic account limits', async () => {
  const subject = structuredClone(plan);
  subject.portfolio.accounts.traditional.balance = 100_000;
  subject.portfolio.extraAccounts = [];
  const state = await withdrawalAccountState(subject, {
    deferredWithdrawal: 30_000,
    rothConversion: 60_000,
    qcd: 0,
  });
  assert.equal(state.limits.qcd.max, 10_000);
  assert.equal(state.limits.rothConversion.max, 70_000);
  assert.equal(state.limits.deferredWithdrawal.max, 40_000);
});

test('adapter approves one changed lever against the shared account pool', async () => {
  const subject = structuredClone(plan);
  subject.portfolio.accounts.traditional.balance = 100_000;
  subject.portfolio.extraAccounts = [];
  const approval = await approveWithdrawalPlannerLeverChange(subject, {
    rothConversion: 60_000,
    deferredWithdrawal: 0,
    qcd: 0,
  }, 'deferredWithdrawal', 60_000);
  assert.strictEqual(approval.approved, true);
  assert.strictEqual(approval.approvedValue, 40_000);
  assert.strictEqual(approval.state.pools.traditional.remaining, 0);
});

test('missing legacy basis metadata cannot disable funded Planner controls', async () => {
  for (const basisVariant of ['missing', 'null']) {
    const subject = structuredClone(plan);
    subject.meta.filingStatus = 'single';
    subject.household.spouse = null;
    subject.portfolio.accounts = {
      taxable: { balance: 200_000, basisPct: 1 },
      traditional: { balance: 100_000 },
      roth: { balance: 80_000 },
    };
    if (basisVariant === 'missing') {
      delete subject.portfolio.accounts.taxable.basisPct;
    } else {
      subject.portfolio.accounts.taxable.basisPct = null;
    }
    const brokerage = createAccount('joint_brokerage', { balance: 50_000 });
    subject.portfolio.extraAccounts = [brokerage];
    const hadBasisPct = Object.hasOwn(subject.portfolio.accounts.taxable, 'basisPct');
    const savedBasisPct = subject.portfolio.accounts.taxable.basisPct;

    const income = await householdIncome(subject, 2026, { baseYear: 2026 });
    const state = await withdrawalAccountState(subject);
    const result = await evaluateYear({
      plan: subject,
      taxYear: 2026,
      facts: {
        filingStatus: 'single', livedWithSpouse: false,
        wages: 50_000, socialSecurityBenefits: 0, otherIncome: 0,
      },
      levers: {
        realizedGain: 100_000, deferredWithdrawal: 0, rothConversion: 0,
        rothWithdrawal: 0, qcd: 0,
      },
    });

    assert.notEqual(income.available, false, basisVariant);
    assert.equal(state.valid, true, basisVariant);
    assert.equal(state.limits.realizedGain.max, 250_000, basisVariant);
    assert.equal(state.limits.deferredWithdrawal.max, 100_000, basisVariant);
    assert.equal(state.limits.rothConversion.max, 100_000, basisVariant);
    assert.equal(state.limits.qcd.max, 100_000, basisVariant);
    assert.equal(state.limits.rothWithdrawal.max, 80_000, basisVariant);
    assert.equal(result.ltcg.gains, 100_000, basisVariant);
    assert.equal(result.modeledFederalIncomeTax.selected, 16_487.50, basisVariant);
    assert.deepEqual(result.accountState.pools.taxable, {
      available: 250_000,
      used: 0,
      remaining: 250_000,
    }, basisVariant);
    assert.equal(
      Object.hasOwn(subject.portfolio.accounts.taxable, 'basisPct'),
      hadBasisPct,
      basisVariant,
    );
    assert.equal(
      subject.portfolio.accounts.taxable.basisPct,
      savedBasisPct,
      basisVariant,
    );
  }
});

test('householdIncome returns person-specific focus-year ages and survivor status', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  subject.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 64 };
  subject.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 24_000, claimAge: 63 },
  };
  const baseYear = 2026;
  const current = await householdIncome(subject, baseYear, { baseYear });
  const terminal = await householdIncome(subject, baseYear + 1, { baseYear });
  const survivor = await householdIncome(subject, baseYear + 2, { baseYear });
  assert.deepEqual(current.ages, { client: 65, spouse: 63 });
  assert.ok(current.socialSecurityBenefits > 0);
  assert.equal(current.filingStatus, 'marriedFilingJointly');
  assert.deepEqual(terminal.ages, { client: 66, spouse: 64 });
  assert.ok(terminal.socialSecurityBenefits > 0);
  assert.equal(terminal.filingStatus, 'marriedFilingJointly');
  assert.deepEqual(survivor.ages, { client: 67, spouse: 65 });
  assert.equal(survivor.socialSecurityBenefits, 0);
  assert.equal(survivor.filingStatus, 'single');
  assert.equal(survivor.survivingOwner, 'client');
});

test('missing terminal age keeps current-year tax available but leaves future status unknown', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  subject.household.spouse = { currentAge: 63, retirementAge: 63 };
  subject.income.socialSecurity = { primary: null, spouse: null };
  subject.income.other = [];

  const current = await householdIncome(subject, 2026, { baseYear: 2026 });
  assert.strictEqual(current.available, true);
  assert.strictEqual(current.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(current.people.spouse.alive, true);
  const currentTax = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: current,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(typeof currentTax.modeledFederalIncomeTax.selected, 'number');

  const future = await householdIncome(subject, 2027, { baseYear: 2026 });
  assert.strictEqual(future.available, false);
  assert.strictEqual(future.filingStatus, null);
  assert.strictEqual(future.people.spouse.alive, null);
});

test('prior-year household income is unavailable instead of reverse-projected', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.primary = { currentAge: 60, retirementAge: 65, planEndAge: 90 };
  subject.household.spouse = null;
  subject.income.socialSecurity = { primary: null, spouse: null };
  subject.income.other = [{
    typeId: 'wages', owner: 'client', amount: 100_000,
    startAge: 60, endAge: 64, taxablePct: 1,
  }];
  subject.portfolio.extraAccounts = [];

  const facts = await householdIncome(subject, 2025, { baseYear: 2026 });
  assert.strictEqual(facts.available, false);
  assert.strictEqual(facts.filingStatus, 'single');
  assert.strictEqual(facts.otherIncome, null);

  const result = await evaluateYear({
    plan: subject,
    taxYear: 2025,
    facts,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.code, 'HOUSEHOLD_INCOME_UNAVAILABLE');
  assert.strictEqual(result.modeledFederalIncomeTax.selected, null);
});

test('household income advances from the saved planning as-of year', async () => {
  const subject = structuredClone(plan);
  subject.meta.planningAsOfYear = 2025;
  subject.meta.filingStatus = 'single';
  subject.household.primary = { currentAge: 65, retirementAge: 67, planEndAge: 90 };
  subject.household.spouse = null;
  subject.income.socialSecurity = { primary: null, spouse: null };
  subject.income.other = [{
    typeId: 'wages', owner: 'client', amount: 100_000,
    startAge: 65, endAge: 66, taxablePct: 1,
  }];
  subject.portfolio.extraAccounts = [];

  const facts = await householdIncome(subject, 2026);
  assert.strictEqual(facts.age, 66);
  assert.deepStrictEqual(facts.ages, { client: 66 });
  assert.strictEqual(facts.wages, 100_000);
});

test('Tax wages override the matching current return while Income wages own future years', async () => {
  let subject = createBlankHousehold(plan, 'hh_member_wages', 2026);
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'family',
    action: 'add-spouse',
  });
  subject.household.primary.currentAge = 60;
  subject.household.primary.retirementAge = 62;
  subject.household.primary.planEndAge = 95;
  subject.household.spouse.currentAge = 58;
  subject.household.spouse.retirementAge = 61;
  subject.household.spouse.planEndAge = 97;
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', action: 'add-income-source', typeId: 'wages', owner: 'client',
  });
  const clientRowId = subject.income.other.at(-1).id;
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'source.amount', rowId: clientRowId, value: 81_000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', action: 'add-income-source', typeId: 'wages', owner: 'spouse',
  });
  const spouseRowId = subject.income.other.at(-1).id;
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'source.amount', rowId: spouseRowId, value: 39_000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax', action: 'set', field: 'income.wages.client', value: 600_000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax', action: 'set', field: 'income.wages.spouse', value: 399_999,
  });
  subject.incomeTax.current1040.income.wages = 999_999;

  const current = await householdIncome(subject, 2026, { baseYear: 2026 });
  const clientRetired = await householdIncome(subject, 2028, { baseYear: 2026 });
  const bothRetired = await householdIncome(subject, 2029, { baseYear: 2026 });

  assert.strictEqual(current.wages, 999_999);
  assert.strictEqual(current.people.client.retired, false);
  assert.strictEqual(current.people.spouse.retired, false);
  assert.strictEqual(clientRetired.wages, 39_000);
  assert.strictEqual(clientRetired.people.client.retired, true);
  assert.strictEqual(clientRetired.people.spouse.retired, false);
  assert.strictEqual(bothRetired.wages, 0);
  assert.strictEqual(bothRetired.people.client.retired, true);
  assert.strictEqual(bothRetired.people.spouse.retired, true);
});

test('Tax-only wages remain unavailable to planning until Income supplies them', async () => {
  let subject = createBlankHousehold(plan, 'hh_tax_only_wages', 2026);
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax', action: 'set', field: 'income.wages.client', value: 50_000,
  });

  let planningFacts = householdIncomeAtYear(resolveInputs(subject, {}), 0);
  assert.strictEqual(planningFacts.wages, null);
  assert.ok(planningFacts.incomeIssues.includes('INCOME_SOURCE_MISSING:client:wages'));

  const currentTaxFacts = await householdIncome(subject, 2026, { baseYear: 2026 });
  assert.strictEqual(currentTaxFacts.wages, 50_000);

  const futureFacts = await householdIncome(subject, 2027, { baseYear: 2026 });
  assert.strictEqual(futureFacts.wages, null);

  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', action: 'add-income-source', typeId: 'wages', owner: 'client',
  });
  const rowId = subject.income.other.at(-1).id;
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'source.amount', rowId, value: 50_000,
  });

  planningFacts = householdIncomeAtYear(resolveInputs(subject, {}), 0);
  assert.strictEqual(planningFacts.wages, 50_000);
  assert.ok(!planningFacts.incomeIssues.includes('INCOME_SOURCE_MISSING:client:wages'));

  const currentFacts = await householdIncome(subject, 2026, { baseYear: 2026 });
  assert.strictEqual(currentFacts.wages, 50_000);
});

test('live household people facts reject an incompatible filing-status override', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.household.primary = { currentAge: 60, retirementAge: 65, planEndAge: 90 };
  subject.household.spouse = { currentAge: 58, retirementAge: 65, planEndAge: 58 };
  subject.income.socialSecurity = { primary: null, spouse: null };
  subject.income.other = [
    {
      typeId: 'wages', owner: 'client', amount: 100_000,
      startAge: 60, endAge: 64, taxablePct: 1,
    },
    {
      typeId: 'wages', owner: 'spouse', amount: 80_000,
      startAge: 58, endAge: 64, taxablePct: 1,
    },
  ];
  subject.portfolio.extraAccounts = [];

  const householdFacts = await householdIncome(subject, 2026, { baseYear: 2026 });
  assert.strictEqual(householdFacts.available, true);
  assert.strictEqual(householdFacts.people.client.alive, true);
  assert.strictEqual(householdFacts.people.spouse.alive, true);

  for (const filingStatus of ['single', 'headOfHousehold']) {
    const result = await evaluateYear({
      plan: subject,
      taxYear: 2026,
      facts: { ...householdFacts, filingStatus },
      levers: {
        realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
        rothWithdrawal: 0, qcd: 0,
      },
    });
    assert.strictEqual(result.code, 'FILING_STATUS_HOUSEHOLD_MISMATCH');
    assert.strictEqual(result.modeledFederalIncomeTax.selected, null);
    assert.ok(result.comparisonIssues.some(issue => (
      issue.code === 'FILING_STATUS_HOUSEHOLD_MISMATCH'
    )));
  }

  const survivorFacts = await householdIncome(subject, 2026, { baseYear: 2025 });
  assert.strictEqual(survivorFacts.available, true);
  assert.strictEqual(survivorFacts.people.client.alive, true);
  assert.strictEqual(survivorFacts.people.spouse.alive, false);
  for (const filingStatus of ['marriedFilingJointly', 'marriedFilingSeparately']) {
    const result = await evaluateYear({
      plan: subject,
      taxYear: 2026,
      facts: { ...survivorFacts, filingStatus },
      levers: {
        realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
        rothWithdrawal: 0, qcd: 0,
      },
    });
    assert.strictEqual(result.code, 'FILING_STATUS_HOUSEHOLD_MISMATCH');
    assert.strictEqual(result.modeledFederalIncomeTax.selected, null);
  }
});

test('confirmed person birth dates reach the tax engine age deduction', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.accounts.traditional.balance = 1_000_000;
  subject.portfolio.extraAccounts = [];
  subject.taxProfiles = subject.taxProfiles || {};
  subject.taxProfiles.client = subject.taxProfiles.client || {};
  const facts = {
    filingStatus: 'single', livedWithSpouse: false,
    socialSecurityBenefits: 0, wages: 50_000, otherIncome: 0,
  };
  const levers = {
    realizedGain: 0, deferredWithdrawal: 100_000,
    rothConversion: 0, rothWithdrawal: 0, qcd: 0,
  };

  subject.taxProfiles.client.birthDate = {
    value: '1960-01-01', status: 'confirmed', source: 'household-entry', confirmedAt: '2026-01-01T00:00:00.000Z',
  };
  const senior = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  subject.taxProfiles.client.birthDate.value = '1980-01-01';
  const younger = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  assert.ok(senior.modeledFederalIncomeTax.selected < younger.modeledFederalIncomeTax.selected);
});

test('planning income keeps wages, interest, dividends, pension, and taxable other income distinct', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  subject.household.spouse = null;
  subject.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  subject.income.other = [
    { typeId: 'wages', owner: 'client', amount: 50_000, startAge: 65, endAge: 65, taxablePct: 1 },
    { typeId: 'interest', owner: 'client', amount: 10_000, startAge: 65, endAge: 65, taxablePct: 1 },
    { typeId: 'dividends', owner: 'client', amount: 20_000, startAge: 65, endAge: 65, taxablePct: 1, qualifiedPct: 0.5 },
    { typeId: 'pension', owner: 'client', amount: 12_000, startAge: 65, endAge: 65, taxablePct: 0.5 },
    { typeId: 'other', owner: 'client', amount: 10_000, startAge: 65, endAge: 65, taxablePct: 0.5 },
  ];
  subject.income.pension = {
    benefitByAge: { 65: 8_000 }, base: 0, startAge: 65, colaPct: 0,
  };
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [];

  const facts = await householdIncome(subject, 2026, { baseYear: 2026 });
  assert.deepEqual({
    wages: facts.wages,
    taxableInterest: facts.taxableInterest,
    taxExemptInterest: facts.taxExemptInterest,
    ordinaryDividends: facts.ordinaryDividends,
    qualifiedDividends: facts.qualifiedDividends,
    pensionAmount: facts.pensionAmount,
    taxablePensions: facts.taxablePensions,
    otherIncome: facts.otherIncome,
    grossOtherIncome: facts.grossOtherIncome,
  }, {
    wages: 50_000,
    taxableInterest: 10_000,
    taxExemptInterest: undefined,
    ordinaryDividends: 20_000,
    qualifiedDividends: 10_000,
    pensionAmount: 20_000,
    taxablePensions: 14_000,
    otherIncome: 5_000,
    grossOtherIncome: 60_000,
  });
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.totals.agi, 99_000);
  assert.strictEqual(result.totals.qualifiedIncome, 10_000);
});

test('typed Social Security stays out of ordinary income and produces zero federal tax when it is the only income', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  subject.household.spouse = null;
  subject.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: null,
  };
  subject.income.other = [{
    typeId: 'social_security', owner: 'client', amount: 30_000,
    startAge: 65, endAge: 65,
  }];
  subject.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [];

  const facts = await householdIncome(subject, 2026, { baseYear: 2026 });
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  const ordinaryControl = runEngineYearTax({
    filingStatus: 'single',
    taxYear: 2026,
    income: { otherIncome: 30_000 },
    deductions: { useStandard: true },
  }, buildDefaultTaxContext({ taxYear: 2026, scenarioId: 'typed-ss-ordinary-control' }));

  assert.strictEqual(facts.available, true);
  assert.strictEqual(facts.socialSecurityBenefits, 30_000);
  assert.strictEqual(facts.otherIncome, 0);
  assert.strictEqual(facts.taxableOtherIncome, 0);
  assert.strictEqual(result.totals.ordinaryIncome, 0);
  assert.strictEqual(result.totals.agi, 0);
  assert.strictEqual(result.modeledFederalIncomeTax.selected, 0);
  assert.ok(ordinaryControl.annual1040Result.lines.line24.value > 0);
});

test('typed qualified dividends and signed long-term gains match the direct tax engine without ordinary-income flattening', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  subject.household.spouse = null;
  subject.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: null,
  };
  subject.income.other = [
    {
      typeId: 'dividends', owner: 'client', amount: 100_000,
      startAge: 65, endAge: 65, taxablePct: 1, qualifiedPct: 1,
    },
    {
      typeId: 'long_term_capital_gain', owner: 'client', amount: -10_000,
      startAge: 65, endAge: 65,
    },
  ];
  subject.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  subject.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  subject.portfolio.extraAccounts = [];

  const facts = await householdIncome(subject, 2026, { baseYear: 2026 });
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts,
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  const context = buildDefaultTaxContext({
    taxYear: 2026,
    scenarioId: 'typed-qualified-dividends-direct',
  });
  const direct = runEngineYearTax({
    filingStatus: 'single',
    taxYear: 2026,
    income: {
      ordinaryDividends: 100_000,
      qualifiedDividends: 100_000,
    },
    scheduleD: {
      mode: 'manual-net-long-term',
      netLongTermGainOrLoss: -10_000,
    },
    deductions: { useStandard: true },
  }, context);
  const ordinaryControl = runEngineYearTax({
    filingStatus: 'single',
    taxYear: 2026,
    income: { otherIncome: 90_000 },
    deductions: { useStandard: true },
  }, context);

  assert.strictEqual(facts.ordinaryDividends, 100_000);
  assert.strictEqual(facts.qualifiedDividends, 100_000);
  assert.strictEqual(facts.capitalGain, -10_000);
  assert.strictEqual(facts.otherIncome, 0);
  assert.strictEqual(result.totals.ordinaryIncome, 0);
  assert.strictEqual(result.totals.qualifiedIncome, 80_900);
  assert.strictEqual(result.totals.agi, 97_000);
  assert.strictEqual(result.modeledFederalIncomeTax.selected, 4_717.50);
  assert.strictEqual(
    result.modeledFederalIncomeTax.selected,
    direct.annual1040Result.lines.line24.value
  );
  assert.strictEqual(result.totals.agi, direct.annual1040Result.lines.line11.value);
  assert.ok(
    result.modeledFederalIncomeTax.selected
      < ordinaryControl.annual1040Result.lines.line24.value
  );
});

test('Withdrawal Planner honors a supplied itemized deduction instead of forcing standard', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.accounts.traditional.balance = 1_000_000;
  subject.portfolio.extraAccounts = [];
  subject.incomeTax.current1040 = {
    taxYear: 2026,
    returnScope: { modeledTaxpayer: 'client' },
    deductions: { method: 'standard', source: 'calculated' },
  };
  const facts = {
    filingStatus: 'single', socialSecurityBenefits: 0,
    wages: 50_000, otherIncome: 0,
  };
  const levers = {
    realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
    rothWithdrawal: 0, qcd: 0,
  };
  const standard = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  subject.incomeTax.current1040.deductions = {
    method: 'itemized', source: 'supplied-line12e', line12e: 40_000,
  };
  const supplied = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  assert.strictEqual(standard.modeledFederalIncomeTax.selected, 3_820);
  assert.strictEqual(supplied.modeledFederalIncomeTax.selected, 1_000);
  assert.strictEqual(supplied.deductionCoverage.source, 'household-current-1040');
});

test('partial MFJ birth dates calculate base tax and disclose the missing age adjustment', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.household.spouse = { currentAge: 64, retirementAge: 65, planEndAge: 95 };
  subject.portfolio.accounts.traditional.balance = 1_000_000;
  subject.portfolio.extraAccounts = [];
  subject.taxProfiles = subject.taxProfiles || {};
  subject.taxProfiles.client = subject.taxProfiles.client || {};
  subject.taxProfiles.spouse = subject.taxProfiles.spouse || {};
  subject.taxProfiles.client.birthDate = {
    value: '1950-01-01', status: 'confirmed', source: 'household-entry',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      filingStatus: 'marriedFilingJointly', socialSecurityBenefits: 0,
      wages: 100_000, otherIncome: 0,
    },
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(typeof result.modeledFederalIncomeTax.selected, 'number');
  assert.strictEqual(result.deductionCoverage.complete, false);
  assert.deepEqual(result.deductionCoverage.missingBirthDateOwners, ['spouse']);
  assert.strictEqual(result.deductionCoverage.appliedScope, 'base-only');
});

test('a spouse survivor uses the spouse birth date for age-aware tax', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  subject.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 90 };
  subject.portfolio.accounts.traditional.balance = 1_000_000;
  subject.portfolio.extraAccounts = [];
  subject.taxProfiles = subject.taxProfiles || {};
  subject.taxProfiles.client = subject.taxProfiles.client || {};
  subject.taxProfiles.spouse = subject.taxProfiles.spouse || {};
  subject.taxProfiles.client.birthDate = {
    value: '1980-01-01', status: 'confirmed', source: 'household-entry',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  };
  subject.taxProfiles.spouse.birthDate = {
    value: '1960-01-01', status: 'confirmed', source: 'household-entry',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  };
  const facts = {
    ...await householdIncome(subject, 2026, { baseYear: 2025 }),
    wages: 50_000,
  };
  const levers = {
    realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
    rothWithdrawal: 0, qcd: 0,
  };
  const seniorSpouse = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  subject.taxProfiles.spouse.birthDate.value = '1980-01-01';
  const youngerSpouse = await evaluateYear({ plan: subject, taxYear: 2026, facts, levers });
  assert.strictEqual(facts.filingStatus, 'single');
  assert.strictEqual(facts.survivingOwner, 'spouse');
  assert.ok(
    seniorSpouse.modeledFederalIncomeTax.selected
      < youngerSpouse.modeledFederalIncomeTax.selected
  );
});

test('missing MFS living-status facts do not silently assume spouses lived apart', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingSeparately';
  subject.household.spouse = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      filingStatus: 'marriedFilingSeparately', socialSecurityBenefits: 30_000,
      wages: 20_000, otherIncome: 0,
    },
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.modeledFederalIncomeTax.selected, null);
  assert.strictEqual(result.code, 'MFS_RETURN_TAXPAYER_UNATTRIBUTED');
  assert.ok(result.comparisonIssues.some(issue => issue.code === 'MFS_RETURN_TAXPAYER_UNATTRIBUTED'));
});

test('unavailable household income stays blank while account limits and gross cash remain available', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.accounts.traditional.balance = 100_000;
  subject.portfolio.extraAccounts = [];
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: {
      available: false,
      filingStatus: 'single',
      wages: null,
      socialSecurityBenefits: null,
      otherIncome: null,
    },
    levers: {
      realizedGain: 0, deferredWithdrawal: 10_000, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.code, 'HOUSEHOLD_INCOME_UNAVAILABLE');
  assert.strictEqual(result.modeledFederalIncomeTax.selected, null);
  assert.strictEqual(result.totals.agi, null);
  assert.strictEqual(result.cash.grossWithdrawalCash, 10_000);
  assert.strictEqual(result.cash.netAfterIncrementalModeledFederalIncomeTax, null);
  assert.strictEqual(result.accountState.limits.deferredWithdrawal.max, 100_000);
});

test('fixed IRA and pension income require an explicit taxable portion but preserve explicit zero', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.extraAccounts = [];
  const levers = {
    realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
    rothWithdrawal: 0, qcd: 0,
  };

  const missingPension = await evaluateYear({
    plan: subject, taxYear: 2026,
    facts: { filingStatus: 'single', pensionAmount: 100_000, wages: 0 },
    levers,
  });
  assert.strictEqual(missingPension.code, 'TAXABLE_PENSION_PORTION_MISSING');
  assert.strictEqual(missingPension.modeledFederalIncomeTax.selected, null);

  const zeroPension = await evaluateYear({
    plan: subject, taxYear: 2026,
    facts: {
      filingStatus: 'single', pensionAmount: 100_000,
      taxablePensions: 0, wages: 0,
    },
    levers,
  });
  assert.strictEqual(zeroPension.totals.agi, 0);
  assert.strictEqual(zeroPension.modeledFederalIncomeTax.selected, 0);

  const missingIra = await evaluateYear({
    plan: subject, taxYear: 2026,
    facts: { filingStatus: 'single', iraDistributions: 100_000, wages: 0 },
    levers,
  });
  assert.strictEqual(missingIra.code, 'TAXABLE_IRA_PORTION_MISSING');

  const zeroIra = await evaluateYear({
    plan: subject, taxYear: 2026,
    facts: {
      filingStatus: 'single', iraDistributions: 100_000,
      taxableIra: 0, wages: 0,
    },
    levers,
  });
  assert.strictEqual(zeroIra.totals.agi, 0);
  assert.strictEqual(zeroIra.modeledFederalIncomeTax.selected, 0);
});

test('current-return deductions are not reused after the return identity changes', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.household.spouse = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  subject.portfolio.extraAccounts = [];
  subject.incomeTax.current1040 = {
    taxYear: 2026,
    returnScope: { modeledTaxpayer: 'jointReturn' },
    deductions: {
      method: 'itemized', source: 'supplied-line12e', line12e: 40_000,
    },
  };
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: { filingStatus: 'single', wages: 50_000, socialSecurityBenefits: 0 },
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.modeledFederalIncomeTax.selected, 3_820);
  assert.strictEqual(result.deductionCoverage.source, 'planner-standard-default');
  assert.ok(result.deductionCoverage.issues.some(issue => (
    issue.code === 'CURRENT_1040_DEDUCTION_IDENTITY_MISMATCH'
  )));
});

test('standard deduction reconstruction keeps compatible QBI, Schedule 1-A, and pass-through facts', async () => {
  const subject = structuredClone(plan);
  subject.meta.filingStatus = 'single';
  subject.household.spouse = null;
  subject.portfolio.extraAccounts = [];
  subject.incomeTax.current1040 = {
    taxYear: 2026,
    returnScope: { modeledTaxpayer: 'client' },
    deductions: {
      method: 'standard', source: 'calculated',
      qbi: 10_000,
      schedule1A: { mode: 'supplied-line13b', amount: 6_000 },
    },
    passThrough: { line23: 1_000 },
  };
  const result = await evaluateYear({
    plan: subject,
    taxYear: 2026,
    facts: { filingStatus: 'single', wages: 50_000, socialSecurityBenefits: 0 },
    levers: {
      realizedGain: 0, deferredWithdrawal: 0, rothConversion: 0,
      rothWithdrawal: 0, qcd: 0,
    },
  });
  assert.strictEqual(result.totals.taxableIncome, 17_900);
  assert.strictEqual(result.modeledFederalIncomeTax.selected, 2_900);
  assert.deepStrictEqual(result.comparisonIssues, []);
});

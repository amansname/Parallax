import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurrent1040Intake,
  hasCurrent1040PlanningEnvelope,
} from './buildCurrent1040Intake.js';

const confirmations = {
  shortTermNetIsZero: true,
  noCapitalLossCarryovers: true,
  line18NotApplicable: true,
  line19NotApplicable: true,
  form4952Line4gIsZeroOrNotApplicable: true,
};

function canonicalEnvelope(overrides = {}){
  return {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    returnScope: { modeledTaxpayer: 'client' },
    taxpayers: { client: {} },
    adjustments: { mode: 'supplied-line10', amount: 0 },
    scheduleD: { mode: 'supplied-form1040-line7', amount: 0 },
    deductions: {
      method: 'standard',
      source: 'supplied-line12e',
      line12e: 15750,
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
    ...overrides,
  };
}

function plan(overrides = {}){
  return {
    meta: { filingStatus: 'single' },
    household: {
      primary: { currentAge: 50, retirementAge: 65 },
      spouse: null,
    },
    income: {
      other: [
        {
          typeId: 'wages',
          owner: 'client',
          amount: 75000,
          startAge: 50,
          endAge: 64,
        },
      ],
      socialSecurity: { primary: { pia: 0, claimAge: 67 }, spouse: null },
    },
    incomeTax: {
      current1040: canonicalEnvelope(),
      adjustments: [],
      deductions: [],
      credits: [],
    },
    ...overrides,
  };
}

const codes = result => result.gaps.map(gap => gap.code);

test('canonical planning route is opt-in and keeps an explicit supported year', () => {
  const legacy = plan();
  delete legacy.incomeTax.current1040;
  assert.equal(hasCurrent1040PlanningEnvelope(legacy), false);

  const subject = plan();
  assert.equal(hasCurrent1040PlanningEnvelope(subject), true);
  const result = buildCurrent1040Intake(subject);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.intake.schemaVersion, 1);
  assert.equal(result.intake.taxYear, 2026);
  assert.equal(result.intake.income.wages, 75000);
  assert.equal(result.intake.income.taxableSS, 0);
  assert.deepEqual(result.intake.income.socialSecurity, {
    mode: 'supplied-form1040-lines',
  });
  assert.deepEqual(result.intake.scheduleD, {
    mode: 'supplied-form1040-line7',
    amount: 0,
  });

  subject.incomeTax.current1040.taxYear = 2025;
  assert.equal(buildCurrent1040Intake(subject).intake.taxYear, 2025);

  delete subject.incomeTax.current1040.taxYear;
  assert.ok(codes(buildCurrent1040Intake(subject))
    .includes('CURRENT_1040_TAX_YEAR_REQUIRED'));
});

test('explicit deduction authority and zero-valued supplied facts survive unchanged', () => {
  const subject = plan();
  subject.incomeTax.current1040.deductions = {
    method: 'itemized',
    source: 'supplied-line12e',
    line12e: 0,
    qbi: 0,
    schedule1A: { mode: 'supplied-line13b', amount: 0 },
  };
  subject.incomeTax.current1040.passThrough = {
    line17: 0,
    line19: 0,
    line20: 0,
    line23: 0,
  };
  const { intake, gaps } = buildCurrent1040Intake(subject);
  assert.deepEqual(gaps, []);
  assert.deepEqual(intake.deductions, subject.incomeTax.current1040.deductions);
  assert.deepEqual(intake.passThrough, subject.incomeTax.current1040.passThrough);
  assert.ok(Object.hasOwn(intake.deductions, 'line12e'));
  assert.ok(Object.hasOwn(intake.deductions, 'qbi'));
  for(const lineId of ['line17', 'line19', 'line20', 'line23']){
    assert.ok(Object.hasOwn(intake.passThrough, lineId));
  }
});

test('explicit canonical income survives and merges only non-overlapping planning fields', () => {
  const subject = plan();
  subject.incomeTax.current1040.income = {
    taxExemptInterest: 5000,
    socialSecurityBenefits: 20000,
    taxableSS: 5000,
    socialSecurity: { mode: 'supplied-form1040-lines' },
  };
  const result = buildCurrent1040Intake(subject);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.intake.income.wages, 75000);
  assert.equal(result.intake.income.taxExemptInterest, 5000);
  assert.equal(result.intake.income.socialSecurityBenefits, 20000);
  assert.equal(result.intake.income.taxableSS, 5000);
  assert.equal(result.intake.income.taxableInterest, 0);
  assert.equal(result.totalIncome, 80000);
});

test('same-field canonical and mapped income sources fail closed without precedence', () => {
  const wages = plan();
  wages.incomeTax.current1040.income = { wages: 75000 };
  const wageConflict = buildCurrent1040Intake(wages);
  assert.ok(codes(wageConflict)
    .includes('CURRENT_1040_INCOME_SOURCE_CONFLICT'));
  assert.ok(!Object.hasOwn(wageConflict.intake.income, 'wages'));
  assert.equal(wageConflict.totalIncome, null);

  const taxExempt = plan({
    income: {
      other: [{
        typeId: 'tax_exempt_interest',
        owner: 'client',
        amount: 5000,
        startAge: 50,
        endAge: 50,
      }],
      socialSecurity: { primary: { pia: 0, claimAge: 67 }, spouse: null },
    },
  });
  taxExempt.incomeTax.current1040.income = { taxExemptInterest: 5000 };
  const taxExemptConflict = buildCurrent1040Intake(taxExempt);
  assert.ok(codes(taxExemptConflict)
    .includes('CURRENT_1040_INCOME_SOURCE_CONFLICT'));
  assert.ok(!Object.hasOwn(
    taxExemptConflict.intake.income,
    'taxExemptInterest'
  ));
  assert.equal(taxExemptConflict.totalIncome, null);
});

test('complete canonical Social Security resolves active planning benefit sources', () => {
  const subject = plan({
    household: {
      primary: { currentAge: 70, retirementAge: 65 },
      spouse: null,
    },
    income: {
      other: [{
        typeId: 'social_security',
        owner: 'client',
        amount: 100000,
        startAge: 67,
        endAge: 999,
      }],
      socialSecurity: {
        primary: { pia: 100000, claimAge: 67 },
        spouse: null,
      },
    },
  });
  subject.incomeTax.current1040.income = {
    socialSecurityBenefits: 100000,
    taxableSS: 85000,
    socialSecurity: { mode: 'supplied-form1040-lines' },
  };
  const result = buildCurrent1040Intake(subject);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.intake.income.socialSecurityBenefits, 100000);
  assert.equal(result.intake.income.taxableSS, 85000);
  assert.equal(result.intake.income.wages, 0);
  assert.equal(result.totalIncome, 85000);
});

test('calculated MFS Social Security preserves true, false, and missing living status', () => {
  function subject(livedWithSpouse){
    const socialSecurity = {
      mode: 'calculate-taxable-benefits',
      otherIncome: 10000,
      excludedIncomeAddBacks: 0,
      adjustments: 0,
      ...(livedWithSpouse === undefined ? {} : { livedWithSpouse }),
    };
    return plan({
      meta: { filingStatus: 'marriedFilingSeparately' },
      household: {
        primary: { currentAge: 70, retirementAge: 65 },
        spouse: { currentAge: 69, retirementAge: 65 },
      },
      income: {
        other: [],
        socialSecurity: {
          primary: { pia: 10000, claimAge: 67 },
          spouse: { pia: 0, claimAge: 67 },
        },
      },
      incomeTax: {
        current1040: canonicalEnvelope({
          returnScope: {
            modeledTaxpayer: 'client',
            spouseItemizes: false,
          },
          taxpayers: { client: {}, spouse: {} },
          income: {
            wages: 10000,
            socialSecurityBenefits: 10000,
            taxExemptInterest: 0,
            socialSecurity,
          },
        }),
        adjustments: [],
        deductions: [],
        credits: [],
      },
    });
  }

  for(const livedWithSpouse of [true, false]){
    const result = buildCurrent1040Intake(subject(livedWithSpouse));
    assert.deepEqual(result.gaps, []);
    assert.strictEqual(
      result.intake.income.socialSecurity.livedWithSpouse,
      livedWithSpouse
    );
    assert.equal(
      result.totalIncome,
      null,
      'calculated taxable Social Security is unresolved until the tax rule runs'
    );
  }

  const missing = buildCurrent1040Intake(subject(undefined));
  assert.deepEqual(missing.gaps, []);
  assert.ok(!Object.hasOwn(
    missing.intake.income.socialSecurity,
    'livedWithSpouse'
  ));
});

test('MFS includes only the modeled owner and refuses joint or missing attribution', () => {
  const subject = plan({
    meta: { filingStatus: 'marriedFilingSeparately' },
    household: {
      primary: { currentAge: 50, retirementAge: 65 },
      spouse: { currentAge: 49, retirementAge: 65 },
    },
    income: {
      other: [
        { typeId: 'wages', owner: 'client', amount: 40000, startAge: 50, endAge: 64 },
        { typeId: 'wages', owner: 'spouse', amount: 90000, startAge: 49, endAge: 64 },
        { typeId: 'interest', owner: 'joint', amount: 1000, startAge: 50, endAge: 50 },
        { typeId: 'other', amount: 500, startAge: 50, endAge: 50 },
      ],
      socialSecurity: {
        primary: { pia: 0, claimAge: 67 },
        spouse: { pia: 0, claimAge: 67 },
      },
    },
    incomeTax: {
      current1040: canonicalEnvelope({
        returnScope: { modeledTaxpayer: 'client', spouseItemizes: false },
        taxpayers: { client: {}, spouse: {} },
      }),
      adjustments: [],
      deductions: [],
      credits: [],
    },
  });
  const result = buildCurrent1040Intake(subject);
  assert.equal(result.intake.income.wages, 40000);
  assert.ok(codes(result).includes('CURRENT_1040_MFS_JOINT_INCOME_UNATTRIBUTED'));
  assert.ok(codes(result).includes('CURRENT_1040_INCOME_OWNER_REQUIRED'));
  assert.ok(!Object.values(result.intake.income).includes(90000));

  subject.income.other = subject.income.other.slice(0, 2);
  const attributed = buildCurrent1040Intake(subject);
  assert.deepEqual(attributed.gaps, []);
  assert.equal(attributed.intake.income.wages, 40000);
  assert.equal(attributed.intake.income.otherIncome, 0);
  assert.equal(attributed.intake.income.taxableSS, 0);

  subject.incomeTax.current1040.returnScope.modeledTaxpayer = 'spouse';
  const spouseReturn = buildCurrent1040Intake(subject);
  assert.deepEqual(spouseReturn.gaps, []);
  assert.equal(spouseReturn.intake.income.wages, 90000);
  assert.equal(spouseReturn.intake.income.otherIncome, 0);
});

test('simple Schedule D derives and preserves a signed owned long-term result', () => {
  const subject = plan();
  subject.income.other = [
    {
      typeId: 'long_term_capital_gain',
      owner: 'client',
      amount: -5000,
      startAge: 50,
      endAge: 50,
    },
  ];
  subject.incomeTax.current1040.scheduleD = {
    mode: 'simple-net-long-term',
    confirmations,
  };
  const result = buildCurrent1040Intake(subject);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.intake.scheduleD.netLongTermGainOrLoss, -5000);
  assert.deepEqual(result.intake.scheduleD.confirmations, confirmations);
  assert.equal(result.totalIncome, null);

  subject.income.other.push({
    typeId: 'short_term_capital_gain',
    owner: 'client',
    amount: 1000,
    startAge: 50,
    endAge: 50,
  });
  assert.ok(codes(buildCurrent1040Intake(subject))
    .includes('CURRENT_1040_SIMPLE_SCHEDULE_D_SHORT_TERM_NOT_ZERO'));
});

test('manual long-term mode preserves blank, zero, signed rows, and source precedence', () => {
  const untouched = plan();
  delete untouched.incomeTax.current1040.scheduleD;
  const blank = buildCurrent1040Intake(untouched);
  assert.equal(Object.hasOwn(blank.intake, 'scheduleD'), false);
  assert.equal(blank.totalIncome, null);

  const storedBlank = plan();
  storedBlank.incomeTax.current1040.scheduleD = {
    mode: 'manual-net-long-term',
  };
  const missing = buildCurrent1040Intake(storedBlank);
  assert.ok(codes(missing).includes('CURRENT_1040_SCHEDULE_D_AMOUNT_REQUIRED'));
  assert.equal(missing.intake.scheduleD.mode, 'manual-net-long-term');
  assert.equal(
    Object.hasOwn(missing.intake.scheduleD, 'netLongTermGainOrLoss'),
    false
  );

  const malformed = plan();
  malformed.incomeTax.current1040.scheduleD = {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 5000,
    confirmations: {},
  };
  const rejected = buildCurrent1040Intake(malformed);
  assert.ok(codes(rejected).includes('CURRENT_1040_SCHEDULE_D_SOURCE_CONFLICT'));
  assert.equal(Object.hasOwn(rejected.intake.scheduleD, 'confirmations'), true);

  const directZero = plan();
  directZero.incomeTax.current1040.scheduleD = {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 0,
  };
  const zero = buildCurrent1040Intake(directZero);
  assert.deepEqual(zero.gaps, []);
  assert.deepEqual(zero.intake.scheduleD, {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 0,
  });
  assert.equal(zero.totalIncome, 75000);

  const directLoss = plan();
  directLoss.incomeTax.current1040.scheduleD = {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: -5000,
  };
  const loss = buildCurrent1040Intake(directLoss);
  assert.deepEqual(loss.gaps, []);
  assert.equal(loss.intake.scheduleD.netLongTermGainOrLoss, -5000);
  assert.equal(loss.totalIncome, null);

  const rowDerived = plan();
  rowDerived.income.other.push(
    {
      typeId: 'long_term_capital_gain',
      owner: 'client',
      amount: 2000,
      startAge: 50,
      endAge: 50,
    },
    {
      typeId: 'long_term_capital_gain',
      owner: 'client',
      amount: -500,
      startAge: 50,
      endAge: 50,
    }
  );
  rowDerived.incomeTax.current1040.scheduleD = {
    mode: 'manual-net-long-term',
  };
  const summed = buildCurrent1040Intake(rowDerived);
  assert.deepEqual(summed.gaps, []);
  assert.equal(summed.intake.scheduleD.netLongTermGainOrLoss, 1500);
  assert.equal(summed.totalIncome, 76500);

  rowDerived.incomeTax.current1040.scheduleD.netLongTermGainOrLoss = 0;
  assert.ok(codes(buildCurrent1040Intake(rowDerived))
    .includes('CURRENT_1040_SCHEDULE_D_SOURCE_CONFLICT'));

  const shortTerm = plan();
  shortTerm.income.other.push({
    typeId: 'short_term_capital_gain',
    owner: 'client',
    amount: 1,
    startAge: 50,
    endAge: 50,
  });
  shortTerm.incomeTax.current1040.scheduleD = {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: -5000,
  };
  const conflict = buildCurrent1040Intake(shortTerm);
  assert.ok(codes(conflict)
    .includes('CURRENT_1040_MANUAL_NET_LONG_TERM_SHORT_TERM_CONFLICT'));
  assert.equal(conflict.totalIncome, null);
});

test('Schedule D uses explicit completeness for zero but never merges competing sources', () => {
  const subject = plan();
  subject.income.other = [];
  subject.incomeTax.current1040.scheduleD = {
    mode: 'simple-net-long-term',
    confirmations,
  };
  assert.ok(codes(buildCurrent1040Intake(subject))
    .includes('CURRENT_1040_SCHEDULE_D_AMOUNT_REQUIRED'));

  subject.income.other = [{
    typeId: 'long_term_capital_gain',
    owner: 'client',
    amount: 0,
    startAge: 50,
    endAge: 50,
  }];
  subject.incomeTax.current1040.scheduleD.netLongTermGainOrLoss = 0;
  assert.ok(codes(buildCurrent1040Intake(subject))
    .includes('CURRENT_1040_SCHEDULE_D_SOURCE_CONFLICT'));

  subject.income.other = [];
  subject.incomeTax.current1040.scheduleD = {
    mode: 'supplied-form1040-line7',
    amount: 0,
  };
  const supplied = buildCurrent1040Intake(subject);
  assert.deepEqual(supplied.gaps, []);
  assert.ok(Object.hasOwn(supplied.intake.scheduleD, 'amount'));
  assert.equal(supplied.intake.scheduleD.amount, 0);

  subject.incomeTax.current1040.scheduleD.amount = 50000;
  const suppliedGain = buildCurrent1040Intake(subject);
  assert.deepEqual(suppliedGain.gaps, []);
  assert.equal(suppliedGain.totalIncome, 50000);
});

test('missing completeness and active planning Social Security produce clear gaps', () => {
  const subject = plan();
  delete subject.incomeTax.current1040.incomeSourcesComplete;
  subject.household.primary.currentAge = 70;
  subject.income.socialSecurity.primary = { pia: 30000, claimAge: 67 };
  const result = buildCurrent1040Intake(subject);
  assert.ok(codes(result).includes('CURRENT_1040_INCOME_SOURCES_INCOMPLETE'));
  assert.ok(codes(result)
    .includes('CURRENT_1040_SOCIAL_SECURITY_RETURN_FACTS_REQUIRED'));
  assert.equal(result.totalIncome, null);
});

test('a planning Social Security row cannot become generic other income', () => {
  const subject = plan();
  subject.income.other = [{
    typeId: 'social_security',
    owner: 'client',
    amount: 24000,
    startAge: 50,
    endAge: 999,
  }];
  const result = buildCurrent1040Intake(subject);
  assert.ok(codes(result)
    .includes('CURRENT_1040_SOCIAL_SECURITY_RETURN_FACTS_REQUIRED'));
  assert.equal(result.intake.income.otherIncome, undefined);
});

test('positive direct gross IRA and pension amounts never gain fabricated taxable companions', () => {
  const ira = plan();
  ira.income.other = [];
  ira.incomeTax.current1040.income = { iraDistributions: 20000 };
  const iraResult = buildCurrent1040Intake(ira);
  assert.ok(codes(iraResult).includes('CURRENT_1040_TAXABLE_IRA_REQUIRED'));
  assert.equal(Object.hasOwn(iraResult.intake.income, 'taxableIra'), false);
  assert.equal(iraResult.totalIncome, null);

  ira.incomeTax.current1040.income.taxableIra = 0;
  const explicitZero = buildCurrent1040Intake(ira);
  assert.equal(
    codes(explicitZero).includes('CURRENT_1040_TAXABLE_IRA_REQUIRED'),
    false,
  );
  assert.equal(explicitZero.intake.income.taxableIra, 0);

  const pension = plan();
  pension.income.other = [];
  pension.incomeTax.current1040.income = { pensionAmount: 15000 };
  const pensionResult = buildCurrent1040Intake(pension);
  assert.ok(codes(pensionResult)
    .includes('CURRENT_1040_TAXABLE_PENSION_REQUIRED'));
  assert.equal(
    Object.hasOwn(pensionResult.intake.income, 'taxablePensions'),
    false,
  );
  assert.equal(pensionResult.totalIncome, null);
});

test('planning income overrides suppress only the selected source group and stay outside canonical intake', () => {
  const subject = plan();
  subject.income.other.push({
    typeId: 'interest',
    owner: 'client',
    amount: 1000,
    taxablePct: 0.75,
    startAge: 50,
    endAge: 50,
  });
  subject.incomeTax.current1040.income = { wages: 81000 };
  subject.incomeTax.current1040.planningIncomeOverrides = ['wages'];

  const result = buildCurrent1040Intake(subject);

  assert.deepEqual(result.gaps, []);
  assert.equal(result.intake.income.wages, 81000);
  assert.equal(result.intake.income.taxableInterest, 750);
  assert.equal(result.intake.income.taxExemptInterest, 250);
  assert.equal(Object.hasOwn(result.intake, 'planningIncomeOverrides'), false);
});

test('planning income overrides fail closed when malformed and keep short-term blockers active', () => {
  const malformed = plan();
  malformed.incomeTax.current1040.planningIncomeOverrides = ['wages', 'wages'];
  assert.ok(codes(buildCurrent1040Intake(malformed))
    .includes('CURRENT_1040_INCOME_OVERRIDE_GROUP_INVALID'));

  const capital = plan();
  capital.income.other.push(
    {
      typeId: 'long_term_capital_gain',
      owner: 'client',
      amount: 5000,
      startAge: 50,
      endAge: 50,
    },
    {
      typeId: 'short_term_capital_gain',
      owner: 'client',
      amount: 1000,
      startAge: 50,
      endAge: 50,
    },
  );
  capital.incomeTax.current1040.planningIncomeOverrides = [
    'long-term-gain-loss',
  ];
  capital.incomeTax.current1040.scheduleD = {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 7000,
  };
  assert.ok(codes(buildCurrent1040Intake(capital))
    .includes('CURRENT_1040_MANUAL_NET_LONG_TERM_SHORT_TERM_CONFLICT'));
});

test('row-derived IRA gross and taxable amounts remain a complete paired source', () => {
  const subject = plan();
  subject.income.other = [{
    typeId: 'ira_distribution',
    owner: 'client',
    amount: 20000,
    taxablePct: 0.4,
    startAge: 50,
    endAge: 50,
  }];
  const result = buildCurrent1040Intake(subject);
  assert.equal(
    codes(result).includes('CURRENT_1040_TAXABLE_IRA_REQUIRED'),
    false,
  );
  assert.equal(result.intake.income.iraDistributions, 20000);
  assert.equal(result.intake.income.taxableIra, 8000);
});

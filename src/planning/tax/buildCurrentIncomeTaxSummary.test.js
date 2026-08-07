import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentIncomeTaxSummary } from './buildCurrentIncomeTaxSummary.js';

function plan(overrides = {}){
  return {
    meta: { filingStatus: 'single' },
    household: { primary: { birthYear: 1976, currentAge: 50, retirementAge: 65, planEndAge: 95 } },
    income: {
      other: [{ typeId:'wages', owner:'client', label:'Wages', amount:100000, startAge:50, endAge:64, realGrowth:0, taxablePct:1 }],
      socialSecurity: { primary: { pia:0, claimAge:67 } },
    },
    incomeTax: { adjustments: [], deductions: [] },
    ...overrides,
  };
}

function canonicalCurrent1040(overrides = {}){
  return {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    returnScope: { modeledTaxpayer: 'client' },
    taxpayers: { client: {} },
    adjustments: { mode: 'supplied-line10', amount: 0 },
    deductions: {
      method: 'itemized',
      source: 'supplied-line12e',
      line12e: 42000,
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
      line23: 0,
    },
    scheduleD: {
      mode: 'supplied-form1040-line7',
      amount: 0,
    },
    ...overrides,
  };
}

test('current wizard summary runs the federal engine for supported income', () => {
  const summary = buildCurrentIncomeTaxSummary(plan());
  assert.equal(summary.status, 'ready');
  assert.equal(summary.totalIncome, 100000);
  assert.ok(summary.adjustedGrossIncome > 0);
  assert.ok(summary.federalTaxLiability > 0);
  assert.ok(summary.ordinaryBracketRoom > 0);
  assert.equal(summary.rmdAge, 73);
  assert.equal(summary.firstRmdYear, 2049);
});

test('qualified dividends expose the audited capital-gains position', () => {
  const summary = buildCurrentIncomeTaxSummary(plan({
    income: {
      other: [{ typeId:'dividends', owner:'client', label:'Dividends', amount:30000, startAge:50, endAge:999, realGrowth:0, qualifiedPct:1 }],
      socialSecurity: { primary: { pia:0, claimAge:67 } },
    },
  }));
  assert.equal(summary.status, 'ready');
  assert.equal(summary.capitalGainsRate, 0);
  assert.ok(summary.capitalGainsRoom > 0);
  assert.match(summary.capitalGainsNote, /0% bracket/);
});

test('a working-only 401(k) contribution no longer reduces AGI after retirement', () => {
  const summary = buildCurrentIncomeTaxSummary(plan({
    household: { primary: { birthYear: 1956, currentAge: 70, retirementAge: 65, planEndAge: 95 } },
    income: {
      other: [{ typeId:'pension', owner:'client', label:'Pension', amount:60000, startAge:65, endAge:999, realGrowth:0, taxablePct:1 }],
      socialSecurity: { primary: { pia:0, claimAge:67 } },
    },
    incomeTax: {
      adjustments: [{ typeId:'401k', owner:'client', amount:23000, whileWorkingOnly:true }],
      deductions: [],
    },
  }));
  assert.equal(summary.status, 'ready');
  assert.equal(summary.adjustments, 0);
  assert.equal(summary.adjustedGrossIncome, 60000);
});

test('current-year federal items route through existing 1040 inputs and Premium Tax Credit reduces line 24', () => {
  const income = {
    other: [
      { typeId:'wages', owner:'client', label:'Wages', amount:100000, startAge:50, endAge:64, taxablePct:1 },
      { typeId:'tax_exempt_interest', owner:'joint', label:'Tax-exempt interest', amount:5000, startAge:50, endAge:50, taxablePct:0 },
      { typeId:'ira_distribution', owner:'client', label:'IRA distribution', amount:10000, startAge:50, endAge:50, taxablePct:.8 },
      { typeId:'roth_conversion', owner:'client', label:'Roth conversion', amount:20000, startAge:50, endAge:50, taxablePct:.9 },
      { typeId:'short_term_capital_gain', owner:'joint', label:'Short-term gain', amount:5000, startAge:50, endAge:50, taxablePct:1 },
      { typeId:'long_term_capital_gain', owner:'joint', label:'Long-term gain', amount:15000, startAge:50, endAge:50, taxablePct:0 },
    ],
    socialSecurity: { primary: { pia:0, claimAge:67 } },
  };
  const withoutCredit = buildCurrentIncomeTaxSummary(plan({ income }));
  const withCredit = buildCurrentIncomeTaxSummary(plan({
    income,
    incomeTax: {
      adjustments: [],
      deductions: [],
      credits: [{ typeId:'premium_tax_credit', amount:2000 }],
    },
  }));
  assert.equal(withCredit.status, 'ready');
  assert.equal(withCredit.totalIncome, 155000);
  assert.equal(withCredit.adjustedGrossIncome, 146000);
  assert.equal(withCredit.premiumTaxCredit, 2000);
  assert.equal(withoutCredit.federalTaxLiability - withCredit.federalTaxLiability, 2000);
  assert.equal(withCredit.capitalGainsRate, .15);
  assert.match(withCredit.capitalGainsNote, /0% bracket exceeded/);
});

test('deductible IRA and separate property taxes persist but fail closed without required federal facts', () => {
  const ira = buildCurrentIncomeTaxSummary(plan({
    incomeTax: {
      adjustments: [{ typeId:'ira_deduction', owner:'client', amount:7000 }],
      deductions: [],
      credits: [],
    },
  }));
  assert.equal(ira.status, 'needs_facts');
  assert.match(ira.message, /workplace-plan facts/);

  for(const typeId of ['real_estate_tax', 'personal_property_tax']){
    const propertyTax = buildCurrentIncomeTaxSummary(plan({
      incomeTax: {
        adjustments: [],
        deductions: [{ typeId, amount:5000 }],
        credits: [],
      },
    }));
    assert.equal(propertyTax.status, 'needs_facts');
    assert.match(propertyTax.message, /SALT.*cap rule/);
  }
});

test('active Social Security uses the taxable-benefits worksheet, including tax-exempt interest', () => {
  const summary = buildCurrentIncomeTaxSummary(plan({
    household: { primary: { currentAge: 70, retirementAge: 65, planEndAge: 95 } },
    income: {
      other: [{ typeId:'interest', owner:'client', label:'Municipal interest', amount:20000, startAge:50, endAge:999, realGrowth:0, taxablePct:0 }],
      socialSecurity: { primary: { pia:30000, claimAge:67 } },
    },
  }));
  assert.equal(summary.status, 'ready');
  assert.equal(summary.totalIncome, 50000);
  assert.ok(summary.adjustedGrossIncome > 0, 'tax-exempt interest should make part of Social Security taxable');
  assert.ok(summary.adjustedGrossIncome < summary.totalIncome);
});

test('legacy Social Security fallback uses the engine claim-age adjustment', () => {
  const summary = buildCurrentIncomeTaxSummary(plan({
    household: { primary: { currentAge: 70, retirementAge: 65, planEndAge: 95 } },
    income: {
      other: [],
      socialSecurity: { primary: { pia: 30000, claimAge: 62 } },
    },
  }));

  assert.equal(summary.status, 'ready');
  assert.equal(summary.totalIncome, 21000);
});

test('unsupported deduction and self-employment facts fail closed instead of fabricating tax', () => {
  const medical = buildCurrentIncomeTaxSummary(plan({
    incomeTax: { adjustments: [], deductions: [{ typeId:'medical', amount:5000 }] },
  }));
  assert.equal(medical.status, 'needs_facts');
  assert.match(medical.message, /AGI-floor/);
  assert.equal(medical.adjustedGrossIncome, undefined);

  const selfEmployment = buildCurrentIncomeTaxSummary(plan({
    income: {
      other: [{ typeId:'self_employment', owner:'client', label:'Consulting', amount:50000, startAge:50, endAge:64, realGrowth:0, taxablePct:1 }],
      socialSecurity: { primary: { pia:0, claimAge:67 } },
    },
  }));
  assert.equal(selfEmployment.status, 'needs_facts');
  assert.match(selfEmployment.message, /Schedule SE/);
  assert.equal(selfEmployment.federalTaxLiability, undefined);
});

test('explicit canonical route honors year, deduction source, and supplied total', () => {
  const subject = plan();
  subject.incomeTax.current1040 = canonicalCurrent1040({ taxYear: 2025 });
  const summary = buildCurrentIncomeTaxSummary(subject);
  assert.equal(summary.status, 'ready');
  assert.equal(summary.sourceMode, 'canonical-v1');
  assert.equal(summary.taxYear, 2025);
  assert.equal(summary.lawVersion, '2025_FINAL');
  assert.equal(summary.deductionMethod, 'Itemized');
  assert.equal(summary.deductionSource, 'supplied-line12e');
  assert.equal(summary.deductionUsed, 42000);
  assert.equal(summary.itemizedDeduction, 42000);
  assert.equal(summary.standardDeduction, null);
  assert.equal(summary.premiumTaxCredit, 0);
  assert.equal(summary.taxTotalScope, 'FULL_1040');
});

test('omitted optional Schedule D remains missing instead of becoming confirmed zero', () => {
  const subject = plan();
  const envelope = canonicalCurrent1040();
  delete envelope.scheduleD;
  subject.incomeTax.current1040 = envelope;

  const summary = buildCurrentIncomeTaxSummary(subject);

  assert.equal(summary.status, 'needs_facts');
  assert.equal(summary.taxTotalScope, 'NOT_CALCULABLE');
  assert.equal(summary.totalIncome, null);
  assert.ok(summary.unresolvedTaxableIncomeLines.includes('line9'));
  assert.ok(summary.reasonCodes.includes('CURRENT_1040_LINE9_DEFERRED'));
});

test('canonical supplied Social Security cannot become a false ready zero return', () => {
  const subject = plan({
    household: {
      primary: {
        birthYear: 1956,
        currentAge: 70,
        retirementAge: 65,
        planEndAge: 95,
      },
    },
    income: {
      other: [],
      socialSecurity: { primary: { pia: 100000, claimAge: 67 } },
    },
    incomeTax: {
      current1040: canonicalCurrent1040({
        income: {
          socialSecurityBenefits: 100000,
          taxableSS: 85000,
          socialSecurity: { mode: 'supplied-form1040-lines' },
        },
      }),
      adjustments: [],
      deductions: [],
      credits: [],
    },
  });
  const summary = buildCurrentIncomeTaxSummary(subject);
  assert.equal(summary.status, 'ready');
  assert.equal(summary.taxTotalScope, 'FULL_1040');
  assert.equal(summary.totalIncome, 85000);
  assert.equal(summary.adjustedGrossIncome, 85000);
  assert.ok(summary.federalTaxLiability > 0);
});

test('non-ready canonical totalIncome remains authoritative Form 1040 line 9', () => {
  const envelope = canonicalCurrent1040({
    income: {
      taxExemptInterest: 2500,
      socialSecurityBenefits: 100000,
      taxableSS: 85000,
      socialSecurity: { mode: 'supplied-form1040-lines' },
    },
  });
  delete envelope.deductions.qbi;
  const subject = plan({
    household: {
      primary: {
        birthYear: 1956,
        currentAge: 70,
        retirementAge: 65,
        planEndAge: 95,
      },
    },
    income: {
      other: [],
      socialSecurity: { primary: { pia: 100000, claimAge: 67 } },
    },
    incomeTax: {
      current1040: envelope,
      adjustments: [],
      deductions: [],
      credits: [],
    },
  });

  const summary = buildCurrentIncomeTaxSummary(subject);

  assert.equal(summary.status, 'needs_facts');
  assert.equal(summary.taxTotalScope, 'NOT_CALCULABLE');
  assert.equal(summary.totalIncome, 85000);
  assert.ok(summary.reasonCodes.includes('CURRENT_1040_LINE13A_DEFERRED'));
});

test('canonical calculated MFS Social Security preserves living-status semantics', () => {
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
        primary: {
          birthYear: 1956,
          currentAge: 70,
          retirementAge: 65,
          planEndAge: 95,
        },
        spouse: {
          birthYear: 1957,
          currentAge: 69,
          retirementAge: 65,
          planEndAge: 95,
        },
      },
      income: {
        other: [],
        socialSecurity: {
          primary: { pia: 10000, claimAge: 67 },
          spouse: { pia: 0, claimAge: 67 },
        },
      },
      incomeTax: {
        current1040: canonicalCurrent1040({
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
          deductions: {
            method: 'itemized',
            source: 'supplied-line12e',
            line12e: 0,
            qbi: 0,
            schedule1A: { mode: 'supplied-line13b', amount: 0 },
          },
        }),
        adjustments: [],
        deductions: [],
        credits: [],
      },
    });
  }

  const livedTogether = buildCurrentIncomeTaxSummary(subject(true));
  const livedApart = buildCurrentIncomeTaxSummary(subject(false));
  assert.equal(livedTogether.status, 'ready');
  assert.equal(livedApart.status, 'ready');
  assert.equal(livedTogether.totalIncome, 18500);
  assert.equal(livedApart.totalIncome, 10000);
  assert.ok(livedTogether.federalTaxLiability > livedApart.federalTaxLiability);

  const missing = buildCurrentIncomeTaxSummary(subject(undefined));
  assert.equal(missing.status, 'needs_facts');
  assert.ok(missing.reasonCodes
    .includes('MISSING_SOCIAL_SECURITY_LIVING_STATUS'));
  assert.equal(missing.federalTaxLiability, undefined);
});

test('canonical duplicate income sources block readiness without a partial total', () => {
  const subject = plan();
  subject.incomeTax.current1040 = canonicalCurrent1040({
    income: { wages: 100000 },
  });
  const summary = buildCurrentIncomeTaxSummary(subject);
  assert.equal(summary.status, 'needs_facts');
  assert.ok(summary.reasonCodes
    .includes('CURRENT_1040_INCOME_SOURCE_CONFLICT'));
  assert.equal(summary.totalIncome, null);
  assert.equal(summary.federalTaxLiability, undefined);
});

test('canonical supplied Schedule D amount appears once in total income', () => {
  const subject = plan({
    income: {
      other: [],
      socialSecurity: { primary: { pia: 0, claimAge: 67 } },
    },
    incomeTax: {
      current1040: canonicalCurrent1040({
        income: {},
        scheduleD: {
          mode: 'supplied-form1040-line7',
          amount: 50000,
        },
      }),
      adjustments: [],
      deductions: [],
      credits: [],
    },
  });
  const summary = buildCurrentIncomeTaxSummary(subject);
  assert.equal(summary.status, 'ready');
  assert.equal(summary.totalIncome, 50000);
  assert.equal(summary.adjustedGrossIncome, 50000);
});

test('canonical route preserves missing pass-through scope without changing legacy status', () => {
  const subject = plan();
  const envelope = canonicalCurrent1040();
  delete envelope.passThrough;
  subject.incomeTax.current1040 = envelope;
  const summary = buildCurrentIncomeTaxSummary(subject);
  assert.equal(summary.status, 'ready');
  assert.equal(summary.taxTotalScope, 'INCOME_TAX_ONLY');
  assert.equal(summary.premiumTaxCredit, null);

  const legacy = buildCurrentIncomeTaxSummary(plan());
  assert.equal(legacy.status, 'ready');
  assert.equal(legacy.sourceMode, undefined);
});

for(const {
  label,
  remove,
  expectedLine,
} of [
  {
    label: 'adjustments',
    remove: envelope => { delete envelope.adjustments; },
    expectedLine: 'line10',
  },
  {
    label: 'QBI',
    remove: envelope => { delete envelope.deductions.qbi; },
    expectedLine: 'line13a',
  },
  {
    label: 'Schedule 1-A',
    remove: envelope => { delete envelope.deductions.schedule1A; },
    expectedLine: 'line13b',
  },
]){
  test(`canonical route reports unresolved ${label} instead of a ready zero`, () => {
    const subject = plan();
    const envelope = canonicalCurrent1040();
    remove(envelope);
    subject.incomeTax.current1040 = envelope;

    const summary = buildCurrentIncomeTaxSummary(subject);

    assert.equal(summary.status, 'needs_facts');
    assert.equal(summary.sourceMode, 'canonical-v1');
    assert.equal(summary.taxTotalScope, 'NOT_CALCULABLE');
    assert.deepEqual(summary.unresolvedTaxableIncomeLines, [expectedLine]);
    assert.ok(summary.reasonCodes.includes('CURRENT_1040_TAX_RESULT_NOT_CALCULABLE'));
    assert.ok(summary.reasonCodes.includes(
      `CURRENT_1040_${expectedLine.toUpperCase()}_DEFERRED`
    ));
    assert.equal(summary.federalTaxLiability, undefined);
    assert.equal(summary.deductionUsed, null);
  });
}

test('canonical route rejects a law version that does not match its explicit year', () => {
  const subject = plan();
  subject.incomeTax.current1040 = canonicalCurrent1040({
    taxYear: 2025,
    lawVersion: '2026_FINAL',
  });
  const summary = buildCurrentIncomeTaxSummary(subject);
  assert.equal(summary.status, 'needs_facts');
  assert.equal(summary.sourceMode, 'canonical-v1');
  assert.ok(summary.reasonCodes.includes('INTAKE_LAW_VERSION_MISMATCH'));
});

test('canonical route fails closed on missing year and unattributed MFS joint income', () => {
  const missingYear = plan();
  missingYear.incomeTax.current1040 = canonicalCurrent1040();
  delete missingYear.incomeTax.current1040.taxYear;
  const missing = buildCurrentIncomeTaxSummary(missingYear);
  assert.equal(missing.status, 'needs_facts');
  assert.ok(missing.reasonCodes.includes('CURRENT_1040_TAX_YEAR_REQUIRED'));

  const mfs = plan({
    meta: { filingStatus: 'marriedFilingSeparately' },
    household: {
      primary: { birthYear: 1976, currentAge: 50, retirementAge: 65, planEndAge: 95 },
      spouse: { birthYear: 1977, currentAge: 49, retirementAge: 65, planEndAge: 95 },
    },
    income: {
      other: [
        { typeId: 'wages', owner: 'client', amount: 60000, startAge: 50, endAge: 64 },
        { typeId: 'wages', owner: 'spouse', amount: 90000, startAge: 49, endAge: 64 },
        { typeId: 'interest', owner: 'joint', amount: 1000, startAge: 50, endAge: 50 },
      ],
      socialSecurity: {
        primary: { pia: 0, claimAge: 67 },
        spouse: { pia: 0, claimAge: 67 },
      },
    },
    incomeTax: {
      current1040: canonicalCurrent1040({
        returnScope: { modeledTaxpayer: 'client', spouseItemizes: false },
        taxpayers: { client: {}, spouse: {} },
      }),
      adjustments: [],
      deductions: [],
      credits: [],
    },
  });
  const blocked = buildCurrentIncomeTaxSummary(mfs);
  assert.equal(blocked.status, 'needs_facts');
  assert.ok(blocked.reasonCodes
    .includes('CURRENT_1040_MFS_JOINT_INCOME_UNATTRIBUTED'));
  assert.equal(blocked.totalIncome, null);
});

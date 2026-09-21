import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdTaxView } from './householdWizardTax.js';
import { escHtml } from './dom.js';

function context(overrides = {}){
  return {
    plan: { meta: { filingStatus: 'single', planningAsOfYear: 2026 }, household: { primary: {} } },
    current: { taxYear: 2026, income: {} }, deductionMode: 'standard',
    optionalItems: new Set(), optionalMenuOpen: false,
    taxSummary: { status: 'needs-facts', reasonCodes: ['missing-income'] }, esc: escHtml,
    ...overrides,
  };
}
const fields = view => view.controls.map(control => control.field);
const base = [
  'taxYear', 'deductionMode', 'irmaa.lookback.2024.magi', 'irmaa.lookback.2025.magi',
  'income.wages.client', 'income.taxExemptInterest', 'income.taxableInterest',
  'income.qualifiedDividends', 'income.ordinaryDividends', 'income.iraDistributions',
  'income.rothConversion', 'income.pensionAmount', 'income.socialSecurityBenefits',
  'scheduleD.netLongTermGainOrLoss', 'income.otherIncome', 'socialSecurity.mode',
];

test('Tax base model preserves ordered fields, select choices, signed fields and lookback year authority', () => {
  const view = buildHouseholdTaxView(context());
  assert.deepEqual(fields(view), base);
  assert.deepEqual(view.controls.filter(control => control.signed).map(control => control.field),
    ['scheduleD.netLongTermGainOrLoss', 'income.otherIncome']);
  assert.deepEqual(view.controls.find(control => control.field === 'deductionMode').options.map(([key]) => key),
    ['standard', 'itemized-details', 'itemized-total']);
  assert.equal(view.controls.find(control => control.field === 'socialSecurity.mode').value, 'supplied-form1040-lines');
  const earlierReturn = buildHouseholdTaxView(context({ current: { taxYear: 2025, income: {} } }));
  assert.deepEqual(fields(earlierReturn), base);
});

test('Tax value-only and readiness updates keep an identical explicit structure', () => {
  const first = buildHouseholdTaxView(context());
  const next = buildHouseholdTaxView(context({ current: { taxYear: 2026, income: { taxableInterest: 800 } },
    taxSummary: { status: 'ready' } }));
  assert.deepEqual(next.structure, first.structure);
  assert.equal(next.controls.find(control => control.field === 'income.taxableInterest').value, '800');
  assert.deepEqual(next.readiness, { status: 'ready', reason: '' });
});

test('IRA and pension companions follow direct gross, planning gross or supplied taxable facts', () => {
  for(const [groupId, gross, taxable] of [['ira', 'iraDistributions', 'taxableIra'], ['pension', 'pensionAmount', 'taxablePensions']]){
    for(const variation of [
      { current: { taxYear: 2026, income: { [gross]: 100 } } },
      { current: { taxYear: 2026, income: { [taxable]: 100 } } },
      { planningIncome: { groups: { [groupId]: { rowIds: ['row'], values: { [gross]: 100 }, rowSourced: true } } } },
    ]){
      const view = buildHouseholdTaxView(context(variation));
      const inventory = fields(view);
      assert.equal(inventory[inventory.indexOf(`income.${gross}`) + 1], `income.${taxable}`);
    }
    assert.equal(fields(buildHouseholdTaxView(context({ current: { taxYear: 2026, income: { [gross]: 0, [taxable]: 0 } } })))
      .includes(`income.${taxable}`), false);
  }
});

test('Social Security modes have distinct exact conditional inventories', () => {
  const supplied = fields(buildHouseholdTaxView(context({ current: { taxYear: 2026, income: { socialSecurity: { mode: 'supplied-form1040-lines' } } } })));
  const expected = [...base]; expected.splice(expected.indexOf('income.socialSecurityBenefits') + 1, 0, 'income.taxableSS');
  assert.deepEqual(supplied, expected);
  const worksheet = fields(buildHouseholdTaxView(context({ current: { taxYear: 2026, income: { socialSecurity: { mode: 'calculate-taxable-benefits' } } } })));
  assert.deepEqual(worksheet, [...base, 'socialSecurity.otherIncome', 'socialSecurity.excludedIncomeAddBacks', 'socialSecurity.adjustments']);
});

test('Planning source actions, displayed values and disabled state change together', () => {
  for(const [rowSourced, overridden, value, action] of [[true, false, '1,234', 'override-income-group'], [false, true, '25', 'revert-income-group']]){
    const view = buildHouseholdTaxView(context({ current: { taxYear: 2026, income: { taxableInterest: 25 } },
      planningIncome: { groups: { interest: { rowIds: ['interest'], values: { taxableInterest: 1234 }, rowSourced, overridden } } } }));
    const control = view.controls.find(item => item.field === 'income.taxableInterest');
    assert.equal(control.value, value); assert.equal(control.disabled, rowSourced);
    assert.deepEqual(view.structure.sources, [{ groupId: 'interest', action }]);
    assert.equal(view.controls.find(item => item.field === 'income.wages.client').disabled, false);
  }
});

test('Optional facts retain invalid saved values for correction and preserve Schedule SE coupling', () => {
  for(const amount of [null, 'invalid', '0', 30]){
    const view = buildHouseholdTaxView(context({ current: { taxYear: 2026, income: {}, adjustments: { amount } } }));
    assert.equal(fields(view).includes('adjustments.line10'), true);
  }
  assert.equal(fields(buildHouseholdTaxView(context({ current: { taxYear: 2026, income: {}, adjustments: { amount: 0 } } })))
    .includes('adjustments.line10'), false);
  const view = buildHouseholdTaxView(context({ current: { taxYear: 2026, income: {}, scheduleSE: [{}] } }));
  assert.deepEqual(fields(view).slice(base.length), [
    'schedule2.netInvestmentIncomeTax', 'schedule2.additionalMedicareTax', 'schedule2.otherPartIITaxes',
    'scheduleSE.taxpayerOwner', 'scheduleSE.netEarningsFromSelfEmployment', 'scheduleSE.socialSecurityWagesAndTips',
  ]);
});

test('Itemized method selects the complete ordered deduction inventory', () => {
  const detailed = buildHouseholdTaxView(context({ deductionMode: 'itemized-details' }));
  assert.deepEqual(fields(detailed).slice(base.length), [
    'deductions.itemized.medicalExpensesPaid', 'deductions.itemized.salt.eligibleTaxesPaid',
    'deductions.itemized.salt.magi', 'deductions.itemized.mortgageInterestDeductible',
    'deductions.itemized.charitableContributionsDeductible', 'deductions.itemized.otherItemizedDeductions',
  ]);
  assert.deepEqual(fields(buildHouseholdTaxView(context({ deductionMode: 'itemized-total' }))).slice(base.length), ['deductions.line12e']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAdjustment,
  createCredit,
  createIncomeSource,
  createIncomeTaxInputs,
  enteredAdjustmentTotal,
  incomeSourceGroups,
  isAdjustmentActiveNow,
  normalizedIncomeSource,
} from './incomeTaxModel.js';

function plan(overrides = {}){
  return {
    meta: { primaryName: 'Alex', spouseName: 'Jordan' },
    household: {
      primary: { currentAge: 64, retirementAge: 65 },
      spouse: { currentAge: 63, retirementAge: 66 },
    },
    income: { other: [] },
    incomeTax: { adjustments: [], deductions: [] },
    ...overrides,
  };
}

test('income columns follow entered start age instead of hard-coded source type', () => {
  const subject = plan({
    income: {
      other: [
        { typeId:'pension', owner:'client', label:'Early pension', amount:20000, startAge:60, endAge:999 },
        { typeId:'interest', owner:'client', label:'Later interest', amount:5000, startAge:65, endAge:999 },
        { typeId:'dividends', owner:'joint', label:'Joint dividends', amount:8000, startAge:66, endAge:999 },
      ],
    },
  });
  const groups = incomeSourceGroups(subject);
  assert.deepEqual(groups.working.map(row => row.label), ['Early pension']);
  assert.deepEqual(groups.retirement.map(row => row.label), ['Later interest', 'Joint dividends']);
});

test('working-only adjustments stop at retirement and joint rows remain active while either client works', () => {
  const subject = plan({
    household: {
      primary: { currentAge: 65, retirementAge: 65 },
      spouse: { currentAge: 64, retirementAge: 66 },
    },
    incomeTax: {
      adjustments: [
        { typeId:'401k', owner:'client', amount:23000, whileWorkingOnly:true },
        { typeId:'401k', owner:'joint', amount:10000, whileWorkingOnly:true },
        { typeId:'hsa', owner:'client', amount:4300, whileWorkingOnly:false },
      ],
      deductions: [],
    },
  });
  assert.equal(isAdjustmentActiveNow(subject, subject.incomeTax.adjustments[0]), false);
  assert.equal(isAdjustmentActiveNow(subject, subject.incomeTax.adjustments[1]), true);
  assert.equal(enteredAdjustmentTotal(subject), 14300);
});

test('new 401(k) adjustments persist their working-only default', () => {
  assert.equal(createAdjustment('401k', 'spouse').whileWorkingOnly, true);
  assert.equal(createAdjustment('hsa', 'joint').whileWorkingOnly, false);
});

test('current-year federal source types default to one year with honest tax character', () => {
  const subject = plan();
  const exempt = createIncomeSource(subject, 'tax_exempt_interest', 'joint');
  const ira = createIncomeSource(subject, 'ira_distribution', 'client');
  const conversion = createIncomeSource(subject, 'roth_conversion', 'client');
  const shortGain = createIncomeSource(subject, 'short_term_capital_gain', 'joint');
  const longGain = createIncomeSource(subject, 'long_term_capital_gain', 'joint');
  for(const row of [exempt, ira, conversion, shortGain, longGain]){
    assert.equal(row.startAge, 64);
    assert.equal(row.endAge, 64);
  }
  assert.equal(exempt.taxablePct, 0);
  assert.equal(ira.taxablePct, 1);
  assert.equal(conversion.taxablePct, 1);
  assert.equal(shortGain.taxablePct, 1);
  assert.equal(longGain.taxablePct, 0);
});

test('long-term capital gain rows preserve signed losses without opening other income types', () => {
  const subject = plan();
  assert.equal(normalizedIncomeSource(subject, {
    typeId: 'long_term_capital_gain',
    owner: 'client',
    amount: -5000,
  }).amount, -5000);
  assert.equal(normalizedIncomeSource(subject, {
    typeId: 'wages',
    owner: 'client',
    amount: -5000,
  }).amount, 0);
  assert.equal(normalizedIncomeSource(subject, {
    typeId: 'long_term_capital_gain',
    owner: 'client',
    amount: 0,
  }).amount, 0);
});

test('Premium Tax Credit is part of the persisted Income & Tax defaults', () => {
  assert.deepEqual(createIncomeTaxInputs().credits, []);
  assert.deepEqual(createCredit(), {
    typeId: 'premium_tax_credit',
    label: 'Premium Tax Credit',
    amount: 0,
  });
});

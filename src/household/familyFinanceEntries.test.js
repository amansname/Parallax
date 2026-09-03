import test from 'node:test';
import assert from 'node:assert/strict';

import { plan as defaultPlan } from '../projection/engine/defaultPlan.js';
import { resolveInputs } from '../projection/engine/resolveInputs.js';
import {
  addFamilyFinanceEntry,
  FAMILY_INCOME_SOURCE_TYPES,
  FAMILY_SAVINGS_SOURCE_TYPES,
} from './familyFinanceEntries.js';

function subject(){
  const value = structuredClone(defaultPlan);
  value.meta.primaryName = 'Alex Johnson';
  value.meta.spouseName = 'Jamie Johnson';
  value.household.primary.currentAge = 52;
  value.household.primary.retirementAge = 67;
  value.household.spouse = {
    currentAge: 50,
    retirementAge: 67,
    planEndAge: 95,
  };
  value.income.socialSecurity.spouse = { pia: null, claimAge: 69 };
  value.savings = {
    annual: 0,
    split: { taxable: 0, traditional: 1, roth: 0 },
  };
  return value;
}

test('Family finance pickers expose only explicit supported source choices', () => {
  assert.deepEqual(
    FAMILY_INCOME_SOURCE_TYPES.map(type => type.label),
    [
      'Social Security',
      'Pension',
      'Wages or salary',
      'Self-employment',
      'Rental net income',
      'Annuity',
      'Interest',
      'Dividends',
      'Deferred compensation',
      'Other income',
    ],
  );
  assert.deepEqual(
    FAMILY_SAVINGS_SOURCE_TYPES.map(type => type.label),
    [
      '401(k) deferral',
      'Roth 401(k) deferral',
      'Traditional IRA',
      'Roth IRA',
      'HSA',
      'Taxable brokerage',
      'Cash savings',
    ],
  );
  assert.equal(FAMILY_SAVINGS_SOURCE_TYPES.some(type => type.id === 'legacy_529'), false);
});

test('explicit income entry creates one owner-attributed canonical income row', () => {
  const value = subject();
  addFamilyFinanceEntry(value, {
    mode: 'income',
    typeId: 'wages',
    owner: 'spouse',
    amount: 84_000,
  });

  assert.equal(value.income.other.length, 1);
  assert.match(value.income.other[0].id, /^income_/);
  assert.equal(value.income.other[0].owner, 'spouse');
  assert.equal(value.income.other[0].typeId, 'wages');
  assert.equal(value.income.other[0].amount, 84_000);
  assert.equal(resolveInputs(value, {}).otherIncome[0].amount, 84_000);
});

test('selecting the same income source edits it instead of creating hidden duplicates', () => {
  const value = subject();
  addFamilyFinanceEntry(value, {
    mode: 'income', typeId: 'rental', owner: 'client', amount: 18_000,
  });
  const id = value.income.other[0].id;
  addFamilyFinanceEntry(value, {
    mode: 'income', typeId: 'rental', owner: 'client', amount: 24_000,
  });

  assert.equal(value.income.other.length, 1);
  assert.equal(value.income.other[0].id, id);
  assert.equal(value.income.other[0].amount, 24_000);
});

test('retirement income begins at its owner retirement age instead of current age', () => {
  const value = subject();
  addFamilyFinanceEntry(value, {
    mode: 'income', typeId: 'pension', owner: 'spouse', amount: 30_000,
  });

  assert.equal(value.income.other[0].startAge, 67);
  assert.equal(value.income.other[0].endAge, 999);
  const resolved = resolveInputs(value, {});
  const pension = resolved.otherIncome.find(source => source.typeId === 'pension');
  assert.equal(pension.startAge, 69);
  assert.equal(pension.endAge, 97);
});

test('Social Security entry preserves claiming age and writes the engine-owned FRA benefit', () => {
  const value = subject();
  addFamilyFinanceEntry(value, {
    mode: 'income',
    typeId: 'social_security',
    owner: 'spouse',
    amount: 22_000,
  });

  assert.deepEqual(value.income.socialSecurity.spouse, {
    pia: 22_000,
    claimAge: 69,
  });
  const resolved = resolveInputs(value, {});
  const spouseWorker = resolved.ss.find(
    stream => stream.kind === 'worker' && stream.owner === 'spouse',
  );
  assert.equal(spouseWorker.startAge, 71);
  assert.ok(spouseWorker.amount > 0);
});

test('savings entries preserve ownership while feeding the existing annual and sleeve inputs', () => {
  const value = subject();
  addFamilyFinanceEntry(value, {
    mode: 'savings', typeId: '401k', owner: 'client', amount: 28_300,
  });
  addFamilyFinanceEntry(value, {
    mode: 'savings', typeId: 'roth_ira', owner: 'spouse', amount: 16_000,
  });
  addFamilyFinanceEntry(value, {
    mode: 'savings', typeId: 'brokerage_taxable', owner: 'client', amount: 24_000,
  });

  assert.deepEqual(
    value.savings.entries.map(({ owner, typeId, amount, bucket }) => ({
      owner, typeId, amount, bucket,
    })),
    [
      { owner: 'client', typeId: '401k', amount: 28_300, bucket: 'traditional' },
      { owner: 'spouse', typeId: 'roth_ira', amount: 16_000, bucket: 'roth' },
      { owner: 'client', typeId: 'brokerage_taxable', amount: 24_000, bucket: 'taxable' },
    ],
  );
  assert.equal(value.savings.annual, 68_300);
  const resolved = resolveInputs(value, {});
  assert.equal(resolved.savingsAnnual, 68_300);
  assert.equal(resolved.savingsSplit.traditional, 28_300 / 68_300);
  assert.equal(resolved.savingsSplit.roth, 16_000 / 68_300);
  assert.equal(resolved.savingsSplit.taxable, 24_000 / 68_300);
});

test('the first explicit savings entry preserves a legacy aggregate as unallocated savings', () => {
  const value = subject();
  value.savings = {
    annual: 10_000,
    split: { taxable: 0.25, traditional: 0.75, roth: 0 },
  };
  addFamilyFinanceEntry(value, {
    mode: 'savings', typeId: 'roth_ira', owner: 'spouse', amount: 6_000,
  });

  assert.equal(value.savings.unallocatedAnnual, 10_000);
  assert.deepEqual(value.savings.unallocatedSplit, {
    taxable: 0.25,
    traditional: 0.75,
    roth: 0,
  });
  assert.equal(value.savings.annual, 16_000);
  assert.equal(value.savings.split.taxable, 2_500 / 16_000);
  assert.equal(value.savings.split.traditional, 7_500 / 16_000);
  assert.equal(value.savings.split.roth, 6_000 / 16_000);
});

test('an empty explicit collection still preserves a legacy aggregate before the first entry', () => {
  const value = subject();
  value.savings = {
    annual: 10_000,
    split: { taxable: 0.25, traditional: 0.75, roth: 0 },
    entries: [],
  };
  addFamilyFinanceEntry(value, {
    mode: 'savings', typeId: 'roth_ira', owner: 'spouse', amount: 6_000,
  });

  assert.equal(value.savings.unallocatedAnnual, 10_000);
  assert.equal(value.savings.annual, 16_000);
});

test('unsupported and zero-value entries fail closed without changing the plan', () => {
  const value = subject();
  const before = structuredClone(value);
  assert.throws(
    () => addFamilyFinanceEntry(value, {
      mode: 'savings', typeId: 'legacy_529', owner: 'client', amount: 10_000,
    }),
    /Unsupported savings source/,
  );
  assert.throws(
    () => addFamilyFinanceEntry(value, {
      mode: 'income', typeId: 'pension', owner: 'client', amount: 0,
    }),
    /greater than zero/,
  );
  assert.deepEqual(value, before);
});

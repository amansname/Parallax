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

test('the first explicit savings entry replaces legacy savings only after a bound confirmation', () => {
  const value = subject();
  value.savings = {
    annual: 10_000,
    split: { taxable: 0.25, traditional: 0.75, roth: 0 },
  };
  const command = {
    mode: 'savings', typeId: 'roth_ira', owner: 'spouse', amount: 6_000,
  };
  const before = JSON.stringify(value);
  let confirmation;
  assert.throws(() => addFamilyFinanceEntry(value, command), error => {
    assert.equal(error.code, 'SAVINGS_REPLACEMENT_REQUIRED');
    confirmation = error.confirmation;
    assert.equal(confirmation.priorAnnual, 10_000);
    assert.equal(confirmation.itemizedAnnual, 6_000);
    return true;
  });
  assert.equal(JSON.stringify(value), before);
  addFamilyFinanceEntry(value, { ...command, savingsConfirmation: confirmation });
  assert.deepEqual(value.meta.legacyRepairArchive.at(-1).priorSavings, JSON.parse(before).savings);

  assert.equal(Object.hasOwn(value.savings, 'unallocatedAnnual'), false);
  assert.equal(Object.hasOwn(value.savings, 'unallocatedSplit'), false);
  assert.equal(value.savings.annual, 6_000);
  assert.deepEqual(value.savings.split, {
    taxable: 0,
    traditional: 0,
    roth: 1,
  });
});

test('zero for an absent savings entry preserves legacy bytes and missing or empty entry shape', () => {
  for(const entries of [undefined, []]){
    const value = subject();
    value.savings.annual = 30_000;
    if(entries) value.savings.entries = entries;
    const before = JSON.stringify(value);
    addFamilyFinanceEntry(value, {
      mode: 'savings', typeId: '401k', owner: 'client', amount: 0,
    });
    assert.equal(JSON.stringify(value), before);
  }
});

test('confirmation rejects changes to the reviewed household, savings, or proposed entry', () => {
  const command = { mode: 'savings', typeId: '401k', owner: 'client', amount: 500 };
  const changes = [
    value => { value.meta.householdId = 'other-household'; },
    value => { value.savings.annual = 40_000; },
    value => { value.savings.split = { taxable: 1, traditional: 0, roth: 0 }; },
    value => { value.savings.entries = []; },
    value => { value.savings.entries = [{ id: 'new', typeId: '401k', owner: 'client', amount: 100, bucket: 'traditional' }]; },
  ];
  for(const change of changes){
    const value = subject();
    value.savings.annual = 30_000;
    let savingsConfirmation;
    assert.throws(() => addFamilyFinanceEntry(value, command), error => {
      savingsConfirmation = error.confirmation;
      return error.code === 'SAVINGS_REPLACEMENT_REQUIRED';
    });
    change(value);
    const before = JSON.stringify(value);
    assert.throws(() => addFamilyFinanceEntry(value, { ...command, savingsConfirmation }), { code: 'SAVINGS_REPLACEMENT_STALE' });
    assert.equal(JSON.stringify(value), before);
  }
  for(const changed of [{ amount: 0 }, { amount: 600 }, { owner: 'spouse' }, { typeId: 'roth_ira' }, { mode: 'income', typeId: 'wages' }]){
    const value = subject();
    value.savings.annual = 30_000;
    let savingsConfirmation;
    assert.throws(() => addFamilyFinanceEntry(value, command), error => {
      savingsConfirmation = error.confirmation;
      return error.code === 'SAVINGS_REPLACEMENT_REQUIRED';
    });
    const before = JSON.stringify(value);
    assert.throws(() => addFamilyFinanceEntry(value, { ...command, ...changed, savingsConfirmation }), { code: 'SAVINGS_REPLACEMENT_STALE' });
    assert.equal(JSON.stringify(value), before);
  }
});

test('malformed savings lists cannot be treated as an empty legacy total', () => {
  for(const entries of [null, {}, { oldContribution: { amount: 30_000 } }]){
    const value = subject();
    value.savings = { annual: 30_000, split: { taxable: 0, traditional: 1, roth: 0 }, entries };
    const before = JSON.stringify(value);
    for(const amount of [0, 500]){
      assert.throws(() => addFamilyFinanceEntry(value, { mode: 'savings', typeId: '401k', owner: 'client', amount }), /savings.entries must be an array/);
      assert.equal(JSON.stringify(value), before);
    }
  }
});

test('confirmed replacement archives the exact prior savings and ordinary edits keep itemized authority', () => {
  const value = subject();
  value.savings = { annual: 30_000, split: { taxable: 0.2, traditional: 0.8, roth: 0 }, entries: [], unallocatedAnnual: 30_000, unallocatedSplit: { taxable: 0.2, traditional: 0.8, roth: 0 } };
  const prior = structuredClone(value.savings);
  const command = { mode: 'savings', typeId: '401k', owner: 'client', amount: 500 };
  let savingsConfirmation;
  assert.throws(() => addFamilyFinanceEntry(value, command), error => {
    savingsConfirmation = error.confirmation;
    return error.code === 'SAVINGS_REPLACEMENT_REQUIRED';
  });
  addFamilyFinanceEntry(value, { ...command, savingsConfirmation });
  addFamilyFinanceEntry(value, { ...command, amount: 1_000 });
  addFamilyFinanceEntry(value, { ...command, owner: 'spouse', amount: 2_000 });
  assert.equal(value.meta.legacyRepairArchive.length, 1);
  assert.deepEqual(value.meta.legacyRepairArchive[0].priorSavings, prior);
  assert.equal(value.meta.legacyRepairArchive[0].itemizedAnnual, 500);
  assert.equal(value.savings.annual, 3_000);
  assert.equal(resolveInputs(value, {}).savingsAnnual, 3_000);
  const before = JSON.stringify(value);
  addFamilyFinanceEntry(value, { ...command, typeId: 'roth_ira', amount: 0 });
  assert.equal(JSON.stringify(value), before);
  addFamilyFinanceEntry(value, { ...command, amount: 0 });
  assert.equal(value.savings.annual, 2_000);
  assert.equal(value.savings.entries[0].owner, 'spouse');
});

test('editing a persisted itemized entry removes the hidden aggregate from PR 259', () => {
  const value = subject();
  value.savings = {
    annual: 16_000,
    split: { taxable: 0.25, traditional: 0.375, roth: 0.375 },
    unallocatedAnnual: 10_000,
    unallocatedSplit: { taxable: 0.4, traditional: 0.6, roth: 0 },
    entries: [{
      id: 'savings_spouse_roth',
      typeId: 'roth_ira',
      label: 'Roth IRA',
      owner: 'spouse',
      amount: 6_000,
      bucket: 'roth',
    }],
  };
  addFamilyFinanceEntry(value, {
    mode: 'savings', typeId: 'roth_ira', owner: 'spouse', amount: 7_000,
  });

  assert.equal(Object.hasOwn(value.savings, 'unallocatedAnnual'), false);
  assert.equal(Object.hasOwn(value.savings, 'unallocatedSplit'), false);
  assert.equal(value.savings.annual, 7_000);
  assert.deepEqual(value.savings.split, { taxable: 0, traditional: 0, roth: 1 });
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

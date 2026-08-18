import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NET_WORTH_ONLY_TREATMENT,
  createEmptyNetWorthRecords,
  migrateNetWorthRecords,
  validateNetWorthRecords,
} from './netWorthRecords.js';

function plan(){
  return {
    netWorth: createEmptyNetWorthRecords(),
    properties: [],
  };
}

function shellEntry(overrides = {}){
  return {
    id: 'nw-entry',
    categoryId: 'insurance',
    name: 'Anonymized policy',
    type: 'Whole Life',
    owner: 'client',
    tax: '',
    value: 50000,
    projectionTreatment: NET_WORTH_ONLY_TREATMENT,
    ...overrides,
  };
}

test('missing Net Worth records migrate once and reload idempotently', () => {
  const subject = { properties: [] };
  assert.equal(migrateNetWorthRecords(subject).changed, true);
  assert.deepEqual(subject.netWorth, createEmptyNetWorthRecords());
  assert.equal(migrateNetWorthRecords(subject).changed, false);
  assert.equal(validateNetWorthRecords(subject, 'hh-net-worth'), true);
});

test('durable shell entries and canonical Property/Mortgage metadata validate together', () => {
  const subject = plan();
  subject.netWorth.shellEntries.push(shellEntry());
  subject.properties.push({
    name: 'Anonymized property',
    value: 500000,
    netWorthMeta: { type: 'Second Home', owner: 'joint' },
    mortgage: {
      balance: 120000,
      netWorthMeta: {
        present: true,
        name: 'Anonymized lender',
        type: 'Second Home',
        owner: 'joint',
      },
    },
  });
  assert.equal(validateNetWorthRecords(subject, 'hh-net-worth'), true);
});

test('invalid IDs, amounts, categories, and projection treatment fail closed', () => {
  for(const invalid of [
    shellEntry({ id: '' }),
    shellEntry({ value: -1 }),
    shellEntry({ value: 1.5 }),
    shellEntry({ categoryId: 'mortgage' }),
    shellEntry({ projectionTreatment: '' }),
  ]){
    const subject = plan();
    subject.netWorth.shellEntries.push(invalid);
    assert.throws(
      () => validateNetWorthRecords(subject, 'hh-net-worth'),
      /netWorth\.shellEntries|Net Worth/,
    );
  }

  const duplicate = plan();
  duplicate.netWorth.shellEntries.push(shellEntry(), shellEntry());
  assert.throws(
    () => validateNetWorthRecords(duplicate, 'hh-net-worth'),
    /duplicate Net Worth record id/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleIsoBirthDate,
  formatIsoBirthDate,
  parseDisplayedBirthDate,
  splitIsoBirthDate,
} from './birthDateInput.js';

test('splitIsoBirthDate strips leading zeros for month and day', () => {
  assert.deepEqual(splitIsoBirthDate('1971-03-14'), {
    month: '3',
    day: '14',
    year: '1971',
  });
});

test('assembleIsoBirthDate requires a four-digit year', () => {
  assert.equal(
    assembleIsoBirthDate({ month: '1', day: '30', year: '2003' }),
    '2003-01-30',
  );
  assert.equal(assembleIsoBirthDate({ month: '1', day: '30', year: '03' }), null);
  assert.equal(assembleIsoBirthDate({ month: '1', day: '30', year: '3' }), null);
});

test('assembleIsoBirthDate rejects incomplete parts', () => {
  assert.equal(assembleIsoBirthDate({ month: '1', day: '', year: '2003' }), null);
});

test('single birth-date field matches the standalone presentation', () => {
  assert.equal(formatIsoBirthDate('1960-04-12'), '04 / 12 / 1960');
  assert.equal(parseDisplayedBirthDate('04 / 12 / 1960'), '1960-04-12');
  assert.equal(parseDisplayedBirthDate('4/12/1960'), '1960-04-12');
  assert.equal(parseDisplayedBirthDate('04 / 12'), null);
});

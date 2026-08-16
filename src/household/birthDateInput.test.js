import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleIsoBirthDate,
  splitIsoBirthDate,
} from './birthDateInput.js';

test('splitIsoBirthDate preserves two-digit month and day segments', () => {
  assert.deepEqual(splitIsoBirthDate('1971-03-14'), {
    month: '03',
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

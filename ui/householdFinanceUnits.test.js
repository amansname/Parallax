import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFinanceAmountInput, readFinanceAnnualAmount } from './householdFinanceUnits.js';

test('the entered finance unit, rather than viewport size, determines the saved annual value', () => {
  assert.equal(readFinanceAnnualAmount({ dataset: { financeUnit: 'month' }, value: '3,000' }), 36000);
  assert.equal(readFinanceAnnualAmount({ dataset: { financeUnit: 'year' }, value: '36,000' }), '36,000');
});

test('unchanged rounded monthly display preserves the original annual amount exactly', () => {
  assert.equal(readFinanceAnnualAmount({ dataset: { financeUnit: 'month', financeDisplayedValue: '2,500.08', financeAnnualValue: '30001' }, value: '2,500.08' }), '30001');
});

test('invalid monthly text still reaches production validation rather than becoming zero', () => {
  assert.equal(readFinanceAnnualAmount({ dataset: { financeUnit: 'month' }, value: 'invalid' }), 'invalid');
});

test('one backspace in a fractional monthly amount preserves the decimal and annual magnitude', () => {
  const control = { dataset: { financeUnit: 'month', financeDisplayedValue: '2,500.08', financeAnnualValue: '30001' },
    value: '2,500.0', selectionStart: 7, setSelectionRange(start, end){ this.selection = [start, end]; } };
  formatFinanceAmountInput(control);
  assert.equal(control.value, '2,500.0');
  assert.deepEqual(control.selection, [7, 7]);
  assert.equal(readFinanceAnnualAmount(control), 30000);
});

test('fractional finance typing keeps incomplete decimal and invalid raw text for correction', () => {
  for(const text of ['2,500.', '2,500.08', '.', '--1', 'invalid']){
    const control = { value: text, selectionStart: text.length, setSelectionRange(){} };
    formatFinanceAmountInput(control);
    assert.equal(control.value, text);
  }
});

test('finance grouping preserves leading zeros and the caret within a fractional raw input', () => {
  const control = { value: '0001234.050', selectionStart: 4, setSelectionRange(start, end){ this.selection = [start, end]; } };
  formatFinanceAmountInput(control);
  assert.equal(control.value, '0,001,234.050');
  assert.deepEqual(control.selection, [5, 5]);
});

test('long pasted finance text retains every digit without numeric conversion', () => {
  const text = '123'.repeat(10000) + '.';
  const control = { value: text, selectionStart: text.length, setSelectionRange(start, end){ this.selection = [start, end]; } };
  formatFinanceAmountInput(control);
  assert.equal(control.value.replaceAll(',', ''), text);
  assert.equal(control.value.split(',').length, 10000);
  assert.deepEqual(control.selection, [control.value.length, control.value.length]);
});

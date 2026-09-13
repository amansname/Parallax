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

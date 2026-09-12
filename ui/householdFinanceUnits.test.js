import assert from 'node:assert/strict';
import test from 'node:test';
import { readFinanceAnnualAmount } from './householdFinanceUnits.js';

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

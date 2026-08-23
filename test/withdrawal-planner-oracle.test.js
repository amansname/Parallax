import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const oracle = JSON.parse(readFileSync(
  new URL('./fixtures/withdrawal-planner-oracle.v1.json', import.meta.url),
  'utf8',
));

function progressiveTax(taxableIncome, brackets){
  let tax = 0;
  let lower = 0;
  for(const { upper, rate } of brackets){
    const dollars = Math.max(0, Math.min(taxableIncome, upper) - lower);
    tax += dollars * rate;
    lower = upper;
    if(taxableIncome <= upper) break;
  }
  return tax;
}

function formatDollars(value){
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function formatDisplayedRate(tax, taxableIncome){
  const rounded = Math.round((tax / taxableIncome) * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

test('Withdrawal Planner oracle is pinned to an independent 2026 worksheet', () => {
  assert.match(oracle.source, /independently hand-derived 2026 federal worksheet/i);
  assert.match(oracle.source, /Rev\. Proc\. 2025-32 \/ IRB 2025-45/);
  assert.match(oracle.source, /not captured from Parallax production/i);

  const now = oracle.households['now-household'];
  const nowWages = 430_000;
  const nowItemizedDeduction = 14_000 + 34_000;
  const nowTaxableOrdinaryIncome = nowWages - nowItemizedDeduction;
  const nowOrdinaryTax = progressiveTax(nowTaxableOrdinaryIncome, [
    { upper: 24_800, rate: 0.10 },
    { upper: 100_800, rate: 0.12 },
    { upper: 211_400, rate: 0.22 },
    { upper: 403_550, rate: 0.24 },
  ]);
  const nowRealizedGain = 80_000;
  const nowRealizedGainTax = nowRealizedGain * 0.15;
  const nowSelectedTax = nowOrdinaryTax + nowRealizedGainTax;

  assert.equal(nowTaxableOrdinaryIncome, 382_000);
  assert.equal(nowOrdinaryTax, 76_876);
  assert.equal(now.baseline.federalTax, formatDollars(nowOrdinaryTax));
  assert.equal(now.baseline.ordinary, formatDollars(nowOrdinaryTax));
  assert.equal(now.baseline.longTermGainTax, '$0');
  assert.equal(now.realizedGainAtDisplayCeiling.slider, formatDollars(nowRealizedGain));
  assert.equal(now.realizedGainAtDisplayCeiling.federalTax, formatDollars(nowSelectedTax));
  assert.equal(now.realizedGainAtDisplayCeiling.ordinary, formatDollars(nowOrdinaryTax));
  assert.equal(
    now.realizedGainAtDisplayCeiling.longTermGainTax,
    formatDollars(nowRealizedGainTax),
  );
  assert.equal(
    now.realizedGainAtDisplayCeiling.effectiveRate,
    formatDisplayedRate(nowSelectedTax, nowTaxableOrdinaryIncome + nowRealizedGain),
  );
  assert.equal(now.realizedGainAtDisplayCeiling.taxCaused, formatDollars(nowRealizedGainTax));

  const future = oracle.households['future-household'];
  const futureOrdinaryIncome = 8_000 + 15_000;
  const futureBaselineLongTermGain = 10_000;
  const futureStandardDeduction = 32_200 + 1_650 + 1_650;
  const futureBaselineTaxableIncome = Math.max(
    0,
    futureOrdinaryIncome + futureBaselineLongTermGain - futureStandardDeduction,
  );
  const futureRealizedGain = 500_000;
  const futureTaxablePreferentialIncome = (
    futureOrdinaryIncome
    + futureBaselineLongTermGain
    + futureRealizedGain
    - futureStandardDeduction
  );
  const futureZeroRateCeiling = 98_900;
  const futureSelectedTax = (
    futureTaxablePreferentialIncome - futureZeroRateCeiling
  ) * 0.15;

  assert.equal(futureStandardDeduction, 35_500);
  assert.equal(futureBaselineTaxableIncome, 0);
  assert.equal(futureTaxablePreferentialIncome, 497_500);
  assert.equal(futureSelectedTax, 59_790);
  assert.equal(future.baseline.federalTax, '$0');
  assert.equal(future.baseline.ordinary, '$0');
  assert.equal(future.baseline.longTermGainTax, '$0');
  assert.equal(future.realizedGainAtDisplayCeiling.slider, formatDollars(futureRealizedGain));
  assert.equal(future.realizedGainAtDisplayCeiling.federalTax, formatDollars(futureSelectedTax));
  assert.equal(future.realizedGainAtDisplayCeiling.ordinary, '$0');
  assert.equal(
    future.realizedGainAtDisplayCeiling.longTermGainTax,
    formatDollars(futureSelectedTax),
  );
  assert.equal(
    future.realizedGainAtDisplayCeiling.effectiveRate,
    formatDisplayedRate(futureSelectedTax, futureTaxablePreferentialIncome),
  );
  assert.equal(future.realizedGainAtDisplayCeiling.taxCaused, formatDollars(futureSelectedTax));
});

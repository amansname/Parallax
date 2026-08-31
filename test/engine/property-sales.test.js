// Engine contract: property sales. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { generateReturnPath, runSimulation, runHistoricalPath, resolveInputs, defaultPlan, annualMortgagePayment } from '../../engine.js';

// ── Property mortgage (engine-native amortization) ──────────────────────────
// The mortgage is amortized to a fixed annual payment and run through the tested
// liability path: it charges until payoff, then stops. purchasePrice is inert.
test('annualMortgagePayment matches the standard amortization formula', () => {
  // $300k, 6% APR, 30yr → ~$1798.65/mo → ~$21,583.81/yr.
  const pay = annualMortgagePayment(300000, 6, 30);
  assert.ok(Math.abs(pay - 21583.81) < 1.0, `expected ~21583.81/yr, got ${pay.toFixed(2)}`);
  assert.strictEqual(annualMortgagePayment(0, 6, 30), 0, 'no balance → no payment');
  assert.strictEqual(annualMortgagePayment(300000, 6, 0), 0, 'no term → no payment');
  // 0% loan = straight-line: 120000 / 10yr = 12000/yr.
  assert.ok(Math.abs(annualMortgagePayment(120000, 0, 10) - 12000) < 1e-6, '0% APR → straight-line');
});

test('a property mortgage becomes an amortized liability that stops at payoff', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  p.properties = [{
    name:'Primary residence', value:900000, purchasePrice:400000,
    mortgage:{ balance:300000, rate:6, termYears:10 }
  }];
  const r = resolveInputs(p, {});
  assert.strictEqual(r.liabilities.length, 1, 'mortgage folded into liabilities');
  assert.ok(Math.abs(r.liabilities[0].amount - annualMortgagePayment(300000, 6, 10)) < 1e-6,
    'liability amount = amortized annual payment');
  assert.strictEqual(r.liabilities[0].endAge, 75, 'payoff = startAge + termYears');
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  assert.ok(m.rows.find(r => r.age === 70).liabilities > 0, 'mortgage charged while active');
  assert.strictEqual(m.rows.find(r => r.age === 80).liabilities, 0, 'gone after payoff');
});

test('purchasePrice / value are inert — they move no current number', () => {
  const withProp = JSON.parse(JSON.stringify(defaultPlan));
  withProp.properties = [{ name:'House', value:900000, purchasePrice:400000 }];  // no mortgage
  const without = JSON.parse(JSON.stringify(defaultPlan));
  const a = runHistoricalPath(withProp, 1995, 'taxable-first');
  const b = runHistoricalPath(without,  1995, 'taxable-first');
  assert.strictEqual(a.terminalBalance, b.terminalBalance, 'a mortgage-less property changes nothing today');
});

test('a pre-retirement lump sum debits the portfolio (no longer ignored in accumulation)', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  // Keep this accumulation-only assertion before RMD age; RMD disposition is
  // covered independently and must not collapse both terminal balances.
  p.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 72 };
  const base = runHistoricalPath(p, 1995, 'taxable-first');
  const buy  = runHistoricalPath(p, 1995, 'taxable-first', undefined, { lumpSum: 200000, lumpSumYear: 0 });
  assert.ok(buy.terminalBalance < base.terminalBalance - 1,
    'a $200k purchase at current age (accumulation) must reduce ending wealth');
});

// ── Earmarked-asset sale ("sell this to fund that") ─────────────────────────
// A sale is an OVERRIDE, never baked into the base plan, so the Baseline stays
// clean. Net proceeds = value − mortgage payoff − agent commission − cap-gains
// tax, landing in the taxable sleeve. Selling at the current age makes the
// nominal/real bridge 1, so the numbers are exact and easy to verify.
const houseplan = () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  p.taxes = { ordinary: 22, capitalGains: 15 };
  p.properties = [{ name:'Home', value:1000000, purchasePrice:400000, commissionPct:0 }];  // no mortgage
  return p;
};

test('a sale with no override = nothing happens (Baseline stays clean)', () => {
  const p = houseplan();
  const r = resolveInputs(p, {});
  assert.strictEqual(r.assetSale, null, 'no assetSale override → no sale resolved');
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  assert.ok(m.rows.every(x => !x.assetSale), 'no proceeds injected anywhere on the baseline');
});

test('net proceeds = value − commission − cap-gains tax (no mortgage, sold today)', () => {
  const p = houseplan();
  // value 1,000,000, basis 400,000, 0% commission, 15% cap-gains, k=0 (f=1):
  // gain 600,000 → tax 90,000 → net 910,000.
  const r = resolveInputs(p, { assetSale: { asset: 0, age: 65 } });
  assert.ok(r.assetSale, 'sale resolved');
  assert.ok(Math.abs(r.assetSale.netProceeds - 910000) < 1, `expected 910,000 net, got ${r.assetSale.netProceeds.toFixed(0)}`);
  assert.ok(Math.abs(r.assetSale.capGainsTax - 90000) < 1, 'cap-gains tax = 15% of the 600k gain');
});

test('agent commission is deducted from gross proceeds', () => {
  const p = houseplan();
  const noComm = resolveInputs(p, { assetSale: { asset: 0, age: 65 } }).assetSale.netProceeds;
  p.properties[0].commissionPct = 5;
  // 5% of 1,000,000 = 50,000 commission. Gain now (950,000−400,000)=550,000 →
  // tax 82,500. Net = 1,000,000 − 50,000 − 82,500 = 867,500.
  const withComm = resolveInputs(p, { assetSale: { asset: 0, age: 65 } }).assetSale;
  assert.ok(Math.abs(withComm.commission - 50000) < 1, 'commission = 5% of gross');
  assert.ok(Math.abs(withComm.netProceeds - 867500) < 1, `expected 867,500 net, got ${withComm.netProceeds.toFixed(0)}`);
  assert.ok(withComm.netProceeds < noComm, 'commission lowers net proceeds');
});

test('proceeds land in the taxable sleeve at the sale age and are reported on the row', () => {
  const p = houseplan();
  const m = runHistoricalPath(p, 1995, 'taxable-first', undefined, { assetSale: { asset: 0, age: 70 } });
  const at69 = m.rows.find(r => r.age === 69);
  const at70 = m.rows.find(r => r.age === 70);
  assert.strictEqual(at69.assetSale, 0, 'no proceeds before the sale year');
  assert.ok(at70.assetSale > 0, 'proceeds reported in the sale year');
  // taxable balance must jump by roughly the proceeds (net of that year's draw/return)
  assert.ok(at70.accountBalances.taxable > at69.accountBalances.taxable,
    'the taxable sleeve grows when the sale lands');
});

test('selling mid-mortgage stops the payments at the sale and nets out the payoff', () => {
  const p = houseplan();
  p.properties[0].mortgage = { balance: 500000, rate: 0, termYears: 10 };  // 0% → straight-line
  // Sell at 70 (5 of 10 yrs elapsed): remaining nominal payoff = 250,000.
  const sold = runHistoricalPath(p, 1995, 'taxable-first', undefined, { assetSale: { asset: 0, age: 70 } });
  assert.ok(sold.rows.find(r => r.age === 69).liabilities > 0, 'mortgage paid while held');
  // The SALE YEAR pays no mortgage: the payoff (deducted from proceeds) already
  // settles the remaining balance — paying again here would double-count it.
  assert.strictEqual(sold.rows.find(r => r.age === 70).liabilities, 0, 'no mortgage payment in the sale year');
  assert.strictEqual(sold.rows.find(r => r.age === 72).liabilities, 0, 'mortgage stops after the sale');
  // Net is lower than the unmortgaged case because the payoff is deducted.
  const free = resolveInputs(houseplan(), { assetSale: { asset: 0, age: 70 } }).assetSale.netProceeds;
  const mort = resolveInputs(p,           { assetSale: { asset: 0, age: 70 } }).assetSale;
  assert.ok(Math.abs(mort.mortgagePayoff - 250000 / Math.pow(1.025, 5)) < 1,
    'payoff = remaining balance, deflated to today\'s dollars');
  assert.ok(mort.netProceeds < free, 'the mortgage payoff reduces net proceeds');
});

test('a property with no entered cost basis assumes basis = value (no phantom gain)', () => {
  const p = houseplan();
  delete p.properties[0].purchasePrice;          // basis not entered
  const r = resolveInputs(p, { assetSale: { asset: 0, age: 65 } }).assetSale;
  // No basis → fall back to value → zero gain → zero cap-gains tax (NOT the whole
  // price taxed). With 0% commission and k=0, net = full value.
  assert.strictEqual(r.capGainsTax, 0, 'no substantiated basis → no invented gain');
  assert.ok(Math.abs(r.netProceeds - 1000000) < 1, 'net = full value when no gain and no costs');
});

test('selling an asset can rescue a plan that would otherwise run dry', () => {
  // A thin portfolio against heavy spending: fails on its own; the sale funds it.
  const p = houseplan();
  p.portfolio.accounts = { taxable:{balance:300000,basisPct:1}, traditional:{balance:0}, roth:{balance:0} };
  p.expenses = { living: 78000, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0 };
  p.income.other = [];
  const horizon = 95 - 65 + 1;
  const bundle = Array.from({ length: 300 }, () => generateReturnPath(horizon));
  const keep = runSimulation(p, {}, bundle);
  const sell = runSimulation(p, { assetSale: { asset: 0, age: 66 } }, bundle);
  assert.ok(sell.successRate > keep.successRate + 1,
    `selling to fund spending must raise success (keep ${keep.successRate}%, sell ${sell.successRate}%)`);
});

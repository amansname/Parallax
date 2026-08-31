// Engine contract: income streams. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { runHistoricalPath, resolveInputs, defaultPlan } from '../../engine.js';

// Pension benefit-by-age: discrete lookup, no interpolation, no extrapolation.
// The engine only pays the amount entered for the EXACT chosen age — a missing
// age pays 0, never an inferred number. This is the truth-source rule for
// pension data: we don't invent what wasn't on the statement.
test('pension uses discrete benefit-by-age map', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.income.pension = { benefitByAge: { 62: 36000, 65: 48000 }, startAge: 65, colaPct: 0 };
  const at65 = resolveInputs(p, { pensionStartAge: 65 });
  const at62 = resolveInputs(p, { pensionStartAge: 62 });
  const at64 = resolveInputs(p, { pensionStartAge: 64 });
  assert.strictEqual(at65.pension.amount, 48000, 'age 65 → entered $48k');
  assert.strictEqual(at62.pension.amount, 36000, 'age 62 → entered $36k');
  assert.strictEqual(at64.pension.amount, 0,     'age 64 has no entry → 0, never invented');
  assert.strictEqual(at62.pension.startAge, 62,  'pensionStartAge override sets start age');
});

test('other income streams report during accumulation years', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 40, retirementAge: 65, planEndAge: 95 };
  p.income.other = [{ label: 'Wages', amount: 150000, startAge: 40, endAge: 64 }];
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  const at45 = m.rows.find(r => r.age === 45);
  const at64 = m.rows.find(r => r.age === 64);
  const at65 = m.rows.find(r => r.age === 65);
  assert.strictEqual(at45.phase, 'accum');
  assert.strictEqual(at45.otherIncome, 150000);
  assert.strictEqual(at64.otherIncome, 150000);
  assert.strictEqual(at65.otherIncome, 0, 'wages ended the year before retirement');
});

test('current-year realized-gain tax facts do not create engine cash flow', () => {
  const p = structuredClone(defaultPlan);
  const base = runHistoricalPath(p, 1995, 'taxable-first');
  p.incomeTax.realizedGains = { shortTerm:25000, longTerm:75000 };
  const withTaxFacts = runHistoricalPath(p, 1995, 'taxable-first');
  assert.deepStrictEqual(withTaxFacts.rows, base.rows,
    'tax-only realized gains must not reduce withdrawals or alter portfolio balances');
});

test('accumulation rows report shortcut tax without funding from the portfolio', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 40, retirementAge: 65, planEndAge: 95 };
  p.portfolio.accounts = { taxable: { balance: 500000, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } };
  p.income.other = [{ label: 'Wages', amount: 200000, startAge: 40, endAge: 64, taxablePct: 1 }];
  p.savings.annual = 0;
  p.goals = [];
  const taxed = runHistoricalPath(p, 1995, 'taxable-first');
  p.income.other = [];
  const untaxed = runHistoricalPath(p, 1995, 'taxable-first');
  const row = taxed.rows.find(r => r.age === 50);
  assert.strictEqual(row.phase, 'accum');
  assert.ok(row.taxes > 0, 'working-year wages must produce shortcut income tax on the row');
  assert.strictEqual(row.netCashflow, 0, 'implicit spending stays off-books');
  assert.ok(Math.abs(row.taxBySource.oi - row.taxes) < 0.01, 'wage tax must land in taxBySource.oi');
  const taxedBal = taxed.rows.find(r => r.age === 64).balance;
  const untaxedBal = untaxed.rows.find(r => r.age === 64).balance;
  assert.ok(Math.abs(taxedBal - untaxedBal) < 1,
    'display-only accumulation tax must not change portfolio balances');
});

test('other income: multiple timed streams sum while active and stop at endAge', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  p.income.other = [
    { label:'Rental',    amount:24000, startAge:65, endAge:75 },
    { label:'Part-time', amount:30000, startAge:65, endAge:70 },
  ];
  const r = resolveInputs(p, {});
  assert.strictEqual(r.otherIncome.length, 2, 'both streams resolved');
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  const at66 = m.rows.find(r => r.age === 66).otherIncome;  // both active
  const at72 = m.rows.find(r => r.age === 72).otherIncome;  // only rental
  const at80 = m.rows.find(r => r.age === 80).otherIncome;  // neither
  assert.strictEqual(at66, 54000, 'both streams active → summed');
  assert.strictEqual(at72, 24000, 'part-time ended → only rental');
  assert.strictEqual(at80, 0, 'both ended → no other income');
});

test('a legacy single other-income object is still honored', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.income.other = { amount: 12000, startAge: 0, endAge: 999 };
  const r = resolveInputs(p, {});
  assert.strictEqual(r.otherIncome.length, 1, 'single object wrapped into one stream');
  assert.strictEqual(r.otherIncome[0].amount, 12000, 'amount preserved');
});

// ── Other income: per-stream real growth and taxable share ──────────────────
// A stream grows in REAL terms from its own startAge (negative = phases down),
// and only its taxable share is taxed at the ordinary rate. Both default to the
// legacy flat-real, fully-taxed behavior.
test('other-income streams default to flat-real, fully taxable', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.income.other = [{ label:'Rent', amount:12000, startAge:65, endAge:80 }];
  const r = resolveInputs(p, {});
  assert.strictEqual(r.otherIncome[0].realGrowth, 0, 'no real growth by default');
  assert.strictEqual(r.otherIncome[0].taxablePct, 1, 'fully taxable by default');
});

test('other-income realGrowth compounds the stream (negative phases it down)', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  p.income.other = [
    { label:'Rental',    amount:24000, startAge:65, endAge:95, realGrowth: 0.03 },  // rises
    { label:'Part-time', amount:24000, startAge:65, endAge:95, realGrowth:-0.10 },  // winds down
  ];
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  const oi65 = m.rows.find(r => r.age === 65).otherIncome;
  const oi75 = m.rows.find(r => r.age === 75).otherIncome;
  const expect75 = 24000 * Math.pow(1.03, 10) + 24000 * Math.pow(0.90, 10);
  assert.ok(Math.abs(oi65 - 48000) < 1e-6, 'both streams at base in the first year');
  assert.ok(Math.abs(oi75 - expect75) < 1.0,
    `at 75 the grown + decayed streams should sum to ~${expect75.toFixed(0)}, got ${oi75.toFixed(0)}`);
});

test('a partly tax-free stream is taxed less than a fully-taxable one (higher ending wealth)', () => {
  const mk = taxablePct => {
    const p = JSON.parse(JSON.stringify(defaultPlan));
    p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
    p.income.other = [{ label:'Annuity', amount:60000, startAge:65, endAge:95, taxablePct }];
    return runHistoricalPath(p, 1995, 'taxable-first');
  };
  const fully = mk(1);
  const half  = mk(0.5);
  assert.ok(half.terminalBalance > fully.terminalBalance + 1,
    'lower taxable share → less tax → higher ending wealth');
  assert.strictEqual(half.rows.find(r => r.age === 70).otherIncome,
                     fully.rows.find(r => r.age === 70).otherIncome,
    'taxablePct changes tax only, not the gross income shown');
});

test('engine rows expose taxable other income matching taxBySource', () => {
  const run = (taxablePct) => {
    const p = JSON.parse(JSON.stringify(defaultPlan));
    p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
    p.income.other = [{ label:'Annuity', amount:60000, startAge:65, endAge:95, taxablePct }];
    const params = resolveInputs(p, {});
    const row = runHistoricalPath(p, 1995, 'taxable-first').rows.find(r => r.age === 70);
    return { params, row };
  };

  const half = run(0.5);
  assert.strictEqual(half.row.otherIncome, 60000);
  assert.strictEqual(half.row.otherIncomeTaxable, 30000);
  assert.ok(Math.abs(
    half.row.otherIncomeTaxable - (half.row.taxBySource.oi / half.params.taxRates.ordinary)
  ) < 1e-9);

  const fully = run(undefined);
  assert.strictEqual(fully.params.otherIncome[0].taxablePct, 1);
  assert.strictEqual(fully.row.otherIncomeTaxable, fully.row.otherIncome);
});

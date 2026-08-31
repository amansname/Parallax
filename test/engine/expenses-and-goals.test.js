// Engine contract: expenses and goals. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { runHistoricalPath, runSinglePath, analyzeResults, resolveInputs, defaultPlan, LONGRUN_INFLATION } from '../../engine.js';
import { flatAssetReturnRow } from './fixtures.js';

// ── Recurring liabilities (e.g. a mortgage) ─────────────────────────────────
// A time-bounded fixed obligation must (1) reduce the portfolio while active,
// (2) erode in real terms when colaPct=0 (a fixed-nominal payment gets cheaper),
// and (3) stop at endAge. Modeled like the pension's nominal→real conversion.
test('resolveInputs converts a 0%-COLA liability to a real-eroding stream', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.liabilities = [{ label:'mortgage', amount:48000, startAge:65, endAge:94, colaPct:0 }];
  const r = resolveInputs(p, {});
  assert.strictEqual(r.liabilities.length, 1, 'liability resolved');
  assert.ok(Math.abs(r.liabilities[0].colaReal - (-LONGRUN_INFLATION)) < 1e-9,
    '0% COLA → colaReal = −LONGRUN_INFLATION (erodes in real terms)');
  assert.strictEqual(r.liabilities[0].amount, 48000, 'amount preserved');
});

test('a recurring liability lowers retirement wealth and stops at endAge', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));   // retire-now (65), funded
  const mort = JSON.parse(JSON.stringify(defaultPlan));
  mort.liabilities = [{ label:'mortgage', amount:48000, startAge:65, endAge:80, colaPct:0 }];
  const b = runHistoricalPath(base, 1995, 'taxable-first');
  const m = runHistoricalPath(mort, 1995, 'taxable-first');
  assert.ok(m.terminalBalance < b.terminalBalance - 1, 'mortgage must lower ending wealth');
  // the liability appears in active years and is gone after endAge
  const active = m.rows.find(r => r.age === 70);
  const after  = m.rows.find(r => r.age === 85);
  assert.ok(active && active.liabilities > 0, 'liability charged while active (age 70)');
  assert.ok(after && (after.liabilities || 0) === 0, 'liability gone after endAge (age 85)');
  // real erosion: the charge at 75 is smaller than at 65 (fixed nominal shrinks)
  const at65 = m.rows.find(r => r.age === 65).liabilities;
  const at75 = m.rows.find(r => r.age === 75).liabilities;
  assert.ok(at75 < at65, 'a fixed-nominal liability erodes in real terms over time');
});

// expenses.extra: discretionary, time-bounded, and flexes with the spending lever.
// Spending now lives on the Goals page, so a time-bounded discretionary expense
// IS a goal. The behaviors asserted here are unchanged — it lowers wealth, stops
// at endAge, and flexes with the spending lever — only the channel it is read
// from moved.
test('a discretionary extra expense lowers wealth, stops at endAge, and flexes with spendMult', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));
  const exp  = JSON.parse(JSON.stringify(defaultPlan));
  exp.expenses.extra = [{ label:'Go-go travel', amount:40000, startAge:65, endAge:75 }];
  const b = runHistoricalPath(base, 1995, 'taxable-first');
  const e = runHistoricalPath(exp,  1995, 'taxable-first');
  assert.ok(e.terminalBalance < b.terminalBalance - 1, 'extra spending must lower ending wealth');
  const at70 = e.rows.find(r => r.age === 70).goals;
  const at80 = e.rows.find(r => r.age === 80).goals;
  assert.ok(at70 > at80, 'extra expense active at 70, gone by 80');
  // spendMult still scales discretionary spending: a +20% bump raises the amount.
  const bumped = resolveInputs(exp, { spendBump: 0.20 });
  const travel = bumped.goals.find(g => g.name === 'Go-go travel');
  assert.ok(travel, 'the extra expense resolves as a goal');
  assert.ok(Math.abs(travel.amount - 48000) < 1e-6, 'extra flexes with spendMult');
});

// goals: a ONE-TIME goal is a single-year window; it hits exactly one year.
test('a one-time goal (startAge===endAge) charges exactly one year', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  p.goals = [{ name:'Wedding', amount:60000, startAge:68, endAge:68 }];
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  assert.strictEqual(m.rows.find(r => r.age === 67).goals, 0, 'nothing before the year');
  assert.strictEqual(m.rows.find(r => r.age === 68).goals, 60000, 'full hit in the goal year');
  assert.strictEqual(m.rows.find(r => r.age === 69).goals, 0, 'nothing after');
});

test('pre-retirement goals stay off-book unless portfolio funding is explicit', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));
  base.household.primary = { currentAge: 55, retirementAge: 65, planEndAge: 90 };
  base.goals = [];
  const offBook = JSON.parse(JSON.stringify(base));
  offBook.goals = [{ name:'College', amount:50000, startAge:58, endAge:61 }];
  const funded = JSON.parse(JSON.stringify(offBook));
  funded.goals[0].fundFromPortfolioBeforeRetirement = true;
  const m0 = runHistoricalPath(base, 1995, 'taxable-first');
  const m1 = runHistoricalPath(offBook, 1995, 'taxable-first');
  const m2 = runHistoricalPath(funded, 1995, 'taxable-first');
  assert.strictEqual(m1.rows.find(r => r.age === 58).goals, 0,
    'working-year goal is not treated as a portfolio draw by default');
  assert.strictEqual(m2.rows.find(r => r.age === 58).goals, 50000,
    'explicitly portfolio-funded goal hits in its first selected year');
  assert.strictEqual(m2.rows.find(r => r.age === 61).goals, 50000,
    'explicitly portfolio-funded goal hits through its selected end year');
  const end0 = m0.rows[m0.rows.length - 1].balance;
  const end1 = m1.rows[m1.rows.length - 1].balance;
  const end2 = m2.rows[m2.rows.length - 1].balance;
  assert.strictEqual(end1, end0, 'off-book working-year goal does not alter portfolio wealth');
  assert.ok(end2 < end0, 'explicitly funded working-year goal lowers ending wealth');
});

test('an underfunded pre-retirement portfolio goal fails when the required cash flow is missed', () => {
  const p = structuredClone(defaultPlan);
  p.meta = { ...p.meta, spendingSchemaVersion: 1 };
  p.household.primary = { currentAge: 55, retirementAge: 58, planEndAge: 58 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.savings = { ...p.savings, annual: 10_000 };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.income.other = [];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.liabilities = [];
  p.properties = [];
  p.goals = [{
    name: 'College', amount: 50_000, startAge: 55, endAge: 55,
    fundFromPortfolioBeforeRetirement: true,
  }];
  p.ltc = { amount: 0, onsetAge: 99 };
  p.taxes = { ordinary: 0, capitalGains: 0 };

  const inputs = resolveInputs(p, {});
  const path = Array.from(
    { length: inputs.horizonYears },
    (_, index) => flatAssetReturnRow(2026 + index),
  );
  const sim = runSinglePath(inputs, path);
  const result = analyzeResults([sim], inputs);
  const goalYear = sim.rows[0];

  assert.equal(goalYear.goals, 50_000);
  assert.equal(goalYear.withdrawal, 10_000, 'available savings must be reported as the portfolio draw');
  assert.deepEqual(goalYear.accountBreakdown, { taxable: 0, traditional: 10_000, roth: 0 });
  assert.equal(goalYear.fundingShortfall, 40_000, 'the unmet required cash flow must not disappear');
  assert.equal(goalYear.failed, true);
  assert.equal(sim.failed, true);
  assert.equal(sim.depletionAge, 55);
  assert.equal(result.successRate, 0);
  assert.ok(sim.rows.slice(1).every(row => row.failed), 'later savings cannot erase an earlier missed obligation');
});

test('terminal funding distinguishes exact zero from a negative-return shortfall', () => {
  const p = structuredClone(defaultPlan);
  p.meta = { ...p.meta, spendingSchemaVersion: 1 };
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 100_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.savings = { ...p.savings, annual: 0 };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.income.other = [];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.liabilities = [];
  p.properties = [];
  p.goals = [{ name: 'Final gift', amount: 100_000, startAge: 65, endAge: 65 }];
  p.ltc = { amount: 0, onsetAge: 99 };
  p.taxes = { ordinary: 0, capitalGains: 0 };

  const inputs = resolveInputs(p, {});
  const path = [flatAssetReturnRow(2026)];
  const ordinary = runSinglePath(inputs, path);
  const federal = runSinglePath(inputs, path, {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });

  for(const sim of [ordinary, federal]){
    assert.equal(sim.rows[0].withdrawal, 100_000);
    assert.equal(sim.rows[0].fundingShortfall, 0);
    assert.equal(sim.rows[0].balance, 0);
    assert.equal(sim.rows[0].failed, false);
    assert.equal(sim.failed, false);
    assert.equal(analyzeResults([sim], inputs).successRate, 100);
  }

  const negativePath = [flatAssetReturnRow(2026, -0.5)];
  const negativeOrdinary = runSinglePath(inputs, negativePath);
  const negativeFederal = runSinglePath(inputs, negativePath, {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });

  for(const sim of [negativeOrdinary, negativeFederal]){
    const row = sim.rows[0];
    assert.ok(row.withdrawal > 0 && row.withdrawal < 100_000);
    assert.ok(row.fundingShortfall > 0);
    assert.ok(Math.abs(row.withdrawal + row.fundingShortfall - 100_000) <= 0.01);
    assert.equal(row.balance, 0);
    assert.equal(row.failed, true);
    assert.equal(sim.failed, true);
    assert.equal(analyzeResults([sim], inputs).successRate, 0);
  }
});

test('a zero-asset terminal year succeeds when no modeled cash flow is required', () => {
  const p = structuredClone(defaultPlan);
  p.meta = { ...p.meta, spendingSchemaVersion: 1 };
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.savings = { ...p.savings, annual: 0 };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.income.other = [];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.liabilities = [];
  p.properties = [];
  p.goals = [];
  p.ltc = { amount: 0, onsetAge: 99 };
  p.taxes = { ordinary: 0, capitalGains: 0 };

  const inputs = resolveInputs(p, {});
  const sim = runSinglePath(inputs, [flatAssetReturnRow(2026)]);

  assert.equal(sim.rows[0].fundingShortfall, 0);
  assert.equal(sim.rows[0].balance, 0);
  assert.equal(sim.failed, false);
  assert.equal(analyzeResults([sim], inputs).successRate, 100);
});

test('a legacy { vacation, property, gifts } goals object still resolves', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.goals = { vacation: 15000, property: 10000, gifts: 5000 };
  // Isolate the object→array conversion: the default plan also carries legacy
  // plan.expenses, which now folds into its own goals.
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
  const r = resolveInputs(p, {});
  assert.strictEqual(r.goals.length, 3, 'object converted to three always-on entries');
  const total = r.goals.reduce((s, g) => s + g.amount, 0);
  assert.strictEqual(total, 30000, 'amounts preserved');
});

test('empty liabilities = byte-identical to before (no regression)', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  const withEmpty = runHistoricalPath(p, 1973, 'taxable-first');
  p.liabilities = [];
  const explicit = runHistoricalPath(p, 1973, 'taxable-first');
  assert.strictEqual(withEmpty.terminalBalance, explicit.terminalBalance, 'no liabilities → unchanged');
});

// ── Healthcare: separate from lifestyle spending ─────────────────────────────
// Healthcare is NOT discretionary — the spend lever must not move it.
// It grows at its own real rate (healthcareRealGrowth) from retirement forward.
test('spendBump does NOT scale healthcare costs', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));
  base.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  base.expenses.living = 100000;
  base.expenses.healthcare = 15000;
  base.expenses.healthcareRealGrowth = 0;   // disable growth for isolation
  const rBase   = resolveInputs(base, {});
  const rBumped = resolveInputs(base, { spendBump: 0.50 });
  assert.strictEqual(rBumped.expenses.healthcare, 15000,
    'healthcare must NOT be scaled by spendBump');
  assert.ok(Math.abs(rBumped.expenses.living - 150000) < 1e-6,
    'lifestyle spending IS scaled by spendBump');
  assert.strictEqual(rBase.expenses.healthcare, 15000, 'base healthcare untouched');
});

test('healthcare real growth raises costs over retirement years', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  p.expenses.healthcareRealGrowth = 0.03;  // 3% above CPI
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  // After 10 years of retirement (age 75), healthcare in the row should be
  // noticeably higher than at retirement (age 65). We read it from the expenses
  // row delta — not exact because other expense components are flat, but the
  // total expenses at 75 must exceed those at 65 by more than a rounding error.
  // (expenses = living + housing + debt + healthcare*growth + extras)
  const at65 = m.rows.find(r => r.age === 65).expenses;
  const at75 = m.rows.find(r => r.age === 75).expenses;
  const expectedHealthcareDelta = p.expenses.healthcare * (Math.pow(1.03, 10) - 1);
  assert.ok(at75 > at65 + expectedHealthcareDelta * 0.9,
    'healthcare real growth must lift total expenses over retirement');
});

test('livingAnnual models positive scenario spending over a zero-dollar base', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 100_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, { livingAnnual: 24_000 });
  const result = runSinglePath(params, [flatAssetReturnRow(2026)], {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });

  assert.equal(params.expenses.living, 24_000);
  assert.equal(result.rows[0].expenses, 24_000);
  assert.equal(result.rows[0].withdrawal, 24_000);
  assert.equal(result.rows[0].taxFundingConvergence.taxSavingsReinvested, 0);
});

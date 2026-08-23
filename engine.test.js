/* Engine guard tests. Run with: node --test  (Node 18+)
   These lock the engine's core behavior so the UI can be rebuilt freely
   without silently breaking the math. If you change engine.js and these
   fail, STOP and reconcile before continuing. */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  RETURN_DATA, RISK_PROFILES, generateReturnPath, runSimulation,
  runHistoricalPath, runSinglePath, analyzeResults, resolveInputs, defaultPlan, LONGRUN_INFLATION,
  annualMortgagePayment, resetSeed, resolveHouseholdTimeline, householdStateAtYear,
  householdIncomeAtYear, resolveWithdrawalPlannerAccountState,
  approveWithdrawalPlannerLeverChange, buildWithdrawalPlannerCashContract
} from './engine.js';
import { createFederalTaxResolver } from './src/planning/tax/createFederalTaxResolver.js';
import { createAccount } from './src/household/createAccount.js';
import { resolvePortfolioAccounts } from './src/household/resolvePortfolioAccounts.js';
import { migrateSpendingToGoals } from './src/household/migrateSpendingToGoals.js';

function explicitlyBasedBrokerage(balance, basisAmount){
  const account = createAccount('brokerage_taxable', {
    owner: 'client',
    balance,
  });
  account.basis = {
    amount: basisAmount,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-08-19T12:00:00.000Z',
    version: 1,
  };
  return account;
}

test('return data spans the full history', () => {
  assert.ok(RETURN_DATA.length >= 90, 'expected ~98 years of returns');
});

test('a return path matches the requested horizon', () => {
  const p = generateReturnPath(30);
  assert.strictEqual(p.length, 30);
});

test('runSimulation returns a success rate in [0,100]', () => {
  const r = runSimulation(defaultPlan, {});
  assert.ok(r.successRate >= 0 && r.successRate <= 100);
  assert.ok(r.terminal && typeof r.terminal.p50 === 'number');
});

test('shared paths make identical inputs reproducible', () => {
  const horizon = resolveInputs(defaultPlan, {}).horizonYears;
  const bundle = Array.from({length: 300}, () => generateReturnPath(horizon));
  const a = runSimulation(defaultPlan, {}, bundle);
  const b = runSimulation(defaultPlan, {}, bundle);
  assert.strictEqual(Math.round(a.successRate), Math.round(b.successRate),
    'same inputs + same paths must give the same success rate');
});

test('higher-equity allocation has a higher expected return', () => {
  const w3 = RISK_PROFILES[3].weights, w5 = RISK_PROFILES[5].weights;
  assert.ok(w5.usLarge >= w3.usLarge, 'R5 should hold more equity than R3');
});

test('a known bad sequence (retire into 1973) is materially worse than average', () => {
  const hist = runHistoricalPath(defaultPlan, 1973, 'taxable-first');
  assert.ok(hist && (hist.rows || hist).length > 0, 'historical path should produce rows');
});

test('default runHistoricalPath is identical to the explicit shortcut tax policy', () => {
  const defaultResult = runHistoricalPath(defaultPlan, 1973, 'taxable-first');
  const explicitShortcutResult = runHistoricalPath(
    defaultPlan,
    1973,
    'taxable-first',
    undefined,
    undefined,
    { taxPolicy: (_row, { shortcutTax }) => shortcutTax }
  );

  assert.deepStrictEqual(defaultResult, explicitShortcutResult);
});

// Sequence Stress must be measured from RETIREMENT start, not plan start. For a
// still-working client (currentAge < retirementAge), the first accumulation years
// carry no sequence-of-returns risk (no withdrawals), so they must NOT drive which
// path is labeled "stressed". The selector sorts by balanceAtRet10 (balance after
// 10 retirement years), never balanceAt10 (plan-year 10). Regression for the
// 58-retire-at-65 contamination case.
test('Sequence Stress is retirement-relative, not contaminated by accumulation years', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 95 };
  p.savings = { annual: 30000, split: { traditional: 1, roth: 0, taxable: 0 } };
  const horizon = resolveInputs(p, {}).horizonYears; // ages 58 through 95, inclusive
  // Fixed seed + fixed bundle → fully deterministic selection, so the assertions
  // are reproducible across runs and machines.
  resetSeed(20260615);
  const bundle = Array.from({ length: 400 }, () => generateReturnPath(horizon));
  const res = runSimulation(p, {}, bundle);

  // (1) Every sim exposes the retirement-relative probe as a finite number.
  assert.ok(res.sims.every(s => Number.isFinite(s.balanceAtRet10)),
    'balanceAtRet10 must be present and finite on every sim');

  // (2) The capture window is retirement year 10 (age retirementAge+9 = 74), NOT
  //     plan-year 10 (age 67). Prove it against the actual row balance.
  const sample = res.sims.find(s => !s.failed) || res.sims[0];
  const ret10Row = sample.rows.find(r => r.age === 65 + 9);   // age 74
  const plan10Row = sample.rows.find(r => r.age === 58 + 9);  // age 67
  assert.ok(ret10Row, 'a surviving sim should reach retirement year 10 (age 74)');
  assert.strictEqual(sample.balanceAtRet10, ret10Row.balance,
    'balanceAtRet10 must equal the end balance at age 74 (10th retirement year)');
  assert.strictEqual(sample.balanceAt10, plan10Row.balance,
    'balanceAt10 (untouched) must still equal the end balance at plan-year 10 (age 67)');
  assert.notStrictEqual(ret10Row.age, plan10Row.age,
    'the two windows must be genuinely different when accumulation years exist');

  // (3) The selector ranks by balanceAtRet10: re-derive the ordering and confirm
  //     the engine's stressed (p10) and favorable (p90) picks match it. This proves
  //     accumulation-year balances are not what chooses the stressed path.
  const ns = res.sims.length;
  const bySeq = res.sims.slice().sort((a, b) => {
    if (a.balanceAtRet10 !== b.balanceAtRet10) return a.balanceAtRet10 - b.balanceAtRet10;
    return a.terminalBalance - b.terminalBalance;
  });
  assert.strictEqual(res.paths.p10.balanceAtRet10, bySeq[Math.floor(ns * 0.10)].balanceAtRet10,
    'stressed path (p10) must be the 10th-percentile by retirement-relative balance');
  assert.strictEqual(res.paths.p90.balanceAtRet10, bySeq[Math.floor(ns * 0.90)].balanceAtRet10,
    'favorable path (p90) must be the 90th-percentile by retirement-relative balance');
  assert.ok(res.paths.p10.balanceAtRet10 <= res.paths.p90.balanceAtRet10,
    'stressed early-retirement balance must not exceed the favorable one');
});

// Sequencing tab relies on this: reversing a real path must reuse the SAME
// returns in the opposite order — never invent or drop any. We check the
// multiset of source years is identical (same returns) but the sequence differs.
test('reversed historical path = same returns, opposite order', () => {
  // Use a richly funded plan so BOTH orders survive the full horizon — then the
  // sequence of return-years is directly comparable (depletion would truncate
  // one and confound the multiset check; that survival flips with order is the
  // feature itself, tested implicitly by the lean-plan 1973 test above).
  const rich = JSON.parse(JSON.stringify(defaultPlan));
  rich.portfolio.accounts.taxable.balance     = 20e6;
  rich.portfolio.accounts.traditional.balance = 0;
  rich.portfolio.accounts.roth.balance        = 0;
  const fwd = runHistoricalPath(rich, 1973, 'taxable-first');
  const rev = runHistoricalPath(rich, 1973, 'taxable-first', p => p.slice().reverse());
  assert.ok(rev && rev.rows.length > 0, 'reversed path should produce rows');
  const fy = fwd.rows.filter(r => r.source != null).map(r => r.source);
  const ry = rev.rows.filter(r => r.source != null).map(r => r.source);
  assert.deepStrictEqual([...fy].sort((a,b)=>a-b), [...ry].sort((a,b)=>a-b), 'identical set of return years');
  assert.notDeepStrictEqual(fy, ry, 'order must actually differ');
  assert.deepStrictEqual(ry, [...fy].reverse(), 'reversed = forward backwards');
});

// Sequencing honors a chosen scenario, not just its allocation: overrides must
// flow through runHistoricalPath the same way they do for the Monte Carlo path.
test('historical path honors overrides (e.g. a spending bump)', () => {
  // Rich plan so both runs survive (a depleted plan floors at $0 either way and
  // wouldn't reveal whether the override flowed through).
  const rich = JSON.parse(JSON.stringify(defaultPlan));
  rich.portfolio.accounts.taxable.balance     = 20e6;
  rich.portfolio.accounts.traditional.balance = 0;
  rich.portfolio.accounts.roth.balance        = 0;
  const base   = runHistoricalPath(rich, 1973, 'taxable-first');
  const spendy = runHistoricalPath(rich, 1973, 'taxable-first', undefined, { spendBump: 0.5 });
  assert.ok(base && spendy, 'both runs produce a result');
  assert.ok(spendy.terminalBalance < base.terminalBalance - 1,
    'a +50% spend override must lower the historical ending balance');
});

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

// ── Multi-row income / expenses / goals (the add-row data model) ─────────────
// income.other is now an ARRAY of timed streams: each is summed only while active,
// and a legacy single object is still accepted.
test('annual savings increases terminal wealth during accumulation', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 40, retirementAge: 65, planEndAge: 95 };
  p.portfolio.accounts = { taxable: { balance: 500000, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } };
  p.goals = [];
  p.savings.annual = 0;
  const base = runHistoricalPath(p, 1995, 'taxable-first');
  p.savings.annual = 50000;
  p.savings.split = { taxable: 1, traditional: 0, roth: 0 };
  const saving = runHistoricalPath(p, 1995, 'taxable-first');
  assert.ok(saving.terminalBalance > base.terminalBalance + 1,
    'annual savings must raise ending wealth during working years');
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

test('reporting-only federal policy sets accumulation row taxes to Form 1040 line 24', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 64, retirementAge: 66, planEndAge: 68 };
  p.household.spouse = { currentAge: 63, retirementAge: 65, planEndAge: 67 };
  p.portfolio.accounts = {
    taxable: { balance: 1000000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: { pia: 0, claimAge: 67 } };
  p.income.other = [
    { label: 'Client wages', amount: 90000, startAge: 64, endAge: 65, taxablePct: 1 },
    { label: 'Co-client wages', amount: 90000, startAge: 63, endAge: 64, taxablePct: 1 },
  ];
  p.income.pension = { benefitByAge: {}, startAge: 65, colaPct: 0 };
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0 };
  p.goals = [];

  const inputs = resolveInputs(p, {});
  const returnPath = Array.from({ length: inputs.horizonYears }, (_, index) => ({
    y: 2026 + index,
    proxyReturn: 0,
  }));
  const shortcutPath = runSinglePath(inputs, returnPath);
  const federalResolver = createFederalTaxResolver(inputs, {
    filingStatus: 'marriedFilingJointly',
    baseTaxYear: 2026,
    scenarioId: 'accum_federal_reporting_test',
  });
  const federalPath = runSinglePath(inputs, returnPath, { taxPolicy: federalResolver });
  const accumRows = federalPath.rows.filter((row) => row.phase === 'accum' && row.otherIncome > 0);

  assert.ok(accumRows.length >= 2, 'fixture must include multiple accumulation income years');
  for(const row of accumRows){
    const expected = federalResolver(row);
    assert.ok(Math.abs(row.taxes - expected) < 0.01,
      `age ${row.age} must report federal line 24 on accumulation rows`);
    assert.ok(row.taxes > 0, `age ${row.age} must carry a positive federal tax`);
  }
  assert.ok(
    federalPath.rows.some((row, index) => row.taxes !== shortcutPath.rows[index].taxes),
    'federal reporting must differ from shortcut on at least one accumulation row'
  );
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
  const path = Array.from({ length: inputs.horizonYears }, (_, index) => ({
    y: 2026 + index,
    proxyReturn: 0,
  }));
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
  const path = [{ y: 2026, proxyReturn: 0 }];
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

  const negativePath = [{ y: 2026, proxyReturn: -0.5 }];
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
  const sim = runSinglePath(inputs, [{ y: 2026, proxyReturn: 0 }]);

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
  p.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 95 };
  const base = runHistoricalPath(p, 1995, 'taxable-first');
  const buy  = runHistoricalPath(p, 1995, 'taxable-first', undefined, { lumpSum: 200000, lumpSumYear: 0 });
  assert.ok(buy.terminalBalance < base.terminalBalance - 1,
    'a $200k purchase at current age (accumulation) must reduce ending wealth');
});

// ── RMDs (Required Minimum Distributions) ───────────────────────────────────
// From age 73 the pre-tax sleeve must distribute a minimum even if spending
// doesn't need it; the after-tax excess is reinvested into the taxable sleeve.
// Roth / taxable-only plans have no RMD.
test('RMDs force pre-tax distributions from 73 and reinvest the excess', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.portfolio.accounts.taxable.balance     = 0;     // starts empty…
  p.portfolio.accounts.traditional.balance = 10e6;  // big pre-tax → RMD >> spending
  p.portfolio.accounts.roth.balance        = 0;
  const r = runHistoricalPath(p, 1995, 'taxable-first');
  const at73 = r.rows.find(x => x.age === 73);
  assert.ok(at73 && at73.rmd > 0, 'a required distribution fires at age 73');
  // Taxable began at $0 and nothing else funds it in retirement, so any positive
  // taxable balance can ONLY be reinvested RMD proceeds.
  assert.ok(r.rows.some(x => x.age >= 73 && x.accountBalances.taxable > 1),
    'excess RMD is reinvested into the taxable sleeve');

  // No pre-tax balance → no RMD ever (Roth/taxable are exempt).
  const q = JSON.parse(JSON.stringify(defaultPlan));
  q.portfolio.accounts.taxable.balance     = 10e6;
  q.portfolio.accounts.traditional.balance = 0;
  q.portfolio.accounts.roth.balance        = 0;
  const r2 = runHistoricalPath(q, 1995, 'taxable-first');
  assert.ok(r2.rows.every(x => !(x.rmd > 0)), 'no Traditional balance → no RMD');
});

test('engine rows separate total required RMD from the forced top-up', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 72, retirementAge: 72, planEndAge: 74 };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 10_000_000 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 100_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };
  const params = resolveInputs(p, {});
  const sim = runSinglePath(params, [
    { y: 2025, proxyReturn: 0 },
    { y: 2026, proxyReturn: 0 },
    { y: 2027, proxyReturn: 0 },
  ]);
  const pre73 = sim.rows.find(row => row.age === 72);
  const at73 = sim.rows.find(row => row.age === 73);
  assert.equal(pre73.rmdRequired, 0);
  assert.ok(at73.rmdRequired > 0);
  assert.ok(Math.abs(
    at73.rmdRequired - at73.accountStartingBalances.traditional / 26.5
  ) < 0.01);
  assert.ok(at73.accountBreakdown.traditional + at73.rmd >= at73.rmdRequired - 0.01);
  assert.deepEqual(at73.preTaxDeltaAccountBreakdown, at73.accountBreakdown);
  assert.ok(at73.rmd < at73.rmdRequired,
    'row.rmd remains only the portion forced beyond the spending withdrawal');
});

// ── Contribution split (Roth / brokerage contributions in accumulation) ─────
// Savings can land in any of the three sleeves. Default is 100% pre-tax so old
// plans are unchanged; a Roth/taxable split routes the money differently.
test('savings split: default is all pre-tax; resolveInputs normalizes a custom split', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.savings = { annual: 30000 };                       // no split → back-compat default
  const d = resolveInputs(p, {});
  assert.ok(Math.abs(d.savingsSplit.traditional - 1) < 1e-9 && d.savingsSplit.roth === 0 && d.savingsSplit.taxable === 0,
    'missing split → 100% traditional');
  const q = JSON.parse(JSON.stringify(defaultPlan));
  q.savings = { annual: 30000, split: { traditional: 1, roth: 1, taxable: 2 } };  // 1:1:2
  const e = resolveInputs(q, {});
  assert.ok(Math.abs(e.savingsSplit.taxable - 0.5) < 1e-9 && Math.abs(e.savingsSplit.roth - 0.25) < 1e-9,
    'split normalizes to fractions');
  // override beats the plan's split
  const o = resolveInputs(p, { savingsSplit: { roth: 1 } });
  assert.ok(o.savingsSplit.roth === 1 && o.savingsSplit.traditional === 0, 'ov.savingsSplit wins');
});

test('Roth contributions end higher than the same dollars pre-tax (split flows through)', () => {
  const horizon = 95 - 50 + 1;
  const bundle = Array.from({ length: 200 }, () => generateReturnPath(horizon));
  // Well-funded so the plan SURVIVES — then the withdrawal-side tax treatment
  // (Roth tax-free + no RMD vs Traditional taxed + RMD drag) shows in the terminal.
  const mk = split => {
    const p = JSON.parse(JSON.stringify(defaultPlan));
    p.household.primary = { currentAge: 50, retirementAge: 65, planEndAge: 95 };
    p.savings   = { annual: 150000, split };
    p.expenses  = { living: 60000, housing: 0, debt: 0, healthcare: 0 };
    p.portfolio.accounts = { taxable:{balance:200000,basisPct:1}, traditional:{balance:0}, roth:{balance:0} };
    return runSimulation(p, {}, bundle);
  };
  const allTrad = mk({ traditional:1, roth:0, taxable:0 });
  const allRoth = mk({ traditional:0, roth:1, taxable:0 });
  assert.ok(allRoth.terminal.p50 > allTrad.terminal.p50 + 1,
    'tax-free Roth (no RMD) must end higher than the same dollars in pre-tax');
});

// ── Typed accounts (401k, SEP, …) fold into their tax sleeve ────────────────
test('extra typed accounts sum into their bucket; empty = unchanged', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));
  const baseR = resolveInputs(base, {});
  base.portfolio.extraAccounts = [];                       // explicit empty = no change
  assert.strictEqual(resolveInputs(base, {}).accounts.traditional.balance, baseR.accounts.traditional.balance,
    'empty extras → identical resolved balances');
  // a $500k 401(k) lands in the pre-tax (traditional) sleeve
  const withAcct = JSON.parse(JSON.stringify(defaultPlan));
  withAcct.portfolio.extraAccounts = [{ type:'401k', bucket:'traditional', balance:500000 }];
  const fold = resolvePortfolioAccounts(withAcct);
  const r = resolveInputs(withAcct, {});
  assert.strictEqual(r.accounts.traditional.balance, fold.engineBuckets.traditional.balance,
    'engine resolved balance must come from the shared account fold');
  assert.strictEqual(r.accounts.traditional.balance, baseR.accounts.traditional.balance + 500000,
    '401(k) adds to the pre-tax bucket');
  assert.strictEqual(r.accounts.roth.balance, baseR.accounts.roth.balance, 'Roth untouched');
  // a taxable add also lifts basis at the account basis %
  const withTax = JSON.parse(JSON.stringify(defaultPlan));
  withTax.portfolio.extraAccounts = [{ type:'brokerage', bucket:'taxable', balance:100000 }];
  const rt = resolveInputs(withTax, {});
  assert.strictEqual(rt.accounts.taxable.balance, baseR.accounts.taxable.balance + 100000, 'taxable add folds into taxable balance');
  assert.ok(rt.accounts.taxable.basis > baseR.accounts.taxable.basis, 'taxable add lifts basis');
});

test('confirmed taxable basis is preserved and unknown basis uses the approved 50/50 assumption', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const brokerage = createAccount('brokerage_taxable', { owner: 'client', balance: 100000 });
  brokerage.id = 'confirmed-brokerage';
  brokerage.basis = {
    amount: 25000,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-07-12T12:00:00Z',
    version: 1,
  };
  p.portfolio.extraAccounts = [brokerage];

  assert.strictEqual(resolveInputs(p, {}).accounts.taxable.basis, 25000,
    'complete confirmed account basis reaches engine starting basis');

  brokerage.basis = {
    amount: null,
    method: 'unknown',
    status: 'unknown',
    source: null,
    confirmedAt: null,
    version: 1,
  };
  const assumed = resolveInputs(p, {});
  assert.strictEqual(assumed.accounts.taxable.basis, 50000,
    'unknown basis uses 50% of the applicable taxable balance');
});

test('inherited accounts appear in current folds but stay out of engine inputs until rules exist', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));
  const baseInputs = resolveInputs(base, {});
  const withInherited = JSON.parse(JSON.stringify(defaultPlan));
  withInherited.portfolio.extraAccounts = [
    { typeId:'inherited_traditional_ira', type:'Inherited Traditional IRA', bucket:'traditional', balance:500000 },
    { typeId:'inherited_roth_ira', type:'Inherited Roth IRA', bucket:'roth', balance:250000 },
  ];
  const fold = resolvePortfolioAccounts(withInherited);
  const inputs = resolveInputs(withInherited, {});

  assert.equal(fold.taxBuckets.traditional.balance, baseInputs.accounts.traditional.balance + 500000);
  assert.equal(fold.taxBuckets.roth.balance, baseInputs.accounts.roth.balance + 250000);
  assert.equal(inputs.accounts.traditional.balance, baseInputs.accounts.traditional.balance);
  assert.equal(inputs.accounts.roth.balance, baseInputs.accounts.roth.balance);
  assert.deepEqual(fold.pendingStrategyAccounts.map(account => account.typeId), [
    'inherited_traditional_ira', 'inherited_roth_ira',
  ]);
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

test('default Monte Carlo is identical to the explicit shortcut tax policy', () => {
  const p = structuredClone(defaultPlan);
  const inputs = resolveInputs(p, {});
  resetSeed(20260710);
  const bundle = Array.from({ length: 40 }, () => generateReturnPath(inputs.horizonYears));

  const defaultResult = runSimulation(p, {}, bundle);
  const explicitNullResult = runSimulation(p, {}, bundle, {
    taxPolicy: null,
    fundTaxPolicyDelta: true,
  });
  const explicitSims = bundle.map((returnPath, simIndex) => {
    const sim = runSinglePath(inputs, returnPath, {
      taxPolicy: (_row, { shortcutTax }) => shortcutTax,
    });
    sim.simIndex = simIndex;
    sim.returnPath = returnPath;
    return sim;
  });
  const explicitShortcutResult = analyzeResults(explicitSims, inputs);

  assert.deepStrictEqual(defaultResult, explicitShortcutResult,
    'unused tax-policy seam must preserve the complete default MC result');
  assert.deepStrictEqual(defaultResult, explicitNullResult,
    'null tax policy must remain byte-identical even when funding mode is requested');
});

test('opt-in single path reports federal line 24 as row tax', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 68 };
  p.portfolio.accounts = {
    taxable: { balance: 10000000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [{ label: 'Taxable income', amount: 100000, startAge: 65, endAge: 68, taxablePct: 1 }];
  p.income.pension = { benefitByAge: {}, startAge: 65, colaPct: 0 };
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0 };
  p.goals = [];

  const inputs = resolveInputs(p, {});
  const returnPath = Array.from({ length: inputs.horizonYears }, (_, index) => ({
    y: 2026 + index,
    proxyReturn: 0,
  }));
  const shortcutPath = runSinglePath(inputs, returnPath);
  const federalResolver = createFederalTaxResolver(inputs, {
    filingStatus: 'single',
    baseTaxYear: 2026,
    scenarioId: 't6_engine_policy_test',
  });
  const expectedFederalTax = shortcutPath.rows.map((row) => federalResolver(row));
  const federalPath = runSinglePath(inputs, returnPath, { taxPolicy: federalResolver });

  assert.deepStrictEqual(federalPath.rows.map((row) => row.taxes), expectedFederalTax,
    'every wired row tax must equal federal Form 1040 line 24');
  assert.ok(federalPath.rows.some((row, index) => row.taxes !== shortcutPath.rows[index].taxes),
    'fixture must prove the federal resolver differs from the shortcut');
  assert.ok(Math.abs(
    federalPath.lifetimeTax - federalPath.rows.reduce((sum, row) => sum + row.taxes, 0)
  ) < 0.01, 'single-path lifetime tax must follow resolved federal row taxes');
});

test('tax-policy funding mode grosses up a positive delta before depletion', () => {
  const build = (balance, living, bucket = 'taxable') => {
    const p = structuredClone(defaultPlan);
    p.meta.filingStatus = 'single';
    p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
    p.household.spouse = null;
    p.portfolio.accounts = {
      taxable: { balance: 0, basisPct: 1 },
      traditional: { balance: bucket === 'traditional' ? balance : 0 },
      roth: { balance: 0 },
    };
    p.portfolio.extraAccounts = bucket === 'taxable'
      ? [explicitlyBasedBrokerage(balance, balance)]
      : [];
    p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
    p.income.other = [];
    p.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
    p.expenses = {
      living,
      housing: 0,
      debt: 0,
      healthcare: 0,
      healthcareRealGrowth: 0,
      extra: [],
    };
    p.liabilities = [];
    p.properties = [];
    p.goals = [];
    p.ltc = { amount: 0, onsetAge: 85 };
    return resolveInputs(p, {});
  };
  const returnPath = [{ y: 2026, proxyReturn: 0 }];

  const ampleInputs = build(100000, 10000);
  const shortcut = runSinglePath(ampleInputs, returnPath);
  const reportingOnly = runSinglePath(ampleInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 5000,
  });
  const funded = runSinglePath(ampleInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 5000,
    fundTaxPolicyDelta: true,
  });

  assert.strictEqual(reportingOnly.rows[0].withdrawal, shortcut.rows[0].withdrawal,
    'reporting-only T7 mode must keep shortcut funding unchanged');
  assert.strictEqual(reportingOnly.terminalBalance, shortcut.terminalBalance);
  assert.strictEqual(funded.rows[0].withdrawal, shortcut.rows[0].withdrawal + 5000,
    'positive resolved-tax delta must create an additional portfolio withdrawal');
  assert.strictEqual(funded.terminalBalance, shortcut.terminalBalance - 5000);
  assert.strictEqual(funded.rows[0].taxes, shortcut.rows[0].taxes + 5000);
  assert.strictEqual(funded.rows[0].taxFundingConvergence.status, 'converged');
  assert.ok(Math.abs(funded.rows[0].taxFundingConvergence.residual) <= 0.01);

  const traditionalInputs = build(100000, 10000, 'traditional');
  const traditionalShortcut = runSinglePath(traditionalInputs, returnPath);
  const traditionalFunded = runSinglePath(traditionalInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 5000,
    fundTaxPolicyDelta: true,
  });
  const extraGross = traditionalFunded.rows[0].withdrawal
    - traditionalShortcut.rows[0].withdrawal;
  assert.ok(extraGross > 5000, 'traditional funding must gross up the federal delta');
  assert.ok(Math.abs(extraGross * (1 - traditionalInputs.taxRates.ordinary) - 5000) < 0.01,
    'additional traditional withdrawal must net the resolved-tax delta after shortcut tax');

  const tightInputs = build(12000, 10000);
  const tightShortcut = runSinglePath(tightInputs, returnPath);
  const tightFunded = runSinglePath(tightInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 3000,
    fundTaxPolicyDelta: true,
  });
  assert.strictEqual(tightShortcut.failed, false, 'shortcut fixture must survive');
  assert.strictEqual(tightFunded.failed, true,
    'unfunded federal-tax delta must be able to change the path outcome');

  const lowerTax = runSinglePath(traditionalInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax - 1000,
    fundTaxPolicyDelta: true,
  });
  assert.ok(lowerTax.rows[0].withdrawal < traditionalShortcut.rows[0].withdrawal,
    'a lower federal liability must rebuild the year with a smaller withdrawal');
  assert.ok(lowerTax.terminalBalance > traditionalShortcut.terminalBalance);
  assert.strictEqual(lowerTax.rows[0].taxFundingConvergence.fundingAdjustment, -1000);
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
  const result = runSinglePath(params, [{ y: 2026, proxyReturn: 0 }], {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });

  assert.equal(params.expenses.living, 24_000);
  assert.equal(result.rows[0].expenses, 24_000);
  assert.equal(result.rows[0].withdrawal, 24_000);
  assert.equal(result.rows[0].taxFundingConvergence.taxSavingsReinvested, 0);
});

test('savingsAnnual models positive scenario savings over a zero-dollar base', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 60, retirementAge: 62, planEndAge: 62 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];
  p.savings.annual = 0;
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {
    savingsAnnual: 24_000,
    savingsSplit: { taxable: 1 },
  });
  const result = runSinglePath(params, [
    { y: 2026, proxyReturn: 0 },
    { y: 2027, proxyReturn: 0 },
    { y: 2028, proxyReturn: 0 },
  ]);

  assert.equal(params.savingsAnnual, 24_000);
  assert.deepEqual(params.savingsSplit, { traditional: 0, roth: 0, taxable: 1 });
  assert.equal(result.rows[1].accountBalances.taxable, 48_000);
  assert.equal(result.rows[1].taxableEndingBasis, 48_000);
});

test('federal funding rejects non-finite spending inputs before convergence', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  p.household.spouse = null;
  p.expenses = {
    living: 10_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };

  assert.throws(
    () => resolveInputs(p, { spendBump: Infinity }),
    /spendBump must be finite/
  );
  assert.throws(
    () => resolveInputs(p, { spendCut: NaN }),
    /spendCut must be finite/
  );
  for(const value of [NaN, Infinity, -1, null, '24000']){
    assert.throws(
      () => resolveInputs(p, { livingAnnual: value }),
      /livingAnnual must be a finite non-negative number/
    );
    assert.throws(
      () => resolveInputs(p, { savingsAnnual: value }),
      /savingsAnnual must be a finite non-negative number/
    );
  }

  // This block previously corrupted plan.expenses.housing and asserted the
  // row-level funding guard caught the resulting NaN. That field is retired —
  // spending is goals now — so the equivalent protection is that a corrupt
  // spending figure is sanitized at resolve time and never reaches the funding
  // calculation at all. The row-level guard remains as defense in depth.
  p.goals = [{ name: 'Corrupt', amount: NaN, startAge: 0, endAge: 999 }];
  const params = resolveInputs(p, {});
  const corrupt = params.goals.find(g => g.name === 'Corrupt');
  assert.strictEqual(corrupt.amount, 0, 'a non-finite goal amount resolves to zero');
  for(const g of params.goals){
    assert.ok(Number.isFinite(g.amount), 'no non-finite spending survives resolveInputs');
    assert.ok(Number.isFinite(g.realGrowth), 'nor a non-finite growth rate');
  }
});

test('converged age-68 cash-flow row funds the visible federal-tax identity', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 68, retirementAge: 68, planEndAge: 68 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 1_000_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];
  p.portfolio.withdrawalStrategy = 'taxable-first';
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [{
    label: 'Retirement income', amount: 65_000,
    startAge: 68, endAge: 68, taxablePct: 1,
  }];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 170_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [{ name: 'Age-68 goal', amount: 50_000, startAge: 68, endAge: 68 }];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {});
  const result = runSinglePath(params, [{ y: 2026, proxyReturn: 0 }], {
    taxPolicy: () => 30_000,
    fundTaxPolicyDelta: true,
  });
  const row = result.rows[0];
  const grossIncome = row.socialSecurity + row.otherIncome + row.pension;
  const visibleOutflows = row.expenses + row.goals + row.taxes;
  const visibleResidual = grossIncome + row.withdrawal - visibleOutflows;

  assert.equal(row.age, 68);
  assert.equal(grossIncome, 65_000);
  assert.equal(row.expenses, 170_000);
  assert.equal(row.goals, 50_000);
  assert.equal(row.taxes, 30_000);
  assert.equal(row.rmd, 0);
  assert.equal(row.rmdRequired, 0);
  assert.equal(row.liabilities, 0);
  assert.equal(row.lumpSum, 0);
  assert.equal(row.assetSale, 0);
  assert.equal(row.failed, false, 'ample taxable assets must leave no funding shortfall');
  assert.equal(row.taxFundingConvergence.status, 'converged');
  assert.ok(Math.abs(row.taxFundingConvergence.residual) <= 0.01);
  assert.ok(Math.abs(row.withdrawal - 185_000) <= 0.01,
    'the converged portfolio draw must fund expenses, goals, and resolved federal tax');
  assert.ok(Math.abs(visibleResidual) <= 0.01,
    `visible cash-flow columns must reconcile within one cent; residual=${visibleResidual}`);
});

test('converged taxable funding rebuilds exact final gain facts from the opening state', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 73 };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    explicitlyBasedBrokerage(1_000_000, 200_000),
    createAccount('traditional_ira', {
      owner: 'client',
      balance: 10_000_000,
    }),
  ];
  p.portfolio.withdrawalStrategy = 'taxable-first';
  p.expenses = {
    living: 100_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {});
  const result = runSinglePath(params, [{ y: 2025, proxyReturn: 0 }], {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 200_000,
    fundTaxPolicyDelta: true,
  });
  const row = result.rows[0];
  const gainFraction = 0.80;
  const firstWithdrawal = 100_000 / (1 - gainFraction * 0.15);
  const expectedWithdrawal = 300_000 / (1 - gainFraction * 0.15);
  const expectedGain = expectedWithdrawal * gainFraction;

  assert.ok(Math.abs(row.accountBreakdown.taxable - expectedWithdrawal) < 0.01);
  assert.ok(Math.abs(
    row.preTaxDeltaAccountBreakdown.taxable - firstWithdrawal
  ) < 0.01);
  assert.ok(Math.abs(row.taxableCapitalGain - expectedGain) < 0.01);
  assert.ok(Math.abs(row.taxableGainFraction - expectedGain / expectedWithdrawal) < 1e-12);
  assert.equal(row.taxableGainFraction, gainFraction);
  assert.deepEqual(row.accountStartingBalances, {
    taxable: 1_000_000,
    traditional: 10_000_000,
    roth: 0,
  });
  assert.equal(row.taxableStartingBasis, 200_000);
  assert.equal(row.taxFundingConvergence.status, 'converged');
});

test('lower federal tax beyond a zero draw retains only the incremental saving as taxable basis', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    explicitlyBasedBrokerage(100_000, 100_000),
  ];
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [{
    label: 'Pension-like income', amount: 100_000,
    startAge: 65, endAge: 65, taxablePct: 1,
  }];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 90_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };
  const params = resolveInputs(p, {});
  const shortcut = runSinglePath(params, [{ y: 2026, proxyReturn: 0 }]);
  const funded = runSinglePath(params, [{ y: 2026, proxyReturn: 0 }], {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });

  assert.equal(shortcut.rows[0].withdrawal, 12_000);
  assert.equal(funded.rows[0].withdrawal, 0);
  assert.equal(funded.rows[0].taxFundingConvergence.taxSavingsReinvested, 10_000);
  assert.equal(funded.rows[0].accountBalances.taxable, 110_000);
  assert.equal(funded.rows[0].taxableStartingBasis, 100_000);
});

test('converged funding fails closed when a discontinuous tax policy has no fixed point', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 100_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 10_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };
  const params = resolveInputs(p, {});

  assert.throws(() => runSinglePath(params, [{ y: 2026, proxyReturn: 0 }], {
    taxPolicy: row => row.withdrawal > 12_000 ? 0 : 5_000,
    fundTaxPolicyDelta: true,
  }), error => error?.code === 'TAX_POLICY_FUNDING_DID_NOT_CONVERGE');
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

test('spouse retirement age extends accumulation on the same calendar timeline', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 57, retirementAge: 67, planEndAge: 89 };
  p.savings.annual = 50000;
  p.savings.split = { traditional: 0, roth: 0, taxable: 1 };
  p.portfolio.accounts.taxable.balance = 5e6;
  p.portfolio.accounts.traditional.balance = 0;
  p.portfolio.accounts.roth.balance = 0;

  const resolved = resolveInputs(p, {});
  assert.strictEqual(resolved.retirementAge, 68,
    'spouse age 57 retiring at 67 maps to primary age 68');

  const m = runHistoricalPath(p, 1995, 'taxable-first');
  assert.strictEqual(m.rows.find(r => r.age === 67).phase, 'accum',
    'household remains in accumulation until spouse retirement calendar year');
  assert.notStrictEqual(m.rows.find(r => r.age === 68).phase, 'accum',
    'retirement cash flows start when both spouse retirement ages have arrived');

  p.household.spouse.retirementAge = 64;
  assert.strictEqual(resolveInputs(p, {}).retirementAge, 65,
    'same-calendar spouse retirement preserves the client retirement year');
});

test('spouse-owned working income uses the spouse timeline and stops at retirement', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 60, retirementAge: 67, planEndAge: 90 };
  p.household.spouse = { currentAge: 58, retirementAge: 63, planEndAge: 90 };
  p.portfolio.accounts.taxable.balance += p.portfolio.accounts.traditional.balance;
  p.portfolio.accounts.traditional.balance = 0;
  p.savings.annual = 0;
  p.income.other = [{
    typeId: 'wages', owner: 'spouse', label: 'Co-client wages', amount: 60000,
    startAge: 58, endAge: 62, realGrowth: 0, taxablePct: 1,
  }];
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  assert.strictEqual(m.rows.find(row => row.age === 64).otherIncome, 60000,
    'spouse age 62 maps to primary age 64');
  assert.strictEqual(m.rows.find(row => row.age === 65).otherIncome, 0,
    'spouse wages stop after the spouse working window');
});

test('Tax-page member wages combine once and stop at each owner retirement age', () => {
  const p = structuredClone(defaultPlan);
  p.meta.planningAsOfYear = 2026;
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = {
    currentAge: 60, retirementAge: 65, planEndAge: 90, employmentStatus: 'employed',
  };
  p.household.spouse = {
    currentAge: 58, retirementAge: 62, planEndAge: 90, employmentStatus: 'employed',
  };
  p.incomeTax.current1040 = {
    taxYear: 2026,
    incomeSourcesComplete: false,
    income: {},
  };
  p.income.other = [
    { typeId: 'wages', owner: 'client', amount: 80_000, taxablePct: 1 },
    { typeId: 'wages', owner: 'spouse', amount: 60_000, taxablePct: 1 },
  ];

  const resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, 140_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 3).wages, 140_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 4).wages, 80_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 5).wages, 0);
});

test('current-year single wage total is a safe projection fallback but a prior-year total is not', () => {
  const p = structuredClone(defaultPlan);
  p.meta.planningAsOfYear = 2026;
  p.meta.filingStatus = 'single';
  p.household.primary = {
    currentAge: 60, retirementAge: 65, planEndAge: 90, employmentStatus: 'employed',
  };
  p.household.spouse = null;
  p.income.socialSecurity.spouse = null;
  p.income.other = [];
  p.incomeTax.current1040 = {
    taxYear: 2026,
    incomeSourcesComplete: false,
    income: { wages: 50_000 },
  };

  let resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, 50_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 4).wages, 50_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 5).wages, 0);

  p.incomeTax.current1040.taxYear = 2025;
  resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, null);
  assert.ok(resolved.incomeContractIssues.includes(
    'INCOME_SOURCE_MISSING:client:wages',
  ));
});

test('a retirement-year wage stays in that year without becoming future wages', () => {
  const p = structuredClone(defaultPlan);
  p.meta.planningAsOfYear = 2026;
  p.meta.filingStatus = 'single';
  p.household.primary = {
    currentAge: 65, retirementAge: 65, planEndAge: 90, employmentStatus: 'retired',
  };
  p.household.spouse = null;
  p.income.socialSecurity.spouse = null;
  p.income.other = [{
    typeId: 'wages', owner: 'client', amount: 25_000,
    startAge: 65, endAge: 65, taxablePct: 1,
  }];

  const resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, 25_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 1).wages, 0);
});

test('household timeline preserves each person age and lifecycle milestone', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 60, retirementAge: 67, planEndAge: 90 };
  p.household.spouse = { currentAge: 57, retirementAge: 63, planEndAge: 95 };
  p.portfolio.accounts.taxable.balance += p.portfolio.accounts.traditional.balance;
  p.portfolio.accounts.traditional.balance = 0;
  p.savings.annual = 0;
  p.income.socialSecurity = {
    primary: { pia: 30_000, claimAge: 68 },
    spouse: { pia: 20_000, claimAge: 70 },
  };

  const timeline = resolveHouseholdTimeline(p);
  assert.deepStrictEqual(timeline.people.client, {
    currentAge: 60,
    birthYear: null,
    rmdStartAge: 75,
    retirementAge: 67,
    socialSecurityClaimAge: 68,
    planEndAge: 90,
    retirementAgeOnPrimaryTimeline: 67,
    socialSecurityClaimAgeOnPrimaryTimeline: 68,
    planEndAgeOnPrimaryTimeline: 90,
  });
  assert.deepStrictEqual(timeline.people.spouse, {
    currentAge: 57,
    birthYear: null,
    rmdStartAge: 75,
    retirementAge: 63,
    socialSecurityClaimAge: 70,
    planEndAge: 95,
    retirementAgeOnPrimaryTimeline: 66,
    socialSecurityClaimAgeOnPrimaryTimeline: 73,
    planEndAgeOnPrimaryTimeline: 98,
  });
  assert.strictEqual(timeline.householdRetirementAgeOnPrimaryTimeline, 67);
  assert.strictEqual(timeline.householdEndAgeOnPrimaryTimeline, 98);

  const resolved = resolveInputs(p, {});
  const yearSix = householdStateAtYear(resolved, 6);
  assert.deepStrictEqual(yearSix.ages, { client: 66, spouse: 63 });
  assert.strictEqual(yearSix.people.client.retired, false);
  assert.strictEqual(yearSix.people.spouse.retired, true);
  assert.strictEqual(yearSix.people.client.claimingSocialSecurity, false);
  assert.strictEqual(yearSix.people.spouse.claimingSocialSecurity, false);
  assert.strictEqual(yearSix.filingStatus, 'marriedFilingJointly');

  const rows = runHistoricalPath(p, 1995, 'taxable-first').rows;
  assert.deepStrictEqual(rows[6].ages, { client: 66, spouse: 63 });
  assert.strictEqual(rows[13].people.client.claimingSocialSecurity, true);
  assert.strictEqual(rows[13].people.spouse.claimingSocialSecurity, true);
});

test('RMD cohort inference ignores prior-return years and unconfirmed birth dates', () => {
  const p = structuredClone(defaultPlan);
  const currentYear = 2026;
  p.meta.planningAsOfYear = currentYear;
  const boundaryAge = currentYear - 1960;
  p.household.primary = {
    currentAge: boundaryAge,
    retirementAge: boundaryAge,
    planEndAge: boundaryAge + 10,
  };
  p.incomeTax = { current1040: { taxYear: currentYear - 1 } };
  p.taxProfiles = {
    client: {
      birthDate: { value: '1960-01-01', status: 'unknown' },
    },
  };

  assert.strictEqual(resolveHouseholdTimeline(p).people.client.rmdStartAge, null);
  p.taxProfiles.client.birthDate.status = 'confirmed';
  assert.strictEqual(resolveHouseholdTimeline(p).people.client.rmdStartAge, 75);
  p.household.primary.birthYear = 1959;
  assert.strictEqual(resolveHouseholdTimeline(p).people.client.birthYear, 1960);
  assert.strictEqual(resolveHouseholdTimeline(p).people.client.rmdStartAge, null);
});

test('household income uses the same per-person survival boundary as simulation', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 64 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 24_000, claimAge: 63 },
  };
  p.income.other = [];

  const resolved = resolveInputs(p, {});
  assert.ok(householdIncomeAtYear(resolved, 0).socialSecurityBenefits > 0);
  const terminalAge = householdIncomeAtYear(resolved, 1);
  assert.ok(terminalAge.socialSecurityBenefits > 0);
  assert.strictEqual(terminalAge.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(terminalAge.people.spouse.alive, true);
  const afterSpouseEnd = householdIncomeAtYear(resolved, 2);
  assert.strictEqual(afterSpouseEnd.socialSecurityBenefits, 0);
  assert.strictEqual(afterSpouseEnd.filingStatus, 'single');
  assert.strictEqual(afterSpouseEnd.survivingOwner, 'client');
  assert.deepStrictEqual(afterSpouseEnd.ages, { client: 67, spouse: 65 });
});

test('terminal ages are included and longevity extends each person consistently', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 67 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 66 };
  const base = resolveInputs(p, {});
  const extended = resolveInputs(p, { longevityYears: 2 });

  assert.strictEqual(base.horizonYears, 4);
  assert.strictEqual(householdStateAtYear(base, 2).people.client.alive, true);
  assert.strictEqual(householdStateAtYear(base, 3).people.client.alive, false);
  assert.strictEqual(extended.people.client.planEndAge, 69);
  assert.strictEqual(extended.people.spouse.planEndAge, 68);
  assert.strictEqual(extended.horizonYears, 6);
  assert.strictEqual(householdStateAtYear(extended, 4).people.client.alive, true);
});

test('missing co-client milestones remain unknown and do not create a false simulation', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 60 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 24_000 },
  };

  const timeline = resolveHouseholdTimeline(p);
  assert.deepStrictEqual(timeline.people.spouse, {
    currentAge: 60,
    birthYear: null,
    rmdStartAge: 75,
    retirementAge: null,
    socialSecurityClaimAge: null,
    planEndAge: null,
    retirementAgeOnPrimaryTimeline: null,
    socialSecurityClaimAgeOnPrimaryTimeline: null,
    planEndAgeOnPrimaryTimeline: null,
  });
  assert.strictEqual(timeline.completeForSimulation, false);

  const resolved = resolveInputs(p, {});
  const state = householdStateAtYear(resolved, 0);
  assert.strictEqual(state.people.spouse.age, 60);
  assert.strictEqual(state.people.spouse.alive, true);
  assert.strictEqual(state.people.spouse.retired, null);
  const income = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(income.available, true);
  assert.strictEqual(income.socialSecurityBenefits, null);
  assert.ok(income.incomeIssues.includes('SOCIAL_SECURITY_TIMELINE_INCOMPLETE:spouse'));
  assert.throws(
    () => runSimulation(p, {}),
    error => error?.code === 'HOUSEHOLD_TIMELINE_INCOMPLETE'
  );
});

test('income aggregates stay blank when the source owner timeline is incomplete', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { retirementAge: 65, planEndAge: 90 };
  p.income.socialSecurity = { primary: null, spouse: null };
  p.income.other = [{
    typeId: 'rental', owner: 'spouse', amount: 12_000,
    startAge: 60, endAge: 90, taxablePct: 1,
  }];

  let facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.available, true);
  assert.strictEqual(facts.grossOtherIncome, null);
  assert.strictEqual(facts.otherIncome, null);
  assert.strictEqual(facts.wages, 0);
  assert.ok(facts.incomeIssues.includes('INCOME_TIMELINE_INCOMPLETE:spouse:rental'));

  p.income.other = [{
    typeId: 'wages', owner: 'spouse', amount: 12_000,
    startAge: 60, taxablePct: 1,
  }];
  facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.available, true);
  assert.strictEqual(facts.wages, null);
  assert.strictEqual(facts.grossOtherIncome, 0);
  assert.ok(facts.incomeIssues.includes('INCOME_TIMELINE_INCOMPLETE:spouse:wages'));
});

test('missing terminal age preserves known current-year facts but not an invented future status', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 63, retirementAge: 63 };
  p.income.socialSecurity = { primary: null, spouse: null };
  p.income.other = [];

  const resolved = resolveInputs(p, {});
  const current = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(current.people.spouse.alive, true);
  assert.strictEqual(current.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(current.available, true);

  const future = householdIncomeAtYear(resolved, 1);
  assert.strictEqual(future.people.spouse.alive, null);
  assert.strictEqual(future.filingStatus, null);
  assert.strictEqual(future.available, false);
});

test('past retirement ages remain intact for years-retired calculations', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 70, retirementAge: 65, planEndAge: 70 };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 1_000_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];
  p.expenses = {
    living: 0, housing: 0, debt: 0,
    healthcare: 10_000, healthcareRealGrowth: 0.10, extra: [],
  };

  const resolved = resolveInputs(p, {});
  assert.strictEqual(resolved.retirementAge, 65);
  const row = runHistoricalPath(p, 1995, 'taxable-first').rows[0];
  assert.ok(Math.abs(row.expenses - 10_000 * (1.10 ** 5)) < 0.01);
});

test('focus-year household facts are unavailable after nobody remains alive', () => {
  const single = structuredClone(defaultPlan);
  single.meta.filingStatus = 'single';
  single.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  single.household.spouse = null;
  single.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  single.income.other = [];
  const singleResolved = resolveInputs(single, {});
  assert.strictEqual(householdStateAtYear(singleResolved, 1).filingStatus, null);
  assert.strictEqual(householdIncomeAtYear(singleResolved, 1).available, false);

  const couple = structuredClone(single);
  couple.meta.filingStatus = 'marriedFilingJointly';
  couple.household.spouse = { currentAge: 64, retirementAge: 64, planEndAge: 64 };
  couple.income.socialSecurity.spouse = { pia: 0, claimAge: 67 };
  const coupleResolved = resolveInputs(couple, {});
  const afterBoth = householdStateAtYear(coupleResolved, 1);
  assert.strictEqual(afterBoth.people.client.alive, false);
  assert.strictEqual(afterBoth.people.spouse.alive, false);
  assert.strictEqual(afterBoth.filingStatus, null);
  assert.strictEqual(householdIncomeAtYear(coupleResolved, 1).available, false);
});

test('a missing Social Security claim age leaves that benefit blank without blocking the plan', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 67 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 65 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 24_000 },
  };
  p.income.other = [];

  const resolved = resolveInputs(p, {});
  assert.strictEqual(resolved.simulationAvailable, true);
  assert.strictEqual(resolved.incomeContractAvailable, false);
  assert.ok(resolved.incomeContractIssues.includes(
    'SOCIAL_SECURITY_TIMELINE_INCOMPLETE:spouse'
  ));
  assert.strictEqual(
    householdIncomeAtYear(resolved, 0).socialSecurityBenefits,
    null,
  );
  const path = Array.from({ length: resolved.horizonYears }, (_, index) => ({
    y: 2026 + index,
    proxyReturn: 0,
  }));
  assert.ok(Number.isFinite(runSimulation(p, {}, [path]).successRate));
  assert.ok(runSinglePath(resolved, path).rows.length > 0);
  assert.ok(
    runHistoricalPath(p, 1995, 'taxable-first').rows.length > 0,
  );
});

test('spouse-owned other income ends with the spouse lifetime, not one year later', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 64 };
  p.income.socialSecurity = { primary: null, spouse: null };
  p.income.other = [{
    typeId: 'other', owner: 'spouse', amount: 12_000,
    startAge: 63, endAge: 90, taxablePct: 1, realGrowth: 0,
  }];
  const resolved = resolveInputs(p, {});

  assert.strictEqual(householdIncomeAtYear(resolved, 1).otherIncome, 12_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 2).otherIncome, 0);
});

test('typed Social Security, qualified dividends, and signed long-term gains keep their tax character', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [
    { typeId: 'social_security', owner: 'client', amount: 30_000, startAge: 65, endAge: 65 },
    { typeId: 'dividends', owner: 'client', amount: 100_000, startAge: 65, endAge: 65, taxablePct: 1, qualifiedPct: 1 },
    { typeId: 'long_term_capital_gain', owner: 'client', amount: -10_000, startAge: 65, endAge: 65 },
  ];

  const resolved = resolveInputs(p, {});
  const facts = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(facts.socialSecurityBenefits, 30_000);
  assert.strictEqual(facts.ordinaryDividends, 100_000);
  assert.strictEqual(facts.qualifiedDividends, 100_000);
  assert.strictEqual(facts.capitalGain, -10_000);
  assert.strictEqual(facts.otherIncome, 0);

  const row = runHistoricalPath(p, 1995, 'taxable-first').rows[0];
  assert.deepStrictEqual(row.incomeTaxFacts, {
    socialSecurityBenefits: 30_000,
    ordinaryDividends: 100_000,
    qualifiedDividends: 100_000,
    capitalGain: -10_000,
  });
  assert.strictEqual(row.socialSecurity, 30_000);
  assert.strictEqual(row.otherIncome, 90_000);
});

test('cash IRA distributions and Roth conversions remain separate RMD facts', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [
    {
      typeId: 'ira_distribution', owner: 'client', amount: 10_000,
      startAge: 65, endAge: 65, taxablePct: 1,
    },
    {
      typeId: 'roth_conversion', owner: 'client', amount: 20_000,
      startAge: 65, endAge: 65, taxablePct: 1,
    },
  ];

  const facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.iraDistributions, 30_000);
  assert.strictEqual(facts.iraCashDistributions, 10_000);
  assert.strictEqual(facts.rothConversions, 20_000);
  assert.strictEqual(facts.taxableIra, 30_000);
});

test('dedicated and typed Social Security for one owner are not counted twice', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 67, retirementAge: 67, planEndAge: 67 };
  p.income.socialSecurity = {
    primary: { pia: 36_000, claimAge: 67 },
    spouse: null,
  };
  p.income.other = [{
    typeId: 'social_security', owner: 'client', amount: 36_000,
    startAge: 67, endAge: 67,
  }];
  const facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.socialSecurityBenefits, 36_000);
  assert.strictEqual(facts.available, false);
  assert.ok(facts.incomeIssues.includes('SOCIAL_SECURITY_SOURCE_OVERLAP:client'));
});

test('RMD uses the known Traditional-account owner age and refuses unknown couple ownership', () => {
  const spouseOwned = structuredClone(defaultPlan);
  spouseOwned.meta.filingStatus = 'marriedFilingJointly';
  spouseOwned.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  spouseOwned.household.spouse = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  spouseOwned.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  spouseOwned.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'spouse', balance: 265_000 }),
  ];
  spouseOwned.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: { pia: 0, claimAge: 67 } };
  spouseOwned.income.other = [];
  spouseOwned.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };

  const spouseRow = runHistoricalPath(spouseOwned, 1995, 'taxable-first').rows[0];
  assert.strictEqual(spouseRow.rmdOwner, 'spouse');
  assert.strictEqual(spouseRow.rmdAvailable, true);
  assert.ok(Math.abs(spouseRow.rmdRequired - 10_000) < 0.01);

  const youngerSpouse = structuredClone(spouseOwned);
  youngerSpouse.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  youngerSpouse.household.spouse = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  const youngerSpouseRow = runHistoricalPath(youngerSpouse, 1995, 'taxable-first').rows[0];
  assert.strictEqual(youngerSpouseRow.rmdRequired, 0);

  const unknownCouple = structuredClone(spouseOwned);
  unknownCouple.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  unknownCouple.portfolio.accounts.traditional.balance = 265_000;
  unknownCouple.portfolio.extraAccounts = [];
  assert.throws(
    () => runHistoricalPath(unknownCouple, 1995, 'taxable-first'),
    error => error?.code === 'HOUSEHOLD_RMD_UNAVAILABLE'
      && error.rmdIssue === 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE'
      && error.age === 73
  );
  assert.strictEqual(
    resolveWithdrawalPlannerAccountState(unknownCouple).limits.deferredWithdrawal.max,
    265_000,
    'current-year planner limits remain available even when full-plan RMD ownership is not'
  );

  const single = structuredClone(unknownCouple);
  single.meta.filingStatus = 'single';
  single.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  single.household.spouse = null;
  single.income.socialSecurity.spouse = null;
  const singleRow = runHistoricalPath(single, 1995, 'taxable-first').rows[0];
  assert.strictEqual(singleRow.rmdOwner, 'client');
  assert.ok(Math.abs(singleRow.rmdRequired - 10_000) < 0.01);
});

test('an older non-owner spouse does not create an RMD for a younger known owner', () => {
  const p = structuredClone(defaultPlan);
  const currentYear = 2026;
  p.meta.planningAsOfYear = currentYear;
  const ownerAge = currentYear - 1960;
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = {
    currentAge: ownerAge,
    retirementAge: ownerAge,
    planEndAge: ownerAge + 1,
  };
  p.household.spouse = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];

  const rows = runHistoricalPath(p, 1995, 'taxable-first').rows;
  assert.strictEqual(rows[0].rmdRequired, 0);
  assert.strictEqual(rows[0].rmdAvailable, true);
  assert.strictEqual(rows[0].rmdOwner, 'client');
});

test('a known RMD owner receives required distributions during household accumulation years', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 73, retirementAge: 75, planEndAge: 75 };
  p.household.spouse = { currentAge: 65, retirementAge: 67, planEndAge: 67 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };

  const first = runHistoricalPath(p, 1995, 'taxable-first').rows[0];
  assert.strictEqual(first.phase, 'accum');
  assert.strictEqual(first.rmdOwner, 'client');
  assert.ok(Math.abs(first.rmdRequired - 10_000) < 0.01);
  assert.ok(Math.abs(first.rmd - 10_000) < 0.01);
  assert.ok(first.taxBySource.traditional > 0);
});

test('RMD applicable age follows the owner birth cohort', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 65,
    retirementAge: 65,
    planEndAge: 75,
    birthYear: 1961,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 246_000 }),
  ];
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 999 };
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };

  const rows = runSinglePath(
    resolveInputs(p, {}),
    Array.from({ length: 11 }, () => ({ proxyReturn: 0 }))
  ).rows;
  assert.strictEqual(rows.find(row => row.age === 73).rmdRequired, 0);
  assert.strictEqual(rows.find(row => row.age === 74).rmdRequired, 0);
  const at75 = rows.find(row => row.age === 75);
  assert.ok(Math.abs(
    at75.rmdRequired - at75.accountStartingBalances.traditional / 24.6
  ) < 0.01);
});

test('a working-owner employer plan does not receive an invented RMD', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = {
    currentAge: 73,
    retirementAge: 75,
    planEndAge: 75,
    birthYear: 1953,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('401k', { owner: 'client', balance: 265_000 }),
  ];

  assert.throws(
    () => runHistoricalPath(p, 1995, 'taxable-first'),
    error => error?.code === 'HOUSEHOLD_RMD_UNAVAILABLE'
      && error.rmdIssue === 'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE'
      && error.age === 73
  );
});

// Superseded: multi-owner pre-tax money used to abort the whole projection.
// Each spouse now gets their own RMD, off their own balance and their own age —
// a married couple who each own an IRA is the ordinary case, not an error.
test('multi-owner households project with a per-owner RMD each', () => {
  const multiOwner = structuredClone(defaultPlan);
  multiOwner.meta.filingStatus = 'marriedFilingJointly';
  multiOwner.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 75 };
  multiOwner.household.spouse = { currentAge: 65, retirementAge: 65, planEndAge: 67 };
  multiOwner.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  multiOwner.income.other = [];
  multiOwner.savings.annual = 0;
  multiOwner.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  multiOwner.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 132_500 }),
    createAccount('traditional_ira', { owner: 'spouse', balance: 132_500 }),
  ];
  multiOwner.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };

  const rows = runHistoricalPath(multiOwner, 1995, 'taxable-first').rows;
  const first = rows[0];
  // Client is 73 and past their applicable age; spouse is 65 and not.
  assert.strictEqual(first.rmdAvailable, true);
  assert.ok(first.rmdRequired > 0, 'the client owes a distribution');
  assert.ok(first.rmdRequiredByOwner.client > 0, 'charged to the client');
  assert.strictEqual(first.rmdRequiredByOwner.spouse, 0, 'the spouse owes nothing yet');
  // No single household owner exists once two people hold pre-tax money.
  assert.strictEqual(first.rmdOwner, null);
  // Each requirement runs off that owner's own balance, not the household total.
  assert.ok(
    Math.abs(first.rmdRequiredByOwner.client - 132_500 / 26.5) < 1,
    'client RMD = their own $132,500 over the age-73 divisor'
  );

  assert.strictEqual(
    resolveWithdrawalPlannerAccountState(multiOwner).limits.deferredWithdrawal.max,
    265_000
  );
});

test('a surviving spouse receives a single-owner Traditional IRA by rollover', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 73, birthYear: 1953,
  };
  p.household.spouse = {
    currentAge: 65, retirementAge: 65, planEndAge: 80, birthYear: 1961,
  };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };

  const result = runHistoricalPath(p, 1995, 'taxable-first');
  const firstSurvivorRow = result.rows.find(row => row.age === 74);
  const survivorRmdRow = result.rows.find(row => row.people.spouse.age === 75);

  assert.strictEqual(firstSurvivorRow.rmdOwner, 'spouse');
  assert.strictEqual(firstSurvivorRow.rmdRequired, 0);
  assert.strictEqual(survivorRmdRow.rmdOwner, 'spouse');
  assert.ok(survivorRmdRow.rmdRequired > 0);
  assert.strictEqual(survivorRmdRow.rmdAvailable, true);
});

test('young spouses with two contributing 401(k)s keep a full projection after one owner dies', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 36, retirementAge: 65, planEndAge: 90, birthYear: 1990,
  };
  p.household.spouse = {
    currentAge: 33, retirementAge: 62, planEndAge: 95, birthYear: 1993,
  };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings = {
    annual: 24_000,
    split: { traditional: 1, roth: 0, taxable: 0 },
  };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('401k', { owner: 'client', balance: 265_000 }),
    createAccount('401k', { owner: 'spouse', balance: 185_000 }),
  ];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };

  const result = runHistoricalPath(p, 1995, 'taxable-first');
  const lastWorkingRow = result.rows.find(row => row.age === 64);
  const retirementRow = result.rows.find(row => row.age === 65);
  const firstSurvivorRow = result.rows.find(row => row.age === 91);
  const laterSurvivorRmdRow = result.rows.find(row => (
    row.people.spouse.alive && row.people.spouse.age === 89
  ));

  assert.equal(lastWorkingRow.phase, 'accum');
  assert.equal(lastWorkingRow.savings, 24_000);
  assert.notEqual(retirementRow.phase, 'accum');
  assert.equal(retirementRow.savings, undefined);
  assert.equal(firstSurvivorRow.people.client.alive, false);
  assert.equal(firstSurvivorRow.people.spouse.alive, true);
  assert.equal(firstSurvivorRow.rmdOwner, 'spouse');
  assert.equal(firstSurvivorRow.rmdAvailable, true);
  assert.equal(laterSurvivorRmdRow.rmdOwner, 'spouse');
  assert.ok(laterSurvivorRmdRow.rmdRequired > 0);
  assert.equal(result.rows.at(-1).age, 98);

  resetSeed();
  const resolved = resolveInputs(p, {});
  const simulation = runSimulation(
    p,
    {},
    [generateReturnPath(resolved.horizonYears, resolved.portfolio)],
  );
  assert.ok(Number.isFinite(simulation.successRate));
  assert.notEqual(simulation.projectionStatus, 'unavailable');
});

test('negative longevity is rejected instead of creating an empty successful plan', () => {
  assert.throws(
    () => resolveInputs(structuredClone(defaultPlan), { longevityYears: -1 }),
    /finite nonnegative/
  );
  const invalidEnd = structuredClone(defaultPlan);
  invalidEnd.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 64 };
  assert.throws(() => resolveInputs(invalidEnd, {}), /cannot precede currentAge/);
  const fractionalAge = structuredClone(defaultPlan);
  fractionalAge.household.primary.currentAge = 65.5;
  assert.throws(() => resolveInputs(fractionalAge, {}), /finite integer/);
});

test('withdrawal planner account limits coordinate one shared traditional pool', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 1_200_000, basisPct: 0.6 },
    traditional: { balance: 100_000 },
    roth: { balance: 750_000 },
  };
  p.portfolio.extraAccounts = [];
  const requested = {
    taxableWithdrawal: 0,
    deferredWithdrawal: 30_000,
    rothConversion: 60_000,
    rothWithdrawal: 0,
    qcd: 0,
  };

  const state = resolveWithdrawalPlannerAccountState(p, requested);
  assert.strictEqual(state.valid, true);
  assert.deepStrictEqual(state.balances, {
    taxable: 1_200_000,
    traditional: 100_000,
    roth: 750_000,
  });
  assert.strictEqual(state.limits.taxableWithdrawal.max, 1_200_000);
  assert.strictEqual(state.limits.rothWithdrawal.max, 750_000);
  assert.strictEqual(state.limits.rothConversion.max, 70_000);
  assert.strictEqual(state.limits.deferredWithdrawal.max, 40_000);
  assert.strictEqual(state.limits.qcd.max, 10_000);
  assert.deepStrictEqual(state.pools.traditional, {
    available: 100_000,
    used: 90_000,
    remaining: 10_000,
  });

  const approval = approveWithdrawalPlannerLeverChange(p, requested, 'qcd', 25_000);
  assert.strictEqual(approval.approved, true);
  assert.strictEqual(approval.clamped, true);
  assert.strictEqual(approval.requestedValue, 25_000);
  assert.strictEqual(approval.approvedValue, 10_000);
  assert.strictEqual(approval.levers.rothConversion, 60_000);
  assert.strictEqual(approval.levers.deferredWithdrawal, 30_000);
  assert.strictEqual(approval.levers.qcd, 10_000);
  assert.strictEqual(approval.state.pools.traditional.remaining, 0);
});

test('withdrawal planner account limits reserve fixed traditional distributions', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 100_000 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];

  const state = resolveWithdrawalPlannerAccountState(
    p,
    { rothConversion: 20_000 },
    { traditional: 80_000 }
  );
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.limits.rothConversion.max, 20_000);
  assert.strictEqual(state.limits.deferredWithdrawal.max, 0);
  assert.deepStrictEqual(state.reservations, {
    traditional: 80_000,
    traditionalTotal: 80_000,
    rmdEligibleCash: 0,
    taxYear: 2026,
  });
  assert.strictEqual(state.pools.traditional.remaining, 0);

  const approval = approveWithdrawalPlannerLeverChange(
    p,
    { rothConversion: 0 },
    'rothConversion',
    80_000,
    { traditional: 80_000 }
  );
  assert.strictEqual(approval.approvedValue, 20_000);
  assert.strictEqual(approval.clamped, true);
});

test('withdrawal planner reserves a known RMD before approving Roth conversions', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
  ];

  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.rmd.status, 'known');
  assert.strictEqual(state.rmd.owner, 'client');
  assert.strictEqual(state.rmd.age, 73);
  assert.strictEqual(state.rmd.applicableAge, 73);
  assert.ok(Math.abs(state.rmd.required - 10_000) < 0.01);
  assert.strictEqual(state.limits.deferredWithdrawal.min, 10_000);
  assert.strictEqual(state.levers.deferredWithdrawal, 10_000);
  assert.strictEqual(state.limits.rothConversion.max, 255_000);

  const approval = approveWithdrawalPlannerLeverChange(
    p,
    {},
    'rothConversion',
    265_000
  );
  assert.strictEqual(approval.approved, true);
  assert.strictEqual(approval.clamped, true);
  assert.strictEqual(approval.approvedValue, 255_000);
  assert.strictEqual(approval.levers.deferredWithdrawal, 10_000);
  assert.strictEqual(approval.state.pools.traditional.remaining, 0);

  const fixedCash = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 10_000,
    rmdEligibleCash: 10_000,
    taxYear: 2026,
  });
  assert.strictEqual(fixedCash.limits.deferredWithdrawal.min, 0);
  assert.strictEqual(fixedCash.limits.rothConversion.max, 255_000);

  const fixedConversion = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 10_000,
    rmdEligibleCash: 0,
    taxYear: 2026,
  });
  assert.strictEqual(fixedConversion.limits.deferredWithdrawal.min, 10_000);
  assert.strictEqual(fixedConversion.limits.rothConversion.max, 245_000);
});

test('withdrawal planner computes and reserves current-year RMDs by IRA owner', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.household.spouse = {
    currentAge: 75, retirementAge: 75, planEndAge: 95, birthYear: 1951,
  };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
    createAccount('traditional_ira', {
      owner: 'spouse', balance: 246_000, valuationDate: '2025-12-31',
    }),
  ];
  const reservations = {
    traditionalTotal: 5_000,
    rmdEligibleCash: 5_000,
    traditionalByOwner: { client: 0, spouse: 5_000 },
    rmdEligibleCashByOwner: { client: 0, spouse: 5_000 },
    taxYear: 2026,
  };

  const state = resolveWithdrawalPlannerAccountState(
    p,
    { rothConversion: 491_000 },
    reservations
  );
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.rmd.status, 'known');
  assert.strictEqual(state.rmd.owner, null);
  assert.ok(Math.abs(state.rmd.required - 20_000) < 0.01);
  assert.strictEqual(state.rmd.satisfiedByFixedCash, 5_000);
  assert.strictEqual(state.rmd.byOwner.client.required, 10_000);
  assert.strictEqual(state.rmd.byOwner.client.satisfiedByFixedCash, 0);
  assert.strictEqual(state.rmd.byOwner.client.satisfiedByPlannerCash, 10_000);
  assert.strictEqual(state.rmd.byOwner.spouse.required, 10_000);
  assert.strictEqual(state.rmd.byOwner.spouse.satisfiedByFixedCash, 5_000);
  assert.strictEqual(state.rmd.byOwner.spouse.satisfiedByPlannerCash, 5_000);
  assert.strictEqual(state.limits.deferredWithdrawal.min, 15_000);
  assert.strictEqual(state.levers.deferredWithdrawal, 15_000);
  assert.strictEqual(state.limits.rothConversion.max, 491_000);
  assert.strictEqual(state.pools.traditional.remaining, 0);

  const youngerSpouse = structuredClone(p);
  youngerSpouse.household.spouse = {
    currentAge: 60, retirementAge: 60, planEndAge: 95, birthYear: 1966,
  };
  youngerSpouse.portfolio.extraAccounts[1] = createAccount('traditional_ira', {
    owner: 'spouse', balance: 100_000, valuationDate: '2025-12-31',
  });
  const spouseCashBeforeRmdAge = resolveWithdrawalPlannerAccountState(
    youngerSpouse,
    {},
    {
      traditionalTotal: 10_000,
      rmdEligibleCash: 10_000,
      traditionalByOwner: { client: 0, spouse: 10_000 },
      rmdEligibleCashByOwner: { client: 0, spouse: 10_000 },
      taxYear: 2026,
    }
  );
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.required, 10_000);
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.satisfiedByFixedCash, 0);
  assert.strictEqual(spouseCashBeforeRmdAge.limits.deferredWithdrawal.min, 10_000);
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.byOwner.client.satisfiedByPlannerCash, 10_000);
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.byOwner.spouse.status, 'not-required');

  const preRmdOwnerOverdraw = structuredClone(p);
  preRmdOwnerOverdraw.household.primary = {
    currentAge: 60, retirementAge: 60, planEndAge: 95, birthYear: 1966,
  };
  preRmdOwnerOverdraw.household.spouse = {
    currentAge: 61, retirementAge: 61, planEndAge: 95, birthYear: 1965,
  };
  preRmdOwnerOverdraw.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 100_000, valuationDate: '2025-12-31',
    }),
    createAccount('traditional_ira', {
      owner: 'spouse', balance: 400_000, valuationDate: '2025-12-31',
    }),
  ];
  const impossibleClientDistribution = resolveWithdrawalPlannerAccountState(
    preRmdOwnerOverdraw,
    {},
    {
      traditionalTotal: 150_000,
      rmdEligibleCash: 150_000,
      traditionalByOwner: { client: 150_000, spouse: 0 },
      rmdEligibleCashByOwner: { client: 150_000, spouse: 0 },
      taxYear: 2026,
    }
  );
  assert.strictEqual(impossibleClientDistribution.valid, false);
  assert.strictEqual(impossibleClientDistribution.rmd.status, 'not-required');
  assert.ok(impossibleClientDistribution.issues.some(issue => (
    issue.code === 'TRADITIONAL_OWNER_POOL_EXCEEDED'
      && issue.owner === 'client'
      && issue.requested === 150_000
      && issue.available === 100_000
  )));
  assert.strictEqual(impossibleClientDistribution.limits.deferredWithdrawal.max, null);
  assert.strictEqual(impossibleClientDistribution.limits.rothConversion.max, null);
  assert.strictEqual(impossibleClientDistribution.limits.qcd.max, null);

  const unattributed = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 5_000,
    rmdEligibleCash: 5_000,
    taxYear: 2026,
  });
  assert.strictEqual(unattributed.rmd.status, 'unavailable');
  assert.strictEqual(unattributed.rmd.issue, 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE');
  assert.strictEqual(unattributed.rmd.required, null);
  assert.strictEqual(unattributed.limits.rothConversion.max, null);

  const singleTrackedOwner = structuredClone(p);
  singleTrackedOwner.portfolio.extraAccounts = [p.portfolio.extraAccounts[0]];
  const crossedSingleOwnerFacts = resolveWithdrawalPlannerAccountState(
    singleTrackedOwner,
    {},
    {
      traditionalTotal: 10_000,
      rmdEligibleCash: 10_000,
      traditionalByOwner: { client: 0, spouse: 10_000 },
      rmdEligibleCashByOwner: { client: 10_000, spouse: 0 },
      taxYear: 2026,
    }
  );
  assert.strictEqual(crossedSingleOwnerFacts.rmd.status, 'unavailable');
  assert.strictEqual(crossedSingleOwnerFacts.rmd.required, null);
  assert.strictEqual(
    crossedSingleOwnerFacts.rmd.issue,
    'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE'
  );

  const missingSpouseValuation = structuredClone(p);
  missingSpouseValuation.portfolio.extraAccounts[1] = createAccount('traditional_ira', {
    owner: 'spouse', balance: 246_000,
  });
  const missingValuation = resolveWithdrawalPlannerAccountState(
    missingSpouseValuation,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(missingValuation.rmd.status, 'unavailable');
  assert.strictEqual(missingValuation.rmd.issue, 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE');
  assert.strictEqual(missingValuation.rmd.byOwner.client.status, 'known');
  assert.strictEqual(missingValuation.rmd.byOwner.spouse.status, 'unavailable');
  assert.strictEqual(missingValuation.limits.rothConversion.max, null);

  const ownerOverdraw = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 260_000,
    rmdEligibleCash: 0,
    traditionalByOwner: { client: 260_000, spouse: 0 },
    rmdEligibleCashByOwner: { client: 0, spouse: 0 },
    taxYear: 2026,
  });
  assert.strictEqual(ownerOverdraw.valid, false);
  assert.ok(ownerOverdraw.issues.some(issue => (
    issue.code === 'RMD_MINIMUM_EXCEEDS_OWNER_TRADITIONAL'
      && issue.owner === 'client'
  )));
  assert.strictEqual(ownerOverdraw.rmd.status, 'unavailable');
  assert.strictEqual(ownerOverdraw.rmd.required, null);
  assert.strictEqual(ownerOverdraw.limits.rothConversion.max, null);

  const retiredEmployerOwner = structuredClone(p);
  retiredEmployerOwner.portfolio.extraAccounts[0] = createAccount('401k', {
    owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
  });
  const retiredEmployerState = resolveWithdrawalPlannerAccountState(
    retiredEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(retiredEmployerState.rmd.status, 'known');
  assert.strictEqual(retiredEmployerState.rmd.byOwner.client.required, 10_000);
  assert.strictEqual(retiredEmployerState.rmd.byOwner.spouse.required, 10_000);

  const singleEmployerOwner = structuredClone(retiredEmployerOwner);
  singleEmployerOwner.meta.filingStatus = 'single';
  singleEmployerOwner.household.spouse = null;
  singleEmployerOwner.income.socialSecurity.spouse = null;
  singleEmployerOwner.portfolio.extraAccounts = [
    retiredEmployerOwner.portfolio.extraAccounts[0],
  ];
  const singleEmployerPlannerRmd = resolveWithdrawalPlannerAccountState(
    singleEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(singleEmployerPlannerRmd.rmd.status, 'known');
  assert.strictEqual(singleEmployerPlannerRmd.rmd.required, 10_000);
  assert.strictEqual(singleEmployerPlannerRmd.limits.deferredWithdrawal.min, 10_000);

  const singleEmployerWithFixedIraCash =
    resolveWithdrawalPlannerAccountState(
      singleEmployerOwner,
      {},
      {
        traditionalTotal: 10_000,
        rmdEligibleCash: 10_000,
        traditionalByOwner: { client: 10_000, spouse: 0 },
        rmdEligibleCashByOwner: { client: 10_000, spouse: 0 },
        taxYear: 2026,
      }
    );
  assert.strictEqual(singleEmployerWithFixedIraCash.rmd.status, 'unavailable');
  assert.strictEqual(singleEmployerWithFixedIraCash.rmd.required, null);
  assert.strictEqual(
    singleEmployerWithFixedIraCash.rmd.issue,
    'EMPLOYER_PLAN_RMD_CASH_ATTRIBUTION_UNAVAILABLE'
  );
  assert.strictEqual(
    singleEmployerWithFixedIraCash.limits.rothConversion.max,
    null
  );

  const workingEmployerOwner = structuredClone(retiredEmployerOwner);
  workingEmployerOwner.household.primary.retirementAge = 80;
  const workingEmployerState = resolveWithdrawalPlannerAccountState(
    workingEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(workingEmployerState.rmd.status, 'unavailable');
  assert.strictEqual(workingEmployerState.rmd.required, null);
  assert.strictEqual(
    workingEmployerState.rmd.byOwner.client.issue,
    'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE'
  );

  const mixedEmployerOwner = structuredClone(p);
  mixedEmployerOwner.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 100_000, valuationDate: '2025-12-31',
    }),
    createAccount('401k', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
    p.portfolio.extraAccounts[1],
  ];
  const mixedEmployerState = resolveWithdrawalPlannerAccountState(
    mixedEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(mixedEmployerState.rmd.status, 'unavailable');
  assert.strictEqual(mixedEmployerState.rmd.required, null);
  assert.strictEqual(
    mixedEmployerState.rmd.byOwner.client.issue,
    'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
  );
  assert.strictEqual(mixedEmployerState.limits.rothConversion.max, null);

  const singleMixedEmployerOwner = structuredClone(mixedEmployerOwner);
  singleMixedEmployerOwner.meta.filingStatus = 'single';
  singleMixedEmployerOwner.household.spouse = null;
  singleMixedEmployerOwner.income.socialSecurity.spouse = null;
  singleMixedEmployerOwner.portfolio.extraAccounts =
    singleMixedEmployerOwner.portfolio.extraAccounts.slice(0, 2);
  const singleMixedEmployerState = resolveWithdrawalPlannerAccountState(
    singleMixedEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(singleMixedEmployerState.rmd.status, 'unavailable');
  assert.strictEqual(singleMixedEmployerState.rmd.required, null);
  assert.strictEqual(
    singleMixedEmployerState.rmd.issue,
    'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
  );
});

test('withdrawal planner leaves an unsupported current-year RMD blank', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];

  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.rmd.status, 'unavailable');
  assert.strictEqual(state.rmd.issue, 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE');
  assert.strictEqual(state.rmd.required, null);
  assert.strictEqual(state.limits.deferredWithdrawal.max, 265_000);
  assert.strictEqual(state.limits.rothConversion.max, null);

  const approval = approveWithdrawalPlannerLeverChange(
    p,
    {},
    'rothConversion',
    1
  );
  assert.strictEqual(approval.approved, false);
  assert.strictEqual(approval.approvedValue, 0);
});

test('withdrawal planner does not approve a change while another shared-pool violation remains', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts.traditional.balance = 100_000;
  p.portfolio.extraAccounts = [];
  const approval = approveWithdrawalPlannerLeverChange(p, {
    deferredWithdrawal: 100_000,
    rothConversion: 100_000,
    qcd: 0,
  }, 'taxableWithdrawal', 0);
  assert.strictEqual(approval.approved, false);
  assert.strictEqual(approval.state.valid, false);
  assert.ok(approval.state.issues.some(issue => issue.code === 'TRADITIONAL_POOL_EXCEEDED'));
});

test('withdrawal planner rejects an impossible lever vector without inventing priority', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts.traditional.balance = 100_000;
  p.portfolio.extraAccounts = [];
  const state = resolveWithdrawalPlannerAccountState(p, {
    taxableWithdrawal: 0,
    deferredWithdrawal: 100_000,
    rothConversion: 100_000,
    rothWithdrawal: 0,
    qcd: 100_000,
  });
  assert.strictEqual(state.valid, false);
  assert.ok(state.issues.some(issue => issue.code === 'TRADITIONAL_POOL_EXCEEDED'));
});

test('withdrawal planner excludes tax-bucket-ineligible balances from approved limits', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('roth_ira', { owner: 'client', balance: 100_000 }),
    createAccount('hsa', { owner: 'client', balance: 500_000 }),
    createAccount('checking', { owner: 'client', balance: 250_000 }),
  ];
  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.balances.roth, 100_000);
  assert.strictEqual(state.balances.taxable, 0);
  assert.strictEqual(state.limits.rothWithdrawal.max, 100_000);
  assert.ok(state.excludedAccountIds.includes(p.portfolio.extraAccounts[1].id));
  assert.ok(state.excludedAccountIds.includes(p.portfolio.extraAccounts[2].id));
});

test('withdrawal planner excludes an account whose household tax reporting is unconfirmed', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const joint = createAccount('joint_brokerage', { balance: 100_000 });
  p.portfolio.extraAccounts = [joint];

  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.balances.taxable, 0);
  assert.strictEqual(state.limits.taxableWithdrawal.max, 0);
  assert.ok(state.excludedAccountIds.includes(joint.id));
  assert.ok(state.sourceIssues.includes(`TAX_REPORTING_INCLUSION_UNKNOWN:${joint.id}`));
});

test('stale spouse-owned facts are not reassigned to a single client', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.spouse = null;
  p.income.socialSecurity.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const spouseAccount = createAccount('traditional_ira', {
    owner: 'spouse', balance: 100_000,
  });
  p.portfolio.extraAccounts = [spouseAccount];
  const accountState = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(accountState.balances.traditional, 0);
  assert.strictEqual(accountState.limits.deferredWithdrawal.max, 0);
  assert.ok(accountState.excludedAccountIds.includes(spouseAccount.id));
  assert.ok(accountState.sourceIssues.includes(`ACCOUNT_OWNER_UNAVAILABLE:${spouseAccount.id}`));
  assert.throws(
    () => resolveInputs(p, {}),
    error => error?.code === 'ACCOUNT_OWNER_UNAVAILABLE'
  );

  p.portfolio.extraAccounts = [];
  p.income.other = [{
    typeId: 'rental', owner: 'spouse', amount: 12_000,
    startAge: p.household.primary.currentAge,
    endAge: p.household.primary.planEndAge,
  }];
  const resolved = resolveInputs(p, {});
  const income = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(income.otherIncome, null);
  assert.strictEqual(income.grossOtherIncome, null);
  assert.strictEqual(income.available, true);
  assert.ok(income.incomeIssues.includes('INCOME_OWNER_UNAVAILABLE:spouse:rental'));
});

test('withdrawal planner does not approve an ambiguous legacy plus typed account pool', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 100_000, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('brokerage_taxable', { owner: 'client', balance: 100_000 }),
  ];
  const state = resolveWithdrawalPlannerAccountState(p, { taxableWithdrawal: 1 });
  assert.strictEqual(state.limits.taxableWithdrawal.max, null);
  assert.strictEqual(state.valid, false);
  assert.ok(state.issues.some(issue => issue.code === 'ACCOUNT_POOL_AMBIGUOUS'));
});

test('withdrawal planner net cash uses incremental tax and excludes conversions and QCDs from cash', () => {
  const cash = buildWithdrawalPlannerCashContract({
    taxableWithdrawal: 5_000,
    deferredWithdrawal: 20_000,
    rothConversion: 50_000,
    rothWithdrawal: 10_000,
    qcd: 15_000,
  }, 12_000);
  assert.deepStrictEqual(cash, {
    grossWithdrawalCash: 35_000,
    incrementalModeledFederalIncomeTax: 12_000,
    netAfterIncrementalModeledFederalIncomeTax: 23_000,
  });
});

test('withdrawal planner preserves gross cash but leaves net cash blank when incremental tax is unavailable', () => {
  const cash = buildWithdrawalPlannerCashContract({
    taxableWithdrawal: 5_000,
    deferredWithdrawal: 20_000,
    rothConversion: 50_000,
    rothWithdrawal: 10_000,
    qcd: 0,
  }, null);
  assert.deepStrictEqual(cash, {
    grossWithdrawalCash: 35_000,
    incrementalModeledFederalIncomeTax: null,
    netAfterIncrementalModeledFederalIncomeTax: null,
  });
});

/* ── pathDigest / assessPlan / returnDollars (story-mode aggregates) ────── */

import { pathDigest, assessPlan, ASSESSMENT_RULES } from './engine.js';

test('pathDigest invariants on a historical run (1973)', () => {
  const sim = runHistoricalPath(defaultPlan, 1973, 'taxable-first');
  const p   = resolveInputs(defaultPlan, {});
  const d   = pathDigest(sim, p);

  assert.strictEqual(d.endBalance, sim.terminalBalance, 'endBalance passes through');
  assert.strictEqual(d.realCagr, sim.cagr, 'realCagr passes through');
  assert.strictEqual(d.failed, sim.failed, 'failed passes through');

  const wdRates = sim.rows.filter(r => r.source != null && r.wdRate > 0).map(r => r.wdRate);
  assert.strictEqual(d.withdrawalYears, wdRates.length, 'withdrawal year count');
  assert.ok(d.avgWdRate >= Math.min(...wdRates) && d.avgWdRate <= Math.max(...wdRates),
    'average withdrawal rate sits inside the row range');
  assert.strictEqual(d.peakWdRate, Math.max(...wdRates), 'peak withdrawal rate');
  const peakRow = sim.rows.find(r => r.wdRate === d.peakWdRate);
  assert.strictEqual(d.peakWdAge, peakRow.age, 'peak age matches its row');

  const totals = Object.values(d.taxSourceTotals).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(totals - d.lifetimeTax) < 1, 'tax source totals reconcile with lifetime tax');
  const shares = Object.values(d.taxSourceShares).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9, 'tax source shares sum to 1');
  assert.ok(d.dominantTaxShare >= 0.25, 'dominant source carries the largest share');

  const early = sim.rows.filter(r => r.source != null && r.phase !== 'accum').slice(0, 10);
  assert.strictEqual(d.negEarlyYears, early.filter(r => r.returnRate < 0).length,
    'negative early years recount');
  assert.ok(d.underwaterSpellMax > 0, '1973 spends years underwater');
  assert.ok(d.spendShareOfStart > 0 && d.spendShareOfStart < 1, 'spend share computed with params');
  assert.ok(d.fixedIncomeShare > 0 && d.fixedIncomeShare < 1, 'fixed income covers part of outflows');
});

test('pathDigest scopes withdrawal stats to retirement rows', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary.retirementAge = 70;            // 5 accumulation years
  const sim = runHistoricalPath(p, 1995, 'taxable-first');
  const d   = pathDigest(sim);
  const accumYears = sim.rows.filter(r => r.phase === 'accum').length;
  assert.ok(accumYears >= 5, 'run has accumulation rows');
  assert.ok(d.withdrawalYears <= sim.rows.length - accumYears,
    'withdrawal years exclude accumulation rows');
});

test('pathDigest damage window: 1973 grinds longer than 1995', () => {
  const a = pathDigest(runHistoricalPath(defaultPlan, 1973, 'taxable-first'));
  const b = pathDigest(runHistoricalPath(defaultPlan, 1995, 'taxable-first'));
  assert.ok(a.underwaterSpellMax > b.underwaterSpellMax,
    'stagflation decade stays underwater longer than the 90s boom');
});

test('returnDollars is the market gain on start-of-year balance', () => {
  const sim = runHistoricalPath(defaultPlan, 1973, 'taxable-first');
  for(const r of sim.rows.filter(x => x.source != null)){
    assert.ok(Math.abs(r.returnDollars - r.startBalance * r.returnRate) < 0.01,
      `row ${r.year}: returnDollars matches startBalance x return`);
  }
});

test('pathDigest is deterministic', () => {
  const sim = runHistoricalPath(defaultPlan, 2000, 'taxable-first');
  assert.deepStrictEqual(pathDigest(sim), pathDigest(sim), 'same input, same digest');
});

test('assessPlan emits facts that agree with the analysis', () => {
  resetSeed(12345);
  const res = runSimulation(defaultPlan, {});
  const a   = assessPlan(res);
  for(const list of [a.strengths, a.pressures, a.tossups]){
    assert.ok(Array.isArray(list));
    for(const item of list) assert.ok(item.id && item.value !== undefined, 'items carry id + value');
  }
  const hs = a.strengths.find(s => s.id === 'high-success');
  if(res.successRate >= ASSESSMENT_RULES.highSuccess.minSuccessRate){
    assert.ok(hs, 'high success rate is reported as a strength');
    assert.strictEqual(hs.value, res.successRate);
  } else {
    assert.ok(!hs, 'no high-success strength below threshold');
  }
  const rt = a.tossups.find(t => t.id === 'return-timing');
  const expectRt = res.paths.p10.failed && !res.paths.p50.failed;
  assert.strictEqual(!!rt, expectRt, 'return-timing tossup iff stressed fails while median survives');
});

test('assessPlan flags a lean plan and not a rich one', () => {
  resetSeed(777);
  const rich = structuredClone(defaultPlan);
  rich.portfolio.accounts.taxable.balance = 4000000;
  rich.portfolio.accounts.traditional.balance = 4000000;
  rich.portfolio.accounts.roth.balance = 2000000;
  const aRich = assessPlan(runSimulation(rich, {}));
  assert.ok(aRich.strengths.some(s => s.id === 'low-fixed-spending'),
    'rich plan: spending is a small share of assets');
  assert.ok(aRich.strengths.some(s => s.id === 'tax-diversified'),
    'rich plan: three meaningful buckets');

  resetSeed(777);
  const lean = structuredClone(defaultPlan);
  lean.portfolio.accounts.taxable.balance = 200000;
  lean.portfolio.accounts.traditional.balance = 500000;
  lean.portfolio.accounts.roth.balance = 0;
  const aLean = assessPlan(runSimulation(lean, {}));
  assert.ok(!aLean.strengths.some(s => s.id === 'low-fixed-spending'),
    'lean plan: spending share too high to qualify');
  assert.ok(aLean.pressures.some(p => p.id === 'withdrawal-load'),
    'lean plan: withdrawal pressure shows');
});

/* ── Per-owner RMDs ─────────────────────────────────────────────────────────
   RMDs are legally per owner — you cannot satisfy your spouse's RMD out of your
   IRA. These lock the owner-level traditional sleeve that makes that possible.
   Regression origin: a married couple who each owned a pre-tax account (the
   ordinary case) aborted every scenario at the first RMD year, so Scenarios
   rendered a dash with no explanation. */

function mfjTwoOwnerPlan() {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = { currentAge: 56, retirementAge: 63, planEndAge: 95, birthYear: 1970 };
  p.household.spouse  = { currentAge: 53, retirementAge: 60, planEndAge: 95, birthYear: 1973 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse:  { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings = { annual: 0, split: { traditional: 1, roth: 0, taxable: 0 } };
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 3000000 }),
    createAccount('rollover_ira', { owner: 'spouse', balance: 2000000 }),
  ];
  return p;
}

function agedTwoOwnerPlan(clientAge, spouseAge, living) {
  const p = mfjTwoOwnerPlan();
  p.household.primary = {
    currentAge: clientAge, retirementAge: clientAge, planEndAge: clientAge + 6,
    birthYear: 2026 - clientAge,
  };
  p.household.spouse = {
    currentAge: spouseAge, retirementAge: spouseAge, planEndAge: spouseAge + 6,
    birthYear: 2026 - spouseAge,
  };
  if (living != null) {
    p.expenses = { living, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
  }
  return p;
}

test('a couple who each own a pre-tax account completes a projection', () => {
  const p = mfjTwoOwnerPlan();
  resetSeed();
  const r = resolveInputs(p, {});
  const res = runSimulation(p, {}, [generateReturnPath(r.horizonYears, r.portfolio)]);
  assert.ok(Number.isFinite(res.successRate), 'must produce a probability, not abort');
  assert.notStrictEqual(res.projectionStatus, 'unavailable');
});

test('each spouse RMD uses their own balance and their own age', () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 76), 1995, 'taxable-first').rows[0];
  // Same age, different balances: requirements differ strictly by balance.
  assert.ok(Math.abs(row.rmdRequiredByOwner.client - 3000000 / 23.7) < 1);
  assert.ok(Math.abs(row.rmdRequiredByOwner.spouse - 2000000 / 23.7) < 1);
  assert.strictEqual(row.rmdOwner, null, 'two owners means no single household owner');
});

test('a spouse below their applicable age owes nothing', () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 70), 1995, 'taxable-first').rows[0];
  assert.ok(row.rmdRequiredByOwner.client > 0);
  assert.strictEqual(row.rmdRequiredByOwner.spouse, 0);
});

test('an ordinary withdrawal is allocated RMD-first, not pro rata', () => {
  // Client is past their applicable age, spouse is not, and spending needs a draw.
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 60, 120000), 1995, 'taxable-first').rows[0];
  const required = row.rmdRequiredByOwner.client;
  assert.ok(required > 0, 'client owes an RMD');
  const drawn = row.accountBreakdown.traditional;
  assert.ok(drawn > required, 'this case needs a draw larger than the requirement');
  // The client's own RMD comes out of the client's share first; only the
  // remainder is spread pro rata, so the spouse still takes part of the excess.
  assert.ok(row.rmdGrossByOwner.client >= required - 1,
    'the draw is charged to the owner who owes the RMD before anyone else');
  assert.ok(row.rmdGrossByOwner.spouse > 0,
    'the leftover above the requirement is shared pro rata');
  // The payoff: nothing has to be forced on top. Naive pro rata would have
  // given the client only ~60% of the draw, leaving ~$48k of their requirement
  // unmet and forcing it out separately — pulling more from tax-deferred money
  // than the plan actually needed.
  assert.ok(row.rmd < 1, 'no additional forced distribution is needed');
});

test("one spouse's withdrawal never satisfies the other's RMD", () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(60, 76, 200000), 1995, 'taxable-first').rows[0];
  const spouseRequired = row.rmdRequiredByOwner.spouse;
  assert.ok(spouseRequired > 0);
  assert.strictEqual(row.rmdRequiredByOwner.client, 0, 'the client is too young to owe');
  const spouseCovered = row.rmdGrossByOwner.spouse + row.rmd;
  assert.ok(spouseCovered + 1 >= spouseRequired,
    "the spouse's requirement is met from the spouse's own money");
});

test('row.rmd stays forced-only so Form 1040 cannot double-count', () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 76, 150000), 1995, 'taxable-first').rows[0];
  // The tax adapter computes accountBreakdown.traditional + row.rmd, so row.rmd
  // must exclude whatever the ordinary draw already took.
  assert.ok(row.rmd <= Math.max(0, row.rmdRequired - row.accountBreakdown.traditional) + 1,
    'row.rmd counts only the forced remainder');
  const distributed = row.rmdGrossByOwner.client + row.rmdGrossByOwner.spouse + row.rmd;
  assert.ok(distributed + 1 >= row.rmdRequired, 'the full requirement is still distributed');
});

test('owner buckets sum to the traditional balance, shocked or not', () => {
  for (const initialShock of [0, 0.3]) {
    const p = agedTwoOwnerPlan(76, 74, 150000);
    const r = resolveInputs(p, { initialShock });
    const t = r.accounts.traditional;
    const sum = t.byOwner.client + t.byOwner.spouse + t.byOwner.unattributed;
    assert.ok(Math.abs(t.balance - sum) < 0.01,
      'seed invariant holds at initialShock=' + initialShock);
    if (initialShock > 0) {
      const raw = r.rmdContract.openingBalanceByOwner;
      assert.ok(sum < raw.client + raw.spouse,
        'buckets follow the shocked sleeve, not the raw account dollars');
    }
    resetSeed();
    const sim = runSinglePath(r, generateReturnPath(r.horizonYears, r.portfolio));
    for (const row of sim.rows) {
      if (!row.accountBalances) continue;
      assert.ok(row.accountBalances.traditional >= -0.01, 'buckets never go negative');
    }
  }
});

test('an initial shock does not retroactively shrink the year-0 RMD basis', () => {
  const p = agedTwoOwnerPlan(76, 76);
  const plain = runSinglePath(resolveInputs(p, {}), generateReturnPath(30));
  const shocked = runSinglePath(resolveInputs(p, { initialShock: 0.3 }), generateReturnPath(30));
  assert.strictEqual(plain.rows[0].rmdBasisSource, 'opening-balance-assumption');
  assert.ok(Math.abs(plain.rows[0].rmdRequired - shocked.rows[0].rmdRequired) < 1,
    'the assumed prior-Dec-31 basis is unchanged by a shock during year 0');
  assert.strictEqual(plain.rows[1].rmdBasisSource, 'simulated-prior-year-close');
});

test('simulation paths do not share owner buckets', () => {
  const r = resolveInputs(agedTwoOwnerPlan(76, 76, 150000), {});
  const opening = Object.assign({}, r.accounts.traditional.byOwner);
  resetSeed();
  const path = generateReturnPath(r.horizonYears, r.portfolio);
  const a = runSinglePath(r, path);
  assert.deepStrictEqual(r.accounts.traditional.byOwner, opening,
    'a path must not mutate the shared resolved inputs');
  const b = runSinglePath(r, path);
  assert.strictEqual(
    a.rows[a.rows.length - 1].accountBalances.traditional,
    b.rows[b.rows.length - 1].accountBalances.traditional,
    'replaying the same path gives the same result'
  );
});

test('traditional contributions follow the owner-allocation policy', () => {
  const accumulating = () => {
    const p = mfjTwoOwnerPlan();
    p.household.primary = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
    p.household.spouse  = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
    p.savings = { annual: 45000, split: { traditional: 1, roth: 0, taxable: 0 } };
    return p;
  };

  const explicit = accumulating();
  explicit.savings.split.byOwner = { client: 1, spouse: 0 };
  assert.ok(runSinglePath(resolveInputs(explicit, {}), generateReturnPath(25)).rows.length > 0);

  // No explicit split, but existing attributable balances give a proportion.
  assert.ok(runSinglePath(resolveInputs(accumulating(), {}), generateReturnPath(25)).rows.length > 0);

  // Nothing to prorate from and a co-client present: the contribution is
  // unattributed rather than invented as 50/50 or defaulted to the client, and
  // it fails closed once an RMD would depend on it.
  const orphan = accumulating();
  orphan.portfolio.extraAccounts = [];
  // Still working, so contributions actually accumulate, and old enough that an
  // RMD comes due on that unattributed money before the plan ends.
  orphan.household.primary = { currentAge: 70, retirementAge: 80, planEndAge: 82, birthYear: 1956 };
  orphan.household.spouse  = { currentAge: 70, retirementAge: 80, planEndAge: 82, birthYear: 1956 };
  const r = resolveInputs(orphan, {});
  const res = runSimulation(orphan, {}, [generateReturnPath(r.horizonYears, r.portfolio)]);
  assert.strictEqual(res.projectionStatus, 'unavailable');
  assert.strictEqual(res.successRate, null, 'never a percentage on unresolved ownership');
});

test('accumulation rows report exact Traditional ending balances by owner', () => {
  const p = mfjTwoOwnerPlan();
  p.household.primary = {
    ...p.household.primary, retirementAge: 57, planEndAge: 57,
  };
  p.household.spouse = {
    ...p.household.spouse, retirementAge: 54, planEndAge: 54,
  };
  p.savings = {
    annual: 12_000,
    split: {
      traditional: 1, roth: 0, taxable: 0,
      byOwner: { client: 1, spouse: 0 },
    },
  };

  const inputs = resolveInputs(p, {});
  const row = runSinglePath(inputs, [
    { y: 2026, proxyReturn: 0 },
    { y: 2027, proxyReturn: 0 },
  ]).rows[0];

  assert.deepStrictEqual(row.traditionalEndingBalancesByOwner, {
    client: 3_012_000,
    spouse: 2_000_000,
    unattributed: 0,
  });
  assert.equal(
    Object.values(row.traditionalEndingBalancesByOwner)
      .reduce((sum, value) => sum + value, 0),
    row.accountBalances.traditional
  );
});

test('unresolvable ownership fails closed instead of throwing', () => {
  const p = agedTwoOwnerPlan(74, 73);
  p.portfolio.accounts.traditional.balance = 400000;   // legacy aggregate, no owner
  p.portfolio.extraAccounts = [];
  const r = resolveInputs(p, {});
  let res;
  assert.doesNotThrow(() => {
    res = runSimulation(p, {}, [generateReturnPath(r.horizonYears, r.portfolio)]);
  }, 'no uncontrolled exception may escape');
  assert.strictEqual(res.projectionStatus, 'unavailable');
  assert.strictEqual(res.successRate, null);
  assert.strictEqual(res.issue, 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE');
  assert.ok(Number.isInteger(res.issueAge), 'the failing age is reported');
});

test('the live Scenarios entry point completes for a two-owner household', async () => {
  const { runFederalFundingSimulation } = await import('./src/planning/tax/runMonteCarloWithFederalFunding.js');
  const { buildReadyCurrent1040Intake } = await import('./src/planning/tax/buildCurrent1040Intake.js');
  const p = mfjTwoOwnerPlan();
  const r = resolveInputs(p, {});
  resetSeed();
  const paths = [generateReturnPath(r.horizonYears, r.portfolio)];
  const res = runFederalFundingSimulation(p, {}, paths, {
    baseTaxYear: 2026,
    scenarioId: 'per-owner-rmd',
    filingStatus: 'marriedFilingJointly',
    current1040Intake: buildReadyCurrent1040Intake(p),
  });
  // runSimulation alone did not reproduce the original defect; the federal
  // funding path is what Scenarios actually calls, so it is tested explicitly.
  assert.notStrictEqual(res.projectionStatus, 'unavailable');
  assert.ok(Number.isFinite(res.successRate));
});

test('a heavy-withdrawal projection cannot corrupt a later untouched one', () => {
  // allocateTraditionalDistribution returns a shared frozen object on its
  // no-draw fast path, and applyTraditionalMidyearWithdrawal compares against
  // it by identity. If a refactor ever mutated that object, one plan's
  // withdrawals would leak into every later plan's no-draw years — silently,
  // and everywhere at once. Guarded behaviorally so no test-only export is
  // needed: run a draw-heavy plan first, then confirm a quiet plan is bit-for-
  // bit identical to running it on its own.
  const quiet = () => {
    const q = mfjTwoOwnerPlan();          // no expenses, so no traditional draw
    q.household.primary = { currentAge: 55, retirementAge: 60, planEndAge: 70, birthYear: 1971 };
    q.household.spouse  = { currentAge: 55, retirementAge: 60, planEndAge: 70, birthYear: 1971 };
    return q;
  };
  const pathFor = (plan) => {
    const r = resolveInputs(plan, {});
    resetSeed();
    return runSinglePath(r, generateReturnPath(r.horizonYears, r.portfolio));
  };

  const alone = pathFor(quiet());
  pathFor(agedTwoOwnerPlan(76, 74, 400000));   // draw-heavy run in between
  const after = pathFor(quiet());

  assert.strictEqual(after.terminalBalance, alone.terminalBalance,
    'a prior plan with heavy withdrawals must not change this one');
  assert.deepStrictEqual(
    after.rows.map(r => r.accountBalances && r.accountBalances.traditional),
    alone.rows.map(r => r.accountBalances && r.accountBalances.traditional),
    'every year of the traditional sleeve must match'
  );
});

test('projection assumptions are surfaced, not held privately', () => {
  // A prorated contribution owner is an assumption the projection had to make.
  // It has to reach the caller — a number that quietly depends on a guess is
  // the failure mode this whole change exists to remove.
  const p = mfjTwoOwnerPlan();
  p.household.primary = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
  p.household.spouse  = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
  p.savings = { annual: 45000, split: { traditional: 1, roth: 0, taxable: 0 } };

  const r = resolveInputs(p, {});
  resetSeed();
  const sim = runSinglePath(r, generateReturnPath(r.horizonYears, r.portfolio));
  assert.ok(Array.isArray(sim.assumptions), 'each path reports its assumptions');
  assert.ok(sim.assumptions.includes('TRADITIONAL_CONTRIBUTION_OWNER_PRORATED'),
    'the prorated contribution owner is recorded');

  resetSeed();
  const analysis = runSimulation(p, {}, [generateReturnPath(r.horizonYears, r.portfolio)]);
  assert.ok(analysis.assumptions.includes('TRADITIONAL_CONTRIBUTION_OWNER_PRORATED'),
    'and reaches the analysis the UI consumes');

  // An explicit per-owner split is determinate, so it carries no assumption.
  const explicit = structuredClone(p);
  explicit.savings.split.byOwner = { client: 1, spouse: 0 };
  resetSeed();
  const clean = runSinglePath(resolveInputs(explicit, {}), generateReturnPath(25));
  assert.ok(!clean.assumptions.includes('TRADITIONAL_CONTRIBUTION_OWNER_PRORATED'),
    'an explicit allocation is a fact, not an assumption');
});

/* Spending lives on the Goals page.
   plan.expenses is retired: living/housing/debt/healthcare/extra are goals now.
   These lock the conversion being lossless and the healthcare escalation
   surviving the move, because a silent change here alters every saved plan. */

function noLegacyExpenses(p){
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0.02, extra: [] };
  return p;
}

test('a healthcare goal reproduces the retired expenses.healthcare curve exactly', () => {
  const mk = () => {
    const p = structuredClone(defaultPlan);
    p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
    noLegacyExpenses(p);
    p.goals = [];
    return p;
  };
  const oldWay = mk();
  oldWay.expenses.healthcare = 11000;        // folded in by the engine
  const newWay = mk();
  newWay.meta.spendingSchemaVersion = 1;     // already migrated
  newWay.goals = [{ name: 'Healthcare', system: 'healthcare', amount: 11000,
                    startsAtRetirement: true, endAge: 999, realGrowth: 0.02 }];

  const a = runSinglePath(resolveInputs(oldWay, {}), generateReturnPath(31));
  const b = runSinglePath(resolveInputs(newWay, {}), generateReturnPath(31));
  for(let i = 0; i < a.rows.length; i++){
    const before = (a.rows[i].expenses || 0) + (a.rows[i].goals || 0);
    const after = (b.rows[i].expenses || 0) + (b.rows[i].goals || 0);
    assert.ok(Math.abs(before - after) < 1e-6, 'age ' + a.rows[i].age);
  }
  // And it really escalates rather than quietly flattening.
  const first = b.rows[0].expenses;
  const last = b.rows[b.rows.length - 1].expenses;
  assert.ok(last > first * 1.7, 'healthcare compounds above CPI across retirement');
});

test('essentials stay flat real while healthcare escalates', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  noLegacyExpenses(p);
  p.meta.spendingSchemaVersion = 1;
  p.goals = [{ name: 'Essentials', system: 'essentials', amount: 100000,
               startsAtRetirement: true, endAge: 999, realGrowth: 0 }];
  const sim = runSinglePath(resolveInputs(p, {}), generateReturnPath(31));
  const first = sim.rows[0].expenses;
  const last = sim.rows[sim.rows.length - 1].expenses;
  assert.ok(Math.abs(first - 100000) < 1e-6, 'essentials start at the entered amount');
  assert.ok(Math.abs(last - first) < 1e-6, 'and never drift, being flat real dollars');
});

test('a system goal starting at retirement follows the retirement-age lever', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 60, retirementAge: 65, planEndAge: 90 };
  noLegacyExpenses(p);
  p.meta.spendingSchemaVersion = 1;
  p.goals = [{ name: 'Essentials', system: 'essentials', amount: 50000,
               startsAtRetirement: true, endAge: 999, realGrowth: 0 }];

  assert.strictEqual(resolveInputs(p, {}).goals[0].startAge, 65);
  // Retiring two years later must carry essentials with it, not leave them behind.
  assert.strictEqual(resolveInputs(p, { retireDelay: 2 }).goals[0].startAge, 67);
});

test('migrating a legacy plan preserves total spending year by year', () => {
  const legacy = structuredClone(defaultPlan);
  legacy.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  legacy.expenses = { living: 120000, housing: 18000, debt: 6000, healthcare: 11000,
                      healthcareRealGrowth: 0.02,
                      extra: [{ label: 'Travel', amount: 9000, startAge: 66, endAge: 75 }] };
  legacy.goals = [{ name: 'Gifts', amount: 5000, startAge: 0, endAge: 999 }];

  const migrated = migrateSpendingToGoals(legacy).plan;
  assert.strictEqual(migrated.expenses.living, 0, 'the retired channel is emptied');
  assert.strictEqual(migrated.meta.spendingSchemaVersion, 1);

  const before = runSinglePath(resolveInputs(legacy, {}), generateReturnPath(31));
  const after = runSinglePath(resolveInputs(migrated, {}), generateReturnPath(31));
  for(let i = 0; i < before.rows.length; i++){
    const b = (before.rows[i].expenses || 0) + (before.rows[i].goals || 0);
    const a = (after.rows[i].expenses || 0) + (after.rows[i].goals || 0);
    assert.ok(Math.abs(a - b) < 1e-6, 'age ' + before.rows[i].age);
  }
});

test('migration converts what a plan has and never invents spending', () => {
  // A saved household with no healthcare figure must not acquire the per-person
  // preload. That would change a plan without anyone asking for it.
  const p = structuredClone(defaultPlan);
  p.expenses = { living: 40000, housing: 0, debt: 0, healthcare: 0,
                 healthcareRealGrowth: 0.02, extra: [] };
  p.goals = [];
  const migrated = migrateSpendingToGoals(p).plan;
  assert.strictEqual(migrated.goals.find(g => g.system === 'healthcare').amount, 0,
    'no invented healthcare spending');
  assert.strictEqual(migrated.goals.find(g => g.system === 'essentials').amount, 40000);
});

test('spending migration is idempotent', () => {
  const p = structuredClone(defaultPlan);
  p.expenses = { living: 40000, housing: 0, debt: 0, healthcare: 5000,
                 healthcareRealGrowth: 0.02, extra: [] };
  const once = migrateSpendingToGoals(p).plan;
  const twice = migrateSpendingToGoals(once);
  assert.strictEqual(twice.changed, false, 'a migrated plan is left alone');
  assert.deepStrictEqual(twice.plan.goals, once.goals);
});

test('the spending lever scales discretionary goals but never healthcare', () => {
  const p = structuredClone(defaultPlan);
  p.expenses = { living: 100000, housing: 0, debt: 0, healthcare: 10000,
                 healthcareRealGrowth: 0.02,
                 extra: [{ label: 'Travel', amount: 10000, startAge: 66, endAge: 75 }] };
  p.goals = [{ name: 'Gifts', amount: 5000, startAge: 0, endAge: 999 }];
  const migrated = migrateSpendingToGoals(p).plan;
  const amounts = ov => Object.fromEntries(
    resolveInputs(migrated, ov).goals.map(g => [g.name, Math.round(g.amount)]));

  assert.deepStrictEqual(amounts({}),
    { Essentials: 100000, Healthcare: 10000, Travel: 10000, Gifts: 5000 });
  assert.deepStrictEqual(amounts({ spendCut: 0.2 }),
    { Essentials: 80000, Healthcare: 10000, Travel: 8000, Gifts: 5000 });
  assert.deepStrictEqual(amounts({ livingAnnual: 60000 }),
    { Essentials: 60000, Healthcare: 10000, Travel: 10000, Gifts: 5000 });
});

test('the essentials override works from a zero base', () => {
  // Every new household starts with Essentials at zero, so a percentage swing
  // has no meaning. The scenario input must still set a real figure.
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 70 };
  noLegacyExpenses(p);
  p.goals = [];
  const essentials = resolveInputs(p, { livingAnnual: 72000 })
    .goals.find(g => g.system === 'essentials');
  assert.ok(essentials, 'an essentials goal exists for the override to land on');
  assert.strictEqual(essentials.amount, 72000);
});

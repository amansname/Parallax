// Engine contract: path assessment. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { runSimulation, runHistoricalPath, resolveInputs, defaultPlan, resetSeed } from '../../engine.js';
import { pathDigest, assessPlan, ASSESSMENT_RULES } from '../../engine.js';

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

test('pathDigest exposes real portfolio stress and plan-margin metrics from authoritative retirement rows', () => {
  const rows = [
    { year: 1, age: 78, phase: 'ret', source: 1973, returnRate: 0.1,
      startBalance: 1_000, balance: 1_100, withdrawal: 50, wdRate: 5,
      fundingShortfall: 0, failed: false },
    { year: 2, age: 79, phase: 'ret', source: 1974, returnRate: -0.1,
      startBalance: 1_100, balance: 880, withdrawal: 67.1, wdRate: 6.1,
      fundingShortfall: 0, failed: false },
    { year: 3, age: 80, phase: 'ret', source: 1975, returnRate: -0.2,
      startBalance: 880, balance: 660, withdrawal: 52.8, wdRate: 6,
      fundingShortfall: 0, failed: false },
    { year: 4, age: 81, phase: 'ret', source: 1976, returnRate: 0.2,
      startBalance: 660, balance: 770, withdrawal: 77, wdRate: 8,
      fundingShortfall: 0, failed: false },
  ];
  const digest = pathDigest({
    rows,
    terminalBalance: 770,
    cagr: 0,
    first10Cagr: 0,
    minBalance: 660,
    failed: false,
    depletionAge: null,
    lifetimeTax: 0,
  });

  assert.equal(digest.maxRealDrawdownPct, 40);
  assert.equal(digest.maxRealDrawdownTroughAge, 80);
  assert.equal(digest.yearsAboveSixPctWdRate, 2, '6.0% is not above the threshold');
  assert.equal(digest.portfolioUnderwaterYearsMax, 3);
  assert.equal(digest.portfolioRecoveryPeriodStatus, 'never');
  assert.equal(digest.portfolioRecoveryPeriodYears, null);
  assert.equal(digest.realBalanceAtAge80, 660);
  assert.equal(digest.fundedThroughAge, 81);
  assert.equal(digest.planEndAge, 81);
  assert.equal(digest.fundingMarginYears, 10);
  assert.equal(digest.fundingMarginKind, 'zero-return-runway');
});

test('pathDigest never fabricates age-80 balance or runway after underfunding', () => {
  const rows = [
    { year: 1, age: 78, phase: 'ret', source: 1973, returnRate: 0,
      startBalance: 100, balance: 100, withdrawal: 5, wdRate: 5,
      fundingShortfall: 0, failed: false },
    { year: 2, age: 79, phase: 'ret', source: 1974, returnRate: -1,
      startBalance: 100, balance: 0, withdrawal: 100, wdRate: 100,
      fundingShortfall: 10, failed: true },
    { year: 3, age: 80, phase: 'ret', source: null, returnRate: 0,
      startBalance: 0, balance: 0, withdrawal: 0, wdRate: 0,
      fundingShortfall: 0, failed: true },
    { year: 4, age: 81, phase: 'ret', source: null, returnRate: 0,
      startBalance: 0, balance: 0, withdrawal: 0, wdRate: 0,
      fundingShortfall: 0, failed: true },
  ];
  const digest = pathDigest({
    rows,
    terminalBalance: 0,
    cagr: -1,
    first10Cagr: -1,
    minBalance: 0,
    failed: true,
    depletionAge: 79,
    lifetimeTax: 0,
  });

  assert.equal(digest.maxRealDrawdownPct, 100);
  assert.equal(digest.maxRealDrawdownTroughAge, 79);
  assert.equal(digest.portfolioUnderwaterYearsMax, 1);
  assert.equal(digest.portfolioRecoveryPeriodStatus, 'never');
  assert.equal(digest.portfolioRecoveryPeriodYears, null);
  assert.equal(digest.realBalanceAtAge80, null);
  assert.equal(digest.fundedThroughAge, 78);
  assert.equal(digest.planEndAge, 81);
  assert.equal(digest.fundingMarginYears, -3);
  assert.equal(digest.fundingMarginKind, 'years-short');
});

test('pathDigest recovery period distinguishes no dip, recovered spells, and an open final spell', () => {
  const digestFor = balances => {
    const rows = balances.map((balance, index) => ({
      year: index + 1,
      age: 65 + index,
      phase: 'ret',
      source: 1995 + index,
      returnRate: 0,
      startBalance: index === 0 ? 1_000 : balances[index - 1],
      balance,
      withdrawal: 10,
      wdRate: 1,
      fundingShortfall: 0,
      failed: false,
    }));
    return pathDigest({
      rows,
      terminalBalance: balances.at(-1),
      cagr: 0,
      first10Cagr: 0,
      minBalance: Math.min(...balances),
      failed: false,
      depletionAge: null,
      lifetimeTax: 0,
    });
  };

  const noDip = digestFor([1_050, 1_000, 1_100]);
  assert.equal(noDip.portfolioRecoveryPeriodStatus, 'no-dip');
  assert.equal(noDip.portfolioRecoveryPeriodYears, 0);

  const recovered = digestFor([900, 850, 1_000, 950, 1_010]);
  assert.equal(recovered.portfolioRecoveryPeriodStatus, 'recovered');
  assert.equal(recovered.portfolioRecoveryPeriodYears, 2);
  assert.equal(recovered.portfolioUnderwaterYearsMax, 2);

  const openFinalSpell = digestFor([900, 1_000, 950]);
  assert.equal(openFinalSpell.portfolioRecoveryPeriodStatus, 'never');
  assert.equal(openFinalSpell.portfolioRecoveryPeriodYears, null);
  assert.equal(openFinalSpell.portfolioUnderwaterYearsMax, 1);
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

// Projection Engine implementation; public consumers import engine.js.
import { RETURN_SERIES_PROVENANCE } from '../portfolioReturns.js';

export function analyzeResults(sims, p){
  const ns = sims.length;
  const survived = sims.filter(s => !s.failed).length;

  // Total starting balance across all three accounts — used as the envelope
  // origin point and as the comparison baseline for "above starting" metrics.
  const startingTotal = p.accounts.taxable.balance + p.accounts.traditional.balance + p.accounts.roth.balance;

  // Year-by-year percentile envelope — computed FIRST so we can use it for
  // path centrality selection below. At each year, sort all simulation balances
  // and take percentile cuts. Note: envelope is NOT a coherent path; it's the
  // boundary of outcomes at each year.
  const horizon = p.horizonYears;
  const envelope = [{
    year: 0,
    p10: startingTotal, p25: startingTotal,
    p50: startingTotal, p75: startingTotal,
    p90: startingTotal
  }];
  for(let y = 0; y < horizon; y++){
    const bals = sims.map(s => s.rows[y] ? s.rows[y].balance : 0).sort((a,b)=>a-b);
    envelope.push({
      year: y + 1,
      p10: bals[Math.floor(ns * 0.10)],
      p25: bals[Math.floor(ns * 0.25)],
      p50: bals[Math.floor(ns * 0.50)],
      p75: bals[Math.floor(ns * 0.75)],
      p90: bals[Math.floor(ns * 0.90)]
    });
  }

  // Path selection for Stressed/Favorable: sort by balance after 10 RETIREMENT years.
  // Stressed = worst early sequence → surfaces the sequence-risk story clients need
  // to understand. Bad early returns during withdrawals are the primary retirement risk.
  // Favorable = best early sequence → shows what good early compounding looks like.
  // Uses balanceAtRet10 (retirement-relative), so accumulation years do not drive the
  // ranking when retirementAge > currentAge. Terminal balance is correct for the Summary
  // distribution but wrong here — Plan Drivers is sequence-of-returns risk, not final
  // outcome ranking. Terminal balance only breaks ties (e.g. two early-failed sims at 0).
  const bySequence = sims.slice().sort((a, b) => {
    if(a.balanceAtRet10 !== b.balanceAtRet10) return a.balanceAtRet10 - b.balanceAtRet10;
    return a.terminalBalance - b.terminalBalance;
  });
  const byCagr = sims.slice().sort((a, b) => a.cagr - b.cagr);

  // Centrality score: sum of proportional deviations from year-by-year median.
  // Proportional (rather than absolute) so later high-balance years don't dominate.
  // The most central path is the one that tracks the median envelope closest.
  function centrality(sim){
    let score = 0;
    for(let y = 0; y < sim.rows.length; y++){
      const med = envelope[y + 1].p50;
      if(med > 0.01){
        score += Math.abs(sim.rows[y].balance - med) / med;
      }
    }
    return score;
  }
  const withCent = sims.map((s, i) => ({ sim: s, i, c: centrality(s) }));
  withCent.sort((a, b) => a.c - b.c);

  // Two-stage MEDOID so the representative (p50) path is central AND realistically
  // bumpy — a median *sequence*, never a balance-central-but-volatility outlier
  // (e.g. a crash-then-lucky-recovery path that only lands median at the very end):
  //   Stage 1: keep the most central-by-outcome decile (paths whose whole trajectory
  //            tracks the median envelope) — that's what makes it "typical".
  //   Stage 2: within that set, take the path whose year-to-year return volatility is
  //            closest to the median, so it still reads like a real market, not a
  //            smoothed line.
  // Display-only: this changes WHICH sample path the cash-flow table surfaces; it does
  // NOT touch successRate, terminal, or the envelope (the truth math is untouched).
  function returnStdDev(sim){
    const rs = sim.rows.map(r => r.realReturnUsed ?? r.returnRate ?? 0);
    if(!rs.length) return 0;
    const m = rs.reduce((a, b) => a + b, 0) / rs.length;
    return Math.sqrt(rs.reduce((s, r) => s + (r - m) ** 2, 0) / rs.length);
  }
  const sdAll = sims.map(returnStdDev);
  const medianSd = sdAll.slice().sort((a, b) => a - b)[Math.floor(sdAll.length / 2)];
  const centralCount = Math.max(1, Math.ceil(withCent.length * 0.10));
  let centralIdx = withCent[0].i, bestSdGap = Infinity;
  for(let k = 0; k < centralCount; k++){
    const g = Math.abs(sdAll[withCent[k].i] - medianSd);
    if(g < bestSdGap){ bestSdGap = g; centralIdx = withCent[k].i; }
  }
  const typicalPath = sims[centralIdx];

  const paths = {
    p10: bySequence[Math.floor(ns * 0.10)],
    p25: bySequence[Math.floor(ns * 0.25)],
    p50: typicalPath,
    p75: bySequence[Math.floor(ns * 0.75)],
    p90: bySequence[Math.floor(ns * 0.90)]
  };

  // Terminal balance distribution — independent of path selection sort.
  const terms = sims.map(s => s.terminalBalance).sort((a, b) => a - b);
  const terminal = {
    p10: terms[Math.floor(ns * 0.10)],
    p25: terms[Math.floor(ns * 0.25)],
    p50: terms[Math.floor(ns * 0.50)],
    p75: terms[Math.floor(ns * 0.75)],
    p90: terms[Math.floor(ns * 0.90)]
  };

  // Aggregate risk metrics.
  const failedSims    = sims.filter(s => s.failed);
  const survivorSims  = sims.filter(s => !s.failed);

  // Depletion age — already scoped to failed paths.
  const deplAges = failedSims.map(s => s.depletionAge).filter(a => a !== null).sort((a,b)=>a-b);
  const medianDepletionAge = deplAges.length > 0
    ? deplAges[Math.floor(deplAges.length / 2)]
    : null;

  // Min balance and max drawdown — scoped to SURVIVORS only.
  // Including failed paths makes these metrics collapse to $0 / 100% on stressed
  // plans, which is uninformative (a failed path always hits zero by definition).
  // Among survivors, these answer "of the plans that worked, how close did
  // they come to failure?" — a real sequence-risk signal.
  const sMinBals = survivorSims.map(s => s.minBalance).sort((a,b)=>a-b);
  const medianMinBalanceSurvivors = sMinBals.length > 0
    ? sMinBals[Math.floor(sMinBals.length / 2)]
    : null;

  const sDDs = survivorSims.map(s => s.maxDrawdown).sort((a,b)=>a-b);
  const medianMaxDrawdownSurvivors = sDDs.length > 0
    ? sDDs[Math.floor(sDDs.length / 2)]
    : null;

  // Worst overall drawdown across all paths (not just survivors). Useful even
  // when failures exist because it indicates how steep the worst case got.
  const worstMaxDrawdown = sims.reduce((m, s) => s.maxDrawdown > m ? s.maxDrawdown : m, -Infinity);

  const worstFirst10Cagr = sims.reduce((m, s) => s.first10Cagr < m ? s.first10Cagr : m, Infinity);

  // Years underwater — median count of years a path's balance sits below its
  // starting (real) capital. A direct sequence-risk read: how long the plan
  // spends in a hole. Failed-path filler rows (balance 0) count as underwater.
  const uwCounts = sims.map(s => s.rows.filter(r => r.balance < startingTotal - 0.01).length).sort((a,b)=>a-b);
  const medianYearsUnderwater = uwCounts.length ? uwCounts[Math.floor(uwCounts.length / 2)] : 0;

  // Derived probability counts — power the connective-tissue text strip.
  const aboveStartCount   = sims.filter(s => s.terminalBalance > startingTotal).length;
  const doubledCount      = sims.filter(s => s.terminalBalance > 2 * startingTotal).length;
  const bigDrawdownCount  = sims.filter(s => s.maxDrawdown > 0.40).length;

  const taxAmounts = sims.map(s => s.lifetimeTax).sort((a,b) => a - b);
  const medianLifetimeTax = taxAmounts[Math.floor(ns * 0.50)];

  return {
    paths, terminal, envelope,
    sims,
    returnSeriesProvenance: RETURN_SERIES_PROVENANCE,
    successRate: (survived / ns) * 100,
    // Union of the modeling assumptions any path had to make, so a caller can
    // show what a number depends on instead of presenting it as unqualified.
    assumptions: [...new Set(sims.flatMap(s => s.assumptions || []))],
    survived, total: ns,
    medianCagr: byCagr[Math.floor(ns * 0.50)].cagr,
    horizonYears: p.horizonYears,
    iterations: ns,
    params: p,
    medianLifetimeTax,
    metrics: {
      medianDepletionAge,
      medianMinBalanceSurvivors,
      medianMaxDrawdownSurvivors,
      medianYearsUnderwater,
      worstMaxDrawdown,
      worstFirst10Cagr,
      aboveStartCount,
      doubledCount,
      bigDrawdownCount
    }
  };
}

/* ── PATH DIGEST ─────────────────────────────────────────────────────────────
   Pure read-only summary of ONE simulation result (Monte Carlo path or
   historical run). Computes the aggregates the narrative surfaces print, so
   every number on screen is engine output rather than UI math. No state, no
   mutation: same input → same digest. `params` (a resolveInputs result) is
   optional and only unlocks spendShareOfStart. */
export function pathDigest(sim, params){
  const rows    = (sim && sim.rows) ? sim.rows : [];
  // Real rows exclude post-depletion filler (source === null after failure).
  const real    = rows.filter(r => r.source != null);
  const retRows = real.filter(r => r.phase !== 'accum');
  const wdRows  = retRows.filter(r => r.wdRate > 0);

  // Withdrawal pressure — wdRate is stored in PERCENT on the row.
  let peakWdRate = 0, peakWdAge = null, wdSum = 0;
  for(const r of wdRows){
    wdSum += r.wdRate;
    if(r.wdRate > peakWdRate){ peakWdRate = r.wdRate; peakWdAge = r.age; }
  }
  const avgWdRate = wdRows.length ? wdSum / wdRows.length : 0;

  // Early sequence — the first 10 retirement years, where sequence risk lives.
  const early = retRows.slice(0, 10);
  const negEarlyYears = early.filter(r => r.returnRate < 0).length;

  // Damage window — longest run of retirement years the cumulative return sat
  // below its retirement-day level. (Same definition the Sequencing prints use.)
  let g = 1, cur = 0, underwaterSpellMax = 0;
  for(const r of retRows){
    g *= (1 + r.returnRate);
    if(g < 1){ cur++; if(cur > underwaterSpellMax) underwaterSpellMax = cur; }
    else cur = 0;
  }

  // Real-portfolio stress — balances in the Projection Engine are already in
  // today's dollars. These aggregates deliberately use portfolio values, not
  // the return-only damage window above: withdrawals and taxes are part of the
  // path the household actually experiences.
  const portfolioStartingRealBalance = Number.isFinite(retRows[0]?.startBalance)
    && retRows[0].startBalance >= 0
    ? retRows[0].startBalance
    : null;
  let maxRealDrawdownPct = null;
  let maxRealDrawdownTroughAge = null;
  let portfolioUnderwaterYearsMax = null;
  let portfolioRecoveryPeriodStatus = null;
  let portfolioRecoveryPeriodYears = null;
  if(portfolioStartingRealBalance !== null){
    let runningPeak = portfolioStartingRealBalance;
    let maxDrawdown = 0;
    let underwaterYears = 0;
    let longestClosedUnderwaterYears = 0;
    let dippedBelowStart = false;
    portfolioUnderwaterYearsMax = 0;
    for(const r of retRows){
      if(!Number.isFinite(r.balance) || r.balance < 0) continue;
      if(r.balance > runningPeak) runningPeak = r.balance;
      const drawdown = runningPeak > 0
        ? ((runningPeak - r.balance) / runningPeak) * 100
        : 0;
      if(drawdown > maxDrawdown){
        maxDrawdown = drawdown;
        maxRealDrawdownTroughAge = Number.isFinite(r.age) ? r.age : null;
      }
      if(r.balance < portfolioStartingRealBalance - 0.01){
        dippedBelowStart = true;
        underwaterYears += 1;
        if(underwaterYears > portfolioUnderwaterYearsMax){
          portfolioUnderwaterYearsMax = underwaterYears;
        }
      }else{
        if(underwaterYears > longestClosedUnderwaterYears){
          longestClosedUnderwaterYears = underwaterYears;
        }
        underwaterYears = 0;
      }
    }
    maxRealDrawdownPct = maxDrawdown;
    if(!dippedBelowStart){
      portfolioRecoveryPeriodStatus = 'no-dip';
      portfolioRecoveryPeriodYears = 0;
    }else if(underwaterYears > 0){
      portfolioRecoveryPeriodStatus = 'never';
    }else{
      portfolioRecoveryPeriodStatus = 'recovered';
      portfolioRecoveryPeriodYears = longestClosedUnderwaterYears;
    }
  }

  const yearsAboveSixPctWdRate = retRows.filter(
    r => Number.isFinite(r.wdRate) && r.wdRate > 6
  ).length;
  const age80Rows = real.filter(r => r.age === 80 && Number.isFinite(r.balance) && r.balance >= 0);
  const realBalanceAtAge80 = age80Rows.length === 1 ? age80Rows[0].balance : null;

  // Funding margin converts a surviving terminal dollar figure into a
  // conservative, zero-return runway at the final modeled gross portfolio
  // draw. Failed paths instead report the exact number of plan years missed.
  // A zero final draw is not treated as infinite runway.
  const resolvedPlanEndAges = [
    params?.people?.client?.planEndAgeOnPrimaryTimeline,
    params?.people?.spouse?.planEndAgeOnPrimaryTimeline,
  ].filter(Number.isFinite);
  const planEndAge = resolvedPlanEndAges.length > 0
    ? Math.max(...resolvedPlanEndAges)
    : (Number.isFinite(rows.at(-1)?.age) ? rows.at(-1).age : null);
  const firstUnderfundedRow = retRows.find(r => (
    (Number.isFinite(r.fundingShortfall) && r.fundingShortfall > 0.01)
      || r.failed === true
  )) ?? null;
  const fullyFundedRetirementRows = retRows.filter(r => (
    Number.isFinite(r.fundingShortfall)
      && r.fundingShortfall <= 0.01
      && r.failed !== true
      && Number.isFinite(r.age)
  ));
  const lastFundedRetirementRow = fullyFundedRetirementRows.at(-1) ?? null;
  const fundedThroughAge = Number.isFinite(lastFundedRetirementRow?.age)
    ? lastFundedRetirementRow.age
    : (Number.isFinite(firstUnderfundedRow?.age) ? firstUnderfundedRow.age - 1 : null);
  let fundingMarginYears = null;
  let fundingMarginKind = 'unavailable';
  if(firstUnderfundedRow){
    if(Number.isFinite(fundedThroughAge) && Number.isFinite(planEndAge)){
      fundingMarginYears = fundedThroughAge - planEndAge;
    }
    fundingMarginKind = 'years-short';
  }else{
    const finalRetirementRow = retRows.at(-1) ?? null;
    if(Number.isFinite(finalRetirementRow?.withdrawal) && finalRetirementRow.withdrawal > 0
        && Number.isFinite(finalRetirementRow.balance) && finalRetirementRow.balance >= 0){
      fundingMarginYears = finalRetirementRow.balance / finalRetirementRow.withdrawal;
      fundingMarginKind = 'zero-return-runway';
    }else if(finalRetirementRow
        && Number.isFinite(finalRetirementRow?.withdrawal)
        && finalRetirementRow.withdrawal === 0){
      fundingMarginKind = 'no-portfolio-draw';
    }
  }

  // Taxes by source. Row taxBySource covers SS / other income / funding
  // withdrawals; forced-RMD tax is inside row.taxes but not the breakdown, so
  // traditional is taken as the residual — RMD tax lands where it belongs.
  let taxTotal = 0, ssTax = 0, oiTax = 0, taxableTax = 0;
  for(const r of retRows){
    taxTotal   += (r.taxes || 0);
    if(r.taxBySource){
      ssTax      += (r.taxBySource.ss      || 0);
      oiTax      += (r.taxBySource.oi      || 0);
      taxableTax += (r.taxBySource.taxable || 0);
    }
  }
  const tradTax = Math.max(0, taxTotal - ssTax - oiTax - taxableTax);
  const taxSourceTotals = { socialSecurity: ssTax, otherIncome: oiTax, traditional: tradTax, taxable: taxableTax };
  const taxSourceShares = {};
  let dominantTaxSource = null, dominantTaxShare = 0;
  for(const k of Object.keys(taxSourceTotals)){
    const share = taxTotal > 0 ? taxSourceTotals[k] / taxTotal : 0;
    taxSourceShares[k] = share;
    if(share > dominantTaxShare){ dominantTaxShare = share; dominantTaxSource = k; }
  }

  // Guaranteed-income coverage — SS + pension over all retirement outflows.
  let guaranteed = 0, outflows = 0;
  for(const r of retRows){
    guaranteed += (r.socialSecurity || 0) + (r.pension || 0);
    outflows   += (r.expenses || 0) + (r.goals || 0) + (r.liabilities || 0) + (r.taxes || 0);
  }
  const fixedIncomeShare = outflows > 0 ? guaranteed / outflows : null;

  // Core annual spend vs starting assets — needs resolved params.
  let spendShareOfStart = null;
  if(params && params.expenses && params.accounts){
    let spend = 0;
    for(const v of Object.values(params.expenses)) if(typeof v === 'number') spend += v;
    const start = params.accounts.taxable.balance + params.accounts.traditional.balance + params.accounts.roth.balance;
    spendShareOfStart = start > 0 ? spend / start : null;
  }

  return {
    startBalance: rows.length ? rows[0].startBalance : null,
    endBalance:   sim.terminalBalance,
    realCagr:     sim.cagr,
    first10Cagr:  sim.first10Cagr,
    first10Supports: sim.first10Cagr >= 0,
    minBalance:   sim.minBalance,
    failed:       !!sim.failed,
    depletionAge: sim.depletionAge != null ? sim.depletionAge : null,
    withdrawalYears: wdRows.length,
    avgWdRate, peakWdRate, peakWdAge,
    earlyWindowYears: early.length,
    negEarlyYears,
    underwaterSpellMax,
    portfolioStartingRealBalance,
    maxRealDrawdownPct,
    maxRealDrawdownTroughAge,
    yearsAboveSixPctWdRate,
    portfolioUnderwaterYearsMax,
    portfolioRecoveryPeriodStatus,
    portfolioRecoveryPeriodYears,
    realBalanceAtAge80,
    fundedThroughAge,
    planEndAge,
    fundingMarginYears,
    fundingMarginKind,
    lifetimeTax: sim.lifetimeTax,
    avgTax: retRows.length ? taxTotal / retRows.length : 0,
    taxSourceTotals, taxSourceShares, dominantTaxSource, dominantTaxShare,
    fixedIncomeShare, spendShareOfStart
  };
}

/* ── PLAN ASSESSMENT ─────────────────────────────────────────────────────────
   Rule table applied to an analyzeResults() object. Emits facts only —
   which observations apply and the numbers behind them. The UI maps ids to
   fixed sentences; nothing here recommends an action. Thresholds live in one
   place so they are visible, testable, and arguable. */
export const ASSESSMENT_RULES = {
  lowFixedSpending:  { maxSpendShareOfStart: 0.045 },  // core spend ≤ 4.5% of starting assets
  taxDiversified:    { minBucketShare: 0.15, minBuckets: 2 },
  highSuccess:       { minSuccessRate: 85 },
  withdrawalLoad:    { peakWdRatePct: 10 },            // wdRate rows are in percent
  portfolioFunded:   { minFixedIncomeShare: 0.33 }
};

export function assessPlan(analysis){
  const p   = analysis.params;
  const mid = pathDigest(analysis.paths.p50, p);
  const low = pathDigest(analysis.paths.p10, p);
  const strengths = [], pressures = [], tossups = [];

  if(mid.spendShareOfStart != null && mid.spendShareOfStart <= ASSESSMENT_RULES.lowFixedSpending.maxSpendShareOfStart){
    strengths.push({ id:'low-fixed-spending', value: mid.spendShareOfStart });
  }
  const startTotal = p.accounts.taxable.balance + p.accounts.traditional.balance + p.accounts.roth.balance;
  if(startTotal > 0){
    const shares = ['taxable','traditional','roth'].map(k => p.accounts[k].balance / startTotal);
    const buckets = shares.filter(s => s >= ASSESSMENT_RULES.taxDiversified.minBucketShare).length;
    if(buckets >= ASSESSMENT_RULES.taxDiversified.minBuckets){
      strengths.push({ id:'tax-diversified', value: buckets });
    }
  }
  if(analysis.successRate >= ASSESSMENT_RULES.highSuccess.minSuccessRate){
    strengths.push({ id:'high-success', value: analysis.successRate });
  }
  if(mid.peakWdRate >= ASSESSMENT_RULES.withdrawalLoad.peakWdRatePct){
    pressures.push({ id:'withdrawal-load', value: { avg: mid.avgWdRate, peak: mid.peakWdRate, age: mid.peakWdAge } });
  }
  if(mid.fixedIncomeShare != null && mid.fixedIncomeShare < ASSESSMENT_RULES.portfolioFunded.minFixedIncomeShare){
    pressures.push({ id:'portfolio-funded-spending', value: mid.fixedIncomeShare });
  }
  if(low.failed && !mid.failed){
    tossups.push({ id:'return-timing', value: { stressedDepletionAge: low.depletionAge } });
  }
  return { strengths, pressures, tossups };
}

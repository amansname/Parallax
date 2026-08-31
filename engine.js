import { LONGRUN_INFLATION, RETURN_DATA, EQUITY_MIX, DEFENSIVE_MIX, buildAssetWeights, RISK_PROFILES, computeAssetStats, ASSET_STATS } from './src/projection/engine/marketAssumptions.js';

import { plan } from './src/projection/engine/defaultPlan.js';

import { ssAdjust, annualMortgagePayment, resolveInputs } from './src/projection/engine/resolveInputs.js';

import { resolveWithdrawalPlannerAccountState, approveWithdrawalPlannerLeverChange, buildWithdrawalPlannerCashContract } from './src/projection/engine/withdrawalPlanner.js';

import { TRADITIONAL_OWNER_KEYS, TRADITIONAL_PERSON_OWNERS, emptyTraditionalOwnerBuckets, ZERO_TRADITIONAL_OWNER_BUCKETS, cloneTraditionalOwnerBuckets, applyDeathBoundaryRollover } from './src/projection/engine/traditionalOwners.js';

import { resolveOpeningRmd } from './src/projection/engine/requiredDistributions.js';

import { PROJECTION_EXECUTION_LIMITS, validateProjectionHorizon, validateReturnPaths } from './src/projection/engine/execution.js';

import { resolveHouseholdTimeline, externalIncomeAtAge, householdStateAtYear, householdIncomeAtYear, householdTaxStatusAtAge } from './src/projection/engine/householdTimeline.js';

import {
  ASSET_KEYS,
  ASSET_META,
} from './src/household/investmentAllocation.js';

import {
  createProjectionReturnCache,
  RETURN_SERIES_PROVENANCE,
  weightedAssetReturn,
} from './src/projection/portfolioReturns.js';

import { accountBalancesById, addProjectionCash, applyDirectBucketWithdrawal, applyProjectionContributions, applyProjectionOwnerRmd, applyProjectionYearReturnsAndWithdrawals, cloneProjectionAccountLedger, fundProjectionGap, resolveProjectionReturnFrame, rolloverProjectionAccounts, snapshotProjectionAccounts, syncProjectionAggregates, zeroProjectionAccounts } from './src/projection/accountLedger.js';

/* ============================================================================
   PARALLAX ENGINE  —  the heart of the model. Treat as SACRED.
   Block-bootstrap Monte Carlo on real (inflation-adjusted) returns, 1928–2025.
   Accounts: taxable / traditional / Roth. Accumulation + pension + LTC.
   Path-consistent: all scenarios can share one return-path bundle.

   RULE: Do not "improve" this casually. It is verified. If you change it,
   the tests in engine.test.js must still pass. Terminal wealth is NOT the
   objective — it is only a ranking/sorting device. The engine reports
   success, depletion, balances over time; the UI decides what to show.
   ============================================================================ */

function fundGap(accounts, gap, taxRates, strategy = 'taxable-first'){
  let remainingNeed = gap;
  const breakdown = { taxable: 0, traditional: 0, roth: 0 };
  const taxBySource = { taxable: 0, traditional: 0 };
  let totalTax = 0;

  const workingBal = {
    taxable:     accounts.taxable.balance,
    traditional: accounts.traditional.balance,
    roth:        accounts.roth.balance
  };
  let workingBasis = accounts.taxable.basis;

  const effRateFor = (type) => {
    if(type === 'taxable'){
      const gainPct = workingBal.taxable > 0
        ? Math.max(0, (workingBal.taxable - workingBasis) / workingBal.taxable)
        : 0;
      return gainPct * taxRates.capitalGains;
    }
    if(type === 'traditional') return taxRates.ordinary;
    return 0;
  };

  const drawFrom = (type, netNeeded) => {
    if(workingBal[type] <= 0.01 || netNeeded <= 0.01) return;
    const rate = effRateFor(type);
    const grossNeeded = rate < 0.999 ? netNeeded / (1 - rate) : netNeeded;
    const withdrawn   = Math.min(grossNeeded, workingBal[type]);
    const tax         = withdrawn * rate;
    breakdown[type]  += withdrawn;
    totalTax         += tax;
    if(type === 'taxable' || type === 'traditional') taxBySource[type] += tax;
    workingBal[type] -= withdrawn;
    remainingNeed    -= (withdrawn - tax);
    if(type === 'taxable' && accounts.taxable.balance > 0){
      const basisPortion = workingBasis / accounts.taxable.balance;
      workingBasis = Math.max(0, workingBasis - withdrawn * basisPortion);
    }
  };

  if(strategy === 'proportional'){
    // Draw from all three proportionally to their current balances.
    // Compute each account's share of total, then draw that share of the need.
    // Overflow from depleted accounts falls through to sequential fallback.
    const total = workingBal.taxable + workingBal.traditional + workingBal.roth;
    if(total > 0.01){
      // For proportional we solve: each account nets its share of the gap.
      // Since each account has a different effective rate, we iterate once:
      // target net from each = gap × (balance / total), gross up by that acct's rate.
      const types = ['taxable', 'traditional', 'roth'];
      types.forEach(type => {
        if(workingBal[type] <= 0.01) return;
        const share = gap * (workingBal[type] / total);
        drawFrom(type, share);
      });
    }
    // Proportional may leave a small residual if accounts were insufficient;
    // fall through to taxable-first for any remainder.
    if(remainingNeed > 0.01){
      for(const type of ['taxable', 'traditional', 'roth']){
        if(remainingNeed <= 0.01) break;
        drawFrom(type, remainingNeed);
      }
    }
  } else {
    // Sequential strategies: taxable-first or traditional-first
    const order = strategy === 'traditional-first'
      ? ['traditional', 'taxable', 'roth']
      : ['taxable', 'traditional', 'roth'];
    for(const type of order){
      if(remainingNeed <= 0.01) break;
      drawFrom(type, remainingNeed);
    }
  }

  return {
    totalWithdrawn: breakdown.taxable + breakdown.traditional + breakdown.roth,
    totalTax,
    breakdown,
    taxBySource,
    shortfall: Math.max(0, remainingNeed)
  };
}





























// Seeded RNG (mulberry32). The bootstrap draws are deterministic so identical
// inputs reproduce an identical success % — no sampling drift on page refresh.
// Distribution is unchanged; this only fixes *which* draws come out. Call
// resetSeed() before generating a bundle to reproduce it; pass a fresh seed
// (e.g. Date.now()) only if you deliberately want a new random bundle.
const DEFAULT_SEED = 0x9e3779b9;

let _rngState = DEFAULT_SEED >>> 0;

function resetSeed(seed = DEFAULT_SEED){ _rngState = seed >>> 0; }

function rand(){
  _rngState = (_rngState + 0x6D2B79F5) >>> 0;
  let t = _rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function generateReturnPath(horizonYears){
  validateProjectionHorizon(horizonYears, 'return path horizon');
  const path = [];
  const minBlock = 3, maxBlock = 5;
  while(path.length < horizonYears){
    const blockLen = minBlock + Math.floor(rand() * (maxBlock - minBlock + 1));
    const maxStart = RETURN_DATA.length - blockLen;
    const startIdx = Math.floor(rand() * (maxStart + 1));
    for(let i = 0; i < blockLen && path.length < horizonYears; i++){
      path.push(RETURN_DATA[startIdx + i]);
    }
  }
  return path;
}

function attachSelectedAccountDiagnostics(analysis, inputs, options){
  const detailedByIndex = new Map();
  function materialize(compact){
    const index = compact.simIndex;
    let detailed = detailedByIndex.get(index);
    if(!detailed){
      detailed = runSinglePath(inputs, compact.returnPath, {
        ...options,
        includeAccountDiagnostics: true,
      });
      detailed.simIndex = index;
      detailed.returnPath = compact.returnPath;
      detailedByIndex.set(index, detailed);
      analysis.sims[index] = detailed;
    }
    return detailed;
  }
  for(const [pathKey, compact] of Object.entries(analysis.paths)){
    analysis.paths[pathKey] = materialize(compact);
  }
  // Cash Flow compares alternatives on Baseline's selected market path, which
  // need not be one of the alternative's own percentile selections.
  for(const index of options.accountDiagnosticsSimIndices ?? []){
    materialize(analysis.sims[index]);
  }
  return analysis;
}

function runSimulation(plan, overrides = {}, returnPaths = null, options = {}){
  const inputs = resolveInputs(plan, overrides);
  if(inputs.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  if(returnPaths !== null) validateReturnPaths(returnPaths, inputs.horizonYears);
  const sims = [];
  const projectionReturnCache = options.projectionReturnCache
    ?? createProjectionReturnCache();
  const runOptions = {
    ...options,
    projectionReturnCache,
  };
  // Monte Carlo selection needs compact numeric rows for every trial, but the
  // account-allocation detail is consumed only by the representative paths.
  // Never materialize internal per-account detail, then re-run the at-most-five
  // selected paths with it.
  // When a return-path bundle is supplied it is authoritative: iterate over
  // exactly those paths so identical inputs + identical paths are reproducible.
  // (Silently generating random fill paths for missing indices broke that.)
  const iterations = returnPaths !== null ? returnPaths.length : inputs.iterations;
  if(options.accountDiagnosticsSimIndices !== undefined
      && (!Array.isArray(options.accountDiagnosticsSimIndices)
        || options.accountDiagnosticsSimIndices.some(index => !Number.isInteger(index) || index < 0 || index >= iterations))){
    throw new RangeError('accountDiagnosticsSimIndices must contain valid simulation indices');
  }
  for(let s = 0; s < iterations; s++){
    const returnPath = returnPaths
      ? returnPaths[s]
      : generateReturnPath(inputs.horizonYears);
    let sim;
    try{
      sim = runSinglePath(inputs, returnPath, {
        ...runOptions,
        includeAccountDiagnostics: false,
      });
    }catch(error){
      // A genuinely unresolvable RMD fails CLOSED — it must not escape as an
      // uncontrolled exception (which discards every scenario and leaves the UI
      // with a bare dash), and it must not be treated as zero and quietly
      // produce an authoritative-looking percentage. Callers get a structured
      // result carrying the reason and the rows computed before the stop.
      if(error?.code === 'HOUSEHOLD_RMD_UNAVAILABLE'){
        return {
          projectionStatus: 'unavailable',
          issue: error.rmdIssue || error.code,
          issueAge: error.age ?? null,
          rowsThroughIssue: error.rows || [],
          successRate: null,
        };
      }
      throw error;
    }
    sim.simIndex = s;  // anchor for path-coherent cross-strategy comparison
    sim.returnPath = returnPath;  // preserve coherent path for summary resilience / elasticity diagnostics
    sims.push(sim);
  }
  return attachSelectedAccountDiagnostics(
    analyzeResults(sims, inputs),
    inputs,
    runOptions,
  );
}




























































/**
 * A goal's cost in THIS year, in today's dollars.
 *
 * Most goals are flat real: the same purchasing power every year they run, so
 * realGrowth is 0 and this returns the entered amount. Healthcare is the case
 * that isn't — it rises faster than general inflation, so it compounds above
 * CPI from its own start age. Same curve the engine previously applied to
 * plan.expenses.healthcare, now a property of the goal rather than a hardcoded
 * special case in the year loop.
 */
function goalAmountAtAge(goal, age){
  if(!(goal.realGrowth > 0)) return goal.amount;
  const yearsRunning = Math.max(0, age - goal.startAge);
  return goal.amount * Math.pow(1 + goal.realGrowth, yearsRunning);
}

function shortcutTaxOnExternalIncome(p, { ssInc, oiTaxable, penInc }){
  const taxOnSS  = ssInc * 0.85 * p.taxRates.ordinary;
  const taxOnOI  = oiTaxable * p.taxRates.ordinary;
  const taxOnPen = penInc * p.taxRates.ordinary;
  return {
    taxOnSS, taxOnOI, taxOnPen,
    shortcutTax: taxOnSS + taxOnOI + taxOnPen,
  };
}

const FEDERAL_FUNDING_CONVERGENCE_TOLERANCE = 0.01;

const FEDERAL_FUNDING_MAX_ITERATIONS = 32;

function assertFiniteFederalFundingInputs(age, values){
  const invalid = Object.entries(values)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([name, value]) => `${name}=${String(value)}`);
  if(invalid.length){
    throw new TypeError(
      `Federal funding inputs must be finite at age ${age}: ${invalid.join(', ')}`
    );
  }
}

function cloneEngineAccounts(accounts){
  const projectionAccounts = cloneProjectionAccountLedger(accounts.projectionAccounts);
  const cloned = {
    taxable: {
      balance: 0,
      basis: 0,
    },
    traditional: {
      balance: 0,
      byOwner: emptyTraditionalOwnerBuckets(),
    },
    roth: { balance: 0 },
    projectionAccounts,
  };
  syncProjectionAggregates(projectionAccounts, cloned);
  return cloned;
}

function midyearWithdrawalFactor(returnRate){
  return Math.abs(returnRate) < 1e-7
    ? 12
    : returnRate / (Math.pow(1 + returnRate, 1 / 12) - 1);
}

// Ordinary retirement draws are spread through the year. With a negative
// annual return, less than the opening balance can actually be delivered under
// that timing convention. Scale every sleeve (and taxable basis) by the same
// capacity factor so fundGap reports the deliverable draw and explicit
// shortfall instead of funding from money lost before later installments.
function buildMidyearFundingProxy(accounts, returnRate, factor){
  const rawScale = Number.isFinite(factor) && factor > 0
    ? ((1 + returnRate) * 12) / factor
    : 0;
  const scale = Math.max(0, Math.min(1, rawScale));
  const traditionalByOwner = Object.fromEntries(
    TRADITIONAL_OWNER_KEYS.map(owner => [
      owner,
      Math.max(0, accounts.traditional.byOwner[owner] ?? 0) * scale,
    ])
  );
  return {
    taxable: {
      balance: Math.max(0, accounts.taxable.balance) * scale,
      basis: Math.max(0, accounts.taxable.basis) * scale,
    },
    traditional: {
      balance: Object.values(traditionalByOwner).reduce((sum, value) => sum + value, 0),
      byOwner: traditionalByOwner,
    },
    roth: { balance: Math.max(0, accounts.roth.balance) * scale },
  };
}

function emptyFunding(){
  return {
    totalWithdrawn: 0,
    totalTax: 0,
    breakdown: { taxable: 0, traditional: 0, roth: 0 },
    taxBySource: { taxable: 0, traditional: 0 },
    shortfall: 0,
  };
}

function accountTotal(accounts){
  return accounts.taxable.balance
    + accounts.traditional.balance
    + accounts.roth.balance;
}

function combineAccountAmounts(...maps){
  const combined = {};
  for(const map of maps){
    for(const [accountId, amount] of Object.entries(map ?? {})){
      combined[accountId] = (combined[accountId] ?? 0) + amount;
    }
  }
  return combined;
}

function traditionalWithdrawalsByOwner(ledger, withdrawalsById){
  if(!withdrawalsById || Object.keys(withdrawalsById).length === 0){
    return ZERO_TRADITIONAL_OWNER_BUCKETS;
  }
  const byOwner = emptyTraditionalOwnerBuckets();
  for(const account of ledger){
    if(account.bucket === 'traditional'){
      byOwner[account.owner] += withdrawalsById?.[account.id] ?? 0;
    }
  }
  return byOwner;
}

function appendFailedTailRows(rows, p, failedYearIndex){
  for(let z = failedYearIndex + 1; z < p.horizonYears; z++){
    rows.push({
      year:z+1, age:p.currentAge+z, source:null, returnRate:0, returnDollars:0,
      ...householdStateAtYear(p, z),
      socialSecurity:0, otherIncome:0, withdrawal:0,
      expenses:0, goals:0, taxes:0,
      startBalance:0, wdRate:0, netCashflow:0, balance:0, failed:true,
      fundingShortfall:0,
      accountBreakdown: { taxable:0, traditional:0, roth:0 },
      accountBalances:  { taxable:0, traditional:0, roth:0 }
    });
  }
}

/**
 * Rebuild one retirement year from the same opening account state for a
 * candidate federal-tax funding adjustment. The ordinary engine gap already
 * includes its shortcut tax assumptions, so the signed adjustment is the
 * difference between modeled federal tax and that candidate's shortcut tax.
 * Replaying from the opening state is what lets a lower federal liability
 * reduce withdrawals instead of pretending the savings arrived after them.
 */
function buildFederalFundingCandidate({
  openingAccounts,
  p,
  rp,
  y,
  age,
  r,
  returnFrame,
  saleProceeds,
  ssInc,
  oiInc,
  oiTaxable,
  penInc,
  taxIncome,
  expenses,
  goalsY,
  liabCost,
  lumpY,
  gap,
  taxOnSS,
  taxOnOI,
  taxOnPen,
  preFederalFunding,
  openingRmd,
  includeAccountDiagnostics,
}, taxFundingAdjustment){
  const accounts = cloneEngineAccounts(openingAccounts);
  const startBalance = accountTotal(accounts);
  const accountStartingBalances = {
    taxable: accounts.taxable.balance,
    traditional: accounts.traditional.balance,
    roth: accounts.roth.balance,
  };
  const taxableStartingBasis = accounts.taxable.basis;
  // The requirement is a function of the OPENING state, which is identical for
  // every secant candidate — so the caller resolves it once per year and passes
  // it in rather than each candidate re-deriving the same number.
  const rmdRequiredByOwner = openingRmd.requiredByOwner;
  const rmdRequired = openingRmd.required;

  const adjustedGap = gap + taxFundingAdjustment;
  const funding = adjustedGap > 0
    ? fundProjectionGap(
        accounts.projectionAccounts,
        returnFrame,
        adjustedGap,
        p.taxRates,
        p.withdrawalStrategy,
        rmdRequiredByOwner,
      )
    : emptyFunding();
  const withdrawal = funding.totalWithdrawn;
  const appliedFunding = applyProjectionYearReturnsAndWithdrawals(
    accounts.projectionAccounts,
    returnFrame,
    funding.grossById,
  );
  syncProjectionAggregates(accounts.projectionAccounts, accounts);
  const traditionalGrossByOwner = funding.traditionalGrossByOwner
    ?? emptyTraditionalOwnerBuckets();

  const taxableCapitalGain = appliedFunding.taxableCapitalGain;

  let rmdForced = 0;
  let rmdTax = 0;
  let rmdWithdrawalsById = {};
  if(rmdRequired > 0){
    // Net each owner's requirement against what THEY actually withdrew. One
    // spouse's spending draw can never satisfy the other's RMD.
    const outstandingByOwner = Object.fromEntries(
      TRADITIONAL_PERSON_OWNERS.map(owner => [owner, Math.max(
        0,
        (rmdRequiredByOwner[owner] ?? 0) - (traditionalGrossByOwner[owner] ?? 0),
      )]),
    );
    const forced = applyProjectionOwnerRmd(
      accounts.projectionAccounts,
      outstandingByOwner,
    );
    rmdForced = forced.total;
    rmdWithdrawalsById = forced.byId;
    if(rmdForced > 0.01){
      rmdTax = rmdForced * p.taxRates.ordinary;
    }
    syncProjectionAggregates(accounts.projectionAccounts, accounts);
  }

  // Save the gross lower-tax surplus for the converged solver. Attribution to
  // a forced gross-spent RMD needs the final policy liability, so crediting
  // taxable cash here would be both premature and wrong for custom policies.
  const grossTaxSavingsReinvested = Math.max(
    0,
    -(Math.max(0, gap) + taxFundingAdjustment)
  );

  const shortcutTax = taxOnSS + taxOnOI + taxOnPen + funding.totalTax + rmdTax;
  const wdRate = startBalance > 0.01 && withdrawal > 0
    ? (withdrawal / startBalance) * 100
    : 0;
  const taxableGainFraction = funding.breakdown.taxable > 0.01
    ? taxableCapitalGain / funding.breakdown.taxable
    : undefined;
  const policyRow = {
    year: y + 1,
    age,
    ...householdTaxStatusAtAge(p, age),
    source: rp.y,
    returnRate: r,
    returnDollars: returnFrame.returnDollars,
    ...(includeAccountDiagnostics ? {
      accountReturns: returnFrame.accountReturns,
      householdEffectiveAllocation: returnFrame.householdAllocation,
    } : {}),
    nominalReturn: (rp && rp.proxyNominalReturn != null) ? rp.proxyNominalReturn : null,
    inflationRate: (rp && rp.proxyInflationRate != null) ? rp.proxyInflationRate : null,
    realReturnUsed: r,
    socialSecurity: ssInc,
    otherIncome: oiInc,
    pension: penInc,
    incomeTaxFacts: { ...taxIncome },
    withdrawal,
    ...(oiInc > 0 ? { otherIncomeTaxable: oiTaxable } : {}),
    rmd: rmdForced,
    rmdRequired,
    rmdAvailable: openingRmd.available,
    rmdOwner: openingRmd.owner,
    rmdIssue: openingRmd.issue,
    // New per-owner detail. `rmd` above stays forced-only — the tax adapter
    // computes accountBreakdown.traditional + row.rmd, so redefining it would
    // double-count the ordinary draw on Form 1040.
    rmdRequiredByOwner: { ...openingRmd.requiredByOwner },
    rmdGrossByOwner: { ...traditionalGrossByOwner },
    rmdBasisSource: openingRmd.basisSource,
    assetSale: saleProceeds,
    expenses,
    goals: goalsY,
    liabilities: liabCost,
    taxes: shortcutTax,
    lumpSum: lumpY,
    startBalance,
    wdRate,
    netCashflow: (ssInc + oiInc + penInc + saleProceeds)
      - (expenses + goalsY + liabCost + shortcutTax),
    balance: accountTotal(accounts),
    failed: false,
    fundingShortfall: funding.shortfall,
    accountBreakdown: { ...funding.breakdown },
    preTaxDeltaAccountBreakdown: { ...preFederalFunding.breakdown },
    accountStartingBalances: { ...accountStartingBalances },
    taxableStartingBasis,
    taxableCapitalGain,
    accountBalances: {
      taxable: accounts.taxable.balance,
      traditional: accounts.traditional.balance,
      roth: accounts.roth.balance,
    },
    ...(includeAccountDiagnostics ? {
      accountBalancesById: accountBalancesById(accounts.projectionAccounts),
      accountStates: snapshotProjectionAccounts(accounts.projectionAccounts),
      accountWithdrawalsById: combineAccountAmounts(
        funding.grossById,
        rmdWithdrawalsById,
      ),
    } : {}),
    taxableEndingBasis: accounts.taxable.basis,
    ...(taxableGainFraction !== undefined ? { taxableGainFraction } : {}),
    taxBySource: {
      ss: taxOnSS,
      oi: taxOnOI,
      traditional: funding.taxBySource.traditional,
      taxable: funding.taxBySource.taxable,
    },
  };

  return {
    accounts,
    funding,
    policyRow,
    shortcutTax,
    grossTaxSavingsReinvested,
    rmdShortcutTax: rmdTax,
  };
}

function solveFederalFundingYear(args, taxPolicy){
  const preFederalFunding = args.gap > 0
    ? fundProjectionGap(
        args.openingAccounts.projectionAccounts,
        args.returnFrame,
        args.gap,
        args.p.taxRates,
        args.p.withdrawalStrategy,
        args.openingRmd.requiredByOwner,
      )
    : emptyFunding();
  let adjustment = 0;
  let lowerBracket = null;
  let upperBracket = null;
  let previousEvaluation = null;

  for(let iteration = 1; iteration <= FEDERAL_FUNDING_MAX_ITERATIONS; iteration++){
    const candidate = buildFederalFundingCandidate(
      { ...args, preFederalFunding },
      adjustment
    );
    const resolvedTax = taxPolicy(candidate.policyRow, {
      shortcutTax: candidate.shortcutTax,
      yearIndex: args.y,
    });
    if(!Number.isFinite(resolvedTax) || resolvedTax < 0){
      throw new TypeError('taxPolicy must return a finite non-negative tax');
    }
    const targetAdjustment = resolvedTax - candidate.shortcutTax;
    const residual = targetAdjustment - adjustment;
    if(Math.abs(residual) <= FEDERAL_FUNDING_CONVERGENCE_TOLERANCE){
      const accounts = candidate.accounts;
      let taxSavingsReinvested = candidate.grossTaxSavingsReinvested;
      if(candidate.policyRow.rmd > 0.01 && taxSavingsReinvested > 0){
        const shortcutTaxWithoutForcedRmd = Math.max(
          0,
          candidate.shortcutTax - candidate.rmdShortcutTax,
        );
        const counterfactualTax = taxPolicy({
          ...candidate.policyRow,
          rmd: 0,
          taxes: shortcutTaxWithoutForcedRmd,
          netCashflow: (
            args.ssInc + args.oiInc + args.penInc + args.saleProceeds
          ) - (args.expenses + args.goalsY + args.liabCost + shortcutTaxWithoutForcedRmd),
        }, {
          shortcutTax: shortcutTaxWithoutForcedRmd,
          yearIndex: args.y,
        });
        if(!Number.isFinite(counterfactualTax) || counterfactualTax < 0){
          throw new TypeError('taxPolicy must return a finite non-negative tax');
        }
        const actualRmdMarginalTax = Math.max(0, resolvedTax - counterfactualTax);
        const rmdTaxSaving = Math.max(
          0,
          candidate.rmdShortcutTax - actualRmdMarginalTax,
        );
        taxSavingsReinvested = Math.max(0, taxSavingsReinvested - rmdTaxSaving);
      }
      if(taxSavingsReinvested > 0){
        addProjectionCash(
          accounts.projectionAccounts,
          'taxable',
          taxSavingsReinvested,
          taxSavingsReinvested,
        );
        syncProjectionAggregates(accounts.projectionAccounts, accounts);
      }
      for(const account of accounts.projectionAccounts){
        if(account.balance < 0) account.balance = 0;
      }
      syncProjectionAggregates(accounts.projectionAccounts, accounts);
      const failed = candidate.funding.shortfall > 0.01;
      if(failed){
        zeroProjectionAccounts(accounts.projectionAccounts);
        syncProjectionAggregates(accounts.projectionAccounts, accounts);
      }
      const row = {
        ...candidate.policyRow,
        taxes: resolvedTax,
        netCashflow: (
          args.ssInc + args.oiInc + args.penInc + args.saleProceeds
        ) - (args.expenses + args.goalsY + args.liabCost + resolvedTax),
        balance: accountTotal(accounts),
        failed,
        accountBalances: {
          taxable: accounts.taxable.balance,
          traditional: accounts.traditional.balance,
          roth: accounts.roth.balance,
        },
        ...(args.includeAccountDiagnostics ? {
          accountBalancesById: accountBalancesById(accounts.projectionAccounts),
          accountStates: snapshotProjectionAccounts(accounts.projectionAccounts),
        } : {}),
        taxableEndingBasis: accounts.taxable.basis,
        taxFundingConvergence: {
          status: 'converged',
          iterations: iteration,
          tolerance: FEDERAL_FUNDING_CONVERGENCE_TOLERANCE,
          residual,
          fundingAdjustment: adjustment,
          taxSavingsReinvested,
        },
      };
      return { accounts, row, failed };
    }
    if(residual > 0){
      if(!lowerBracket || adjustment > lowerBracket.adjustment){
        lowerBracket = { adjustment, residual };
      }
    }else if(!upperBracket || adjustment < upperBracket.adjustment){
      upperBracket = { adjustment, residual };
    }
    let nextAdjustment = targetAdjustment;
    if(previousEvaluation){
      const residualDelta = residual - previousEvaluation.residual;
      if(Math.abs(residualDelta) > Number.EPSILON){
        const secant = adjustment - residual
          * (adjustment - previousEvaluation.adjustment)
          / residualDelta;
        if(Number.isFinite(secant)) nextAdjustment = secant;
      }
    }
    if(lowerBracket && upperBracket){
      const low = Math.min(lowerBracket.adjustment, upperBracket.adjustment);
      const high = Math.max(lowerBracket.adjustment, upperBracket.adjustment);
      if(!(nextAdjustment > low && nextAdjustment < high)){
        nextAdjustment = (low + high) / 2;
      }
    }
    previousEvaluation = { adjustment, residual };
    adjustment = nextAdjustment;
  }

  const error = new RangeError('TAX_POLICY_FUNDING_DID_NOT_CONVERGE');
  error.code = 'TAX_POLICY_FUNDING_DID_NOT_CONVERGE';
  throw error;
}

function runSinglePath(p, returnPath, options = {}){
  if(p.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  validateProjectionHorizon(p.horizonYears);
  validateReturnPaths([returnPath], p.horizonYears);
  const taxPolicy = options.taxPolicy ?? null;
  const fundTaxPolicyDelta = options.fundTaxPolicyDelta === true;
  const includeAccountDiagnostics = options.includeAccountDiagnostics !== false;
  const projectionReturnCache = options.projectionReturnCache
    ?? createProjectionReturnCache();
  if(taxPolicy !== null && typeof taxPolicy !== 'function'){
    throw new TypeError('options.taxPolicy must be a function');
  }
  // Each path gets its own evolving account ledger. Aggregate tax sleeves are
  // derived adapters retained for existing row and planning contracts.
  const projectionAccounts = cloneProjectionAccountLedger(p.projectionAccounts);
  const accounts = {
    taxable: { balance: 0, basis: 0 },
    traditional: { balance: 0, byOwner: emptyTraditionalOwnerBuckets() },
    roth: { balance: 0 },
    projectionAccounts,
  };
  syncProjectionAggregates(projectionAccounts, accounts);

  let returnProduct = 1;
  let failed        = false;
  let lifetimeTax   = 0;  // cumulative taxes paid across all years of this path
  const rows = [];

  // Total balance across all accounts — what we report as "portfolio balance".
  const totalBalance = () => accounts.taxable.balance + accounts.traditional.balance + accounts.roth.balance;

  // Path-level risk metrics (against total portfolio balance).
  let minBalance      = totalBalance();
  let peakBalance     = totalBalance();
  let maxDrawdown     = 0;
  let depletionAge    = null;
  let first10Product  = 1;
  let balanceAt10     = 0;
  let balanceAtRet10  = 0;
  // Owners already rolled over, so a death boundary transfers exactly once.
  const rolledOverOwners = new Set();

  for(let y = 0; y < p.horizonYears; y++){
    const age = p.currentAge + y;
    const rp  = returnPath[y];

    // ── Earmarked-asset sale ──────────────────────────────────────────────
    // Net proceeds land in the TAXABLE sleeve as after-tax cash (basis = full
    // proceeds) at the sale age, then invest and compound from here forward —
    // works in either phase. Applied via the assetSale override only; the base
    // plan is never mutated, so the Baseline column never sees it.
    const saleProceeds = (p.assetSale && age === p.assetSale.age) ? p.assetSale.netProceeds : 0;
    if(saleProceeds > 0){
      addProjectionCash(projectionAccounts, 'taxable', saleProceeds, saleProceeds);
      syncProjectionAggregates(projectionAccounts, accounts);
    }

    // ── Death boundary: spousal rollover ──────────────────────────────────
    // Applied at the opening of the year following a death, which is the same
    // instant as the closing boundary of the decedent's final living year — but
    // reachable from one place, since the retirement branches below exit via
    // `continue`. The decedent's year-of-death RMD was therefore already
    // computed and satisfied last iteration, off their own balance and age.
    // From here the survivor owns the combined balance under their own age.
    if(y > 0){
      const rollover = applyDeathBoundaryRollover(
        p,
        age,
        accounts.traditional,
        rolledOverOwners,
      );
      if(rollover){
        rolloverProjectionAccounts(projectionAccounts, rollover.from, rollover.to);
        syncProjectionAggregates(projectionAccounts, accounts);
      }
    }

    const returnFrame = resolveProjectionReturnFrame(
      projectionAccounts,
      rp,
      p.returnAdj,
      { includeAccountDiagnostics, projectionReturnCache },
    );
    const r = returnFrame.returnRate;

    // ── Per-owner RMD for the year ────────────────────────────────────────
    // Basis convention: year 0 uses each owner's raw pre-shock opening balance
    // as the assumed prior-Dec-31 figure (an initial market shock is a drop
    // occurring during the projection, not a revision of last year's
    // statement); every later year uses that owner's actual simulated prior
    // year-end close, which is exactly what `byOwner` holds right now.
    const openingRmd = resolveOpeningRmd(p, age, accounts.traditional, y);
    if(openingRmd.status === 'unavailable'){
      const error = new RangeError('HOUSEHOLD_RMD_UNAVAILABLE');
      error.code = 'HOUSEHOLD_RMD_UNAVAILABLE';
      error.rmdIssue = openingRmd.issue;
      error.age = age;
      error.rows = rows;          // keep diagnostic rows for the fail-closed result
      throw error;
    }

    // ── ACCUMULATION PHASE (age < retirementAge) ──────────────────────────
    // Still working: portfolio grows and receives savings; no retirement
    // spending or withdrawals yet. Timed external income (wages, etc.) is
    // reported on rows for Cash Flow; recurring living costs are still assumed
    // covered off-books while working. No-op at default (retirementAge==currentAge).
    if(age < p.retirementAge){
      const { ssInc, oiInc, oiTaxable, penInc, taxIncome } = externalIncomeAtAge(p, age);
      returnProduct *= (1 + r);
      if(y < 10) first10Product *= (1 + r);
      const startBalanceA = totalBalance();
      const contributionsById = applyProjectionContributions(
        projectionAccounts,
        returnFrame,
        {
          taxable: p.savingsAnnual * p.savingsSplit.taxable,
          traditional: p.savingsAnnual * p.savingsSplit.traditional,
          roth: p.savingsAnnual * p.savingsSplit.roth,
        },
      );
      syncProjectionAggregates(projectionAccounts, accounts);
      let rmdForcedA = 0;
      let rmdTaxA = 0;
      let rmdWithdrawalsByIdA = {};
      // One-time capital outlay (e.g. a home purchase) during working years. The
      // engine assumes salary covers recurring costs while working, but a large
      // purchase is funded by liquidating investments — taxable first, then
      // traditional, then Roth. (Simplification: principal only, no cap-gains tax
      // on the sale — small vs the outlay and consistent with the accum model.)
      const lumpA = (p.lumpSum > 0 && y === p.lumpSumYear) ? p.lumpSum : 0;
      // Parallax does not run a working-year household budget. A goal remains
      // off-book before both clients retire unless the advisor explicitly marks
      // it as portfolio-funded.
      let goalsA = 0;
      for(const g of p.goals){
        if(g.fundFromPortfolioBeforeRetirement && age >= g.startAge && age <= g.endAge){
          goalsA += goalAmountAtAge(g, age);
        }
      }
      const outlayA = lumpA + goalsA;
      // Working-year portfolio outlays use the same explicit funding result as
      // retirement. Zero tax rates preserve the existing principal-only
      // simplification while exposing every draw and unmet required dollar.
      const accumulationFunding = outlayA > 0
        ? fundGap(accounts, outlayA, { ordinary: 0, capitalGains: 0 }, 'taxable-first')
        : emptyFunding();
      const taxableStartingBasisA = accounts.taxable.basis;
      let taxableCapitalGainA = 0;
      let outlayWithdrawalsByIdA = {};
      if(outlayA > 0){
        for(const bucket of ['taxable', 'traditional', 'roth']){
          const direct = applyDirectBucketWithdrawal(
            projectionAccounts,
            bucket,
            accumulationFunding.breakdown[bucket],
          );
          taxableCapitalGainA += direct.taxableCapitalGain;
          outlayWithdrawalsByIdA = combineAccountAmounts(
            outlayWithdrawalsByIdA,
            direct.withdrawalsById,
          );
        }
        syncProjectionAggregates(projectionAccounts, accounts);
      }
      const traditionalOutlayByOwner = accumulationFunding.breakdown.traditional > 0.01
        && (openingRmd.required > 0 || includeAccountDiagnostics)
        ? traditionalWithdrawalsByOwner(projectionAccounts, outlayWithdrawalsByIdA)
        : ZERO_TRADITIONAL_OWNER_BUCKETS;
      if(openingRmd.required > 0){
        // A Traditional outlay already distributed by a given owner satisfies
        // that owner's RMD. Force only the remaining owner-level top-up.
        const outstandingByOwner = Object.fromEntries(
          TRADITIONAL_PERSON_OWNERS.map(owner => [owner, Math.max(
            0,
            (openingRmd.requiredByOwner[owner] ?? 0)
              - (traditionalOutlayByOwner[owner] ?? 0),
          )]),
        );
        const forcedA = applyProjectionOwnerRmd(
          projectionAccounts,
          outstandingByOwner,
        );
        rmdForcedA = forcedA.total;
        rmdWithdrawalsByIdA = forcedA.byId;
        const rmdSatisfied = TRADITIONAL_PERSON_OWNERS.reduce((sum, owner) => (
          sum + Math.min(
            openingRmd.requiredByOwner[owner] ?? 0,
            (traditionalOutlayByOwner[owner] ?? 0) + (forcedA.byOwner[owner] ?? 0),
          )
        ), 0);
        if(rmdSatisfied > 0.01){
          rmdTaxA = rmdSatisfied * p.taxRates.ordinary;
        }
        syncProjectionAggregates(projectionAccounts, accounts);
      }
      const taxableGainFractionA = accumulationFunding.breakdown.taxable > 0.01
        ? taxableCapitalGainA / accumulationFunding.breakdown.taxable
        : undefined;
      const accumulationFailed = accumulationFunding.shortfall > 0.01;
      if(accumulationFailed){
        zeroProjectionAccounts(projectionAccounts);
        syncProjectionAggregates(projectionAccounts, accounts);
        failed = true;
        if(depletionAge === null) depletionAge = age;
      }
      const endBalanceA = totalBalance();
      if(y === 9) balanceAt10 = endBalanceA;
      if(endBalanceA < minBalance) minBalance = endBalanceA;
      if(endBalanceA > peakBalance) peakBalance = endBalanceA;
      if(peakBalance > 0){ const dd = (peakBalance - endBalanceA) / peakBalance; if(dd > maxDrawdown) maxDrawdown = dd; }
      const { taxOnSS, taxOnOI, taxOnPen, shortcutTax } = shortcutTaxOnExternalIncome(p, { ssInc, oiTaxable, penInc });
      const rowShortcutTax = shortcutTax + rmdTaxA;
      const row = {
        year: y+1, age, source: rp.y, returnRate: r, phase: 'accum',
        ...householdTaxStatusAtAge(p, age),
        returnDollars: returnFrame.returnDollars,
        ...(includeAccountDiagnostics ? {
          accountReturns: returnFrame.accountReturns,
          householdEffectiveAllocation: returnFrame.householdAllocation,
        } : {}),
        socialSecurity: ssInc, otherIncome: oiInc, pension: penInc,
        incomeTaxFacts: { ...taxIncome }, withdrawal: accumulationFunding.totalWithdrawn,
        rmd: rmdForcedA,
        rmdRequired: openingRmd.required,
        ...(includeAccountDiagnostics ? {
          rmdRequiredByOwner: { ...openingRmd.requiredByOwner },
          rmdGrossByOwner: { ...traditionalOutlayByOwner },
        } : {}),
        rmdAvailable: true,
        rmdOwner: openingRmd.owner,
        rmdIssue: null,
        assetSale: saleProceeds,
        ...(oiInc > 0 ? { otherIncomeTaxable: oiTaxable } : {}),
        expenses: 0, goals: goalsA, liabilities: 0, taxes: rowShortcutTax, savings: p.savingsAnnual, lumpSum: lumpA,
        startBalance: startBalanceA, wdRate: 0,
        netCashflow: saleProceeds - lumpA - goalsA,
        balance: endBalanceA, failed: accumulationFailed,
        fundingShortfall: accumulationFunding.shortfall,
        accountBreakdown: { ...accumulationFunding.breakdown },
        taxableStartingBasis: taxableStartingBasisA,
        taxableCapitalGain: taxableCapitalGainA,
        ...(taxableGainFractionA !== undefined ? { taxableGainFraction: taxableGainFractionA } : {}),
        accountBalances: { taxable: accounts.taxable.balance, traditional: accounts.traditional.balance, roth: accounts.roth.balance },
        ...(includeAccountDiagnostics ? {
          accountBalancesById: accountBalancesById(projectionAccounts),
          accountStates: snapshotProjectionAccounts(projectionAccounts),
          accountContributionsById: contributionsById,
          accountWithdrawalsById: combineAccountAmounts(
            outlayWithdrawalsByIdA,
            rmdWithdrawalsByIdA,
          ),
        } : {}),
        traditionalEndingBalancesByOwner: cloneTraditionalOwnerBuckets(accounts.traditional.byOwner),
        taxableEndingBasis: accounts.taxable.basis,
        taxBySource: { ss: taxOnSS, oi: taxOnOI, traditional: rmdTaxA, taxable: 0 }
      };
      // Reporting-only federal reruns (T7/T8). Income tax during working years is
      // display-only — it does not fund from the portfolio and fundTaxPolicyDelta
      // remains retirement-only.
      if(taxPolicy){
        const reportingTax = taxPolicy(row, { shortcutTax: rowShortcutTax, yearIndex: y });
        if(!Number.isFinite(reportingTax) || reportingTax < 0){
          throw new TypeError('taxPolicy must return a finite non-negative tax');
        }
        row.taxes = reportingTax;
        lifetimeTax += reportingTax;
      }else{
        lifetimeTax += rowShortcutTax;
      }
      rows.push(row);
      if(accumulationFailed){
        appendFailedTailRows(rows, p, y);
        break;
      }
      continue;
    }

    const { ssInc, oiInc, oiTaxable, penInc, taxIncome } = externalIncomeAtAge(p, age);
    const ltcCost = (p.ltc && age >= p.ltc.onsetAge) ? p.ltc.amount : 0;
    // All spending is entered on the Goals page and read from p.goals only.
    // plan.expenses is retired — living/housing/debt/healthcare/extra are goals
    // now (migrateSpendingToGoals.js), so summing them here too would
    // double-count. LTC is unrelated: it lives on plan.ltc with its own
    // onset-age model.
    //
    // The split below is presentational, not a second channel: the pre-loaded
    // Essentials and Healthcare goals report as `expenses` so Cash Flow keeps a
    // meaningful ESSENTIAL column, and everything else reports as `goals`.
    let goalsY = 0;
    let essentialsY = 0;
    for(const g of p.goals){
      if(age < g.startAge || age > g.endAge) continue;
      const amount = goalAmountAtAge(g, age);
      if(g.system) essentialsY += amount;
      else goalsY += amount;
    }
    const expenses = essentialsY + ltcCost;
    // Recurring liabilities active at this age, each eroded in real terms from
    // its OWN start age (a fixed mortgage started years ago is already cheaper).
    const liabCost = p.liabilities.reduce((s, L) =>
      (age >= L.startAge && age <= L.endAge)
        ? s + L.amount * Math.pow(1 + L.colaReal, age - L.startAge)
        : s, 0);

    // Tax on external income: 85% of SS, the taxable share of OI, 100% of pension,
    // at the ordinary rate.
    const taxOnSS    = ssInc * 0.85 * p.taxRates.ordinary;
    const taxOnOI    = oiTaxable * p.taxRates.ordinary;
    const taxOnPen   = penInc * p.taxRates.ordinary;
    const taxOnInc   = taxOnSS + taxOnOI + taxOnPen;
    const netInc     = (ssInc + oiInc + penInc) - taxOnInc;

    // One-time cash shock (e.g. medical/family event) lands as extra need.
    const lumpY = (p.lumpSum > 0 && y === p.lumpSumYear) ? p.lumpSum : 0;

    // After-tax gap the portfolio must cover.
    const gap = (expenses + goalsY + liabCost + lumpY) - netInc;

    if(taxPolicy && fundTaxPolicyDelta){
      // Validates what actually feeds the calculation. The old plan.expenses
      // fields are deliberately absent: they no longer reach the engine, so
      // rejecting a plan over junk in a retired field would block a run for a
      // value nothing reads.
      assertFiniteFederalFundingInputs(age, {
        essentials: essentialsY,
        ltcCost,
        expenses,
        goalsY,
        liabCost,
        lumpY,
        netInc,
        gap,
      });
    }

    const startBalance = totalBalance();
    // Reporting-only opening facts for planning/tax counterfactuals. Captured
    // after any asset sale and before funding, return, RMD, or tax-delta draws.
    const accountStartingBalances = {
      taxable: accounts.taxable.balance,
      traditional: accounts.traditional.balance,
      roth: accounts.roth.balance
    };
    const taxableStartingBasis = accounts.taxable.basis;
    const rmd = openingRmd;
    const rmdRequired = rmd.required;

    if(taxPolicy && fundTaxPolicyDelta){
      const solved = solveFederalFundingYear({
        openingAccounts: accounts,
        p,
        rp,
        y,
        age,
        r,
        returnFrame,
        saleProceeds,
        ssInc,
        oiInc,
        oiTaxable,
        penInc,
        taxIncome,
        expenses,
        goalsY,
        liabCost,
        lumpY,
        gap,
        taxOnSS,
        taxOnOI,
        taxOnPen,
        openingRmd,
        includeAccountDiagnostics,
      }, taxPolicy);
      projectionAccounts.splice(
        0,
        projectionAccounts.length,
        ...cloneProjectionAccountLedger(solved.accounts.projectionAccounts),
      );
      accounts.projectionAccounts = projectionAccounts;
      syncProjectionAggregates(projectionAccounts, accounts);
      failed = solved.failed;
      if(failed && depletionAge === null) depletionAge = age;
      lifetimeTax += solved.row.taxes;

      returnProduct *= (1 + r);
      if(y < 10) first10Product *= (1 + r);
      const endBalance = solved.row.balance;
      if(y === 9) balanceAt10 = endBalance;
      if(age >= p.retirementAge && age <= p.retirementAge + 9){
        balanceAtRet10 = endBalance;
      }
      if(endBalance < minBalance) minBalance = endBalance;
      if(endBalance > peakBalance) peakBalance = endBalance;
      if(peakBalance > 0){
        const dd = (peakBalance - endBalance) / peakBalance;
        if(dd > maxDrawdown) maxDrawdown = dd;
      }
      rows.push(solved.row);

      if(failed){
        appendFailedTailRows(rows, p, y);
        break;
      }
      continue;
    }

    // Compute the withdrawal breakdown without mutating accounts. Capacity is
    // adjusted for the same mid-year timing used below so a negative return
    // cannot turn an undeliverable draw into a funded result.
    const funding = gap > 0
      ? fundProjectionGap(
          projectionAccounts,
          returnFrame,
          gap,
          p.taxRates,
          p.withdrawalStrategy,
          openingRmd.requiredByOwner,
        )
      : { totalWithdrawn: 0, totalTax: 0, breakdown: { taxable: 0, traditional: 0, roth: 0 }, taxBySource: { taxable: 0, traditional: 0 }, shortfall: 0 };
    // Preserve the spending/goal draw before a later federal-tax delta can add
    // a second funding tranche to the same mutable breakdown.
    const preTaxDeltaAccountBreakdown = { ...funding.breakdown };

    let withdrawal = funding.totalWithdrawn;
    const totalTax   = taxOnInc + funding.totalTax;
    lifetimeTax     += totalTax;
    let wdRate = (startBalance > 0.01 && withdrawal > 0)
                 ? (withdrawal / startBalance) * 100 : 0;

    returnProduct *= (1 + r);
    if(y < 10) first10Product *= (1 + r);

    // Mid-year withdrawal factor — spreads withdrawals across the year while
    // the balance is earning the annual return. Same formula as the original
    // single-account engine; we just apply it per-account now.
    // Capture the START-of-year values for basis math. We need these before
    // we modify the balance, because basis consumption is based on the
    // withdrawal's share of the starting balance — not the ending balance.
    const appliedFunding = applyProjectionYearReturnsAndWithdrawals(
      projectionAccounts,
      returnFrame,
      funding.grossById,
    );
    syncProjectionAggregates(projectionAccounts, accounts);
    const traditionalGrossByOwner = funding.traditionalGrossByOwner
      ?? emptyTraditionalOwnerBuckets();

    // Consume basis proportionally to the gross taxable withdrawal. If you
    // pull X dollars from a taxable account with starting balance B and
    // basis P, the dollars carry P/B basis with them: basis_consumed = X * P/B.
    // Basis doesn't earn returns — only the appreciation does — so timing
    // doesn't change this proportion.
    let taxableCapitalGain = appliedFunding.taxableCapitalGain;

    // Start-of-year gain share for adapter/tax attach — read-only fact, not tax math.
    const taxableWithdrawal = funding.breakdown.taxable;
    let taxableGainFraction = taxableWithdrawal > 0.01
      ? taxableCapitalGain / taxableWithdrawal
      : undefined;

    // ── RMD: force out any required distribution beyond what spending pulled ──
    // Spending may already have drawn from Traditional (funding.breakdown). Only
    // the shortfall to the required amount is forced. It's taxed as ordinary
    // income and the full gross distribution is treated as spent. It does not
    // silently enter the taxable sleeve.
    let rmdForced = 0, rmdTax = 0;
    let rmdWithdrawalsById = {};
    if(rmdRequired > 0){
      // Net per owner: the spending draw only counts against the RMD of the
      // owner it actually came from.
      const outstandingByOwner = Object.fromEntries(
        TRADITIONAL_PERSON_OWNERS.map(owner => [owner, Math.max(
          0,
          (openingRmd.requiredByOwner[owner] ?? 0) - (traditionalGrossByOwner[owner] ?? 0),
        )]),
      );
      const forced = applyProjectionOwnerRmd(projectionAccounts, outstandingByOwner);
      rmdForced = forced.total;
      rmdWithdrawalsById = forced.byId;
      if(rmdForced > 0.01){
        rmdTax = rmdForced * p.taxRates.ordinary;
        lifetimeTax += rmdTax;
      }
      syncProjectionAggregates(projectionAccounts, accounts);
    }

    const shortcutTax = totalTax + rmdTax;
    let resolvedTax = shortcutTax;

    // Floor any depleted accounts at zero.
    for(const account of projectionAccounts){
      if(account.balance < 0) account.balance = 0;
    }
    syncProjectionAggregates(projectionAccounts, accounts);

    // A path fails only when a required cash flow is not funded. Reaching
    // exactly zero after the terminal obligation is a valid funded outcome.
    if(funding.shortfall > 0.01){
      zeroProjectionAccounts(projectionAccounts);
      syncProjectionAggregates(projectionAccounts, accounts);
      failed = true;
      if(depletionAge === null) depletionAge = age;
    }

    const endBalance = totalBalance();

    if(y === 9) balanceAt10 = endBalance;

    // Retirement-relative sequence-stress probe: hold the end-of-year balance
    // for each of the first 10 RETIREMENT years (age retirementAge … +9). Unlike
    // balanceAt10 (plan-year indexed), this isolates early-retirement sequence
    // risk and is unaffected by accumulation years when retirementAge > currentAge.
    // A sim that depletes early lands at 0 here (failure zeroes the balance above),
    // so early failures sort to the bottom; a short horizon leaves the last
    // available retirement-year balance.
    if(age >= p.retirementAge && age <= p.retirementAge + 9) balanceAtRet10 = endBalance;

    if(endBalance < minBalance) minBalance = endBalance;
    if(endBalance > peakBalance) peakBalance = endBalance;
    if(peakBalance > 0){
      const dd = (peakBalance - endBalance) / peakBalance;
      if(dd > maxDrawdown) maxDrawdown = dd;
    }

    const row = {
      year: y+1, age, source: rp.y, returnRate: r,
      ...householdTaxStatusAtAge(p, age),
      returnDollars: returnFrame.returnDollars,
      ...(includeAccountDiagnostics ? {
        accountReturns: returnFrame.accountReturns,
        householdEffectiveAllocation: returnFrame.householdAllocation,
      } : {}),
      nominalReturn: (rp && rp.proxyNominalReturn != null) ? rp.proxyNominalReturn : null,
      inflationRate: (rp && rp.proxyInflationRate != null) ? rp.proxyInflationRate : null,
      realReturnUsed: r,
      socialSecurity: ssInc, otherIncome: oiInc, pension: penInc,
      incomeTaxFacts: { ...taxIncome }, withdrawal,
      ...(oiInc > 0 ? { otherIncomeTaxable: oiTaxable } : {}),
      rmd: rmdForced, rmdRequired,
      rmdAvailable: rmd.available,
      rmdOwner: rmd.owner,
      rmdIssue: rmd.issue,
      rmdRequiredByOwner: { ...openingRmd.requiredByOwner },
      rmdGrossByOwner: { ...traditionalGrossByOwner },
      rmdBasisSource: openingRmd.basisSource,
      assetSale: saleProceeds,
      expenses, goals: goalsY, liabilities: liabCost, taxes: resolvedTax, lumpSum: lumpY,
      startBalance, wdRate,
      netCashflow: (ssInc + oiInc + penInc + saleProceeds)
                   - (expenses + goalsY + liabCost + resolvedTax),
      balance: endBalance, failed,
      fundingShortfall: funding.shortfall,
      accountBreakdown: { ...funding.breakdown },
      preTaxDeltaAccountBreakdown: { ...preTaxDeltaAccountBreakdown },
      accountStartingBalances: { ...accountStartingBalances },
      taxableStartingBasis,
      taxableCapitalGain,
      accountBalances: {
        taxable: accounts.taxable.balance,
        traditional: accounts.traditional.balance,
        roth: accounts.roth.balance
      },
      ...(includeAccountDiagnostics ? {
        accountBalancesById: accountBalancesById(projectionAccounts),
        accountStates: snapshotProjectionAccounts(projectionAccounts),
        accountWithdrawalsById: combineAccountAmounts(
          funding.grossById,
          rmdWithdrawalsById,
        ),
      } : {}),
      taxableEndingBasis: accounts.taxable.basis,
      ...(taxableGainFraction !== undefined ? { taxableGainFraction } : {}),
      taxBySource: {
        ss: taxOnSS, oi: taxOnOI,
        traditional: funding.taxBySource.traditional,
        taxable: funding.taxBySource.taxable
      }
    };

    // Reporting-only mode remains the T6/T7 default. T8 opts into the earlier
    // funding branch explicitly, so existing callers retain identical paths.
    if(taxPolicy && !fundTaxPolicyDelta){
      const reportingTax = taxPolicy(row, { shortcutTax, yearIndex: y });
      if(!Number.isFinite(reportingTax) || reportingTax < 0){
        throw new TypeError('taxPolicy must return a finite non-negative tax');
      }
      if(reportingTax !== shortcutTax){
        lifetimeTax += reportingTax - shortcutTax;
        row.taxes = reportingTax;
        row.netCashflow = (ssInc + oiInc + penInc + saleProceeds)
                          - (expenses + goalsY + liabCost + reportingTax);
      }
    }

    rows.push(row);

    if(failed){
      appendFailedTailRows(rows, p, y);
      break;
    }
  }

  const cagr = Math.pow(returnProduct, 1 / p.horizonYears) - 1;
  const first10Years = Math.min(10, p.horizonYears);
  const first10Cagr = first10Years > 0
    ? Math.pow(first10Product, 1 / first10Years) - 1
    : 0;
  return { rows, failed, cagr, terminalBalance: totalBalance(),
           minBalance, maxDrawdown, depletionAge, first10Cagr, balanceAt10,
           balanceAtRet10, lifetimeTax,
           returnSeriesProvenance: RETURN_SERIES_PROVENANCE,
           assumptions: [] };
}

function analyzeResults(sims, p){
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

function runHistoricalPath(plan, startYear, strategy, transform, overrides, options = {}){
  // `overrides` flows through the SAME resolveInputs lever mapping the Monte
  // Carlo path uses (retireDelay, ssDelayYears, spendBump, lumpSum, savingsBump,
  // pensionStartAge, …) so a chosen scenario is sequenced faithfully, not just
  // its allocation. Defaults to {} → behavior identical to the original.
  const rawInputs = resolveInputs(plan, overrides || {});
  if(rawInputs.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  // Override strategy for this run
  rawInputs.withdrawalStrategy = strategy;

  // Build the path from startYear forward. When we reach the end of the real
  // record (2025) we WRAP back to its start rather than truncate — the same
  // cyclic treatment the block-bootstrap Monte Carlo uses, so a recent
  // retirement year (2000, 2008) still gets a FULL real-return horizon instead
  // of a stub that ends mid-retirement. Every return remains a real historical
  // year; only the calendar contiguity breaks at the wrap (invisible on an
  // age-based axis). The first decade — where sequence risk lives — is always
  // pre-wrap and fully real.
  const startIdx = RETURN_DATA.findIndex(r => r.y === startYear);
  if(startIdx < 0) return null;
  const path = [];
  for(let i = 0; i < rawInputs.horizonYears; i++){
    const row = RETURN_DATA[(startIdx + i) % RETURN_DATA.length];
    path.push(row);
  }
  if(path.length === 0) return null;

  // Optional ORDER transform (e.g. reverse): reorders the SAME real return
  // rows before the single-path runner walks them. The returns are unchanged —
  // only their sequence is. Used by the Sequencing tab to isolate order. When
  // omitted, behavior is byte-identical to the original forward run.
  const ordered = typeof transform === 'function' ? transform(path.slice()) : path;

  // Adjust horizon to actual data available
  const inputs = { ...rawInputs, horizonYears: ordered.length };
  const result = runSinglePath(inputs, ordered, options);
  result.actualYears  = ordered.length;
  result.requestedYrs = rawInputs.horizonYears;
  result.startYear    = startYear;
  result.endYear      = startYear + ordered.length - 1;
  return result;
}

/* ── PATH DIGEST ─────────────────────────────────────────────────────────────
   Pure read-only summary of ONE simulation result (Monte Carlo path or
   historical run). Computes the aggregates the narrative surfaces print, so
   every number on screen is engine output rather than UI math. No state, no
   mutation: same input → same digest. `params` (a resolveInputs result) is
   optional and only unlocks spendShareOfStart. */
function pathDigest(sim, params){
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
const ASSESSMENT_RULES = {
  lowFixedSpending:  { maxSpendShareOfStart: 0.045 },  // core spend ≤ 4.5% of starting assets
  taxDiversified:    { minBucketShare: 0.15, minBuckets: 2 },
  highSuccess:       { minSuccessRate: 85 },
  withdrawalLoad:    { peakWdRatePct: 10 },            // wdRate rows are in percent
  portfolioFunded:   { minFixedIncomeShare: 0.33 }
};

function assessPlan(analysis){
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

/* ---- exports (so the UI and tests import instead of sharing globals) ---- */
export {
  RETURN_DATA, ASSET_META, ASSET_KEYS, EQUITY_MIX, DEFENSIVE_MIX,
  RETURN_SERIES_PROVENANCE,
  RISK_PROFILES, ASSET_STATS, LONGRUN_INFLATION, PROJECTION_EXECUTION_LIMITS,
  buildAssetWeights, computeAssetStats, generateReturnPath, resetSeed, weightedAssetReturn,
  ssAdjust,
  runSimulation, resolveInputs, resolveHouseholdTimeline, householdStateAtYear,
  householdIncomeAtYear, resolveWithdrawalPlannerAccountState,
  approveWithdrawalPlannerLeverChange, buildWithdrawalPlannerCashContract,
  runSinglePath, analyzeResults, runHistoricalPath,
  annualMortgagePayment,
  pathDigest, assessPlan, ASSESSMENT_RULES,
  plan as defaultPlan
};

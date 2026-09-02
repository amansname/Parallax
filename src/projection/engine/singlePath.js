// Projection Engine implementation; public consumers import engine.js.
import { TRADITIONAL_PERSON_OWNERS, emptyTraditionalOwnerBuckets, ZERO_TRADITIONAL_OWNER_BUCKETS, cloneTraditionalOwnerBuckets, applyDeathBoundaryRollover } from './traditionalOwners.js';
import { resolveOpeningRmd } from './requiredDistributions.js';
import { validateProjectionHorizon, validateReturnPaths } from './execution.js';
import { externalIncomeAtAge, householdStateAtYear, householdTaxStatusAtAge } from './householdTimeline.js';
import { createProjectionReturnCache, RETURN_SERIES_PROVENANCE } from '../portfolioReturns.js';
import { accountBalancesById, addProjectionCash, applyDirectBucketWithdrawal, applyProjectionContributions, applyProjectionOwnerRmd, applyProjectionYearReturnsAndWithdrawals, cloneProjectionAccountLedger, fundProjectionGap, resolveProjectionReturnFrame, rolloverProjectionAccounts, snapshotProjectionAccounts, syncProjectionAggregates, zeroProjectionAccounts } from '../accountLedger.js';
import { fundGap, emptyFunding, combineAccountAmounts, traditionalWithdrawalsByOwner } from './accountFunding.js';
import { assertFiniteFederalFundingInputs, solveFederalFundingYear } from './federalFunding.js';
import { effectiveWithdrawalRate } from './withdrawalMetrics.js';

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

function appendFailedTailRows(rows, p, failedYearIndex){
  for(let z = failedYearIndex + 1; z < p.horizonYears; z++){
    rows.push({
      year:z+1, age:p.currentAge+z, source:null, returnRate:0, returnDollars:0,
      ...householdStateAtYear(p, z),
      socialSecurity:0, otherIncome:0, withdrawal:0,
      expenses:0, goals:0, taxes:0,
      startBalance:0, wdRate:0, effectiveWdRate:0, netCashflow:0, balance:0, failed:true,
      fundingShortfall:0,
      accountBreakdown: { taxable:0, traditional:0, roth:0 },
      accountBalances:  { taxable:0, traditional:0, roth:0 }
    });
  }
}

export function runSinglePath(p, returnPath, options = {}){
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
        startBalance: startBalanceA, wdRate: 0, effectiveWdRate: 0,
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
    const effectiveWdRate = effectiveWithdrawalRate({
      withdrawal,
      startBalance,
      returnDollars: returnFrame.returnDollars,
    });

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
      startBalance, wdRate, effectiveWdRate,
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

// Projection Engine implementation; public consumers import engine.js.
import { TRADITIONAL_PERSON_OWNERS, emptyTraditionalOwnerBuckets } from './traditionalOwners.js';
import { householdTaxStatusAtAge } from './householdTimeline.js';
import { accountBalancesById, addProjectionCash, applyProjectionOwnerRmd, applyProjectionYearReturnsAndWithdrawals, fundProjectionGap, snapshotProjectionAccounts, syncProjectionAggregates, zeroProjectionAccounts } from '../accountLedger.js';
import { cloneEngineAccounts, emptyFunding, accountTotal, combineAccountAmounts } from './accountFunding.js';

const FEDERAL_FUNDING_CONVERGENCE_TOLERANCE = 0.01;

const FEDERAL_FUNDING_MAX_ITERATIONS = 32;

export function assertFiniteFederalFundingInputs(age, values){
  const invalid = Object.entries(values)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([name, value]) => `${name}=${String(value)}`);
  if(invalid.length){
    throw new TypeError(
      `Federal funding inputs must be finite at age ${age}: ${invalid.join(', ')}`
    );
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

export function solveFederalFundingYear(args, taxPolicy){
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

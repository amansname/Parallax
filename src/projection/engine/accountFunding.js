// Projection Engine implementation; public consumers import engine.js.
import { emptyTraditionalOwnerBuckets, ZERO_TRADITIONAL_OWNER_BUCKETS } from './traditionalOwners.js';
import { cloneProjectionAccountLedger, syncProjectionAggregates } from '../accountLedger.js';

/* ============================================================================
   PARALLAX ENGINE  —  the heart of the model. Treat as SACRED.
   Block-bootstrap Monte Carlo on real (inflation-adjusted) returns, 1928–2025.
   Accounts: taxable / traditional / Roth. Accumulation + pension + LTC.
   Path-consistent: all scenarios can share one return-path bundle.

   RULE: Do not "improve" this casually. It is verified. If you change it,
   the contracts in test/engine/ must still pass. Terminal wealth is NOT the
   objective — it is only a ranking/sorting device. The engine reports
   success, depletion, balances over time; the UI decides what to show.
   ============================================================================ */

export function fundGap(accounts, gap, taxRates, strategy = 'taxable-first'){
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

export function cloneEngineAccounts(accounts){
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

export function emptyFunding(){
  return {
    totalWithdrawn: 0,
    totalTax: 0,
    breakdown: { taxable: 0, traditional: 0, roth: 0 },
    taxBySource: { taxable: 0, traditional: 0 },
    shortfall: 0,
  };
}

export function accountTotal(accounts){
  return accounts.taxable.balance
    + accounts.traditional.balance
    + accounts.roth.balance;
}

export function combineAccountAmounts(...maps){
  const combined = {};
  for(const map of maps){
    for(const [accountId, amount] of Object.entries(map ?? {})){
      combined[accountId] = (combined[accountId] ?? 0) + amount;
    }
  }
  return combined;
}

export function traditionalWithdrawalsByOwner(ledger, withdrawalsById){
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

// Projection Engine implementation; public consumers import engine.js.
import { householdTaxStatusAtAge } from './householdTimeline.js';

// ── RMDs (Required Minimum Distributions) ───────────────────────────────────
// SECURE 2.0: the pre-tax (Traditional) sleeve must distribute a minimum each
// year from the owner's cohort-specific applicable age. Roth is exempt. The
// distribution is ordinary income and is modeled as spent in full. Required
// distributions never silently move into the taxable sleeve.
//
// ── Owner-level traditional sleeve ──────────────────────────────────────────
// The traditional sleeve is tracked per owner because RMDs are per owner: each
// spouse's requirement runs off their own balance and their own age, and one
// spouse's withdrawal can never satisfy the other's requirement.
//
// `byOwner` is the source of truth. `.balance` is a derived cache kept only so
// the many read sites (accountTotal, row emission, funding breakdown) stay
// untouched — nothing outside these helpers may assign it.
export const TRADITIONAL_OWNER_KEYS = Object.freeze(['client', 'spouse', 'unattributed']);

export const TRADITIONAL_PERSON_OWNERS = Object.freeze(['client', 'spouse']);

export function emptyTraditionalOwnerBuckets(){
  return { client: 0, spouse: 0, unattributed: 0 };
}

// Shared read-only zero buckets. resolveOpeningRmd returns "nothing due" on the
// large majority of the ~40,000 year-evaluations in a 1,000-path run, and
// allocating a fresh object each time is pure overhead on a loop the audit
// already flags as blocking the UI thread (PX-AUD-028 — the durable fix is to
// move the projection off the UI thread, which is tracked separately).
//
// MUST NOT be mutated: it is shared across every caller, and
// applyTraditionalMidyearWithdrawal compares against it by identity to take its
// no-draw fast path. Frozen so a future refactor fails loudly in strict mode
// rather than silently corrupting every projection; locked by a unit test.
export const ZERO_TRADITIONAL_OWNER_BUCKETS = Object.freeze({ client: 0, spouse: 0, unattributed: 0 });

export function cloneTraditionalOwnerBuckets(byOwner){
  return {
    client: byOwner?.client ?? 0,
    spouse: byOwner?.spouse ?? 0,
    unattributed: byOwner?.unattributed ?? 0,
  };
}

// Recompute the derived total. Every mutation helper ends here. Unrolled: this
// runs on every secant iteration of every year of every path.
export function reconcileTraditionalTotal(traditional){
  const b = traditional.byOwner;
  const total = b.client + b.spouse + b.unattributed;
  traditional.balance = total;
  return total;
}

function clampTraditionalNonNegative(traditional){
  for(const owner of TRADITIONAL_OWNER_KEYS){
    if(!(traditional.byOwner[owner] > 0)) traditional.byOwner[owner] = 0;
  }
  return reconcileTraditionalTotal(traditional);
}

function zeroTraditionalOwners(traditional){
  traditional.byOwner = emptyTraditionalOwnerBuckets();
  return reconcileTraditionalTotal(traditional);
}

// Growth is proportional, so ownership shares are unchanged by returns.
function growTraditional(traditional, r){
  const b = traditional.byOwner;
  const g = 1 + r;
  b.client *= g;
  b.spouse *= g;
  b.unattributed *= g;
  return reconcileTraditionalTotal(traditional);
}

/**
 * Split a gross traditional distribution across owners: RMD-first, then pro
 * rata over what's left.
 *
 * Pro-rata-only would be wrong. If the client owes a $10k RMD, the spouse owes
 * nothing, and the plan needs $10k from the traditional sleeve, splitting
 * $5k/$5k leaves $5k of the client's RMD unsatisfied — which then gets forced
 * out on top, pulling $15k out of tax-deferred money instead of $10k.
 *
 * Returns gross by owner. This is the figure RMD satisfaction and Form 1040
 * reporting use; it deliberately does NOT touch balances, because the sleeve's
 * mid-year timing math is a separate concern (see applyTraditionalMidyearWithdrawal).
 */
function allocateTraditionalDistribution({ traditional, grossAmount, requiredByOwner = null }){
  // Shared frozen result when there is nothing to split — callers only read it.
  if(!(grossAmount > 0)) return ZERO_TRADITIONAL_OWNER_BUCKETS;
  const allocation = emptyTraditionalOwnerBuckets();
  let remaining = grossAmount;

  const available = {};
  for(const owner of TRADITIONAL_OWNER_KEYS){
    available[owner] = Math.max(0, traditional.byOwner[owner] ?? 0);
  }

  // 1. Satisfy each owner's own outstanding RMD first, capped by their balance.
  if(requiredByOwner){
    for(const owner of TRADITIONAL_PERSON_OWNERS){
      const required = requiredByOwner[owner];
      if(!(required > 0)) continue;
      const take = Math.min(required, available[owner], remaining);
      if(take > 0){
        allocation[owner] += take;
        available[owner] -= take;
        remaining -= take;
      }
      if(!(remaining > 0)) break;
    }
  }

  // 2. Anything left is pro rata across remaining attributable balances.
  if(remaining > 0){
    let pool = 0;
    for(const owner of TRADITIONAL_OWNER_KEYS) pool += available[owner];
    if(pool > 0){
      let assigned = 0;
      const ordered = TRADITIONAL_OWNER_KEYS.filter(owner => available[owner] > 0);
      ordered.forEach((owner, index) => {
        const isLast = index === ordered.length - 1;
        // Last bucket takes "whatever is left" rather than its own computed
        // share, so floating-point error in the earlier shares cannot leave a
        // residual. Without this the per-owner parts drift from the gross by
        // fractions of a cent, and that gap compounds across 40 years into a
        // real discrepancy against the sleeve total.
        const take = isLast
          ? Math.min(available[owner], remaining - assigned)
          : Math.min(available[owner], (available[owner] / pool) * remaining);
        if(take > 0){
          allocation[owner] += take;
          assigned += take;
        }
      });
      remaining -= assigned;
    }
  }

  return allocation;
}

/**
 * Apply an ordinary spending withdrawal using the engine's existing mid-year
 * convention — end = start*(1+r) − (amount/12)*factor — per owner. Keeping this
 * separate from allocation is what preserves single-owner parity: the gross
 * figure feeds tax, the timing math feeds balances, and they are not the same
 * number.
 */
function applyTraditionalMidyearWithdrawal({ traditional, returnRate, factor, grossByOwner }){
  // No draw at all is the common case (taxable-first strategies spend other
  // sleeves for years), and it reduces to pure growth.
  if(!grossByOwner || grossByOwner === ZERO_TRADITIONAL_OWNER_BUCKETS){
    return growTraditional(traditional, returnRate);
  }
  const b = traditional.byOwner;
  const g = 1 + returnRate;
  const spread = factor / 12;
  b.client = b.client * g - grossByOwner.client * spread;
  b.spouse = b.spouse * g - grossByOwner.spouse * spread;
  b.unattributed = b.unattributed * g - grossByOwner.unattributed * spread;
  return reconcileTraditionalTotal(traditional);
}

// Accumulation-phase contribution, mid-year spread, allocated by owner policy.
function applyTraditionalContribution({ traditional, returnRate, contributionByOwner }){
  for(const owner of TRADITIONAL_OWNER_KEYS){
    const start = traditional.byOwner[owner] ?? 0;
    traditional.byOwner[owner] = start * (1 + returnRate)
      + (contributionByOwner?.[owner] ?? 0);
  }
  return reconcileTraditionalTotal(traditional);
}

// Direct-subtraction draw spread pro rata across owners. Used for liquidations
// that are not RMD-driven (capital outlays), where no owner has a claim.
function withdrawTraditionalProRata(traditional, amount){
  const allocation = allocateTraditionalDistribution({ traditional, grossAmount: amount });
  let taken = 0;
  for(const owner of TRADITIONAL_OWNER_KEYS){
    const available = Math.max(0, traditional.byOwner[owner] ?? 0);
    const take = Math.min(allocation[owner], available);
    traditional.byOwner[owner] = available - take;
    taken += take;
  }
  reconcileTraditionalTotal(traditional);
  return taken;
}

// Forced RMD keeps the engine's existing year-end convention: a direct
// subtraction, taken from that owner's own bucket.
function withdrawTraditionalForced(traditional, owner, amount){
  const available = Math.max(0, traditional.byOwner[owner] ?? 0);
  const taken = Math.min(Math.max(0, amount), available);
  traditional.byOwner[owner] = available - taken;
  reconcileTraditionalTotal(traditional);
  return taken;
}

// Spousal rollover at a death-year boundary: one transfer, decedent zeroed.
function rolloverTraditional(traditional, from, to){
  const moved = Math.max(0, traditional.byOwner[from] ?? 0);
  if(moved > 0){
    traditional.byOwner[from] = 0;
    traditional.byOwner[to] = (traditional.byOwner[to] ?? 0) + moved;
  }
  reconcileTraditionalTotal(traditional);
  return moved;
}

/**
 * Is a spousal rollover of `from`'s pre-tax balance to `to` supportable?
 *
 * Both sides are inspected for attributable balances and supported RMD rules.
 * Employer-plan status does not prevent the death-boundary transfer: the
 * surviving spouse owns the transferred pre-tax balance after the rollover.
 *
 * Deliberately NOT derived from `rmdContract.spousalRolloverAvailable`, which is
 * computed off the single-owner `traditionalRmdOwner` and is therefore always
 * false in exactly the two-owner households this needs to serve.
 */
function spousalRolloverSupported(p, contract, from, to){
  const fromContract = contract?.byOwner?.[from];
  if(!fromContract) return false;
  if(fromContract.focusRulesAvailable !== true) return false;
  if(fromContract.rmdAccountAttributionAvailable !== true) return false;

  // The survivor need not already hold pre-tax accounts — inheriting one is the
  // normal case — so their eligibility comes from the timeline, not from a
  // byOwner entry that may legitimately not exist. Where they do have one, it
  // has to be clean too.
  const toContract = contract?.byOwner?.[to];
  if(toContract){
    if(toContract.focusRulesAvailable !== true) return false;
    if(toContract.rmdAccountAttributionAvailable !== true) return false;
  }
  return Number.isFinite(p.people?.[to]?.rmdStartAge);
}

/**
 * Transfer a decedent's remaining pre-tax balance to the surviving spouse at
 * the closing boundary of their final living year. One move, no proration.
 */
export function applyDeathBoundaryRollover(p, age, traditional, rolledOverOwners){
  // Spousal rollover needs a spouse, not a particular filing status — a
  // surviving spouse may roll over regardless of how the couple filed.
  if(!p.people?.spouse) return null;
  const priorYear = householdTaxStatusAtAge(p, age - 1);
  const thisYear = householdTaxStatusAtAge(p, age);

  for(const owner of TRADITIONAL_PERSON_OWNERS){
    if(rolledOverOwners.has(owner)) continue;
    const aliveBefore = priorYear.people?.[owner]?.alive === true;
    const aliveNow = thisYear.people?.[owner]?.alive === true;
    if(!aliveBefore || aliveNow) continue;          // they did not just die
    if(!((traditional.byOwner[owner] ?? 0) > 0.01)){
      rolledOverOwners.add(owner);
      continue;
    }
    const survivor = owner === 'client' ? 'spouse' : 'client';
    if(thisYear.people?.[survivor]?.alive !== true) continue;   // no survivor to receive it
    if(!spousalRolloverSupported(p, p.rmdContract, owner, survivor)) continue;  // fail closed
    rolloverTraditional(traditional, owner, survivor);
    rolledOverOwners.add(owner);
    return { from: owner, to: survivor, age };
  }
  return null;
}

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
// MUST NOT be mutated: required-distribution and account-funding callers share
// it when no owner-level draw is due. Frozen so a future refactor fails loudly in strict mode
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

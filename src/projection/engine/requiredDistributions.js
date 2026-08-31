// Projection Engine implementation; public consumers import engine.js.
import { householdTaxStatusAtAge } from './householdTimeline.js';
import { TRADITIONAL_PERSON_OWNERS, emptyTraditionalOwnerBuckets, ZERO_TRADITIONAL_OWNER_BUCKETS } from './traditionalOwners.js';

// 72 is the pre-SECURE-2.0 floor: used only to ask "could anyone owe yet?", never
// to compute an amount. A real applicable age is still required for that.
function belowApplicableAge(person){
  return person?.alive === true
    && typeof person.age === 'number'
    && person.age < (person.rmdStartAge ?? 72);
}

/**
 * Per-owner RMD requirement for one projection year.
 *
 * Short-circuits when there is no pre-tax money, and stays quiet while everyone
 * is below their applicable age — an unresolvable owner only matters once a
 * distribution is actually due.
 */
export function resolveOpeningRmd(p, age, traditional, yearIndex){
  // `available` / `owner` are retained for the existing row contract. `owner`
  // identifies whose pre-tax money this is — which is why it follows the
  // balances rather than the plan's contract: after a spousal rollover the
  // survivor owns it. It is null when two people hold pre-tax money, because
  // then there is no single household RMD owner, which is the point of all this.
  const clientHolds = (traditional.byOwner.client ?? 0) > 0.01;
  const spouseHolds = (traditional.byOwner.spouse ?? 0) > 0.01;
  const rowOwner = clientHolds && spouseHolds
    ? null                                        // two owners: no single one
    : (clientHolds ? 'client'
      : (spouseHolds ? 'spouse' : (p.rmdContract?.owner ?? null)));

  // `requiredByOwner` on the not-required paths is shared and frozen: this
  // function runs ~40,000 times in a 1,000-path projection and is "nothing due"
  // for most of them, so per-call allocation is pure overhead on a loop the
  // audit already flags as blocking the UI thread (PX-AUD-028).
  const empty = {
    status: 'not-required',
    available: true,
    owner: rowOwner,
    required: 0,
    requiredByOwner: ZERO_TRADITIONAL_OWNER_BUCKETS,
    issue: null,
    basisSource: null,
  };
  if(!(traditional.balance > 0.01)) return empty;

  const contract = p.rmdContract;
  const householdState = householdTaxStatusAtAge(p, age);

  // Hot path — this runs for every year of every path, so the age gates below
  // read the two people directly instead of building and filtering arrays.
  const clientPerson = householdState.people?.client ?? null;
  const spousePerson = householdState.people?.spouse ?? null;
  const hasUnattributed = (traditional.byOwner.unattributed ?? 0) > 0.01;

  // Nobody in the household has reached an applicable age — nothing is due, so
  // ownership gaps are not yet a problem.
  if((clientPerson || spousePerson)
    && (!clientPerson || belowApplicableAge(clientPerson))
    && (!spousePerson || belowApplicableAge(spousePerson))){
    return empty;
  }

  // Someone is old enough, but a distribution is only owed by a person who
  // actually holds pre-tax money. An older spouse with no IRA of their own does
  // not force resolution of the younger owner's cohort.
  if((clientHolds || spouseHolds)
    && (!clientHolds || belowApplicableAge(clientPerson))
    && (!spouseHolds || belowApplicableAge(spousePerson))
    && !hasUnattributed){
    return empty;
  }

  // Pre-tax money nobody owns cannot produce a defensible RMD.
  if(hasUnattributed){
    return {
      ...empty,
      status: 'unavailable',
      available: false,
      owner: null,
      required: null,
      issue: 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE',
    };
  }

  const basisSource = yearIndex === 0
    ? 'opening-balance-assumption'
    : 'simulated-prior-year-close';

  // A survivor who inherited a spouse's IRA now holds pre-tax money without
  // having an entry in the plan-derived contract. Synthesize one from the
  // timeline so the inherited balance still produces an RMD instead of silently
  // escaping the requirement.
  let effectiveContract = contract;
  const missingOwners = [];
  if(clientHolds && !contract?.byOwner?.client) missingOwners.push('client');
  if(spouseHolds && !contract?.byOwner?.spouse) missingOwners.push('spouse');
  if(missingOwners.length > 0){
    const byOwner = { ...(contract?.byOwner || {}) };
    for(const owner of missingOwners){
      byOwner[owner] = {
        available: true,
        balance: traditional.byOwner[owner],
        startAge: p.people?.[owner]?.rmdStartAge ?? null,
        containsEmployerPlan: false,
        focusRulesAvailable: true,
        rmdAccountAttributionAvailable: true,
        priorYearEndBalance: traditional.byOwner[owner],
        priorYearEndBalanceAvailable: true,
      };
    }
    effectiveContract = { ...contract, byOwner };
  }

  const evaluated = evaluateRmdByOwner(effectiveContract, householdState, {
    priorYearEndBalanceForOwner: (owner) => (
      yearIndex === 0
        ? (contract?.openingBalanceByOwner?.[owner] ?? 0)   // raw, pre-shock
        : (traditional.byOwner[owner] ?? 0)                 // prior year's close
    ),
  });

  const requiredByOwner = emptyTraditionalOwnerBuckets();
  for(const owner of TRADITIONAL_PERSON_OWNERS){
    const detail = evaluated.byOwner[owner];
    requiredByOwner[owner] = detail && detail.required > 0 ? detail.required : 0;
  }

  return {
    status: evaluated.status,
    available: evaluated.status !== 'unavailable',
    owner: rowOwner,
    required: evaluated.requiredTotal,
    requiredByOwner,
    issue: evaluated.issue,
    basisSource,
    byOwner: evaluated.byOwner,
  };
}

// Divisors: IRS Uniform Lifetime Table (Pub 590-B, Table III), current 2026.
const UNIFORM_LIFETIME = {
  72:27.4, 73:26.5, 74:25.5, 75:24.6, 76:23.7, 77:22.9, 78:22.0, 79:21.1, 80:20.2,
  81:19.4, 82:18.5, 83:17.7, 84:16.8, 85:16.0, 86:15.2, 87:14.4, 88:13.7,
  89:12.9, 90:12.2, 91:11.5, 92:10.8, 93:10.1, 94:9.5, 95:8.9, 96:8.4,
  97:7.8, 98:7.3, 99:6.8, 100:6.4, 101:6.0, 102:5.6, 103:5.2, 104:4.9,
  105:4.6, 106:4.3, 107:4.1, 108:3.9, 109:3.7, 110:3.5, 111:3.4, 112:3.3,
  113:3.1, 114:3.0, 115:2.9, 116:2.8, 117:2.7, 118:2.5, 119:2.3, 120:2.0
};

export function rmdDivisor(age){
  if(age < 72) return Infinity;                     // no RMD → required = 0
  return UNIFORM_LIFETIME[Math.min(age, 120)];      // table floors at 120+
}

/**
 * THE authoritative per-owner RMD evaluator. RMDs are legally per owner — you
 * cannot satisfy your spouse's RMD out of your IRA — so every caller that needs
 * a required amount comes through here.
 *
 * `priorYearEndBalanceForOwner` lets a caller supply the basis it actually has.
 * The Withdrawal Planner has only the plan's recorded prior-Dec-31 figure, so it
 * passes nothing and the contract's own `priorYearEndBalance` is used. The
 * projection simulates each year, so from year 1 on it supplies that owner's
 * real prior-year closing balance — which is why the planner's focus-year guard
 * is a parameter rather than a hard rule.
 */
export function evaluateRmdByOwner(contract, householdState, {
  priorYearEndBalanceForOwner = null,
  focusYearMatchesBase = true,
} = {}){
  const suppliedBasis = typeof priorYearEndBalanceForOwner === 'function';
  const details = {};
  let anyKnown = false;
  let anyUnavailable = false;
  let requiredTotal = 0;
  let priorYearEndTotal = 0;
  let priorYearEndComplete = true;

  const contractOwners = contract?.byOwner;
  for(const owner of TRADITIONAL_PERSON_OWNERS){
    const ownerContract = contractOwners?.[owner];
    if(!ownerContract) continue;
    const ownerPerson = householdState.people?.[owner] ?? null;
    let status = 'not-required';
    let required = 0;
    let issue = null;
    const basis = suppliedBasis
      ? priorYearEndBalanceForOwner(owner, ownerContract)
      : ownerContract.priorYearEndBalance;
    const basisAvailable = suppliedBasis
      ? Number.isFinite(basis)
      : (ownerContract.priorYearEndBalanceAvailable === true && Number.isFinite(basis));

    if(suppliedBasis && !(basis > 0.01)){
      // Projection mode: this owner holds no pre-tax dollars this year, so
      // there is nothing to distribute and nothing to resolve. Most often a
      // decedent whose balance already rolled to the survivor — they must not
      // keep failing the lifecycle check forever after.
      status = 'not-required';
      required = 0;
    }else if(!ownerPerson?.alive){
      status = 'unavailable';
      required = null;
      issue = 'TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE';
    }else if(ownerContract.startAge === null){
      status = 'unavailable';
      required = null;
      issue = 'RMD_BIRTH_COHORT_UNAVAILABLE';
    }else if(ownerPerson.age >= ownerContract.startAge){
      if(!focusYearMatchesBase){
        status = 'unavailable';
        required = null;
        issue = 'RMD_FOCUS_YEAR_BALANCE_UNAVAILABLE';
      }else if(ownerContract.rmdAccountAttributionAvailable !== true){
        status = 'unavailable';
        required = null;
        issue = 'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE';
      }else if(ownerContract.focusRulesAvailable !== true){
        status = 'unavailable';
        required = null;
        issue = 'TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE';
      }else if(ownerContract.containsEmployerPlan
          && ownerPerson.retired !== true){
        status = 'unavailable';
        required = null;
        issue = 'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE';
      }else if(!basisAvailable){
        status = 'unavailable';
        required = null;
        issue = 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE';
      }else{
        status = 'known';
        required = basis / rmdDivisor(ownerPerson.age);
      }
    }

    if(status === 'known') anyKnown = true;
    if(status === 'unavailable') anyUnavailable = true;
    if(required !== null) requiredTotal += required;
    if(Number.isFinite(basis)){
      priorYearEndTotal += basis;
    }else{
      priorYearEndComplete = false;
    }
    details[owner] = {
      status,
      age: ownerPerson?.age ?? null,
      applicableAge: ownerContract.startAge,
      priorYearEndBalance: Number.isFinite(basis) ? basis : null,
      containsEmployerPlan: ownerContract.containsEmployerPlan === true,
      required,
      issue,
    };
  }

  return {
    byOwner: details,
    requiredTotal: anyUnavailable ? null : requiredTotal,
    status: anyUnavailable ? 'unavailable' : (anyKnown ? 'known' : 'not-required'),
    issue: anyUnavailable
      ? (Object.values(details).find(detail => detail.issue)?.issue
        ?? 'RMD_CONTRACT_UNAVAILABLE')
      : null,
    priorYearEndTotal,
    priorYearEndComplete,
  };
}

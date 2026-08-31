// Projection Engine implementation; public consumers import engine.js.
import { rmdDivisor, evaluateRmdByOwner } from './requiredDistributions.js';
import { householdTaxStatusAtAge } from './householdTimeline.js';
import { resolvePortfolioAccounts } from '../../household/resolvePortfolioAccounts.js';
import { resolveAccountTaxReportingGap } from '../../household/resolveTaxableStartingBasis.js';
import { getAccountTypeById } from '../../household/accountTypes.js';
import { resolveInputs } from './resolveInputs.js';

const WITHDRAWAL_PLANNER_LEVER_KEYS = Object.freeze([
  'taxableWithdrawal',
  'deferredWithdrawal',
  'rothConversion',
  'rothWithdrawal',
  'qcd',
]);

const TRADITIONAL_WITHDRAWAL_LEVERS = Object.freeze([
  'deferredWithdrawal',
  'rothConversion',
  'qcd',
]);

function normalizeWithdrawalPlannerLevers(requested = {}){
  const out = {};
  for(const key of WITHDRAWAL_PLANNER_LEVER_KEYS){
    const value = requested[key] ?? 0;
    if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
      throw new TypeError(`${key} must be a finite nonnegative number`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

export function resolveWithdrawalPlannerAccountState(
  plan,
  requestedLevers = {},
  accountReservations = {}
){
  const requested = normalizeWithdrawalPlannerLevers(requestedLevers);
  const reservedTraditionalTotal = accountReservations?.traditionalTotal
    ?? accountReservations?.traditional
    ?? 0;
  const reservedRmdEligibleCash = accountReservations?.rmdEligibleCash ?? 0;
  const focusTaxYear = accountReservations?.taxYear
    ?? (Number.isInteger(plan?.meta?.planningAsOfYear)
      ? plan.meta.planningAsOfYear
      : 2026);
  if(typeof reservedTraditionalTotal !== 'number'
      || !Number.isFinite(reservedTraditionalTotal)
      || reservedTraditionalTotal < 0){
    throw new TypeError('accountReservations.traditionalTotal must be a finite nonnegative number');
  }
  if(typeof reservedRmdEligibleCash !== 'number'
      || !Number.isFinite(reservedRmdEligibleCash)
      || reservedRmdEligibleCash < 0
      || reservedRmdEligibleCash > reservedTraditionalTotal){
    throw new TypeError('accountReservations.rmdEligibleCash must be within traditionalTotal');
  }
  if(!Number.isInteger(focusTaxYear)){
    throw new TypeError('accountReservations.taxYear must be an integer');
  }
  let reservedTraditionalByOwner = null;
  if(accountReservations?.traditionalByOwner != null){
    if(typeof accountReservations.traditionalByOwner !== 'object'
        || Array.isArray(accountReservations.traditionalByOwner)){
      throw new TypeError('accountReservations.traditionalByOwner must be an object');
    }
    reservedTraditionalByOwner = {
      client: accountReservations.traditionalByOwner.client ?? 0,
      spouse: accountReservations.traditionalByOwner.spouse ?? 0,
    };
    if(Object.values(reservedTraditionalByOwner).some(value => (
      typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ))){
      throw new TypeError('accountReservations.traditionalByOwner values must be finite and nonnegative');
    }
  }
  let reservedRmdEligibleCashByOwner = null;
  if(accountReservations?.rmdEligibleCashByOwner != null){
    if(typeof accountReservations.rmdEligibleCashByOwner !== 'object'
        || Array.isArray(accountReservations.rmdEligibleCashByOwner)){
      throw new TypeError('accountReservations.rmdEligibleCashByOwner must be an object');
    }
    reservedRmdEligibleCashByOwner = {
      client: accountReservations.rmdEligibleCashByOwner.client ?? 0,
      spouse: accountReservations.rmdEligibleCashByOwner.spouse ?? 0,
    };
    if(Object.values(reservedRmdEligibleCashByOwner).some(value => (
      typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ))){
      throw new TypeError('accountReservations.rmdEligibleCashByOwner values must be finite and nonnegative');
    }
  }
  const fold = resolvePortfolioAccounts(plan);
  const balances = { taxable: 0, traditional: 0, roth: 0 };
  const traditionalBalancesByOwner = { client: 0, spouse: 0 };
  let traditionalBalanceAttributionAvailable = true;
  const excludedAccountIds = [];
  const accountSourceIssues = [];
  const legacyPools = new Set();
  const typedPools = new Set();
  for(const account of fold.accounts){
    const raw = account.sourceKind === 'typed-account'
      ? plan?.portfolio?.extraAccounts?.[account.sourceIndex]
      : null;
    const canonical = account.sourceKind === 'typed-account'
      ? getAccountTypeById(account.typeId)
      : null;
    const reportingGap = account.sourceKind === 'typed-account'
      && canonical?.supportedForTax === true
      ? resolveAccountTaxReportingGap(raw, account, plan)
      : null;
    const ownerAvailable = account.owner !== 'spouse'
      || Boolean(plan?.household?.spouse);
    const eligible = ownerAvailable
      && account.taxBucketGroup
      && !account.strategyRulesPending
      && (account.sourceKind === 'legacy-base'
        || (account.classificationStatus === 'included'
          && canonical?.supportedForTax === true
          && reportingGap === null));
    if(eligible){
      balances[account.taxBucketGroup] += account.balance;
      if(account.taxBucketGroup === 'traditional' && account.balance > 0){
        if(account.sourceKind === 'typed-account'
            && (account.owner === 'client' || account.owner === 'spouse')){
          traditionalBalancesByOwner[account.owner] += account.balance;
        }else{
          traditionalBalanceAttributionAvailable = false;
        }
      }
      if(account.balance > 0){
        (account.sourceKind === 'legacy-base' ? legacyPools : typedPools)
          .add(account.taxBucketGroup);
      }
    }else if(account.balance > 0){
      excludedAccountIds.push(account.id);
      if(!ownerAvailable){
        accountSourceIssues.push(`ACCOUNT_OWNER_UNAVAILABLE:${account.id}`);
      }else if(account.sourceKind === 'typed-account'
          && canonical?.supportedForTax !== true){
        accountSourceIssues.push(`ACCOUNT_TAX_SCOPE_UNAVAILABLE:${account.id}`);
      }else if(reportingGap){
        accountSourceIssues.push(`${reportingGap.code}:${account.id}`);
      }
    }
  }
  const ambiguousPools = new Set(
    [...legacyPools].filter(pool => typedPools.has(pool))
  );

  const availableFor = pool => ambiguousPools.has(pool) ? null : balances[pool];
  const taxableAvailable = availableFor('taxable');
  const traditionalAvailable = availableFor('traditional');
  const rothAvailable = availableFor('roth');
  let rmdStatus = 'not-required';
  let rmdOwner = null;
  let rmdAge = null;
  let rmdApplicableAge = null;
  let rmdPriorYearEndBalance = null;
  let rmdRequired = 0;
  let rmdIssue = null;
  let rmdByOwner = null;
  let rmdContainsEmployerPlan = false;
  if(traditionalAvailable === null){
    rmdStatus = 'unavailable';
    rmdRequired = null;
    rmdIssue = 'ACCOUNT_POOL_AMBIGUOUS';
  }else if(traditionalAvailable > 0.01){
    try{
      const resolved = resolveInputs(plan, {});
      const contract = resolved.rmdContract;
      const baseTaxYear = contract?.planningAsOfYear
        ?? (Number.isInteger(plan?.meta?.planningAsOfYear)
          ? plan.meta.planningAsOfYear
          : 2026);
      const primaryAge = resolved.currentAge + (focusTaxYear - baseTaxYear);
      const householdState = householdTaxStatusAtAge(resolved, primaryAge);
      const ownerContracts = Object.entries(contract?.byOwner || {});
      const exactMultiOwnerFocus = traditionalBalanceAttributionAvailable
        && ownerContracts.length > 1
        && ownerContracts.every(([owner, ownerContract]) => (
          Math.abs(
            ownerContract.balance - (traditionalBalancesByOwner[owner] ?? 0)
          ) <= 0.01
        ));
      if(exactMultiOwnerFocus){
        const evaluated = evaluateRmdByOwner(contract, householdState, {
          focusYearMatchesBase: focusTaxYear === baseTaxYear,
        });
        rmdByOwner = evaluated.byOwner;
        rmdOwner = null;
        rmdAge = null;
        rmdApplicableAge = null;
        rmdPriorYearEndBalance = evaluated.priorYearEndComplete
          ? evaluated.priorYearEndTotal
          : null;
        rmdStatus = evaluated.status;
        rmdRequired = evaluated.requiredTotal;
        rmdIssue = evaluated.issue;
      }else{
        const person = contract?.owner
          ? householdState.people?.[contract.owner]
          : null;
        rmdOwner = contract?.owner ?? null;
        rmdContainsEmployerPlan = contract?.containsEmployerPlan === true;
        rmdAge = person?.age ?? null;
        rmdApplicableAge = contract?.startAge ?? null;
        rmdPriorYearEndBalance = contract?.priorYearEndBalance ?? null;
        if(!contract?.available || !contract.owner){
          const possibleOwners = contract?.owner
            ? [householdState.people?.[contract.owner]].filter(Boolean)
            : Object.values(householdState.people || {}).filter(Boolean);
          const noCurrentRmdExposure = possibleOwners.length > 0
            && possibleOwners.every(candidate => (
              candidate.alive === true
                && typeof candidate.age === 'number'
                && candidate.age < (candidate.rmdStartAge ?? 72)
            ));
          if(noCurrentRmdExposure){
            rmdStatus = 'not-required';
          }else{
            rmdStatus = 'unavailable';
            rmdRequired = null;
            rmdIssue = contract?.issue ?? 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE';
          }
        }else if(!person?.alive){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE';
        }else if(person.age < contract.startAge){
          rmdStatus = 'not-required';
        }else if(focusTaxYear !== baseTaxYear){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'RMD_FOCUS_YEAR_BALANCE_UNAVAILABLE';
        }else if(contract.focusRulesAvailable !== true){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE';
        }else if(contract.containsEmployerPlan && person.retired !== true){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE';
        }else if(contract.priorYearEndBalanceAvailable !== true
            || !Number.isFinite(contract.priorYearEndBalance)){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE';
        }else{
          rmdStatus = 'known';
          rmdRequired = contract.priorYearEndBalance / rmdDivisor(person.age);
        }
      }
    }catch(error){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = error?.code ?? 'RMD_CONTRACT_UNAVAILABLE';
    }
  }

  let appliedReservedTraditionalTotal = reservedTraditionalTotal;
  let appliedReservedRmdEligibleCash = reservedRmdEligibleCash;
  let traditionalOwnerCapacityIssue = null;
  let traditionalOwnerAttributionMissing = false;
  let rmdOwnerCapacityIssue = null;
  // Aggregate current-return IRA activity can reserve household capacity until
  // an owner-specific RMD obligation makes attribution legally relevant.
  if(rmdByOwner && rmdStatus !== 'not-required'){
    const traditionalOwnerTotal = reservedTraditionalByOwner
      ? reservedTraditionalByOwner.client + reservedTraditionalByOwner.spouse
      : null;
    const rmdCashOwnerTotal = reservedRmdEligibleCashByOwner
      ? reservedRmdEligibleCashByOwner.client + reservedRmdEligibleCashByOwner.spouse
      : null;
    const traditionalOwnerAttributionAvailable = reservedTraditionalTotal === 0
      || (traditionalOwnerTotal !== null
        && Math.abs(traditionalOwnerTotal - reservedTraditionalTotal) <= 0.01);
    const rmdCashOwnerAttributionAvailable = reservedRmdEligibleCash === 0
      || (rmdCashOwnerTotal !== null
        && Math.abs(rmdCashOwnerTotal - reservedRmdEligibleCash) <= 0.01);
    const ownerCashWithinTraditional = reservedTraditionalByOwner
      && reservedRmdEligibleCashByOwner
      ? ['client', 'spouse'].every(owner => (
        reservedRmdEligibleCashByOwner[owner] <= reservedTraditionalByOwner[owner] + 0.01
      ))
      : reservedRmdEligibleCash === 0;
    if(traditionalOwnerAttributionAvailable && reservedTraditionalByOwner){
      appliedReservedTraditionalTotal = reservedTraditionalByOwner.client
        + reservedTraditionalByOwner.spouse;
    }
    if(rmdCashOwnerAttributionAvailable && reservedRmdEligibleCashByOwner){
      appliedReservedRmdEligibleCash = reservedRmdEligibleCashByOwner.client
        + reservedRmdEligibleCashByOwner.spouse;
    }
    traditionalOwnerAttributionMissing = !traditionalOwnerAttributionAvailable
      || !rmdCashOwnerAttributionAvailable
      || !ownerCashWithinTraditional;
    if(traditionalOwnerAttributionMissing && rmdStatus === 'known'){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE';
    }
  }else if(rmdOwner && plan?.household?.spouse){
    const traditionalOwnerTotal = reservedTraditionalByOwner
      ? reservedTraditionalByOwner.client + reservedTraditionalByOwner.spouse
      : null;
    const rmdCashOwnerTotal = reservedRmdEligibleCashByOwner
      ? reservedRmdEligibleCashByOwner.client + reservedRmdEligibleCashByOwner.spouse
      : null;
    const traditionalOwnerAttributionAvailable = reservedTraditionalTotal === 0
      || (traditionalOwnerTotal !== null
        && Math.abs(traditionalOwnerTotal - reservedTraditionalTotal) <= 0.01);
    const rmdCashOwnerAttributionAvailable = reservedRmdEligibleCash === 0
      || (rmdCashOwnerTotal !== null
        && Math.abs(rmdCashOwnerTotal - reservedRmdEligibleCash) <= 0.01);
    const ownerCashWithinTraditional = reservedTraditionalByOwner
      && reservedRmdEligibleCashByOwner
      ? ['client', 'spouse'].every(owner => (
        reservedRmdEligibleCashByOwner[owner] <= reservedTraditionalByOwner[owner] + 0.01
      ))
      : reservedRmdEligibleCash === 0;
    if(traditionalOwnerAttributionAvailable && reservedTraditionalByOwner){
      appliedReservedTraditionalTotal = reservedTraditionalByOwner[rmdOwner];
    }
    if(rmdCashOwnerAttributionAvailable && reservedRmdEligibleCashByOwner){
      appliedReservedRmdEligibleCash = reservedRmdEligibleCashByOwner[rmdOwner];
    }
    if(rmdStatus === 'known'
        && (!traditionalOwnerAttributionAvailable
          || !rmdCashOwnerAttributionAvailable
          || !ownerCashWithinTraditional)){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE';
    }
  }
  if(rmdStatus === 'known'){
    const employerPlanCashOwner = rmdByOwner
      ? Object.entries(rmdByOwner).find(([owner, detail]) => (
        detail.containsEmployerPlan === true
          && (reservedRmdEligibleCashByOwner?.[owner] ?? 0) > 0
      ))?.[0] ?? null
      : (rmdContainsEmployerPlan && appliedReservedRmdEligibleCash > 0
        ? rmdOwner
        : null);
    if(employerPlanCashOwner){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = 'EMPLOYER_PLAN_RMD_CASH_ATTRIBUTION_UNAVAILABLE';
      if(rmdByOwner?.[employerPlanCashOwner]){
        rmdByOwner[employerPlanCashOwner] = {
          ...rmdByOwner[employerPlanCashOwner],
          status: 'unavailable',
          required: null,
          issue: rmdIssue,
        };
      }
    }
  }
  if(rmdByOwner && reservedTraditionalByOwner){
    for(const owner of Object.keys(rmdByOwner)){
      const reserved = reservedTraditionalByOwner[owner] ?? 0;
      const available = traditionalBalancesByOwner[owner] ?? 0;
      if(reserved > available + 0.01){
        traditionalOwnerCapacityIssue = {
          code: 'TRADITIONAL_OWNER_POOL_EXCEEDED',
          owner,
          requested: reserved,
          available,
        };
        break;
      }
    }
  }
  let rmdMinimumCash = rmdStatus === 'known'
    ? Math.max(0, rmdRequired - appliedReservedRmdEligibleCash)
    : 0;
  if(rmdByOwner && rmdStatus === 'known'){
    rmdMinimumCash = 0;
    for(const [owner, detail] of Object.entries(rmdByOwner)){
      const fixedTraditional = reservedTraditionalByOwner?.[owner] ?? 0;
      const fixedCash = reservedRmdEligibleCashByOwner?.[owner] ?? 0;
      const ownerFloor = detail.status === 'known'
        ? Math.max(0, detail.required - fixedCash)
        : 0;
      rmdMinimumCash += ownerFloor;
      if(!traditionalOwnerCapacityIssue
          && fixedTraditional + ownerFloor
            > traditionalBalancesByOwner[owner] + 0.01){
        rmdOwnerCapacityIssue = {
          code: 'RMD_MINIMUM_EXCEEDS_OWNER_TRADITIONAL',
          owner,
          required: ownerFloor,
          reserved: fixedTraditional,
          available: traditionalBalancesByOwner[owner],
        };
      }
    }
    if(rmdOwnerCapacityIssue){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = rmdOwnerCapacityIssue.code;
      rmdMinimumCash = 0;
    }
  }
  const rmdSatisfiedByFixedCash = rmdStatus === 'known'
    ? (rmdByOwner
      ? Object.entries(rmdByOwner).reduce((sum, [owner, detail]) => (
        sum + (detail.status === 'known'
          ? Math.min(detail.required, reservedRmdEligibleCashByOwner?.[owner] ?? 0)
          : 0)
      ), 0)
      : Math.min(rmdRequired, appliedReservedRmdEligibleCash))
    : (rmdStatus === 'not-required' ? 0 : null);
  const levers = Object.freeze({
    ...requested,
    deferredWithdrawal: Math.max(requested.deferredWithdrawal, rmdMinimumCash),
  });
  const rmdRemaining = rmdStatus === 'known'
    ? Math.max(0, rmdRequired - rmdSatisfiedByFixedCash - levers.deferredWithdrawal)
    : (rmdStatus === 'not-required' ? 0 : null);
  const rmdOwnerDetails = rmdByOwner ?? (rmdOwner
    ? {
      [rmdOwner]: {
        status: rmdStatus,
        age: rmdAge,
        applicableAge: rmdApplicableAge,
        priorYearEndBalance: rmdPriorYearEndBalance,
        required: rmdRequired,
        issue: rmdIssue,
      },
    }
    : null);
  const frozenRmdByOwner = rmdOwnerDetails
    ? Object.freeze(Object.fromEntries(Object.entries(rmdOwnerDetails).map(([owner, detail]) => {
      const fixedCash = rmdStatus === 'unavailable'
        ? null
        : Math.min(
          detail.required ?? 0,
          rmdByOwner
            ? reservedRmdEligibleCashByOwner?.[owner] ?? 0
            : appliedReservedRmdEligibleCash
        );
      const plannerCash = detail.status === 'known' && fixedCash !== null
        ? Math.max(0, detail.required - fixedCash)
        : (detail.status === 'not-required' ? 0 : null);
      return [owner, Object.freeze({
        ...detail,
        satisfiedByFixedCash: fixedCash,
        satisfiedByPlannerCash: plannerCash,
        remaining: detail.status === 'unavailable' || fixedCash === null
          ? null
          : Math.max(0, (detail.required ?? 0) - fixedCash - plannerCash),
      })];
    })))
    : null;
  const rmd = Object.freeze({
    status: rmdStatus,
    owner: rmdOwner,
    age: rmdAge,
    applicableAge: rmdApplicableAge,
    priorYearEndBalance: rmdPriorYearEndBalance,
    required: rmdRequired,
    satisfiedByFixedCash: rmdSatisfiedByFixedCash,
    remaining: rmdRemaining,
    issue: rmdIssue,
    byOwner: frozenRmdByOwner,
  });
  const rmdShortfall = rmdStatus === 'known'
    ? Math.max(0, rmdRequired - rmdSatisfiedByFixedCash - levers.deferredWithdrawal)
    : 0;
  const interactiveTraditionalUsed = TRADITIONAL_WITHDRAWAL_LEVERS
    .reduce((sum, key) => sum + levers[key], 0);
  const traditionalUsed = appliedReservedTraditionalTotal + interactiveTraditionalUsed;
  const traditionalRemaining = traditionalAvailable === null
    ? null
    : Math.max(0, traditionalAvailable - traditionalUsed);
  const traditionalOwnerLimitsUnavailable = Boolean(
    traditionalOwnerCapacityIssue || traditionalOwnerAttributionMissing
  );
  const deferredMaximum = traditionalAvailable === null
      || traditionalOwnerLimitsUnavailable
    ? null
    : Math.max(
      0,
      traditionalAvailable
        - appliedReservedTraditionalTotal
        - levers.rothConversion
        - levers.qcd
    );
  const conversionMaximum = traditionalAvailable === null
      || traditionalOwnerLimitsUnavailable
      || rmdStatus === 'unavailable'
    ? null
    : Math.max(
      0,
      traditionalAvailable
        - appliedReservedTraditionalTotal
        - levers.deferredWithdrawal
        - levers.qcd
        - rmdShortfall
    );
  const qcdMaximum = traditionalAvailable === null
      || traditionalOwnerLimitsUnavailable
    ? null
    : Math.max(
      0,
      traditionalAvailable
        - appliedReservedTraditionalTotal
        - levers.deferredWithdrawal
        - levers.rothConversion
        - rmdShortfall
    );
  const limits = {
    taxableWithdrawal: Object.freeze({
      pool: 'taxable', min: 0, max: taxableAvailable,
      available: taxableAvailable !== null,
    }),
    rothWithdrawal: Object.freeze({
      pool: 'roth', min: 0, max: rothAvailable,
      available: rothAvailable !== null,
    }),
    deferredWithdrawal: Object.freeze({
      pool: 'traditional', min: rmdMinimumCash, max: deferredMaximum,
      available: deferredMaximum !== null,
    }),
    rothConversion: Object.freeze({
      pool: 'traditional', min: 0, max: conversionMaximum,
      available: conversionMaximum !== null,
    }),
    qcd: Object.freeze({
      pool: 'traditional', min: 0, max: qcdMaximum,
      available: qcdMaximum !== null,
    }),
  };

  const issues = [];
  if(traditionalOwnerCapacityIssue){
    issues.push(Object.freeze(traditionalOwnerCapacityIssue));
  }
  if(rmdOwnerCapacityIssue){
    issues.push(Object.freeze(rmdOwnerCapacityIssue));
  }
  if(traditionalOwnerAttributionMissing){
    for(const lever of TRADITIONAL_WITHDRAWAL_LEVERS){
      if(levers[lever] > 0){
        issues.push(Object.freeze({
          code: 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE',
          lever,
          requested: levers[lever],
        }));
      }
    }
  }
  const usedByPool = {
    taxable: levers.taxableWithdrawal,
    traditional: traditionalUsed,
    roth: levers.rothWithdrawal,
  };
  for(const pool of ambiguousPools){
    if(usedByPool[pool] > 0){
      issues.push(Object.freeze({
        code: 'ACCOUNT_POOL_AMBIGUOUS',
        pool,
        requested: usedByPool[pool],
      }));
    }
  }
  if(taxableAvailable !== null && levers.taxableWithdrawal > taxableAvailable){
    issues.push(Object.freeze({
      code: 'TAXABLE_POOL_EXCEEDED',
      available: taxableAvailable,
      requested: levers.taxableWithdrawal,
    }));
  }
  if(rothAvailable !== null && levers.rothWithdrawal > rothAvailable){
    issues.push(Object.freeze({
      code: 'ROTH_POOL_EXCEEDED',
      available: rothAvailable,
      requested: levers.rothWithdrawal,
    }));
  }
  if(traditionalAvailable !== null && traditionalUsed > traditionalAvailable){
    issues.push(Object.freeze({
      code: 'TRADITIONAL_POOL_EXCEEDED',
      available: traditionalAvailable,
      requested: traditionalUsed,
    }));
  }
  if(rmdStatus === 'known'
      && deferredMaximum !== null
      && rmdMinimumCash > deferredMaximum){
    issues.push(Object.freeze({
      code: 'RMD_MINIMUM_EXCEEDS_AVAILABLE_TRADITIONAL',
      required: rmdMinimumCash,
      available: deferredMaximum,
    }));
  }
  if(rmdStatus === 'unavailable' && levers.rothConversion > 0){
    issues.push(Object.freeze({
      code: 'RMD_ACCOUNT_LIMIT_UNAVAILABLE',
      lever: 'rothConversion',
      requested: levers.rothConversion,
    }));
  }

  return Object.freeze({
    valid: issues.length === 0,
    requestedLevers: requested,
    levers,
    reservations: Object.freeze({
      traditional: appliedReservedTraditionalTotal,
      traditionalTotal: appliedReservedTraditionalTotal,
      rmdEligibleCash: appliedReservedRmdEligibleCash,
      taxYear: focusTaxYear,
    }),
    balances: Object.freeze({ ...balances }),
    limits: Object.freeze(limits),
    rmd,
    pools: Object.freeze({
      taxable: Object.freeze({
        available: taxableAvailable,
        used: levers.taxableWithdrawal,
        remaining: taxableAvailable === null
          ? null
          : Math.max(0, taxableAvailable - levers.taxableWithdrawal),
      }),
      traditional: Object.freeze({
        available: traditionalAvailable,
        used: traditionalUsed,
        remaining: traditionalRemaining,
      }),
      roth: Object.freeze({
        available: rothAvailable,
        used: levers.rothWithdrawal,
        remaining: rothAvailable === null
          ? null
          : Math.max(0, rothAvailable - levers.rothWithdrawal),
      }),
    }),
    issues: Object.freeze(issues),
    sourceIssues: Object.freeze([...new Set([...fold.issues, ...accountSourceIssues])]),
    ambiguousPools: Object.freeze([...ambiguousPools]),
    excludedAccountIds: Object.freeze(excludedAccountIds),
  });
}

export function approveWithdrawalPlannerLeverChange(
  plan,
  currentLevers,
  changedLever,
  requestedValue,
  accountReservations = {}
){
  if(!WITHDRAWAL_PLANNER_LEVER_KEYS.includes(changedLever)){
    throw new TypeError(`Unknown Withdrawal Planner lever: ${changedLever}`);
  }
  if(typeof requestedValue !== 'number' || !Number.isFinite(requestedValue) || requestedValue < 0){
    throw new TypeError('requestedValue must be a finite nonnegative number');
  }
  const currentState = resolveWithdrawalPlannerAccountState(
    plan,
    normalizeWithdrawalPlannerLevers(currentLevers),
    accountReservations
  );
  const current = currentState.levers;
  const minimum = currentState.limits[changedLever].min ?? 0;
  const maximum = currentState.limits[changedLever].max;
  if(maximum === null){
    return Object.freeze({
      approved: false,
      requestedValue,
      approvedValue: current[changedLever],
      clamped: requestedValue !== current[changedLever],
      levers: current,
      state: currentState,
    });
  }
  const approvedValue = Math.max(minimum, Math.min(requestedValue, maximum));
  const levers = Object.freeze({ ...current, [changedLever]: approvedValue });
  const state = resolveWithdrawalPlannerAccountState(plan, levers, accountReservations);
  return Object.freeze({
    approved: state.valid,
    requestedValue,
    approvedValue,
    clamped: approvedValue !== requestedValue,
    levers,
    state,
  });
}

export function buildWithdrawalPlannerCashContract(levers, incrementalModeledFederalIncomeTax){
  const normalized = normalizeWithdrawalPlannerLevers(levers);
  if(incrementalModeledFederalIncomeTax !== null
      && (typeof incrementalModeledFederalIncomeTax !== 'number'
        || !Number.isFinite(incrementalModeledFederalIncomeTax))){
    throw new TypeError('incrementalModeledFederalIncomeTax must be finite or null');
  }
  const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const grossWithdrawalCash = round2(
    normalized.taxableWithdrawal
      + normalized.deferredWithdrawal
      + normalized.rothWithdrawal
  );
  if(incrementalModeledFederalIncomeTax === null){
    return Object.freeze({
      grossWithdrawalCash,
      incrementalModeledFederalIncomeTax: null,
      netAfterIncrementalModeledFederalIncomeTax: null,
    });
  }
  return Object.freeze({
    grossWithdrawalCash,
    incrementalModeledFederalIncomeTax: round2(incrementalModeledFederalIncomeTax),
    netAfterIncrementalModeledFederalIncomeTax: round2(
      grossWithdrawalCash - incrementalModeledFederalIncomeTax
    ),
  });
}

// Projection Engine implementation; public consumers import engine.js.
import { emptyTraditionalOwnerBuckets, reconcileTraditionalTotal } from './traditionalOwners.js';
import { validateProjectionHorizon, validateProjectionIterations } from './execution.js';
import { resolveHouseholdTimeline } from './householdTimeline.js';
import { resolvePortfolioAccounts } from '../../household/resolvePortfolioAccounts.js';
import { resolveTaxableStartingBasis } from '../../household/resolveTaxableStartingBasis.js';
import { getAccountTypeById } from '../../household/accountTypes.js';
import { normalizedIncomeSource } from '../../household/incomeTaxModel.js';
import { goalsFromLegacyExpenses } from '../../household/migrateSpendingToGoals.js';
import { aggregateProjectionAccounts, buildProjectionAccountLedger } from '../accountLedger.js';
import { LONGRUN_INFLATION, RISK_PROFILES } from './marketAssumptions.js';

// Social Security claim-age math (modern Full Retirement Age = 67, born 1960+).
// pia = Primary Insurance Amount = the benefit at FRA. The actual benefit is the
// pia adjusted for when you actually file (the real SSA schedule):
//   • file LATE  → delayed retirement credits, +8%/yr, capped at age 70.
//   • file EARLY → permanent reduction: 5/9 of 1% per month for the first 36
//     months before FRA, then 5/12 of 1% per month beyond that. (62 = 30% cut.)
const SS_FRA = 67;

export function ssAdjust(pia, claimAge){
  const c = Math.max(62, Math.min(70, claimAge));
  if(c >= SS_FRA) return pia * (1 + 0.08 * (c - SS_FRA));
  const monthsEarly = (SS_FRA - c) * 12;
  const first36 = Math.min(monthsEarly, 36);
  const beyond  = Math.max(0, monthsEarly - 36);
  return pia * (1 - (first36 * (5/900) + beyond * (5/1200)));
}

// Standard fixed-rate amortization → the NOMINAL ANNUAL payment (12 monthly
// payments). `ratePct` is the APR in percent; rate 0 → straight-line. This is the
// ONLY mortgage math the engine derives; the resulting payment is then run through
// the existing (tested) liability cash-flow path, so mortgages add no new sim-loop
// surface. Returns 0 for a paid-off or term-less loan.
export function annualMortgagePayment(balance, ratePct, termYears){
  const P = Math.max(0, balance || 0);
  const yrs = Math.max(0, termYears || 0);
  if(P <= 0 || yrs <= 0) return 0;
  const mr = (Math.max(0, ratePct || 0) / 100) / 12;
  const N  = yrs * 12;
  const monthly = (mr < 1e-9) ? P / N : (P * mr) / (1 - Math.pow(1 + mr, -N));
  return monthly * 12;
}

// Remaining NOMINAL balance of an amortizing loan after `yearsElapsed`. Mirrors
// annualMortgagePayment's monthly compounding so the payoff figure when a
// property is SOLD mid-term reconciles with the payment that's been running.
function mortgageBalanceRemaining(balance, ratePct, termYears, yearsElapsed){
  const P = Math.max(0, balance || 0);
  const yrs = Math.max(0, termYears || 0);
  if(P <= 0 || yrs <= 0) return 0;
  const mr = (Math.max(0, ratePct || 0) / 12) / 100;
  const N  = yrs * 12;
  const n  = Math.max(0, Math.min(N, Math.round((yearsElapsed || 0) * 12)));
  if(mr < 1e-9) return P * (1 - n / N);                       // 0% = straight-line
  return P * (Math.pow(1 + mr, N) - Math.pow(1 + mr, n)) / (Math.pow(1 + mr, N) - 1);
}

export function resolveInputs(plan, ov){
  const profile = RISK_PROFILES[plan.portfolio.riskProfile];
  const timeline = resolveHouseholdTimeline(plan, ov);
  const pCurAge = timeline.people.client.currentAge;
  const spousePlan = plan.household.spouse || null;
  const spouseCurAge = timeline.people.spouse?.currentAge ?? null;
  const primaryEndAge = timeline.people.client.planEndAgeOnPrimaryTimeline;
  const spouseEndAge = timeline.people.spouse?.planEndAgeOnPrimaryTimeline ?? null;
  const householdEndAge = timeline.householdEndAgeOnPrimaryTimeline;
  const horizon = (householdEndAge ?? pCurAge) - pCurAge + 1;
  validateProjectionHorizon(horizon);
  const iterations = validateProjectionIterations(plan?.simulation?.iterations);

  // Social Security — per person. Each benefit is the pia (benefit at FRA, today's
  // dollars) actuarially adjusted for the actual claim age, haircut by any ssCut
  // stress, then mapped onto the PRIMARY's age timeline (the frame the sim runs in)
  // so a spouse of a different age switches on at the right simulation year.
  // ssDelayYears (the SS Start Age lever) is a SIGNED shift to the PRIMARY's claim
  // age; the spouse keeps their own claim age (edited on the input page).
  const ssCfg = plan.income.socialSecurity || {};
  const ssCutMult = 1 - (ov.ssCut || 0);
  const ssBenefits = [];
  const incomeContractIssues = [];
  function addSS(person, owner){
    if(!person || !(person.pia > 0)) return;
    const isPrimary = owner === 'client';
    const personTimeline = timeline.people[owner];
    const claim = personTimeline.socialSecurityClaimAge;
    const personCurAge = personTimeline.currentAge;
    if(claim === null || personCurAge === null){
      incomeContractIssues.push(`SOCIAL_SECURITY_TIMELINE_INCOMPLETE:${owner}`);
      return;
    }
    ssBenefits.push({
      owner,
      amount:   ssAdjust(person.pia, claim) * ssCutMult,
      startAge: pCurAge + (claim - personCurAge),
      endAge: isPrimary ? primaryEndAge : spouseEndAge,
    });
  }
  addSS(ssCfg.primary, 'client');
  if(timeline.people.spouse) addSS(ssCfg.spouse, 'spouse');

  // Spend cut: proportional reduction across all expense categories.
  // spendCut reduces spending (stress); spendBump raises it (elasticity probe).
  for(const key of ['spendCut', 'spendBump']){
    if(Object.prototype.hasOwnProperty.call(ov, key) && !Number.isFinite(ov[key])){
      throw new TypeError(`${key} must be finite`);
    }
  }
  const hasLivingAnnual = Object.prototype.hasOwnProperty.call(ov, 'livingAnnual');
  if(hasLivingAnnual && (!Number.isFinite(ov.livingAnnual) || ov.livingAnnual < 0)){
    throw new TypeError('livingAnnual must be a finite non-negative number');
  }
  const hasSavingsAnnual = Object.prototype.hasOwnProperty.call(ov, 'savingsAnnual');
  if(hasSavingsAnnual && (!Number.isFinite(ov.savingsAnnual) || ov.savingsAnnual < 0)){
    throw new TypeError('savingsAnnual must be a finite non-negative number');
  }
  const spendMult = (1 - Math.max(0, Math.min(0.5, ov.spendCut || 0))) * (1 + Math.max(0, ov.spendBump || 0));

  // Typed accounts (401k, SEP, etc.) retain identity and their saved allocation.
  // Aggregate sleeves remain derived adapters for existing consumers.
  const accountFold = resolvePortfolioAccounts(plan);
  const unavailableOwnerAccount = accountFold.accounts.find(account => (
    account.sourceKind === 'typed-account'
      && account.owner === 'spouse'
      && !spousePlan
      && account.balance > 0
  ));
  if(unavailableOwnerAccount){
    const error = new RangeError('ACCOUNT_OWNER_UNAVAILABLE');
    error.code = 'ACCOUNT_OWNER_UNAVAILABLE';
    error.accountId = unavailableOwnerAccount.id;
    throw error;
  }
  const taxableBasis = resolveTaxableStartingBasis(plan, accountFold);
  const projectionAccounts = buildProjectionAccountLedger({
    plan,
    accountFold,
    taxableBasis,
    initialShock: ov.initialShock || 0,
  });
  const projectionAggregate = aggregateProjectionAccounts(projectionAccounts);
  const accounts = {
    taxable: {
      balance: projectionAggregate.balances.taxable,
      basis: projectionAggregate.taxableBasis,
    },
    traditional: {
      balance: projectionAggregate.balances.traditional,
    },
    roth: {
      balance: projectionAggregate.balances.roth,
    }
  };
  const traditionalOwners = new Set();
  const traditionalOwnerDetails = {
    client: {
      balance: 0,
      priorYearEndBalance: 0,
      priorYearEndBalanceAvailable: true,
      focusRulesAvailable: true,
      containsEmployerPlan: false,
      traditionalIraAccountCount: 0,
      employerPlanAccountCount: 0,
      rmdAccountAttributionAvailable: true,
    },
    spouse: {
      balance: 0,
      priorYearEndBalance: 0,
      priorYearEndBalanceAvailable: true,
      focusRulesAvailable: true,
      containsEmployerPlan: false,
      traditionalIraAccountCount: 0,
      employerPlanAccountCount: 0,
      rmdAccountAttributionAvailable: true,
    },
  };
  let traditionalOwnerKnown = true;
  let traditionalAccountRulesKnown = true;
  let traditionalFocusRulesKnown = true;
  let traditionalContainsEmployerPlan = false;
  const planningAsOfYear = Number.isInteger(plan?.meta?.planningAsOfYear)
    ? plan.meta.planningAsOfYear
    : 2026;
  const requiredPriorYearEndDate = `${planningAsOfYear - 1}-12-31`;
  let traditionalPriorYearEndBalance = 0;
  let traditionalPriorYearEndBalanceAvailable = true;
  // Raw (pre-shock) pre-tax dollars per owner, following the same attribution
  // rule as the RMD ownership resolution below. Seeds the projection's owner
  // buckets and supplies the year-0 prior-Dec-31 RMD basis.
  const rawTraditionalByOwner = emptyTraditionalOwnerBuckets();
  for(const account of accountFold.accounts){
    if(account.engineBucket !== 'traditional' || account.strategyRulesPending
        || account.balance <= 0) continue;
    if(account.sourceKind === 'legacy-base'){
      traditionalFocusRulesKnown = false;
      traditionalPriorYearEndBalanceAvailable = false;
    }else if(account.sourceKind === 'typed-account'){
      const accountType = getAccountTypeById(account.typeId);
      if(accountType?.taxCharacter === 'employer_pretax'){
        traditionalContainsEmployerPlan = true;
      }else if(accountType?.taxCharacter !== 'traditional_ira'){
        traditionalAccountRulesKnown = false;
      }
      if(account.valuationDate === requiredPriorYearEndDate){
        traditionalPriorYearEndBalance += account.balance;
      }else{
        traditionalPriorYearEndBalanceAvailable = false;
      }
      if(account.owner === 'client'
          || (account.owner === 'spouse' && timeline.people.spouse)){
        const ownerDetail = traditionalOwnerDetails[account.owner];
        ownerDetail.balance += account.balance;
        if(accountType?.taxCharacter === 'employer_pretax'){
          ownerDetail.containsEmployerPlan = true;
          ownerDetail.employerPlanAccountCount += 1;
        }else if(accountType?.taxCharacter === 'traditional_ira'){
          ownerDetail.traditionalIraAccountCount += 1;
        }else if(accountType?.taxCharacter !== 'traditional_ira'){
          ownerDetail.focusRulesAvailable = false;
        }
        if(account.valuationDate === requiredPriorYearEndDate){
          ownerDetail.priorYearEndBalance += account.balance;
        }else{
          ownerDetail.priorYearEndBalanceAvailable = false;
        }
      }
    }
    if(account.owner === 'client'
        || (account.owner === 'spouse' && timeline.people.spouse)){
      traditionalOwners.add(account.owner);
      rawTraditionalByOwner[account.owner] += account.balance;
    }else if(!timeline.people.spouse && account.owner !== 'spouse'){
      // No co-client, so unowned pre-tax money (legacy aggregate, joint, trust)
      // can only be the client's. Same rule the RMD ownership resolution uses.
      traditionalOwners.add('client');
      rawTraditionalByOwner.client += account.balance;
    }else{
      // A co-client exists and this money names no person — genuinely ambiguous.
      traditionalOwnerKnown = false;
      rawTraditionalByOwner.unattributed += account.balance;
    }
  }
  let traditionalRmdAccountAttributionKnown = true;
  for(const ownerDetail of Object.values(traditionalOwnerDetails)){
    ownerDetail.rmdAccountAttributionAvailable =
      ownerDetail.employerPlanAccountCount === 0
      || (ownerDetail.employerPlanAccountCount === 1
        && ownerDetail.traditionalIraAccountCount === 0);
    if(ownerDetail.balance > 0
        && !ownerDetail.rmdAccountAttributionAvailable){
      traditionalRmdAccountAttributionKnown = false;
    }
  }
  if(traditionalOwners.size > 1) traditionalOwnerKnown = false;
  const traditionalRmdOwner = traditionalOwnerKnown && traditionalOwners.size === 1
    ? [...traditionalOwners][0]
    : (traditionalOwnerKnown && !timeline.people.spouse ? 'client' : null);

  // ── Owner-level traditional buckets ───────────────────────────────────────
  // RMDs are per owner, so the projection has to keep each person's pre-tax
  // money distinct as it grows, is drawn down, and is contributed to. These
  // buckets are the source of truth; `accounts.traditional.balance` is a derived
  // cache the read sites still use.
  //
  accounts.traditional.byOwner = { ...projectionAggregate.traditionalByOwner };
  reconcileTraditionalTotal(accounts.traditional);

  // ── Accumulation, pension, and LTC resolution (all no-op at plan defaults) ──
  const curAge        = timeline.people.client.currentAge;
  const retirementAge = timeline.householdRetirementAgeOnPrimaryTimeline ?? curAge;
  const savingsAnnual = hasSavingsAnnual
    ? ov.savingsAnnual
    : Math.max(0, ((plan.savings && plan.savings.annual) || 0) * (1 + (ov.savingsBump || 0)));
  // Contribution split — where accumulation savings land across the three sleeves.
  // Default 100% pre-tax (Traditional) so existing plans are byte-identical. Lets
  // high earners model Roth (backdoor) and post-tax brokerage contributions. The
  // ov.savingsSplit override (if given) wins over the plan's split.
  const rawSplit = ov.savingsSplit || (plan.savings && plan.savings.split) || null;
  let savingsSplit;
  if(!rawSplit){
    savingsSplit = { traditional: 1, roth: 0, taxable: 0 };   // back-compat default
  } else {
    // A split object is given (plan or override): missing keys are 0, not 1.
    const _st = Math.max(0, rawSplit.traditional || 0);
    const _sr = Math.max(0, rawSplit.roth || 0);
    const _sx = Math.max(0, rawSplit.taxable || 0);
    const _ssum = _st + _sr + _sx;
    savingsSplit = _ssum > 0
      ? { traditional: _st/_ssum, roth: _sr/_ssum, taxable: _sx/_ssum }
      : { traditional: 1, roth: 0, taxable: 0 };
  }
  const traditionalRmdStartAge = traditionalRmdOwner
    ? timeline.people[traditionalRmdOwner]?.rmdStartAge ?? null
    : null;
  const traditionalRmdSurvivorOwner = traditionalRmdOwner === 'client'
    ? 'spouse'
    : traditionalRmdOwner === 'spouse'
      ? 'client'
      : null;
  const spousalRolloverAvailable = plan?.meta?.filingStatus === 'marriedFilingJointly'
    && Boolean(spousePlan)
    && Boolean(traditionalRmdSurvivorOwner)
    && Number.isFinite(timeline.people[traditionalRmdSurvivorOwner]?.rmdStartAge)
    && traditionalAccountRulesKnown
    && traditionalRmdAccountAttributionKnown
    && traditionalFocusRulesKnown
    && !traditionalContainsEmployerPlan;
  const pen           = plan.income.pension || {};
  // Chosen collection age. The UI computes this (retirement-linked or custom) and
  // passes it as an absolute override; fall back to the plan's startAge (+ legacy
  // pensionDelay) when no absolute age is supplied.
  const penStartAge   = (ov.pensionStartAge != null ? ov.pensionStartAge
                          : (pen.startAge != null ? pen.startAge : 65) + (ov.pensionDelay || 0));
  // Discrete lookup: use ONLY the amount explicitly entered for this exact age.
  // A missing age means no modeled benefit (0) — we never invent the number.
  // `base` remains a legacy fallback for plans that still carry a single amount.
  const byAge         = pen.benefitByAge || {};
  const penEntered    = (byAge[penStartAge] != null) ? byAge[penStartAge] : pen.base;
  const penBase       = Math.max(0, (penEntered || 0));
  // Pension COLA: advisor enters a NOMINAL annual COLA% (like the SS COLA).
  // Engine is real-dollar, so convert to real drift: real = nominalCOLA − inflation.
  // 0% COLA → −inflation (flat-nominal pension erodes); COLA = inflation → flat real.
  const penColaReal = ((pen.colaPct || 0) / 100) - LONGRUN_INFLATION;
  const pensionAmount = penBase;
  const ltc           = plan.ltc || {};

  const savedOtherIncome = Array.isArray(plan.income.other)
    ? plan.income.other
    : (plan.income.other ? [plan.income.other] : []);
  const current1040 = plan.incomeTax?.current1040;
  const current1040MatchesPlanYear = Number(current1040?.taxYear)
    === Number(planningAsOfYear);
  const hasExplicitCurrentWages = current1040?.income
    && Object.prototype.hasOwnProperty.call(current1040.income, 'wages')
    && Number.isFinite(current1040.income.wages)
    && current1040.income.wages >= 0;
  const savedMemberWageOwners = new Set(savedOtherIncome
    .filter(source => source?.typeId === 'wages' || source?.typeId === 'bonus')
    .map(source => source?.owner)
    .filter(owner => owner === 'client' || owner === 'spouse'));
  const singleCurrentWageFallback = !spousePlan
    && savedMemberWageOwners.size === 0
    && current1040MatchesPlanYear
    && hasExplicitCurrentWages
    ? [{
        typeId: 'wages',
        owner: 'client',
        amount: current1040.income.wages,
        realGrowth: 0,
        taxablePct: 1,
      }]
    : [];
  const rawOtherIncome = [...savedOtherIncome, ...singleCurrentWageFallback];
  const wageOwners = new Set([
    ...savedMemberWageOwners,
    ...singleCurrentWageFallback.map(source => source.owner),
  ]);
  if(current1040 && current1040.incomeSourcesComplete !== true){
    for(const [owner, personPlan, personTimeline] of [
      ['client', plan.household.primary, timeline.people.client],
      ['spouse', spousePlan, timeline.people.spouse],
    ]){
      if(!personPlan || !personTimeline) continue;
      const working = personPlan.employmentStatus !== 'retired'
        && personTimeline.currentAge !== null
        && personTimeline.retirementAge !== null
        && personTimeline.currentAge < personTimeline.retirementAge;
      if(working && !wageOwners.has(owner)){
        incomeContractIssues.push(`INCOME_SOURCE_MISSING:${owner}:wages`);
      }
    }
  }
  const otherIncome = rawOtherIncome.map(o => {
    const source = normalizedIncomeSource(plan, o);
    const missingSourceOwner = source.owner === 'spouse' && !spousePlan;
    const spouseOwned = source.owner === 'spouse' && Boolean(spousePlan);
    const unassignedHouseholdWage = Boolean(spousePlan)
      && source.owner === 'joint'
      && (source.typeId === 'wages' || source.typeId === 'bonus');
    const missingOwnerTimeline = missingSourceOwner
      || (spouseOwned && spouseCurAge === null);
    const ownerRetirementAge = source.owner === 'spouse'
      ? timeline.people.spouse?.retirementAge
      : timeline.people.client.retirementAge;
    const missingWorkingEnd = source.timing === 'working'
      && o.endAge == null
      && ownerRetirementAge === null;
    const duplicateSocialSecurity = source.typeId === 'social_security'
      && ssBenefits.some(benefit => benefit.owner === source.owner);
    if(duplicateSocialSecurity){
      incomeContractIssues.push(`SOCIAL_SECURITY_SOURCE_OVERLAP:${source.owner}`);
    }else if(unassignedHouseholdWage){
      incomeContractIssues.push('INCOME_OWNER_UNAVAILABLE:joint:wages');
    }else if(missingSourceOwner){
      incomeContractIssues.push(`INCOME_OWNER_UNAVAILABLE:${source.owner}:${source.typeId}`);
    }else if(missingOwnerTimeline || missingWorkingEnd){
      incomeContractIssues.push(`INCOME_TIMELINE_INCOMPLETE:${source.owner}:${source.typeId}`);
    }
    const mapAge = age => spouseOwned && age !== 999
      ? pCurAge + (age - spouseCurAge)
      : age;
    const ownerEndAge = spouseOwned
      ? spouseEndAge
      : source.owner === 'joint' ? householdEndAge : primaryEndAge;
    return {
      typeId: source.typeId,
      owner: source.owner,
      amount: source.typeId === 'long_term_capital_gain'
        ? source.amount
        : Math.max(0, source.amount || 0),
      startAge: missingOwnerTimeline || missingWorkingEnd || duplicateSocialSecurity
          || unassignedHouseholdWage
        ? Infinity
        : mapAge(source.startAge),
      endAge: missingOwnerTimeline || missingWorkingEnd || duplicateSocialSecurity
          || unassignedHouseholdWage
        ? -Infinity
        : Math.min(mapAge(source.endAge), ownerEndAge ?? 999),
      realGrowth: source.realGrowth,
      taxablePct: source.taxablePct == null
        ? 1
        : Math.max(0, Math.min(1, source.taxablePct)),
      qualifiedPct: Math.max(0, Math.min(1, source.qualifiedPct || 0)),
    };
  });

  // ── Earmarked-asset sale (override-only; never baked into the base plan) ──────
  // ov.assetSale = { asset: <index into plan.properties>, age: <sale age> }. We
  // resolve the NET proceeds here (deterministic — no market randomness), in
  // NOMINAL dollars at the sale year, then deflate to today's dollars for the
  // real-dollar sim. Cap-gains is computed on the NOMINAL appreciation (the
  // real-world basis is historical cost, so inflation is part of the taxable
  // gain). The #5 primary-residence exclusion will subtract from the gain here.
  const capGainsRate = (plan.taxes.capitalGains * (1 + (ov.taxMult || 0))) / 100;
  const saleAsset = (ov.assetSale && ov.assetSale.age != null) ? ov.assetSale.asset : -1;
  const saleAge   = (saleAsset >= 0) ? ov.assetSale.age : null;
  let assetSale = null;
  if(saleAsset >= 0){
    const pr = (plan.properties || [])[saleAsset];
    if(pr && saleAge >= curAge){
      const k        = saleAge - curAge;                       // years from now to sale
      const f        = Math.pow(1 + LONGRUN_INFLATION, k);     // nominal/real bridge
      const apprec   = (pr.appreciation || 0);                 // real appreciation/yr (v1 default 0)
      const realPrice= Math.max(0, pr.value || 0) * Math.pow(1 + apprec, k);   // today's $ at sale
      const nomPrice = realPrice * f;                          // nominal at sale
      const commPct  = Math.max(0, Math.min(1, (pr.commissionPct == null ? 5 : pr.commissionPct) / 100));
      const nomComm  = nomPrice * commPct;
      const M        = pr.mortgage || {};
      const mStart   = (M.startAge != null ? M.startAge : curAge);
      const nomPayoff= mortgageBalanceRemaining(M.balance, M.rate || 0, M.termYears, saleAge - mStart);
      // Cost basis = entered purchasePrice. If none is entered, fall back to the
      // current value (→ zero modeled gain) rather than basis 0 (which would tax
      // the ENTIRE price as gain) — we don't invent a gain we can't substantiate.
      const basis    = (pr.purchasePrice != null && pr.purchasePrice > 0)
                         ? pr.purchasePrice : Math.max(0, pr.value || 0);
      const exclusion= Math.max(0, (ov.saleExclusion || 0));   // #5: §121 primary-residence (nominal)
      const nomGain  = Math.max(0, (nomPrice - nomComm) - basis - exclusion);
      const nomTax   = nomGain * capGainsRate;
      const nomNet   = Math.max(0, nomPrice - nomPayoff - nomComm - nomTax);
      assetSale = {
        age: saleAge, asset: saleAsset,
        netProceeds:  nomNet / f,                              // back to today's dollars
        grossReal:    realPrice,
        capGainsTax:  nomTax / f,
        commission:   nomComm / f,
        mortgagePayoff: nomPayoff / f
      };
    }
  }

  return {
    currentAge: pCurAge,
    retirementAge,
    people: timeline.people,
    simulationAvailable: timeline.completeForSimulation,
    simulationIssues: timeline.completeForSimulation
      ? Object.freeze([])
      : Object.freeze(['HOUSEHOLD_TIMELINE_INCOMPLETE']),
    incomeContractAvailable: incomeContractIssues.length === 0,
    incomeContractIssues: Object.freeze([...incomeContractIssues]),
    savingsAnnual,
    savingsSplit,
    horizonYears: horizon,
    accounts,  // structured account container
    projectionAccounts: Object.freeze(projectionAccounts.map(account => Object.freeze({ ...account }))),
    portfolio: {
      eq: profile.eq, fi: profile.fi,
      label: profile.label, alloc: profile.alloc,
      weights: profile.weights
    },
    returnAdj: (ov.returnAdj || 0) / 100,
    ss: ssBenefits,   // array of { amount, startAge } in the primary's age frame
    // Other income — normalized to an array of timed streams, each carrying its
    // own real growth and taxable share (both defaulting to the legacy flat-real,
    // fully-taxed behavior). Accepts a legacy single object too.
    otherIncome,
    pension:        { amount: pensionAmount, startAge: penStartAge, colaReal: penColaReal },
    rmdContract: Object.freeze({
      available: traditionalOwnerKnown
        && traditionalAccountRulesKnown
        && traditionalRmdAccountAttributionKnown
        && Boolean(traditionalRmdOwner)
        && traditionalRmdStartAge !== null,
      owner: traditionalRmdOwner,
      startAge: traditionalRmdStartAge,
      // Raw, pre-shock pre-tax dollars per owner. This is the year-0 assumed
      // prior-Dec-31 RMD basis: an initial scenario shock reduces the projection
      // sleeve but does not retroactively revise last year's statement. Unlike
      // byOwner[].balance it includes legacy-aggregate money.
      openingBalanceByOwner: Object.freeze({ ...rawTraditionalByOwner }),
      spousalRolloverAvailable,
      containsEmployerPlan: traditionalContainsEmployerPlan,
      focusRulesAvailable: traditionalFocusRulesKnown,
      planningAsOfYear,
      priorYearEndBalance: traditionalPriorYearEndBalanceAvailable
        ? traditionalPriorYearEndBalance
        : null,
      priorYearEndBalanceAvailable: traditionalPriorYearEndBalanceAvailable,
      byOwner: Object.freeze(Object.fromEntries(
        [...traditionalOwners].map(owner => {
          const detail = traditionalOwnerDetails[owner];
          const startAge = timeline.people[owner]?.rmdStartAge ?? null;
          return [owner, Object.freeze({
            available: detail.focusRulesAvailable
              && detail.priorYearEndBalanceAvailable
              && startAge !== null,
            balance: detail.balance,
            startAge,
            containsEmployerPlan: detail.containsEmployerPlan,
            focusRulesAvailable: detail.focusRulesAvailable,
            rmdAccountAttributionAvailable:
              detail.rmdAccountAttributionAvailable,
            priorYearEndBalance: detail.priorYearEndBalanceAvailable
              ? detail.priorYearEndBalance
              : null,
            priorYearEndBalanceAvailable: detail.priorYearEndBalanceAvailable,
          })];
        })
      )),
      issue: !traditionalOwnerKnown || !traditionalRmdOwner
        ? 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE'
        : !traditionalAccountRulesKnown
          ? 'TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE'
          : !traditionalRmdAccountAttributionKnown
            ? 'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
            : traditionalRmdStartAge === null
                ? 'RMD_BIRTH_COHORT_UNAVAILABLE'
                : null,
    }),
    ltc:            { amount: Math.max(0, (ltc.amount || 0) * (1 + (ov.ltcAdj || 0))), onsetAge: (ltc.onsetAge != null ? ltc.onsetAge : 999) },
    expenses: {
      // Absolute living spend is a narrow zero-base scenario seam. It avoids
      // representing a real dollar target as an impossible percent of $0.
      living:     hasLivingAnnual ? ov.livingAnnual : plan.expenses.living * spendMult,
      housing:    plan.expenses.housing    * spendMult,
      debt:       plan.expenses.debt       * spendMult,
      // Healthcare is NOT scaled by spendMult — it's not discretionary lifestyle
      // spending. It has its own healthcareRealGrowth rate applied in the sim loop.
      healthcare: plan.expenses.healthcare,
      // Discretionary, time-bounded extras — flex with the spending lever, flat-real.
      extra: (plan.expenses.extra || []).map(e => ({
        amount:   Math.max(0, e.amount || 0) * spendMult,
        startAge: (e.startAge != null ? e.startAge : 0),
        endAge:   (e.endAge   != null ? e.endAge   : 999)
      }))
    },
    // Recurring liabilities (e.g. a mortgage). NOT scaled by spendMult — a fixed
    // obligation isn't discretionary spending. colaReal mirrors the pension:
    // nominal escalator − inflation, so a 0%-COLA debt erodes in real terms.
    // Property mortgages are amortized to a fixed annual payment and APPENDED here
    // as ordinary fixed-nominal liabilities (payment from the loan's start age until
    // payoff = startAge + termYears), so they reuse the same tested cash-flow path.
    liabilities: [
      ...(plan.liabilities || []).map(L => ({
        amount:   Math.max(0, L.amount || 0),
        startAge: (L.startAge != null ? L.startAge : 0),
        endAge:   (L.endAge   != null ? L.endAge   : 999),
        colaReal: ((L.colaPct || 0) / 100) - LONGRUN_INFLATION
      })),
      ...(plan.properties || [])
        .map((pr, idx) => ({ pr, idx }))
        .filter(({pr}) => pr && pr.mortgage && (pr.mortgage.balance > 0) && (pr.mortgage.termYears > 0))
        .map(({pr, idx}) => {
          const M = pr.mortgage;
          const start = (M.startAge != null ? M.startAge : curAge);
          let endAge = start + M.termYears;          // payoff
          // If THIS property is sold before payoff, the mortgage is settled from
          // the proceeds. Payments stop the year BEFORE the sale (endAge = saleAge−1):
          // the remaining balance at the sale is the payoff we deduct from proceeds
          // (computed at saleAge−mStart years elapsed), so paying in the sale year too
          // would double-count that year's payment.
          if(idx === saleAsset && saleAge != null && saleAge <= endAge) endAge = saleAge - 1;
          return {
            amount:   annualMortgagePayment(M.balance, M.rate || 0, M.termYears),
            startAge: start,
            endAge,
            colaReal: -LONGRUN_INFLATION              // fixed-nominal payment erodes in real terms
          };
        })
    ],
    assetSale,   // resolved net-proceeds object, or null when no sale override
    healthcareMult: 1 + (ov.healthcareAdj || 0),
    healthcareRealGrowth: Math.max(0, plan.expenses.healthcareRealGrowth ?? 0.02),
    // Goals — normalized to an array of timed entries. A legacy
    // { vacation, property, gifts } object is converted to always-on entries.
    //
    // Two fields carry what used to live in plan.expenses:
    //   realGrowth        annual growth ABOVE general inflation, compounding
    //                     from the goal's start age. 0 = flat real dollars,
    //                     which is every ordinary goal. Healthcare uses 0.02.
    //   startsAtRetirement  bind the start age to the household's retirement
    //                     age instead of a fixed number. Resolved here, so it
    //                     follows the retireAge lever per scenario rather than
    //                     silently desyncing when a scenario retires earlier.
    goals: [
      ...(Array.isArray(plan.goals)
            ? plan.goals
            : Object.keys(plan.goals || {}).map(k => ({ name:k, amount:plan.goals[k], startAge:0, endAge:999 }))),
      // A plan saved before spending moved onto the Goals page still carries
      // plan.expenses. Fold it in here rather than trusting that the
      // persistence migration ran — an un-migrated plan must never silently
      // lose the spending the engine used to charge it.
      ...(plan.meta?.spendingSchemaVersion ? [] : (goalsFromLegacyExpenses(plan) || [])),
    ]
      // The absolute essentials override is a zero-base seam: it has to work on
      // a household whose essentials are still $0, which is precisely when no
      // Essentials goal exists yet. Give it something to land on.
      .concat(
        hasLivingAnnual
          && !(Array.isArray(plan.goals) && plan.goals.some(g => g?.system === 'essentials'))
          && !((goalsFromLegacyExpenses(plan) || []).some(g => g.system === 'essentials'))
          ? [{ id: 'system:essentials', system: 'essentials', name: 'Essentials',
               amount: 0, startsAtRetirement: true, endAge: 999,
               realGrowth: 0, flexesWithSpending: true }]
          : []
      )
      .map(g => {
        const entered = Math.max(0, g.amount || 0);
        // The spending lever scales DISCRETIONARY spending only. Healthcare was
        // explicitly exempt before this moved onto goals ("not discretionary
        // lifestyle spending"), and plan.goals never flexed at all — so the
        // flag defaults off and only the migrated expense channels carry it.
        const flexes = g.flexesWithSpending === true;
        // Absolute essentials override: a zero-base seam, so a real dollar
        // target isn't expressed as an impossible percentage of $0. Replaces
        // the amount rather than scaling it, exactly as livingAnnual did.
        const amount = (g.system === 'essentials' && hasLivingAnnual)
          ? ov.livingAnnual
          : (flexes ? entered * spendMult : entered);
        return {
          name:     g.name || '',
          id:       g.id,
          system:   g.system,
          amount,
          startAge: g.startsAtRetirement === true
                      ? retirementAge
                      : (g.startAge != null ? g.startAge : 0),
          endAge:   (g.endAge   != null ? g.endAge   : 999),
          realGrowth: Math.max(0, g.realGrowth || 0),
          startsAtRetirement: g.startsAtRetirement === true,
          flexesWithSpending: flexes,
          fundFromPortfolioBeforeRetirement: g.fundFromPortfolioBeforeRetirement === true,
        };
      }),
    // Tax rates split: ordinary income (for traditional withdrawals and SS),
    // and long-term capital gains (for taxable account gains).
    // The taxMult override scales both rates proportionally for stress testing.
    taxRates: {
      ordinary:     (plan.taxes.ordinary     * (1 + (ov.taxMult || 0))) / 100,
      capitalGains: (plan.taxes.capitalGains * (1 + (ov.taxMult || 0))) / 100
    },
    // Withdrawal strategy — drives account sequencing in fundGap
    withdrawalStrategy: plan.portfolio.withdrawalStrategy || 'taxable-first',
    // One-time cash shock injected at a specific year (fragility probe).
    lumpSum:     Math.max(0, ov.lumpSum || 0),
    lumpSumYear: (ov.lumpSumYear != null ? ov.lumpSumYear : -1),
    iterations,
    survival: {
      initialFilingStatus: plan.meta?.filingStatus ?? null,
      primaryEndAge,
      spouseEndAge,
    }
  };
}

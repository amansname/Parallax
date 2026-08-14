/* =============================================================================
   taxEngineAdapter.js — binding seam for the Tax-Aware Withdrawal module.

   THIS FILE CONTAINS NO TAX MATH AND NO TAX DATA.
   Pipeline: facts+levers → runEngineYearTax → annual1040Result + rule audits
   ========================================================================== */

const PATHS = {
  annual1040: '../../tax/annual1040.js',
  constants: '../../tax/core/constants.js',
  attribution: '../tax/attributeWithdrawalTaxByBucket.js',
  current1040: '../tax/buildCurrent1040Intake.js',
  irmaaPlanning: '../tax/buildIrmaaPlanningResult.js',
  engine: '../../../engine.js',
  portfolio: '../../household/resolvePortfolioAccounts.js',
};

let mods = null;
let loadError = null;

async function load() {
  if (mods) return mods;
  if (loadError) throw loadError;
  try {
    const [annual1040, constants, attribution, current1040, irmaaPlanning, engine, portfolio] = await Promise.all([
      import(PATHS.annual1040),
      import(PATHS.constants),
      import(PATHS.attribution),
      import(PATHS.current1040),
      import(PATHS.irmaaPlanning),
      import(PATHS.engine),
      import(PATHS.portfolio),
    ]);
    mods = {
      annual1040,
      constants,
      attribution,
      current1040,
      irmaaPlanning,
      engine,
      portfolio,
    };
    return mods;
  } catch (e) {
    loadError = e;
    throw e;
  }
}

export function loadFailure() {
  return loadError ? String(loadError.message || loadError) : null;
}

export const NOT_MODELED = Object.freeze({
  niit: 'NIIT_NOT_MODELED',
});

const REALIZED_GAIN_MAX = 500_000;

function toEngineLevers(levers = {}) {
  return {
    // Realized Gain is a tax-only input. The engine's taxableWithdrawal lever
    // represents account depletion, so it must remain zero here.
    taxableWithdrawal: 0,
    deferredWithdrawal: levers.deferredWithdrawal ?? 0,
    rothConversion: levers.rothConversion ?? 0,
    rothWithdrawal: levers.rothWithdrawal ?? 0,
    qcd: levers.qcd ?? 0,
  };
}

function toCashLevers(levers = {}) {
  return {
    ...toEngineLevers(levers),
    taxableWithdrawal: 0,
  };
}

function fromEngineLevers(levers = {}, realizedGain = 0) {
  return Object.freeze({
    realizedGain,
    deferredWithdrawal: levers.deferredWithdrawal ?? 0,
    rothConversion: levers.rothConversion ?? 0,
    rothWithdrawal: levers.rothWithdrawal ?? 0,
    qcd: levers.qcd ?? 0,
  });
}

function withoutPlannerBasisDependency(plan) {
  const taxable = plan?.portfolio?.accounts?.taxable;
  if (!taxable || typeof taxable !== 'object' || Array.isArray(taxable)) return plan;
  const basisPct = taxable.basisPct;
  if (typeof basisPct === 'number' && Number.isFinite(basisPct) && basisPct >= 0) {
    return plan;
  }
  return {
    ...plan,
    portfolio: {
      ...plan.portfolio,
      accounts: {
        ...plan.portfolio.accounts,
        taxable: {
          ...taxable,
          // The shared account fold requires this legacy field. Planner
          // Realized Gain never consumes it: taxable withdrawal is forced to
          // zero and the hypothetical gain is taxed directly. This ephemeral
          // sentinel therefore removes a metadata dependency without creating
          // a basis assumption or changing the saved household.
          basisPct: 0,
        },
      },
    },
  };
}

function taxableInvestmentBalance(plan, portfolio) {
  const fold = portfolio.resolvePortfolioAccounts(
    withoutPlannerBasisDependency(plan),
  );
  return fold.accounts.reduce((total, account) => {
    const isLegacyTaxable = account.sourceKind === 'legacy-base'
      && account.taxBucketGroup === 'taxable';
    const isTypedTaxableInvestment = account.sourceKind === 'typed-account'
      && account.classificationStatus === 'included'
      && account.taxBucketGroup === 'taxable'
      && account.taxCharacter === 'capital_asset';
    return isLegacyTaxable || isTypedTaxableInvestment
      ? total + account.balance
      : total;
  }, 0);
}

function realizedGainValue(levers = {}) {
  const value = levers.realizedGain ?? 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('realizedGain must be a finite nonnegative number');
  }
  return value;
}

function fromEngineAccountState(
  state,
  { realizedGain = 0, taxableBalance = 0 } = {},
) {
  if (!state) return state;
  const realizedGainMax = Math.min(REALIZED_GAIN_MAX, taxableBalance);
  const levers = fromEngineLevers(state.levers, realizedGain);
  const requestedLevers = fromEngineLevers(state.requestedLevers, realizedGain);
  const exceedsDisplayLimit = realizedGain > realizedGainMax;
  const limits = {
    ...state.limits,
    realizedGain: Object.freeze({
      pool: 'taxable',
      min: 0,
      max: realizedGainMax,
      available: true,
    }),
  };
  delete limits.taxableWithdrawal;
  const issues = exceedsDisplayLimit
    ? [...state.issues, Object.freeze({
        code: 'REALIZED_GAIN_LIMIT_EXCEEDED',
        available: realizedGainMax,
        requested: requestedLevers.realizedGain,
      })]
    : state.issues;
  return Object.freeze({
    ...state,
    valid: state.valid && !exceedsDisplayLimit,
    requestedLevers,
    levers,
    limits: Object.freeze(limits),
    issues: Object.freeze(issues),
    balances: Object.freeze({
      ...state.balances,
      taxable: taxableBalance,
    }),
    pools: Object.freeze({
      ...state.pools,
      taxable: Object.freeze({
        available: taxableBalance,
        used: 0,
        remaining: taxableBalance,
      }),
    }),
  });
}

function resolvePlannerAccountState(
  dependencies,
  plan,
  levers = {},
  facts = {},
  taxYear = null,
) {
  const realizedGain = realizedGainValue(levers);
  const taxableBalance = taxableInvestmentBalance(plan, dependencies.portfolio);
  const accountLimitPlan = withoutPlannerBasisDependency(plan);
  const state = dependencies.engine.resolveWithdrawalPlannerAccountState(
    accountLimitPlan,
    toEngineLevers(levers),
    accountReservations(plan, facts, taxYear),
  );
  return fromEngineAccountState(state, { realizedGain, taxableBalance });
}

function accountReservations(plan, facts = {}, taxYear = null) {
  return {
    traditionalTotal: Math.max(0, num(facts.iraDistributions) ?? 0),
    rmdEligibleCash: Math.max(0, num(facts.iraCashDistributions) ?? 0),
    traditionalByOwner: facts.iraDistributionsByOwner ?? null,
    rmdEligibleCashByOwner: facts.iraCashDistributionsByOwner ?? null,
    taxYear: Number.isInteger(taxYear)
      ? taxYear
      : (Number.isInteger(facts.taxYear)
        ? facts.taxYear
        : (Number.isInteger(plan?.meta?.planningAsOfYear)
          ? plan.meta.planningAsOfYear
          : 2026)),
  };
}

export function supportedYears() {
  return mods ? mods.annual1040.supportedTaxYears() : [];
}

export async function sleeveBalances(plan) {
  if (!plan) return { taxable: null, traditional: null, roth: null };
  const state = await withdrawalAccountState(plan);
  return state?.balances ?? { taxable: null, traditional: null, roth: null };
}

export async function withdrawalAccountState(plan, levers = {}, facts = {}) {
  if (!plan) return null;
  const dependencies = await load();
  return resolvePlannerAccountState(dependencies, plan, levers, facts);
}

export async function approveWithdrawalPlannerLeverChange(
  plan,
  currentLevers,
  changedLever,
  requestedValue,
  facts = {}
) {
  const dependencies = await load();
  realizedGainValue({ realizedGain: requestedValue });
  const currentRealizedGain = realizedGainValue(currentLevers);
  const taxableBalance = taxableInvestmentBalance(plan, dependencies.portfolio);
  const accountLimitPlan = withoutPlannerBasisDependency(plan);
  let approval;
  let approvedRealizedGain = currentRealizedGain;
  if (changedLever === 'realizedGain') {
    approvedRealizedGain = Math.min(
      requestedValue,
      REALIZED_GAIN_MAX,
      taxableBalance,
    );
    const state = dependencies.engine.resolveWithdrawalPlannerAccountState(
      accountLimitPlan,
      toEngineLevers(currentLevers),
      accountReservations(plan, facts),
    );
    approval = {
      approved: state.valid,
      levers: state.levers,
      state,
    };
  } else {
    approval = dependencies.engine.approveWithdrawalPlannerLeverChange(
      accountLimitPlan,
      toEngineLevers(currentLevers),
      changedLever,
      requestedValue,
      accountReservations(plan, facts),
    );
  }
  const state = fromEngineAccountState(approval.state, {
    realizedGain: approvedRealizedGain,
    taxableBalance,
  });
  const levers = fromEngineLevers(approval.levers, approvedRealizedGain);
  const approvedValue = levers[changedLever];
  return Object.freeze({
    ...approval,
    approved: approval.approved && state.valid,
    requestedValue,
    approvedValue,
    clamped: approvedValue !== requestedValue,
    levers,
    state,
  });
}

export async function householdIncome(plan, taxYear, options = {}) {
  const baseYear = options.baseYear
    ?? (Number.isInteger(plan?.meta?.planningAsOfYear)
      ? plan.meta.planningAsOfYear
      : 2026);
  const out = {
    available: false,
    filingStatus: null,
    socialSecurityBenefits: null,
    otherIncome: null,
    taxableOtherIncome: null,
    pensionAmount: null,
    age: null,
    ages: null,
    people: null,
    survivor: false,
    survivingOwner: null,
    taxYear: Number(taxYear),
  };
  if (!plan) return out;
  out.filingStatus = plan?.meta?.filingStatus ?? null;
  if (Number(taxYear) < Number(baseYear)) return out;
  try {
    const { current1040, engine } = await load();
    const resolved = engine.resolveInputs(withoutPlannerBasisDependency(plan), {});
    const income = { ...engine.householdIncomeAtYear(resolved, taxYear - baseYear) };
    const matchingCurrent1040Intake = Number(plan?.incomeTax?.current1040?.taxYear)
      === Number(taxYear)
      ? current1040.buildCurrent1040Intake(plan).intake
      : null;
    const matchingCurrent1040 = matchingCurrent1040Intake?.income;
    if (matchingCurrent1040 && typeof matchingCurrent1040 === 'object') {
      for (const field of [
        'taxableInterest',
        'taxExemptInterest',
        'otherIncome',
      ]) {
        const value = matchingCurrent1040[field];
        if (typeof value === 'number' && Number.isFinite(value)) income[field] = value;
      }
      if (typeof matchingCurrent1040.ordinaryDividends === 'number'
          && Number.isFinite(matchingCurrent1040.ordinaryDividends)
          && typeof matchingCurrent1040.qualifiedDividends === 'number'
          && Number.isFinite(matchingCurrent1040.qualifiedDividends)) {
        income.ordinaryDividends = matchingCurrent1040.ordinaryDividends;
        income.qualifiedDividends = matchingCurrent1040.qualifiedDividends;
      }
      const socialSecurityMode = matchingCurrent1040.socialSecurity?.mode;
      if (socialSecurityMode === 'calculate-taxable-benefits'
          && typeof matchingCurrent1040.socialSecurityBenefits === 'number'
          && Number.isFinite(matchingCurrent1040.socialSecurityBenefits)) {
        income.socialSecurityBenefits = matchingCurrent1040.socialSecurityBenefits;
      } else if (socialSecurityMode === 'supplied-form1040-lines'
          && typeof matchingCurrent1040.socialSecurityBenefits === 'number'
          && Number.isFinite(matchingCurrent1040.socialSecurityBenefits)
          && typeof matchingCurrent1040.taxableSS === 'number'
          && Number.isFinite(matchingCurrent1040.taxableSS)) {
        income.socialSecurityBenefits = matchingCurrent1040.socialSecurityBenefits;
        income.taxableSS = matchingCurrent1040.taxableSS;
      }
      if (typeof matchingCurrent1040.pensionAmount === 'number'
          && Number.isFinite(matchingCurrent1040.pensionAmount)
          && typeof matchingCurrent1040.taxablePensions === 'number'
          && Number.isFinite(matchingCurrent1040.taxablePensions)) {
        income.pensionAmount = matchingCurrent1040.pensionAmount;
        income.taxablePensions = matchingCurrent1040.taxablePensions;
      }
      const currentIraCash = num(matchingCurrent1040.iraDistributions);
      const currentTaxableIra = num(matchingCurrent1040.taxableIra);
      const currentRothConversion = num(matchingCurrent1040.rothConversion);
      if (currentIraCash !== null && currentIraCash >= 0
          && currentTaxableIra !== null && currentTaxableIra >= 0
          && currentRothConversion !== null && currentRothConversion >= 0) {
        const currentTraditionalTotal = currentIraCash + currentRothConversion;
        income.iraDistributions = currentTraditionalTotal;
        income.iraCashDistributions = currentIraCash;
        income.taxableIra = currentTaxableIra + currentRothConversion;
        income.rothConversion = currentRothConversion;

        const existingTraditionalByOwner = income.iraDistributionsByOwner;
        const existingCashByOwner = income.iraCashDistributionsByOwner;
        const existingOwnerFactsMatch = existingTraditionalByOwner
          && existingCashByOwner
          && ['client', 'spouse'].every(owner => (
            num(existingTraditionalByOwner[owner]) !== null
              && num(existingCashByOwner[owner]) !== null
          ))
          && Math.abs(
            existingTraditionalByOwner.client
              + existingTraditionalByOwner.spouse
              - currentTraditionalTotal
          ) <= 0.01
          && Math.abs(
            existingCashByOwner.client
              + existingCashByOwner.spouse
              - currentIraCash
          ) <= 0.01;
        if (income.filingStatus === 'single'
            || income.filingStatus === 'headOfHousehold') {
          const owner = income.survivingOwner === 'spouse' ? 'spouse' : 'client';
          income.iraDistributionsByOwner = { client: 0, spouse: 0 };
          income.iraCashDistributionsByOwner = { client: 0, spouse: 0 };
          income.iraDistributionsByOwner[owner] = currentTraditionalTotal;
          income.iraCashDistributionsByOwner[owner] = currentIraCash;
        } else if (!existingOwnerFactsMatch) {
          delete income.iraDistributionsByOwner;
          delete income.iraCashDistributionsByOwner;
        }
      }
      if (typeof matchingCurrent1040.otherIncome === 'number'
          && Number.isFinite(matchingCurrent1040.otherIncome)) {
        income.taxableOtherIncome = matchingCurrent1040.otherIncome;
      }
      const scheduleD = matchingCurrent1040Intake?.scheduleD;
      const currentLongTermGain = scheduleD?.mode === 'supplied-form1040-line7'
        ? scheduleD.amount
        : scheduleD?.netLongTermGainOrLoss;
      if (typeof currentLongTermGain === 'number'
          && Number.isFinite(currentLongTermGain)) {
        income.capitalGain = currentLongTermGain;
      }
      const grossOtherFields = [
        'taxableInterest',
        'taxExemptInterest',
        'ordinaryDividends',
        'iraDistributions',
        'pensionAmount',
        'otherIncome',
      ];
      income.grossOtherIncome = grossOtherFields.every(field => (
        typeof matchingCurrent1040[field] === 'number'
          && Number.isFinite(matchingCurrent1040[field])
      ))
        ? grossOtherFields.reduce(
            (sum, field) => sum + matchingCurrent1040[field],
            0,
          )
        : null;
    }
    return {
      ...income,
      available: income.available !== false,
      taxYear: Number(taxYear),
    };
  } catch (e) { /* plan cannot resolve */ }
  return out;
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sub = (a, b) => (num(a) === null || num(b) === null ? null : a - b);

function irmaaMfsLivingArrangement(facts){
  if(facts.filingStatus !== 'marriedFilingSeparately') return undefined;
  if(typeof facts.livedWithSpouse !== 'boolean') return undefined;
  return facts.livedWithSpouse
    ? 'lived-together-at-any-time'
    : 'lived-apart-all-year';
}

function medicareEligibleMembers(plan, facts, taxYear){
  const premiumYear = taxYear + 2;
  const planYear = Number.isInteger(plan?.meta?.planningAsOfYear)
    ? plan.meta.planningAsOfYear
    : 2026;
  const owners = ['client', ...(plan?.household?.spouse ? ['spouse'] : [])];
  let count = 0;
  let unknown = false;
  for(const owner of owners){
    const personFacts = facts.people?.[owner];
    if(personFacts?.alive === false) continue;
    if(personFacts && personFacts.alive !== true) unknown = true;
    const planPerson = owner === 'spouse'
      ? plan?.household?.spouse
      : plan?.household?.primary;
    const taxYearAge = num(personFacts?.age)
      ?? num(facts.ages?.[owner])
      ?? (num(planPerson?.currentAge) === null
        ? null
        : planPerson.currentAge + (taxYear - planYear));
    if(taxYearAge === null){
      unknown = true;
      continue;
    }
    const premiumAge = taxYearAge + (premiumYear - taxYear);
    const terminalAge = num(planPerson?.planEndAge);
    if(terminalAge !== null && premiumAge > terminalAge) continue;
    if(premiumAge >= 65) count += 1;
  }
  return unknown ? null : count;
}

function auditFor(audits, ruleId) {
  return (audits || []).find(a => a && a.ruleId === ruleId) || null;
}

function bandFrom(brackets, income) {
  if (!Array.isArray(brackets) || num(income) === null) return { floor: null, ceiling: null, rate: null, nextRate: null };
  let floor = 0;
  for (let i = 0; i < brackets.length; i++) {
    const { rate, upTo } = brackets[i];
    if (income < upTo || i === brackets.length - 1) {
      return { floor, ceiling: Number.isFinite(upTo) ? upTo : null, rate, nextRate: brackets[i + 1]?.rate ?? null };
    }
    floor = upTo;
  }
  return { floor: null, ceiling: null, rate: null, nextRate: null };
}

function confirmedBirthDate(plan, owner) {
  const fact = plan?.taxProfiles?.[owner]?.birthDate;
  return fact?.status === 'confirmed'
    && typeof fact.value === 'string'
    && fact.value.trim()
    ? fact.value
    : null;
}

function baseAndAgeTaxFacts(plan, facts, taxYear) {
  const current1040 = plan?.incomeTax?.current1040;
  const filingStatus = facts.filingStatus;
  const expectedModeledTaxpayer = filingStatus === 'marriedFilingJointly'
    ? 'jointReturn'
    : (filingStatus === 'single' || filingStatus === 'headOfHousehold'
      ? 'client'
      : null);
  const currentYearMatches = Number(current1040?.taxYear) === Number(taxYear);
  const survivorMatches = facts.survivingOwner == null
    || current1040?.survivingOwner === facts.survivingOwner;
  const currentIdentityMatches = Boolean(
    current1040
      && currentYearMatches
      && plan?.meta?.filingStatus === filingStatus
      && current1040?.returnScope?.modeledTaxpayer === expectedModeledTaxpayer
      && survivorMatches
  );
  const coverageIssues = current1040 && currentYearMatches && !currentIdentityMatches
    ? [{ code: 'CURRENT_1040_DEDUCTION_IDENTITY_MISMATCH' }]
    : [];
  const currentDeductions = currentIdentityMatches
    && current1040?.deductions
    && typeof current1040.deductions === 'object'
    ? current1040.deductions
    : null;
  const passThrough = currentIdentityMatches
    && current1040?.passThrough
    && typeof current1040.passThrough === 'object'
    ? { ...current1040.passThrough }
    : null;
  const standardCompanions = {};
  if (currentDeductions
      && Object.prototype.hasOwnProperty.call(currentDeductions, 'qbi')) {
    standardCompanions.qbi = currentDeductions.qbi;
  }
  if (currentDeductions?.schedule1A
      && typeof currentDeductions.schedule1A === 'object') {
    standardCompanions.schedule1A = { ...currentDeductions.schedule1A };
  }
  const usesSuppliedDeduction = currentDeductions?.source === 'supplied-line12e';
  const usesItemizedDeduction = currentDeductions?.method === 'itemized'
    || currentDeductions?.useStandard === false
    || currentDeductions?.itemizedAmount !== undefined;
  if (usesSuppliedDeduction || usesItemizedDeduction) {
    return {
      deductions: { ...currentDeductions },
      returnScope: { ...current1040.returnScope },
      taxpayers: current1040.taxpayers
        ? structuredClone(current1040.taxpayers)
        : null,
      passThrough,
      coverage: {
        source: 'household-current-1040',
        complete: true,
        missingBirthDateOwners: [],
        appliedScope: usesSuppliedDeduction ? 'supplied-line12e' : 'itemized',
        issues: coverageIssues,
      },
    };
  }

  const source = currentDeductions
    ? 'household-current-1040'
    : 'planner-standard-default';
  let requiredOwners = [];
  if (filingStatus === 'marriedFilingJointly') {
    requiredOwners = ['client', 'spouse'];
  } else if (filingStatus === 'single' || filingStatus === 'headOfHousehold') {
    requiredOwners = [facts.survivingOwner === 'spouse' ? 'spouse' : 'client'];
  }
  const birthDates = Object.fromEntries(
    requiredOwners.map(owner => [owner, confirmedBirthDate(plan, owner)])
  );
  const missingBirthDateOwners = requiredOwners
    .filter(owner => !birthDates[owner]);
  const complete = requiredOwners.length > 0
    && missingBirthDateOwners.length === 0;
  if (!complete) {
    return {
      deductions: { useStandard: true, ...standardCompanions },
      returnScope: null,
      taxpayers: null,
      passThrough,
      coverage: {
        source,
        complete: false,
        missingBirthDateOwners,
        appliedScope: 'base-only',
        issues: coverageIssues,
      },
    };
  }
  if (filingStatus === 'marriedFilingJointly') {
    return {
      deductions: {
        source: 'calculated', method: 'standard', standardScope: 'base-and-age',
        ...standardCompanions,
      },
      returnScope: { modeledTaxpayer: 'jointReturn' },
      taxpayers: {
        client: { birthDate: birthDates.client },
        spouse: { birthDate: birthDates.spouse },
      },
      passThrough,
      coverage: {
        source,
        complete: true,
        missingBirthDateOwners: [],
        appliedScope: 'base-and-age',
        issues: coverageIssues,
      },
    };
  }
  const sourceOwner = requiredOwners[0];
  return {
    deductions: {
      source: 'calculated', method: 'standard', standardScope: 'base-and-age',
      ...standardCompanions,
    },
    returnScope: { modeledTaxpayer: 'client' },
    taxpayers: { client: { birthDate: birthDates[sourceOwner] } },
    passThrough,
    coverage: {
      source,
      complete: true,
      missingBirthDateOwners: [],
      appliedScope: 'base-and-age',
      issues: coverageIssues,
    },
  };
}

function toYearFacts({ facts, levers, taxYear, deductionContract }) {
  const income = {};
  const put = (k, v) => { if (num(v) !== null && v !== 0) income[k] = v; };
  put('wages', facts.wages);
  put('taxableInterest', facts.taxableInterest);
  put('taxExemptInterest', facts.taxExemptInterest);
  put('ordinaryDividends', facts.ordinaryDividends);
  put('qualifiedDividends', facts.qualifiedDividends);
  put('socialSecurityBenefits', facts.socialSecurityBenefits);
  put('pensionAmount', facts.pensionAmount);
  put('otherIncome', num(facts.taxableOtherIncome) === null
    ? facts.otherIncome
    : facts.taxableOtherIncome);

  const fixedIraGross = Math.max(0, num(facts.iraDistributions) ?? 0);
  const plannerIraGross = Math.max(
    0,
    (levers.deferredWithdrawal || 0) + (levers.rothConversion || 0)
  );
  const iraGross = fixedIraGross + plannerIraGross;
  put('iraDistributions', iraGross);

  const baselineCapitalGain = num(facts.capitalGain);
  const realizedGain = num(levers.realizedGain) ?? 0;
  const capitalGain = (baselineCapitalGain ?? 0) + realizedGain;

  const resolved = {};
  if (iraGross > 0) {
    const fixedTaxableIra = num(facts.taxableIra) ?? 0;
    resolved.taxableIra = fixedTaxableIra + plannerIraGross;
  }
  if (num(facts.pensionAmount) !== null || num(facts.taxablePensions) !== null) {
    resolved.taxablePensions = num(facts.taxablePensions) ?? 0;
  }
  if (num(facts.taxableSS) !== null) resolved.taxableSS = facts.taxableSS;

  const out = {
    filingStatus: facts.filingStatus,
    taxYear,
    income,
    deductions: deductionContract.deductions,
  };
  out.scheduleD = {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: capitalGain,
  };
  if (deductionContract.returnScope) {
    out.returnScope = deductionContract.returnScope;
  }
  if (deductionContract.taxpayers) {
    out.taxpayers = deductionContract.taxpayers;
  }
  if (deductionContract.passThrough) {
    out.passThrough = { ...deductionContract.passThrough };
  }
  if (facts.filingStatus === 'marriedFilingSeparately'
      && typeof facts.livedWithSpouse === 'boolean') {
    out.socialSecurityWorksheet = { livedWithSpouse: facts.livedWithSpouse };
  }
  if (Object.keys(resolved).length) out.resolved = resolved;
  return out;
}

export async function evaluateYear({ plan, taxYear, facts, levers }) {
  const dependencies = await load();
  const { annual1040, constants, engine, irmaaPlanning } = dependencies;
  if (!facts || !facts.filingStatus) return null;

  let accountState = null;
  const accountIssues = [];
  try {
    accountState = resolvePlannerAccountState(
      dependencies,
      plan,
      levers,
      facts,
      taxYear,
    );
  } catch {
    accountIssues.push({ code: 'WITHDRAWAL_ACCOUNT_STATE_UNAVAILABLE' });
  }
  const requestedAccountUse = [
    levers?.realizedGain,
    levers?.deferredWithdrawal,
    levers?.rothConversion,
    levers?.rothWithdrawal,
    levers?.qcd,
  ].reduce((sum, value) => sum + (num(value) ?? 0), 0);
  if (!accountState && requestedAccountUse > 0) {
    return {
      code: 'WITHDRAWAL_ACCOUNT_STATE_UNAVAILABLE',
      accountState,
      accountIssues,
    };
  }
  if (accountState && !accountState.valid) {
    return {
      code: 'WITHDRAWAL_ACCOUNT_LIMIT_EXCEEDED',
      accountState,
      accountIssues,
    };
  }
  const effectiveLevers = accountState?.levers ?? levers;

  const context = annual1040.buildDefaultTaxContext({ taxYear, runId: 'tax_aware_withdrawal', scenarioId: 'focus_year' });
  const lawVersion = context.lawVersion;
  const fs = facts.filingStatus;
  const hasHouseholdPeople = facts.people
    && typeof facts.people === 'object';
  const bothHouseholdMembersAlive = hasHouseholdPeople
    && facts.people.client?.alive === true
    && facts.people.spouse?.alive === true;
  const filingStatusHouseholdMismatch = hasHouseholdPeople && (
    ((fs === 'single' || fs === 'headOfHousehold') && bothHouseholdMembersAlive)
    || ((fs === 'marriedFilingJointly' || fs === 'marriedFilingSeparately')
      && !bothHouseholdMembersAlive)
  );
  let unavailableCode = null;
  if (facts.available === false) {
    unavailableCode = 'HOUSEHOLD_INCOME_UNAVAILABLE';
  } else if (filingStatusHouseholdMismatch) {
    unavailableCode = 'FILING_STATUS_HOUSEHOLD_MISMATCH';
  } else if (fs === 'marriedFilingSeparately' && plan?.household?.spouse) {
    unavailableCode = 'MFS_RETURN_TAXPAYER_UNATTRIBUTED';
  } else if ((num(facts.pensionAmount) ?? 0) > 0
      && (!Object.prototype.hasOwnProperty.call(facts, 'taxablePensions')
        || num(facts.taxablePensions) === null)) {
    unavailableCode = 'TAXABLE_PENSION_PORTION_MISSING';
  } else if ((num(facts.iraDistributions) ?? 0) > 0
      && (!Object.prototype.hasOwnProperty.call(facts, 'taxableIra')
        || num(facts.taxableIra) === null)) {
    unavailableCode = 'TAXABLE_IRA_PORTION_MISSING';
  } else if (accountState?.rmd?.status === 'unavailable') {
    unavailableCode = accountState.rmd.issue || 'RMD_CONTRACT_UNAVAILABLE';
  }
  if (unavailableCode) {
    const cash = engine.buildWithdrawalPlannerCashContract(toCashLevers(effectiveLevers), null);
    return {
      code: unavailableCode,
      lawVersion,
      taxYear,
      baseline: { ordinaryIncome: null, provisionalIncome: null },
      totals: {
        ordinaryIncome: null,
        qualifiedIncome: null,
        agi: null,
        magi: null,
        taxableIncome: null,
        federalTax: null,
        marginalRate: null,
        effectiveRate: null,
        netCash: null,
      },
      thresholdTaxDollars: {
        ordinaryIncomeTax: null,
        preferentialIncomeTax: null,
        irmaaPremium: null,
        socialSecurityIncrementalModeledFederalIncomeTax: null,
      },
      modeledFederalIncomeTax: {
        baseline: null,
        selected: null,
        incremental: null,
        taxTotalScope: null,
      },
      comparisonIssues: [{ code: unavailableCode }],
      deductionCoverage: null,
      rmd: accountState?.rmd ?? null,
      accountState,
      accountIssues,
      cash,
    };
  }

  const zeroLevers = {
    realizedGain: 0,
    deferredWithdrawal: 0,
    rothConversion: 0,
    rothWithdrawal: 0,
    qcd: 0,
  };
  const deductionContract = baseAndAgeTaxFacts(plan, facts, taxYear);
  const selectedFacts = toYearFacts({
    facts, levers: effectiveLevers, taxYear, deductionContract,
  });
  const baselineFacts = toYearFacts({
    facts, levers: zeroLevers, taxYear, deductionContract,
  });
  const withoutSocialSecurityFacts = toYearFacts({
    facts: { ...facts, socialSecurityBenefits: 0 },
    levers: effectiveLevers,
    taxYear,
    deductionContract,
  });
  let analysis;
  try {
    analysis = annual1040.runWithdrawalPlannerTaxAnalysis({
      selectedFacts,
      baselineFacts,
      withoutSocialSecurityFacts,
      context,
    });
  } catch (e) {
    return { error: String(e.message || e), accountState };
  }
  const main = analysis.selectedRun;

  const res = main?.annual1040Result ?? {};
  const sum = res.federalSummary ?? {};
  const audits = main?.audits ?? [];

  const ordAudit = auditFor(audits, 'FED_ORDINARY_INCOME_TAX');
  const gainAudit = auditFor(audits, 'FED_CAPITAL_GAINS_STACKING');
  const ssAudit = auditFor(audits, 'FED_TAXABLE_SOCIAL_SECURITY');

  const taxableOrdinary = num(ordAudit?.inputsUsed?.taxableOrdinaryIncome);
  const brackets = constants.ORDINARY_BRACKETS?.[lawVersion]?.[fs];
  const band = bandFrom(brackets, taxableOrdinary ?? 0);
  const cgT = constants.CAPITAL_GAINS_THRESHOLDS?.[lawVersion]?.[fs] || {};
  const preferential = num(sum.preferentialIncome);

  const zero = analysis.baselineRun;
  const zeroSummary = zero?.annual1040Result?.federalSummary ?? {};
  const zeroOrd = num(auditFor(zero?.audits, 'FED_ORDINARY_INCOME_TAX')?.inputsUsed?.taxableOrdinaryIncome);
  const zeroSsSteps = auditFor(zero?.audits, 'FED_TAXABLE_SOCIAL_SECURITY')?.calculationSteps || [];
  const zeroStep = line => {
    const st = zeroSsSteps.find(x => x && x.line === line);
    return st ? num(st.amount) : null;
  };
  const zeroProvisional = zeroStep('worksheetIncome') ?? zeroStep('combinedIncomeBeforeAdjustments');

  const cash = engine.buildWithdrawalPlannerCashContract(
    toCashLevers(effectiveLevers),
    analysis.modeledFederalIncomeTax.incremental
  );

  const form = main?.result?.form1040 || {};
  const ssBenefit = num(form.line6a?.value) ?? num(facts.socialSecurityBenefits);
  const ssTaxable = num(form.line6b?.value);
  const ssSteps = ssAudit?.calculationSteps || [];
  const stepAmount = line => {
    const st = ssSteps.find(x => x && x.line === line);
    return st ? num(st.amount) : null;
  };
  const ssProvisional = stepAmount('worksheetIncome') ?? stepAmount('combinedIncomeBeforeAdjustments');
  const ssKey = fs === 'marriedFilingSeparately'
    ? (typeof facts.livedWithSpouse === 'boolean'
      ? (facts.livedWithSpouse
        ? 'marriedFilingSeparatelyLivedTogether'
        : 'marriedFilingSeparatelyLivedApart')
      : null)
    : fs;
  const ssT = constants.SOCIAL_SECURITY_TAXATION_THRESHOLDS?.[lawVersion]?.[ssKey] || {};
  const ssTier1 = num(ssT.baseAmount);
  const ssAdditional = num(ssT.additionalAmount);
  const ssTier2 = ssTier1 === null || ssAdditional === null ? null : ssTier1 + ssAdditional;
  const ssNextAt = ssProvisional === null ? ssTier1
    : (ssProvisional < ssTier1 ? ssTier1 : (ssTier2 !== null && ssProvisional < ssTier2 ? ssTier2 : null));

  const eligibleMembers = medicareEligibleMembers(plan, facts, taxYear);
  const mfsLivingArrangement = irmaaMfsLivingArrangement(facts);
  const irmaaCommon = {
    taxExemptInterest: facts.taxExemptInterest ?? 0,
    uncommonAddbacks:
      plan?.incomeTax?.irmaa?.uncommonAddbacksByTaxYear?.[taxYear] ?? 0,
    filingStatus: fs,
    mfsLivingArrangement,
    taxYear,
    premiumYear: taxYear + 2,
    eligibleMembers,
    context,
  };
  const selectedIrmaa = irmaaPlanning.buildIrmaaPlanningResult({
    ...irmaaCommon,
    adjustedGrossIncome: num(sum.adjustedGrossIncome),
  });
  const baselineIrmaa = irmaaPlanning.buildIrmaaPlanningResult({
    ...irmaaCommon,
    adjustedGrossIncome: num(zeroSummary.adjustedGrossIncome),
  });
  const selectedIrmaaAnnual = selectedIrmaa?.annualHouseholdAdjustment ?? null;
  const baselineIrmaaAnnual = baselineIrmaa?.annualHouseholdAdjustment ?? null;
  const incrementalIrmaaAnnual = selectedIrmaaAnnual === null
      || baselineIrmaaAnnual === null
    ? null
    : selectedIrmaaAnnual - baselineIrmaaAnnual;
  const irmaaResult = selectedIrmaa
    ? Object.freeze({
      ...selectedIrmaa,
      baselineMagi: baselineIrmaa?.magi ?? null,
      baselineAnnualHouseholdAdjustment: baselineIrmaaAnnual,
      incrementalAnnualHouseholdAdjustment: incrementalIrmaaAnnual,
    })
    : null;
  const thresholdTaxDollars = {
    ...analysis.thresholdTaxDollars,
    irmaaPremium: selectedIrmaaAnnual,
  };

  return {
    lawVersion,
    taxYear: res.taxYear ?? taxYear,
    baseline: { ordinaryIncome: zeroOrd, provisionalIncome: zeroProvisional },
    totals: {
      ordinaryIncome: taxableOrdinary,
      qualifiedIncome: preferential,
      agi: num(sum.adjustedGrossIncome),
      magi: selectedIrmaa?.magi ?? null,
      taxableIncome: num(sum.taxableIncome),
      federalTax: num(sum.federalTaxLiability),
      marginalRate: num(sum.marginalRate),
      effectiveRate: num(sum.effectiveRate),
      netCash: cash.netAfterIncrementalModeledFederalIncomeTax,
    },
    ordinary: {
      rate: num(sum.marginalRate) ?? band.rate, ceiling: band.ceiling,
      income: taxableOrdinary, roomToNext: sub(band.ceiling, taxableOrdinary),
    },
    ltcg: {
      rate: num(gainAudit?.calculationSteps?.[gainAudit.calculationSteps.length - 1]?.rate),
      zeroCeiling: num(cgT.zeroRateMax),
      stackedOn: taxableOrdinary,
      stackTop: taxableOrdinary === null || preferential === null ? null : taxableOrdinary + preferential,
      roomToZeroCeiling: taxableOrdinary === null || num(cgT.zeroRateMax) === null
        ? null
        : Math.max(0, cgT.zeroRateMax - taxableOrdinary - (preferential || 0)),
      gains: preferential,
    },
    socialSecurity: {
      benefit: ssBenefit,
      taxableAmount: ssTaxable,
      taxablePct: ssBenefit && ssTaxable !== null ? ssTaxable / ssBenefit : null,
      provisionalIncome: ssProvisional,
      nextTierAt: ssNextAt,
      roomToNext: sub(ssNextAt, ssProvisional),
    },
    irmaa: irmaaResult,
    niit: { scope: NOT_MODELED.niit },
    rmd: accountState?.rmd
      ? {
        ...accountState.rmd,
        satisfied: accountState.rmd.required === null
          || accountState.rmd.remaining === null
          ? null
          : accountState.rmd.required - accountState.rmd.remaining,
      }
      : null,
    ladders: {
      ordinary: (Array.isArray(brackets) ? brackets : []).map(b => ({
        rate: b.rate, upTo: Number.isFinite(b.upTo) ? b.upTo : null,
      })),
      ltcg: {
        zeroRateMax: num(cgT.zeroRateMax),
        fifteenRateMax: num(cgT.fifteenRateMax),
        rates: analysis.thresholdRates?.ltcg ?? null,
      },
      socialSecurity: {
        tier1: ssTier1,
        tier2: ssTier2,
        rates: analysis.thresholdRates?.socialSecurity ?? null,
      },
      irmaa: selectedIrmaa?.ladder ?? null,
    },
    coverage: {
      unsupportedIntentional: res.unsupportedIntentional || [],
      warnings: res.warnings || [],
    },
    comparisonIssues: analysis.comparisonIssues,
    deductionCoverage: deductionContract.coverage,
    accountState,
    accountIssues,
    thresholdTaxDollars,
    modeledFederalIncomeTax: analysis.modeledFederalIncomeTax,
    cash,
  };
}

export async function attributeSleeves({ plan, taxYear, facts, levers }) {
  const dependencies = await load();
  const { annual1040, attribution } = dependencies;
  if (!facts || !facts.filingStatus) return null;
  let accountState = null;
  try {
    accountState = resolvePlannerAccountState(
      dependencies,
      plan,
      levers,
      facts,
      taxYear,
    );
  } catch {
    return { code: 'WITHDRAWAL_ACCOUNT_STATE_UNAVAILABLE', accountState: null };
  }
  if (!accountState.valid) {
    return {
      code: 'WITHDRAWAL_ACCOUNT_LIMIT_EXCEEDED',
      accountState,
    };
  }
  if (accountState.rmd?.status === 'unavailable') {
    return {
      code: accountState.rmd.issue || 'RMD_CONTRACT_UNAVAILABLE',
      accountState,
    };
  }
  const effectiveLevers = accountState.levers;
  const context = annual1040.buildDefaultTaxContext({
    taxYear, runId: 'tax_aware_withdrawal', scenarioId: 'sleeve_attribution',
  });
  const deductionContract = baseAndAgeTaxFacts(plan, facts, taxYear);

  const held = {
    rothConversion: effectiveLevers.rothConversion || 0,
    qcd: effectiveLevers.qcd || 0,
  };
  const amounts = {
    taxable: Math.max(0, effectiveLevers.realizedGain || 0),
    traditional: Math.max(0, effectiveLevers.deferredWithdrawal || 0),
    roth: Math.max(0, effectiveLevers.rothWithdrawal || 0),
  };

  const taxFor = buckets => {
    const lv = {
      ...held,
      realizedGain: buckets.includes('taxable') ? amounts.taxable : 0,
      deferredWithdrawal: buckets.includes('traditional') ? amounts.traditional : 0,
      rothWithdrawal: buckets.includes('roth') ? amounts.roth : 0,
    };
    const out = annual1040.runEngineYearTax(
      toYearFacts({ facts, levers: lv, taxYear, deductionContract }),
      context
    );
    const tax = num(out?.annual1040Result?.federalSummary?.federalTaxLiability);
    if (tax === null) throw new Error('Modeled federal tax is unavailable for this coalition');
    return tax;
  };

  try {
    const coalitionTaxes = {};
    for (const c of attribution.WITHDRAWAL_TAX_COALITIONS) coalitionTaxes[c.id] = taxFor(c.buckets);
    const att = attribution.attributeWithdrawalTaxByBucket(coalitionTaxes);
    return {
      method: att.method,
      baselineTax: att.baselineTax,
      incrementalTax: att.incrementalTax,
      byBucket: att.displayByBucket,
      exactByBucket: att.byBucket,
      residual: att.displayReconciliation.difference,
      withdrawals: amounts,
      heldFixed: held,
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

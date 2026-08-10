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
  engine: '../../../engine.js',
  taxableBasis: '../../household/resolveTaxableStartingBasis.js',
};

let mods = null;
let loadError = null;

async function load() {
  if (mods) return mods;
  if (loadError) throw loadError;
  try {
    const [annual1040, constants, attribution, current1040, engine, taxableBasis] = await Promise.all([
      import(PATHS.annual1040),
      import(PATHS.constants),
      import(PATHS.attribution),
      import(PATHS.current1040),
      import(PATHS.engine),
      import(PATHS.taxableBasis),
    ]);
    mods = { annual1040, constants, attribution, current1040, engine, taxableBasis };
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
  irmaa: 'No IRMAA table in src/tax/',
  niit: 'NIIT_NOT_MODELED',
});

const READY_TAXABLE_BASIS_STATUSES = new Set([
  'confirmed',
  'legacy-assumption',
  'not-applicable',
]);

const WITHDRAWAL_PLANNER_BASIS_ASSUMPTION_CODES = new Set([
  'TAXABLE_BASIS_UNKNOWN',
]);

const WITHDRAWAL_PLANNER_PRESERVED_BASIS_GAP_CODES = new Set([
  'TAXABLE_BASIS_ASSUMED',
  'LEGACY_TAXABLE_BASIS_ASSUMPTION',
]);

const WITHDRAWAL_PLANNER_50_50_ASSUMPTION = Object.freeze({
  code: 'WITHDRAWAL_PLANNER_TAXABLE_50_50_ASSUMPTION',
  principalFraction: 0.5,
  gainFraction: 0.5,
});

const TAXABLE_BASIS_LOSS_TREATMENT_PENDING = 'TAXABLE_LOSS_TREATMENT_PENDING';

function taxableBasisContract(plan, taxableBasis) {
  const resolution = taxableBasis.resolveTaxableStartingBasis(plan);
  const canonicalReady = READY_TAXABLE_BASIS_STATUSES.has(resolution.status);
  const plannerAssumptionGaps = resolution.gaps.filter(gap => (
    WITHDRAWAL_PLANNER_BASIS_ASSUMPTION_CODES.has(gap.code)
  ));
  const plannerCompatibleGaps = resolution.gaps.filter(gap => (
    WITHDRAWAL_PLANNER_BASIS_ASSUMPTION_CODES.has(gap.code)
      || WITHDRAWAL_PLANNER_PRESERVED_BASIS_GAP_CODES.has(gap.code)
  ));
  const usesPlannerAssumption = !canonicalReady
    && resolution.taxableBalance > 0
    && plannerAssumptionGaps.length > 0
    && plannerCompatibleGaps.length === resolution.gaps.length;
  const unknownBasisAccountIds = new Set(
    plannerAssumptionGaps.map(gap => gap.accountId).filter(Boolean)
  );
  const preservedLegacyAccountIds = new Set(
    resolution.gaps
      .filter(gap => WITHDRAWAL_PLANNER_PRESERVED_BASIS_GAP_CODES.has(gap.code))
      .map(gap => gap.accountId)
      .filter(Boolean)
  );
  const legacyBasisFraction = resolution.taxableBalance > 0
    ? resolution.legacyFallbackBasis / resolution.taxableBalance
    : null;
  const plannerAppliedBasisCandidate = usesPlannerAssumption
    ? resolution.records.reduce((total, record) => {
        if (unknownBasisAccountIds.has(record.accountId)) {
          return total
            + record.balance * WITHDRAWAL_PLANNER_50_50_ASSUMPTION.principalFraction;
        }
        const recordedBasis = num(record.basisAmount);
        if (recordedBasis !== null) return total + recordedBasis;
        if (preservedLegacyAccountIds.has(record.accountId) && legacyBasisFraction !== null) {
          return total + record.balance * legacyBasisFraction;
        }
        return total;
      }, 0)
    : null;
  const hasConfirmedLossEvidence = resolution.records.some(record => (
    record.basisStatus === 'confirmed'
      && num(record.basisAmount) !== null
      && record.basisAmount > record.balance
  ));
  const hasUnresolvedConfirmedLoss = hasConfirmedLossEvidence
    && !canonicalReady;
  const lossTreatmentPending = resolution.gaps.some(gap => (
    gap.code === TAXABLE_BASIS_LOSS_TREATMENT_PENDING
  )) || hasUnresolvedConfirmedLoss;
  const unavailableCode = lossTreatmentPending
    ? TAXABLE_BASIS_LOSS_TREATMENT_PENDING
    : null;
  const appliesPlannerAssumption = plannerAppliedBasisCandidate !== null
    && !unavailableCode;
  const plannerAppliedBasis = appliesPlannerAssumption
    ? plannerAppliedBasisCandidate
    : null;
  const appliedBasis = unavailableCode
    ? null
    : plannerAppliedBasis ?? num(resolution.appliedBasis);
  const gainFraction = resolution.taxableBalance > 0 && appliedBasis !== null
    ? 1 - (appliedBasis / resolution.taxableBalance)
    : null;
  return Object.freeze({
    gainFraction,
    resolution,
    assumption: appliesPlannerAssumption ? WITHDRAWAL_PLANNER_50_50_ASSUMPTION : null,
    unavailableCode,
  });
}

function applyTaxableBasisContract(state, basisContract) {
  if (!state) return state;
  const next = {
    ...state,
    taxableBasis: Object.freeze({
      status: basisContract.resolution.status,
      appliedMode: basisContract.unavailableCode
        ? 'unavailable'
        : basisContract.assumption
          ? 'withdrawal-planner-50-50-assumption'
          : basisContract.resolution.appliedMode,
      gainFraction: basisContract.gainFraction,
      assumption: basisContract.assumption,
      gaps: basisContract.resolution.gaps,
      issue: basisContract.unavailableCode,
    }),
  };
  if (!basisContract.unavailableCode) return Object.freeze(next);
  const requestedTaxableUse = num(state.levers?.taxableWithdrawal) ?? 0;
  const normalizedLevers = requestedTaxableUse > 0
    ? Object.freeze({ ...state.levers, taxableWithdrawal: 0 })
    : state.levers;
  const issues = requestedTaxableUse > 0
    ? Object.freeze([
        ...(state.issues ?? []),
        Object.freeze({
          code: basisContract.unavailableCode,
          lever: 'taxableWithdrawal',
          requested: requestedTaxableUse,
        }),
      ])
    : state.issues;
  return Object.freeze({
    ...next,
    valid: state.valid && requestedTaxableUse === 0,
    levers: normalizedLevers,
    limits: Object.freeze({
      ...state.limits,
      taxableWithdrawal: Object.freeze({
        ...state.limits.taxableWithdrawal,
        max: null,
        available: false,
        reason: basisContract.unavailableCode,
      }),
    }),
    pools: Object.freeze({
      ...state.pools,
      taxable: Object.freeze({
        ...state.pools.taxable,
        available: null,
        used: 0,
        remaining: null,
      }),
    }),
    issues,
    sourceIssues: Object.freeze([
      ...new Set([...(state.sourceIssues ?? []), basisContract.unavailableCode]),
    ]),
  });
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
  const { engine, taxableBasis } = await load();
  const basisContract = taxableBasisContract(plan, taxableBasis);
  const state = engine.resolveWithdrawalPlannerAccountState(plan, levers, {
    traditionalTotal: Math.max(0, num(facts?.iraDistributions) ?? 0),
    rmdEligibleCash: Math.max(0, num(facts?.iraCashDistributions) ?? 0),
    traditionalByOwner: facts?.iraDistributionsByOwner ?? null,
    rmdEligibleCashByOwner: facts?.iraCashDistributionsByOwner ?? null,
    taxYear: Number.isInteger(facts?.taxYear)
      ? facts.taxYear
      : (Number.isInteger(plan?.meta?.planningAsOfYear)
        ? plan.meta.planningAsOfYear
        : 2026),
  });
  return applyTaxableBasisContract(state, basisContract);
}

export async function approveWithdrawalPlannerLeverChange(
  plan,
  currentLevers,
  changedLever,
  requestedValue,
  facts = {}
) {
  const { engine, taxableBasis } = await load();
  const basisContract = taxableBasisContract(plan, taxableBasis);
  const options = {
    traditionalTotal: Math.max(0, num(facts?.iraDistributions) ?? 0),
    rmdEligibleCash: Math.max(0, num(facts?.iraCashDistributions) ?? 0),
    traditionalByOwner: facts?.iraDistributionsByOwner ?? null,
    rmdEligibleCashByOwner: facts?.iraCashDistributionsByOwner ?? null,
    taxYear: Number.isInteger(facts?.taxYear)
      ? facts.taxYear
      : (Number.isInteger(plan?.meta?.planningAsOfYear)
        ? plan.meta.planningAsOfYear
        : 2026),
  };
  const normalizedCurrentLevers = basisContract.unavailableCode
    ? Object.freeze({ ...currentLevers, taxableWithdrawal: 0 })
    : currentLevers;
  if (
    changedLever === 'taxableWithdrawal'
    && requestedValue > 0
    && basisContract.unavailableCode
  ) {
    const requestedLevers = {
      ...normalizedCurrentLevers,
      taxableWithdrawal: requestedValue,
    };
    const state = applyTaxableBasisContract(
      engine.resolveWithdrawalPlannerAccountState(plan, requestedLevers, options),
      basisContract
    );
    return Object.freeze({
      approved: false,
      requestedValue,
      approvedValue: state.levers.taxableWithdrawal,
      clamped: requestedValue !== state.levers.taxableWithdrawal,
      levers: state.levers,
      state,
      code: basisContract.unavailableCode,
    });
  }
  const approval = engine.approveWithdrawalPlannerLeverChange(
    plan,
    normalizedCurrentLevers,
    changedLever,
    requestedValue,
    options
  );
  const state = applyTaxableBasisContract(approval.state, basisContract);
  return Object.freeze({ ...approval, state });
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
    const resolved = engine.resolveInputs(plan, {});
    const income = { ...engine.householdIncomeAtYear(resolved, taxYear - baseYear) };
    const matchingCurrent1040 = Number(plan?.incomeTax?.current1040?.taxYear)
      === Number(taxYear)
      ? current1040.buildCurrent1040Intake(plan).intake?.income
      : null;
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

function toYearFacts({ facts, levers, gainFraction, taxYear, deductionContract }) {
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

  let capitalGain = num(facts.capitalGain);
  const hasCapitalGainContract = capitalGain !== null || num(gainFraction) !== null;
  if ((levers.taxableWithdrawal || 0) > 0 && num(gainFraction) !== null) {
    capitalGain = (capitalGain ?? 0) + levers.taxableWithdrawal * gainFraction;
  }

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
  if (hasCapitalGainContract) {
    out.scheduleD = {
      mode: 'manual-net-long-term',
      netLongTermGainOrLoss: capitalGain ?? 0,
    };
  }
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
  const { annual1040, constants, engine, taxableBasis } = await load();
  if (!facts || !facts.filingStatus) return null;

  let accountState = null;
  let basisContract = null;
  const accountIssues = [];
  try {
    basisContract = taxableBasisContract(plan, taxableBasis);
    accountState = applyTaxableBasisContract(
      engine.resolveWithdrawalPlannerAccountState(plan, levers, {
        traditionalTotal: Math.max(0, num(facts?.iraDistributions) ?? 0),
        rmdEligibleCash: Math.max(0, num(facts?.iraCashDistributions) ?? 0),
        traditionalByOwner: facts?.iraDistributionsByOwner ?? null,
        rmdEligibleCashByOwner: facts?.iraCashDistributionsByOwner ?? null,
        taxYear,
      }),
      basisContract
    );
  } catch {
    accountIssues.push({ code: 'WITHDRAWAL_ACCOUNT_STATE_UNAVAILABLE' });
  }
  const requestedAccountUse = [
    levers?.taxableWithdrawal,
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
  const basisUnavailableWithTaxableUse = Boolean(
    basisContract?.unavailableCode
    && (num(levers?.taxableWithdrawal) ?? 0) > 0
  );
  if (accountState && !accountState.valid && !basisUnavailableWithTaxableUse) {
    return {
      code: 'WITHDRAWAL_ACCOUNT_LIMIT_EXCEEDED',
      accountState,
      accountIssues,
    };
  }
  const effectiveLevers = accountState?.levers ?? levers;

  const gainFraction = basisContract?.gainFraction ?? null;

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
  if (basisUnavailableWithTaxableUse) {
    unavailableCode = basisContract.unavailableCode;
  } else if (facts.available === false) {
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
    const cash = engine.buildWithdrawalPlannerCashContract(effectiveLevers, null);
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
    taxableWithdrawal: 0,
    deferredWithdrawal: 0,
    rothConversion: 0,
    rothWithdrawal: 0,
    qcd: 0,
  };
  const deductionContract = baseAndAgeTaxFacts(plan, facts, taxYear);
  const selectedFacts = toYearFacts({
    facts, levers: effectiveLevers, gainFraction, taxYear, deductionContract,
  });
  const baselineFacts = toYearFacts({
    facts, levers: zeroLevers, gainFraction, taxYear, deductionContract,
  });
  const withoutSocialSecurityFacts = toYearFacts({
    facts: { ...facts, socialSecurityBenefits: 0 },
    levers: effectiveLevers,
    gainFraction,
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
  const zeroOrd = num(auditFor(zero?.audits, 'FED_ORDINARY_INCOME_TAX')?.inputsUsed?.taxableOrdinaryIncome);
  const zeroSsSteps = auditFor(zero?.audits, 'FED_TAXABLE_SOCIAL_SECURITY')?.calculationSteps || [];
  const zeroStep = line => {
    const st = zeroSsSteps.find(x => x && x.line === line);
    return st ? num(st.amount) : null;
  };
  const zeroProvisional = zeroStep('worksheetIncome') ?? zeroStep('combinedIncomeBeforeAdjustments');

  const cash = engine.buildWithdrawalPlannerCashContract(
    effectiveLevers,
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

  return {
    lawVersion,
    taxYear: res.taxYear ?? taxYear,
    baseline: { ordinaryIncome: zeroOrd, provisionalIncome: zeroProvisional },
    totals: {
      ordinaryIncome: taxableOrdinary,
      qualifiedIncome: preferential,
      agi: num(sum.adjustedGrossIncome),
      magi: num(sum.adjustedGrossIncome),
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
    irmaa: { scope: NOT_MODELED.irmaa },
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
      irmaa: null,
    },
    coverage: {
      unsupportedIntentional: res.unsupportedIntentional || [],
      warnings: res.warnings || [],
    },
    comparisonIssues: analysis.comparisonIssues,
    deductionCoverage: deductionContract.coverage,
    accountState,
    accountIssues,
    thresholdTaxDollars: analysis.thresholdTaxDollars,
    modeledFederalIncomeTax: analysis.modeledFederalIncomeTax,
    cash,
  };
}

export async function attributeSleeves({ plan, taxYear, facts, levers }) {
  const { annual1040, attribution, engine, taxableBasis } = await load();
  if (!facts || !facts.filingStatus) return null;
  let accountState = null;
  let basisContract = null;
  try {
    basisContract = taxableBasisContract(plan, taxableBasis);
    accountState = applyTaxableBasisContract(
      engine.resolveWithdrawalPlannerAccountState(plan, levers, {
        traditionalTotal: Math.max(0, num(facts?.iraDistributions) ?? 0),
        rmdEligibleCash: Math.max(0, num(facts?.iraCashDistributions) ?? 0),
        traditionalByOwner: facts?.iraDistributionsByOwner ?? null,
        rmdEligibleCashByOwner: facts?.iraCashDistributionsByOwner ?? null,
        taxYear,
      }),
      basisContract
    );
  } catch {
    return { code: 'WITHDRAWAL_ACCOUNT_STATE_UNAVAILABLE', accountState: null };
  }
  if (
    basisContract?.unavailableCode
    && (num(levers?.taxableWithdrawal) ?? 0) > 0
  ) {
    return {
      code: basisContract.unavailableCode,
      accountState,
    };
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

  const gainFraction = basisContract?.gainFraction ?? null;
  const context = annual1040.buildDefaultTaxContext({
    taxYear, runId: 'tax_aware_withdrawal', scenarioId: 'sleeve_attribution',
  });
  const deductionContract = baseAndAgeTaxFacts(plan, facts, taxYear);

  const held = {
    rothConversion: effectiveLevers.rothConversion || 0,
    qcd: effectiveLevers.qcd || 0,
  };
  const amounts = {
    taxable: Math.max(0, effectiveLevers.taxableWithdrawal || 0),
    traditional: Math.max(0, effectiveLevers.deferredWithdrawal || 0),
    roth: Math.max(0, effectiveLevers.rothWithdrawal || 0),
  };

  const taxFor = buckets => {
    const lv = {
      ...held,
      taxableWithdrawal: buckets.includes('taxable') ? amounts.taxable : 0,
      deferredWithdrawal: buckets.includes('traditional') ? amounts.traditional : 0,
      rothWithdrawal: buckets.includes('roth') ? amounts.roth : 0,
    };
    const out = annual1040.runEngineYearTax(
      toYearFacts({ facts, levers: lv, gainFraction, taxYear, deductionContract }),
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

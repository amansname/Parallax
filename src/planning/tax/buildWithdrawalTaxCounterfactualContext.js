import { getAccountTypeById } from '../../household/accountTypes.js';
import { resolvePortfolioAccounts } from '../../household/resolvePortfolioAccounts.js';
import { resolveTaxableStartingBasis } from '../../household/resolveTaxableStartingBasis.js';
import { TaxInputError } from '../../tax/core/errors.js';
import { supportedTaxYears } from '../../tax/core/lawRegistry.js';
import { buildHouseholdTaxFactContract } from './buildHouseholdTaxFactContract.js';
import { buildPlanMetaFromEngineParams } from './buildPlanMetaFromEngineParams.js';

function cloneFreeze(value){
  if(Array.isArray(value)) return Object.freeze(value.map(cloneFreeze));
  if(value && typeof value === 'object'){
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFreeze(item)])
    ));
  }
  return value;
}

function uniqueReasons(reasons){
  return Object.freeze([...new Set(reasons.filter(Boolean))]);
}

function confirmedFact(fact){
  return fact && fact.status === 'confirmed'
    ? { ready: true, value: fact.value }
    : { ready: false, value: null };
}

function ownerProfileFacts(plan, owner){
  const profile = plan.taxProfiles?.[owner];
  const birthDate = confirmedFact(profile?.birthDate);
  const blind = confirmedFact(profile?.blind);
  return Object.freeze({
    birthDate: birthDate.ready ? birthDate.value : null,
    birthDateConfirmed: birthDate.ready,
    blind: blind.ready ? blind.value : null,
    blindConfirmed: blind.ready,
  });
}

function reportingGapReason(account, outsideReturnIds){
  return outsideReturnIds.has(account.id) ? 'ACCOUNT_TAX_REPORTING_NOT_READY' : null;
}

function buildTraditionalReadiness(plan, fold, outsideReturnIds){
  const reasons = [];
  const modeledIds = new Set(fold.engineBuckets.traditional.accountIds);
  const accounts = fold.accounts.filter(
    account => modeledIds.has(account.id) && account.balance > 0
  );
  for(const account of accounts){
    if(account.sourceKind === 'legacy-base'){
      reasons.push('LEGACY_TRADITIONAL_TAX_FACTS_UNATTRIBUTED');
      continue;
    }
    const entry = getAccountTypeById(account.typeId);
    if(!entry?.supportedForTax){
      reasons.push('TRADITIONAL_ACCOUNT_TAX_TREATMENT_UNSUPPORTED');
      continue;
    }
    reasons.push(reportingGapReason(account, outsideReturnIds));
    const raw = plan.portfolio.extraAccounts[account.sourceIndex];
    // Incremental traditional-IRA planner distributions remain fully taxable
    // until a future Form 8606/pro-rata model is explicitly introduced.
    if(account.taxCharacter === 'traditional_ira') continue;
    if(account.taxCharacter === 'employer_pretax'){
      const afterTaxBasis = confirmedFact(raw?.employerPlanFacts?.afterTaxContributionBasis);
      const subtype = confirmedFact(raw?.employerPlanFacts?.planSubtypeConfirmed);
      if(!afterTaxBasis.ready){
        reasons.push('EMPLOYER_AFTER_TAX_BASIS_NOT_CONFIRMED');
      }else if(afterTaxBasis.value !== 0){
        reasons.push('EMPLOYER_AFTER_TAX_BASIS_RULE_REQUIRED');
      }
      if(!subtype.ready || subtype.value !== true){
        reasons.push('EMPLOYER_PLAN_SUBTYPE_NOT_CONFIRMED');
      }
    }else{
      reasons.push('TRADITIONAL_ACCOUNT_TAX_TREATMENT_UNSUPPORTED');
    }
  }
  return Object.freeze({
    accountIds: Object.freeze(accounts.map(account => account.id)),
    accounts: Object.freeze(accounts.map(account => Object.freeze({
      id: account.id,
      owner: account.owner,
      taxCharacter: account.taxCharacter,
    }))),
    reasons: uniqueReasons(reasons),
  });
}

function buildRothReadiness(plan, fold, outsideReturnIds){
  const reasons = [];
  const accounts = [];
  const modeledIds = new Set(fold.engineBuckets.roth.accountIds);
  for(const account of fold.accounts.filter(
    item => modeledIds.has(item.id) && item.balance > 0
  )){
    if(account.sourceKind === 'legacy-base'){
      reasons.push('LEGACY_ROTH_TAX_FACTS_UNATTRIBUTED');
      continue;
    }
    const entry = getAccountTypeById(account.typeId);
    if(!entry?.supportedForTax){
      reasons.push('ROTH_ACCOUNT_TAX_TREATMENT_UNSUPPORTED');
      continue;
    }
    reasons.push(reportingGapReason(account, outsideReturnIds));
    const owner = account.owner;
    const raw = plan.portfolio.extraAccounts[account.sourceIndex];
    const firstContribution = account.taxCharacter === 'roth_ira'
      ? confirmedFact(plan.taxProfiles?.[owner]?.rothIra?.firstContributionYear)
      : account.taxCharacter === 'designated_roth'
        ? confirmedFact(raw?.designatedRothFacts?.firstContributionYear)
        : { ready: false, value: null };
    if(!firstContribution.ready){
      reasons.push('ROTH_FIRST_CONTRIBUTION_YEAR_NOT_CONFIRMED');
    }
    if(owner !== 'client' && owner !== 'spouse'){
      reasons.push('ROTH_ACCOUNT_OWNER_UNSUPPORTED');
    }
    accounts.push(Object.freeze({
      id: account.id,
      owner,
      taxCharacter: account.taxCharacter,
      firstContributionYear: firstContribution.value,
    }));
  }
  return Object.freeze({
    accounts: Object.freeze(accounts),
    reasons: uniqueReasons(reasons),
  });
}

function buildReadinessScopes(fold, taxFacts){
  const calculationReasons = [];
  const scopeReasons = [];
  for(const issue of fold.issues) calculationReasons.push(`HOUSEHOLD_${issue}`);
  for(const gap of taxFacts.readiness.gaps){
    if(gap.kind === 'invalid' || gap.kind === 'household'
      || gap.code === 'FILING_STATUS_MISSING'
      || gap.code === 'FILING_STATUS_INVALID'){
      calculationReasons.push(gap.code);
    }
    if(gap.code === 'BANK_RETURN_TAX_TREATMENT_PENDING'){
      calculationReasons.push(gap.code);
    }
  }
  if(fold.pendingStrategyAccounts.some(account => account.balance > 0)){
    scopeReasons.push('PROJECTION_SCOPE_RULES_PENDING_ACCOUNTS');
  }
  if(fold.accounts.some(account => (
    account.balance > 0
    && account.engineBucket
    && !account.taxBucketGroup
  ))){
    scopeReasons.push('PROJECTION_SCOPE_OUTSIDE_TAX_BUCKETS');
  }
  return Object.freeze({
    calculationReasons: uniqueReasons(calculationReasons),
    scopeReasons: uniqueReasons(scopeReasons),
  });
}

/** Build immutable shared facts once before per-row coalition reruns. */
export function buildWithdrawalTaxCounterfactualContext(
  plan,
  engineParams,
  options = {},
  supplied = {}
){
  if(plan === null || typeof plan !== 'object' || Array.isArray(plan)){
    throw new TaxInputError('plan must be a plain object');
  }
  if(options === null || typeof options !== 'object' || Array.isArray(options)){
    throw new TaxInputError('options must be a plain object');
  }
  if(options.filingStatus !== undefined
    && options.filingStatus !== plan.meta?.filingStatus){
    throw new TaxInputError('filingStatus override conflicts with Household');
  }
  if(options.taxableGainFraction !== undefined || options.capitalGain !== undefined){
    throw new TaxInputError('withdrawal counterfactuals must use exact engine-row taxable gain');
  }
  if(options.treatWithdrawalsAsFullyTaxable === false || options.resolved !== undefined){
    throw new TaxInputError(
      'withdrawal counterfactuals cannot override supported distribution tax character'
    );
  }
  if(supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)){
    throw new TaxInputError('supplied context facts must be a plain object');
  }
  const fold = supplied.fold ?? resolvePortfolioAccounts(plan);
  const taxFacts = supplied.taxFacts ?? buildHouseholdTaxFactContract(plan);
  const basis = resolveTaxableStartingBasis(plan, fold);
  const planMeta = buildPlanMetaFromEngineParams(engineParams, {
    ...options,
    filingStatus: options.filingStatus ?? plan.meta?.filingStatus,
  });
  const years = supportedTaxYears();
  const defaultYear = years[years.length - 1];
  const baseCalendarYear = options.baseTaxYear ?? options.taxYear ?? defaultYear;
  if(!Number.isInteger(baseCalendarYear) || baseCalendarYear < 1900){
    throw new TaxInputError('baseTaxYear must be an integer year');
  }
  const outsideReturnIds = new Set(
    taxFacts.scope.outsideHouseholdReturn.map(account => account.id)
  );
  const taxableReasons = basis.status === 'confirmed'
    || basis.status === 'not-applicable'
    || basis.status === 'assumed-50-50'
    ? []
    : basis.gaps.map(gap => gap.code);
  const primaryAge = plan.household?.primary?.currentAge;
  const resolvedRetirementAge = engineParams?.retirementAge;
  const spouseAge = plan.household?.spouse?.currentAge ?? null;
  if(typeof primaryAge !== 'number' || !Number.isFinite(primaryAge)){
    throw new TaxInputError('plan.household.primary.currentAge must be finite');
  }
  if(typeof resolvedRetirementAge !== 'number' || !Number.isFinite(resolvedRetirementAge)){
    throw new TaxInputError('engineParams.retirementAge must be finite');
  }
  const traditionalCouldExistAtRetirement = (
    (engineParams.accounts?.traditional?.balance ?? 0) > 0
    || (
      (engineParams.savingsAnnual ?? 0) > 0
      && (engineParams.savingsSplit?.traditional ?? 0) > 0
      && resolvedRetirementAge > primaryAge
    )
  );

  const readinessScopes = buildReadinessScopes(fold, taxFacts);

  return Object.freeze({
    schemaVersion: 1,
    baseCalendarYear,
    explicitTaxYear: options.taxYear ?? null,
    supportedTaxYears: Object.freeze([...years]),
    scenarioId: options.scenarioId ?? 'withdrawal_tax_counterfactual',
    contextOverrides: cloneFreeze(options.contextOverrides ?? {}),
    planMeta: cloneFreeze(planMeta),
    householdAges: Object.freeze({
      primary: primaryAge,
      resolvedRetirement: resolvedRetirementAge,
      spouse: spouseAge,
    }),
    engineProjection: Object.freeze({ traditionalCouldExistAtRetirement }),
    ownerProfiles: Object.freeze({
      client: ownerProfileFacts(plan, 'client'),
      spouse: ownerProfileFacts(plan, 'spouse'),
    }),
    taxFacts,
    readiness: Object.freeze({
      globalReasons: readinessScopes.calculationReasons,
      scopeReasons: readinessScopes.scopeReasons,
      taxable: Object.freeze({ reasons: uniqueReasons(taxableReasons) }),
      traditional: buildTraditionalReadiness(plan, fold, outsideReturnIds),
      roth: buildRothReadiness(plan, fold, outsideReturnIds),
    }),
  });
}

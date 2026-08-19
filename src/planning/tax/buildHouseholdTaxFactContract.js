import { getAccountTypeById } from '../../household/accountTypes.js';
import {
  validateBasisEnvelope,
  validateFactEnvelope,
} from '../../household/factEnvelope.js';
import { resolvePortfolioAccounts } from '../../household/resolvePortfolioAccounts.js';
import {
  resolveAccountTaxReportingGap,
  resolveTaxableStartingBasis,
} from '../../household/resolveTaxableStartingBasis.js';
import {
  DESIGNATED_ROTH_FACTS,
  EMPLOYER_FACTS,
  PROFILE_FACTS,
  ROTH_IRA_FACTS,
  TRADITIONAL_IRA_FACTS,
  semanticValueIsValid,
} from '../../household/taxFactDefinitions.js';
import { FILING_STATUSES } from '../../tax/core/constants.js';

const INDIVIDUAL_ACCOUNT_CHARACTERS = new Set([
  'traditional_ira',
  'inherited_traditional_ira',
  'employer_pretax',
  'roth_ira',
  'inherited_roth_ira',
  'designated_roth',
  'hsa',
]);

function cloneFreeze(value){
  if(Array.isArray(value)){
    return Object.freeze(value.map(cloneFreeze));
  }
  if(value && typeof value === 'object'){
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFreeze(item)])
    ));
  }
  return value;
}

function makeGap(code, kind, path, details = {}){
  return Object.freeze({
    code,
    kind,
    path,
    owner: details.owner ?? null,
    accountId: details.accountId ?? null,
    affects: details.affects ?? 'future-strategy-tax',
  });
}

function appendUniqueGap(gaps, gap){
  const duplicate = gaps.some(item => (
    item.code === gap.code
    && item.path === gap.path
    && item.accountId === gap.accountId
  ));
  if(!duplicate) gaps.push(gap);
}

function contractGapFromResolver(gap){
  return makeGap(gap.code, gap.kind ?? 'missing-fact', gap.path, {
    accountId: gap.accountId,
    affects: gap.affects,
  });
}

function accountOwnershipGap(account, plan){
  const path = `portfolio.extraAccounts.${account.sourceIndex}.owner`;
  if(account.owner === 'spouse' && !plan?.household?.spouse){
    return makeGap('ACCOUNT_OWNER_WITHOUT_SPOUSE', 'household', path, {
      owner: account.owner,
      accountId: account.id,
    });
  }
  if(account.owner === 'trust'){
    return makeGap('TRUST_ACCOUNT_TAX_TREATMENT_UNSUPPORTED', 'scope', path, {
      owner: account.owner,
      accountId: account.id,
    });
  }
  if(INDIVIDUAL_ACCOUNT_CHARACTERS.has(account.taxCharacter)
    && account.owner !== 'client'
    && account.owner !== 'spouse'){
    return makeGap('INDIVIDUAL_ACCOUNT_OWNER_UNSUPPORTED', 'invalid', path, {
      owner: account.owner,
      accountId: account.id,
    });
  }
  return null;
}

function unsupportedTaxTreatmentGap(entry, raw, index){
  if(!entry || raw.balance <= 0 || entry.supportedForTax) return null;
  const details = { owner: raw.owner, accountId: raw.id };
  const path = `portfolio.extraAccounts.${index}.typeId`;
  if(entry.taxCharacter === 'taxable_cash'){
    return makeGap('BANK_RETURN_TAX_TREATMENT_PENDING', 'rules-pending', path, details);
  }
  if(entry.taxCharacter === 'hsa'){
    return makeGap('HSA_TAX_TREATMENT_UNSUPPORTED', 'scope', path, details);
  }
  if(entry.taxCharacter === 'inherited_traditional_ira'
    || entry.taxCharacter === 'inherited_roth_ira'){
    return makeGap('INHERITED_ACCOUNT_RULES_PENDING', 'rules-pending', path, details);
  }
  if(entry.taxCharacter === 'unsupported'){
    return makeGap('ACCOUNT_OUTSIDE_TAX_BUCKET_SCOPE', 'scope', path, details);
  }
  if(entry.taxCharacter === 'capital_asset') return null;
  return makeGap('ACCOUNT_TAX_TREATMENT_UNSUPPORTED', 'scope', path, details);
}

function makeFactRecord({
  path,
  scope,
  owner = null,
  accountId = null,
  fact,
  disposition,
  reason,
  semantic,
  gaps,
  applicable,
  applicableAccountIds = [],
  rule,
}){
  try{
    validateFactEnvelope(fact, path);
  }catch{
    gaps.push(makeGap('FACT_ENVELOPE_INVALID', 'invalid', path, { owner, accountId }));
    return Object.freeze({
      path, scope, owner, accountId, value: null, status: 'invalid', source: null,
      confirmedAt: null, version: null, disposition: 'excluded', reason: 'invalid-envelope',
      applicableAccountIds: Object.freeze([...applicableAccountIds]),
    });
  }

  const value = fact.status === 'unknown' ? null : cloneFreeze(fact.value);
  let finalDisposition = disposition;
  let finalReason = reason;
  if(fact.status !== 'unknown' && !semanticValueIsValid(fact.value, semantic)){
    gaps.push(makeGap('FACT_VALUE_INVALID', 'invalid', path, { owner, accountId }));
    finalDisposition = 'excluded';
    finalReason = 'invalid-value';
  }else if(applicable){
    if(fact.status === 'unknown'){
      gaps.push(makeGap('FACT_UNKNOWN', 'missing-fact', path, { owner, accountId }));
    }else if(fact.status === 'assumed'){
      gaps.push(makeGap('FACT_ASSUMED', 'assumption', path, { owner, accountId }));
    }
    if(rule){
      gaps.push(makeGap(rule, 'rules-pending', path, { owner, accountId }));
    }
  }

  return Object.freeze({
    path,
    scope,
    owner,
    accountId,
    value,
    status: fact.status,
    source: fact.source,
    confirmedAt: fact.confirmedAt,
    version: fact.version,
    disposition: finalDisposition,
    reason: finalReason,
    applicableAccountIds: Object.freeze([...applicableAccountIds]),
  });
}

function makeBasisRecord(raw, index, resolverRecord, gaps){
  const path = `portfolio.extraAccounts.${index}.basis`;
  try{
    validateBasisEnvelope(raw.basis, path);
  }catch{
    gaps.push(makeGap('BASIS_ENVELOPE_INVALID', 'invalid', path, {
      owner: raw.owner,
      accountId: raw.id,
      affects: 'taxable-withdrawal-gain',
    }));
    return Object.freeze({
      path, scope: 'account', owner: raw.owner, accountId: raw.id, value: null,
      status: 'invalid', source: null, confirmedAt: null, version: null,
      disposition: 'excluded', reason: 'invalid-envelope',
      method: null,
    });
  }
  const calculationDisposition = resolverRecord?.disposition === 'calculation'
    || resolverRecord?.disposition === 'structural-principal'
    || resolverRecord?.disposition === 'calculation-assumption';
  return Object.freeze({
    path,
    scope: 'account',
    owner: raw.owner,
    accountId: raw.id,
    value: raw.basis.status === 'unknown' ? null : raw.basis.amount,
    status: raw.basis.status,
    source: raw.basis.source,
    confirmedAt: raw.basis.confirmedAt,
    version: raw.basis.version,
    method: raw.basis.method,
    disposition: calculationDisposition ? 'calculation' : 'readiness-only',
    reason: resolverRecord?.disposition === 'structural-principal'
      ? 'structural-principal'
      : resolverRecord?.reason ?? null,
  });
}

function scopeAccount(account){
  return Object.freeze({
    id: account.id,
    typeId: account.typeId,
    owner: account.owner,
    balance: account.balance,
  });
}

function readinessStatus(gaps){
  if(gaps.some(gap => gap.kind === 'invalid' || gap.kind === 'household')) return 'blocked';
  if(gaps.some(gap => gap.kind === 'rules-pending' || gap.kind === 'scope')){
    return 'rules-pending';
  }
  if(gaps.some(gap => ['missing-fact', 'assumption', 'reporting'].includes(gap.kind))){
    return 'incomplete';
  }
  return 'ready';
}

function factCompleteness(gaps){
  if(gaps.some(gap => gap.kind === 'invalid')) return 'invalid';
  if(gaps.some(gap => ['missing-fact', 'assumption', 'reporting'].includes(gap.kind))){
    return 'incomplete';
  }
  return 'complete';
}

/**
 * Display-neutral Household tax-fact contract for planning/tax consumers.
 * Only a complete confirmed taxable basis can change current calculations;
 * all unsupported facts remain provenance-preserving readiness evidence.
 */
export function buildHouseholdTaxFactContract(plan){
  const fold = resolvePortfolioAccounts(plan);
  const basisResolution = resolveTaxableStartingBasis(plan, fold);
  const gaps = [];
  for(const gap of basisResolution.gaps){
    appendUniqueGap(gaps, contractGapFromResolver(gap));
  }

  const filingStatus = plan?.meta?.filingStatus ?? null;
  if(filingStatus === null){
    appendUniqueGap(gaps, makeGap(
      'FILING_STATUS_MISSING',
      'missing-fact',
      'meta.filingStatus',
      { affects: 'all-federal-tax' }
    ));
  }else if(!FILING_STATUSES.includes(filingStatus)){
    appendUniqueGap(gaps, makeGap(
      'FILING_STATUS_INVALID',
      'invalid',
      'meta.filingStatus',
      { affects: 'all-federal-tax' }
    ));
  }
  const hasSpouse = Boolean(plan?.household?.spouse);
  if((filingStatus === 'marriedFilingJointly' && !hasSpouse)
    || (hasSpouse && filingStatus !== 'marriedFilingJointly')){
    appendUniqueGap(gaps, makeGap(
      'FILING_STATUS_HOUSEHOLD_MISMATCH',
      'household',
      'meta.filingStatus',
      { affects: 'all-federal-tax' }
    ));
  }

  const factRecords = [];
  const extras = plan?.portfolio?.extraAccounts ?? [];
  const basisRecordById = new Map(basisResolution.records.map(record => [record.accountId, record]));
  const materialAccounts = fold.accounts.filter(
    account => account.sourceKind === 'typed-account' && account.balance > 0
  );
  const materialBySourceIndex = new Map(
    materialAccounts.map(account => [account.sourceIndex, account])
  );
  const reportingGapById = new Map();
  const ownershipGapById = new Map();

  for(const account of materialAccounts){
    const raw = extras[account.sourceIndex];
    const reportingGap = resolveAccountTaxReportingGap(raw, account, plan);
    if(reportingGap){
      reportingGapById.set(account.id, reportingGap);
      appendUniqueGap(gaps, contractGapFromResolver(reportingGap));
    }
    const ownershipGap = accountOwnershipGap(account, plan);
    if(ownershipGap){
      ownershipGapById.set(account.id, ownershipGap);
      appendUniqueGap(gaps, ownershipGap);
    }
  }

  extras.forEach((raw, index) => {
    const entry = getAccountTypeById(raw.typeId);
    const foldedAccount = materialBySourceIndex.get(index);
    const reportingReady = !foldedAccount || !reportingGapById.has(foldedAccount.id);
    const ownershipReady = !foldedAccount || !ownershipGapById.has(foldedAccount.id);
    const accountReady = Boolean(
      foldedAccount
      && foldedAccount.classificationStatus === 'included'
      && !foldedAccount.strategyRulesPending
      && entry?.supportedForTax
      && reportingReady
      && ownershipReady
    );
    factRecords.push(makeBasisRecord(raw, index, basisRecordById.get(raw.id), gaps));

    const treatmentGap = unsupportedTaxTreatmentGap(entry, raw, index);
    if(treatmentGap) appendUniqueGap(gaps, treatmentGap);

    if(raw.employerPlanFacts){
      for(const spec of EMPLOYER_FACTS){
        factRecords.push(makeFactRecord({
          path: `portfolio.extraAccounts.${index}.employerPlanFacts.${spec.key}`,
          scope: 'account', owner: raw.owner, accountId: raw.id,
          fact: raw.employerPlanFacts[spec.key], semantic: spec.semantic,
          disposition: accountReady ? 'readiness-only' : 'excluded',
          reason: accountReady ? 'rule-not-implemented' : 'account-not-applicable',
          gaps, applicable: accountReady,
          applicableAccountIds: accountReady ? [raw.id] : [],
          rule: accountReady ? spec.rule : null,
        }));
      }
    }
    if(raw.designatedRothFacts){
      for(const spec of DESIGNATED_ROTH_FACTS){
        factRecords.push(makeFactRecord({
          path: `portfolio.extraAccounts.${index}.designatedRothFacts.${spec.key}`,
          scope: 'account', owner: raw.owner, accountId: raw.id,
          fact: raw.designatedRothFacts[spec.key], semantic: spec.semantic,
          disposition: accountReady ? 'readiness-only' : 'excluded',
          reason: accountReady ? 'rule-not-implemented' : 'account-not-applicable',
          gaps, applicable: accountReady,
          applicableAccountIds: accountReady ? [raw.id] : [],
          rule: accountReady ? spec.rule : null,
        }));
      }
    }
  });

  const legacyUnattributed = fold.accounts
    .filter(account => account.sourceKind === 'legacy-base'
      && account.balance > 0
      && (account.engineBucket === 'traditional' || account.engineBucket === 'roth'))
    .map(scopeAccount);
  for(const account of legacyUnattributed){
    appendUniqueGap(gaps, makeGap(
      account.typeId === null && account.id === 'base-traditional'
        ? 'LEGACY_TRADITIONAL_TAX_FACTS_UNATTRIBUTED'
        : 'LEGACY_ROTH_TAX_FACTS_UNATTRIBUTED',
      'assumption',
      `portfolio.accounts.${account.id === 'base-traditional' ? 'traditional' : 'roth'}`,
      { accountId: account.id, affects: 'future-strategy-tax' }
    ));
  }

  const activeOwners = new Set(['client']);
  if(plan?.household?.spouse && filingStatus === 'marriedFilingJointly'){
    activeOwners.add('spouse');
  }
  const ownerAccountIds = new Map(['client', 'spouse'].map(owner => [owner, new Map()]));
  for(const account of materialAccounts){
    if(!ownerAccountIds.has(account.owner)
      || reportingGapById.has(account.id)
      || ownershipGapById.has(account.id)
      || account.classificationStatus !== 'included'
      || account.strategyRulesPending
      || !getAccountTypeById(account.typeId)?.supportedForTax) continue;
    const idsByCharacter = ownerAccountIds.get(account.owner);
    const ids = idsByCharacter.get(account.taxCharacter) ?? [];
    ids.push(account.id);
    idsByCharacter.set(account.taxCharacter, ids);
  }

  for(const owner of ['client', 'spouse']){
    const profile = plan?.taxProfiles?.[owner];
    const ownerActive = activeOwners.has(owner);
    if(!profile || typeof profile !== 'object' || Array.isArray(profile)){
      if(ownerActive){
        gaps.push(makeGap('TAX_PROFILE_MISSING', 'missing-fact', `taxProfiles.${owner}`, { owner }));
      }
      continue;
    }
    const traditionalIraIds = ownerAccountIds.get(owner).get('traditional_ira') ?? [];
    const rothIraIds = ownerAccountIds.get(owner).get('roth_ira') ?? [];
    const hasTraditionalIra = traditionalIraIds.length > 0;
    const hasRothIra = rothIraIds.length > 0;
    for(const spec of PROFILE_FACTS){
      const key = spec.path[0];
      factRecords.push(makeFactRecord({
        path: `taxProfiles.${owner}.${key}`,
        scope: 'owner', owner, fact: profile[key], semantic: spec.semantic,
        disposition: ownerActive ? 'readiness-only' : 'excluded',
        reason: ownerActive ? 'rule-not-implemented' : 'owner-not-active',
        gaps, applicable: ownerActive, applicableAccountIds: [],
        rule: ownerActive ? spec.rule : null,
      }));
    }
    for(const spec of TRADITIONAL_IRA_FACTS){
      const key = spec.path[1];
      factRecords.push(makeFactRecord({
        path: `taxProfiles.${owner}.traditionalIra.${key}`,
        scope: 'owner', owner, fact: profile.traditionalIra?.[key], semantic: spec.semantic,
        disposition: hasTraditionalIra ? 'readiness-only' : 'excluded',
        reason: hasTraditionalIra ? 'rule-not-implemented' : 'no-material-account',
        gaps, applicable: hasTraditionalIra, applicableAccountIds: traditionalIraIds,
        rule: hasTraditionalIra ? spec.rule : null,
      }));
    }
    for(const spec of ROTH_IRA_FACTS){
      const key = spec.path[1];
      factRecords.push(makeFactRecord({
        path: `taxProfiles.${owner}.rothIra.${key}`,
        scope: 'owner', owner, fact: profile.rothIra?.[key], semantic: spec.semantic,
        disposition: hasRothIra ? 'readiness-only' : 'excluded',
        reason: hasRothIra ? 'rule-not-implemented' : 'no-material-account',
        gaps, applicable: hasRothIra, applicableAccountIds: rothIraIds,
        rule: hasRothIra ? spec.rule : null,
      }));
    }
  }

  const inheritedRulesPending = fold.pendingStrategyAccounts
    .filter(account => account.balance > 0)
    .map(scopeAccount);
  const hsaUnsupported = materialAccounts
    .filter(account => account.taxCharacter === 'hsa')
    .map(scopeAccount);
  const outsideTaxBuckets = materialAccounts
    .filter(account => !account.taxBucketGroup && account.taxCharacter !== 'hsa')
    .map(scopeAccount);
  const outsideHouseholdReturn = materialAccounts
    .filter(account => reportingGapById.has(account.id))
    .map(account => {
      const raw = extras[account.sourceIndex];
      return Object.freeze({
        id: account.id,
        typeId: account.typeId,
        owner: account.owner,
        inclusion: raw.taxReporting?.inclusion ?? null,
        reportingTaxpayer: raw.taxReporting?.reportingTaxpayer ?? null,
        householdReturnShare: raw.taxReporting?.householdReturnShare ?? null,
        reason: reportingGapById.get(account.id).code,
      });
    });

  const taxableBasisOverride = basisResolution.basisOverride !== null
    && basisResolution.taxableBalance > 0
    ? Object.freeze({
        amount: basisResolution.basisOverride,
        taxableBalance: basisResolution.taxableBalance,
        accountIds: Object.freeze([...basisResolution.accountIds]),
        evidence: Object.freeze(basisResolution.evidence.map(item => Object.freeze({
          ...item,
          reporting: item.reporting ? Object.freeze({ ...item.reporting }) : null,
        }))),
      })
    : null;
  const frozenGaps = Object.freeze(gaps);

  return Object.freeze({
    schemaVersion: 1,
    filingStatus,
    calculationInputs: Object.freeze({
      taxableBasisOverride,
      taxableBasisMode: basisResolution.appliedMode,
      provisionalTaxableBasis: basisResolution.appliedBasis,
      taxableBasisAssumptions: Object.freeze(
        basisResolution.assumptions.map(cloneFreeze)
      ),
    }),
    factRecords: Object.freeze(factRecords),
    readiness: Object.freeze({
      purpose: 'distribution-strategy-tax-comparison',
      status: readinessStatus(frozenGaps),
      factCompleteness: factCompleteness(frozenGaps),
      gaps: frozenGaps,
    }),
    scope: Object.freeze({
      inheritedRulesPending: Object.freeze(inheritedRulesPending),
      hsaUnsupported: Object.freeze(hsaUnsupported),
      outsideTaxBuckets: Object.freeze(outsideTaxBuckets),
      outsideHouseholdReturn: Object.freeze(outsideHouseholdReturn),
      legacyUnattributed: Object.freeze(legacyUnattributed),
    }),
  });
}

import { getAccountTypeById } from './accountTypes.js';
import { validateBasisEnvelope } from './factEnvelope.js';
import { resolvePortfolioAccounts } from './resolvePortfolioAccounts.js';

const GAP_AFFECTS = 'taxable-withdrawal-gain';
const APPROVED_BASIS_ASSUMPTION_CODE = 'TAXABLE_BASIS_ASSUMED_50_50';

function freezeGap(code, account, path, kind = 'missing-fact'){
  return Object.freeze({
    code,
    kind,
    accountId: account?.id ?? null,
    path,
    affects: GAP_AFFECTS,
  });
}

function freezeRecord(account, disposition, basisAmount, reason, raw = null){
  return Object.freeze({
    accountId: account.id,
    typeId: account.typeId,
    taxCharacter: account.taxCharacter,
    balance: account.balance,
    disposition,
    basisAmount,
    basisStatus: raw?.basis?.status ?? account.basis?.status ?? null,
    source: raw?.basis?.source ?? account.basis?.source ?? null,
    confirmedAt: raw?.basis?.confirmedAt ?? account.basis?.confirmedAt ?? null,
    reason,
  });
}

function freezeReportingSnapshot(reporting){
  return Object.freeze({
    inclusion: reporting.inclusion,
    reportingTaxpayer: reporting.reportingTaxpayer,
    householdReturnShare: reporting.householdReturnShare,
  });
}

function freezeApprovedBasisAssumption(account){
  const basisAmount = account.balance * 0.5;
  return Object.freeze({
    code: APPROVED_BASIS_ASSUMPTION_CODE,
    mode: 'assumed-50-50',
    accountId: account.id,
    applicableBalance: account.balance,
    basisAmount,
    gainAmount: account.balance - basisAmount,
    basisFraction: 0.5,
    gainFraction: 0.5,
  });
}

export function resolveAccountTaxReportingGap(raw, account, plan){
  const reporting = raw?.taxReporting;
  const path = `portfolio.extraAccounts.${account.sourceIndex}.taxReporting`;
  if(!reporting || typeof reporting !== 'object' || Array.isArray(reporting)){
    return freezeGap('TAX_REPORTING_MISSING', account, path, 'reporting');
  }
  if(reporting.inclusion !== 'household-return'){
    return freezeGap(
      reporting.inclusion === 'unknown'
        ? 'TAX_REPORTING_INCLUSION_UNKNOWN'
        : 'TAX_REPORTING_OUTSIDE_HOUSEHOLD_RETURN',
      account,
      `${path}.inclusion`,
      'reporting'
    );
  }
  if(reporting.householdReturnShare !== 1){
    return freezeGap(
      reporting.householdReturnShare == null
        ? 'TAX_REPORTING_SHARE_UNKNOWN'
        : 'TAX_REPORTING_FRACTIONAL_SHARE_UNSUPPORTED',
      account,
      `${path}.householdReturnShare`,
      'reporting'
    );
  }
  if(plan?.meta?.filingStatus === 'marriedFilingSeparately'){
    return freezeGap('MFS_ACCOUNT_ATTRIBUTION_UNSUPPORTED', account, path, 'reporting');
  }
  if(account.owner === 'spouse'
    && (plan?.meta?.filingStatus === 'single'
      || plan?.meta?.filingStatus === 'headOfHousehold')){
    return freezeGap(
      'FILING_STATUS_ACCOUNT_OWNER_MISMATCH',
      account,
      path,
      'reporting'
    );
  }

  const taxpayer = reporting.reportingTaxpayer;
  const owner = account.owner;
  const consistent = owner === 'client' || owner === 'spouse'
    ? taxpayer === owner || taxpayer === 'return-level'
    : taxpayer === 'return-level';
  if(!consistent){
    return freezeGap(
      'TAX_REPORTING_OWNER_MISMATCH',
      account,
      `${path}.reportingTaxpayer`,
      'reporting'
    );
  }
  return null;
}

function capitalAssetEvidence(account, raw, plan){
  const path = `portfolio.extraAccounts.${account.sourceIndex}`;
  const entry = getAccountTypeById(account.typeId);
  if(!entry?.supportedForTax){
    return {
      record: freezeRecord(account, 'readiness-only', null, 'unsupported-tax-treatment', raw),
      gap: freezeGap(
        'TAXABLE_ACCOUNT_TAX_TREATMENT_UNSUPPORTED',
        account,
        `${path}.typeId`,
        'scope'
      ),
    };
  }

  const reportGap = resolveAccountTaxReportingGap(raw, account, plan);
  if(reportGap){
    return {
      record: freezeRecord(account, 'readiness-only', null, 'reporting-not-ready', raw),
      gap: reportGap,
    };
  }

  try{
    validateBasisEnvelope(raw?.basis, `${path}.basis`);
  }catch{
    return {
      record: freezeRecord(account, 'readiness-only', null, 'invalid-basis-envelope', raw),
      gap: freezeGap('TAXABLE_BASIS_ENVELOPE_INVALID', account, `${path}.basis`, 'invalid'),
    };
  }

  if(raw.basis.status !== 'confirmed'){
    return {
      record: freezeRecord(
        account,
        'readiness-only',
        null,
        raw.basis.status === 'assumed' ? 'assumed-basis' : 'unknown-basis',
        raw
      ),
      gap: freezeGap(
        raw.basis.status === 'assumed' ? 'TAXABLE_BASIS_ASSUMED' : 'TAXABLE_BASIS_UNKNOWN',
        account,
        `${path}.basis`,
        raw.basis.status === 'assumed' ? 'assumption' : 'missing-fact'
      ),
    };
  }
  if(raw.basis.method !== 'reported-cost-basis'){
    return {
      record: freezeRecord(account, 'readiness-only', null, 'unsupported-basis-method', raw),
      gap: freezeGap(
        'TAXABLE_BASIS_METHOD_UNSUPPORTED',
        account,
        `${path}.basis.method`,
        'rules-pending'
      ),
    };
  }

  return {
    record: freezeRecord(account, 'calculation', raw.basis.amount, null, raw),
    gap: null,
  };
}

/**
 * Resolve the only Household tax fact the current engine can consume directly:
 * a complete starting basis for its aggregated taxable sleeve.
 *
 * Confirmed account-basis facts are preserved. A supported taxable investment
 * with no usable explicit basis receives the owner-approved 50% basis / 50%
 * gain planning assumption; unsupported ownership, reporting, or tax treatment
 * remains unavailable rather than inheriting a competing default.
 */
export function resolveTaxableStartingBasis(plan, suppliedFold = null){
  const fold = suppliedFold ?? resolvePortfolioAccounts(plan);
  const modeledTaxableIds = new Set(fold.engineBuckets.taxable.accountIds);
  const accounts = fold.accounts.filter(
    account => modeledTaxableIds.has(account.id) && account.balance > 0
  );
  const records = [];
  const gaps = [];
  const evidence = [];
  const assumptions = [];
  const assumptionGaps = [];
  const accountIds = [];
  let completeBasis = 0;
  let hasCalculatedBasis = false;
  let calculatedCarriedForwardBasis = null;

  for(const account of accounts){
    accountIds.push(account.id);
    if(account.sourceKind === 'legacy-base'){
      if(account.basis?.method === 'calculated-carried-forward'){
        hasCalculatedBasis = true;
        calculatedCarriedForwardBasis = account.basis.amount;
        completeBasis += account.basis.amount;
        records.push(freezeRecord(
          account,
          'calculation',
          account.basis.amount,
          'calculated-carried-forward'
        ));
        evidence.push(Object.freeze({
          accountId: account.id,
          amount: account.basis.amount,
          method: 'calculated-carried-forward',
          status: 'calculated',
          source: 'retirement-entry-calculation',
          confirmedAt: null,
          reporting: null,
        }));
      }else{
        const assumption = freezeApprovedBasisAssumption(account);
        assumptions.push(assumption);
        completeBasis += assumption.basisAmount;
        records.push(freezeRecord(
          account,
          'calculation-assumption',
          assumption.basisAmount,
          'assumed-50-50'
        ));
        evidence.push(Object.freeze({
          accountId: account.id,
          amount: assumption.basisAmount,
          method: 'assumed-50-50',
          status: 'assumed',
          source: 'owner-approved-planning-assumption',
          confirmedAt: null,
          reporting: null,
        }));
        assumptionGaps.push(freezeGap(
          APPROVED_BASIS_ASSUMPTION_CODE,
          account,
          'portfolio.accounts.taxable',
          'assumption'
        ));
      }
      continue;
    }

    const raw = plan?.portfolio?.extraAccounts?.[account.sourceIndex];
    if(account.owner === 'spouse' && !plan?.household?.spouse){
      records.push(freezeRecord(account, 'readiness-only', null, 'owner-without-spouse', raw));
      gaps.push(freezeGap(
        'ACCOUNT_OWNER_WITHOUT_SPOUSE',
        account,
        `portfolio.extraAccounts.${account.sourceIndex}.owner`,
        'household'
      ));
      continue;
    }
    if(account.owner === 'trust'){
      records.push(freezeRecord(account, 'readiness-only', null, 'trust-treatment-unsupported', raw));
      gaps.push(freezeGap(
        'TRUST_ACCOUNT_TAX_TREATMENT_UNSUPPORTED',
        account,
        `portfolio.extraAccounts.${account.sourceIndex}.owner`,
        'scope'
      ));
      continue;
    }
    if(account.taxCharacter === 'taxable_cash'){
      const reportGap = resolveAccountTaxReportingGap(raw, account, plan);
      if(reportGap){
        records.push(freezeRecord(account, 'readiness-only', null, 'reporting-not-ready', raw));
        gaps.push(reportGap);
        continue;
      }
      completeBasis += account.balance;
      records.push(freezeRecord(account, 'structural-principal', account.balance, null, raw));
      evidence.push(Object.freeze({
        accountId: account.id,
        amount: account.balance,
        method: 'principal',
        status: 'structural',
        source: null,
        confirmedAt: null,
        reporting: freezeReportingSnapshot(raw.taxReporting),
      }));
      continue;
    }
    if(account.taxCharacter === 'capital_asset'){
      const result = capitalAssetEvidence(account, raw, plan);
      const approvedAssumption = result.gap
        && (result.gap.code === 'TAXABLE_BASIS_UNKNOWN'
          || result.gap.code === 'TAXABLE_BASIS_ASSUMED');
      if(approvedAssumption){
        const assumption = freezeApprovedBasisAssumption(account);
        assumptions.push(assumption);
        completeBasis += assumption.basisAmount;
        records.push(freezeRecord(
          account,
          'calculation-assumption',
          assumption.basisAmount,
          'assumed-50-50',
          raw
        ));
        evidence.push(Object.freeze({
          accountId: account.id,
          amount: assumption.basisAmount,
          method: 'assumed-50-50',
          status: 'assumed',
          source: 'owner-approved-planning-assumption',
          confirmedAt: null,
          reporting: freezeReportingSnapshot(raw.taxReporting),
        }));
        assumptionGaps.push(freezeGap(
          APPROVED_BASIS_ASSUMPTION_CODE,
          account,
          `portfolio.extraAccounts.${account.sourceIndex}.basis`,
          'assumption'
        ));
      }else{
        records.push(result.record);
      }
      if(result.gap && !approvedAssumption){
        gaps.push(result.gap);
      }else if(!result.gap){
        completeBasis += result.record.basisAmount;
        evidence.push(Object.freeze({
          accountId: account.id,
          amount: result.record.basisAmount,
          method: raw.basis.method,
          status: raw.basis.status,
          source: result.record.source,
          confirmedAt: result.record.confirmedAt,
          reporting: freezeReportingSnapshot(raw.taxReporting),
        }));
      }
      continue;
    }

    records.push(freezeRecord(account, 'readiness-only', null, 'unclassified-taxable-treatment', raw));
    gaps.push(freezeGap(
      'TAXABLE_ACCOUNT_CLASSIFICATION_UNSUPPORTED',
      account,
      `portfolio.extraAccounts.${account.sourceIndex}`,
      'scope'
    ));
  }

  const blockingFoldIssues = fold.issues;
  for(const issue of blockingFoldIssues){
    gaps.unshift(Object.freeze({
      code: `HOUSEHOLD_${issue}`,
      kind: 'household',
      accountId: null,
      path: 'portfolio',
      affects: GAP_AFFECTS,
    }));
  }

  const taxableBalance = fold.engineBuckets.taxable.balance;
  const blocked = blockingFoldIssues.length > 0;
  const composable = !blocked && gaps.length === 0;
  const completeConfirmed = composable
    && assumptions.length === 0;
  const lossTreatmentPending = taxableBalance > 0
    && composable
    && !hasCalculatedBasis
    && completeBasis > taxableBalance;
  if(lossTreatmentPending){
    gaps.push(freezeGap(
      'TAXABLE_LOSS_TREATMENT_PENDING',
      null,
      'portfolio.extraAccounts',
      'rules-pending'
    ));
  }
  const basisOverride = taxableBalance === 0
    ? 0
    : composable && !lossTreatmentPending ? completeBasis : null;
  const appliedAssumptions = basisOverride === null
    ? []
    : assumptions;
  const exactTransientBasis = basisOverride === null
      && hasCalculatedBasis
      && accounts.length === 1
    ? calculatedCarriedForwardBasis
    : null;
  gaps.push(...appliedAssumptions.map((_, index) => assumptionGaps[index]));
  const resolvedRecords = lossTreatmentPending
    ? records.map(record => (
        record.disposition === 'calculation'
          || record.disposition === 'calculation-assumption'
          || record.disposition === 'structural-principal'
          ? Object.freeze({
              ...record,
              disposition: 'readiness-only',
              reason: 'loss-treatment-pending',
            })
          : record
      ))
    : records;
  const status = blocked
    ? 'blocked'
    : taxableBalance === 0
      ? 'not-applicable'
      : lossTreatmentPending
        ? 'rules-pending'
      : completeConfirmed
        ? 'confirmed'
        : composable && appliedAssumptions.length > 0
          ? 'assumed-50-50'
          : 'incomplete';

  return Object.freeze({
    status,
    taxableBalance,
    basisOverride,
    appliedBasis: basisOverride ?? exactTransientBasis ?? taxableBalance * 0.5,
    appliedMode: appliedAssumptions.length > 0
      ? 'assumed-50-50'
      : exactTransientBasis !== null
        ? 'calculated-carried-forward'
        : basisOverride === null
          ? 'unavailable'
          : hasCalculatedBasis
            ? 'calculated-carried-forward'
            : 'confirmed-or-structural',
    assumptions: Object.freeze(appliedAssumptions),
    accountIds: Object.freeze(accountIds),
    evidence: Object.freeze(evidence),
    records: Object.freeze(resolvedRecords),
    gaps: Object.freeze(gaps),
  });
}

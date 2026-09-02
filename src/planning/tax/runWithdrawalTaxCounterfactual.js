import { TaxInputError } from '../../tax/core/errors.js';
import {
  WITHDRAWAL_BUCKETS,
  WITHDRAWAL_TAX_COALITIONS,
  attributeWithdrawalTaxByBucket,
} from './attributeWithdrawalTaxByBucket.js';
import { runTaxForScenarioPath } from './runTaxForScenarioPath.js';
import { buildRowPlanMetaFromOptions } from './buildPlanMetaFromEngineParams.js';
import {
  buildComparisonEligibility,
  counterfactualSemantics,
  resolveRmdReasons,
  resolveRothReadiness,
  resolveTraditionalReasons,
  retirementBeforeRmdReasons,
} from './withdrawalTaxCounterfactualReadiness.js';

const TOLERANCE = 0.01;

function cloneFreeze(value){
  if(Array.isArray(value)) return Object.freeze(value.map(cloneFreeze));
  if(value && typeof value === 'object'){
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFreeze(item)])
    ));
  }
  return value;
}

function unique(values){
  return [...new Set(values.filter(Boolean))];
}

function assertPlainObject(value, path){
  if(value === null || typeof value !== 'object' || Array.isArray(value)){
    throw new TaxInputError(`${path} must be a plain object`);
  }
  return value;
}

function assertFiniteNonNegative(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new TaxInputError(`${path} must be a finite non-negative number`);
  }
  return value;
}

function assertClose(actual, expected, path){
  if(Math.abs(actual - expected) > TOLERANCE){
    throw new TaxInputError(`${path} does not reconcile`, { actual, expected });
  }
}

function sumBuckets(record){
  return WITHDRAWAL_BUCKETS.reduce((sum, bucket) => sum + record[bucket], 0);
}

function freezeBuckets(record, path){
  assertPlainObject(record, path);
  return Object.freeze(Object.fromEntries(WITHDRAWAL_BUCKETS.map(bucket => [
    bucket,
    assertFiniteNonNegative(record[bucket], `${path}.${bucket}`),
  ])));
}

function resolveTaxLawYear(context, calendarYear){
  if(context.explicitTaxYear !== null){
    if(!context.supportedTaxYears.includes(context.explicitTaxYear)){
      throw new TaxInputError('explicit taxYear is not supported', {
        taxYear: context.explicitTaxYear,
      });
    }
    return context.explicitTaxYear;
  }
  const min = context.supportedTaxYears[0];
  const max = context.supportedTaxYears[context.supportedTaxYears.length - 1];
  return Math.max(min, Math.min(max, calendarYear));
}

function slimLine(line){
  return Object.freeze({
    lineId: line?.lineId ?? null,
    value: line?.value ?? null,
    status: line?.status ?? null,
  });
}

function coverageEntryKey(entry){
  return JSON.stringify([
    entry?.code ?? null,
    entry?.lineId ?? null,
    entry?.label ?? null,
    entry?.notes ?? null,
    entry?.message ?? null,
  ]);
}

function mergeEntries(target, entries){
  for(const entry of entries ?? []){
    const key = coverageEntryKey(entry);
    if(!target.has(key)) target.set(key, cloneFreeze(entry));
  }
}

function mergeTaxCoverage(readyCoalitions){
  if(readyCoalitions.length === 0){
    return cloneFreeze({
      status: 'not-run',
      taxTotalScope: null,
      unsupportedIntentional: [],
      architectureLater: [],
      warnings: [],
    });
  }
  const scopes = new Set();
  const unsupported = new Map();
  const architectureLater = new Map();
  const warnings = new Map();
  for(const coalition of readyCoalitions){
    scopes.add(coalition.taxCoverage.taxTotalScope);
    mergeEntries(unsupported, coalition.taxCoverage.unsupportedIntentional);
    mergeEntries(architectureLater, coalition.taxCoverage.architectureLater);
    mergeEntries(warnings, coalition.taxCoverage.warnings);
  }
  const scope = scopes.size === 1 ? [...scopes][0] : 'MIXED';
  return cloneFreeze({
    status: scope === 'FULL_1040' ? 'full-1040' : 'modeled-income-tax-only',
    taxTotalScope: scope,
    unsupportedIntentional: [...unsupported.values()],
    architectureLater: [...architectureLater.values()],
    warnings: [...warnings.values()],
  });
}

function unavailableResult({
  row,
  context,
  calendarYear,
  taxLawYear,
  reasonCodes,
  withdrawals,
}){
  const taxCoverage = mergeTaxCoverage([]);
  return cloneFreeze({
    schemaVersion: 2,
    status: 'unavailable',
    reasonCodes: unique(reasonCodes),
    calendarYear,
    taxLawYear,
    withdrawals,
    projectionScope: {
      status: context.readiness.scopeReasons.length > 0 ? 'scope-difference' : 'aligned',
      reasonCodes: context.readiness.scopeReasons,
    },
    coalitions: [],
    taxCoverage,
    baselineModeledFederalIncomeTax: null,
    fullCoalitionModeledFederalIncomeTax: null,
    incrementalWithdrawalModeledFederalIncomeTax: null,
    attributedModeledFederalIncomeTaxByBucket: null,
    displayAttributedModeledFederalIncomeTaxByBucket: null,
    fundedFederalTax: row.taxes,
    deltaVsFundedFederalTax: null,
    comparisonEligibility: buildComparisonEligibility(
      row,
      context,
      calendarYear,
      taxCoverage,
      reasonCodes
    ),
    distributionTaxEvidence: null,
    semantics: counterfactualSemantics(row),
  });
}

function runCoalition({
  coalition,
  row,
  context,
  taxLawYear,
  mandatoryRmd,
  taxableCapitalGain,
  discretionaryByBucket,
  reasonCodes,
}){
  const included = new Set(coalition.buckets);
  const coalitionWithdrawals = Object.freeze(Object.fromEntries(
    WITHDRAWAL_BUCKETS.map(bucket => [
      bucket,
      included.has(bucket) ? discretionaryByBucket[bucket] : 0,
    ])
  ));
  if(reasonCodes.length > 0){
    return cloneFreeze({
      id: coalition.id,
      buckets: coalition.buckets,
      status: 'unavailable',
      reasonCodes,
      discretionaryWithdrawalsByBucket: coalitionWithdrawals,
      modeledFederalIncomeTax: null,
      lines: null,
      taxCoverage: null,
      lawVersion: null,
    });
  }

  const coalitionRow = {
    year: row.year,
    filingStatus: row.filingStatus ?? context.planMeta.filingStatus,
    survivor: row.survivor ?? false,
    survivingOwner: row.survivingOwner ?? null,
    socialSecurity: row.socialSecurity,
    pension: row.pension,
    otherIncome: row.otherIncome,
    ...(row.otherIncomeTaxable !== undefined
      ? { otherIncomeTaxable: row.otherIncomeTaxable }
      : {}),
    accountBreakdown: coalitionWithdrawals,
    rmd: mandatoryRmd,
  };
  const identityMeta = buildRowPlanMetaFromOptions({}, {
    people: context.projectedPeople,
    meta: { filingStatus: context.planMeta.filingStatus },
  })?.(coalitionRow) ?? {};
  const planMeta = {
    ...context.planMeta,
    ...identityMeta,
    taxYear: taxLawYear,
    capitalGain: included.has('taxable') ? taxableCapitalGain : 0,
  };
  const { results } = runTaxForScenarioPath([coalitionRow], planMeta, {
    contextOverrides: {
      ...context.contextOverrides,
      taxYear: taxLawYear,
      scenarioId: `${context.scenarioId}_${row.year}_${coalition.id}`,
    },
  });
  const annual = results[0]?.annual1040Result;
  const modeledTax = annual?.lines?.line24?.value;
  if(typeof modeledTax !== 'number' || !Number.isFinite(modeledTax) || modeledTax < 0){
    throw new TaxInputError('counterfactual did not produce Form 1040 line 24', {
      coalition: coalition.id,
    });
  }
  return cloneFreeze({
    id: coalition.id,
    buckets: coalition.buckets,
    status: 'modeled',
    reasonCodes: [],
    discretionaryWithdrawalsByBucket: coalitionWithdrawals,
    modeledFederalIncomeTax: modeledTax,
    lines: {
      line11: slimLine(annual.lines.line11),
      line15: slimLine(annual.lines.line15),
      line16: slimLine(annual.lines.line16),
      line24: slimLine(annual.lines.line24),
    },
    taxCoverage: {
      taxTotalScope: annual.federalSummary?.taxTotalScope ?? null,
      unsupportedIntentional: annual.unsupportedIntentional ?? [],
      architectureLater: annual.architectureLater ?? [],
      warnings: annual.warnings ?? [],
    },
    lawVersion: annual.metadata?.lawVersion ?? null,
  });
}

/**
 * Rerun one completed retirement row under all eight withdrawal coalitions.
 * This never funds a gap, moves a balance, or feeds a result into another year.
 */
export function runWithdrawalTaxCounterfactual(row, context){
  assertPlainObject(row, 'row');
  assertPlainObject(context, 'context');
  if(!Number.isInteger(row.year) || row.year <= 0){
    throw new TaxInputError('row.year must be a positive integer');
  }
  assertFiniteNonNegative(row.age, 'row.age');
  if(row.phase === 'accum' || (row.failed === true && row.source === null)){
    return cloneFreeze({
      schemaVersion: 2,
      status: 'not-applicable',
      reasonCodes: [row.phase === 'accum' ? 'ACCUMULATION_YEAR' : 'DEPLETED_FILLER_YEAR'],
      calendarYear: context.baseCalendarYear + row.year - 1,
      taxLawYear: resolveTaxLawYear(context, context.baseCalendarYear + row.year - 1),
    });
  }

  const grossFundingByBucket = freezeBuckets(row.accountBreakdown, 'row.accountBreakdown');
  const preTaxDeltaFundingByBucket = freezeBuckets(
    row.preTaxDeltaAccountBreakdown,
    'row.preTaxDeltaAccountBreakdown'
  );
  const grossFunding = sumBuckets(grossFundingByBucket);
  assertClose(grossFunding, assertFiniteNonNegative(row.withdrawal, 'row.withdrawal'), 'row.withdrawal');
  const rmdForced = assertFiniteNonNegative(row.rmd, 'row.rmd');
  const rmdRequired = assertFiniteNonNegative(row.rmdRequired, 'row.rmdRequired');
  const maximumRmdForced = Math.max(
    0,
    rmdRequired - grossFundingByBucket.traditional
  );
  if(rmdForced > maximumRmdForced + TOLERANCE){
    throw new TaxInputError('row.rmd exceeds the final-funding forced amount');
  }
  const openingBalances = freezeBuckets(
    row.accountStartingBalances,
    'row.accountStartingBalances'
  );
  const startBalance = assertFiniteNonNegative(row.startBalance, 'row.startBalance');
  assertClose(sumBuckets(openingBalances), startBalance, 'row.accountStartingBalances');
  const taxableStartingBasis = assertFiniteNonNegative(
    row.taxableStartingBasis,
    'row.taxableStartingBasis'
  );
  const taxableCapitalGain = assertFiniteNonNegative(
    row.taxableCapitalGain,
    'row.taxableCapitalGain'
  );
  if(taxableCapitalGain > grossFundingByBucket.taxable + TOLERANCE){
    throw new TaxInputError('row.taxableCapitalGain cannot exceed taxable withdrawals');
  }
  if(grossFundingByBucket.taxable === 0 && taxableCapitalGain !== 0){
    throw new TaxInputError('row.taxableCapitalGain must be zero without taxable withdrawals');
  }
  const fundedFederalTax = assertFiniteNonNegative(row.taxes, 'row.taxes');
  assertFiniteNonNegative(row.socialSecurity, 'row.socialSecurity');
  assertFiniteNonNegative(row.pension, 'row.pension');
  const otherIncome = assertFiniteNonNegative(row.otherIncome, 'row.otherIncome');
  if(otherIncome > 0 && row.otherIncomeTaxable === undefined){
    throw new TaxInputError('row.otherIncomeTaxable is required when otherIncome is positive');
  }
  if(row.otherIncomeTaxable !== undefined){
    const otherIncomeTaxable = assertFiniteNonNegative(
      row.otherIncomeTaxable,
      'row.otherIncomeTaxable'
    );
    if(otherIncomeTaxable > otherIncome + TOLERANCE){
      throw new TaxInputError('row.otherIncomeTaxable cannot exceed row.otherIncome');
    }
  }
  const assetSale = row.assetSale == null
    ? 0
    : assertFiniteNonNegative(row.assetSale, 'row.assetSale');

  const actualTraditional = grossFundingByBucket.traditional + rmdForced;
  const mandatoryRmd = Math.min(rmdRequired, actualTraditional);
  const discretionaryTraditional = actualTraditional - mandatoryRmd;
  const rmdShortfall = Math.max(0, rmdRequired - actualTraditional);
  const discretionaryByBucket = Object.freeze({
    taxable: grossFundingByBucket.taxable,
    traditional: discretionaryTraditional,
    roth: grossFundingByBucket.roth,
  });
  const withdrawals = Object.freeze({
    engineFundingGross: grossFunding,
    preTaxDeltaFundingByBucket,
    rmdForced,
    rmdRequired,
    modeledRmdBaseline: mandatoryRmd,
    rmdShortfall,
    actualTraditionalDistribution: actualTraditional,
    discretionaryByBucket,
    discretionaryTotal: sumBuckets(discretionaryByBucket),
    totalGrossDistributions: grossFunding + rmdForced,
    taxableStartingBasis,
    taxableCapitalGain,
    openingBalances,
  });

  const calendarYear = context.baseCalendarYear + row.year - 1;
  const taxLawYear = resolveTaxLawYear(context, calendarYear);
  const globalReasons = [...context.readiness.globalReasons];
  if(row.failed === true) globalReasons.push('FAILED_PATH_YEAR');
  if(rmdShortfall > TOLERANCE) globalReasons.push('RMD_REQUIREMENT_NOT_SATISFIED');
  if(assetSale > 0) globalReasons.push('ASSET_SALE_TAX_INTERACTION_UNSUPPORTED');
  if(context.planMeta.filingStatus === 'marriedFilingSeparately'
    && row.socialSecurity > 0
    && typeof context.planMeta.socialSecurityWorksheet?.livedWithSpouse !== 'boolean'){
    globalReasons.push('MFS_SOCIAL_SECURITY_LIVED_WITH_SPOUSE_NOT_CONFIRMED');
  }
  globalReasons.push(...retirementBeforeRmdReasons(context));
  const uniqueGlobalReasons = unique(globalReasons);
  if(uniqueGlobalReasons.length > 0){
    return unavailableResult({
      row: { ...row, taxes: fundedFederalTax, taxableCapitalGain },
      context,
      calendarYear,
      taxLawYear,
      reasonCodes: uniqueGlobalReasons,
      withdrawals,
    });
  }

  const baselineRmdReasons = resolveRmdReasons(row, context, mandatoryRmd);
  const traditionalReasons = resolveTraditionalReasons(row, context);
  const rothResolution = resolveRothReadiness(row, context, calendarYear);
  const coalitionResults = [];
  for(const coalition of WITHDRAWAL_TAX_COALITIONS){
    const reasons = [...baselineRmdReasons];
    if(coalition.buckets.includes('taxable') && discretionaryByBucket.taxable > 0){
      reasons.push(...context.readiness.taxable.reasons);
    }
    if(coalition.buckets.includes('traditional') && discretionaryByBucket.traditional > 0){
      reasons.push(...traditionalReasons);
    }
    if(coalition.buckets.includes('roth') && discretionaryByBucket.roth > 0){
      reasons.push(...rothResolution.reasons);
    }
    coalitionResults.push(runCoalition({
      coalition,
      row,
      context,
      taxLawYear,
      mandatoryRmd,
      taxableCapitalGain,
      discretionaryByBucket,
      reasonCodes: unique(reasons),
    }));
  }

  const readyCoalitions = coalitionResults.filter(item => item.status === 'modeled');
  const coalitionReasonCodes = unique(coalitionResults.flatMap(item => item.reasonCodes));
  const taxCoverage = mergeTaxCoverage(readyCoalitions);
  const allCoalitionsReady = readyCoalitions.length === WITHDRAWAL_TAX_COALITIONS.length;
  const status = readyCoalitions.length === 0
    ? 'unavailable'
    : allCoalitionsReady
      ? 'modeled-only'
      : 'partial';

  let attribution = null;
  if(allCoalitionsReady){
    attribution = attributeWithdrawalTaxByBucket(Object.fromEntries(
      readyCoalitions.map(item => [item.id, item.modeledFederalIncomeTax])
    ));
  }
  const baseline = coalitionResults.find(item => item.id === 'none' && item.status === 'modeled');
  const full = coalitionResults.find(item => (
    item.id === 'taxable+traditional+roth' && item.status === 'modeled'
  ));
  const deltaVsFundedFederalTax = full
    ? Math.round(
      (full.modeledFederalIncomeTax - fundedFederalTax + Number.EPSILON) * 100
    ) / 100
    : null;

  return cloneFreeze({
    schemaVersion: 2,
    status,
    reasonCodes: coalitionReasonCodes,
    calendarYear,
    taxLawYear,
    withdrawals,
    projectionScope: {
      status: context.readiness.scopeReasons.length > 0 ? 'scope-difference' : 'aligned',
      reasonCodes: context.readiness.scopeReasons,
    },
    coalitions: coalitionResults,
    taxCoverage,
    baselineModeledFederalIncomeTax: baseline?.modeledFederalIncomeTax ?? null,
    fullCoalitionModeledFederalIncomeTax: full?.modeledFederalIncomeTax ?? null,
    incrementalWithdrawalModeledFederalIncomeTax: attribution?.incrementalTax ?? null,
    attributedModeledFederalIncomeTaxByBucket: attribution?.byBucket ?? null,
    displayAttributedModeledFederalIncomeTaxByBucket: attribution?.displayByBucket ?? null,
    attributionExactSixthCentsByBucket: attribution?.exactSixthCentsByBucket ?? null,
    attributionReconciliation: attribution?.reconciliation ?? null,
    attributionDisplayReconciliation: attribution?.displayReconciliation ?? null,
    fundedFederalTax,
    deltaVsFundedFederalTax,
    comparisonEligibility: buildComparisonEligibility(
      { ...row, taxableCapitalGain },
      context,
      calendarYear,
      taxCoverage,
      coalitionReasonCodes
    ),
    distributionTaxEvidence: {
      roth: {
        rule: rothResolution.rule,
        accounts: rothResolution.evidence,
      },
    },
    semantics: {
      ...counterfactualSemantics(row),
      attribution: attribution?.method ?? null,
    },
  });
}

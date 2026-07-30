import {
  FILING_STATUSES,
  ITEMIZED_DEDUCTION_LIMIT,
  ITEMIZED_DEDUCTION_SOURCE,
} from '../../core/constants.js';
import { CONTEXT_SCHEMA } from '../../core/schemas.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';
import {
  assertNonNegativeNumber,
  assertOneOf,
  validateAgainstSchema,
} from '../../core/validators.js';

export const meta = {
  ruleId: 'FED_OVERALL_ITEMIZED_DEDUCTION_LIMIT',
  ruleVersion: '1.0.0',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'itemized_deduction',
  authority: [
    'IRC section 68',
    'P.L. 119-21 section 70111',
    'IRS Publication 505 (2026), Worksheet 2-6',
  ],
  dataSourcesRequired: [
    'IRS_2025_SCHEDULE_A_ITEMIZED_v1.0',
    'IRC_68_2026_ITEMIZED_LIMIT_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70111_2026_v1.0',
  ],
  inputsRequired: [
    'filingStatus',
    'itemizedDeductionsBeforeOverallLimit',
    'adjustedGrossIncome',
  ],
  outputs: [
    'allowedItemizedDeductions',
    'overallLimitationReduction',
    'preItemizedTaxableIncome',
    'exactReductionFraction',
  ],
  limitations: [
    'Category-specific Schedule A limitations must be applied before this rule',
    'QBI and Schedule 1-A amounts must be explicit when absence could change the 2026 threshold result',
    'Qualifying surviving spouse (QSS) is deferred because the filing-status contract does not currently support it',
  ],
  triggerTags: ['itemized_deduction', 'agi_threshold'],
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const OVERALL_ITEMIZED_DEPENDENCIES_MISSING =
  'OVERALL_ITEMIZED_DEPENDENCIES_MISSING';

export function validate(input){
  if(!input || typeof input !== 'object' || Array.isArray(input)){
    throw new TaxInputError('overallItemizedDeductionLimit input must be a plain object');
  }
  assertOneOf(
    input.filingStatus,
    FILING_STATUSES,
    'filingStatus',
    'overallItemizedDeductionLimit input'
  );
  assertNonNegativeNumber(
    input.itemizedDeductionsBeforeOverallLimit,
    'itemizedDeductionsBeforeOverallLimit',
    'overallItemizedDeductionLimit input'
  );
  if(typeof input.adjustedGrossIncome !== 'number'
      || !Number.isFinite(input.adjustedGrossIncome)){
    throw new TaxInputError(
      'overallItemizedDeductionLimit input adjustedGrossIncome must be finite'
    );
  }
  for(const field of ['qualifiedBusinessIncomeDeduction', 'schedule1ADeduction']){
    if(input[field] === undefined) continue;
    assertNonNegativeNumber(
      input[field],
      field,
      'overallItemizedDeductionLimit input'
    );
  }
  return input;
}

function resolveSource(context){
  const dataSourceId = ITEMIZED_DEDUCTION_SOURCE[context.lawVersion];
  if(!dataSourceId){
    throw new TaxDataError(
      `No itemized deduction source for lawVersion: ${context.lawVersion}`
    );
  }
  const dataSourceIds = [
    dataSourceId,
    ...(context.lawVersion === '2026_FINAL'
      ? ['PUBLIC_LAW_119_21_SECTION_70111_2026_v1.0']
      : []),
  ];
  for(const resolvedSourceId of dataSourceIds){
    const dataSource = getDataSource(resolvedSourceId);
    if(dataSource.taxYear !== context.taxYear
        || dataSource.lawVersion !== context.lawVersion){
      throw new TaxInputError(
        'context does not match the overall itemized-deduction data source'
      );
    }
  }
  return dataSourceIds;
}

export function calculate(input, context){
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');
  const dataSourceIds = resolveSource(context);
  const law = ITEMIZED_DEDUCTION_LIMIT[context.lawVersion];
  const before = input.itemizedDeductionsBeforeOverallLimit;
  if(law === null){
    const result = {
      allowedItemizedDeductions: round2(before),
      overallLimitationReduction: 0,
      preItemizedTaxableIncome: null,
      exactReductionFraction: null,
      limitationApplied: false,
    };
    return {
      result,
      audit: {
        ruleId: meta.ruleId,
        ruleVersion: meta.ruleVersion,
        taxYear: context.taxYear,
        lawVersion: context.lawVersion,
        calculatedAt: context.calculatedAt,
        runId: context.runId,
        scenarioId: context.scenarioId,
        inputsUsed: { ...input },
        dataSourcesUsed: dataSourceIds,
        calculationSteps: [{ step: 'no_overall_limit_for_year', amount: before }],
        authority: meta.authority,
        limitations: meta.limitations,
      },
    };
  }
  if(!law){
    throw new TaxDataError(
      `No overall itemized-deduction law for lawVersion: ${context.lawVersion}`
    );
  }

  const threshold = law.threshold[input.filingStatus];
  const qbiKnown = input.qualifiedBusinessIncomeDeduction !== undefined;
  const schedule1AKnown = input.schedule1ADeduction !== undefined;
  const exactReductionFraction = {
    numerator: law.reductionNumerator,
    denominator: law.reductionDenominator,
  };
  const exactReductionRate =
    exactReductionFraction.numerator / exactReductionFraction.denominator;
  const maximumPossibleBase = input.adjustedGrossIncome
    - (qbiKnown ? input.qualifiedBusinessIncomeDeduction : 0)
    - (schedule1AKnown ? input.schedule1ADeduction : 0);
  if(before === 0){
    const factsComplete = qbiKnown && schedule1AKnown;
    const preItemizedTaxableIncome = factsComplete
      ? round2(maximumPossibleBase)
      : null;
    const excessOverThreshold = factsComplete
      ? round2(Math.max(0, maximumPossibleBase - threshold))
      : null;
    const missing = [
      ...(!qbiKnown ? ['qualifiedBusinessIncomeDeduction'] : []),
      ...(!schedule1AKnown ? ['schedule1ADeduction'] : []),
    ];
    const result = {
      allowedItemizedDeductions: 0,
      overallLimitationReduction: 0,
      preItemizedTaxableIncome,
      threshold,
      excessOverThreshold,
      exactReductionFraction,
      exactReductionRate,
      limitationApplied: false,
    };
    return {
      result,
      audit: {
        ruleId: meta.ruleId,
        ruleVersion: meta.ruleVersion,
        taxYear: context.taxYear,
        lawVersion: context.lawVersion,
        calculatedAt: context.calculatedAt,
        runId: context.runId,
        scenarioId: context.scenarioId,
        inputsUsed: { ...input },
        dataSourcesUsed: dataSourceIds,
        calculationSteps: [{
          step: 'zero_pre_limit_itemized_deductions',
          missing,
          threshold,
          exactReductionFraction,
          allowedItemizedDeductions: 0,
          overallLimitationReduction: 0,
        }],
        authority: meta.authority,
        limitations: meta.limitations,
      },
    };
  }
  if(maximumPossibleBase > threshold && (!qbiKnown || !schedule1AKnown)){
    const missing = [
      ...(!qbiKnown ? ['qualifiedBusinessIncomeDeduction'] : []),
      ...(!schedule1AKnown ? ['schedule1ADeduction'] : []),
    ];
    throw new TaxInputError(
      `2026 overall itemized deduction limit requires explicit ${missing.join(' and ')}`,
      {
        code: OVERALL_ITEMIZED_DEPENDENCIES_MISSING,
        missing,
        maximumPossibleBase,
        threshold,
      }
    );
  }

  const factsComplete = qbiKnown && schedule1AKnown;
  const preItemizedTaxableIncome = factsComplete
    ? maximumPossibleBase
    : null;
  const excessOverThreshold = factsComplete
    ? Math.max(0, preItemizedTaxableIncome - threshold)
    : 0;
  const lesserAmount = Math.min(before, excessOverThreshold);
  const overallLimitationReduction = round2(lesserAmount * exactReductionRate);
  const allowedItemizedDeductions = round2(Math.max(
    0,
    before - overallLimitationReduction
  ));
  const result = {
    allowedItemizedDeductions,
    overallLimitationReduction,
    preItemizedTaxableIncome: preItemizedTaxableIncome === null
      ? null
      : round2(preItemizedTaxableIncome),
    threshold,
    excessOverThreshold: round2(excessOverThreshold),
    exactReductionFraction,
    exactReductionRate,
    limitationApplied: overallLimitationReduction > 0,
  };
  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: { ...input },
    dataSourcesUsed: dataSourceIds,
    calculationSteps: [
      {
        step: 'pre_itemized_taxable_income',
        adjustedGrossIncome: input.adjustedGrossIncome,
        qualifiedBusinessIncomeDeduction:
          input.qualifiedBusinessIncomeDeduction ?? null,
        schedule1ADeduction: input.schedule1ADeduction ?? null,
        preItemizedTaxableIncome: result.preItemizedTaxableIncome,
        maximumPossibleBase,
      },
      {
        step: 'overall_limit',
        threshold,
        excessOverThreshold: result.excessOverThreshold,
        lesserAmount,
        exactFraction: `${law.reductionNumerator}/${law.reductionDenominator}`,
        exactReductionFraction,
        exactReductionRate,
        overallLimitationReduction,
        allowedItemizedDeductions,
      },
    ],
    authority: meta.authority,
    limitations: meta.limitations,
  };
  return { result, audit };
}

export const overallItemizedDeductionLimit = { meta, validate, calculate };

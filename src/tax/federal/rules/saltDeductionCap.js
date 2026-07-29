import {
  FILING_STATUSES,
  SALT_DEDUCTION,
  SALT_DEDUCTION_SOURCES,
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
  ruleId: 'FED_SALT_DEDUCTION_CAP',
  ruleVersion: '2.0.0',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'salt_deduction',
  authority: [
    'P.L. 119-21 section 70120',
    'IRS Instructions for Schedule A (2025)',
    'IRS Publication 505 (2026)',
  ],
  dataSourcesRequired: [
    'IRS_2025_SCHEDULE_A_SALT_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70120_2025_v1.0',
    'IRS_2026_PUBLICATION_505_SALT_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70120_2026_v1.0',
  ],
  inputsRequired: [
    'filingStatus',
    'eligibleTaxesPaid',
    'modifiedAdjustedGrossIncome',
  ],
  outputs: [
    'saltDeduction',
    'filingStatusLimit',
    'unhalvedLimit',
    'phaseoutReduction',
  ],
  limitations: [
    'Input must already contain only taxes eligible for the federal Schedule A SALT line',
    'MFS input must be attributable to the modeled separate return',
  ],
  triggerTags: ['salt_deduction', 'agi_threshold', 'itemized_deduction'],
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function validate(input){
  if(!input || typeof input !== 'object' || Array.isArray(input)){
    throw new TaxInputError('saltDeduction input must be a plain object');
  }
  assertOneOf(input.filingStatus, FILING_STATUSES, 'filingStatus', 'saltDeduction input');
  assertNonNegativeNumber(
    input.eligibleTaxesPaid,
    'eligibleTaxesPaid',
    'saltDeduction input'
  );
  if(typeof input.modifiedAdjustedGrossIncome !== 'number'
      || !Number.isFinite(input.modifiedAdjustedGrossIncome)){
    throw new TaxInputError(
      'saltDeduction input modifiedAdjustedGrossIncome must be finite'
    );
  }
  return input;
}

function resolveLaw(context){
  const law = SALT_DEDUCTION[context.lawVersion];
  const dataSourceIds = SALT_DEDUCTION_SOURCES[context.lawVersion];
  if(!law || !Array.isArray(dataSourceIds) || dataSourceIds.length === 0){
    throw new TaxDataError(
      `No SALT deduction data for lawVersion: ${context.lawVersion}`
    );
  }
  for(const dataSourceId of dataSourceIds){
    const dataSource = getDataSource(dataSourceId);
    if(dataSource.taxYear !== context.taxYear
        || dataSource.lawVersion !== context.lawVersion){
      throw new TaxInputError(
        'context does not match the SALT deduction data source'
      );
    }
  }
  return { law, dataSourceIds };
}

export function calculate(input, context){
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');
  const { law, dataSourceIds } = resolveLaw(context);
  const isMfs = input.filingStatus === 'marriedFilingSeparately';
  const phaseoutThreshold = isMfs
    ? law.phaseoutStart.marriedFilingSeparately
    : law.phaseoutStart.default;
  const phaseoutExcess = Math.max(
    0,
    input.modifiedAdjustedGrossIncome - phaseoutThreshold
  );
  const phaseoutReduction = round2(phaseoutExcess * law.phaseoutRate);
  const unhalvedLimit = round2(Math.max(
    law.fullFloor,
    law.fullCap - phaseoutReduction
  ));
  // IRS Schedule A computes the full cap/floor worksheet first, then halves
  // its result for MFS. This produces an effective 15% MFS phaseout slope.
  const filingStatusLimit = round2(isMfs ? unhalvedLimit / 2 : unhalvedLimit);
  const saltDeduction = round2(Math.min(
    input.eligibleTaxesPaid,
    filingStatusLimit
  ));
  const result = {
    saltDeduction,
    filingStatusLimit,
    unhalvedLimit,
    phaseoutThreshold,
    phaseoutExcess: round2(phaseoutExcess),
    phaseoutReduction,
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
        step: 'full_cap_phaseout',
        fullCap: law.fullCap,
        fullFloor: law.fullFloor,
        phaseoutThreshold,
        phaseoutExcess: result.phaseoutExcess,
        phaseoutRate: law.phaseoutRate,
        phaseoutReduction,
        unhalvedLimit,
      },
      {
        step: 'filing_status_limit',
        marriedFilingSeparately: isMfs,
        filingStatusLimit,
      },
      {
        step: 'allowed_salt_deduction',
        eligibleTaxesPaid: input.eligibleTaxesPaid,
        saltDeduction,
      },
    ],
    authority: meta.authority,
    limitations: meta.limitations,
  };
  return { result, audit };
}

export const saltDeductionCap = { meta, validate, calculate };

import {
  ENHANCED_SENIOR_DEDUCTION,
  ENHANCED_SENIOR_DEDUCTION_SOURCES,
  FILING_STATUSES,
} from '../../core/constants.js';
import { CONTEXT_SCHEMA } from '../../core/schemas.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';
import {
  activeTaxpayerOwnersForReturn,
  isAge65ByTaxYearEnd,
  isValidTaxDate,
} from '../../core/taxpayerAge.js';
import {
  assertOneOf,
  validateAgainstSchema,
} from '../../core/validators.js';

export const meta = {
  ruleId: 'FED_ENHANCED_SENIOR_DEDUCTION',
  ruleVersion: '1.0.0',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'enhanced_senior_deduction',
  authority: [
    'P.L. 119-21 section 70103',
    'IRS 2025 Schedule 1-A, Part V',
    'IRS Publication 505 (2026)',
  ],
  dataSourcesRequired: [
    'IRS_2025_SCHEDULE_1A_SENIOR_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70103_2025_v1.0',
    'IRS_2026_PUBLICATION_505_SENIOR_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70103_2026_v1.0',
  ],
  inputsRequired: [
    'filingStatus',
    'modifiedAdjustedGrossIncome',
    'taxpayers',
  ],
  outputs: [
    'enhancedSeniorDeduction',
    'eligiblePersonCount',
    'deductionPerEligiblePerson',
  ],
  limitations: [
    'Engine mode calculates only the enhanced senior component of Schedule 1-A',
    'MFS is ineligible',
    'MAGI must already include any IRC sections 911, 931, and 933 add-backs',
  ],
  triggerTags: ['enhanced_senior_deduction', 'agi_threshold'],
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function validate(input, context){
  if(!input || typeof input !== 'object' || Array.isArray(input)){
    throw new TaxInputError('enhancedSeniorDeduction input must be a plain object');
  }
  assertOneOf(
    input.filingStatus,
    FILING_STATUSES,
    'filingStatus',
    'enhancedSeniorDeduction input'
  );
  if(input.filingStatus === 'marriedFilingSeparately'){
    throw new TaxInputError(
      'enhanced senior deduction is unavailable for married filing separately'
    );
  }
  if(typeof input.modifiedAdjustedGrossIncome !== 'number'
      || !Number.isFinite(input.modifiedAdjustedGrossIncome)){
    throw new TaxInputError(
      'enhancedSeniorDeduction input modifiedAdjustedGrossIncome must be finite'
    );
  }
  if(!input.taxpayers || typeof input.taxpayers !== 'object'
      || Array.isArray(input.taxpayers)){
    throw new TaxInputError('enhancedSeniorDeduction input taxpayers must be an object');
  }
  const owners = activeTaxpayerOwnersForReturn(
    input.filingStatus,
    input.modeledTaxpayer
  );
  for(const owner of owners){
    const taxpayer = input.taxpayers[owner];
    if(!taxpayer || typeof taxpayer !== 'object' || Array.isArray(taxpayer)){
      throw new TaxInputError(
        `enhancedSeniorDeduction input is missing taxpayers.${owner}`
      );
    }
    if(!isValidTaxDate(taxpayer.birthDate)){
      throw new TaxInputError(
        `enhancedSeniorDeduction input taxpayers.${owner}.birthDate must be a valid YYYY-MM-DD date`
      );
    }
    const age65OrOlder = context === undefined
      ? null
      : isAge65ByTaxYearEnd(taxpayer.birthDate, context.taxYear);
    if(taxpayer.validSsnForEnhancedSeniorDeduction !== undefined
        && typeof taxpayer.validSsnForEnhancedSeniorDeduction !== 'boolean'){
      throw new TaxInputError(
        `enhancedSeniorDeduction input taxpayers.${owner}.validSsnForEnhancedSeniorDeduction must be a boolean when supplied`
      );
    }
    if(age65OrOlder === true
        && typeof taxpayer.validSsnForEnhancedSeniorDeduction !== 'boolean'){
      throw new TaxInputError(
        `enhancedSeniorDeduction input taxpayers.${owner}.validSsnForEnhancedSeniorDeduction is required for an age-eligible person`
      );
    }
  }
  return input;
}

function resolveLaw(context){
  const law = ENHANCED_SENIOR_DEDUCTION[context.lawVersion];
  const dataSourceIds =
    ENHANCED_SENIOR_DEDUCTION_SOURCES[context.lawVersion];
  if(!law || !Array.isArray(dataSourceIds) || dataSourceIds.length === 0){
    throw new TaxDataError(
      `No enhanced senior deduction data for lawVersion: ${context.lawVersion}`,
      { lawVersion: context.lawVersion }
    );
  }
  for(const dataSourceId of dataSourceIds){
    const dataSource = getDataSource(dataSourceId);
    if(dataSource.taxYear !== context.taxYear
        || dataSource.lawVersion !== context.lawVersion){
      throw new TaxInputError(
        'context does not match the enhanced senior deduction data source',
        {
          contextTaxYear: context.taxYear,
          contextLawVersion: context.lawVersion,
          dataSourceId,
          dataSourceTaxYear: dataSource.taxYear,
          dataSourceLawVersion: dataSource.lawVersion,
        }
      );
    }
  }
  return { law, dataSourceIds };
}

export function calculate(input, context){
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');
  validate(input, context);
  const { law, dataSourceIds } = resolveLaw(context);
  const threshold = law.phaseoutStart[input.filingStatus];
  if(threshold === undefined){
    throw new TaxDataError(
      `No enhanced senior phaseout threshold for filingStatus: ${input.filingStatus}`
    );
  }

  const phaseoutExcess = Math.max(
    0,
    input.modifiedAdjustedGrossIncome - threshold
  );
  const perPersonPhaseout = round2(phaseoutExcess * law.phaseoutRate);
  const deductionPerEligiblePerson = round2(Math.max(
    0,
    law.amountPerEligiblePerson - perPersonPhaseout
  ));
  const owners = activeTaxpayerOwnersForReturn(
    input.filingStatus,
    input.modeledTaxpayer
  );
  const eligibility = owners.map((owner) => {
    const taxpayer = input.taxpayers[owner];
    const age65OrOlder = isAge65ByTaxYearEnd(
      taxpayer.birthDate,
      context.taxYear
    );
    const validSsn = taxpayer.validSsnForEnhancedSeniorDeduction;
    return {
      owner,
      birthDate: taxpayer.birthDate,
      age65OrOlder,
      validSsn,
      eligible: age65OrOlder && validSsn === true,
    };
  });
  const eligiblePersonCount = eligibility.filter(entry => entry.eligible).length;
  const enhancedSeniorDeduction = round2(
    eligiblePersonCount * deductionPerEligiblePerson
  );

  const result = {
    enhancedSeniorDeduction,
    eligiblePersonCount,
    deductionPerEligiblePerson,
    phaseoutThreshold: threshold,
    phaseoutExcess: round2(phaseoutExcess),
    perPersonPhaseout,
    eligibility,
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
        step: 'per_person_phaseout',
        threshold,
        phaseoutExcess: result.phaseoutExcess,
        rate: law.phaseoutRate,
        perPersonPhaseout,
        deductionPerEligiblePerson,
      },
      ...eligibility.map(entry => ({ step: 'person_eligibility', ...entry })),
      {
        step: 'enhanced_senior_total',
        eligiblePersonCount,
        enhancedSeniorDeduction,
      },
    ],
    authority: meta.authority,
    limitations: meta.limitations,
  };
  return { result, audit };
}

export const enhancedSeniorDeduction = { meta, validate, calculate };

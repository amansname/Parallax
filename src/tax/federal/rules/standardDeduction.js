/* ============================================================================
   RULE: Federal Standard Deduction (FED_STANDARD_DEDUCTION)

   Returns the base standard deduction plus supported age/blind additions.
   Dependent, dual-status, and special nonfiling-spouse cases remain blocked.
   ============================================================================ */

import {
  FILING_STATUSES,
  STANDARD_DEDUCTION,
  STANDARD_DEDUCTION_AGE_BLIND,
  STANDARD_DEDUCTION_SOURCE,
} from '../../core/constants.js';
import { CONTEXT_SCHEMA, STANDARD_DEDUCTION_INPUT_SCHEMA } from '../../core/schemas.js';
import { validateAgainstSchema, assertOneOf } from '../../core/validators.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';
import {
  activeTaxpayerOwnersForReturn,
  isAge65ByTaxYearEnd,
  isValidTaxDate,
} from '../../core/taxpayerAge.js';

export const meta = {
  ruleId: 'FED_STANDARD_DEDUCTION',
  ruleVersion: '2.1.0',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'standard_deduction',
  authority: [
    'IRC section 63(c)',
    'IRS 2025 Publication 501',
    'IRS Publication 505 (2026), Worksheet 2-4',
  ],
  dataSourcesRequired: [
    'IRS_2025_FORM_1040_STANDARD_DEDUCTION_v2.0',
    'IRS_2026_PUBLICATION_505_STANDARD_DEDUCTION_v1.0',
  ],
  inputsRequired: ['filingStatus'],
  outputs: [
    'baseStandardDeduction',
    'additionalStandardDeduction',
    'standardDeduction',
    'ageBlindCheckCount',
  ],
  limitations: [
    'Strict canonical calculation requires explicit confirmation that dependent and dual-status rules do not apply',
    'The base-and-age scope calculates only the base amount and DOB-proven age additions',
    'Legacy callers that omit taxpayer facts receive the base amount only',
    'Does not award special age/blind amounts for a nonfiling MFS spouse',
  ],
  triggerTags: ['standard_deduction', 'agi_threshold'],
};

const BASE_AND_AGE_SCOPE = 'base-and-age';
const BASE_AND_AGE_FILING_STATUSES = [
  'single',
  'marriedFilingJointly',
  'headOfHousehold',
];

function validateBaseAndAgeScope(input){
  assertOneOf(
    input.filingStatus,
    BASE_AND_AGE_FILING_STATUSES,
    'filingStatus',
    'base-and-age standardDeduction input'
  );
  for(const field of ['standardEligibility', 'spouseItemizes']){
    if(Object.hasOwn(input, field)){
      throw new TaxInputError(
        `base-and-age standardDeduction input cannot include ${field}`,
        { field }
      );
    }
  }
  if(!input.taxpayers || typeof input.taxpayers !== 'object'
      || Array.isArray(input.taxpayers)){
    throw new TaxInputError(
      'base-and-age standardDeduction input requires taxpayers'
    );
  }
  const owners = activeTaxpayerOwnersForReturn(input.filingStatus);
  for(const owner of owners){
    const taxpayer = input.taxpayers[owner];
    if(taxpayer && typeof taxpayer === 'object' && !Array.isArray(taxpayer)
        && Object.hasOwn(taxpayer, 'blind')){
      throw new TaxInputError(
        `base-and-age standardDeduction input cannot include taxpayers.${owner}.blind`,
        { owner }
      );
    }
  }
  for(const owner of owners){
    const taxpayer = input.taxpayers[owner];
    if(!taxpayer || typeof taxpayer !== 'object' || Array.isArray(taxpayer)){
      throw new TaxInputError(
        `base-and-age standardDeduction input is missing taxpayers.${owner}`
      );
    }
    if(!isValidTaxDate(taxpayer.birthDate)){
      throw new TaxInputError(
        `base-and-age standardDeduction input taxpayers.${owner}.birthDate must be a valid YYYY-MM-DD date`
      );
    }
  }
  return input;
}

export function validate(input){
  validateAgainstSchema(input, STANDARD_DEDUCTION_INPUT_SCHEMA, 'standardDeduction input');
  assertOneOf(input.filingStatus, FILING_STATUSES, 'filingStatus', 'standardDeduction input');
  if(input.standardScope !== undefined){
    if(input.standardScope !== BASE_AND_AGE_SCOPE){
      throw new TaxInputError(
        `standardDeduction input standardScope must be ${BASE_AND_AGE_SCOPE}`,
        { standardScope: input.standardScope }
      );
    }
    return validateBaseAndAgeScope(input);
  }
  if(input.taxpayers === undefined) return input;
  if(!input.standardEligibility || typeof input.standardEligibility !== 'object'
      || Array.isArray(input.standardEligibility)){
    throw new TaxInputError(
      'standardDeduction input requires standardEligibility with taxpayer facts'
    );
  }
  if(input.standardEligibility.anyActiveTaxpayerCanBeClaimedAsDependent !== false){
    throw new TaxInputError(
      'dependent standard-deduction calculation is not supported by this rule'
    );
  }
  if(input.standardEligibility.anyActiveTaxpayerIsDualStatusAlien !== false){
    throw new TaxInputError(
      'dual-status standard-deduction calculation is not supported by this rule'
    );
  }
  if(input.filingStatus === 'marriedFilingSeparately'
      && typeof input.spouseItemizes !== 'boolean'){
    throw new TaxInputError(
      'standardDeduction input spouseItemizes must be an explicit boolean for married filing separately'
    );
  }
  const owners = activeTaxpayerOwnersForReturn(
    input.filingStatus,
    input.modeledTaxpayer
  );
  for(const owner of owners){
    const taxpayer = input.taxpayers[owner];
    if(!taxpayer || typeof taxpayer !== 'object' || Array.isArray(taxpayer)){
      throw new TaxInputError(`standardDeduction input is missing taxpayers.${owner}`);
    }
    if(!isValidTaxDate(taxpayer.birthDate)){
      throw new TaxInputError(
        `standardDeduction input taxpayers.${owner}.birthDate must be a valid YYYY-MM-DD date`
      );
    }
    if(typeof taxpayer.blind !== 'boolean'){
      throw new TaxInputError(
        `standardDeduction input taxpayers.${owner}.blind must be a boolean`
      );
    }
  }
  return input;
}

function resolveAmount(context, filingStatus){
  const table = STANDARD_DEDUCTION[context.lawVersion];
  if(!table){
    throw new TaxDataError(`No standard deduction table for lawVersion: ${context.lawVersion}`, {
      lawVersion: context.lawVersion,
    });
  }
  const amount = table[filingStatus];
  if(amount === undefined){
    throw new TaxDataError(`No standard deduction for filingStatus: ${filingStatus}`, {
      lawVersion: context.lawVersion,
      filingStatus,
    });
  }

  const dataSourceId = STANDARD_DEDUCTION_SOURCE[context.lawVersion];
  if(!dataSourceId){
    throw new TaxDataError(`No standard deduction data source mapped for lawVersion: ${context.lawVersion}`, {
      lawVersion: context.lawVersion,
    });
  }
  const dataSource = getDataSource(dataSourceId);
  if(context.lawVersion !== dataSource.lawVersion){
    throw new TaxInputError('context.lawVersion does not match the resolved standard deduction data source', {
      contextLawVersion: context.lawVersion,
      dataSourceLawVersion: dataSource.lawVersion,
    });
  }
  if(context.taxYear !== dataSource.taxYear){
    throw new TaxInputError('context.taxYear does not match the resolved standard deduction data source tax year', {
      contextTaxYear: context.taxYear,
      dataSourceTaxYear: dataSource.taxYear,
    });
  }

  const ageBlind = STANDARD_DEDUCTION_AGE_BLIND[context.lawVersion];
  if(!ageBlind){
    throw new TaxDataError(
      `No age/blind standard deduction table for lawVersion: ${context.lawVersion}`,
      { lawVersion: context.lawVersion }
    );
  }

  return { amount, ageBlind, dataSourceId };
}

export function calculate(input, context){
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');

  const { amount, ageBlind, dataSourceId } = resolveAmount(context, input.filingStatus);
  const taxpayersSupplied = input.taxpayers !== undefined;
  const baseAndAgeScope = input.standardScope === BASE_AND_AGE_SCOPE;
  const owners = taxpayersSupplied
    ? activeTaxpayerOwnersForReturn(input.filingStatus, input.modeledTaxpayer)
    : [];
  const perCheck = input.filingStatus === 'single'
      || input.filingStatus === 'headOfHousehold'
    ? ageBlind.unmarriedPerCheck
    : ageBlind.marriedPerCheck;
  let ageBlindCheckCount = 0;
  const personChecks = [];
  for(const owner of owners){
    const taxpayer = input.taxpayers[owner];
    const age65OrOlder = isAge65ByTaxYearEnd(taxpayer.birthDate, context.taxYear);
    const blind = baseAndAgeScope ? undefined : taxpayer.blind;
    const checkCount = Number(age65OrOlder) + (
      baseAndAgeScope ? 0 : Number(blind)
    );
    ageBlindCheckCount += checkCount;
    const personCheck = {
      owner,
      birthDate: taxpayer.birthDate,
      age65OrOlder,
      checkCount,
    };
    if(!baseAndAgeScope) personCheck.blind = blind;
    personChecks.push(personCheck);
  }
  const spouseItemizesDisallowance = !baseAndAgeScope
    && input.filingStatus === 'marriedFilingSeparately'
    && input.spouseItemizes === true;
  const additionalStandardDeduction = spouseItemizesDisallowance
    ? 0
    : ageBlindCheckCount * perCheck;
  const standardDeductionAmount = spouseItemizesDisallowance
    ? 0
    : amount + additionalStandardDeduction;

  const result = {
    baseStandardDeduction: spouseItemizesDisallowance ? 0 : amount,
    additionalStandardDeduction,
    standardDeduction: standardDeductionAmount,
    ageBlindCheckCount,
    perAgeBlindCheck: perCheck,
    spouseItemizesDisallowance,
  };
  const baseAndAgeTaxpayers = baseAndAgeScope
    ? Object.fromEntries(owners.map(owner => [
      owner,
      { birthDate: input.taxpayers[owner].birthDate },
    ]))
    : null;

  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: baseAndAgeScope
      ? {
        filingStatus: input.filingStatus,
        standardScope: input.standardScope,
        taxpayers: baseAndAgeTaxpayers,
      }
      : {
        filingStatus: input.filingStatus,
        modeledTaxpayer: input.modeledTaxpayer ?? null,
        spouseItemizes: input.spouseItemizes ?? null,
        taxpayers: input.taxpayers ?? null,
        standardEligibility: input.standardEligibility ?? null,
      },
    dataSourcesUsed: [dataSourceId],
    calculationSteps: [
      { step: 'base_standard_deduction', filingStatus: input.filingStatus, amount },
      ...personChecks.map(entry => ({
        step: baseAndAgeScope ? 'age_checks' : 'age_blind_checks',
        ...entry,
      })),
      {
        step: 'standard_deduction_total',
        perCheck,
        ageBlindCheckCount,
        additionalStandardDeduction,
        spouseItemizesDisallowance,
        standardDeduction: standardDeductionAmount,
      },
    ],
    authority: meta.authority,
    limitations: meta.limitations,
  };

  return { result, audit };
}

export const standardDeduction = { meta, validate, calculate };

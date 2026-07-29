import {
  CLIENT_1040_DEDUCTION_METHODS,
  CLIENT_1040_DEDUCTION_SOURCES,
  CLIENT_1040_MAGI_MODES,
  CLIENT_1040_SCHEDULE_1A_MODES,
  CLIENT_1040_STANDARD_DEDUCTION_SCOPES,
  ITEMIZED_AMOUNT_FIELDS,
} from './client1040IntakeContractConstants.js';
import {
  activeTaxpayerOwners,
  hasOwn,
  issue,
  rejectUnexpectedKeys,
  requireFinite,
  requireNonNegative,
  requirePlainObject,
  validateTaxpayerRecord,
} from './client1040IntakeContractShared.js';

function validateMagiSource(errors, magi, path){
  if(!requirePlainObject(errors, magi, path)) return;
  if(!CLIENT_1040_MAGI_MODES.includes(magi.mode)){
    issue(errors, 'INVALID_MAGI_MODE',
      `${path}.mode must be supplied-magi or line11b-no-exclusions`,
      `${path}.mode`);
    return;
  }
  if(magi.mode === 'supplied-magi'){
    rejectUnexpectedKeys(errors, magi, ['mode', 'amount'], path, 'MAGI_SOURCE_CONFLICT');
    requireFinite(errors, magi.amount, `${path}.amount`);
    return;
  }
  rejectUnexpectedKeys(errors, magi, [
    'mode',
    'noForeignOrTerritorialExclusionsConfirmed',
    'completeReturnIncomeConfirmed',
  ], path, 'MAGI_SOURCE_CONFLICT');
  if(magi.noForeignOrTerritorialExclusionsConfirmed !== true){
    issue(errors, 'MISSING_MAGI_EXCLUSION_CONFIRMATION',
      `${path}.noForeignOrTerritorialExclusionsConfirmed must be true`,
      `${path}.noForeignOrTerritorialExclusionsConfirmed`);
  }
  if(magi.completeReturnIncomeConfirmed !== true){
    issue(errors, 'MISSING_LINE11B_COMPLETENESS_CONFIRMATION',
      `${path}.completeReturnIncomeConfirmed must be true before using calculated line 11b`,
      `${path}.completeReturnIncomeConfirmed`);
  }
}

function validateItemizedDetails(errors, itemized){
  if(!requirePlainObject(errors, itemized, 'deductions.itemized')) return;
  rejectUnexpectedKeys(errors, itemized, [
    ...ITEMIZED_AMOUNT_FIELDS,
    'salt',
  ], 'deductions.itemized', 'UNKNOWN_CANONICAL_FIELD');
  for(const field of ITEMIZED_AMOUNT_FIELDS){
    requireNonNegative(errors, itemized[field], `deductions.itemized.${field}`);
  }

  const salt = itemized.salt;
  if(!requirePlainObject(errors, salt, 'deductions.itemized.salt')) return;
  rejectUnexpectedKeys(errors, salt, ['eligibleTaxesPaid', 'magi'],
    'deductions.itemized.salt', 'UNKNOWN_CANONICAL_FIELD');
  requireNonNegative(errors, salt.eligibleTaxesPaid,
    'deductions.itemized.salt.eligibleTaxesPaid');
  validateMagiSource(errors, salt.magi, 'deductions.itemized.salt.magi');

  if(hasOwn(itemized, 'total') || hasOwn(itemized, 'itemizedAmount')){
    issue(errors, 'ITEMIZED_SOURCE_CONFLICT',
      'Calculated itemized deductions cannot also supply a Schedule A total',
      'deductions.itemized');
  }
}

function validateSchedule1A(errors, intake){
  const schedule1A = intake.deductions?.schedule1A;
  const suppliedLine13b = intake.supplied?.line13b;
  const legacyLine13b = intake.deductions?.additional;
  if(schedule1A === undefined){
    if(suppliedLine13b !== undefined || legacyLine13b !== undefined){
      issue(errors, 'LEGACY_SCHEDULE_1A_FIELD_IN_CANONICAL',
        'Canonical line 13b must use deductions.schedule1A supplied-total mode',
        'deductions.schedule1A');
    }
    return;
  }
  if(!requirePlainObject(errors, schedule1A, 'deductions.schedule1A')) return;
  if(!CLIENT_1040_SCHEDULE_1A_MODES.includes(schedule1A.mode)){
    issue(errors, 'INVALID_SCHEDULE_1A_MODE',
      'deductions.schedule1A.mode is not supported',
      'deductions.schedule1A.mode');
    return;
  }

  if(suppliedLine13b !== undefined || legacyLine13b !== undefined){
    issue(errors, 'SCHEDULE_1A_SOURCE_CONFLICT',
      'Canonical Schedule 1-A mode cannot be mixed with legacy supplied line 13b',
      'deductions.schedule1A');
  }

  if(schedule1A.mode === 'supplied-line13b'){
    rejectUnexpectedKeys(errors, schedule1A, ['mode', 'amount'],
      'deductions.schedule1A', 'SCHEDULE_1A_SOURCE_CONFLICT');
    requireNonNegative(errors, schedule1A.amount, 'deductions.schedule1A.amount');
    return;
  }

  rejectUnexpectedKeys(errors, schedule1A, [
    'mode',
    'magi',
    'noOtherSchedule1ADeductionsConfirmed',
  ], 'deductions.schedule1A', 'SCHEDULE_1A_SOURCE_CONFLICT');
  if(intake.filingStatus === 'marriedFilingSeparately'){
    issue(errors, 'MFS_ENHANCED_SENIOR_DEDUCTION_UNAVAILABLE',
      'The enhanced senior deduction is unavailable for married filing separately',
      'deductions.schedule1A.mode');
  }
  if(schedule1A.noOtherSchedule1ADeductionsConfirmed !== true){
    issue(errors, 'MISSING_SCHEDULE_1A_EXCLUSIVITY_CONFIRMATION',
      'noOtherSchedule1ADeductionsConfirmed must be true for engine senior-only mode',
      'deductions.schedule1A.noOtherSchedule1ADeductionsConfirmed');
  }
  validateMagiSource(errors, schedule1A.magi, 'deductions.schedule1A.magi');
  for(const owner of activeTaxpayerOwners(intake)){
    validateTaxpayerRecord(errors, intake, owner, {
      requireSeniorSsnConfirmation: true,
    });
  }
}

function validateStandardEligibility(errors, deductions){
  const eligibility = deductions.standardEligibility;
  if(!requirePlainObject(errors, eligibility, 'deductions.standardEligibility')) return;
  rejectUnexpectedKeys(errors, eligibility, [
    'anyActiveTaxpayerCanBeClaimedAsDependent',
    'anyActiveTaxpayerIsDualStatusAlien',
  ], 'deductions.standardEligibility', 'STANDARD_DEDUCTION_ELIGIBILITY_CONFLICT');
  if(eligibility.anyActiveTaxpayerCanBeClaimedAsDependent !== false){
    issue(errors, 'DEPENDENT_STANDARD_DEDUCTION_DEFERRED',
      'Calculated standard deduction requires explicit confirmation that no active taxpayer can be claimed as a dependent',
      'deductions.standardEligibility.anyActiveTaxpayerCanBeClaimedAsDependent');
  }
  if(eligibility.anyActiveTaxpayerIsDualStatusAlien !== false){
    issue(errors, 'DUAL_STATUS_STANDARD_DEDUCTION_DEFERRED',
      'Calculated standard deduction requires explicit confirmation that no active taxpayer is a dual-status alien',
      'deductions.standardEligibility.anyActiveTaxpayerIsDualStatusAlien');
  }
}

function validateBaseAndAgeStandardScope(errors, intake){
  const deductions = intake.deductions;
  if(hasOwn(deductions, 'standardEligibility')){
    issue(errors, 'STANDARD_DEDUCTION_SCOPE_CONFLICT',
      'base-and-age cannot include strict standard-deduction eligibility facts',
      'deductions.standardEligibility');
  }
  if(hasOwn(deductions, 'itemized')){
    issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
      'base-and-age cannot include calculated itemized-deduction facts',
      'deductions.itemized');
  }
  if(hasOwn(intake.returnScope || {}, 'spouseItemizes')){
    issue(errors, 'STANDARD_DEDUCTION_SCOPE_CONFLICT',
      'base-and-age does not accept spouse-itemizes facts',
      'returnScope.spouseItemizes');
  }
  if(!['single', 'marriedFilingJointly', 'headOfHousehold']
    .includes(intake.filingStatus)){
    issue(errors, 'BASE_AND_AGE_STANDARD_DEDUCTION_FILING_STATUS_UNSUPPORTED',
      'base-and-age supports single, married filing jointly, and head of household',
      'filingStatus');
  }

  for(const owner of activeTaxpayerOwners(intake)){
    const path = `taxpayers.${owner}`;
    const taxpayer = intake.taxpayers?.[owner];
    if(!taxpayer || typeof taxpayer !== 'object' || Array.isArray(taxpayer)){
      continue;
    }
    if(taxpayer.birthDate === undefined){
      issue(errors, 'MISSING_TAXPAYER_BIRTH_DATE',
        `${path}.birthDate is required for base-and-age`,
        `${path}.birthDate`);
    }
    if(hasOwn(taxpayer, 'blind')){
      issue(errors, 'STANDARD_DEDUCTION_SCOPE_CONFLICT',
        `${path}.blind is outside the base-and-age scope`,
        `${path}.blind`);
    }
  }
}

export function validateDeductions(errors, intake){
  const deductions = intake.deductions;
  if(!requirePlainObject(errors, deductions, 'deductions')) return;
  rejectUnexpectedKeys(errors, deductions, [
    'method',
    'source',
    'line12e',
    'itemized',
    'standardEligibility',
    'standardScope',
    'qbi',
    'schedule1A',
  ], 'deductions', 'UNKNOWN_CANONICAL_FIELD');
  if(!CLIENT_1040_DEDUCTION_METHODS.includes(deductions.method)){
    issue(errors, 'MISSING_DEDUCTION_METHOD',
      'deductions.method must be standard or itemized', 'deductions.method');
  }
  if(!CLIENT_1040_DEDUCTION_SOURCES.includes(deductions.source)){
    issue(errors, 'MISSING_DEDUCTION_SOURCE',
      'deductions.source must be calculated or supplied-line12e',
      'deductions.source');
  }
  const standardScopePresent = hasOwn(deductions, 'standardScope');
  const standardScopeIsValid = CLIENT_1040_STANDARD_DEDUCTION_SCOPES
    .includes(deductions.standardScope);
  if(standardScopePresent && !standardScopeIsValid){
    issue(errors, 'INVALID_STANDARD_DEDUCTION_SCOPE',
      'deductions.standardScope must be base-and-age when supplied',
      'deductions.standardScope');
  }

  if(hasOwn(deductions, 'useStandard') || hasOwn(deductions, 'itemizedAmount')){
    issue(errors, 'LEGACY_DEDUCTION_FIELD_IN_CANONICAL',
      'Canonical intake must use deductions.method and deductions.source',
      'deductions');
  }
  if(intake.supplied?.line12e !== undefined){
    issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
      'Canonical line 12e must use deductions.source and deductions.line12e',
      'deductions');
  }

  if(deductions.source === 'supplied-line12e'){
    requireNonNegative(errors, deductions.line12e, 'deductions.line12e');
    if(hasOwn(deductions, 'itemized')){
      issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
        'Supplied line 12e cannot be mixed with calculated itemized details',
        'deductions');
    }
    if(hasOwn(deductions, 'standardEligibility')){
      issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
        'Supplied line 12e cannot be mixed with calculated standard-deduction eligibility facts',
        'deductions.standardEligibility');
    }
    if(standardScopePresent){
      issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
        'Supplied line 12e cannot be mixed with a calculated standard-deduction scope',
        'deductions.standardScope');
    }
  } else if(deductions.source === 'calculated'){
    if(hasOwn(deductions, 'line12e') || intake.supplied?.line12e !== undefined){
      issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
        'Calculated deduction mode cannot also supply line 12e',
        'deductions');
    }
    if(deductions.method === 'standard'){
      if(standardScopePresent){
        if(standardScopeIsValid){
          validateBaseAndAgeStandardScope(errors, intake);
        }
      } else {
        validateStandardEligibility(errors, deductions);
        for(const owner of activeTaxpayerOwners(intake)){
          validateTaxpayerRecord(errors, intake, owner, { requireAgeBlind: true });
        }
        if(intake.filingStatus === 'marriedFilingSeparately'){
          if(typeof intake.returnScope?.spouseItemizes !== 'boolean'){
            issue(errors, 'MFS_SPOUSE_ITEMIZES_REQUIRED',
              'MFS calculated standard deduction requires spouseItemizes true or false',
              'returnScope.spouseItemizes');
          } else if(intake.returnScope.spouseItemizes){
            issue(errors, 'MFS_STANDARD_DEDUCTION_NOT_ALLOWED',
              'Calculated standard deduction is unavailable when the MFS spouse itemizes',
              'returnScope.spouseItemizes');
          }
        }
      }
    } else if(deductions.method === 'itemized'){
      if(standardScopePresent){
        issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
          'Calculated itemized deductions cannot include a standard-deduction scope',
          'deductions.standardScope');
      }
      if(hasOwn(deductions, 'standardEligibility')){
        issue(errors, 'DEDUCTION_SOURCE_CONFLICT',
          'Calculated itemized deductions cannot include standard-deduction eligibility facts',
          'deductions.standardEligibility');
      }
      validateItemizedDetails(errors, deductions.itemized);
    }
  }

  validateSchedule1A(errors, intake);
}

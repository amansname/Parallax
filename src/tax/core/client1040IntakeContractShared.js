import {
  isAge65ByTaxYearEnd,
  isValidTaxDate,
} from './taxpayerAge.js';

export function hasOwn(value, key){
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isPlainObject(value){
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value){
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value){
  return isFiniteNumber(value) && value >= 0;
}

export function issue(errors, code, message, path, details){
  errors.push({
    code,
    message,
    ...(path ? { path } : {}),
    ...(details ? { details } : {}),
  });
}

export function rejectMissingScalars(errors, value, path = ''){
  if(value === null){
    issue(errors, 'NULL_NOT_ALLOWED',
      `${path || 'intake'} cannot be null; omit an unknown field instead`,
      path || 'intake');
    return;
  }
  if(typeof value === 'number' && !Number.isFinite(value)){
    issue(errors, 'NONFINITE_NUMBER',
      `${path || 'intake'} must be a finite number`,
      path || 'intake');
    return;
  }
  if(Array.isArray(value)){
    value.forEach((entry, index) => {
      rejectMissingScalars(errors, entry, `${path}[${index}]`);
    });
    return;
  }
  if(isPlainObject(value)){
    for(const [key, entry] of Object.entries(value)){
      rejectMissingScalars(errors, entry, path ? `${path}.${key}` : key);
    }
  }
}

export function requirePlainObject(errors, value, path){
  if(isPlainObject(value)) return true;
  issue(errors, 'INVALID_OBJECT', `${path} must be a plain object`, path);
  return false;
}

export function requireNonNegative(errors, value, path){
  if(isNonNegativeNumber(value)) return true;
  issue(errors, 'INVALID_NONNEGATIVE_AMOUNT',
    `${path} must be a non-negative finite number`, path);
  return false;
}

export function requireFinite(errors, value, path){
  if(isFiniteNumber(value)) return true;
  issue(errors, 'INVALID_SIGNED_AMOUNT', `${path} must be a finite number`, path);
  return false;
}

export function rejectUnexpectedKeys(errors, value, allowed, path, code){
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if(unexpected.length === 0) return;
  issue(errors, code,
    `${path} contains fields from another source mode: ${unexpected.join(', ')}`,
    path,
    { unexpected });
}

export function activeTaxpayerOwners(intake){
  if(intake.filingStatus === 'marriedFilingJointly') return ['client', 'spouse'];
  if(intake.filingStatus === 'marriedFilingSeparately'){
    const owner = intake.returnScope?.modeledTaxpayer;
    return owner === 'client' || owner === 'spouse' ? [owner] : [];
  }
  return ['client'];
}

export function validateTaxpayerRecord(errors, intake, owner, {
  requireAgeBlind = false,
  requireSeniorSsnConfirmation = false,
} = {}){
  const path = `taxpayers.${owner}`;
  const taxpayer = intake.taxpayers?.[owner];
  if(!requirePlainObject(errors, taxpayer, path)) return;
  rejectUnexpectedKeys(errors, taxpayer, [
    'birthDate',
    'blind',
    'validSsnForEnhancedSeniorDeduction',
  ], path, 'UNKNOWN_CANONICAL_FIELD');

  const birthDateIsValid = isValidTaxDate(taxpayer.birthDate);
  if(requireAgeBlind || requireSeniorSsnConfirmation){
    if(!birthDateIsValid){
      issue(errors, 'MISSING_TAXPAYER_BIRTH_DATE',
        `${path}.birthDate must be a valid YYYY-MM-DD date`, `${path}.birthDate`);
    }
  } else if(taxpayer.birthDate !== undefined && !isValidTaxDate(taxpayer.birthDate)){
    issue(errors, 'INVALID_TAXPAYER_BIRTH_DATE',
      `${path}.birthDate must be a valid YYYY-MM-DD date`, `${path}.birthDate`);
  }

  if(requireAgeBlind && typeof taxpayer.blind !== 'boolean'){
    issue(errors, 'MISSING_TAXPAYER_BLIND_STATUS',
      `${path}.blind must be explicitly true or false`, `${path}.blind`);
  } else if(taxpayer.blind !== undefined && typeof taxpayer.blind !== 'boolean'){
    issue(errors, 'INVALID_TAXPAYER_BLIND_STATUS',
      `${path}.blind must be a boolean`, `${path}.blind`);
  }

  const seniorSsnIsRequired = requireSeniorSsnConfirmation
    && birthDateIsValid
    && isAge65ByTaxYearEnd(taxpayer.birthDate, intake.taxYear);
  if(seniorSsnIsRequired
      && typeof taxpayer.validSsnForEnhancedSeniorDeduction !== 'boolean'){
    issue(errors, 'MISSING_ENHANCED_SENIOR_SSN_CONFIRMATION',
      `${path}.validSsnForEnhancedSeniorDeduction must be explicitly true or false`,
      `${path}.validSsnForEnhancedSeniorDeduction`);
  } else if(taxpayer.validSsnForEnhancedSeniorDeduction !== undefined
      && typeof taxpayer.validSsnForEnhancedSeniorDeduction !== 'boolean'){
    issue(errors, 'INVALID_ENHANCED_SENIOR_SSN_CONFIRMATION',
      `${path}.validSsnForEnhancedSeniorDeduction must be a boolean`,
      `${path}.validSsnForEnhancedSeniorDeduction`);
  }
}

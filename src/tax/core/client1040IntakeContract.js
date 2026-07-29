/*
 * Canonical client-1040 intake contract facade.
 *
 * This module publishes the stable contract and orchestrates focused
 * validators. It owns document shape, presence, source precedence, and
 * fail-closed assertions. It does not calculate tax.
 */

import { FILING_STATUSES } from './constants.js';
import { resolveLawVersionForTaxYear } from './lawRegistry.js';
import {
  CLIENT_1040_COMPATIBILITY_MODES,
  CLIENT_1040_INTAKE_CONTRACT_ID,
  CLIENT_1040_INTAKE_CONTRACT_VERSION,
  CLIENT_1040_INTAKE_SCHEMA_VERSION,
  CLIENT_1040_LIMITATIONS,
  CLIENT_1040_SUPPORTED_TAX_YEARS,
  SIMPLE_SCHEDULE_D_CONFIRMATIONS,
} from './client1040IntakeContractConstants.js';
import {
  hasOwn,
  isPlainObject,
  issue,
  rejectMissingScalars,
  rejectUnexpectedKeys,
  requirePlainObject,
  validateTaxpayerRecord,
} from './client1040IntakeContractShared.js';
import {
  validateAdjustments,
  validateCanonicalAliases,
  validateCanonicalIncome,
  validateReturnScope,
  validateScheduleD,
} from './client1040IntakeIncomeContract.js';
import { validateDeductions } from './client1040IntakeDeductionContract.js';
import {
  validateCanonicalSuppliedFields,
  validateScheduleSE,
} from './client1040IntakeSupplementalContract.js';
import { validateAccounts } from './client1040IntakeAccountContract.js';

export {
  CLIENT_1040_ADJUSTMENT_MODES,
  CLIENT_1040_COMPATIBILITY_MODES,
  CLIENT_1040_DEDUCTION_METHODS,
  CLIENT_1040_DEDUCTION_SOURCES,
  CLIENT_1040_FIELD_DISPOSITIONS,
  CLIENT_1040_INTAKE_CONTRACT_ID,
  CLIENT_1040_INTAKE_CONTRACT_VERSION,
  CLIENT_1040_INTAKE_SCHEMA_VERSION,
  CLIENT_1040_LIMITATIONS,
  CLIENT_1040_MAGI_MODES,
  CLIENT_1040_MODELED_TAXPAYERS,
  CLIENT_1040_SCHEDULE_1A_MODES,
  CLIENT_1040_SCHEDULE_D_MODES,
  CLIENT_1040_SOCIAL_SECURITY_MODES,
  CLIENT_1040_SUPPORTED_TAX_YEARS,
} from './client1040IntakeContractConstants.js';
export { deriveAccountTaxTreatment } from './client1040IntakeAccountContract.js';

export function describeClient1040IntakeContract(intake){
  const sourceSchemaVersionPresent = isPlainObject(intake)
    && hasOwn(intake, 'schemaVersion');
  const sourceSchemaVersion = sourceSchemaVersionPresent
    ? intake.schemaVersion
    : null;
  const compatibilityMode = !sourceSchemaVersionPresent
    ? CLIENT_1040_COMPATIBILITY_MODES.LEGACY_UNVERSIONED
    : sourceSchemaVersion === CLIENT_1040_INTAKE_SCHEMA_VERSION
      ? CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      : CLIENT_1040_COMPATIBILITY_MODES.UNSUPPORTED;
  const scheduleD = isPlainObject(intake?.scheduleD) ? intake.scheduleD : null;
  const simpleScheduleDConfirmed = scheduleD?.mode === 'simple-net-long-term'
    ? SIMPLE_SCHEDULE_D_CONFIRMATIONS.every(
        field => scheduleD.confirmations?.[field] === true
      )
    : null;
  const limitations = [];
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && scheduleD?.mode === 'simple-net-long-term'){
    limitations.push(CLIENT_1040_LIMITATIONS.SIMPLE_SCHEDULE_D_ONLY);
  }
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && Array.isArray(intake?.scheduleSE)
      && intake.scheduleSE.length > 0){
    limitations.push(
      CLIENT_1040_LIMITATIONS.SCHEDULE_SE_RESOLVED_LINE_6_ONLY
    );
  }
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && intake?.income?.socialSecurity?.mode
        === 'calculate-taxable-benefits'){
    limitations.push(
      CLIENT_1040_LIMITATIONS.SOCIAL_SECURITY_WORKSHEET_ADJUSTMENT_SUBSET
    );
  }
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && intake?.deductions?.source === 'calculated'
      && intake?.deductions?.method === 'itemized'){
    limitations.push(CLIENT_1040_LIMITATIONS.ITEMIZED_COMPONENTS_ALREADY_LIMITED);
  }
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && intake?.deductions?.schedule1A === undefined){
    limitations.push(CLIENT_1040_LIMITATIONS.MISSING_SCHEDULE_1A_DEFERRED);
  }
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && intake?.adjustments === undefined
      && (!Array.isArray(intake?.scheduleSE) || intake.scheduleSE.length === 0)){
    limitations.push(CLIENT_1040_LIMITATIONS.MISSING_ADJUSTMENTS_DEFERRED);
  }
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && !hasOwn(intake?.deductions, 'qbi')){
    limitations.push(CLIENT_1040_LIMITATIONS.MISSING_QBI_DEFERRED);
  }
  if(compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL
      && intake?.filingStatus === 'qualifyingSurvivingSpouse'){
    limitations.push(
      CLIENT_1040_LIMITATIONS.QUALIFYING_SURVIVING_SPOUSE_DEFERRED
    );
  }
  const expectedLawVersion = CLIENT_1040_SUPPORTED_TAX_YEARS
    .includes(intake?.taxYear)
    ? resolveLawVersionForTaxYear(intake.taxYear)
    : null;
  const selections = Object.freeze({
    modeledTaxpayer: intake?.returnScope?.modeledTaxpayer ?? null,
    adjustmentMode: intake?.adjustments?.mode ?? null,
    deductionMethod: intake?.deductions?.method ?? null,
    deductionSource: intake?.deductions?.source ?? null,
    schedule1AMode: intake?.deductions?.schedule1A?.mode ?? null,
    schedule1AMagiMode: intake?.deductions?.schedule1A?.magi?.mode ?? null,
    socialSecurityMode: intake?.income?.socialSecurity?.mode ?? null,
    scheduleDMode: scheduleD?.mode ?? null,
    simpleScheduleDConfirmed,
    scheduleSEMode: Array.isArray(intake?.scheduleSE) ? 'per-taxpayer' : null,
    accountTreatmentSource: Array.isArray(intake?.accounts) ? 'typeId' : null,
  });
  return Object.freeze({
    id: CLIENT_1040_INTAKE_CONTRACT_ID,
    schemaVersion: CLIENT_1040_INTAKE_SCHEMA_VERSION,
    contractVersion: CLIENT_1040_INTAKE_CONTRACT_VERSION,
    sourceSchemaVersionPresent,
    sourceSchemaVersion,
    compatibilityMode,
    taxYear: intake?.taxYear ?? null,
    expectedLawVersion,
    intakeLawVersion: isPlainObject(intake) && hasOwn(intake, 'lawVersion')
      ? intake.lawVersion
      : null,
    selections,
    limitations: Object.freeze(limitations),
  });
}

export function validateClient1040Contract(intake, context){
  const contract = describeClient1040IntakeContract(intake);
  const errors = [];
  if(contract.compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.LEGACY_UNVERSIONED){
    return { contract, errors };
  }
  if(contract.compatibilityMode === CLIENT_1040_COMPATIBILITY_MODES.UNSUPPORTED){
    issue(errors, 'UNSUPPORTED_INTAKE_SCHEMA_VERSION',
      `schemaVersion must be ${CLIENT_1040_INTAKE_SCHEMA_VERSION}`,
      'schemaVersion',
      { received: contract.sourceSchemaVersion });
    return { contract, errors };
  }

  rejectMissingScalars(errors, intake);
  rejectUnexpectedKeys(errors, intake, [
    'schemaVersion',
    'taxYear',
    'lawVersion',
    'filingStatus',
    'returnScope',
    'taxpayers',
    'income',
    'adjustments',
    'deductions',
    'passThrough',
    'scheduleD',
    'scheduleSE',
    'schedule2',
    'accounts',
    'reconciliation',
    'id',
    'label',
  ], 'intake', 'UNKNOWN_CANONICAL_FIELD');

  if(!CLIENT_1040_SUPPORTED_TAX_YEARS.includes(intake.taxYear)){
    issue(errors, 'UNSUPPORTED_TAX_YEAR',
      'Canonical client-1040 intake supports tax years 2025 and 2026',
      'taxYear');
  }
  if(context?.taxYear !== undefined && intake.taxYear !== context.taxYear){
    issue(errors, 'TAX_YEAR_CONTEXT_MISMATCH',
      `Canonical intake taxYear ${intake.taxYear} does not match context taxYear ${context.taxYear}`,
      'taxYear');
  }
  if(CLIENT_1040_SUPPORTED_TAX_YEARS.includes(intake.taxYear)){
    const expectedLawVersion = resolveLawVersionForTaxYear(intake.taxYear);
    if(context?.lawVersion !== undefined && context.lawVersion !== expectedLawVersion){
      issue(errors, 'LAW_VERSION_CONTEXT_MISMATCH',
        `Canonical taxYear ${intake.taxYear} requires lawVersion ${expectedLawVersion}`,
        'taxYear',
        { expectedLawVersion, receivedLawVersion: context.lawVersion });
    }
    if(intake.lawVersion !== undefined && intake.lawVersion !== expectedLawVersion){
      issue(errors, 'INTAKE_LAW_VERSION_MISMATCH',
        `Canonical taxYear ${intake.taxYear} requires lawVersion ${expectedLawVersion}`,
        'lawVersion',
        { expectedLawVersion, receivedLawVersion: intake.lawVersion });
    }
  }
  if(!FILING_STATUSES.includes(intake.filingStatus)){
    issue(errors, 'INVALID_FILING_STATUS',
      'filingStatus must be a supported federal filing status',
      'filingStatus');
  }

  validateReturnScope(errors, intake);
  validateCanonicalAliases(errors, intake);
  validateCanonicalIncome(errors, intake);
  validateAdjustments(errors, intake);
  validateCanonicalSuppliedFields(errors, intake);
  if(!requirePlainObject(errors, intake.taxpayers, 'taxpayers')){
    // Conditional validators report any facts required by the selected modes.
  } else {
    rejectUnexpectedKeys(errors, intake.taxpayers, ['client', 'spouse'],
      'taxpayers', 'UNKNOWN_CANONICAL_FIELD');
    for(const owner of ['client', 'spouse']){
      if(isPlainObject(intake.taxpayers[owner])){
        validateTaxpayerRecord(errors, intake, owner);
      }
    }
    if(intake.filingStatus === 'marriedFilingJointly'){
      for(const owner of ['client', 'spouse']){
        if(!isPlainObject(intake.taxpayers[owner])){
          issue(errors, 'MARRIED_TAXPAYER_RECORD_REQUIRED',
            `taxpayers.${owner} is required for a married return`,
            `taxpayers.${owner}`);
        }
      }
    } else if(intake.filingStatus === 'marriedFilingSeparately'){
      const owner = intake.returnScope?.modeledTaxpayer;
      if((owner === 'client' || owner === 'spouse')
          && !isPlainObject(intake.taxpayers[owner])){
        issue(errors, 'MODELED_TAXPAYER_RECORD_REQUIRED',
          `taxpayers.${owner} is required for this MFS return`,
          `taxpayers.${owner}`);
      }
    } else if(!isPlainObject(intake.taxpayers.client)){
      issue(errors, 'PRIMARY_TAXPAYER_RECORD_REQUIRED',
        'taxpayers.client is required', 'taxpayers.client');
    }
  }

  validateDeductions(errors, intake);
  validateScheduleD(errors, intake);
  validateScheduleSE(errors, intake);
  validateAccounts(errors, intake);

  return { contract, errors };
}

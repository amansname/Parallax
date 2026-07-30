import {
  CLIENT_1040_ADJUSTMENT_MODES,
  CLIENT_1040_MODELED_TAXPAYERS,
  CLIENT_1040_SCHEDULE_D_MODES,
  CLIENT_1040_SOCIAL_SECURITY_MODES,
  LEGACY_CANONICAL_INCOME_FIELDS,
  LEGACY_CANONICAL_TOP_LEVEL_FIELDS,
  NONNEGATIVE_CANONICAL_INCOME_FIELDS,
  SIMPLE_SCHEDULE_D_CONFIRMATIONS,
} from './client1040IntakeContractConstants.js';
import {
  hasOwn,
  isPlainObject,
  issue,
  rejectUnexpectedKeys,
  requireFinite,
  requireNonNegative,
  requirePlainObject,
} from './client1040IntakeContractShared.js';

export function validateReturnScope(errors, intake){
  if(!requirePlainObject(errors, intake.returnScope, 'returnScope')) return;
  rejectUnexpectedKeys(errors, intake.returnScope,
    ['modeledTaxpayer', 'spouseItemizes'],
    'returnScope',
    'UNKNOWN_CANONICAL_FIELD');
  const modeled = intake.returnScope.modeledTaxpayer;
  if(!CLIENT_1040_MODELED_TAXPAYERS.includes(modeled)){
    issue(errors, 'INVALID_MODELED_TAXPAYER',
      'returnScope.modeledTaxpayer must be client, spouse, or jointReturn',
      'returnScope.modeledTaxpayer');
    return;
  }

  if(intake.filingStatus === 'marriedFilingJointly'){
    if(modeled !== 'jointReturn'){
      issue(errors, 'MFJ_JOINT_RETURN_REQUIRED',
        'Married filing jointly requires returnScope.modeledTaxpayer=jointReturn',
        'returnScope.modeledTaxpayer');
    }
  } else if(intake.filingStatus === 'marriedFilingSeparately'){
    if(modeled !== 'client' && modeled !== 'spouse'){
      issue(errors, 'MFS_MODELED_TAXPAYER_REQUIRED',
        'Married filing separately requires one modeled taxpayer: client or spouse',
        'returnScope.modeledTaxpayer');
    }
  } else if(modeled !== 'client'){
    issue(errors, 'PRIMARY_TAXPAYER_REQUIRED',
      'Single and head-of-household returns require modeledTaxpayer=client',
      'returnScope.modeledTaxpayer');
  }
}

export function validateCanonicalAliases(errors, intake){
  for(const field of LEGACY_CANONICAL_TOP_LEVEL_FIELDS){
    if(hasOwn(intake, field)){
      issue(errors, 'LEGACY_ALIAS_CONTAINER_IN_CANONICAL',
        `${field} is available only to unversioned legacy intake`,
        field);
    }
  }
  if(isPlainObject(intake.income)){
    for(const field of LEGACY_CANONICAL_INCOME_FIELDS){
      if(hasOwn(intake.income, field)){
        issue(errors, 'LEGACY_INCOME_ALIAS_IN_CANONICAL',
          `income.${field} is not part of canonical schema v1`,
          `income.${field}`);
      }
    }
  }
}

export function validateCanonicalIncome(errors, intake){
  if(!requirePlainObject(errors, intake.income, 'income')) return;
  rejectUnexpectedKeys(errors, intake.income, [
    ...NONNEGATIVE_CANONICAL_INCOME_FIELDS,
    'otherIncome',
    'socialSecurity',
  ], 'income', 'UNKNOWN_CANONICAL_FIELD');
  for(const field of NONNEGATIVE_CANONICAL_INCOME_FIELDS){
    if(hasOwn(intake.income, field)){
      requireNonNegative(errors, intake.income[field], `income.${field}`);
    }
  }
  if(hasOwn(intake.income, 'otherIncome')){
    requireFinite(errors, intake.income.otherIncome, 'income.otherIncome');
  }

  const hasTaxableIra = hasOwn(intake.income, 'taxableIra');
  const hasRothConversion = hasOwn(intake.income, 'rothConversion');
  if(hasTaxableIra !== hasRothConversion){
    issue(errors, 'LINE4B_COMPONENTS_INCOMPLETE',
      'income.taxableIra and income.rothConversion must both be supplied; explicit zero is allowed',
      'income');
  }

  const socialSecurity = intake.income.socialSecurity;
  const hasSuppliedGross = hasOwn(intake.income, 'socialSecurityBenefits');
  const hasSuppliedTaxable = hasOwn(intake.income, 'taxableSS');
  if(socialSecurity === undefined){
    if(hasSuppliedGross || hasSuppliedTaxable){
      issue(errors, 'MISSING_SOCIAL_SECURITY_MODE',
        'Social Security facts require an explicit supplied-form1040-lines or calculate-taxable-benefits mode',
        'income.socialSecurity');
    }
    return;
  }
  if(!requirePlainObject(errors, socialSecurity, 'income.socialSecurity')) return;
  if(!CLIENT_1040_SOCIAL_SECURITY_MODES.includes(socialSecurity.mode)){
    issue(errors, 'INVALID_SOCIAL_SECURITY_MODE',
      'income.socialSecurity.mode must be supplied-form1040-lines or calculate-taxable-benefits',
      'income.socialSecurity.mode');
    return;
  }

  if(socialSecurity.mode === 'supplied-form1040-lines'){
    rejectUnexpectedKeys(errors, socialSecurity, ['mode'],
      'income.socialSecurity', 'SOCIAL_SECURITY_SOURCE_CONFLICT');
    if(!hasSuppliedGross){
      issue(errors, 'MISSING_SOCIAL_SECURITY_GROSS_BENEFITS',
        'Supplied Form 1040 Social Security requires income.socialSecurityBenefits',
        'income.socialSecurityBenefits');
    }
    if(!hasSuppliedTaxable){
      issue(errors, 'MISSING_SOCIAL_SECURITY_TAXABLE_BENEFITS',
        'Supplied Form 1040 Social Security requires income.taxableSS',
        'income.taxableSS');
    }
    return;
  }

  rejectUnexpectedKeys(errors, socialSecurity, [
    'mode',
    'otherIncome',
    'excludedIncomeAddBacks',
    'adjustments',
    'livedWithSpouse',
  ], 'income.socialSecurity', 'SOCIAL_SECURITY_SOURCE_CONFLICT');
  if(hasSuppliedTaxable){
    issue(errors, 'SOCIAL_SECURITY_SOURCE_CONFLICT',
      'Calculated Social Security cannot also supply Form 1040 line 6b',
      'income.taxableSS');
  }
  if(!hasSuppliedGross){
    issue(errors, 'MISSING_SOCIAL_SECURITY_WORKSHEET_FACT',
      'income.socialSecurityBenefits is required for calculated Social Security',
      'income.socialSecurityBenefits');
  }
  if(!hasOwn(intake.income, 'taxExemptInterest')){
    issue(errors, 'MISSING_SOCIAL_SECURITY_WORKSHEET_FACT',
      'income.taxExemptInterest is required for calculated Social Security',
      'income.taxExemptInterest');
  }
  for(const field of [
    'excludedIncomeAddBacks',
    'adjustments',
  ]){
    if(!hasOwn(socialSecurity, field)){
      issue(errors, 'MISSING_SOCIAL_SECURITY_WORKSHEET_FACT',
        field === 'adjustments'
          ? 'income.socialSecurity.adjustments is required and must be the Publication 915/505 worksheet-eligible adjustment subtotal, excluding any half-SE-tax deduction calculated by this engine'
          : `income.socialSecurity.${field} is required for calculated Social Security`,
        `income.socialSecurity.${field}`);
    } else {
      requireNonNegative(errors, socialSecurity[field], `income.socialSecurity.${field}`);
    }
  }
  if(!hasOwn(socialSecurity, 'otherIncome')){
    issue(errors, 'MISSING_SOCIAL_SECURITY_WORKSHEET_FACT',
      'income.socialSecurity.otherIncome is required for calculated Social Security',
      'income.socialSecurity.otherIncome');
  } else {
    requireFinite(
      errors,
      socialSecurity.otherIncome,
      'income.socialSecurity.otherIncome'
    );
  }
  if(intake.filingStatus === 'marriedFilingSeparately'
      && typeof socialSecurity.livedWithSpouse !== 'boolean'){
    issue(errors, 'MISSING_SOCIAL_SECURITY_LIVING_STATUS',
      'income.socialSecurity.livedWithSpouse must state whether the modeled taxpayer lived with their spouse at any time during the tax year; false means they lived apart for the entire year',
      'income.socialSecurity.livedWithSpouse');
  } else if(socialSecurity.livedWithSpouse !== undefined
      && typeof socialSecurity.livedWithSpouse !== 'boolean'){
    issue(errors, 'INVALID_SOCIAL_SECURITY_LIVING_STATUS',
      'income.socialSecurity.livedWithSpouse must be a boolean when supplied',
      'income.socialSecurity.livedWithSpouse');
  }
  if(intake.adjustments?.mode === 'supplied-traditional-ira-deduction'
      && socialSecurity.adjustments
        !== intake.adjustments.traditionalIraDeduction){
    issue(errors, 'SOCIAL_SECURITY_ADJUSTMENT_SOURCE_CONFLICT',
      'With the traditional-IRA component mode, the Social Security worksheet-eligible adjustment subtotal must equal the supplied traditional IRA deduction; use supplied-line10 when other adjustment components exist',
      'income.socialSecurity.adjustments',
      {
        worksheetEligibleAdjustments: socialSecurity.adjustments,
        traditionalIraDeduction:
          intake.adjustments.traditionalIraDeduction,
      });
  }
}

export function validateAdjustments(errors, intake){
  const adjustments = intake.adjustments;
  if(adjustments === undefined) return;
  if(!requirePlainObject(errors, adjustments, 'adjustments')) return;
  if(!CLIENT_1040_ADJUSTMENT_MODES.includes(adjustments.mode)){
    issue(errors, 'INVALID_ADJUSTMENTS_MODE',
      'Canonical adjustments.mode must be supplied-line10 or supplied-traditional-ira-deduction',
      'adjustments.mode');
    return;
  }
  if(adjustments.mode === 'supplied-line10'){
    rejectUnexpectedKeys(errors, adjustments, ['mode', 'amount'],
      'adjustments', 'ADJUSTMENT_SOURCE_CONFLICT');
    requireNonNegative(errors, adjustments.amount, 'adjustments.amount');
  } else {
    rejectUnexpectedKeys(errors, adjustments, [
      'mode',
      'traditionalIraDeduction',
    ], 'adjustments', 'ADJUSTMENT_SOURCE_CONFLICT');
    requireNonNegative(errors, adjustments.traditionalIraDeduction,
      'adjustments.traditionalIraDeduction');
  }

  for(const field of ['total', 'line10', 'ira']){
    if(hasOwn(adjustments, field)){
      issue(errors, 'LINE10_SOURCE_CONFLICT',
        `adjustments.${field} is a legacy line 10 source and cannot be mixed with canonical mode`,
        `adjustments.${field}`);
    }
  }
}

export function validateScheduleD(errors, intake){
  const scheduleD = intake.scheduleD;
  if(scheduleD === undefined) return;
  if(!requirePlainObject(errors, scheduleD, 'scheduleD')) return;
  if(!CLIENT_1040_SCHEDULE_D_MODES.includes(scheduleD.mode)){
    issue(errors, 'INVALID_SCHEDULE_D_MODE',
      'Canonical Schedule D supports manual-net-long-term, simple-net-long-term, or supplied-form1040-line7',
      'scheduleD.mode');
    return;
  }
  if(intake.income?.capitalGain !== undefined
      || intake.income?.netLongTermCapitalGains !== undefined
      || intake.supplied?.line7a !== undefined){
    issue(errors, 'FORM1040_LINE7_SOURCE_CONFLICT',
      'Canonical Schedule D cannot be mixed with another Form 1040 line 7 source',
      'scheduleD');
  }

  if(scheduleD.mode === 'manual-net-long-term'){
    rejectUnexpectedKeys(errors, scheduleD, [
      'mode',
      'netLongTermGainOrLoss',
    ], 'scheduleD', 'SCHEDULE_D_SOURCE_CONFLICT');
    requireFinite(errors, scheduleD.netLongTermGainOrLoss,
      'scheduleD.netLongTermGainOrLoss');
    return;
  }

  if(scheduleD.mode === 'simple-net-long-term'){
    rejectUnexpectedKeys(errors, scheduleD, [
      'mode',
      'netLongTermGainOrLoss',
      'confirmations',
    ], 'scheduleD', 'SCHEDULE_D_SOURCE_CONFLICT');
    requireFinite(errors, scheduleD.netLongTermGainOrLoss,
      'scheduleD.netLongTermGainOrLoss');
    if(!requirePlainObject(errors, scheduleD.confirmations,
      'scheduleD.confirmations')) return;
    rejectUnexpectedKeys(errors, scheduleD.confirmations,
      [...SIMPLE_SCHEDULE_D_CONFIRMATIONS],
      'scheduleD.confirmations',
      'SCHEDULE_D_CONFIRMATION_CONFLICT');
    for(const field of SIMPLE_SCHEDULE_D_CONFIRMATIONS){
      if(scheduleD.confirmations[field] !== true){
        issue(errors, 'MISSING_SIMPLE_SCHEDULE_D_CONFIRMATION',
          `scheduleD.confirmations.${field} must be true`,
          `scheduleD.confirmations.${field}`);
      }
    }
    return;
  }

  rejectUnexpectedKeys(errors, scheduleD, ['mode', 'amount'],
    'scheduleD', 'SCHEDULE_D_SOURCE_CONFLICT');
  requireFinite(errors, scheduleD.amount, 'scheduleD.amount');
}

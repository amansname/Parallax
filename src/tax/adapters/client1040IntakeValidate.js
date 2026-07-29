/* Validate client 1040 intake before compose. */

import { readIntakeField } from '../core/1040BasicLineMap.js';
import {
  CLIENT_1040_COMPATIBILITY_MODES,
  validateClient1040Contract,
} from '../core/client1040IntakeContract.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function pushError(errors, code, message){
  errors.push({ code, message });
}

function pushWarning(warnings, code, message){
  warnings.push({ code, message });
}

function assertNonNegative(errors, value, label){
  // Legacy unversioned intake historically treated null as absent. Canonical
  // validation rejects null before this compatibility validator runs.
  if(value === undefined || value === null) return;
  if(typeof value !== 'number' || !Number.isFinite(value)){
    pushError(errors, 'INVALID_NUMBER', `${label} must be a number`);
    return;
  }
  if(value < 0) pushError(errors, 'NEGATIVE_AMOUNT', `${label} cannot be negative`);
}

function addPendingCanonicalCapabilities(errors, intake, contract){
  if(contract.compatibilityMode !== CLIENT_1040_COMPATIBILITY_MODES.CANONICAL) return;
  const deductions = intake.deductions;
  if(deductions?.source === 'calculated' && deductions.method === 'standard'){
    pushError(errors, 'STANDARD_DEDUCTION_AGE_BLIND_RULE_PENDING',
      'Canonical calculated standard deduction is blocked until age/blind additions are implemented');
  }
  if(deductions?.source === 'calculated' && deductions.method === 'itemized'){
    pushError(errors, 'CALCULATED_ITEMIZED_DEDUCTION_RULES_PENDING',
      'Canonical calculated itemized deductions are blocked until the versioned rules are implemented');
  }
  if(deductions?.schedule1A?.mode === 'calculate-enhanced-senior'){
    pushError(errors, 'ENHANCED_SENIOR_DEDUCTION_RULE_PENDING',
      'Canonical enhanced senior deduction is blocked until the Schedule 1-A rule is implemented');
  }
  if(intake.taxYear === 2026 && Array.isArray(intake.scheduleSE)
      && intake.scheduleSE.length > 0){
    pushError(errors, 'SCHEDULE_SE_2026_RULE_PENDING',
      'Canonical 2026 Schedule SE is blocked until the 2026 rule data is implemented');
  }
}

function addCanonicalLimitations(warnings, contract){
  if(contract.compatibilityMode !== CLIENT_1040_COMPATIBILITY_MODES.CANONICAL) return;
  for(const limitation of contract.limitations){
    pushWarning(warnings, limitation.code, limitation.message);
  }
}

export function validateClient1040Intake(intake, context){
  const errors = [];
  const warnings = [];
  const contractValidation = validateClient1040Contract(intake, context);
  errors.push(...contractValidation.errors);
  if(intake && typeof intake === 'object' && !Array.isArray(intake)){
    addPendingCanonicalCapabilities(errors, intake, contractValidation.contract);
  }

  if(!intake || typeof intake !== 'object' || Array.isArray(intake)){
    pushError(errors, 'INVALID_INTAKE', 'intake must be a plain object');
    return { errors, warnings, contract: contractValidation.contract };
  }

  if(!intake.filingStatus){
    pushError(errors, 'MISSING_FILING_STATUS', 'filingStatus is required');
  }

  const wages = readIntakeField(intake, 'income.wages');
  const ordinaryDividends = readIntakeField(intake, 'income.ordinaryDividends');
  const qualifiedDividends = readIntakeField(intake, 'income.qualifiedDividends');
  const itemized = intake.deductions?.itemizedAmount;
  const useStandard = intake.deductions?.useStandard;

  assertNonNegative(errors, wages, 'income.wages');
  assertNonNegative(errors, ordinaryDividends, 'income.ordinaryDividends');
  assertNonNegative(errors, qualifiedDividends, 'income.qualifiedDividends');
  assertNonNegative(errors, itemized, 'deductions.itemizedAmount');

  if(qualifiedDividends !== undefined && ordinaryDividends !== undefined
      && qualifiedDividends > ordinaryDividends){
    pushError(errors, 'QD_EXCEEDS_ORDINARY', 'income.qualifiedDividends cannot exceed income.ordinaryDividends');
  }

  if(useStandard === true && itemized !== undefined){
    pushError(errors, 'DEDUCTION_CONFLICT', 'deductions.useStandard and deductions.itemizedAmount are contradictory');
  }

  if(intake.taxYear !== undefined
      && (typeof intake.taxYear !== 'number' || !Number.isFinite(intake.taxYear))){
    pushError(errors, 'INVALID_TAX_YEAR', 'taxYear must be a finite number');
  }

  if(intake.passThrough){
    for(const lineId of ['line11a', 'line15', 'line17', 'line19', 'line20', 'line23']){
      const value = intake.passThrough[lineId];
      if(value === undefined) continue;
      if(typeof value !== 'number' || !Number.isFinite(value)){
        pushError(errors, 'INVALID_PASS_THROUGH', `passThrough.${lineId} must be a number`);
      }
    }
  }

  if(intake.scheduleD && typeof intake.scheduleD !== 'object'){
    pushWarning(warnings, 'SCHEDULE_D_SHAPE', 'scheduleD should be an object when supplied');
  }

  if(intake.scheduleSE !== undefined){
    if(!Array.isArray(intake.scheduleSE) || intake.scheduleSE.length === 0){
      pushError(errors, 'INVALID_SCHEDULE_SE', 'scheduleSE must be a non-empty array');
    } else {
      for(const [index, scheduleSE] of intake.scheduleSE.entries()){
        if(!scheduleSE || typeof scheduleSE !== 'object' || Array.isArray(scheduleSE)){
          pushError(errors, 'INVALID_SCHEDULE_SE', `scheduleSE[${index}] must be an object`);
          continue;
        }
        assertNonNegative(
          errors,
          scheduleSE.netEarningsFromSelfEmployment,
          `scheduleSE[${index}].netEarningsFromSelfEmployment`
        );
        assertNonNegative(
          errors,
          scheduleSE.socialSecurityWagesAndTips,
          `scheduleSE[${index}].socialSecurityWagesAndTips`
        );
        if(scheduleSE.netEarningsFromSelfEmployment === undefined){
          pushError(errors, 'MISSING_SCHEDULE_SE_INPUT',
            `scheduleSE[${index}].netEarningsFromSelfEmployment is required`);
        }
        if(scheduleSE.socialSecurityWagesAndTips === undefined){
          pushError(errors, 'MISSING_SCHEDULE_SE_INPUT',
            `scheduleSE[${index}].socialSecurityWagesAndTips is required`);
        }
      }
    }

    const schedule2 = intake.schedule2;
    if(!schedule2 || typeof schedule2 !== 'object' || Array.isArray(schedule2)){
      pushError(errors, 'MISSING_SCHEDULE_2_INPUT',
        'schedule2 supplied-tax components are required when scheduleSE is supplied');
    } else {
      for(const field of ['netInvestmentIncomeTax', 'additionalMedicareTax', 'otherPartIITaxes']){
        assertNonNegative(errors, schedule2[field], `schedule2.${field}`);
        if(schedule2[field] === undefined){
          pushError(errors, 'MISSING_SCHEDULE_2_INPUT', `schedule2.${field} is required`);
        }
      }
    }
  }

  if(errors.length === 0){
    addCanonicalLimitations(warnings, contractValidation.contract);
  }
  return { errors, warnings, contract: contractValidation.contract };
}

export function applyValidationWarnings(warnings, intake, result){
  const expectedAgi = intake.passThrough?.line11a;
  if(expectedAgi !== undefined && result.form1040.line11a?.value !== undefined){
    const computed = result.form1040.line11a.value;
    if(round2(expectedAgi) !== round2(computed)){
      pushWarning(warnings, 'AGI_MISMATCH',
        `passThrough.line11a (${expectedAgi}) differs from calculated line11a (${computed})`);
    }
  }

  const expectedTaxable = intake.passThrough?.line15;
  if(expectedTaxable !== undefined && result.form1040.line15?.value !== undefined){
    const computed = result.form1040.line15.value;
    if(round2(expectedTaxable) !== round2(computed)){
      pushWarning(warnings, 'TAXABLE_INCOME_MISMATCH',
        `passThrough.line15 (${expectedTaxable}) differs from calculated line15 (${computed})`);
    }
  }
}

/* ============================================================================

   ADAPTER: Client 1040 intake JSON → composeAnnualFederalTax input

   Maps a human-friendly intake shape (derived from a client 1040) into the

   composer contract. Does not calculate tax law — reshapes and routes fields.

   ============================================================================ */

import {
  CLIENT_1040_COMPATIBILITY_MODES,
} from '../core/client1040IntakeContract.js';
import { validateClient1040Intake } from './client1040IntakeValidate.js';


const PASS_THROUGH_LINE_IDS = ['line11a', 'line15', 'line17', 'line19', 'line20', 'line23'];

function assertVersionedIntakeIsMappable(intake){
  const validation = validateClient1040Intake(intake);
  if(validation.contract.compatibilityMode
      === CLIENT_1040_COMPATIBILITY_MODES.LEGACY_UNVERSIONED){
    return validation.contract.compatibilityMode;
  }
  if(validation.errors.length > 0){
    const error = new Error(
      `Versioned client 1040 intake is invalid: ${
        validation.errors.map(entry => entry.message).join('; ')
      }`
    );
    error.validation = validation;
    throw error;
  }
  return validation.contract.compatibilityMode;
}



export function client1040IntakeToComposerInput(intake){

  if(!intake || typeof intake !== 'object' || Array.isArray(intake)){

    throw new Error('intake must be a plain object');

  }

  if(!intake.filingStatus){

    throw new Error('intake.filingStatus is required');

  }

  const intakeCompatibilityMode = assertVersionedIntakeIsMappable(intake);

  const input = {
    filingStatus: intake.filingStatus,
    intakeCompatibilityMode,
  };



  if(intake.taxYear !== undefined) input.taxYear = intake.taxYear;

  if(intake.returnScope) input.returnScope = { ...intake.returnScope };

  if(intake.taxpayers){

    input.taxpayers = Object.fromEntries(

      Object.entries(intake.taxpayers)

        .map(([owner, facts]) => [owner, { ...facts }])

    );

  }



  if(intake.taxableOrdinaryIncome !== undefined){

    input.taxableOrdinaryIncome = intake.taxableOrdinaryIncome;

  }



  if(intake.income){

    input.supplied = { ...(input.supplied || {}) };

    const inc = intake.income;



    if(inc.wages !== undefined) input.supplied.line1z = inc.wages;

    if(inc.taxableInterest !== undefined) input.supplied.line2b = inc.taxableInterest;

    if(inc.taxExemptInterest !== undefined) input.supplied.line2a = inc.taxExemptInterest;

    if(inc.ordinaryDividends !== undefined) input.supplied.line3b = inc.ordinaryDividends;

    if(inc.qualifiedDividends !== undefined) input.supplied.line3a = inc.qualifiedDividends;

    if(inc.iraDistributions !== undefined) input.supplied.line4a = inc.iraDistributions;

    if(inc.taxableIra !== undefined && inc.rothConversion !== undefined){
      input.supplied.line4b = inc.taxableIra + inc.rothConversion;
    } else if(inc.taxableIra !== undefined){
      input.supplied.line4b = inc.taxableIra;
    } else if(inc.rothConversion !== undefined){
      input.supplied.line4b = inc.rothConversion;
    }

    if(inc.pensionAmount !== undefined) input.supplied.line5a = inc.pensionAmount;

    if(inc.taxablePensions !== undefined) input.supplied.line5b = inc.taxablePensions;

    if(inc.socialSecurityBenefits !== undefined) input.supplied.line6a = inc.socialSecurityBenefits;

    if(inc.taxableSS !== undefined) input.supplied.line6b = inc.taxableSS;

    if(inc.taxableSocialSecurity !== undefined) input.supplied.line6b = inc.taxableSocialSecurity;

    if(inc.capitalGain !== undefined) input.supplied.line7a = inc.capitalGain;

    if(inc.otherIncome !== undefined) input.supplied.line8 = inc.otherIncome;

    if(inc.schedule1Income !== undefined) input.supplied.line8 = inc.schedule1Income;



    if(inc.netLongTermCapitalGains !== undefined){

      input.capitalGains = {

        ...(input.capitalGains || {}),

        netLongTermCapitalGains: inc.netLongTermCapitalGains,

      };

    }



    if(inc.socialSecurity?.mode === 'calculate-taxable-benefits'){
      const { mode: _mode, ...worksheet } = inc.socialSecurity;
      input.supplied.line6a = inc.socialSecurityBenefits;
      input.supplied.line2a = inc.taxExemptInterest;
      input.socialSecurity = {
        filingStatus: intake.filingStatus,
        ...worksheet,
        socialSecurityBenefits: inc.socialSecurityBenefits,
        taxExemptInterest: inc.taxExemptInterest,
        livedWithSpouse: intake.filingStatus === 'marriedFilingSeparately'
          ? worksheet.livedWithSpouse
          : false,
      };
    } else if(inc.socialSecurity
        && inc.socialSecurity.mode !== 'supplied-form1040-lines'){
      input.socialSecurity = {
        filingStatus: intake.filingStatus,
        ...inc.socialSecurity,
      };
    }

  }



  if(intake.adjustments){

    if(intake.adjustments.mode === 'supplied-line10'){

      input.supplied = { ...(input.supplied || {}), line10: intake.adjustments.amount };

    }
    if(intake.adjustments.mode === 'supplied-traditional-ira-deduction'){
      input.adjustmentComponents = {
        traditionalIraDeduction: intake.adjustments.traditionalIraDeduction,
      };
    }

    if(intake.adjustments.total !== undefined){

      input.supplied = { ...(input.supplied || {}), line10: intake.adjustments.total };

    }

    if(intake.adjustments.line10 !== undefined){

      input.supplied = { ...(input.supplied || {}), line10: intake.adjustments.line10 };

    }

    if(intake.adjustments.ira){

      input.traditionalIra = {

        filingStatus: intake.filingStatus,

        ...intake.adjustments.ira,

      };

    }

  }



  if(intake.deductions){

    input.deductions = { ...intake.deductions };

    if(intake.deductions.method){

      if(intake.deductions.source === 'calculated'){

        input.deductions.useStandard = intake.deductions.method === 'standard';

      } else if(intake.deductions.source === 'supplied-line12e'){

        input.supplied = {

          ...(input.supplied || {}),

          line12e: intake.deductions.line12e,

        };

      }

    }

    if(intake.deductions.itemizedAmount !== undefined){

      input.supplied = { ...(input.supplied || {}), line12e: intake.deductions.itemizedAmount };

    }

    if(intake.deductions.qbi !== undefined){

      input.supplied = { ...(input.supplied || {}), line13a: intake.deductions.qbi };

    }

    if(intake.deductions.additional !== undefined){

      input.supplied = { ...(input.supplied || {}), line13b: intake.deductions.additional };

    }

    const schedule1A = intake.deductions.schedule1A;

    if(schedule1A?.mode === 'supplied-line13b'){

      input.supplied = { ...(input.supplied || {}), line13b: schedule1A.amount };

    }

  }



  if(intake.passThrough){

    input.passThrough = { ...(input.passThrough || {}) };

    for(const lineId of PASS_THROUGH_LINE_IDS){

      if(intake.passThrough[lineId] !== undefined){

        input.passThrough[lineId] = intake.passThrough[lineId];

      }

    }

    if(intake.passThrough.payments !== undefined){

      input.passThrough.payments = intake.passThrough.payments;

    }

  }



  if(intake.supplied){

    input.supplied = { ...(input.supplied || {}), ...intake.supplied };

  }



  if(intake.socialSecurity){

    input.socialSecurity = { filingStatus: intake.filingStatus, ...intake.socialSecurity };

  }

  if(intake.traditionalIra){

    input.traditionalIra = { filingStatus: intake.filingStatus, ...intake.traditionalIra };

  }

  if(intake.capitalGains){

    input.capitalGains = { ...(input.capitalGains || {}), ...intake.capitalGains };

  }



  if(intake.scheduleD){

    if(intake.scheduleD.mode === 'manual-net-long-term'){

      input.scheduleD = {

        mode: intake.scheduleD.mode,

        netLongTermGainOrLoss: intake.scheduleD.netLongTermGainOrLoss,

      };

    } else if(intake.scheduleD.mode === 'simple-net-long-term'){

      const amount = intake.scheduleD.netLongTermGainOrLoss;

      input.scheduleD = {

        line7: 0,

        line15: amount,

        line16: amount,

        line18: 0,

        line19: 0,

        form4952Line4g: 0,

      };

    } else if(intake.scheduleD.mode === 'schedule-d-summary'){

      input.scheduleD = {

        line7: intake.scheduleD.line7,

        line15: intake.scheduleD.line15,

        line16: intake.scheduleD.line16,

        line18: intake.scheduleD.line18,

        line19: intake.scheduleD.line19,

      };

    } else if(intake.scheduleD.mode === 'supplied-form1040-line7'){

      input.supplied = {

        ...(input.supplied || {}),

        line7a: intake.scheduleD.amount,

      };
      input.capitalGains = {
        ...(input.capitalGains || {}),
        // A return-supplied line 7 has no ST/LT evidence. Keep it ordinary.
        netLongTermCapitalGains: 0,
      };

    } else {

      input.scheduleD = { ...intake.scheduleD };

    }

  }

  if(intake.scheduleSE){
    input.scheduleSE = intake.scheduleSE.map((entry) => ({
      ...entry,
      ...(entry.taxpayerOwner !== undefined ? { taxpayer: entry.taxpayerOwner } : {}),
    }));
  }

  if(intake.schedule2){
    input.schedule2 = { ...intake.schedule2 };
  }



  return input;

}



export function reconcileTaxTotal(result, theirLine24, tolerance = 1){

  if(theirLine24 === undefined || theirLine24 === null) return null;

  const computed = result.totalFederalTax;
  if(typeof computed !== 'number' || !Number.isFinite(computed)){
    return {
      theirLine24,
      computedLine24: null,
      delta: null,
      withinTolerance: false,
      taxTotalScope: result.taxTotalScope,
    };
  }

  const delta = Math.round((computed - theirLine24 + Number.EPSILON) * 100) / 100;

  return {

    theirLine24,

    computedLine24: computed,

    delta,

    withinTolerance: Math.abs(delta) <= tolerance,

    taxTotalScope: result.taxTotalScope,

  };

}



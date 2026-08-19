/* Build a coverage report and run pipeline for client 1040 intake. */

import { composeAnnualFederalTax } from '../federal/composers/annualFederalTax.js';
import {
  FORM1040_BASIC_LINES,
  LINE_COVERAGE,
  linesByCoverage,
  readIntakeField,
} from '../core/1040BasicLineMap.js';
import { INCOME_DETAIL_LINE_IDS, LINE_STATUS, SPINE_LINE_IDS } from '../core/form1040Lines.js';
import { client1040IntakeToComposerInput } from './client1040Intake.js';
import { applyValidationWarnings, validateClient1040Intake } from './client1040IntakeValidate.js';
import { reconcileTaxTotal } from './client1040Intake.js';
import { CLIENT_1040_COMPATIBILITY_MODES } from '../core/client1040IntakeContract.js';

function isPassThroughLine(line){
  return line?.ruleId === 'INTAKE_PASS_THROUGH';
}

function fmtCaptured(entry, intake){
  const value = readIntakeField(intake, entry.intakePath);
  if(value === undefined) return null;
  return { lineId: entry.lineId, label: entry.label, intakePath: entry.intakePath, value };
}

export function buildIntakeReport(intake, result, validation, context){
  const warnings = [...validation.warnings];
  applyValidationWarnings(warnings, intake, result);

  if(intake.taxYear !== undefined && context?.taxYear !== undefined
      && intake.taxYear !== context.taxYear){
    warnings.push({
      code: 'TAX_YEAR_LAW_MISMATCH',
      message: `Intake taxYear ${intake.taxYear} differs from engine context taxYear ${context.taxYear}`,
    });
  }

  const captured = [];
  for(const entry of linesByCoverage(LINE_COVERAGE.CAPTURED)){
    const row = fmtCaptured(entry, intake);
    if(row) captured.push(row);
  }

  const calculated = [];
  const passThrough = [];
  const form1040 = result.form1040;

  for(const lineId of [...SPINE_LINE_IDS, ...INCOME_DETAIL_LINE_IDS]){
    const line = form1040[lineId];
    if(!line || line.status === LINE_STATUS.DEFERRED) continue;

    if(line.status === LINE_STATUS.CALCULATED){
      calculated.push({
        lineId,
        label: line.label,
        value: line.value,
        ruleId: line.ruleId,
      });
    } else if(isPassThroughLine(line)){
      passThrough.push({
        lineId,
        label: line.label,
        value: line.value,
        ruleId: line.ruleId,
      });
    } else if(line.status === LINE_STATUS.SUPPLIED){
      captured.push({
        lineId,
        label: line.label,
        intakePath: `supplied.${lineId}`,
        value: line.value,
        onSpine: SPINE_LINE_IDS.includes(lineId),
      });
    }
  }

  if(intake.passThrough?.payments !== undefined){
    passThrough.push({
      lineId: 'payments',
      label: 'Withholding / estimated payments',
      intakePath: 'passThrough.payments',
      value: intake.passThrough.payments,
      ruleId: 'INTAKE_PASS_THROUGH',
      notes: 'Not rolled into line 24',
    });
  }

  const unsupportedIntentional = linesByCoverage(LINE_COVERAGE.UNSUPPORTED_INTENTIONAL)
    .map((entry) => ({ lineId: entry.lineId, label: entry.label, notes: entry.notes }));

  const architectureLater = [];
  if(intake.scheduleD){
    const classified = form1040.line7a?.ruleId === 'FED_SCHEDULE_D_CLASSIFICATION';
    if(!classified){
      architectureLater.push({
        lineId: 'scheduleD',
        label: 'Schedule D ST/LT detail',
        notes: 'Captured; Schedule D classification not applied.',
        supplied: true,
      });
    }
  }

  const reconciliation = reconcileTaxTotal(
    result,
    intake.reconciliation?.theirLine24,
    intake.reconciliation?.tolerance ?? 1
  );

  return {
    contract: validation.contract,
    limitations: validation.contract.limitations,
    captured,
    calculated,
    passThrough,
    unsupportedIntentional,
    architectureLater,
    bugs: linesByCoverage(LINE_COVERAGE.BUG),
    validation: { errors: validation.errors, warnings },
    highlights: {
      line15: form1040.line15?.value ?? null,
      line16: form1040.line16?.value ?? null,
      line24: form1040.line24?.value ?? null,
    },
    line24Breakdown: {
      line16: form1040.line16?.value ?? null,
      line17: form1040.line17?.value ?? null,
      line18: form1040.line18?.value ?? null,
      line19: form1040.line19?.value ?? null,
      line20: form1040.line20?.value ?? null,
      line21: form1040.line21?.value ?? null,
      line22: form1040.line22?.value ?? null,
      line23: form1040.line23?.value ?? null,
      line24: form1040.line24?.value ?? null,
    },
    taxTotalScope: result.taxTotalScope,
    reconciliation,
    mapVersion: FORM1040_BASIC_LINES.length,
  };
}

export function runClient1040Intake(
  intake,
  context,
  { strict = true, additionalNetLongTermCapitalGain = 0 } = {},
){
  const validation = validateClient1040Intake(intake, context);
  const canonical = validation.contract.compatibilityMode
    === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL;
  if(validation.errors.length > 0 && (strict || canonical)){
    const err = new Error(validation.errors.map((e) => e.message).join('; '));
    err.validation = validation;
    throw err;
  }

  const input = client1040IntakeToComposerInput(intake, {
    additionalNetLongTermCapitalGain,
  });
  const { result, audits } = composeAnnualFederalTax(input, context);
  const report = buildIntakeReport(intake, result, validation, context);

  return { input, result, audits, validation, report };
}

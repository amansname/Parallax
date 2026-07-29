/* Stable annual Form 1040 module — public entry point before engine.js integration. */

import { client1040IntakeToComposerInput } from './adapters/client1040Intake.js';
import { validateClient1040Intake } from './adapters/client1040IntakeValidate.js';
import { buildIntakeReport, runClient1040Intake as runClient1040IntakePipeline } from './adapters/intakeReport.js';
import { resolvePreferentialComponents } from './federal/composers/form1040Spine.js';
import { buildTaxContext, resolveLawVersionForTaxYear, supportedTaxYears } from './core/lawRegistry.js';
import { engineYearTo1040Input, mapSimulationRowToYearFacts } from './adapters/engineYearTo1040Input.js';

export { validateClient1040Intake, client1040IntakeToComposerInput };
export { buildIntakeReport };
export { resolveLawVersionForTaxYear, supportedTaxYears, buildTaxContext };
export { engineYearTo1040Input, mapSimulationRowToYearFacts };
export {
  CLIENT_1040_INTAKE_CONTRACT_ID,
  CLIENT_1040_INTAKE_SCHEMA_VERSION,
  CLIENT_1040_INTAKE_CONTRACT_VERSION,
  CLIENT_1040_SUPPORTED_TAX_YEARS,
  CLIENT_1040_FIELD_DISPOSITIONS,
  CLIENT_1040_ADJUSTMENT_MODES,
  CLIENT_1040_SOCIAL_SECURITY_MODES,
  CLIENT_1040_LIMITATIONS,
  describeClient1040IntakeContract,
  deriveAccountTaxTreatment,
  validateClient1040Contract,
} from './core/client1040IntakeContract.js';

export const ANNUAL_1040_MODULE_VERSION = '1.6.0';

export function buildDefaultTaxContext(overrides = {}){
  return buildTaxContext(overrides);
}

function lineSnapshot(form1040, lineId){
  const line = form1040?.[lineId];
  if(!line) return { lineId, value: null, status: 'MISSING', ruleId: null };
  return {
    lineId,
    value: line.value,
    status: line.status,
    ruleId: line.ruleId ?? null,
  };
}

function extractRates(audits){
  const ordinary = audits.find((a) => a.ruleId === 'FED_ORDINARY_INCOME_TAX');
  if(!ordinary) return { marginalRate: null, effectiveRate: null };

  if(ordinary.result?.marginalRate != null){
    return {
      marginalRate: ordinary.result.marginalRate,
      effectiveRate: ordinary.result.effectiveRate ?? null,
    };
  }

  const steps = ordinary.calculationSteps ?? [];
  const taxableOrdinaryIncome = ordinary.inputsUsed?.taxableOrdinaryIncome ?? 0;

  if(taxableOrdinaryIncome <= 0 && steps.length === 0){
    return { marginalRate: null, effectiveRate: null };
  }

  const marginalRate = steps.length ? steps[steps.length - 1].rate ?? null : null;
  const ordinaryTax = steps.reduce((sum, step) => sum + (step.tax ?? 0), 0);
  const effectiveRate = taxableOrdinaryIncome > 0
    ? ordinaryTax / taxableOrdinaryIncome
    : null;

  return { marginalRate, effectiveRate };
}

/** Stable result contract for engine integration (one year, federal 1040 spine). */
export function buildAnnual1040Result(intake, composeResult, audits, validation, context, report){
  const form1040 = composeResult.form1040;
  const preferential = composeResult.preferentialIncome !== undefined
    ? { total: composeResult.preferentialIncome }
    : resolvePreferentialComponents(client1040IntakeToComposerInput(intake));

  const { marginalRate, effectiveRate } = extractRates(audits);
  const line15 = form1040.line15?.value ?? null;
  const line24 = composeResult.totalFederalTax ?? form1040.line24?.value ?? null;

  return {
    moduleVersion: ANNUAL_1040_MODULE_VERSION,
    contract: report.contract,
    taxYear: intake.taxYear ?? context.taxYear ?? null,
    filingStatus: intake.filingStatus,
    lines: {
      line9: lineSnapshot(form1040, 'line9'),
      line11: lineSnapshot(form1040, 'line11a'),
      line15: lineSnapshot(form1040, 'line15'),
      line16: lineSnapshot(form1040, 'line16'),
      line24: lineSnapshot(form1040, 'line24'),
    },
    federalSummary: {
      adjustedGrossIncome: form1040.line11a?.value ?? null,
      taxableIncome: line15,
      incomeTax: form1040.line16?.value ?? null,
      federalTaxLiability: line24,
      preferentialIncome: preferential.total,
      marginalRate,
      effectiveRate: line15 > 0 && line24 != null ? line24 / line15 : effectiveRate,
      taxTotalScope: composeResult.taxTotalScope,
    },
    calculated: report.calculated,
    captured: report.captured,
    passThrough: report.passThrough,
    unsupportedIntentional: report.unsupportedIntentional,
    architectureLater: report.architectureLater,
    limitations: report.limitations,
    readiness: {
      unresolvedTaxableIncomeLines:
        composeResult.readiness?.unresolvedTaxableIncomeLines ?? [],
      capitalLossCarryforward:
        composeResult.readiness?.capitalLossCarryforward ?? {
          status: 'NOT_EVALUATED',
          exactAmount: null,
          minimumAmount: null,
        },
    },
    warnings: report.validation.warnings,
    errors: report.validation.errors,
    audit: audits.map((entry) => ({
      ruleId: entry.ruleId,
      ruleVersion: entry.ruleVersion ?? null,
      dataSourcesUsed: entry.dataSourcesUsed ?? [],
    })),
    metadata: {
      calculatedAt: context.calculatedAt,
      runId: context.runId,
      scenarioId: context.scenarioId,
      lawVersion: context.lawVersion,
      engineTaxYear: context.taxYear,
      mapVersion: report.mapVersion,
      contract: report.contract,
    },
    line24Breakdown: report.line24Breakdown,
    reconciliation: report.reconciliation,
  };
}

/**
 * Full intake pipeline:
 * client1040Input → validate → compose → annual1040Result
 */
export function runClient1040Intake(intake, context, options = {}){
  const pipeline = runClient1040IntakePipeline(intake, context, options);
  const annual1040Result = buildAnnual1040Result(
    intake,
    pipeline.result,
    pipeline.audits,
    pipeline.validation,
    context,
    pipeline.report
  );

  return {
    ...pipeline,
    annual1040Result,
  };
}

/**
 * One engine/planning year → client1040 intake → annual1040Result.
 * Stable entry for future engine.js integration (adapter only, no live wiring).
 */
export function runEngineYearTax(engineYearFacts, context, options = {}){
  const intake = engineYearTo1040Input(engineYearFacts);
  return runClient1040Intake(intake, context, options);
}

export function assessAnnual1040EngineReadiness(){
  return {
    readyForOneYearEngineAdapter: true,
    blockers: [
      'NIIT, AMT, full credit rules, and Schedule D ST/LT split are not independently calculated.',
      'Simulation row → year facts requires planMeta gain fraction for taxable-account withdrawals.',
    ],
    supportedTaxYears: supportedTaxYears(),
    stableExports: [
      'validateClient1040Intake',
      'runClient1040Intake',
      'runEngineYearTax',
      'engineYearTo1040Input',
      'mapSimulationRowToYearFacts',
      'buildAnnual1040Result',
      'buildDefaultTaxContext',
    ],
    moduleVersion: ANNUAL_1040_MODULE_VERSION,
  };
}

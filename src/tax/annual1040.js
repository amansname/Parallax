/* Stable annual Form 1040 module — public entry point before engine.js integration. */

import { client1040IntakeToComposerInput } from './adapters/client1040Intake.js';
import { validateClient1040Intake } from './adapters/client1040IntakeValidate.js';
import { buildIntakeReport, runClient1040Intake as runClient1040IntakePipeline } from './adapters/intakeReport.js';
import { resolvePreferentialComponents } from './federal/composers/form1040Spine.js';
import { buildTaxContext, resolveLawVersionForTaxYear, supportedTaxYears } from './core/lawRegistry.js';
import {
  buildProjectedAnnualFederalTaxInput,
  engineYearTo1040Input,
  mapSimulationRowToYearFacts,
} from './adapters/engineYearTo1040Input.js';
import { TaxInputError } from './core/errors.js';
import {
  CAPITAL_GAINS_TAX_RATES,
  SOCIAL_SECURITY_TAXATION_RATES,
} from './core/constants.js';

export { validateClient1040Intake, client1040IntakeToComposerInput };
export { buildIntakeReport };
export { resolveLawVersionForTaxYear, supportedTaxYears, buildTaxContext };
export {
  buildProjectedAnnualFederalTaxInput,
  engineYearTo1040Input,
  mapSimulationRowToYearFacts,
};
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

export const ANNUAL_1040_MODULE_VERSION = '1.7.0';

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
      incomeTaxComponents: composeResult.incomeTaxComponents,
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
 * Source-agnostic authority for one normalized federal tax year.
 * Adapters own source translation; this contract owns the federal calculation.
 */
export function calculateAnnualFederalTax(input, context, options = {}){
  if(input === null || typeof input !== 'object' || Array.isArray(input)){
    throw new TaxInputError('annual federal tax input must be a plain object');
  }
  if(!Number.isInteger(input.taxYear)){
    throw new TaxInputError('annual federal tax input requires an explicit integer taxYear', {
      taxYear: input.taxYear ?? null,
    });
  }
  if(context === null || typeof context !== 'object' || Array.isArray(context)){
    throw new TaxInputError('annual federal tax context must be a plain object');
  }
  if(input.taxYear !== context.taxYear){
    throw new TaxInputError('annual federal tax input.taxYear must match context.taxYear', {
      inputTaxYear: input.taxYear,
      contextTaxYear: context.taxYear ?? null,
    });
  }
  return runClient1040Intake(input, context, options);
}

/**
 * One engine/planning year → client1040 intake → annual1040Result.
 * Stable entry for future engine.js integration (adapter only, no live wiring).
 */
export function runEngineYearTax(engineYearFacts, context, options = {}){
  const adapted = engineYearTo1040Input(engineYearFacts);
  const input = adapted.taxYear === undefined && Number.isInteger(context?.taxYear)
    ? { ...adapted, taxYear: context.taxYear }
    : adapted;
  return calculateAnnualFederalTax(input, context, options);
}

const roundTaxDollar = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const finiteTaxDollar = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);
const taxDifference = (selected, comparison) => {
  const selectedValue = finiteTaxDollar(selected);
  const comparisonValue = finiteTaxDollar(comparison);
  return selectedValue === null || comparisonValue === null
    ? null
    : roundTaxDollar(selectedValue - comparisonValue);
};

const COMPARISON_SCOPE_LINES = Object.freeze([
  'line12e',
  'line13a',
  'line13b',
  'line17',
  'line19',
  'line20',
  'line23',
]);

function stableComparisonValue(value, path = '', omittedPaths = new Set()){
  if(omittedPaths.has(path)) return undefined;
  if(Array.isArray(value)){
    return value.map((item, index) => (
      stableComparisonValue(item, `${path}[${index}]`, omittedPaths)
    ));
  }
  if(value && typeof value === 'object'){
    const entries =
      Object.keys(value).sort().flatMap(key => {
        const childPath = path ? `${path}.${key}` : key;
        const child = stableComparisonValue(value[key], childPath, omittedPaths);
        return child === undefined ? [] : [[key, child]];
      });
    return path && entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value;
}

function comparisonIdentity(run, facts){
  const annual = run?.annual1040Result ?? {};
  const form1040 = run?.result?.form1040 ?? {};
  const returnScopeSignature = stableComparisonValue(facts?.returnScope ?? null);
  const taxpayerSignature = stableComparisonValue(facts?.taxpayers ?? {});
  return {
    taxYear: annual.taxYear ?? facts?.taxYear ?? null,
    filingStatus: annual.filingStatus ?? facts?.filingStatus ?? null,
    modeledTaxpayer: facts?.returnScope?.modeledTaxpayer ?? null,
    returnScopeSignature,
    taxpayerSignature,
    taxTotalScope: annual.federalSummary?.taxTotalScope ?? null,
    lineCoverage: Object.fromEntries(
      COMPARISON_SCOPE_LINES.map(lineId => [
        lineId,
        {
          status: form1040?.[lineId]?.status ?? null,
          ruleId: form1040?.[lineId]?.ruleId ?? null,
          suppliedValue: form1040?.[lineId]?.status === 'SUPPLIED'
            ? form1040?.[lineId]?.value ?? null
            : null,
        },
      ])
    ),
  };
}

function taxRunsAreComparable({
  selectedRun,
  comparisonRun,
  selectedFacts,
  comparisonFacts,
  comparison,
  issues,
}){
  const selected = comparisonIdentity(selectedRun, selectedFacts);
  const candidate = comparisonIdentity(comparisonRun, comparisonFacts);
  const identityMatches = selected.taxYear === candidate.taxYear
    && selected.filingStatus === candidate.filingStatus
    && selected.modeledTaxpayer === candidate.modeledTaxpayer
    && JSON.stringify(selected.returnScopeSignature)
      === JSON.stringify(candidate.returnScopeSignature)
    && JSON.stringify(selected.taxpayerSignature)
      === JSON.stringify(candidate.taxpayerSignature);
  if(!identityMatches){
    issues.push({
      code: 'TAX_IDENTITY_MISMATCH',
      comparison,
      selected: {
        taxYear: selected.taxYear,
        filingStatus: selected.filingStatus,
        modeledTaxpayer: selected.modeledTaxpayer,
        returnScope: selected.returnScopeSignature,
        taxpayers: selected.taxpayerSignature,
      },
      candidate: {
        taxYear: candidate.taxYear,
        filingStatus: candidate.filingStatus,
        modeledTaxpayer: candidate.modeledTaxpayer,
        returnScope: candidate.returnScopeSignature,
        taxpayers: candidate.taxpayerSignature,
      },
    });
    return false;
  }
  if(!selectedRun || !comparisonRun) return false;

  const allowedDifferences = comparison === 'baseline'
    ? new Set([
      'income.iraDistributions',
      'income.taxableIra',
      'income.rothConversion',
      'income.capitalGain',
      'income.socialSecurity.otherIncome',
      'resolved.taxableIra',
      'scheduleD.netLongTermGainOrLoss',
    ])
    : new Set([
      'income.socialSecurityBenefits',
      'income.taxableSS',
      'socialSecurity',
    ]);
  const selectedFactContract = stableComparisonValue(
    selectedFacts,
    '',
    allowedDifferences
  );
  const candidateFactContract = stableComparisonValue(
    comparisonFacts,
    '',
    allowedDifferences
  );
  if(JSON.stringify(selectedFactContract) !== JSON.stringify(candidateFactContract)){
    issues.push({
      code: 'TAX_SCOPE_MISMATCH',
      comparison,
      selected: { factContract: selectedFactContract },
      candidate: { factContract: candidateFactContract },
    });
    return false;
  }

  const scopeMatches = selected.taxTotalScope === candidate.taxTotalScope
    && JSON.stringify(selected.lineCoverage)
      === JSON.stringify(candidate.lineCoverage);
  if(!scopeMatches){
    issues.push({
      code: 'TAX_SCOPE_MISMATCH',
      comparison,
      selected: {
        taxTotalScope: selected.taxTotalScope,
        lineCoverage: selected.lineCoverage,
      },
      candidate: {
        taxTotalScope: candidate.taxTotalScope,
        lineCoverage: candidate.lineCoverage,
      },
    });
    return false;
  }
  return true;
}

/**
 * Authoritative tax-engine comparison contract for a Withdrawal Planner year.
 * The planning layer supplies three fact bundles; this module owns every tax run
 * and returns finished tax dollars so no bracket or counterfactual math leaks
 * into the UI.
 */
export function runWithdrawalPlannerTaxAnalysis({
  selectedFacts,
  baselineFacts,
  withoutSocialSecurityFacts,
  selectedInput,
  baselineInput,
  withoutSocialSecurityInput,
  context,
  options = {},
  calculationOptions = {},
}){
  const comparisonIssues = [];
  const runComparison = (facts, input, failureCode, comparison) => {
    try {
      const runOptions = {
        ...options,
        ...(calculationOptions[comparison] ?? {}),
      };
      return input
        ? calculateAnnualFederalTax(input, context, runOptions)
        : runEngineYearTax(facts, context, runOptions);
    } catch{
      comparisonIssues.push({
        code: failureCode,
        comparison,
      });
      return null;
    }
  };
  const selectedRun = runComparison(
    selectedFacts,
    selectedInput,
    'SELECTED_TAX_RUN_FAILED',
    'selected'
  );
  const baselineRun = runComparison(
    baselineFacts,
    baselineInput,
    'BASELINE_TAX_RUN_FAILED',
    'baseline'
  );
  const withoutSocialSecurityRun = runComparison(
    withoutSocialSecurityFacts,
    withoutSocialSecurityInput,
    'WITHOUT_SOCIAL_SECURITY_TAX_RUN_FAILED',
    'withoutSocialSecurity'
  );
  const selectedSummary = selectedRun?.annual1040Result?.federalSummary ?? {};
  const baselineSummary = baselineRun?.annual1040Result?.federalSummary ?? {};
  const withoutSocialSecuritySummary =
    withoutSocialSecurityRun?.annual1040Result?.federalSummary ?? {};
  const components = selectedSummary.incomeTaxComponents ?? {};
  const selectedTax = finiteTaxDollar(selectedSummary.federalTaxLiability);
  const baselineTax = finiteTaxDollar(baselineSummary.federalTaxLiability);
  const withoutSocialSecurityTax = finiteTaxDollar(
    withoutSocialSecuritySummary.federalTaxLiability
  );
  const baselineComparable = taxRunsAreComparable({
    selectedRun,
    comparisonRun: baselineRun,
    selectedFacts: selectedInput ?? selectedFacts,
    comparisonFacts: baselineInput ?? baselineFacts,
    comparison: 'baseline',
    issues: comparisonIssues,
  });
  const withoutSocialSecurityComparable = taxRunsAreComparable({
    selectedRun,
    comparisonRun: withoutSocialSecurityRun,
    selectedFacts: selectedInput ?? selectedFacts,
    comparisonFacts: withoutSocialSecurityInput ?? withoutSocialSecurityFacts,
    comparison: 'withoutSocialSecurity',
    issues: comparisonIssues,
  });

  return {
    selectedRun,
    baselineRun,
    withoutSocialSecurityRun,
    thresholdTaxDollars: {
      ordinaryIncomeTax: finiteTaxDollar(components.ordinaryIncomeTax),
      preferentialIncomeTax: finiteTaxDollar(components.preferentialIncomeTax),
      irmaaPremium: null,
      socialSecurityIncrementalModeledFederalIncomeTax:
        withoutSocialSecurityComparable
          ? taxDifference(selectedTax, withoutSocialSecurityTax)
          : null,
    },
    thresholdRates: {
      ltcg: CAPITAL_GAINS_TAX_RATES,
      socialSecurity: SOCIAL_SECURITY_TAXATION_RATES,
    },
    modeledFederalIncomeTax: {
      baseline: baselineTax,
      selected: selectedTax,
      incremental: baselineComparable
        ? taxDifference(selectedTax, baselineTax)
        : null,
      taxTotalScope: selectedSummary.taxTotalScope ?? null,
    },
    comparisonIssues,
  };
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
      'calculateAnnualFederalTax',
      'runEngineYearTax',
      'runWithdrawalPlannerTaxAnalysis',
      'engineYearTo1040Input',
      'mapSimulationRowToYearFacts',
      'buildAnnual1040Result',
      'buildDefaultTaxContext',
    ],
    moduleVersion: ANNUAL_1040_MODULE_VERSION,
  };
}

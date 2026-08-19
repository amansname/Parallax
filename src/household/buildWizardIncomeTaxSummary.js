import { buildAvailableInputTaxSummary } from '../planning/tax/buildAvailableInputTaxSummary.js';
import { buildCurrentIncomeTaxSummary } from '../planning/tax/buildCurrentIncomeTaxSummary.js';
import {
  buildCurrent1040Intake,
  buildKnownCurrent1040IncomeSubtotal,
} from '../planning/tax/buildCurrent1040Intake.js';
import { buildWizardTaxPlan } from './wizardCurrent1040.js';
import { confirmWizardTaxInputs } from './wizardTaxCompletion.js';

function wizardNeedsFactsSummary(plan, error){
  const code = error?.code;
  return {
    status: 'needs_facts',
    sourceMode: 'canonical-v1',
    message: error?.message || 'Current-return tax facts are incomplete',
    reasonCodes: code ? [code] : [],
    field: error?.field,
    totalIncome: buildKnownCurrent1040IncomeSubtotal(plan),
    federalTaxLiability: null,
    deductionUsed: null,
    rmdAge: 73,
    firstRmdYear: null,
  };
}

/**
 * Derive a wizard tax summary from a clone without mutating the saved plan.
 * Runs confirmWizardTaxInputs on the clone only; failures become needs_facts.
 */
export function buildWizardIncomeTaxSummary(plan){
  const calculationPlan = buildWizardTaxPlan(plan);
  try{
    confirmWizardTaxInputs(calculationPlan);
  }catch(error){
    const available = buildAvailableInputTaxSummary(
      plan,
      calculationPlan,
      error
    );
    if(available) return available;
    return wizardNeedsFactsSummary(plan, error);
  }
  return buildCurrentIncomeTaxSummary(calculationPlan);
}

/**
 * Saved current-year Tax facts -> an authoritative normalized annual input.
 * Unlike the Tax-page estimate helper, this never confirms, fills, or otherwise
 * materializes missing facts on a clone.
 */
export function buildCurrentAnnualFederalTaxBaseline(plan){
  const savedCurrent1040 = plan?.incomeTax?.current1040;
  if(!savedCurrent1040
      || typeof savedCurrent1040 !== 'object'
      || Array.isArray(savedCurrent1040)
      || savedCurrent1040.incomeSourcesComplete !== true){
    const code = savedCurrent1040
      ? 'CURRENT_1040_INCOME_SOURCES_INCOMPLETE'
      : 'CURRENT_1040_ENVELOPE_REQUIRED';
    const message = savedCurrent1040
      ? 'Saved current-return income facts have not been confirmed complete'
      : 'A saved canonical current-return Tax record is required';
    const issue = Object.freeze({
      code,
      path: savedCurrent1040
        ? 'incomeTax.current1040.incomeSourcesComplete'
        : 'incomeTax.current1040',
      message,
    });
    return Object.freeze({
      status: 'needs_facts',
      sourceMode: 'current-tax-baseline',
      input: null,
      summary: Object.freeze({
        status: 'needs_facts',
        sourceMode: 'canonical-v1',
        message,
        reasonCodes: Object.freeze([code]),
      }),
      issues: Object.freeze([issue]),
    });
  }
  const built = buildCurrent1040Intake(plan);
  const summary = buildCurrentIncomeTaxSummary(plan);
  const calculable = summary.status === 'ready'
    && typeof summary.federalTaxLiability === 'number'
    && Number.isFinite(summary.federalTaxLiability)
    && built.gaps.length === 0;
  const summaryIssues = Array.isArray(summary.gaps) && summary.gaps.length > 0
    ? summary.gaps
    : (summary.reasonCodes || []).map(code => ({
        code,
        ...(summary.message ? { message: summary.message } : {}),
      }));
  const issues = calculable
    ? []
    : built.gaps.length > 0
      ? built.gaps
      : summaryIssues.length > 0
        ? summaryIssues
        : [{
            code: 'CURRENT_1040_BASELINE_NOT_READY',
            message: summary.message || 'Saved current-return tax facts are not ready',
          }];
  return Object.freeze({
    status: calculable ? 'ready' : 'needs_facts',
    sourceMode: 'current-tax-baseline',
    input: calculable ? built.intake : null,
    summary,
    issues: Object.freeze(issues.map(issue => Object.freeze({ ...issue }))),
  });
}

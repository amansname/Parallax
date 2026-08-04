import { buildAvailableInputTaxSummary } from '../planning/tax/buildAvailableInputTaxSummary.js';
import { buildCurrentIncomeTaxSummary } from '../planning/tax/buildCurrentIncomeTaxSummary.js';
import { buildKnownCurrent1040IncomeSubtotal } from '../planning/tax/buildCurrent1040Intake.js';
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
  const clone = buildWizardTaxPlan(plan);
  try{
    confirmWizardTaxInputs(clone);
  }catch(error){
    const available = buildAvailableInputTaxSummary(plan, clone, error);
    if(available) return available;
    return wizardNeedsFactsSummary(plan, error);
  }
  return buildCurrentIncomeTaxSummary(clone);
}

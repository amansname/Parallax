import { buildCurrentIncomeTaxSummary } from '../planning/tax/buildCurrentIncomeTaxSummary.js';
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
    totalIncome: null,
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
    return wizardNeedsFactsSummary(plan, error);
  }
  return buildCurrentIncomeTaxSummary(clone);
}

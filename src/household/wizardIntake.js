import { buildWizardIncomeTaxSummary } from './buildWizardIncomeTaxSummary.js';
import {
  buildWizardTaxPlan,
  ensureWizardCurrent1040,
  syncWizardTaxpayerFacts,
} from './wizardCurrent1040.js';
import {
  overrideWizardIncomeGroup,
  readWizardPlanningIncome,
  revertWizardIncomeGroup,
} from './wizardPlanningIncome.js';
import {
  clearWizardTaxConfirmation,
  confirmWizardTaxInputs,
  invalidateWizardTaxCompletion,
} from './wizardTaxCompletion.js';
import {
  deductionModeForWizard,
  removeWizardTaxItem,
  setWizardTaxField,
} from './wizardTaxMutations.js';

export {
  buildWizardIncomeTaxSummary,
  buildWizardTaxPlan,
  clearWizardTaxConfirmation,
  confirmWizardTaxInputs,
  ensureWizardCurrent1040,
  invalidateWizardTaxCompletion,
  overrideWizardIncomeGroup,
  removeWizardTaxItem,
  revertWizardIncomeGroup,
  setWizardTaxField,
  syncWizardTaxpayerFacts,
};

export function readWizardTaxState(plan){
  const wizardPlan = buildWizardTaxPlan(plan);
  const current = wizardPlan.incomeTax.current1040;
  return Object.freeze({
    current,
    deductionMode: deductionModeForWizard(current),
    planningIncome: readWizardPlanningIncome(wizardPlan, current),
  });
}

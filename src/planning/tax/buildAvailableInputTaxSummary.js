import { buildDefaultTaxContext } from '../../tax/annual1040.js';
import { standardDeduction } from '../../tax/federal/rules/standardDeduction.js';
import { buildKnownCurrent1040IncomeSubtotal } from './buildCurrent1040Intake.js';
import { buildCurrentIncomeTaxSummary } from './buildCurrentIncomeTaxSummary.js';

const RESCUABLE_TAXPAYER_GAPS = new Set([
  'PRIMARY_TAXPAYER_RECORD_REQUIRED',
  'MARRIED_TAXPAYER_RECORD_REQUIRED',
  'MODELED_TAXPAYER_RECORD_REQUIRED',
  'MISSING_TAXPAYER_BIRTH_DATE',
]);

function activeOwners(filingStatus){
  return filingStatus === 'marriedFilingJointly'
    ? ['client', 'spouse']
    : ['client'];
}

/**
 * Calculate a partial wizard result when income is known but taxpayer age is
 * not. The engine supplies the base standard deduction; saved facts are never
 * changed and unresolved income lines remain non-calculable.
 */
export function buildAvailableInputTaxSummary(savedPlan, calculationPlan, error){
  if(!RESCUABLE_TAXPAYER_GAPS.has(error?.code)) return null;
  if(buildKnownCurrent1040IncomeSubtotal(savedPlan) === null) return null;

  const current = calculationPlan?.incomeTax?.current1040;
  const filingStatus = calculationPlan?.meta?.filingStatus;
  if(current?.incomeSourcesComplete !== true
      || current.deductions?.method !== 'standard'
      || current.deductions?.source !== 'calculated'
      || filingStatus === 'marriedFilingSeparately'){
    return null;
  }

  try{
    const context = buildDefaultTaxContext({
      taxYear: current.taxYear,
      calculatedAt: new Date().toISOString(),
      runId: `wizard_available_inputs_${current.taxYear}`,
      scenarioId: 'household_wizard',
    });
    const line12e = standardDeduction.calculate(
      { filingStatus },
      context,
    ).result.standardDeduction;
    const previous = current.deductions;
    current.deductions = {
      method: 'standard',
      source: 'supplied-line12e',
      line12e,
      ...(Object.hasOwn(previous, 'qbi') ? { qbi: previous.qbi } : {}),
      ...(Object.hasOwn(previous, 'schedule1A')
        ? { schedule1A: previous.schedule1A }
        : {}),
    };
    current.taxpayers = current.taxpayers ?? {};
    for(const owner of activeOwners(filingStatus)){
      if(!current.taxpayers[owner]) current.taxpayers[owner] = {};
    }

    const summary = buildCurrentIncomeTaxSummary(calculationPlan);
    if(summary.status !== 'ready'
        || typeof summary.federalTaxLiability !== 'number'){
      return null;
    }
    return {
      ...summary,
      status: 'partial',
      calculationScope: 'available-inputs',
    };
  }catch{
    return null;
  }
}

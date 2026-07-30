/* TAX ENGINE — rules ledger (registry only). */

import { ordinaryIncomeTax } from '../federal/rules/ordinaryIncomeTax.js';
import { standardDeduction } from '../federal/rules/standardDeduction.js';
import { traditionalIraDeductibility } from '../federal/rules/traditionalIraDeductibility.js';
import { capitalGainsStacking } from '../federal/rules/capitalGainsStacking.js';
import { scheduleDClassification } from '../federal/rules/scheduleDClassification.js';
import { taxableSocialSecurity } from '../federal/rules/taxableSocialSecurity.js';
import { selfEmploymentTax } from '../federal/rules/selfEmploymentTax.js';
import { qualifiedRothDistribution } from '../federal/rules/qualifiedRothDistribution.js';
import { enhancedSeniorDeduction } from '../federal/rules/enhancedSeniorDeduction.js';
import { medicalExpenseDeduction } from '../federal/rules/medicalExpenseDeduction.js';
import { saltDeductionCap } from '../federal/rules/saltDeductionCap.js';
import { overallItemizedDeductionLimit } from '../federal/rules/overallItemizedDeductionLimit.js';

export const rulesLedger = [
  ordinaryIncomeTax,
  standardDeduction,
  traditionalIraDeductibility,
  capitalGainsStacking,
  scheduleDClassification,
  taxableSocialSecurity,
  selfEmploymentTax,
  qualifiedRothDistribution,
  enhancedSeniorDeduction,
  medicalExpenseDeduction,
  saltDeductionCap,
  overallItemizedDeductionLimit,
];

export function getRuleById(ruleId){
  return rulesLedger.find(r => r.meta.ruleId === ruleId) || null;
}

export function getRulesByTriggerTag(tag){
  return rulesLedger.filter(r => (r.meta.triggerTags || []).includes(tag));
}

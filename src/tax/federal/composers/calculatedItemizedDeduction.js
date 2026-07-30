import { medicalExpenseDeduction } from '../rules/medicalExpenseDeduction.js';
import { saltDeductionCap } from '../rules/saltDeductionCap.js';
import { overallItemizedDeductionLimit } from '../rules/overallItemizedDeductionLimit.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function resolveMagi(magi, adjustedGrossIncome){
  return magi.mode === 'supplied-magi'
    ? magi.amount
    : adjustedGrossIncome;
}

/**
 * Compose already-resolved Schedule A components. Category-specific limits for
 * mortgage interest, charity, and "other" remain supplied-contract boundaries.
 */
export function calculateItemizedDeduction({
  filingStatus,
  itemized,
  adjustedGrossIncome,
  qualifiedBusinessIncomeDeduction,
  schedule1ADeduction,
}, context, audits){
  const medical = medicalExpenseDeduction.calculate({
    medicalExpensesPaid: itemized.medicalExpensesPaid,
    adjustedGrossIncome,
  }, context);
  audits.push(medical.audit);
  const medicalAuditIndex = audits.length - 1;

  const salt = saltDeductionCap.calculate({
    filingStatus,
    eligibleTaxesPaid: itemized.salt.eligibleTaxesPaid,
    modifiedAdjustedGrossIncome: resolveMagi(
      itemized.salt.magi,
      adjustedGrossIncome
    ),
  }, context);
  audits.push(salt.audit);
  const saltAuditIndex = audits.length - 1;

  const components = {
    deductibleMedicalExpenses: medical.result.deductibleMedicalExpenses,
    saltDeduction: salt.result.saltDeduction,
    mortgageInterestDeductible: itemized.mortgageInterestDeductible,
    charitableContributionsDeductible:
      itemized.charitableContributionsDeductible,
    otherItemizedDeductions: itemized.otherItemizedDeductions,
  };
  const itemizedDeductionsBeforeOverallLimit = round2(
    Object.values(components).reduce((sum, value) => sum + value, 0)
  );
  const overall = overallItemizedDeductionLimit.calculate({
    filingStatus,
    itemizedDeductionsBeforeOverallLimit,
    adjustedGrossIncome,
    ...(qualifiedBusinessIncomeDeduction !== undefined
      ? { qualifiedBusinessIncomeDeduction }
      : {}),
    ...(schedule1ADeduction !== undefined ? { schedule1ADeduction } : {}),
  }, context);
  audits.push(overall.audit);
  const overallAuditIndex = audits.length - 1;

  const audit = {
    ruleId: 'COMPOSER_CALCULATED_ITEMIZED_DEDUCTION',
    ruleVersion: '1.0.0',
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: {
      filingStatus,
      adjustedGrossIncome,
      qualifiedBusinessIncomeDeduction:
        qualifiedBusinessIncomeDeduction ?? null,
      schedule1ADeduction: schedule1ADeduction ?? null,
      itemized,
    },
    dataSourcesUsed: [
      ...medical.audit.dataSourcesUsed,
      ...salt.audit.dataSourcesUsed,
      ...overall.audit.dataSourcesUsed,
    ],
    calculationSteps: [
      {
        step: 'category_limited_components',
        components,
        medicalAuditIndex,
        saltAuditIndex,
      },
      {
        step: 'overall_itemized_limit',
        itemizedDeductionsBeforeOverallLimit,
        overallLimitationReduction:
          overall.result.overallLimitationReduction,
        allowedItemizedDeductions:
          overall.result.allowedItemizedDeductions,
        overallAuditIndex,
      },
    ],
    authority: [
      ...medical.audit.authority,
      ...salt.audit.authority,
      ...overall.audit.authority,
    ],
    limitations: [
      'Mortgage-interest, charitable, and other itemized components must already reflect category-specific limits',
    ],
  };
  audits.push(audit);

  return {
    result: {
      ...components,
      itemizedDeductionsBeforeOverallLimit,
      ...overall.result,
    },
    audit,
    auditIndex: audits.length - 1,
  };
}

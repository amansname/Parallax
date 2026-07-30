/* ============================================================================
   COMPOSER: Annual Federal Tax  (composeAnnualFederalTax)
   ============================================================================ */

import {
  calculatedLine,
  deferredLine,
  lineAmount,
  LINE_STATUS,
  passThroughLine,
  resolveTaxTotalScope,
} from '../../core/form1040Lines.js';
import { buildForm1040IncomeSpine, resolvePreferentialComponents } from './form1040Spine.js';
import { capitalGainsStacking } from '../rules/capitalGainsStacking.js';
import { ordinaryIncomeTax } from '../rules/ordinaryIncomeTax.js';
import { TaxInputError } from '../../core/errors.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function resolvePassThroughTaxLine(input, lineId){
  if(input.passThrough?.[lineId] !== undefined){
    return passThroughLine(lineId, input.passThrough[lineId]);
  }
  return deferredLine(lineId);
}

function resolveSchedule2Line23(input, scheduleSETotals){
  const suppliedLine23 = input.passThrough?.line23;
  const hasCalculatedSchedule2Source =
    input.schedule2 !== undefined || scheduleSETotals != null;
  if(suppliedLine23 !== undefined && hasCalculatedSchedule2Source){
    throw new TaxInputError(
      'Supplied Form 1040 line 23 cannot be combined with Schedule 2 components or calculated Schedule SE',
      {
        code: 'SCHEDULE_2_SOURCE_CONFLICT',
        suppliedLine23,
        hasSchedule2Components: input.schedule2 !== undefined,
        hasCalculatedScheduleSE: scheduleSETotals != null,
      }
    );
  }
  if(suppliedLine23 !== undefined){
    return resolvePassThroughTaxLine(input, 'line23');
  }

  const schedule2 = input.schedule2;
  const hasCompleteSuppliedRemainder = schedule2
    && schedule2.netInvestmentIncomeTax !== undefined
    && schedule2.additionalMedicareTax !== undefined
    && schedule2.otherPartIITaxes !== undefined;
  if(!hasCompleteSuppliedRemainder){
    return deferredLine('line23');
  }

  const selfEmploymentTaxTotal =
    scheduleSETotals?.selfEmploymentTaxTotal ?? 0;
  const line23Value = round2(
    selfEmploymentTaxTotal
    + schedule2.netInvestmentIncomeTax
    + schedule2.additionalMedicareTax
    + schedule2.otherPartIITaxes
  );
  const combinedWithScheduleSE = scheduleSETotals != null;
  return calculatedLine('line23', line23Value, {
    ruleId: combinedWithScheduleSE
      ? 'FED_SELF_EMPLOYMENT_TAX+SCHEDULE_2_SUPPLIED_TAXES'
      : 'SCHEDULE_2_SUPPLIED_TAXES',
    auditIndex: combinedWithScheduleSE
      ? scheduleSETotals.auditIndexes[0]
      : null,
  });
}

function buildTaxLines(input, context, form1040, ordinaryTaxableIncome, preferentialIncome, audits, scheduleDClassificationResult, scheduleSETotals){
  if(form1040.line15.status === LINE_STATUS.DEFERRED
      || ordinaryTaxableIncome === null){
    const line17 = resolvePassThroughTaxLine(input, 'line17');
    const line19 = resolvePassThroughTaxLine(input, 'line19');
    const line20 = resolvePassThroughTaxLine(input, 'line20');
    const line21 = (
      line19.status === LINE_STATUS.DEFERRED
      && line20.status === LINE_STATUS.DEFERRED
    )
      ? deferredLine('line21')
      : calculatedLine(
        'line21',
        round2(lineAmount(line19) + lineAmount(line20))
      );
    const line23 = resolveSchedule2Line23(input, scheduleSETotals);
    return {
      ...form1040,
      line16: deferredLine('line16'),
      line17,
      line18: deferredLine('line18'),
      line19,
      line20,
      line21,
      line22: deferredLine('line22'),
      line23,
      line24: deferredLine('line24'),
    };
  }
  const ordinaryInput = {
    filingStatus: input.filingStatus,
    taxableOrdinaryIncome: ordinaryTaxableIncome,
  };
  const ordinary = ordinaryIncomeTax.calculate(ordinaryInput, context);
  audits.push(ordinary.audit);

  let line16Tax = ordinary.result.ordinaryTax;
  let line16RuleId = 'FED_ORDINARY_INCOME_TAX';
  let line16AuditIndex = audits.length - 1;

  if(preferentialIncome > 0){
    const { netLongTermCapitalGains, qualifiedDividends } =
      resolvePreferentialComponents(input, scheduleDClassificationResult);
    const capitalGains = capitalGainsStacking.calculate({
      filingStatus: input.filingStatus,
      ordinaryTaxableIncome,
      netLongTermCapitalGains,
      qualifiedDividends,
    }, context);
    audits.push(capitalGains.audit);
    line16Tax = round2(line16Tax + capitalGains.result.preferentialIncomeTax);
    line16RuleId = 'FED_ORDINARY_INCOME_TAX+FED_CAPITAL_GAINS_STACKING';
  }

  const line16 = calculatedLine('line16', line16Tax, {
    ruleId: line16RuleId,
    auditIndex: line16AuditIndex,
  });

  const line17 = resolvePassThroughTaxLine(input, 'line17');
  const line18 = calculatedLine('line18', round2(lineAmount(line16) + lineAmount(line17)));
  const line19 = resolvePassThroughTaxLine(input, 'line19');
  const line20 = resolvePassThroughTaxLine(input, 'line20');
  const line21 = (line19.status === LINE_STATUS.DEFERRED && line20.status === LINE_STATUS.DEFERRED)
    ? deferredLine('line21')
    : calculatedLine('line21', round2(lineAmount(line19) + lineAmount(line20)));
  const line22 = calculatedLine('line22', Math.max(0, round2(lineAmount(line18) - lineAmount(line21))));
  const line23 = resolveSchedule2Line23(input, scheduleSETotals);
  const line24 = calculatedLine('line24', round2(lineAmount(line22) + lineAmount(line23)));

  return {
    ...form1040,
    line16,
    line17,
    line18,
    line19,
    line20,
    line21,
    line22,
    line23,
    line24,
  };
}

export function composeAnnualFederalTax(input, context){
  const {
    form1040: incomeSpine,
    ordinaryTaxableIncome,
    preferentialIncome,
    audits,
    scheduleDClassification,
    scheduleSETotals,
  } =
    buildForm1040IncomeSpine(input, context);

  const form1040 = buildTaxLines(
    input,
    context,
    incomeSpine,
    ordinaryTaxableIncome,
    preferentialIncome,
    audits,
    scheduleDClassification,
    scheduleSETotals
  );

  const totalFederalTax = form1040.line24.value;
  const taxTotalScope = resolveTaxTotalScope(form1040);
  const unresolvedTaxableIncomeLines = [
    'line3a',
    'line9',
    'line10',
    'line12e',
    'line13a',
    'line13b',
  ].filter(lineId => form1040[lineId]?.status === LINE_STATUS.DEFERRED);

  return {
    result: {
      form1040,
      totalFederalTax,
      taxTotalScope,
      preferentialIncome,
      readiness: {
        unresolvedTaxableIncomeLines,
        capitalLossCarryforward:
          scheduleDClassification?.capitalLossCarryforward ?? {
            status: 'NOT_EVALUATED',
            exactAmount: null,
            minimumAmount: null,
          },
      },
    },
    audits,
  };
}

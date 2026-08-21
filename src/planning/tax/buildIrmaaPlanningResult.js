import { composeIrmaaMagi } from '../../tax/federal/composers/irmaaMagi.js';
import { irmaa } from '../../tax/federal/rules/irmaa.js';

const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

function eligibleCount(value){
  if(value === null || value === undefined) return null;
  if(!Number.isInteger(value) || value < 0){
    throw new TypeError('eligibleMembers must be a nonnegative integer or null');
  }
  return value;
}

function finish({ calculation, taxYear, eligibleMembers, source, magiComponents }){
  const count = eligibleCount(eligibleMembers);
  const annualHouseholdAdjustment = count === null
    ? null
    : round2(calculation.result.annualAdjustmentPerPerson * count);
  return Object.freeze({
    ...calculation.result,
    taxYear,
    source,
    eligibleMembers: count,
    annualHouseholdAdjustment,
    magiComponents,
    audit: Object.freeze({
      ...calculation.audit,
      source,
      eligibleMembers: count,
      annualHouseholdAdjustment,
      magiComponents,
    }),
  });
}

export function buildIrmaaPlanningResult({
  adjustedGrossIncome,
  taxExemptInterest = 0,
  uncommonAddbacks = 0,
  filingStatus,
  taxYear,
  premiumYear = taxYear + 2,
  eligibleMembers = null,
  mfsLivingArrangement,
  context = {},
}){
  if(typeof adjustedGrossIncome !== 'number'
      || !Number.isFinite(adjustedGrossIncome)) return null;
  const composed = composeIrmaaMagi({
    adjustedGrossIncome,
    taxExemptInterest,
    uncommonAddbacks,
  });
  const calculation = irmaa.calculate({
    magi: composed.magi,
    filingStatus,
    premiumYear,
    ...(filingStatus === 'marriedFilingSeparately'
      ? { mfsLivingArrangement }
      : {}),
  }, context);
  return finish({
    calculation,
    taxYear,
    eligibleMembers,
    source: 'modeled',
    magiComponents: composed.components,
  });
}

function buildManualIrmaaPlanningResult({
  magi,
  filingStatus,
  mfsLivingArrangement,
  taxYear,
  premiumYear,
  eligibleMembers,
  context,
}){
  if(typeof magi !== 'number' || !Number.isFinite(magi)) return null;
  const calculation = irmaa.calculate({
    magi,
    filingStatus,
    premiumYear,
    ...(filingStatus === 'marriedFilingSeparately'
      ? { mfsLivingArrangement }
      : {}),
  }, context);
  return finish({
    calculation,
    taxYear,
    eligibleMembers,
    source: 'manual-lookback',
    magiComponents: null,
  });
}

export function resolveIrmaaPremiumYear({
  plan,
  premiumYear,
  modeledByTaxYear = {},
  eligibleMembers = null,
  context = {},
}){
  const planStartYear = Number.isInteger(plan?.meta?.planningAsOfYear)
    ? plan.meta.planningAsOfYear
    : 2026;
  const taxYear = premiumYear - 2;
  if(premiumYear === planStartYear || premiumYear === planStartYear + 1){
    const manual = plan?.incomeTax?.irmaa?.lookbackByTaxYear?.[taxYear];
    if(!manual) return null;
    return buildManualIrmaaPlanningResult({
      ...manual,
      filingStatus: plan?.meta?.filingStatus,
      taxYear,
      premiumYear,
      eligibleMembers,
      context,
    });
  }
  const modeled = modeledByTaxYear?.[taxYear];
  if(!modeled) return null;
  return buildIrmaaPlanningResult({
    ...modeled,
    filingStatus: modeled.filingStatus ?? plan?.meta?.filingStatus,
    taxYear,
    premiumYear,
    eligibleMembers,
    context,
  });
}

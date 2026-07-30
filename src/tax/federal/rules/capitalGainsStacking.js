/* RULE: Federal Long-Term Capital Gains Stacking (FED_CAPITAL_GAINS_STACKING) */

import {
  CAPITAL_GAINS_THRESHOLDS,
  CAPITAL_GAINS_THRESHOLDS_SOURCE,
  FILING_STATUSES,
} from '../../core/constants.js';
import { CAPITAL_GAINS_STACKING_INPUT_SCHEMA, CONTEXT_SCHEMA } from '../../core/schemas.js';
import { validateAgainstSchema, assertNonNegativeNumber, assertOneOf } from '../../core/validators.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';

export const meta = {
  ruleId: 'FED_CAPITAL_GAINS_STACKING',
  ruleVersion: '1.0.1',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'capital_gains_tax',
  authority: [
    'IRC section 1(h)',
    'IRS Revenue Procedure 2024-40',
    'IRS Revenue Procedure 2025-32',
  ],
  dataSourcesRequired: [
    'IRS_2025_CAPITAL_GAINS_RATES_v1.0',
    'IRS_2026_CAPITAL_GAINS_RATES_v1.0',
  ],
  inputsRequired: ['filingStatus', 'ordinaryTaxableIncome', 'netLongTermCapitalGains', 'qualifiedDividends'],
  outputs: ['preferentialIncomeTax', 'marginalPreferentialRate', 'effectivePreferentialRate', 'rateBreakdown'],
  limitations: [
    'Does not calculate NIIT',
    'Does not classify gains or dividends',
    'Expects ordinaryTaxableIncome already resolved',
  ],
  triggerTags: ['capital_gains', 'qualified_dividends', 'bracket_calculation'],
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round6 = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

export function validate(input){
  validateAgainstSchema(input, CAPITAL_GAINS_STACKING_INPUT_SCHEMA, 'capitalGainsStacking input');
  assertOneOf(input.filingStatus, FILING_STATUSES, 'filingStatus', 'capitalGainsStacking input');
  assertNonNegativeNumber(input.ordinaryTaxableIncome, 'ordinaryTaxableIncome', 'capitalGainsStacking input');
  assertNonNegativeNumber(input.netLongTermCapitalGains, 'netLongTermCapitalGains', 'capitalGainsStacking input');
  assertNonNegativeNumber(input.qualifiedDividends, 'qualifiedDividends', 'capitalGainsStacking input');
  return input;
}

function resolveThresholds(context, filingStatus){
  const thresholdsForLaw = CAPITAL_GAINS_THRESHOLDS[context.lawVersion];
  if(!thresholdsForLaw){
    throw new TaxDataError(`No capital gains threshold table for lawVersion: ${context.lawVersion}`, {
      lawVersion: context.lawVersion,
    });
  }
  const thresholds = thresholdsForLaw[filingStatus];
  if(!thresholds){
    throw new TaxDataError(`No capital gains thresholds for filingStatus: ${filingStatus}`, {
      lawVersion: context.lawVersion,
      filingStatus,
    });
  }
  const dataSourceId = CAPITAL_GAINS_THRESHOLDS_SOURCE[context.lawVersion];
  const dataSource = getDataSource(dataSourceId);
  if(context.lawVersion !== dataSource.lawVersion || context.taxYear !== dataSource.taxYear){
    throw new TaxInputError('context does not match capital gains data source', {
      contextLawVersion: context.lawVersion,
      dataSourceLawVersion: dataSource.lawVersion,
    });
  }
  return { thresholds, dataSourceId, dataSource };
}

function addRateBand(bands, calculationSteps, rate, income){
  const roundedIncome = round2(income);
  if(roundedIncome <= 0) return 0;
  const tax = round2(roundedIncome * rate);
  bands.push({ rate, income: roundedIncome, tax });
  calculationSteps.push({ rate, income: roundedIncome, tax });
  return tax;
}

export function calculate(input, context){
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');

  const {
    filingStatus,
    ordinaryTaxableIncome,
    netLongTermCapitalGains,
    qualifiedDividends,
  } = input;
  const {
    thresholds,
    dataSourceId,
    dataSource,
  } = resolveThresholds(context, filingStatus);

  const preferentialIncome = round2(netLongTermCapitalGains + qualifiedDividends);
  const rateBreakdown = [];
  const calculationSteps = [];
  let remaining = preferentialIncome;
  let preferentialIncomeTax = 0;
  let marginalPreferentialRate = 0;

  const zeroRateIncome = Math.min(remaining, Math.max(0, thresholds.zeroRateMax - ordinaryTaxableIncome));
  preferentialIncomeTax += addRateBand(rateBreakdown, calculationSteps, 0, zeroRateIncome);
  remaining = round2(remaining - zeroRateIncome);
  if(zeroRateIncome > 0) marginalPreferentialRate = 0;

  const fifteenRateIncome = Math.min(
    remaining,
    Math.max(0, thresholds.fifteenRateMax - ordinaryTaxableIncome - zeroRateIncome)
  );
  preferentialIncomeTax += addRateBand(rateBreakdown, calculationSteps, 0.15, fifteenRateIncome);
  remaining = round2(remaining - fifteenRateIncome);
  if(fifteenRateIncome > 0) marginalPreferentialRate = 0.15;

  const twentyRateIncome = Math.max(0, remaining);
  preferentialIncomeTax += addRateBand(rateBreakdown, calculationSteps, 0.20, twentyRateIncome);
  if(twentyRateIncome > 0) marginalPreferentialRate = 0.20;

  preferentialIncomeTax = round2(preferentialIncomeTax);
  const effectivePreferentialRate = preferentialIncome > 0 ? round6(preferentialIncomeTax / preferentialIncome) : 0;

  const result = {
    preferentialIncomeTax,
    marginalPreferentialRate,
    effectivePreferentialRate,
    preferentialIncome,
    taxableIncomeAfterPreferential: round2(ordinaryTaxableIncome + preferentialIncome),
    rateBreakdown,
    thresholdsUsed: {
      zeroRateMax: thresholds.zeroRateMax,
      fifteenRateMax: thresholds.fifteenRateMax,
    },
  };

  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: { filingStatus, ordinaryTaxableIncome, netLongTermCapitalGains, qualifiedDividends },
    dataSourcesUsed: [dataSourceId],
    calculationSteps,
    authority: [dataSource.authority],
    limitations: meta.limitations,
  };

  return { result, audit };
}

export const capitalGainsStacking = { meta, validate, calculate };

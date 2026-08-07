/* RULE: Taxable Social Security Benefits (FED_TAXABLE_SOCIAL_SECURITY) */

import {
  FILING_STATUSES,
  SOCIAL_SECURITY_TAXATION_RATES,
  SOCIAL_SECURITY_TAXATION_SOURCE,
  SOCIAL_SECURITY_TAXATION_THRESHOLDS,
} from '../../core/constants.js';
import { CONTEXT_SCHEMA, TAXABLE_SOCIAL_SECURITY_INPUT_SCHEMA } from '../../core/schemas.js';
import { validateAgainstSchema, assertNonNegativeNumber, assertOneOf } from '../../core/validators.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';

export const meta = {
  ruleId: 'FED_TAXABLE_SOCIAL_SECURITY',
  ruleVersion: '1.2.1',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'social_security_taxation',
  authority: ['IRC section 86', 'IRS Publication 915', 'IRS Publication 505 (2026)'],
  dataSourcesRequired: [
    'IRS_2025_PUBLICATION_915_SOCIAL_SECURITY_v1.0',
    'IRS_2026_PUBLICATION_505_SOCIAL_SECURITY_v1.0',
  ],
  inputsRequired: [
    'filingStatus', 'socialSecurityBenefits', 'otherIncome', 'taxExemptInterest',
    'excludedIncomeAddBacks', 'adjustments', 'livedWithSpouse',
  ],
  outputs: ['taxableBenefits', 'nontaxableBenefits', 'taxablePct', 'worksheetIncome', 'ratesUsed'],
  limitations: [
    'Does not calculate ordinary income tax',
    'Does not solve circular interactions with Traditional IRA deductions',
    'adjustments must contain only the Publication 915/505 worksheet-eligible Schedule 1 subtotal; the composer adds any engine-calculated half-SE-tax deduction exactly once',
    'For MFS, livedWithSpouse means lived with the spouse at any time during the tax year; false means lived apart for the entire year',
  ],
  triggerTags: ['social_security_taxation', 'provisional_income', 'agi_threshold'],
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round6 = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

export function validate(input){
  validateAgainstSchema(input, TAXABLE_SOCIAL_SECURITY_INPUT_SCHEMA, 'taxableSocialSecurity input');
  assertOneOf(input.filingStatus, FILING_STATUSES, 'filingStatus', 'taxableSocialSecurity input');
  assertNonNegativeNumber(input.socialSecurityBenefits, 'socialSecurityBenefits', 'taxableSocialSecurity input');
  // Pub. 915's worksheet aggregate can be negative because it includes signed
  // Schedule D, business, rental, and other income/loss items. The shared
  // schema still requires a finite number.
  assertNonNegativeNumber(input.taxExemptInterest, 'taxExemptInterest', 'taxableSocialSecurity input');
  assertNonNegativeNumber(input.excludedIncomeAddBacks, 'excludedIncomeAddBacks', 'taxableSocialSecurity input');
  assertNonNegativeNumber(input.adjustments, 'adjustments', 'taxableSocialSecurity input');
  return input;
}

function resolveThresholds(context, input){
  const thresholdsForLaw = SOCIAL_SECURITY_TAXATION_THRESHOLDS[context.lawVersion];
  if(!thresholdsForLaw){
    throw new TaxDataError(`No Social Security taxation threshold table for lawVersion: ${context.lawVersion}`, {
      lawVersion: context.lawVersion,
    });
  }
  let key = input.filingStatus;
  if(input.filingStatus === 'marriedFilingSeparately'){
    key = input.livedWithSpouse ? 'marriedFilingSeparatelyLivedTogether' : 'marriedFilingSeparatelyLivedApart';
  }
  const thresholds = thresholdsForLaw[key];
  const dataSourceId = SOCIAL_SECURITY_TAXATION_SOURCE[context.lawVersion];
  const dataSource = getDataSource(dataSourceId);
  if(context.lawVersion !== dataSource.lawVersion || context.taxYear !== dataSource.taxYear){
    throw new TaxInputError('context does not match Social Security data source', {
      contextLawVersion: context.lawVersion,
    });
  }
  return { thresholds, dataSourceId, thresholdKey: key };
}

export function calculate(input, context){
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');

  const { thresholds, dataSourceId, thresholdKey } = resolveThresholds(context, input);
  const halfBenefits = round2(
    input.socialSecurityBenefits * SOCIAL_SECURITY_TAXATION_RATES.lowerTier
  );
  const combinedIncomeBeforeAdjustments = round2(
    halfBenefits + input.otherIncome + input.taxExemptInterest + input.excludedIncomeAddBacks
  );

  let worksheetIncome = round2(combinedIncomeBeforeAdjustments - input.adjustments);
  if(worksheetIncome <= 0) worksheetIncome = 0;

  const maxTaxableBenefits = round2(
    input.socialSecurityBenefits * SOCIAL_SECURITY_TAXATION_RATES.upperTier
  );
  let taxableBeforeCap = 0;
  const calculationSteps = [
    { line: 'halfBenefits', amount: halfBenefits },
    { line: 'combinedIncomeBeforeAdjustments', amount: combinedIncomeBeforeAdjustments },
    { line: 'worksheetIncome', amount: worksheetIncome },
  ];

  if(input.filingStatus === 'marriedFilingSeparately' && input.livedWithSpouse){
    taxableBeforeCap = round2(
      worksheetIncome * SOCIAL_SECURITY_TAXATION_RATES.upperTier
    );
  } else if(worksheetIncome > thresholds.baseAmount){
    const excessOverBase = round2(worksheetIncome - thresholds.baseAmount);
    const excessOverAdditionalAmount = round2(Math.max(0, excessOverBase - thresholds.additionalAmount));
    const amountInFiftyPctBand = round2(Math.min(excessOverBase, thresholds.additionalAmount));
    const limitedFiftyPctAmount = round2(Math.min(
      halfBenefits,
      round2(amountInFiftyPctBand * SOCIAL_SECURITY_TAXATION_RATES.lowerTier)
    ));
    const eightyFivePctAmount = round2(
      excessOverAdditionalAmount * SOCIAL_SECURITY_TAXATION_RATES.upperTier
    );
    taxableBeforeCap = round2(limitedFiftyPctAmount + eightyFivePctAmount);
    calculationSteps.push(
      { line: 'excessOverBase', amount: excessOverBase },
      { line: 'limitedFiftyPctAmount', amount: limitedFiftyPctAmount },
      { line: 'eightyFivePctAmount', amount: eightyFivePctAmount }
    );
  }

  const taxableBenefits = round2(Math.min(taxableBeforeCap, maxTaxableBenefits));
  const nontaxableBenefits = round2(input.socialSecurityBenefits - taxableBenefits);
  const taxablePct = input.socialSecurityBenefits > 0 ? round6(taxableBenefits / input.socialSecurityBenefits) : 0;

  const result = {
    taxableBenefits,
    nontaxableBenefits,
    taxablePct,
    halfBenefits,
    combinedIncomeBeforeAdjustments,
    worksheetIncome,
    baseAmount: thresholds.baseAmount,
    additionalAmount: thresholds.additionalAmount,
    thresholdKey,
    ratesUsed: SOCIAL_SECURITY_TAXATION_RATES,
  };

  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: { ...input },
    dataSourcesUsed: [dataSourceId],
    calculationSteps,
    authority: meta.authority,
    limitations: meta.limitations,
  };

  return { result, audit };
}

export const taxableSocialSecurity = { meta, validate, calculate };

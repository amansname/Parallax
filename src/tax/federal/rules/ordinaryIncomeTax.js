/* ============================================================================
   RULE: Federal Ordinary Income Tax  (FED_ORDINARY_INCOME_TAX)
   The foundational primitive. Given a filing status and an ALREADY-RESOLVED
   taxable ordinary income, it computes the progressive bracket tax, the
   marginal and effective rates, and a per-bracket breakdown — plus a complete,
   JSON-serializable audit trail.

   BRUTALLY NARROW (see docs/TaxEngineArchitecture.md → Phase 1 Build Scope):
   it does NOT compute gross income, AGI, MAGI, the standard/itemized deduction,
   Social Security taxation, NIIT, IRMAA, credits, or state tax. The caller hands
   it taxableOrdinaryIncome already resolved.

   Zero dependency on engine.js. Contract: calculate(input, context) -> { result, audit }.

   Marginal-rate convention: the rate applied to the LAST taxed dollar of income
   (the highest-rate bracket that actually received income). At $0 income there
   is no taxed dollar, so marginalRate is the first bracket's rate (the rate the
   first dollar would face).
   ============================================================================ */

import { ORDINARY_BRACKETS, ORDINARY_BRACKETS_SOURCE, FILING_STATUSES } from '../../core/constants.js';
import { CONTEXT_SCHEMA, ORDINARY_INCOME_INPUT_SCHEMA } from '../../core/schemas.js';
import { validateAgainstSchema, assertNonNegativeNumber, assertOneOf } from '../../core/validators.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';

export const meta = {
  ruleId: 'FED_ORDINARY_INCOME_TAX',
  ruleVersion: '1.0.1',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'ordinary_income_tax',
  authority: [
    'IRC §1',
    'IRS Revenue Procedure 2024-40',
    'IRS Revenue Procedure 2025-32',
  ],
  dataSourcesRequired: [
    'IRS_2025_TAX_TABLES_v1.0',
    'IRS_2026_TAX_TABLES_v1.0',
  ],
  inputsRequired: ['filingStatus', 'taxableOrdinaryIncome'],
  outputs: ['ordinaryTax', 'marginalRate', 'effectiveRate', 'bracketBreakdown'],
  limitations: [
    'Does not calculate AMT',
    'Does not calculate credits',
    'Does not calculate NIIT',
    'Expects taxableOrdinaryIncome already resolved (no AGI/MAGI/deduction math)',
  ],
  triggerTags: ['agi_threshold', 'bracket_calculation', 'roth_conversion', 'charitable_planning'],
};

// Money to cents, rate to 6dp — deterministic, kills float dust without changing
// the reproducibility guarantee.
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round6 = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

// Layer-2 validation: schema shape first, then rule-specific semantics. Throws.
export function validate(input){
  validateAgainstSchema(input, ORDINARY_INCOME_INPUT_SCHEMA, 'ordinaryIncomeTax input');
  assertOneOf(input.filingStatus, FILING_STATUSES, 'filingStatus', 'ordinaryIncomeTax input');
  assertNonNegativeNumber(input.taxableOrdinaryIncome, 'taxableOrdinaryIncome', 'ordinaryIncomeTax input');
  return input;
}

export function calculate(input, context){
  // Validate the request: rule input (Layer 2) + execution context (Layer 1).
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');

  const { filingStatus, taxableOrdinaryIncome } = input;
  const { lawVersion } = context;

  // Resolve the bracket table for this law regime + filing status. A missing
  // table is a data error (never a silent default).
  const tableForLaw = ORDINARY_BRACKETS[lawVersion];
  if(!tableForLaw){
    throw new TaxDataError(`No ordinary bracket table for lawVersion: ${lawVersion}`, { lawVersion });
  }
  const brackets = tableForLaw[filingStatus];
  if(!brackets){
    throw new TaxDataError(`No ordinary brackets for filingStatus: ${filingStatus}`, { lawVersion, filingStatus });
  }

  // Resolve the data source THROUGH the registry so a wrong/missing mapping
  // can never silently produce an undefined id in the audit.
  const dataSourceId = ORDINARY_BRACKETS_SOURCE[lawVersion];
  if(!dataSourceId){
    throw new TaxDataError(`No data source mapped for lawVersion: ${lawVersion}`, { lawVersion });
  }
  const dataSource = getDataSource(dataSourceId);   // throws TaxDataError on unknown id

  // Reject a context that contradicts the resolved law data. e.g. asking for
  // taxYear 2027 while pointing at 2026_FINAL is a silent contradiction — the
  // caller must mean one consistent (taxYear, lawVersion) pair.
  if(context.lawVersion !== dataSource.lawVersion){
    throw new TaxInputError('context.lawVersion does not match the resolved data source', {
      contextLawVersion: context.lawVersion, dataSourceLawVersion: dataSource.lawVersion,
    });
  }
  if(context.taxYear !== dataSource.taxYear){
    throw new TaxInputError('context.taxYear does not match the resolved data source tax year', {
      contextTaxYear: context.taxYear, dataSourceTaxYear: dataSource.taxYear,
    });
  }

  // Progressive stacking: tax the slice of income that falls in each bracket
  // band at that band's rate. `bracketBreakdown` lists only bands that received
  // income; `calculationSteps` mirrors it for the audit.
  const bracketBreakdown = [];
  const calculationSteps = [];
  let remaining = taxableOrdinaryIncome;
  let lowerBound = 0;
  let ordinaryTax = 0;
  let marginalRate = brackets[0].rate;   // rate the first dollar would face (covers $0 income)

  for(let i = 0; i < brackets.length; i++){
    const { rate, upTo } = brackets[i];
    if(remaining <= 0) break;
    const bandWidth = upTo - lowerBound;             // Infinity for the top band
    const taxedInBand = Math.min(remaining, bandWidth);
    const taxForBand = round2(taxedInBand * rate);
    ordinaryTax += taxForBand;
    marginalRate = rate;                              // last band that received income
    const step = { bracket: i + 1, rate, income: round2(taxedInBand), tax: taxForBand };
    bracketBreakdown.push({ rate, income: round2(taxedInBand), tax: taxForBand });
    calculationSteps.push(step);
    remaining -= taxedInBand;
    lowerBound = upTo;
  }

  ordinaryTax = round2(ordinaryTax);
  const effectiveRate = taxableOrdinaryIncome > 0 ? round6(ordinaryTax / taxableOrdinaryIncome) : 0;

  const result = { ordinaryTax, marginalRate, effectiveRate, bracketBreakdown };

  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: { filingStatus, taxableOrdinaryIncome },
    dataSourcesUsed: [dataSourceId],
    calculationSteps,
    authority: [dataSource.authority],
    limitations: meta.limitations,
  };

  return { result, audit };
}

export const ordinaryIncomeTax = { meta, validate, calculate };

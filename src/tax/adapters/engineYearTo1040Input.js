/* ============================================================================
   ADAPTER (SEAM ONLY): engine year facts → client1040 intake

   One planning/simulation year in, stable client1040Input out. Does NOT import
   engine.js and does NOT wire live simulation behavior — shape translation only.

   Doctrine (docs/TaxEngineEngineJsBoundary.md):
   - Reshape cash-flow facts; do not run tax law (SS worksheet, bracket math, etc.)
   - No silent defaults on required identity fields
   - Optional portfolio splits (e.g. taxable gain fraction) come from planMeta,
     not from tax rules

   Stable pipeline:
     engineYearFacts → engineYearTo1040Input() → runClient1040Intake() → annual1040Result
   ============================================================================ */

import { TaxInputError } from '../core/errors.js';

const INCOME_KEYS = [
  'wages',
  'taxableInterest',
  'taxExemptInterest',
  'ordinaryDividends',
  'qualifiedDividends',
  'socialSecurityBenefits',
  'pensionAmount',
  'otherIncome',
  'iraDistributions',
  'rothConversion',
  'capitalGain',
];

function assertPlainObject(value, label){
  if(value === null || typeof value !== 'object' || Array.isArray(value)){
    throw new TaxInputError(`${label} must be a plain object`, { received: typeof value });
  }
}

function hasPositiveIncome(income){
  if(!income) return false;
  return INCOME_KEYS.some((key) => typeof income[key] === 'number' && income[key] > 0);
}

function hasDetailedIncome(facts){
  return hasPositiveIncome(facts.income)
    || (facts.adjustments && Object.keys(facts.adjustments).length > 0);
}

function hasExplicitIncomeObject(facts){
  return facts.income !== undefined;
}

function copyDefinedIncome(target, source){
  for(const key of INCOME_KEYS){
    if(source[key] !== undefined) target[key] = source[key];
  }
}

function applyResolvedIncome(income, resolved){
  if(resolved.taxableIra !== undefined) income.taxableIra = resolved.taxableIra;
  if(resolved.taxablePensions !== undefined) income.taxablePensions = resolved.taxablePensions;
  if(resolved.taxableSocialSecurity !== undefined){
    income.taxableSocialSecurity = resolved.taxableSocialSecurity;
  }
  if(resolved.taxableSS !== undefined) income.taxableSS = resolved.taxableSS;
}

function hasResolvedTaxableSocialSecurity(income){
  return income.taxableSocialSecurity !== undefined || income.taxableSS !== undefined;
}

function sumSocialSecurityWorksheetOtherIncome(income, includeCapitalGain = true){
  // Qualified dividends are already included in ordinary dividends and must not
  // be counted a second time in the Social Security worksheet.
  const directIncome = [
    income.wages,
    income.taxableInterest,
    income.ordinaryDividends,
    income.otherIncome,
    includeCapitalGain ? income.capitalGain : undefined,
  ].reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  const taxableIra = income.taxableIra ?? income.iraDistributions ?? 0;
  const taxablePensions = income.taxablePensions ?? income.pensionAmount ?? 0;
  return directIncome + taxableIra + taxablePensions;
}

function buildSocialSecurityWorksheetInput(engineYearFacts, income){
  if(engineYearFacts.socialSecurityWorksheet !== undefined){
    assertPlainObject(engineYearFacts.socialSecurityWorksheet, 'socialSecurityWorksheet');
  }
  const supplemental = engineYearFacts.socialSecurityWorksheet ?? {};
  const isMfs = engineYearFacts.filingStatus === 'marriedFilingSeparately';
  if(isMfs && typeof supplemental.livedWithSpouse !== 'boolean'){
    throw new TaxInputError(
      'socialSecurityWorksheet.livedWithSpouse is required for married filing separately',
      { field: 'socialSecurityWorksheet.livedWithSpouse' }
    );
  }
  const suppliedLine10 = engineYearFacts.adjustments?.total
    ?? engineYearFacts.adjustments?.line10;
  if(supplemental.adjustments === undefined
      && suppliedLine10 !== undefined){
    throw new TaxInputError(
      'socialSecurityWorksheet.adjustments must supply the Publication 915/505 worksheet-eligible subtotal; Form 1040 line 10 cannot be reused because it may contain excluded adjustments',
      {
        field: 'socialSecurityWorksheet.adjustments',
        suppliedLine10,
      }
    );
  }

  const resolvesScheduleDLine7 = engineYearFacts.scheduleD !== undefined;
  return {
    socialSecurityBenefits: income.socialSecurityBenefits,
    otherIncome: sumSocialSecurityWorksheetOtherIncome(
      income,
      !resolvesScheduleDLine7
    ),
    taxExemptInterest:
      supplemental.taxExemptInterest ?? income.taxExemptInterest ?? 0,
    excludedIncomeAddBacks: supplemental.excludedIncomeAddBacks ?? 0,
    adjustments: supplemental.adjustments ?? 0,
    livedWithSpouse: supplemental.livedWithSpouse ?? false,
    ...(resolvesScheduleDLine7
      ? { addResolvedScheduleDLine7ToOtherIncome: true }
      : {}),
  };
}

/**
 * Map a stable engine-year fact bundle to client1040 intake JSON.
 *
 * Required: filingStatus
 * Provide either taxableOrdinaryIncome (Phase-1 shortcut) or income/adjustments detail.
 */
export function engineYearTo1040Input(engineYearFacts){
  assertPlainObject(engineYearFacts, 'engineYearFacts');

  const { filingStatus, taxYear, id, label, taxableOrdinaryIncome } = engineYearFacts;
  if(filingStatus === undefined || filingStatus === null){
    throw new TaxInputError('engineYearFacts is missing filingStatus', { field: 'filingStatus' });
  }

  const intake = { filingStatus };
  if(taxYear !== undefined) intake.taxYear = taxYear;
  if(id !== undefined) intake.id = id;
  if(label !== undefined) intake.label = label;
  if(engineYearFacts.returnScope !== undefined){
    assertPlainObject(engineYearFacts.returnScope, 'engineYearFacts.returnScope');
    intake.returnScope = { ...engineYearFacts.returnScope };
  }
  if(engineYearFacts.taxpayers !== undefined){
    assertPlainObject(engineYearFacts.taxpayers, 'engineYearFacts.taxpayers');
    intake.taxpayers = Object.fromEntries(
      Object.entries(engineYearFacts.taxpayers)
        .map(([owner, taxpayer]) => {
          assertPlainObject(taxpayer, `engineYearFacts.taxpayers.${owner}`);
          return [owner, { ...taxpayer }];
        })
    );
  }

  if(taxableOrdinaryIncome !== undefined && !hasDetailedIncome(engineYearFacts)){
    intake.taxableOrdinaryIncome = taxableOrdinaryIncome;
    return intake;
  }

  if(!hasDetailedIncome(engineYearFacts) && !hasExplicitIncomeObject(engineYearFacts)){
    throw new TaxInputError(
      'engineYearFacts must include taxableOrdinaryIncome or at least one income/adjustment field',
      { fields: ['taxableOrdinaryIncome', 'income', 'adjustments'] }
    );
  }

  if(hasExplicitIncomeObject(engineYearFacts)){
    assertPlainObject(engineYearFacts.income, 'engineYearFacts.income');
    intake.income = {};
    copyDefinedIncome(intake.income, engineYearFacts.income);
  }

  if(engineYearFacts.resolved){
    intake.income = intake.income || {};
    applyResolvedIncome(intake.income, engineYearFacts.resolved);
  }

  if(engineYearFacts.scheduleD && intake.income?.capitalGain !== undefined){
    throw new TaxInputError(
      'engineYearFacts cannot supply both income.capitalGain and scheduleD',
      { fields: ['income.capitalGain', 'scheduleD'] }
    );
  }

  if(intake.income?.socialSecurityBenefits > 0
      && !hasResolvedTaxableSocialSecurity(intake.income)){
    intake.socialSecurity = buildSocialSecurityWorksheetInput(engineYearFacts, intake.income);
  }

  if(engineYearFacts.adjustments){
    intake.adjustments = { ...engineYearFacts.adjustments };
  }

  if(engineYearFacts.deductions){
    intake.deductions = { ...engineYearFacts.deductions };
  }

  if(engineYearFacts.passThrough){
    intake.passThrough = { ...engineYearFacts.passThrough };
  }

  if(engineYearFacts.scheduleD){
    intake.scheduleD = { ...engineYearFacts.scheduleD };
  }

  if(engineYearFacts.reconciliation){
    intake.reconciliation = { ...engineYearFacts.reconciliation };
  }

  return intake;
}

/**
 * Translate a simulation row-shaped object (plain data) plus plan metadata into
 * engineYearFacts. Knows row field names as data keys only — never imports engine.js.
 *
 * planMeta required: filingStatus
 * planMeta optional: taxYear, wages, deductions, taxableGainFraction (0–1),
 *   treatWithdrawalsAsFullyTaxable (default true for traditional/pension gross)
 */
export function mapSimulationRowToYearFacts(row, planMeta){
  assertPlainObject(row, 'row');
  assertPlainObject(planMeta, 'planMeta');

  if(planMeta.filingStatus === undefined || planMeta.filingStatus === null){
    throw new TaxInputError('planMeta is missing filingStatus', { field: 'filingStatus' });
  }

  const rowTaxFacts = row.incomeTaxFacts && typeof row.incomeTaxFacts === 'object'
    && !Array.isArray(row.incomeTaxFacts)
    ? row.incomeTaxFacts
    : null;
  const income = {};
  if(rowTaxFacts){
    for(const key of INCOME_KEYS){
      if(rowTaxFacts[key] !== undefined) income[key] = rowTaxFacts[key];
    }
  }
  if(planMeta.current1040Income){
    assertPlainObject(planMeta.current1040Income, 'planMeta.current1040Income');
    copyDefinedIncome(income, planMeta.current1040Income);
  }
  if(planMeta.wages !== undefined && income.wages === undefined){
    income.wages = planMeta.wages;
  }
  if(!rowTaxFacts){
    if(row.socialSecurity > 0) income.socialSecurityBenefits = row.socialSecurity;
    if(row.pension > 0) income.pensionAmount = row.pension;
    if(row.otherIncome > 0){
      income.otherIncome = row.otherIncomeTaxable ?? row.otherIncome;
    }
  }

  let netLongTermGainOrLoss = planMeta.currentNetLongTermGainOrLoss
    ?? rowTaxFacts?.capitalGain;
  if(netLongTermGainOrLoss !== undefined){
    delete income.capitalGain;
  }

  const traditionalWithdrawal = row.accountBreakdown?.traditional ?? 0;
  const rmd = row.rmd ?? 0;
  const iraGross = traditionalWithdrawal + rmd;
  if(iraGross > 0){
    income.iraDistributions = (income.iraDistributions ?? 0) + iraGross;
  }

  const taxableWithdrawal = row.accountBreakdown?.taxable ?? 0;
  if(taxableWithdrawal > 0){
    let withdrawalCapitalGain;
    if(row.taxableCapitalGain !== undefined){
      withdrawalCapitalGain = row.taxableCapitalGain;
    } else if(planMeta.capitalGain !== undefined){
      withdrawalCapitalGain = planMeta.capitalGain;
    } else if(planMeta.taxableGainFraction !== undefined){
      withdrawalCapitalGain = taxableWithdrawal * planMeta.taxableGainFraction;
    } else {
      throw new TaxInputError(
        'planMeta.capitalGain or planMeta.taxableGainFraction required when row has taxable withdrawals',
        { taxableWithdrawal }
      );
    }
    netLongTermGainOrLoss = (netLongTermGainOrLoss ?? 0) + withdrawalCapitalGain;
  }

  const resolved = {};
  if(rowTaxFacts?.taxableIra !== undefined){
    resolved.taxableIra = rowTaxFacts.taxableIra;
  }
  if(rowTaxFacts?.taxablePensions !== undefined){
    resolved.taxablePensions = rowTaxFacts.taxablePensions;
  }
  if(planMeta.current1040Income?.taxableIra !== undefined){
    resolved.taxableIra = planMeta.current1040Income.taxableIra;
  }
  if(planMeta.current1040Income?.taxablePensions !== undefined){
    resolved.taxablePensions = planMeta.current1040Income.taxablePensions;
  }
  if(planMeta.current1040Income?.taxableSS !== undefined){
    resolved.taxableSS = planMeta.current1040Income.taxableSS;
  }
  const fullyTaxable = planMeta.treatWithdrawalsAsFullyTaxable !== false;
  if(fullyTaxable){
    if(iraGross > 0) resolved.taxableIra = (resolved.taxableIra ?? 0) + iraGross;
    if(!rowTaxFacts && row.pension > 0) resolved.taxablePensions = row.pension;
  }
  if(planMeta.resolved){
    Object.assign(resolved, planMeta.resolved);
  }

  const facts = {
    filingStatus: row.filingStatus ?? planMeta.filingStatus,
    taxYear: planMeta.taxYear,
    id: planMeta.id,
    label: planMeta.label,
    income,
    deductions: planMeta.deductions ?? { useStandard: true },
  };
  if(planMeta.adjustments) facts.adjustments = { ...planMeta.adjustments };
  if(planMeta.taxpayers) facts.taxpayers = structuredClone(planMeta.taxpayers);
  if(planMeta.returnScope) facts.returnScope = { ...planMeta.returnScope };
  if(planMeta.passThrough) facts.passThrough = { ...planMeta.passThrough };

  if(planMeta.scheduleD !== undefined){
    assertPlainObject(planMeta.scheduleD, 'planMeta.scheduleD');
    if(netLongTermGainOrLoss !== undefined){
      throw new TaxInputError(
        'raw long-term capital gain facts cannot be combined with planMeta.scheduleD',
        { fields: ['incomeTaxFacts.capitalGain', 'planMeta.scheduleD'] }
      );
    }
    facts.scheduleD = { ...planMeta.scheduleD };
  } else if(netLongTermGainOrLoss !== undefined){
    facts.scheduleD = {
      mode: 'manual-net-long-term',
      netLongTermGainOrLoss,
    };
  }

  if(Object.keys(resolved).length > 0) facts.resolved = resolved;
  if(planMeta.socialSecurityWorksheet){
    facts.socialSecurityWorksheet = { ...planMeta.socialSecurityWorksheet };
  }
  return facts;
}

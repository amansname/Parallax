import { qualifiedRothDistribution } from '../../tax/federal/rules/qualifiedRothDistribution.js';

const TOLERANCE = 0.01;
const MODEL_LIMITATION_CODES = Object.freeze([
  'NIIT_NOT_MODELED',
  'AMT_NOT_MODELED',
  'FULL_CREDIT_RULES_NOT_MODELED',
]);

function cloneFreeze(value){
  if(Array.isArray(value)) return Object.freeze(value.map(cloneFreeze));
  if(value && typeof value === 'object'){
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFreeze(item)])
    ));
  }
  return value;
}

function unique(values){
  return [...new Set(values.filter(Boolean))];
}

function ownerAgeForRow(owner, row, context){
  if(owner === 'client') return row.age;
  if(owner === 'spouse' && context.householdAges.spouse !== null){
    return context.householdAges.spouse + (row.age - context.householdAges.primary);
  }
  return null;
}

function ageAtStartOfYear(birthDate, calendarYear){
  if(typeof birthDate !== 'string') return null;
  const [year, month, day] = birthDate.split('-').map(Number);
  if(!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return calendarYear - year - (month === 1 && day === 1 ? 0 : 1);
}

function applicableRmdAge(birthDate){
  if(typeof birthDate !== 'string') return null;
  const year = Number(birthDate.slice(0, 4));
  if(!Number.isInteger(year)) return null;
  if(year >= 1960) return 75;
  if(year >= 1951) return 73;
  if(year >= 1950) return 72;
  if(year === 1949 && birthDate >= '1949-07-01') return 72;
  return 70.5;
}

function projectedAccumulationSkipsRmd(context, startAge){
  return Math.max(context.householdAges.primary, startAge)
    < context.householdAges.resolvedRetirement;
}

export function resolveRothReadiness(row, context, calendarYear){
  const reasons = [...context.readiness.roth.reasons];
  const evidence = [];
  if(context.readiness.roth.accounts.length === 0){
    reasons.push('ROTH_SOURCE_ACCOUNTS_UNATTRIBUTED');
  }
  for(const account of context.readiness.roth.accounts){
    const ownerAge = ownerAgeForRow(account.owner, row, context);
    const ownerBirthDate = context.ownerProfiles?.[account.owner]?.birthDate ?? null;
    const distributionDate = `${calendarYear}-01-01`;
    if(ownerAge === null || account.firstContributionYear === null || ownerBirthDate === null){
      if(ownerBirthDate === null) reasons.push('ROTH_BIRTH_DATE_NOT_CONFIRMED');
      evidence.push(Object.freeze({
        accountId: account.id,
        owner: account.owner,
        taxCharacter: account.taxCharacter,
        ownerAge,
        ownerBirthDate,
        birthDateSource: ownerBirthDate === null ? null : 'confirmed-household-tax-profile',
        modeledDistributionDate: distributionDate,
        distributionDateAssumption: 'start-of-year-conservative',
        firstContributionYear: account.firstContributionYear,
        engineAgeReconciled: null,
        qualified: null,
        ageTestMet: null,
        fiveYearTestMet: null,
        ageQualificationDate: null,
        status: 'unresolved',
      }));
      continue;
    }
    const qualification = qualifiedRothDistribution.calculate({
      distributionDate,
      ownerBirthDate,
      firstContributionYear: account.firstContributionYear,
    }).result;
    const ageAtYearStart = ageAtStartOfYear(ownerBirthDate, calendarYear);
    const engineAgeReconciled = ageAtYearStart !== null && (
      Math.abs(ownerAge - ageAtYearStart) <= TOLERANCE
      || Math.abs(ownerAge - (ageAtYearStart + 1)) <= TOLERANCE
    );
    if(!engineAgeReconciled){
      reasons.push('ROTH_OWNER_AGE_BIRTH_DATE_MISMATCH');
    }
    const qualified = qualification.qualified && engineAgeReconciled;
    evidence.push(Object.freeze({
      accountId: account.id,
      owner: account.owner,
      taxCharacter: account.taxCharacter,
      ownerAge,
      ownerBirthDate,
      birthDateSource: 'confirmed-household-tax-profile',
      modeledDistributionDate: distributionDate,
      distributionDateAssumption: 'start-of-year-conservative',
      firstContributionYear: account.firstContributionYear,
      engineAgeReconciled,
      qualified,
      ageTestMet: qualification.ageTestMet,
      fiveYearTestMet: qualification.fiveYearTestMet,
      ageQualificationDate: qualification.ageQualificationDate,
      status: qualified
        ? 'qualified'
        : engineAgeReconciled
          ? 'not-qualified'
          : 'age-source-mismatch',
    }));
    if(!qualified){
      reasons.push('ROTH_DISTRIBUTION_NOT_PROVEN_QUALIFIED');
    }
  }
  return Object.freeze({
    reasons: Object.freeze(unique(reasons)),
    evidence: Object.freeze(evidence),
    rule: Object.freeze({
      ruleId: qualifiedRothDistribution.meta.ruleId,
      ruleVersion: qualifiedRothDistribution.meta.ruleVersion,
      limitations: qualifiedRothDistribution.meta.limitations,
    }),
  });
}

export function resolveTraditionalReasons(row, context){
  const reasons = [...context.readiness.traditional.reasons];
  const accounts = context.readiness.traditional.accounts;
  if(accounts.length === 0){
    reasons.push('TRADITIONAL_SOURCE_ACCOUNTS_UNATTRIBUTED');
  }
  for(const account of accounts){
    const ownerAge = ownerAgeForRow(account.owner, row, context);
    if(ownerAge === null){
      reasons.push('TRADITIONAL_OWNER_AGE_UNAVAILABLE');
    }else if(ownerAge < 59.5){
      reasons.push('EARLY_TRADITIONAL_DISTRIBUTION_ADDITIONAL_TAX_UNSUPPORTED');
    }
  }
  return unique(reasons);
}

export function resolveRmdReasons(row, context, mandatoryRmd){
  if(mandatoryRmd <= TOLERANCE) return [];
  const reasons = [];
  const accounts = context.readiness.traditional.accounts;
  const owners = new Set(accounts.map(account => account.owner));
  if(owners.size !== 1 || !owners.has('client')){
    reasons.push('RMD_MULTI_OWNER_ALLOCATION_UNSUPPORTED');
  }
  if(accounts.some(account => account.taxCharacter !== 'traditional_ira')){
    reasons.push('RMD_EMPLOYER_PLAN_RULES_UNSUPPORTED');
  }

  const birthDate = context.ownerProfiles?.client?.birthDate;
  const startAge = applicableRmdAge(birthDate);
  if(startAge === null){
    reasons.push('RMD_BIRTH_DATE_NOT_CONFIRMED');
  }else{
    if(startAge !== 73) reasons.push('RMD_START_AGE_MODEL_MISMATCH');
    if(Math.abs(row.age - startAge) < TOLERANCE){
      reasons.push('RMD_FIRST_YEAR_TIMING_ELECTION_NOT_MODELED');
    }
    if(projectedAccumulationSkipsRmd(context, startAge)){
      reasons.push('RMD_BEFORE_RETIREMENT_NOT_MODELED');
    }
  }

  const spouseAge = context.householdAges.spouse === null
    ? null
    : ownerAgeForRow('spouse', row, context);
  if(spouseAge !== null && row.age - spouseAge > 10){
    reasons.push('RMD_JOINT_LIFE_TABLE_FACTS_UNSUPPORTED');
  }

  reasons.push('RMD_PRIOR_YEAR_END_ACCOUNT_BALANCES_NOT_PROVEN');
  return unique(reasons);
}

export function retirementBeforeRmdReasons(context){
  if(context.engineProjection?.traditionalCouldExistAtRetirement !== true) return [];
  if(context.householdAges.resolvedRetirement <= context.householdAges.primary) return [];
  if(context.householdAges.resolvedRetirement <= 73) return [];
  const startAge = applicableRmdAge(context.ownerProfiles?.client?.birthDate);
  if(startAge === null) return ['RMD_BIRTH_DATE_NOT_CONFIRMED'];
  return projectedAccumulationSkipsRmd(context, startAge)
    ? ['RMD_BEFORE_RETIREMENT_NOT_MODELED']
    : [];
}

function modelLimitationReasons(row, context, calendarYear, taxCoverage){
  const reasons = [...MODEL_LIMITATION_CODES];
  if(row.taxFundingConvergence?.status !== 'converged'){
    reasons.push('PHASE_6_FUNDING_NOT_CONVERGED');
  }
  if(taxCoverage.taxTotalScope !== null && taxCoverage.taxTotalScope !== 'FULL_1040'){
    reasons.push('TAX_TOTAL_SCOPE_INCOME_TAX_ONLY');
  }
  if(row.taxableCapitalGain > 0){
    reasons.push('SCHEDULE_D_GAIN_CHARACTER_NOT_MODELED');
  }
  if(row.accountStartingBalances.taxable > 0){
    reasons.push('TAXABLE_PORTFOLIO_YIELD_INCOME_NOT_MODELED');
  }
  if(row.pension > 0){
    reasons.push('PENSION_TAXABLE_PORTION_ASSUMED_FULLY_TAXABLE');
  }
  if(row.socialSecurity > 0){
    const worksheet = context.planMeta.socialSecurityWorksheet ?? {};
    if(worksheet.taxExemptInterest === undefined){
      reasons.push('SOCIAL_SECURITY_TAX_EXEMPT_INTEREST_ASSUMED_ZERO');
    }
    if(worksheet.excludedIncomeAddBacks === undefined){
      reasons.push('SOCIAL_SECURITY_EXCLUDED_INCOME_ADDBACKS_ASSUMED_ZERO');
    }
    if(worksheet.adjustments === undefined){
      reasons.push('SOCIAL_SECURITY_WORKSHEET_ADJUSTMENTS_ASSUMED_ZERO');
    }
  }
  const usesStandard = context.planMeta.deductions?.method === 'standard'
    || (context.planMeta.deductions?.useStandard !== false
      && context.planMeta.deductions?.itemizedAmount === undefined);
  const modelsAgeAddition = context.planMeta.deductions?.method === 'standard'
    && context.planMeta.deductions?.source === 'calculated'
    && context.planMeta.deductions?.standardScope === 'base-and-age';
  if(usesStandard){
    const activeOwners = ['client'];
    if(context.householdAges.spouse !== null) activeOwners.push('spouse');
    let hasSenior = false;
    for(const owner of activeOwners){
      const age = ownerAgeForRow(owner, row, context);
      const profile = context.ownerProfiles?.[owner];
      if(age !== null && age >= 65) hasSenior = true;
      if(profile?.blindConfirmed !== true){
        reasons.push('STANDARD_DEDUCTION_BLINDNESS_NOT_CONFIRMED');
      }else if(profile.blind === true){
        reasons.push('STANDARD_DEDUCTION_BLIND_ADDITION_NOT_MODELED');
      }
    }
    if(hasSenior && !modelsAgeAddition){
      reasons.push('STANDARD_DEDUCTION_AGE_ADDITION_NOT_MODELED');
    }
    if(hasSenior){
      if(calendarYear >= 2025 && calendarYear <= 2028){
        reasons.push('ENHANCED_SENIOR_DEDUCTION_NOT_MODELED');
      }
    }
  }
  return unique(reasons);
}

export function buildComparisonEligibility(
  row,
  context,
  calendarYear,
  taxCoverage,
  calculationReasons
){
  return cloneFreeze({
    status: 'blocked',
    reasonCodes: unique([
      ...calculationReasons,
      ...context.readiness.scopeReasons,
      ...modelLimitationReasons(row, context, calendarYear, taxCoverage),
    ]),
  });
}

export function counterfactualSemantics(row = null){
  return Object.freeze({
    taxSource: 'federal-form-1040-line-24-modeled-scope',
    taxLabel: 'modeled-federal-income-tax',
    taxableGainCharacter: 'modeled-as-net-long-term-capital-gain',
    taxablePortfolioYieldIncome: 'not-modeled',
    pensionTaxablePortion: 'modeled-as-fully-taxable',
    socialSecuritySupplementalFacts: 'explicit-when-supplied-otherwise-zero-assumption',
    traditionalDistributionTreatment: 'fully-taxable-only-when-proven',
    rothDistributionTreatment: 'qualified-only-when-proven',
    rmdTreatment: 'withheld-unless-owner-and-account-legal-baseline-is-proven',
    convergence: row?.taxFundingConvergence?.status === 'converged'
      ? 'converged'
      : 'not-converged',
    recommendation: 'none',
  });
}

import { ACCOUNT_SCHEMA_VERSION } from '../src/household/accountTypes.js';
import { createBlankTaxProfiles } from '../src/household/factEnvelope.js';
import { createIncomeTaxInputs } from '../src/household/incomeTaxModel.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from '../src/household/householdRecordSchema.js';

const clonePristinePlan = pristinePlan => JSON.parse(JSON.stringify(pristinePlan));

/* Persistent first-run slot. It is intentionally blank: "demo" identifies a
   convenient record, not a fictional household whose values can overwrite the
   advisor's saved work. */
export function createDemoHousehold(pristinePlan, currentYear){
  const p = createBlankHousehold(pristinePlan, 'demo', currentYear);
  p.meta.name = 'Demo Household';
  p.meta.isDemo = true;
  return p;
}

/* Empty household record with nondeterministic inputs supplied by the caller. */
export function createBlankHousehold(pristinePlan, householdId, currentYear){
  const p = clonePristinePlan(pristinePlan);
  p.meta.householdId = householdId;
  p.meta.name        = 'New Household';
  p.meta.isDemo      = false;
  p.meta.primaryName = '';
  p.meta.spouseName  = '';
  p.meta.filingStatus = 'single';
  p.meta.state       = 'VA';
  p.meta.planningAsOfYear = currentYear;
  p.household.primary = { currentAge: 60, retirementAge: 65, planEndAge: 90, birthYear: currentYear - 60 };
  p.household.spouse  = null;
  p.household.children = [];
  p.portfolio.accounts.taxable     = { balance: 0, basisPct: 1.0 };
  p.portfolio.accounts.traditional = { balance: 0 };
  p.portfolio.accounts.roth        = { balance: 0 };
  p.portfolio.extraAccounts = [];
  p.meta.accountSchemaVersion = ACCOUNT_SCHEMA_VERSION;
  p.meta.householdRecordSchemaVersion = HOUSEHOLD_RECORD_SCHEMA_VERSION;
  p.taxProfiles = createBlankTaxProfiles();
  p.properties  = [];
  p.liabilities = [];
  p.expenses.living              = 0;
  p.expenses.healthcare          = 0;
  p.expenses.healthcareRealGrowth = 0.02;
  p.expenses.extra = [];
  p.savings.annual        = 0;
  p.income.workingIncome  = 0;
  p.income.socialSecurity.primary = { pia: null, claimAge: 67 };
  p.income.socialSecurity.spouse  = null;
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  p.income.other   = [];
  p.incomeTax = createIncomeTaxInputs();
  p.goals = [];
  p.simulation.iterations = 1000;
  return p;
}

import { ACCOUNT_SCHEMA_VERSION } from '../src/household/accountTypes.js';
import { createAccount } from '../src/household/createAccount.js';
import { createBlankTaxProfiles, createFact } from '../src/household/factEnvelope.js';
import { createIncomeTaxInputs } from '../src/household/incomeTaxModel.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from '../src/household/householdRecordSchema.js';
import {
  SPENDING_SCHEMA_VERSION,
  makeEssentialsGoal,
  makeHealthcareGoal,
  healthcarePreloadFor,
} from '../src/household/migrateSpendingToGoals.js';

const clonePristinePlan = pristinePlan => JSON.parse(JSON.stringify(pristinePlan));

// One-shot UI signal. The app's normal boot path still receives a blank demo
// record. Only an explicit Load demo action arms the next demo-factory call to
// return the populated sample. Module state disappears on refresh by design.
let populatedDemoRequested = false;
export function requestPopulatedDemoHousehold(){
  populatedDemoRequested = true;
}

/* Persistent first-run slot. It is intentionally blank: "demo" identifies a
   convenient record, not a fictional household whose values can overwrite the
   advisor's saved work. */
export function createDemoHousehold(pristinePlan, currentYear){
  if(populatedDemoRequested){
    populatedDemoRequested = false;
    return createPopulatedDemoHousehold(pristinePlan, currentYear);
  }
  const p = createBlankHousehold(pristinePlan, 'demo', currentYear);
  p.meta.name = 'Demo Household';
  p.meta.isDemo = true;
  return p;
}

export const SHIPPED_DEFAULT_HOUSEHOLD_IDS = Object.freeze([
  'default-pre-retirement-solo',
  'default-pre-retirement-couple',
]);

function addDefaultAccount(plan, {
  id, typeId, displayName, owner, balance,
}){
  const account = createAccount(typeId, { displayName, owner, balance });
  account.id = id;
  plan.portfolio.extraAccounts.push(account);
}

function setConfirmedBirthDate(plan, owner, iso){
  plan.taxProfiles[owner].birthDate = createFact(
    iso,
    'confirmed',
    'household-entry',
    `${iso}T12:00:00Z`,
  );
}

function addWages(plan, {
  id, owner, label, amount, startAge, endAge,
}){
  plan.income.other.push({
    id,
    typeId: 'wages',
    owner,
    label,
    amount,
    startAge,
    endAge,
    realGrowth: 0,
    taxablePct: 1,
  });
}

function createPreRetirementSolo(pristinePlan, currentYear){
  const plan = createBlankHousehold(
    pristinePlan,
    SHIPPED_DEFAULT_HOUSEHOLD_IDS[0],
    currentYear,
  );
  const birthYear = currentYear - 64;
  plan.meta.name = 'Pre-Retirement Solo';
  plan.meta.primaryName = 'Sample Client';
  plan.meta.isSelectableDefault = true;
  plan.household.primary = {
    currentAge: 64,
    retirementAge: 66,
    planEndAge: 96,
    birthYear,
    employmentStatus: 'employed',
  };
  setConfirmedBirthDate(plan, 'client', `${birthYear}-01-15`);
  addDefaultAccount(plan, {
    id: 'default-solo-traditional',
    typeId: 'traditional_ira',
    displayName: 'Traditional IRA',
    owner: 'client',
    balance: 1_600_000,
  });
  addDefaultAccount(plan, {
    id: 'default-solo-taxable',
    typeId: 'tod_brokerage',
    displayName: 'TOD Brokerage',
    owner: 'client',
    balance: 800_000,
  });
  addDefaultAccount(plan, {
    id: 'default-solo-roth',
    typeId: 'roth_ira',
    displayName: 'Roth IRA',
    owner: 'client',
    balance: 400_000,
  });
  addWages(plan, {
    id: 'default-solo-wages',
    owner: 'client',
    label: 'Client wages',
    amount: 50_000,
    startAge: 64,
    endAge: 65,
  });
  return plan;
}

function createPreRetirementCouple(pristinePlan, currentYear){
  const plan = createBlankHousehold(
    pristinePlan,
    SHIPPED_DEFAULT_HOUSEHOLD_IDS[1],
    currentYear,
  );
  const clientBirthYear = currentYear - 62;
  const spouseBirthYear = currentYear - 60;
  plan.meta.name = 'Pre-Retirement Couple';
  plan.meta.primaryName = 'Sample Client';
  plan.meta.spouseName = 'Sample Co-Client';
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.meta.isSelectableDefault = true;
  plan.household.primary = {
    currentAge: 62,
    retirementAge: 67,
    planEndAge: 95,
    birthYear: clientBirthYear,
    employmentStatus: 'employed',
  };
  plan.household.spouse = {
    currentAge: 60,
    retirementAge: 65,
    planEndAge: 97,
    birthYear: spouseBirthYear,
    employmentStatus: 'employed',
  };
  plan.income.socialSecurity.spouse = { pia: null, claimAge: 67 };
  setConfirmedBirthDate(plan, 'client', `${clientBirthYear}-02-15`);
  setConfirmedBirthDate(plan, 'spouse', `${spouseBirthYear}-03-15`);
  addDefaultAccount(plan, {
    id: 'default-couple-traditional',
    typeId: 'traditional_ira',
    displayName: 'Client Traditional IRA',
    owner: 'client',
    balance: 1_200_000,
  });
  addDefaultAccount(plan, {
    id: 'default-couple-taxable',
    typeId: 'tod_brokerage',
    displayName: 'Client TOD Brokerage',
    owner: 'client',
    balance: 600_000,
  });
  addDefaultAccount(plan, {
    id: 'default-couple-roth',
    typeId: 'roth_ira',
    displayName: 'Client Roth IRA',
    owner: 'client',
    balance: 350_000,
  });
  addWages(plan, {
    id: 'default-couple-client-wages',
    owner: 'client',
    label: 'Client wages',
    amount: 70_000,
    startAge: 62,
    endAge: 66,
  });
  addWages(plan, {
    id: 'default-couple-spouse-wages',
    owner: 'spouse',
    label: 'Co-client wages',
    amount: 40_000,
    startAge: 60,
    endAge: 64,
  });
  return plan;
}

function createPopulatedDemoHousehold(pristinePlan, currentYear){
  const plan = createPreRetirementCouple(pristinePlan, currentYear);
  plan.meta.householdId = 'demo';
  plan.meta.name = 'Demo Household';
  plan.meta.primaryName = 'Alex Morgan';
  plan.meta.spouseName = 'Jordan Morgan';
  plan.meta.isDemo = true;
  plan.meta.isSelectableDefault = false;

  plan.household.primary.retirementAge = 67;
  plan.household.spouse.retirementAge = 65;
  plan.income.socialSecurity.primary = { pia: 44_000, claimAge: 70 };
  plan.income.socialSecurity.spouse = { pia: 32_000, claimAge: 67 };
  plan.savings.annual = 35_000;
  plan.portfolio.riskProfile = 3;

  const clientWages = plan.income.other.find(source => source.id === 'default-couple-client-wages');
  const spouseWages = plan.income.other.find(source => source.id === 'default-couple-spouse-wages');
  if(clientWages) clientWages.amount = 150_000;
  if(spouseWages) spouseWages.amount = 95_000;

  const clientTraditional = plan.portfolio.extraAccounts.find(account => account.id === 'default-couple-traditional');
  const taxable = plan.portfolio.extraAccounts.find(account => account.id === 'default-couple-taxable');
  const clientRoth = plan.portfolio.extraAccounts.find(account => account.id === 'default-couple-roth');
  if(clientTraditional) clientTraditional.balance = 1_200_000;
  if(taxable){
    taxable.balance = 700_000;
    taxable.basis = {
      amount: 420_000,
      method: 'reported',
      status: 'confirmed',
      source: 'household-entry',
      confirmedAt: `${currentYear}-01-01T12:00:00Z`,
      version: 1,
    };
  }
  if(clientRoth) clientRoth.balance = 300_000;

  addDefaultAccount(plan, {
    id: 'demo-spouse-traditional',
    typeId: 'traditional_ira',
    displayName: 'Jordan Traditional IRA',
    owner: 'spouse',
    balance: 650_000,
  });
  addDefaultAccount(plan, {
    id: 'demo-spouse-roth',
    typeId: 'roth_ira',
    displayName: 'Jordan Roth IRA',
    owner: 'spouse',
    balance: 250_000,
  });

  const essentials = plan.goals.find(goal => goal.system === 'essentials');
  if(essentials) essentials.amount = 90_000;
  plan.goals.push(
    {
      name: 'Travel',
      amount: 15_000,
      startAge: 67,
      endAge: 80,
    },
    {
      name: 'Vehicle replacement',
      amount: 60_000,
      startAge: 70,
      endAge: 70,
    },
  );
  return plan;
}

export function createSelectableDefaultHouseholds(pristinePlan, currentYear){
  return [
    createPreRetirementSolo(pristinePlan, currentYear),
    createPreRetirementCouple(pristinePlan, currentYear),
  ];
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
  // Spending is entered on the Goals page. These stay zeroed so nothing can
  // reach the engine through the retired channel.
  p.expenses.living              = 0;
  p.expenses.housing             = 0;
  p.expenses.debt                = 0;
  p.expenses.healthcare          = 0;
  p.expenses.healthcareRealGrowth = 0.02;
  p.expenses.extra = [];
  p.meta.spendingSchemaVersion = SPENDING_SCHEMA_VERSION;
  p.savings.annual        = 0;
  p.income.workingIncome  = 0;
  p.income.socialSecurity.primary = { pia: null, claimAge: 67 };
  p.income.socialSecurity.spouse  = null;
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  p.income.other   = [];
  p.incomeTax = createIncomeTaxInputs();
  // Every household starts with the two spending goals it will always have.
  // Essentials opens at $0 for the advisor to fill in; Healthcare preloads a
  // per-person figure and escalates above general inflation.
  p.goals = [
    makeEssentialsGoal(0),
    makeHealthcareGoal(healthcarePreloadFor(p)),
  ];
  p.simulation.iterations = 1000;
  return p;
}

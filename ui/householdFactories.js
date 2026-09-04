import { ACCOUNT_SCHEMA_VERSION } from '../src/household/accountTypes.js';
import { createAccount } from '../src/household/createAccount.js';
import {
  snapshotLegacyRiskProfileAllocation,
  snapshotPresetAllocation,
} from '../src/household/investmentAllocation.js';
import { LEGACY_BASE_ACCOUNT_IDS } from '../src/household/migrateAccounts.js';
import { createBlankTaxProfiles, createFact } from '../src/household/factEnvelope.js';
import { createIncomeTaxInputs } from '../src/household/incomeTaxModel.js';
import { addFamilyFinanceEntry } from '../src/household/familyFinanceEntries.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from '../src/household/householdRecordSchema.js';
import { createEmptyNetWorthRecords } from '../src/household/netWorthRecords.js';
import { setWizardTaxField } from '../src/household/wizardTaxMutations.js';
import { confirmWizardTaxInputs } from '../src/household/wizardTaxCompletion.js';
import {
  SPENDING_SCHEMA_VERSION,
  makeEssentialsGoal,
  makeHealthcareGoal,
  healthcarePreloadFor,
} from '../src/household/migrateSpendingToGoals.js';

const clonePristinePlan = pristinePlan => JSON.parse(JSON.stringify(pristinePlan));

export const SHIPPED_DEFAULT_HOUSEHOLD_IDS = Object.freeze([
  'now-household',
  'future-household',
  'joe-household',
]);

export const DEFAULT_STARTUP_HOUSEHOLD_ID = 'joe-household';

function addDefaultAccount(plan, {
  id, typeId, displayName, owner, balance, investmentAllocation,
}){
  const account = createAccount(typeId, {
    displayName,
    owner,
    balance,
    ...(investmentAllocation ? { investmentAllocation } : {}),
  });
  account.id = id;
  plan.portfolio.extraAccounts.push(account);
  return account;
}

function confirmEmployerPlanIsPretax(account){
  const confirmedAt = '2026-09-04T12:00:00Z';
  account.employerPlanFacts.afterTaxContributionBasis = createFact(
    0,
    'confirmed',
    'household-entry',
    confirmedAt,
  );
  account.employerPlanFacts.planSubtypeConfirmed = createFact(
    true,
    'confirmed',
    'household-entry',
    confirmedAt,
  );
}

function applyLegacyFixtureAllocation(plan, riskProfile){
  plan.portfolio.riskProfile = riskProfile;
  const allocation = snapshotLegacyRiskProfileAllocation(riskProfile);
  for(const sleeve of ['taxable', 'traditional', 'roth']){
    plan.portfolio.accounts[sleeve].investmentAllocation = structuredClone(allocation);
  }
  for(const account of plan.portfolio.extraAccounts){
    account.investmentAllocation = structuredClone(allocation);
  }
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

function setConfirmedForm8606Zero(plan, owner){
  const traditionalIra = plan.taxProfiles[owner].traditionalIra;
  for(const key of [
    'priorYearCarryforwardBasis',
    'currentYearNondeductibleContributions',
    'outstandingRolloversAtYearEnd',
    'otherForm8606Adjustments',
  ]){
    traditionalIra[key] = createFact(
      0,
      'confirmed',
      'household-entry',
      '2026-08-23T12:00:00Z',
    );
  }
}

function createNowHousehold(pristinePlan, currentYear){
  const plan = createBlankHousehold(
    pristinePlan,
    SHIPPED_DEFAULT_HOUSEHOLD_IDS[0],
    currentYear,
  );
  plan.meta.name = 'Now Household';
  plan.meta.primaryName = 'Aboysname';
  plan.meta.spouseName = 'Agirlsname';
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.meta.planningAsOfYear = 2026;
  plan.meta.isSelectableDefault = true;
  plan.household.primary = {
    currentAge: 36,
    retirementAge: 65,
    planEndAge: 95,
    birthYear: 1990,
    employmentStatus: 'employed',
  };
  plan.household.spouse = {
    currentAge: 33,
    retirementAge: 60,
    planEndAge: 95,
    birthYear: 1993,
    employmentStatus: 'employed',
  };
  plan.income.socialSecurity = {
    primary: { pia: 50_000, claimAge: 67 },
    spouse: { pia: 50_000, claimAge: 67 },
  };
  setConfirmedBirthDate(plan, 'client', '1990-01-15');
  setConfirmedBirthDate(plan, 'spouse', '1993-03-15');
  addDefaultAccount(plan, {
    id: 'now-client-401k',
    typeId: '401k',
    displayName: 'Aboysname 401(k)',
    owner: 'client',
    balance: 140_000,
  });
  addDefaultAccount(plan, {
    id: 'now-spouse-401k',
    typeId: '401k',
    displayName: 'Agirlsname 401(k)',
    owner: 'spouse',
    balance: 220_000,
  });
  const jointBrokerage = addDefaultAccount(plan, {
    id: 'now-joint-brokerage',
    typeId: 'joint_brokerage',
    displayName: 'Joint Brokerage',
    owner: 'joint',
    balance: 40_000,
  });
  jointBrokerage.taxReporting = {
    inclusion: 'household-return',
    reportingTaxpayer: 'return-level',
    householdReturnShare: 1,
  };
  addDefaultAccount(plan, {
    id: 'now-spouse-tod-brokerage',
    typeId: 'tod_brokerage',
    displayName: 'Agirlsname TOD Brokerage',
    owner: 'spouse',
    balance: 40_000,
  });
  addDefaultAccount(plan, {
    id: 'now-client-roth-ira',
    typeId: 'roth_ira',
    displayName: 'Aboysname Roth IRA',
    owner: 'client',
    balance: 40_000,
  });
  addWages(plan, {
    id: 'now-client-wages',
    owner: 'client',
    label: 'Aboysname wages',
    amount: 220_000,
    startAge: 36,
    endAge: 64,
  });
  addWages(plan, {
    id: 'now-spouse-wages',
    owner: 'spouse',
    label: 'Agirlsname wages',
    amount: 210_000,
    startAge: 33,
    endAge: 59,
  });

  plan.properties = [{
    name: 'Primary Home',
    value: 800_000,
    purchasePrice: 0,
    netWorthMeta: { type: 'Primary Home', owner: 'joint' },
    mortgage: {
      balance: 545_000,
      rate: 0,
      termYears: 0,
      netWorthMeta: {
        present: true,
        name: 'Mortgage',
        type: 'Mortgage',
        owner: 'joint',
      },
    },
  }];

  setWizardTaxField(plan, 'taxYear', 2026);
  setWizardTaxField(plan, 'deductionMode', 'itemized-details');
  setWizardTaxField(plan, 'deductions.itemized.medicalExpensesPaid', 0);
  setWizardTaxField(plan, 'deductions.itemized.salt.eligibleTaxesPaid', 14_000);
  setWizardTaxField(plan, 'deductions.itemized.salt.magi', 352_000);
  setWizardTaxField(plan, 'deductions.itemized.mortgageInterestDeductible', 34_000);
  setWizardTaxField(plan, 'deductions.itemized.charitableContributionsDeductible', 0);
  setWizardTaxField(plan, 'deductions.itemized.otherItemizedDeductions', 0);
  setWizardTaxField(plan, 'irmaa.lookback.2024.magi', 0);
  setWizardTaxField(plan, 'irmaa.lookback.2025.magi', 0);
  confirmWizardTaxInputs(plan);

  plan.goals = [
    makeEssentialsGoal(240_000),
    makeHealthcareGoal(11_000),
    {
      id: 'now-travel',
      name: 'Travel',
      amount: 35_000,
      startAge: 65,
      endAge: 75,
      realGrowth: 0,
      flexesWithSpending: true,
    },
  ];
  plan.savings.annual = 46_000;
  applyLegacyFixtureAllocation(plan, 5);
  return plan;
}

function createFutureHousehold(pristinePlan, currentYear){
  const plan = createBlankHousehold(
    pristinePlan,
    SHIPPED_DEFAULT_HOUSEHOLD_IDS[1],
    currentYear,
  );
  plan.meta.name = 'Future Household';
  plan.meta.primaryName = 'amansname';
  plan.meta.spouseName = 'awomansname';
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.meta.planningAsOfYear = 2026;
  plan.meta.isSelectableDefault = true;
  plan.household.primary = {
    currentAge: 65,
    retirementAge: 63,
    planEndAge: 95,
    birthYear: 1961,
    employmentStatus: 'retired',
  };
  plan.household.spouse = {
    currentAge: 65,
    retirementAge: 63,
    planEndAge: 95,
    birthYear: 1961,
    employmentStatus: 'retired',
  };
  plan.income.socialSecurity = {
    primary: { pia: 50_000, claimAge: 67 },
    spouse: { pia: 50_000, claimAge: 67 },
  };
  setConfirmedBirthDate(plan, 'client', '1961-01-15');
  setConfirmedBirthDate(plan, 'spouse', '1961-03-15');
  setConfirmedForm8606Zero(plan, 'client');
  setConfirmedForm8606Zero(plan, 'spouse');

  addDefaultAccount(plan, {
    id: 'future-client-rollover-ira',
    typeId: 'rollover_ira',
    displayName: 'amansname Rollover IRA',
    owner: 'client',
    balance: 1_800_000,
  });
  addDefaultAccount(plan, {
    id: 'future-spouse-rollover-ira',
    typeId: 'rollover_ira',
    displayName: 'awomansname Rollover IRA',
    owner: 'spouse',
    balance: 1_500_000,
  });
  const jointBrokerage = addDefaultAccount(plan, {
    id: 'future-joint-brokerage',
    typeId: 'joint_brokerage',
    displayName: 'Joint Brokerage',
    owner: 'joint',
    balance: 1_600_000,
  });
  jointBrokerage.taxReporting = {
    inclusion: 'household-return',
    reportingTaxpayer: 'return-level',
    householdReturnShare: 1,
  };
  addDefaultAccount(plan, {
    id: 'future-client-tod-brokerage',
    typeId: 'tod_brokerage',
    displayName: 'amansname TOD Brokerage',
    owner: 'client',
    balance: 800_000,
  });
  addDefaultAccount(plan, {
    id: 'future-client-roth-ira',
    typeId: 'roth_ira',
    displayName: 'amansname Roth IRA',
    owner: 'client',
    balance: 700_000,
  });
  addDefaultAccount(plan, {
    id: 'future-spouse-roth-ira',
    typeId: 'roth_ira',
    displayName: 'awomansname Roth IRA',
    owner: 'spouse',
    balance: 600_000,
  });

  plan.properties = [{
    name: 'Primary Home',
    value: 900_000,
    purchasePrice: 0,
    netWorthMeta: { type: 'Primary Home', owner: 'joint' },
    mortgage: {
      balance: 240_000,
      rate: 0,
      termYears: 0,
      netWorthMeta: {
        present: true,
        name: 'Mortgage',
        type: 'Mortgage',
        owner: 'joint',
      },
    },
  }];

  setWizardTaxField(plan, 'taxYear', 2026);
  setWizardTaxField(plan, 'deductionMode', 'standard');
  setWizardTaxField(plan, 'income.taxableInterest', 8_000);
  setWizardTaxField(plan, 'income.ordinaryDividends', 15_000);
  setWizardTaxField(plan, 'scheduleD.netLongTermGainOrLoss', 10_000);
  setWizardTaxField(plan, 'irmaa.lookback.2024.magi', 42_000);
  setWizardTaxField(plan, 'irmaa.lookback.2025.magi', 42_000);
  confirmWizardTaxInputs(plan);

  plan.goals = [
    {
      ...makeEssentialsGoal(204_000),
      startsAtRetirement: false,
      startAge: 65,
      endAge: 95,
    },
    {
      ...makeHealthcareGoal(11_000),
      startsAtRetirement: false,
      startAge: 65,
      endAge: 95,
    },
    {
      id: 'future-travel-first-10',
      name: 'Travel — first 10 years',
      amount: 35_000,
      startAge: 65,
      endAge: 74,
      realGrowth: 0,
      flexesWithSpending: true,
    },
    {
      id: 'future-travel-years-11-15',
      name: 'Travel — years 11–15',
      amount: 15_000,
      startAge: 75,
      endAge: 79,
      realGrowth: 0,
      flexesWithSpending: true,
    },
    {
      id: 'future-education',
      name: 'Education',
      amount: 40_000,
      startAge: 65,
      endAge: 69,
      realGrowth: 0,
      flexesWithSpending: true,
    },
  ];
  applyLegacyFixtureAllocation(plan, 3);
  return plan;
}

function createJoeHousehold(pristinePlan, currentYear){
  const plan = createBlankHousehold(
    pristinePlan,
    DEFAULT_STARTUP_HOUSEHOLD_ID,
    currentYear,
  );
  plan.meta.name = 'Joe Household';
  plan.meta.primaryName = 'Joe';
  plan.meta.spouseName = 'Jane';
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.meta.planningAsOfYear = 2026;
  plan.meta.isSelectableDefault = true;
  plan.household.primary = {
    currentAge: 60,
    retirementAge: 64,
    planEndAge: 95,
    birthYear: 1966,
    employmentStatus: 'employed',
  };
  plan.household.spouse = {
    currentAge: 60,
    retirementAge: 64,
    planEndAge: 95,
    birthYear: 1966,
    employmentStatus: 'employed',
  };
  plan.income.socialSecurity = {
    primary: { pia: 50_000, claimAge: 67 },
    spouse: { pia: 50_000, claimAge: 67 },
  };
  setConfirmedBirthDate(plan, 'client', '1966-01-15');
  setConfirmedBirthDate(plan, 'spouse', '1966-03-15');

  const growth = snapshotPresetAllocation('growth');
  const allEquity = snapshotPresetAllocation('all-equity');
  const balanced = snapshotPresetAllocation('balanced');
  const client401k = addDefaultAccount(plan, {
    id: 'joe-client-401k',
    typeId: '401k',
    displayName: 'Joe 401(k)',
    owner: 'client',
    balance: 1_300_000,
    investmentAllocation: growth,
  });
  confirmEmployerPlanIsPretax(client401k);
  addDefaultAccount(plan, {
    id: 'joe-client-roth-ira',
    typeId: 'roth_ira',
    displayName: 'Joe Roth IRA',
    owner: 'client',
    balance: 350_000,
    investmentAllocation: allEquity,
  });
  const jointBrokerage = addDefaultAccount(plan, {
    id: 'joe-joint-brokerage',
    typeId: 'joint_brokerage',
    displayName: 'Joint Brokerage',
    owner: 'joint',
    balance: 675_000,
    investmentAllocation: balanced,
  });
  jointBrokerage.taxReporting = {
    inclusion: 'household-return',
    reportingTaxpayer: 'return-level',
    householdReturnShare: 1,
  };
  const spouse401k = addDefaultAccount(plan, {
    id: 'joe-spouse-401k',
    typeId: '401k',
    displayName: 'Jane 401(k)',
    owner: 'spouse',
    balance: 700_000,
    investmentAllocation: growth,
  });
  confirmEmployerPlanIsPretax(spouse401k);
  addDefaultAccount(plan, {
    id: 'joe-spouse-roth-ira',
    typeId: 'roth_ira',
    displayName: 'Jane Roth IRA',
    owner: 'spouse',
    balance: 122_000,
    investmentAllocation: allEquity,
  });
  addDefaultAccount(plan, {
    id: 'joe-spouse-tod-brokerage',
    typeId: 'tod_brokerage',
    displayName: 'Jane TOD Brokerage',
    owner: 'spouse',
    balance: 266_000,
    investmentAllocation: balanced,
  });

  plan.properties = [{
    name: 'Primary Home',
    value: 1_000_000,
    purchasePrice: 0,
    netWorthMeta: { type: 'Primary Home', owner: 'joint' },
    mortgage: {
      balance: 400_000,
      rate: 0,
      termYears: 0,
      netWorthMeta: {
        present: true,
        name: 'Mortgage',
        type: 'Mortgage',
        owner: 'joint',
      },
    },
  }];

  setWizardTaxField(plan, 'taxYear', 2026);
  setWizardTaxField(plan, 'deductionMode', 'standard');
  setWizardTaxField(plan, 'income.wages.client', 210_000);
  setWizardTaxField(plan, 'income.wages.spouse', 210_000);
  plan.income.other.find(row => row.owner === 'client' && row.typeId === 'wages').id = 'joe-client-wages';
  plan.income.other.find(row => row.owner === 'spouse' && row.typeId === 'wages').id = 'joe-spouse-wages';
  confirmWizardTaxInputs(plan);

  addFamilyFinanceEntry(plan, {
    mode: 'savings',
    typeId: '401k',
    owner: 'client',
    amount: 30_000,
  });
  addFamilyFinanceEntry(plan, {
    mode: 'savings',
    typeId: '401k',
    owner: 'spouse',
    amount: 30_000,
  });
  plan.savings.entries.find(entry => entry.owner === 'client').id = 'joe-client-401k-savings';
  plan.savings.entries.find(entry => entry.owner === 'spouse').id = 'joe-spouse-401k-savings';

  plan.goals = [
    {
      ...makeEssentialsGoal(156_000),
      per: 'mo',
    },
    makeHealthcareGoal(11_000),
    {
      id: 'joe-travel',
      name: 'Travel',
      cat: 'travel',
      area: 'travel',
      per: 'yr',
      amount: 20_000,
      startAge: 64,
      endAge: 78,
      realGrowth: 0,
      flexesWithSpending: true,
    },
    {
      id: 'joe-kitchen',
      name: 'Kitchen',
      cat: 'home',
      area: 'home',
      per: 'yr',
      amount: 50_000,
      startAge: 61,
      endAge: 61,
      realGrowth: 0,
    },
    {
      id: 'joe-pool',
      name: 'Pool',
      cat: 'home',
      area: 'home',
      per: 'yr',
      amount: 100_000,
      startAge: 65,
      endAge: 65,
      realGrowth: 0,
    },
  ];
  return plan;
}

export function createSelectableDefaultHouseholds(pristinePlan, currentYear){
  return [
    createNowHousehold(pristinePlan, currentYear),
    createFutureHousehold(pristinePlan, currentYear),
    createJoeHousehold(pristinePlan, currentYear),
  ];
}

export function getDefaultStartupHousehold(householdsById){
  const startupHousehold = householdsById?.[DEFAULT_STARTUP_HOUSEHOLD_ID];
  if(!startupHousehold){
    throw new Error(`Startup household ${DEFAULT_STARTUP_HOUSEHOLD_ID} is unavailable`);
  }
  return startupHousehold;
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
  const baseAllocation = snapshotLegacyRiskProfileAllocation(p.portfolio.riskProfile);
  p.portfolio.accounts.taxable = {
    id: LEGACY_BASE_ACCOUNT_IDS.taxable,
    balance: 0,
    basisPct: 1.0,
    investmentAllocation: structuredClone(baseAllocation),
  };
  p.portfolio.accounts.traditional = {
    id: LEGACY_BASE_ACCOUNT_IDS.traditional,
    balance: 0,
    investmentAllocation: structuredClone(baseAllocation),
  };
  p.portfolio.accounts.roth = {
    id: LEGACY_BASE_ACCOUNT_IDS.roth,
    balance: 0,
    investmentAllocation: structuredClone(baseAllocation),
  };
  p.portfolio.extraAccounts = [];
  p.netWorth = createEmptyNetWorthRecords();
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

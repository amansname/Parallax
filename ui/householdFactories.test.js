import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultPlan, resolveInputs } from '../engine.js';
import { buildCurrentAnnualFederalTaxBaseline } from '../src/household/buildWizardIncomeTaxSummary.js';
import { buildCurrent1040Intake } from '../src/planning/tax/buildCurrent1040Intake.js';
import { prepareHouseholdRecordForSave } from '../src/household/persistence.js';
import { addFamilyFinanceEntry } from '../src/household/familyFinanceEntries.js';
import {
  ASSET_KEYS,
  snapshotLegacyRiskProfileAllocation,
  snapshotPresetAllocation,
} from '../src/household/investmentAllocation.js';
import { resolveTaxableStartingBasis } from '../src/household/resolveTaxableStartingBasis.js';
import {
  applyProjectionContributions,
  cloneProjectionAccountLedger,
  resolveProjectionReturnFrame,
} from '../src/projection/accountLedger.js';
import {
  DEFAULT_STARTUP_HOUSEHOLD_ID,
  SHIPPED_DEFAULT_HOUSEHOLD_IDS,
  createSelectableDefaultHouseholds,
  getDefaultStartupHousehold,
} from './householdFactories.js';

test('the selector ships the approved households with Joe as the startup template', () => {
  const defaults = createSelectableDefaultHouseholds(defaultPlan, 2026);

  assert.deepEqual(SHIPPED_DEFAULT_HOUSEHOLD_IDS, [
    'now-household',
    'future-household',
    'joe-household',
  ]);
  assert.deepEqual(defaults.map(value => value.meta.householdId), [
    'now-household',
    'future-household',
    'joe-household',
  ]);
  assert.deepEqual(defaults.map(value => value.meta.name), [
    'Now Household',
    'Future Household',
    'Joe Household',
  ]);
  assert.equal(DEFAULT_STARTUP_HOUSEHOLD_ID, 'joe-household');
  const householdsById = Object.fromEntries(
    defaults.map(household => [household.meta.householdId, household]),
  );
  assert.equal(getDefaultStartupHousehold(householdsById), defaults[2]);
  assert.throws(
    () => getDefaultStartupHousehold({}),
    /Startup household joe-household is unavailable/,
  );
});

test('Joe Household carries the requested deterministic planning facts', () => {
  const defaults = createSelectableDefaultHouseholds(defaultPlan, 2026);
  const household = defaults.find(value => value.meta.householdId === 'joe-household');

  assert.ok(household);
  assert.deepEqual({
    name: household.meta.name,
    primaryName: household.meta.primaryName,
    spouseName: household.meta.spouseName,
    filingStatus: household.meta.filingStatus,
    planningAsOfYear: household.meta.planningAsOfYear,
    selectable: household.meta.isSelectableDefault,
  }, {
    name: 'Joe Household',
    primaryName: 'Joe',
    spouseName: 'Jane',
    filingStatus: 'marriedFilingJointly',
    planningAsOfYear: 2026,
    selectable: true,
  });
  assert.deepEqual(household.household, {
    primary: {
      currentAge: 60,
      retirementAge: 64,
      planEndAge: 95,
      birthYear: 1966,
      employmentStatus: 'employed',
    },
    spouse: {
      currentAge: 60,
      retirementAge: 64,
      planEndAge: 95,
      birthYear: 1966,
      employmentStatus: 'employed',
    },
    children: [],
  });
  assert.equal(household.taxProfiles.client.birthDate.value, '1966-01-15');
  assert.equal(household.taxProfiles.spouse.birthDate.value, '1966-03-15');
  assert.deepEqual(household.income.socialSecurity, {
    primary: { pia: 50_000, claimAge: 67 },
    spouse: { pia: 50_000, claimAge: 67 },
  });
  assert.deepEqual(
    household.income.other.map(({ id, typeId, owner, amount, startAge, endAge }) => ({
      id, typeId, owner, amount, startAge, endAge,
    })),
    [
      {
        id: 'joe-client-wages', typeId: 'wages', owner: 'client',
        amount: 210_000, startAge: undefined, endAge: undefined,
      },
      {
        id: 'joe-spouse-wages', typeId: 'wages', owner: 'spouse',
        amount: 210_000, startAge: undefined, endAge: undefined,
      },
    ],
  );
  assert.equal(buildCurrent1040Intake(household).intake.income.wages, 420_000);
  assert.equal(household.incomeTax.current1040.incomeSourcesComplete, true);
  assert.equal(buildCurrentAnnualFederalTaxBaseline(household).status, 'ready');

  const accounts = household.portfolio.extraAccounts;
  assert.deepEqual(
    accounts.map(({ id, typeId, owner, balance, investmentAllocation }) => ({
      id, typeId, owner, balance, allocation: investmentAllocation.presetId,
    })),
    [
      { id: 'joe-client-401k', typeId: '401k', owner: 'client', balance: 1_300_000, allocation: 'growth' },
      { id: 'joe-client-roth-ira', typeId: 'roth_ira', owner: 'client', balance: 350_000, allocation: 'all-equity' },
      { id: 'joe-joint-brokerage', typeId: 'joint_brokerage', owner: 'joint', balance: 675_000, allocation: 'balanced' },
      { id: 'joe-spouse-401k', typeId: '401k', owner: 'spouse', balance: 700_000, allocation: 'growth' },
      { id: 'joe-spouse-roth-ira', typeId: 'roth_ira', owner: 'spouse', balance: 122_000, allocation: 'all-equity' },
      { id: 'joe-spouse-tod-brokerage', typeId: 'tod_brokerage', owner: 'spouse', balance: 266_000, allocation: 'balanced' },
    ],
  );
  assert.equal(accounts.reduce((sum, account) => sum + account.balance, 0), 3_413_000);
  assert.deepEqual(accounts[0].investmentAllocation, snapshotPresetAllocation('growth'));
  assert.deepEqual(accounts[1].investmentAllocation, snapshotPresetAllocation('all-equity'));
  assert.deepEqual(accounts[2].investmentAllocation, snapshotPresetAllocation('balanced'));
  for(const account of accounts.filter(value => value.typeId === '401k')){
    assert.equal(account.employerPlanFacts.afterTaxContributionBasis.value, 0);
    assert.equal(account.employerPlanFacts.afterTaxContributionBasis.status, 'confirmed');
    assert.equal(account.employerPlanFacts.planSubtypeConfirmed.value, true);
    assert.equal(account.employerPlanFacts.planSubtypeConfirmed.status, 'confirmed');
  }
  const taxableBasis = resolveTaxableStartingBasis(household);
  assert.equal(taxableBasis.status, 'assumed-50-50');
  assert.equal(taxableBasis.taxableBalance, 941_000);
  assert.equal(taxableBasis.basisOverride, 470_500);

  assert.deepEqual(household.savings, {
    annual: 60_000,
    split: { taxable: 0, traditional: 1, roth: 0 },
    entries: [
      {
        id: 'joe-client-401k-savings', typeId: '401k', label: '401(k) deferral',
        owner: 'client', amount: 30_000, bucket: 'traditional',
      },
      {
        id: 'joe-spouse-401k-savings', typeId: '401k', label: '401(k) deferral',
        owner: 'spouse', amount: 30_000, bucket: 'traditional',
      },
    ],
  });
  assert.deepEqual(household.properties, [{
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
  }]);
  assert.deepEqual(household.goals, [
    {
      id: 'system:essentials', system: 'essentials', name: 'Essentials',
      amount: 156_000, startsAtRetirement: true, endAge: 999,
      realGrowth: 0, flexesWithSpending: true, per: 'mo',
    },
    {
      id: 'system:healthcare', system: 'healthcare', name: 'Healthcare',
      amount: 11_000, startsAtRetirement: true, endAge: 999, realGrowth: 0.02,
    },
    {
      id: 'joe-travel', name: 'Travel', cat: 'travel', area: 'travel', per: 'yr',
      amount: 20_000, startAge: 64, endAge: 78, realGrowth: 0, flexesWithSpending: true,
    },
    {
      id: 'joe-kitchen', name: 'Kitchen', cat: 'home', area: 'home', per: 'yr',
      amount: 50_000, startAge: 61, endAge: 61, realGrowth: 0,
    },
    {
      id: 'joe-pool', name: 'Pool', cat: 'home', area: 'home', per: 'yr',
      amount: 100_000, startAge: 65, endAge: 65, realGrowth: 0,
    },
  ]);

  const resolved = resolveInputs(household, {});
  assert.equal(resolved.simulationAvailable, true);
  assert.equal(resolved.incomeContractAvailable, true);
  assert.deepEqual(resolved.savingsEntries, [
    { owner: 'client', typeId: '401k', bucket: 'traditional', amount: 30_000 },
    { owner: 'spouse', typeId: '401k', bucket: 'traditional', amount: 30_000 },
  ]);
  assert.deepEqual(
    resolved.goals.map(({ id, amount, startAge, endAge }) => ({ id, amount, startAge, endAge })),
    [
      { id: 'system:essentials', amount: 156_000, startAge: 64, endAge: 999 },
      { id: 'system:healthcare', amount: 11_000, startAge: 64, endAge: 999 },
      { id: 'joe-travel', amount: 20_000, startAge: 64, endAge: 78 },
      { id: 'joe-kitchen', amount: 50_000, startAge: 61, endAge: 61 },
      { id: 'joe-pool', amount: 100_000, startAge: 65, endAge: 65 },
    ],
  );
  assert.doesNotThrow(() => prepareHouseholdRecordForSave(
    household,
    household.meta.householdId,
  ));
  const second = createSelectableDefaultHouseholds(defaultPlan, 2026)
    .find(value => value.meta.householdId === 'joe-household');
  assert.deepEqual(second, household);
});

test('Now Household carries the approved plan facts', () => {
  const defaults = createSelectableDefaultHouseholds(defaultPlan, 2026);
  const [household] = defaults;

  assert.equal(household.meta.name, 'Now Household');
  assert.equal(household.meta.primaryName, 'Aboysname');
  assert.equal(household.meta.spouseName, 'Agirlsname');
  assert.equal(household.meta.isSelectableDefault, true);
  assert.equal(household.meta.filingStatus, 'marriedFilingJointly');
  assert.deepEqual(household.household.primary, {
    currentAge: 36,
    retirementAge: 65,
    planEndAge: 95,
    birthYear: 1990,
    employmentStatus: 'employed',
  });
  assert.deepEqual(household.household.spouse, {
    currentAge: 33,
    retirementAge: 60,
    planEndAge: 95,
    birthYear: 1993,
    employmentStatus: 'employed',
  });
  assert.equal(household.taxProfiles.client.birthDate.value, '1990-01-15');
  assert.equal(household.taxProfiles.spouse.birthDate.value, '1993-03-15');
  assert.deepEqual(household.income.socialSecurity, {
    primary: { pia: 50_000, claimAge: 67 },
    spouse: { pia: 50_000, claimAge: 67 },
  });
  assert.deepEqual(
    household.income.other.map(({ owner, amount, startAge, endAge }) => ({
      owner, amount, startAge, endAge,
    })),
    [
      { owner: 'client', amount: 220_000, startAge: 36, endAge: 64 },
      { owner: 'spouse', amount: 210_000, startAge: 33, endAge: 59 },
    ],
  );
  assert.deepEqual(
    household.portfolio.extraAccounts.map(({ typeId, owner, balance }) => ({
      typeId, owner, balance,
    })),
    [
      { typeId: '401k', owner: 'client', balance: 140_000 },
      { typeId: '401k', owner: 'spouse', balance: 220_000 },
      { typeId: 'joint_brokerage', owner: 'joint', balance: 40_000 },
      { typeId: 'tod_brokerage', owner: 'spouse', balance: 40_000 },
      { typeId: 'roth_ira', owner: 'client', balance: 40_000 },
    ],
  );
  const brokerages = household.portfolio.extraAccounts.filter(
    account => account.bucket === 'taxable',
  );
  assert.deepEqual(brokerages.map(account => account.basis.status), ['unknown', 'unknown']);
  assert.deepEqual(brokerages.map(account => account.basis.amount), [null, null]);
  const taxableBasis = resolveTaxableStartingBasis(household);
  assert.equal(taxableBasis.status, 'assumed-50-50');
  assert.equal(taxableBasis.taxableBalance, 80_000);
  assert.equal(taxableBasis.basisOverride, 40_000);
  assert.equal(taxableBasis.assumptions.length, 2);
  assert.deepEqual(household.properties, [{
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
  }]);
  assert.deepEqual(household.incomeTax.irmaa.lookbackByTaxYear, {
    2024: { magi: 0, filingStatus: 'marriedFilingJointly' },
    2025: { magi: 0, filingStatus: 'marriedFilingJointly' },
  });
  assert.deepEqual(household.incomeTax.current1040.deductions.itemized, {
    medicalExpensesPaid: 0,
    salt: {
      eligibleTaxesPaid: 14_000,
      magi: { mode: 'supplied-magi', amount: 352_000 },
    },
    mortgageInterestDeductible: 34_000,
    charitableContributionsDeductible: 0,
    otherItemizedDeductions: 0,
  });
  assert.equal(household.incomeTax.current1040.incomeSourcesComplete, true);
  assert.equal(buildCurrentAnnualFederalTaxBaseline(household).status, 'ready');
  assert.deepEqual(household.goals, [
    {
      id: 'system:essentials', system: 'essentials', name: 'Essentials',
      amount: 240_000, startsAtRetirement: true, endAge: 999,
      realGrowth: 0, flexesWithSpending: true,
    },
    {
      id: 'system:healthcare', system: 'healthcare', name: 'Healthcare',
      amount: 11_000, startsAtRetirement: true, endAge: 999, realGrowth: 0.02,
    },
    {
      id: 'now-travel', name: 'Travel', amount: 35_000,
      startAge: 65, endAge: 75, realGrowth: 0, flexesWithSpending: true,
    },
  ]);
  assert.equal(household.savings.annual, 46_000);
  assert.equal(household.portfolio.riskProfile, 5);
  const nowAllocation = snapshotLegacyRiskProfileAllocation(5);
  assert.deepEqual(
    Object.values(household.portfolio.accounts).map(account => account.investmentAllocation),
    [nowAllocation, nowAllocation, nowAllocation],
  );
  assert.deepEqual(
    household.portfolio.extraAccounts.map(account => account.investmentAllocation),
    household.portfolio.extraAccounts.map(() => nowAllocation),
  );
  assert.doesNotThrow(() => prepareHouseholdRecordForSave(
    household,
    household.meta.householdId,
  ));
});

test('Now Household itemized savings total once and reach the compatible joint brokerage', () => {
  const [household] = createSelectableDefaultHouseholds(defaultPlan, 2026);
  const storedPortfolio = JSON.stringify(household.portfolio);

  addFamilyFinanceEntry(household, {
    mode: 'savings', typeId: '401k', owner: 'client', amount: 23_500,
  });
  addFamilyFinanceEntry(household, {
    mode: 'savings', typeId: '401k', owner: 'spouse', amount: 23_500,
  });
  addFamilyFinanceEntry(household, {
    mode: 'savings', typeId: 'brokerage_taxable', owner: 'client', amount: 12_000,
  });

  assert.equal(household.savings.annual, 59_000);
  assert.deepEqual(household.savings.split, {
    taxable: 12_000 / 59_000,
    traditional: 47_000 / 59_000,
    roth: 0,
  });

  const resolved = resolveInputs(household, {});
  assert.deepEqual(resolved.savingsEntries, [
    { owner: 'client', typeId: '401k', bucket: 'traditional', amount: 23_500 },
    { owner: 'spouse', typeId: '401k', bucket: 'traditional', amount: 23_500 },
    { owner: 'client', typeId: 'brokerage_taxable', bucket: 'taxable', amount: 12_000 },
  ]);

  const ledger = cloneProjectionAccountLedger(resolved.projectionAccounts);
  const returnRow = {
    y: 2026,
    ...Object.fromEntries(ASSET_KEYS.map(key => [key, 0])),
  };
  const frame = resolveProjectionReturnFrame(ledger, returnRow, 0);
  const contributions = applyProjectionContributions(
    ledger,
    frame,
    { taxable: 12_000, traditional: 47_000, roth: 0 },
    resolved.savingsEntries,
  );
  const accountBy = (typeId, owner) => ledger.find(account => (
    account.typeId === typeId && account.owner === owner
  ));
  const client401k = accountBy('401k', 'client');
  const spouse401k = accountBy('401k', 'spouse');
  const jointBrokerage = accountBy('joint_brokerage', 'unattributed');
  const spouseTod = accountBy('tod_brokerage', 'spouse');

  assert.equal(contributions[client401k.id], 23_500);
  assert.equal(contributions[spouse401k.id], 23_500);
  assert.equal(contributions[jointBrokerage.id], 12_000);
  assert.equal(contributions[spouseTod.id], 0);
  assert.equal(jointBrokerage.balance, 52_000);
  assert.equal(jointBrokerage.basis, 32_000);
  assert.equal(spouseTod.balance, 40_000);
  assert.equal(spouseTod.basis, 20_000);
  assert.equal(JSON.stringify(household.portfolio), storedPortfolio);
});

test('Future Household carries the approved current-age retirement facts', () => {
  const defaults = createSelectableDefaultHouseholds(defaultPlan, 2026);
  const household = defaults.find(value => value.meta.householdId === 'future-household');

  assert.ok(household);
  assert.equal(household.meta.name, 'Future Household');
  assert.equal(household.meta.primaryName, 'amansname');
  assert.equal(household.meta.spouseName, 'awomansname');
  assert.equal(household.meta.isSelectableDefault, true);
  assert.equal(household.meta.filingStatus, 'marriedFilingJointly');
  assert.deepEqual(household.household.primary, {
    currentAge: 65,
    retirementAge: 63,
    planEndAge: 95,
    birthYear: 1961,
    employmentStatus: 'retired',
  });
  assert.deepEqual(household.household.spouse, {
    currentAge: 65,
    retirementAge: 63,
    planEndAge: 95,
    birthYear: 1961,
    employmentStatus: 'retired',
  });
  assert.equal(household.taxProfiles.client.birthDate.value, '1961-01-15');
  assert.equal(household.taxProfiles.spouse.birthDate.value, '1961-03-15');
  assert.deepEqual(household.income.socialSecurity, {
    primary: { pia: 50_000, claimAge: 67 },
    spouse: { pia: 50_000, claimAge: 67 },
  });
  assert.deepEqual(household.income.other, []);

  const accounts = household.portfolio.extraAccounts;
  assert.equal(accounts.reduce((sum, account) => sum + account.balance, 0), 7_000_000);
  assert.deepEqual(
    accounts.map(({ typeId, owner, balance }) => ({ typeId, owner, balance })),
    [
      { typeId: 'rollover_ira', owner: 'client', balance: 1_800_000 },
      { typeId: 'rollover_ira', owner: 'spouse', balance: 1_500_000 },
      { typeId: 'joint_brokerage', owner: 'joint', balance: 1_600_000 },
      { typeId: 'tod_brokerage', owner: 'client', balance: 800_000 },
      { typeId: 'roth_ira', owner: 'client', balance: 700_000 },
      { typeId: 'roth_ira', owner: 'spouse', balance: 600_000 },
    ],
  );
  for(const owner of ['client', 'spouse']){
    const traditionalIra = household.taxProfiles[owner].traditionalIra;
    for(const key of [
      'priorYearCarryforwardBasis',
      'currentYearNondeductibleContributions',
      'outstandingRolloversAtYearEnd',
      'otherForm8606Adjustments',
    ]){
      assert.equal(traditionalIra[key].value, 0);
      assert.equal(traditionalIra[key].status, 'confirmed');
    }
  }
  const taxableBasis = resolveTaxableStartingBasis(household);
  assert.equal(taxableBasis.status, 'assumed-50-50');
  assert.equal(taxableBasis.taxableBalance, 2_400_000);
  assert.equal(taxableBasis.basisOverride, 1_200_000);
  assert.equal(taxableBasis.assumptions.length, 2);
  const resolved = resolveInputs(household, {});
  assert.equal(resolved.simulationAvailable, true);
  assert.equal(resolved.currentAge, 65);
  assert.equal(resolved.retirementAge, 63);
  assert.equal(resolved.accounts.taxable.balance, 2_400_000);
  assert.equal(resolved.accounts.taxable.basis, 1_200_000);
  assert.equal(Math.round(resolved.accounts.traditional.balance), 3_300_000);
  assert.equal(resolved.accounts.roth.balance, 1_300_000);
  const futureAllocation = snapshotLegacyRiskProfileAllocation(3);
  assert.deepEqual(
    Object.values(household.portfolio.accounts).map(account => account.investmentAllocation),
    [futureAllocation, futureAllocation, futureAllocation],
  );
  assert.deepEqual(
    household.portfolio.extraAccounts.map(account => account.investmentAllocation),
    household.portfolio.extraAccounts.map(() => futureAllocation),
  );

  assert.deepEqual(household.properties, [{
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
  }]);
  assert.deepEqual(household.incomeTax.irmaa.lookbackByTaxYear, {
    2024: { magi: 42_000, filingStatus: 'marriedFilingJointly' },
    2025: { magi: 42_000, filingStatus: 'marriedFilingJointly' },
  });
  assert.equal(household.incomeTax.current1040.deductions.method, 'standard');
  assert.equal(household.incomeTax.current1040.income.wages, 0);
  assert.equal(household.incomeTax.current1040.income.taxableInterest, 8_000);
  assert.equal(household.incomeTax.current1040.income.ordinaryDividends, 15_000);
  assert.deepEqual(household.incomeTax.current1040.scheduleD, {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 10_000,
  });
  assert.equal(household.incomeTax.current1040.incomeSourcesComplete, true);
  assert.equal(buildCurrentAnnualFederalTaxBaseline(household).status, 'ready');
  assert.deepEqual(household.goals, [
    {
      id: 'system:essentials', system: 'essentials', name: 'Essentials',
      amount: 204_000, startsAtRetirement: false, startAge: 65, endAge: 95,
      realGrowth: 0, flexesWithSpending: true,
    },
    {
      id: 'system:healthcare', system: 'healthcare', name: 'Healthcare',
      amount: 11_000, startsAtRetirement: false, startAge: 65, endAge: 95,
      realGrowth: 0.02,
    },
    {
      id: 'future-travel-first-10', name: 'Travel — first 10 years', amount: 35_000,
      startAge: 65, endAge: 74, realGrowth: 0, flexesWithSpending: true,
    },
    {
      id: 'future-travel-years-11-15', name: 'Travel — years 11–15', amount: 15_000,
      startAge: 75, endAge: 79, realGrowth: 0, flexesWithSpending: true,
    },
    {
      id: 'future-education', name: 'Education', amount: 40_000,
      startAge: 65, endAge: 69, realGrowth: 0, flexesWithSpending: true,
    },
  ]);
  assert.deepEqual(
    resolved.goals.map(({ id, startAge, endAge }) => ({ id, startAge, endAge })),
    [
      { id: 'system:essentials', startAge: 65, endAge: 95 },
      { id: 'system:healthcare', startAge: 65, endAge: 95 },
      { id: 'future-travel-first-10', startAge: 65, endAge: 74 },
      { id: 'future-travel-years-11-15', startAge: 75, endAge: 79 },
      { id: 'future-education', startAge: 65, endAge: 69 },
    ],
  );
  assert.doesNotThrow(() => prepareHouseholdRecordForSave(
    household,
    household.meta.householdId,
  ));
});

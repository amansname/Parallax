import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultPlan, resolveInputs } from '../engine.js';
import { buildCurrentAnnualFederalTaxBaseline } from '../src/household/buildWizardIncomeTaxSummary.js';
import { prepareHouseholdRecordForSave } from '../src/household/persistence.js';
import { resolveTaxableStartingBasis } from '../src/household/resolveTaxableStartingBasis.js';
import {
  SHIPPED_DEFAULT_HOUSEHOLD_IDS,
  createSelectableDefaultHouseholds,
} from './householdFactories.js';

test('the selector ships only the approved Now and Future households', () => {
  const defaults = createSelectableDefaultHouseholds(defaultPlan, 2026);

  assert.deepEqual(SHIPPED_DEFAULT_HOUSEHOLD_IDS, [
    'now-household',
    'future-household',
  ]);
  assert.deepEqual(defaults.map(value => value.meta.householdId), [
    'now-household',
    'future-household',
  ]);
  assert.deepEqual(defaults.map(value => value.meta.name), [
    'Now Household',
    'Future Household',
  ]);
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
  assert.doesNotThrow(() => prepareHouseholdRecordForSave(
    household,
    household.meta.householdId,
  ));
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

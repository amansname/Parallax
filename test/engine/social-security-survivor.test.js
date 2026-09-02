// Engine contract: Social Security spouse and survivor transitions.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  defaultPlan,
  householdIncomeAtYear,
  resolveInputs,
  runSinglePath,
} from '../../engine.js';
import { flatAssetReturnRow } from './fixtures.js';

function survivorPlan({
  primaryPia = 18_000,
  spousePia = 36_000,
  currentAge = 67,
  primaryEndAge = 90,
  spouseEndAge = 67,
  primaryClaimAge = 67,
  spouseClaimAge = 67,
} = {}){
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.household.primary = {
    currentAge,
    retirementAge: currentAge,
    planEndAge: primaryEndAge,
  };
  plan.household.spouse = {
    currentAge,
    retirementAge: currentAge,
    planEndAge: spouseEndAge,
  };
  plan.income.socialSecurity = {
    primary: { pia: primaryPia, claimAge: primaryClaimAge },
    spouse: { pia: spousePia, claimAge: spouseClaimAge },
  };
  plan.income.other = [];
  plan.expenses = {
    living: 0,
    housing: 0,
    debt: 0,
    healthcare: 0,
    healthcareRealGrowth: 0,
    extra: [],
  };
  plan.goals = [{
    id: 'essential_living',
    name: 'Essential living',
    amount: 24_000,
    startAge: 67,
    endAge: Math.max(primaryEndAge, spouseEndAge),
    system: true,
  }];
  plan.liabilities = [];
  plan.ltc = { amount: 0, onsetAge: 999 };
  plan.portfolio.accounts.taxable.balance = 2_000_000;
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.accounts.roth.balance = 0;
  plan.savings.annual = 0;
  return plan;
}

test('first death replaces two benefits with the larger survivor benefit on the next row', () => {
  const plan = survivorPlan();
  const resolved = resolveInputs(plan, {});
  const deathYear = householdIncomeAtYear(resolved, 0);
  const firstSurvivorYear = householdIncomeAtYear(resolved, 1);

  assert.strictEqual(deathYear.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(deathYear.socialSecurityBenefits, 54_000);
  assert.strictEqual(firstSurvivorYear.filingStatus, 'single');
  assert.strictEqual(firstSurvivorYear.survivingOwner, 'client');
  assert.strictEqual(firstSurvivorYear.socialSecurityBenefits, 36_000);

  const path = Array.from(
    { length: resolved.horizonYears },
    (_, index) => flatAssetReturnRow(2026 + index),
  );
  const rows = runSinglePath(resolved, path).rows;
  assert.strictEqual(rows[0].socialSecurity, 54_000);
  assert.strictEqual(rows[1].socialSecurity, 36_000);
  assert.strictEqual(rows[1].filingStatus, 'single');
  assert.strictEqual(rows[1].expenses, 24_000,
    'survivor spending continues after the first death');
  assert.ok(rows.length > 2, 'projection continues through the survivor horizon');
});

test('the survivor keeps a larger worker benefit without stacking the deceased benefit', () => {
  const resolved = resolveInputs(survivorPlan({
    primaryPia: 36_000,
    spousePia: 18_000,
  }), {});

  assert.strictEqual(householdIncomeAtYear(resolved, 0).socialSecurityBenefits, 54_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 1).socialSecurityBenefits, 36_000);
});

test('the spouse-survivor direction uses the same larger-benefit contract', () => {
  const resolved = resolveInputs(survivorPlan({
    primaryPia: 36_000,
    spousePia: 18_000,
    primaryEndAge: 67,
    spouseEndAge: 90,
  }), {});
  const firstSurvivorYear = householdIncomeAtYear(resolved, 1);

  assert.strictEqual(firstSurvivorYear.filingStatus, 'single');
  assert.strictEqual(firstSurvivorYear.survivingOwner, 'spouse');
  assert.strictEqual(firstSurvivorYear.socialSecurityBenefits, 36_000);
});

test('spousal excess while married is recalculated as a survivor benefit after death', () => {
  const resolved = resolveInputs(survivorPlan({
    primaryPia: 10_000,
    spousePia: 40_000,
  }), {});

  assert.strictEqual(householdIncomeAtYear(resolved, 0).socialSecurityBenefits, 60_000,
    'client receives own worker benefit plus the unreduced spousal excess');
  assert.strictEqual(householdIncomeAtYear(resolved, 1).socialSecurityBenefits, 40_000,
    'spousal excess stops and the larger survivor benefit replaces it');
});

test('reduced deceased worker benefits preserve the survivor floor at full survivor retirement age', () => {
  const resolved = resolveInputs(survivorPlan({
    primaryPia: 10_000,
    spousePia: 40_000,
    spouseClaimAge: 62,
  }), {});

  assert.strictEqual(householdIncomeAtYear(resolved, 1).socialSecurityBenefits, 33_000,
    '82.5% of the deceased worker PIA exceeds the age-62 worker amount');
});

test('survivor benefits begin at the first eligible annual boundary independently of worker claim age', () => {
  const plan = survivorPlan({
    primaryPia: 40_000,
    spousePia: 10_000,
    currentAge: 62,
    primaryEndAge: 62,
    spouseEndAge: 90,
    primaryClaimAge: 62,
    spouseClaimAge: 67,
  });
  const resolved = resolveInputs(plan, {});

  assert.ok(householdIncomeAtYear(resolved, 1).socialSecurityBenefits > 0,
    'a survivor already over 60 does not wait for the separate worker-benefit election');
  assert.strictEqual(householdIncomeAtYear(resolved, 5).socialSecurityBenefits, 33_000,
    'the survivor later retains the larger payable benefit without stacking');
});

test('RIB-LIM caps the age-reduced widow amount instead of being reduced twice', () => {
  const resolved = resolveInputs(survivorPlan({
    primaryPia: 10_000,
    spousePia: 40_000,
    currentAge: 60,
    primaryEndAge: 90,
    spouseEndAge: 60,
    primaryClaimAge: 67,
    spouseClaimAge: 62,
  }), {});
  const firstSurvivorYear = householdIncomeAtYear(resolved, 1);

  assert.ok(Math.abs(firstSurvivorYear.socialSecurityBenefits - 30_228.571428571428) < 1e-9);
});

test('RIB-LIM ordering is symmetric when the spouse is the survivor', () => {
  const resolved = resolveInputs(survivorPlan({
    primaryPia: 40_000,
    spousePia: 10_000,
    currentAge: 60,
    primaryEndAge: 60,
    spouseEndAge: 90,
    primaryClaimAge: 62,
    spouseClaimAge: 67,
  }), {});

  assert.ok(Math.abs(
    householdIncomeAtYear(resolved, 1).socialSecurityBenefits
      - 30_228.571428571428,
  ) < 1e-9);
});

test('missing deceased worker claim age fails closed without a NaN survivor amount', () => {
  const plan = survivorPlan({ spousePia: 24_000, spouseClaimAge: 67 });
  plan.income.socialSecurity.spouse.claimAge = null;
  const resolved = resolveInputs(plan, {});

  assert.strictEqual(resolved.survival.socialSecuritySurvivorBenefits.client, undefined);
  assert.strictEqual(householdIncomeAtYear(resolved, 1).socialSecurityBenefits, null,
    'the unknown deceased claim history keeps the larger-benefit comparison unavailable');
});

test('missing survivor worker claim age leaves the larger-benefit comparison unavailable', () => {
  const plan = survivorPlan({ primaryPia: 40_000, spousePia: 36_000 });
  plan.income.socialSecurity.primary.claimAge = null;
  const resolved = resolveInputs(plan, {});

  assert.ok(Number.isFinite(
    resolved.survival.socialSecuritySurvivorBenefits.client.amount,
  ));
  assert.strictEqual(householdIncomeAtYear(resolved, 1).socialSecurityBenefits, null,
    'Parallax cannot choose the larger benefit without the worker election');
});

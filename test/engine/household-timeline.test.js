// Engine contract: household timeline. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { runSimulation, runHistoricalPath, runSinglePath, resolveInputs, defaultPlan, resolveHouseholdTimeline, householdStateAtYear, householdIncomeAtYear } from '../../engine.js';
import { flatAssetReturnRow } from './fixtures.js';

test('spouse retirement age extends accumulation on the same calendar timeline', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 57, retirementAge: 67, planEndAge: 89 };
  p.savings.annual = 50000;
  p.savings.split = { traditional: 0, roth: 0, taxable: 1 };
  p.portfolio.accounts.taxable.balance = 5e6;
  p.portfolio.accounts.traditional.balance = 0;
  p.portfolio.accounts.roth.balance = 0;

  const resolved = resolveInputs(p, {});
  assert.strictEqual(resolved.retirementAge, 68,
    'spouse age 57 retiring at 67 maps to primary age 68');

  const m = runHistoricalPath(p, 1995, 'taxable-first');
  assert.strictEqual(m.rows.find(r => r.age === 67).phase, 'accum',
    'household remains in accumulation until spouse retirement calendar year');
  assert.notStrictEqual(m.rows.find(r => r.age === 68).phase, 'accum',
    'retirement cash flows start when both spouse retirement ages have arrived');

  p.household.spouse.retirementAge = 64;
  assert.strictEqual(resolveInputs(p, {}).retirementAge, 65,
    'same-calendar spouse retirement preserves the client retirement year');
});

test('spouse-owned working income uses the spouse timeline and stops at retirement', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 60, retirementAge: 67, planEndAge: 90 };
  p.household.spouse = { currentAge: 58, retirementAge: 63, planEndAge: 90 };
  p.portfolio.accounts.taxable.balance += p.portfolio.accounts.traditional.balance;
  p.portfolio.accounts.traditional.balance = 0;
  p.savings.annual = 0;
  p.income.other = [{
    typeId: 'wages', owner: 'spouse', label: 'Co-client wages', amount: 60000,
    startAge: 58, endAge: 62, realGrowth: 0, taxablePct: 1,
  }];
  const m = runHistoricalPath(p, 1995, 'taxable-first');
  assert.strictEqual(m.rows.find(row => row.age === 64).otherIncome, 60000,
    'spouse age 62 maps to primary age 64');
  assert.strictEqual(m.rows.find(row => row.age === 65).otherIncome, 0,
    'spouse wages stop after the spouse working window');
});

test('Tax-page member wages combine once and stop at each owner retirement age', () => {
  const p = structuredClone(defaultPlan);
  p.meta.planningAsOfYear = 2026;
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = {
    currentAge: 60, retirementAge: 65, planEndAge: 90, employmentStatus: 'employed',
  };
  p.household.spouse = {
    currentAge: 58, retirementAge: 62, planEndAge: 90, employmentStatus: 'employed',
  };
  p.incomeTax.current1040 = {
    taxYear: 2026,
    incomeSourcesComplete: false,
    income: {},
  };
  p.income.other = [
    { typeId: 'wages', owner: 'client', amount: 80_000, taxablePct: 1 },
    { typeId: 'wages', owner: 'spouse', amount: 60_000, taxablePct: 1 },
  ];

  const resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, 140_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 3).wages, 140_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 4).wages, 80_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 5).wages, 0);
});

test('current-year single wage total is a safe projection fallback but a prior-year total is not', () => {
  const p = structuredClone(defaultPlan);
  p.meta.planningAsOfYear = 2026;
  p.meta.filingStatus = 'single';
  p.household.primary = {
    currentAge: 60, retirementAge: 65, planEndAge: 90, employmentStatus: 'employed',
  };
  p.household.spouse = null;
  p.income.socialSecurity.spouse = null;
  p.income.other = [];
  p.incomeTax.current1040 = {
    taxYear: 2026,
    incomeSourcesComplete: false,
    income: { wages: 50_000 },
  };

  let resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, 50_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 4).wages, 50_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 5).wages, 0);

  p.incomeTax.current1040.taxYear = 2025;
  resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, null);
  assert.ok(resolved.incomeContractIssues.includes(
    'INCOME_SOURCE_MISSING:client:wages',
  ));
});

test('a retirement-year wage stays in that year without becoming future wages', () => {
  const p = structuredClone(defaultPlan);
  p.meta.planningAsOfYear = 2026;
  p.meta.filingStatus = 'single';
  p.household.primary = {
    currentAge: 65, retirementAge: 65, planEndAge: 90, employmentStatus: 'retired',
  };
  p.household.spouse = null;
  p.income.socialSecurity.spouse = null;
  p.income.other = [{
    typeId: 'wages', owner: 'client', amount: 25_000,
    startAge: 65, endAge: 65, taxablePct: 1,
  }];

  const resolved = resolveInputs(p, {});
  assert.strictEqual(householdIncomeAtYear(resolved, 0).wages, 25_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 1).wages, 0);
});

test('household timeline preserves each person age and lifecycle milestone', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 60, retirementAge: 67, planEndAge: 90 };
  p.household.spouse = { currentAge: 57, retirementAge: 63, planEndAge: 95 };
  p.portfolio.accounts.taxable.balance += p.portfolio.accounts.traditional.balance;
  p.portfolio.accounts.traditional.balance = 0;
  p.savings.annual = 0;
  p.income.socialSecurity = {
    primary: { pia: 30_000, claimAge: 68 },
    spouse: { pia: 20_000, claimAge: 70 },
  };

  const timeline = resolveHouseholdTimeline(p);
  assert.deepStrictEqual(timeline.people.client, {
    currentAge: 60,
    birthYear: null,
    rmdStartAge: 75,
    retirementAge: 67,
    socialSecurityClaimAge: 68,
    planEndAge: 90,
    retirementAgeOnPrimaryTimeline: 67,
    socialSecurityClaimAgeOnPrimaryTimeline: 68,
    planEndAgeOnPrimaryTimeline: 90,
  });
  assert.deepStrictEqual(timeline.people.spouse, {
    currentAge: 57,
    birthYear: null,
    rmdStartAge: 75,
    retirementAge: 63,
    socialSecurityClaimAge: 70,
    planEndAge: 95,
    retirementAgeOnPrimaryTimeline: 66,
    socialSecurityClaimAgeOnPrimaryTimeline: 73,
    planEndAgeOnPrimaryTimeline: 98,
  });
  assert.strictEqual(timeline.householdRetirementAgeOnPrimaryTimeline, 67);
  assert.strictEqual(timeline.householdEndAgeOnPrimaryTimeline, 98);

  const resolved = resolveInputs(p, {});
  const yearSix = householdStateAtYear(resolved, 6);
  assert.deepStrictEqual(yearSix.ages, { client: 66, spouse: 63 });
  assert.strictEqual(yearSix.people.client.retired, false);
  assert.strictEqual(yearSix.people.spouse.retired, true);
  assert.strictEqual(yearSix.people.client.claimingSocialSecurity, false);
  assert.strictEqual(yearSix.people.spouse.claimingSocialSecurity, false);
  assert.strictEqual(yearSix.filingStatus, 'marriedFilingJointly');

  const rows = runHistoricalPath(p, 1995, 'taxable-first').rows;
  assert.deepStrictEqual(rows[6].ages, { client: 66, spouse: 63 });
  assert.strictEqual(rows[13].people.client.claimingSocialSecurity, true);
  assert.strictEqual(rows[13].people.spouse.claimingSocialSecurity, true);
});

test('household income uses the same per-person survival boundary as simulation', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 64 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 24_000, claimAge: 63 },
  };
  p.income.other = [];

  const resolved = resolveInputs(p, {});
  assert.ok(householdIncomeAtYear(resolved, 0).socialSecurityBenefits > 0);
  const terminalAge = householdIncomeAtYear(resolved, 1);
  assert.ok(terminalAge.socialSecurityBenefits > 0);
  assert.strictEqual(terminalAge.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(terminalAge.people.spouse.alive, true);
  const afterSpouseEnd = householdIncomeAtYear(resolved, 2);
  assert.strictEqual(afterSpouseEnd.socialSecurityBenefits, 19_800,
    'the surviving client retains the larger payable survivor benefit');
  assert.strictEqual(afterSpouseEnd.filingStatus, 'single');
  assert.strictEqual(afterSpouseEnd.survivingOwner, 'client');
  assert.deepStrictEqual(afterSpouseEnd.ages, { client: 67, spouse: 65 });
});

test('terminal ages are included and longevity extends each person consistently', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 67 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 66 };
  const base = resolveInputs(p, {});
  const extended = resolveInputs(p, { longevityYears: 2 });

  assert.strictEqual(base.horizonYears, 4);
  assert.strictEqual(householdStateAtYear(base, 2).people.client.alive, true);
  assert.strictEqual(householdStateAtYear(base, 3).people.client.alive, false);
  assert.strictEqual(extended.people.client.planEndAge, 69);
  assert.strictEqual(extended.people.spouse.planEndAge, 68);
  assert.strictEqual(extended.horizonYears, 6);
  assert.strictEqual(householdStateAtYear(extended, 4).people.client.alive, true);
});

test('missing co-client milestones remain unknown and do not create a false simulation', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 60 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 24_000 },
  };

  const timeline = resolveHouseholdTimeline(p);
  assert.deepStrictEqual(timeline.people.spouse, {
    currentAge: 60,
    birthYear: null,
    rmdStartAge: 75,
    retirementAge: null,
    socialSecurityClaimAge: null,
    planEndAge: null,
    retirementAgeOnPrimaryTimeline: null,
    socialSecurityClaimAgeOnPrimaryTimeline: null,
    planEndAgeOnPrimaryTimeline: null,
  });
  assert.strictEqual(timeline.completeForSimulation, false);

  const resolved = resolveInputs(p, {});
  const state = householdStateAtYear(resolved, 0);
  assert.strictEqual(state.people.spouse.age, 60);
  assert.strictEqual(state.people.spouse.alive, true);
  assert.strictEqual(state.people.spouse.retired, null);
  const income = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(income.available, true);
  assert.strictEqual(income.socialSecurityBenefits, null);
  assert.ok(income.incomeIssues.includes('SOCIAL_SECURITY_TIMELINE_INCOMPLETE:spouse'));
  assert.throws(
    () => runSimulation(p, {}),
    error => error?.code === 'HOUSEHOLD_TIMELINE_INCOMPLETE'
  );
});

test('income aggregates stay blank when the source owner timeline is incomplete', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { retirementAge: 65, planEndAge: 90 };
  p.income.socialSecurity = { primary: null, spouse: null };
  p.income.other = [{
    typeId: 'rental', owner: 'spouse', amount: 12_000,
    startAge: 60, endAge: 90, taxablePct: 1,
  }];

  let facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.available, true);
  assert.strictEqual(facts.grossOtherIncome, null);
  assert.strictEqual(facts.otherIncome, null);
  assert.strictEqual(facts.wages, 0);
  assert.ok(facts.incomeIssues.includes('INCOME_TIMELINE_INCOMPLETE:spouse:rental'));

  p.income.other = [{
    typeId: 'wages', owner: 'spouse', amount: 12_000,
    startAge: 60, taxablePct: 1,
  }];
  facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.available, true);
  assert.strictEqual(facts.wages, null);
  assert.strictEqual(facts.grossOtherIncome, 0);
  assert.ok(facts.incomeIssues.includes('INCOME_TIMELINE_INCOMPLETE:spouse:wages'));
});

test('missing terminal age preserves known current-year facts but not an invented future status', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 63, retirementAge: 63 };
  p.income.socialSecurity = { primary: null, spouse: null };
  p.income.other = [];

  const resolved = resolveInputs(p, {});
  const current = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(current.people.spouse.alive, true);
  assert.strictEqual(current.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(current.available, true);

  const future = householdIncomeAtYear(resolved, 1);
  assert.strictEqual(future.people.spouse.alive, null);
  assert.strictEqual(future.filingStatus, null);
  assert.strictEqual(future.available, false);
});

test('past retirement ages remain intact for years-retired calculations', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 70, retirementAge: 65, planEndAge: 70 };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 1_000_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];
  p.expenses = {
    living: 0, housing: 0, debt: 0,
    healthcare: 10_000, healthcareRealGrowth: 0.10, extra: [],
  };

  const resolved = resolveInputs(p, {});
  assert.strictEqual(resolved.retirementAge, 65);
  const row = runHistoricalPath(p, 1995, 'taxable-first').rows[0];
  assert.ok(Math.abs(row.expenses - 10_000 * (1.10 ** 5)) < 0.01);
});

test('focus-year household facts are unavailable after nobody remains alive', () => {
  const single = structuredClone(defaultPlan);
  single.meta.filingStatus = 'single';
  single.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  single.household.spouse = null;
  single.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  single.income.other = [];
  const singleResolved = resolveInputs(single, {});
  assert.strictEqual(householdStateAtYear(singleResolved, 1).filingStatus, null);
  assert.strictEqual(householdIncomeAtYear(singleResolved, 1).available, false);

  const couple = structuredClone(single);
  couple.meta.filingStatus = 'marriedFilingJointly';
  couple.household.spouse = { currentAge: 64, retirementAge: 64, planEndAge: 64 };
  couple.income.socialSecurity.spouse = { pia: 0, claimAge: 67 };
  const coupleResolved = resolveInputs(couple, {});
  const afterBoth = householdStateAtYear(coupleResolved, 1);
  assert.strictEqual(afterBoth.people.client.alive, false);
  assert.strictEqual(afterBoth.people.spouse.alive, false);
  assert.strictEqual(afterBoth.filingStatus, null);
  assert.strictEqual(householdIncomeAtYear(coupleResolved, 1).available, false);
});

test('a missing Social Security claim age leaves that benefit blank without blocking the plan', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 67 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 65 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 24_000 },
  };
  p.income.other = [];

  const resolved = resolveInputs(p, {});
  assert.strictEqual(resolved.simulationAvailable, true);
  assert.strictEqual(resolved.incomeContractAvailable, false);
  assert.ok(resolved.incomeContractIssues.includes(
    'SOCIAL_SECURITY_TIMELINE_INCOMPLETE:spouse'
  ));
  assert.strictEqual(
    householdIncomeAtYear(resolved, 0).socialSecurityBenefits,
    null,
  );
  const path = Array.from(
    { length: resolved.horizonYears },
    (_, index) => flatAssetReturnRow(2026 + index),
  );
  assert.ok(Number.isFinite(runSimulation(p, {}, [path]).successRate));
  assert.ok(runSinglePath(resolved, path).rows.length > 0);
  assert.ok(
    runHistoricalPath(p, 1995, 'taxable-first').rows.length > 0,
  );
});

test('spouse-owned other income ends with the spouse lifetime, not one year later', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 90 };
  p.household.spouse = { currentAge: 63, retirementAge: 63, planEndAge: 64 };
  p.income.socialSecurity = { primary: null, spouse: null };
  p.income.other = [{
    typeId: 'other', owner: 'spouse', amount: 12_000,
    startAge: 63, endAge: 90, taxablePct: 1, realGrowth: 0,
  }];
  const resolved = resolveInputs(p, {});

  assert.strictEqual(householdIncomeAtYear(resolved, 1).otherIncome, 12_000);
  assert.strictEqual(householdIncomeAtYear(resolved, 2).otherIncome, 0);
});

test('typed Social Security, qualified dividends, and signed long-term gains keep their tax character', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [
    { typeId: 'social_security', owner: 'client', amount: 30_000, startAge: 65, endAge: 65 },
    { typeId: 'dividends', owner: 'client', amount: 100_000, startAge: 65, endAge: 65, taxablePct: 1, qualifiedPct: 1 },
    { typeId: 'long_term_capital_gain', owner: 'client', amount: -10_000, startAge: 65, endAge: 65 },
  ];

  const resolved = resolveInputs(p, {});
  const facts = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(facts.socialSecurityBenefits, 30_000);
  assert.strictEqual(facts.ordinaryDividends, 100_000);
  assert.strictEqual(facts.qualifiedDividends, 100_000);
  assert.strictEqual(facts.capitalGain, -10_000);
  assert.strictEqual(facts.otherIncome, 0);

  const row = runHistoricalPath(p, 1995, 'taxable-first').rows[0];
  assert.deepStrictEqual(row.incomeTaxFacts, {
    socialSecurityBenefits: 30_000,
    ordinaryDividends: 100_000,
    qualifiedDividends: 100_000,
    capitalGain: -10_000,
  });
  assert.strictEqual(row.socialSecurity, 30_000);
  assert.strictEqual(row.otherIncome, 90_000);
});

test('dedicated and typed Social Security for one owner are not counted twice', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 67, retirementAge: 67, planEndAge: 67 };
  p.income.socialSecurity = {
    primary: { pia: 36_000, claimAge: 67 },
    spouse: null,
  };
  p.income.other = [{
    typeId: 'social_security', owner: 'client', amount: 36_000,
    startAge: 67, endAge: 67,
  }];
  const facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.socialSecurityBenefits, 36_000);
  assert.strictEqual(facts.available, false);
  assert.ok(facts.incomeIssues.includes('SOCIAL_SECURITY_SOURCE_OVERLAP:client'));
});

test('negative longevity is rejected instead of creating an empty successful plan', () => {
  assert.throws(
    () => resolveInputs(structuredClone(defaultPlan), { longevityYears: -1 }),
    /finite nonnegative/
  );
  const invalidEnd = structuredClone(defaultPlan);
  invalidEnd.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 64 };
  assert.throws(() => resolveInputs(invalidEnd, {}), /cannot precede currentAge/);
  const fractionalAge = structuredClone(defaultPlan);
  fractionalAge.household.primary.currentAge = 65.5;
  assert.throws(() => resolveInputs(fractionalAge, {}), /finite integer/);
});

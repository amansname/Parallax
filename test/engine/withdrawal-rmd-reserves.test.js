// Engine contract: withdrawal rmd reserves. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { defaultPlan, resolveWithdrawalPlannerAccountState, approveWithdrawalPlannerLeverChange } from '../../engine.js';
import { createAccount } from '../../src/household/createAccount.js';

test('withdrawal planner reserves a known RMD before approving Roth conversions', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
  ];

  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.rmd.status, 'known');
  assert.strictEqual(state.rmd.owner, 'client');
  assert.strictEqual(state.rmd.age, 73);
  assert.strictEqual(state.rmd.applicableAge, 73);
  assert.ok(Math.abs(state.rmd.required - 10_000) < 0.01);
  assert.strictEqual(state.limits.deferredWithdrawal.min, 10_000);
  assert.strictEqual(state.levers.deferredWithdrawal, 10_000);
  assert.strictEqual(state.limits.rothConversion.max, 255_000);

  const approval = approveWithdrawalPlannerLeverChange(
    p,
    {},
    'rothConversion',
    265_000
  );
  assert.strictEqual(approval.approved, true);
  assert.strictEqual(approval.clamped, true);
  assert.strictEqual(approval.approvedValue, 255_000);
  assert.strictEqual(approval.levers.deferredWithdrawal, 10_000);
  assert.strictEqual(approval.state.pools.traditional.remaining, 0);

  const fixedCash = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 10_000,
    rmdEligibleCash: 10_000,
    taxYear: 2026,
  });
  assert.strictEqual(fixedCash.limits.deferredWithdrawal.min, 0);
  assert.strictEqual(fixedCash.limits.rothConversion.max, 255_000);

  const fixedConversion = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 10_000,
    rmdEligibleCash: 0,
    taxYear: 2026,
  });
  assert.strictEqual(fixedConversion.limits.deferredWithdrawal.min, 10_000);
  assert.strictEqual(fixedConversion.limits.rothConversion.max, 245_000);
});

test('withdrawal planner computes and reserves current-year RMDs by IRA owner', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.household.spouse = {
    currentAge: 75, retirementAge: 75, planEndAge: 95, birthYear: 1951,
  };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
    createAccount('traditional_ira', {
      owner: 'spouse', balance: 246_000, valuationDate: '2025-12-31',
    }),
  ];
  const reservations = {
    traditionalTotal: 5_000,
    rmdEligibleCash: 5_000,
    traditionalByOwner: { client: 0, spouse: 5_000 },
    rmdEligibleCashByOwner: { client: 0, spouse: 5_000 },
    taxYear: 2026,
  };

  const state = resolveWithdrawalPlannerAccountState(
    p,
    { rothConversion: 491_000 },
    reservations
  );
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.rmd.status, 'known');
  assert.strictEqual(state.rmd.owner, null);
  assert.ok(Math.abs(state.rmd.required - 20_000) < 0.01);
  assert.strictEqual(state.rmd.satisfiedByFixedCash, 5_000);
  assert.strictEqual(state.rmd.byOwner.client.required, 10_000);
  assert.strictEqual(state.rmd.byOwner.client.satisfiedByFixedCash, 0);
  assert.strictEqual(state.rmd.byOwner.client.satisfiedByPlannerCash, 10_000);
  assert.strictEqual(state.rmd.byOwner.spouse.required, 10_000);
  assert.strictEqual(state.rmd.byOwner.spouse.satisfiedByFixedCash, 5_000);
  assert.strictEqual(state.rmd.byOwner.spouse.satisfiedByPlannerCash, 5_000);
  assert.strictEqual(state.limits.deferredWithdrawal.min, 15_000);
  assert.strictEqual(state.levers.deferredWithdrawal, 15_000);
  assert.strictEqual(state.limits.rothConversion.max, 491_000);
  assert.strictEqual(state.pools.traditional.remaining, 0);

  const youngerSpouse = structuredClone(p);
  youngerSpouse.household.spouse = {
    currentAge: 60, retirementAge: 60, planEndAge: 95, birthYear: 1966,
  };
  youngerSpouse.portfolio.extraAccounts[1] = createAccount('traditional_ira', {
    owner: 'spouse', balance: 100_000, valuationDate: '2025-12-31',
  });
  const spouseCashBeforeRmdAge = resolveWithdrawalPlannerAccountState(
    youngerSpouse,
    {},
    {
      traditionalTotal: 10_000,
      rmdEligibleCash: 10_000,
      traditionalByOwner: { client: 0, spouse: 10_000 },
      rmdEligibleCashByOwner: { client: 0, spouse: 10_000 },
      taxYear: 2026,
    }
  );
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.required, 10_000);
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.satisfiedByFixedCash, 0);
  assert.strictEqual(spouseCashBeforeRmdAge.limits.deferredWithdrawal.min, 10_000);
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.byOwner.client.satisfiedByPlannerCash, 10_000);
  assert.strictEqual(spouseCashBeforeRmdAge.rmd.byOwner.spouse.status, 'not-required');

  const preRmdOwnerOverdraw = structuredClone(p);
  preRmdOwnerOverdraw.household.primary = {
    currentAge: 60, retirementAge: 60, planEndAge: 95, birthYear: 1966,
  };
  preRmdOwnerOverdraw.household.spouse = {
    currentAge: 61, retirementAge: 61, planEndAge: 95, birthYear: 1965,
  };
  preRmdOwnerOverdraw.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 100_000, valuationDate: '2025-12-31',
    }),
    createAccount('traditional_ira', {
      owner: 'spouse', balance: 400_000, valuationDate: '2025-12-31',
    }),
  ];
  const impossibleClientDistribution = resolveWithdrawalPlannerAccountState(
    preRmdOwnerOverdraw,
    {},
    {
      traditionalTotal: 150_000,
      rmdEligibleCash: 150_000,
      traditionalByOwner: { client: 150_000, spouse: 0 },
      rmdEligibleCashByOwner: { client: 150_000, spouse: 0 },
      taxYear: 2026,
    }
  );
  assert.strictEqual(impossibleClientDistribution.valid, false);
  assert.strictEqual(impossibleClientDistribution.rmd.status, 'not-required');
  assert.ok(impossibleClientDistribution.issues.some(issue => (
    issue.code === 'TRADITIONAL_OWNER_POOL_EXCEEDED'
      && issue.owner === 'client'
      && issue.requested === 150_000
      && issue.available === 100_000
  )));
  assert.strictEqual(impossibleClientDistribution.limits.deferredWithdrawal.max, null);
  assert.strictEqual(impossibleClientDistribution.limits.rothConversion.max, null);
  assert.strictEqual(impossibleClientDistribution.limits.qcd.max, null);

  const unattributed = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 5_000,
    rmdEligibleCash: 5_000,
    taxYear: 2026,
  });
  assert.strictEqual(unattributed.rmd.status, 'unavailable');
  assert.strictEqual(unattributed.rmd.issue, 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE');
  assert.strictEqual(unattributed.rmd.required, null);
  assert.strictEqual(unattributed.limits.rothConversion.max, null);

  const singleTrackedOwner = structuredClone(p);
  singleTrackedOwner.portfolio.extraAccounts = [p.portfolio.extraAccounts[0]];
  const crossedSingleOwnerFacts = resolveWithdrawalPlannerAccountState(
    singleTrackedOwner,
    {},
    {
      traditionalTotal: 10_000,
      rmdEligibleCash: 10_000,
      traditionalByOwner: { client: 0, spouse: 10_000 },
      rmdEligibleCashByOwner: { client: 10_000, spouse: 0 },
      taxYear: 2026,
    }
  );
  assert.strictEqual(crossedSingleOwnerFacts.rmd.status, 'unavailable');
  assert.strictEqual(crossedSingleOwnerFacts.rmd.required, null);
  assert.strictEqual(
    crossedSingleOwnerFacts.rmd.issue,
    'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE'
  );

  const missingSpouseValuation = structuredClone(p);
  missingSpouseValuation.portfolio.extraAccounts[1] = createAccount('traditional_ira', {
    owner: 'spouse', balance: 246_000,
  });
  const missingValuation = resolveWithdrawalPlannerAccountState(
    missingSpouseValuation,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(missingValuation.rmd.status, 'unavailable');
  assert.strictEqual(missingValuation.rmd.issue, 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE');
  assert.strictEqual(missingValuation.rmd.byOwner.client.status, 'known');
  assert.strictEqual(missingValuation.rmd.byOwner.spouse.status, 'unavailable');
  assert.strictEqual(missingValuation.limits.rothConversion.max, null);

  const ownerOverdraw = resolveWithdrawalPlannerAccountState(p, {}, {
    traditionalTotal: 260_000,
    rmdEligibleCash: 0,
    traditionalByOwner: { client: 260_000, spouse: 0 },
    rmdEligibleCashByOwner: { client: 0, spouse: 0 },
    taxYear: 2026,
  });
  assert.strictEqual(ownerOverdraw.valid, false);
  assert.ok(ownerOverdraw.issues.some(issue => (
    issue.code === 'RMD_MINIMUM_EXCEEDS_OWNER_TRADITIONAL'
      && issue.owner === 'client'
  )));
  assert.strictEqual(ownerOverdraw.rmd.status, 'unavailable');
  assert.strictEqual(ownerOverdraw.rmd.required, null);
  assert.strictEqual(ownerOverdraw.limits.rothConversion.max, null);

  const retiredEmployerOwner = structuredClone(p);
  retiredEmployerOwner.portfolio.extraAccounts[0] = createAccount('401k', {
    owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
  });
  const retiredEmployerState = resolveWithdrawalPlannerAccountState(
    retiredEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(retiredEmployerState.rmd.status, 'known');
  assert.strictEqual(retiredEmployerState.rmd.byOwner.client.required, 10_000);
  assert.strictEqual(retiredEmployerState.rmd.byOwner.spouse.required, 10_000);

  const singleEmployerOwner = structuredClone(retiredEmployerOwner);
  singleEmployerOwner.meta.filingStatus = 'single';
  singleEmployerOwner.household.spouse = null;
  singleEmployerOwner.income.socialSecurity.spouse = null;
  singleEmployerOwner.portfolio.extraAccounts = [
    retiredEmployerOwner.portfolio.extraAccounts[0],
  ];
  const singleEmployerPlannerRmd = resolveWithdrawalPlannerAccountState(
    singleEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(singleEmployerPlannerRmd.rmd.status, 'known');
  assert.strictEqual(singleEmployerPlannerRmd.rmd.required, 10_000);
  assert.strictEqual(singleEmployerPlannerRmd.limits.deferredWithdrawal.min, 10_000);

  const singleEmployerWithFixedIraCash =
    resolveWithdrawalPlannerAccountState(
      singleEmployerOwner,
      {},
      {
        traditionalTotal: 10_000,
        rmdEligibleCash: 10_000,
        traditionalByOwner: { client: 10_000, spouse: 0 },
        rmdEligibleCashByOwner: { client: 10_000, spouse: 0 },
        taxYear: 2026,
      }
    );
  assert.strictEqual(singleEmployerWithFixedIraCash.rmd.status, 'unavailable');
  assert.strictEqual(singleEmployerWithFixedIraCash.rmd.required, null);
  assert.strictEqual(
    singleEmployerWithFixedIraCash.rmd.issue,
    'EMPLOYER_PLAN_RMD_CASH_ATTRIBUTION_UNAVAILABLE'
  );
  assert.strictEqual(
    singleEmployerWithFixedIraCash.limits.rothConversion.max,
    null
  );

  const workingEmployerOwner = structuredClone(retiredEmployerOwner);
  workingEmployerOwner.household.primary.retirementAge = 80;
  const workingEmployerState = resolveWithdrawalPlannerAccountState(
    workingEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(workingEmployerState.rmd.status, 'unavailable');
  assert.strictEqual(workingEmployerState.rmd.required, null);
  assert.strictEqual(
    workingEmployerState.rmd.byOwner.client.issue,
    'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE'
  );

  const mixedEmployerOwner = structuredClone(p);
  mixedEmployerOwner.portfolio.extraAccounts = [
    createAccount('traditional_ira', {
      owner: 'client', balance: 100_000, valuationDate: '2025-12-31',
    }),
    createAccount('401k', {
      owner: 'client', balance: 265_000, valuationDate: '2025-12-31',
    }),
    p.portfolio.extraAccounts[1],
  ];
  const mixedEmployerState = resolveWithdrawalPlannerAccountState(
    mixedEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(mixedEmployerState.rmd.status, 'unavailable');
  assert.strictEqual(mixedEmployerState.rmd.required, null);
  assert.strictEqual(
    mixedEmployerState.rmd.byOwner.client.issue,
    'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
  );
  assert.strictEqual(mixedEmployerState.limits.rothConversion.max, null);

  const singleMixedEmployerOwner = structuredClone(mixedEmployerOwner);
  singleMixedEmployerOwner.meta.filingStatus = 'single';
  singleMixedEmployerOwner.household.spouse = null;
  singleMixedEmployerOwner.income.socialSecurity.spouse = null;
  singleMixedEmployerOwner.portfolio.extraAccounts =
    singleMixedEmployerOwner.portfolio.extraAccounts.slice(0, 2);
  const singleMixedEmployerState = resolveWithdrawalPlannerAccountState(
    singleMixedEmployerOwner,
    {},
    { taxYear: 2026 }
  );
  assert.strictEqual(singleMixedEmployerState.rmd.status, 'unavailable');
  assert.strictEqual(singleMixedEmployerState.rmd.required, null);
  assert.strictEqual(
    singleMixedEmployerState.rmd.issue,
    'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
  );
});

test('withdrawal planner leaves an unsupported current-year RMD blank', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];

  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.rmd.status, 'unavailable');
  assert.strictEqual(state.rmd.issue, 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE');
  assert.strictEqual(state.rmd.required, null);
  assert.strictEqual(state.limits.deferredWithdrawal.max, 265_000);
  assert.strictEqual(state.limits.rothConversion.max, null);

  const approval = approveWithdrawalPlannerLeverChange(
    p,
    {},
    'rothConversion',
    1
  );
  assert.strictEqual(approval.approved, false);
  assert.strictEqual(approval.approvedValue, 0);
});

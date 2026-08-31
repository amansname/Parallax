// Engine contract: withdrawal limits and cash. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveInputs, defaultPlan, householdIncomeAtYear, resolveWithdrawalPlannerAccountState, approveWithdrawalPlannerLeverChange, buildWithdrawalPlannerCashContract } from '../../engine.js';
import { createAccount } from '../../src/household/createAccount.js';

test('withdrawal planner account limits coordinate one shared traditional pool', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 1_200_000, basisPct: 0.6 },
    traditional: { balance: 100_000 },
    roth: { balance: 750_000 },
  };
  p.portfolio.extraAccounts = [];
  const requested = {
    taxableWithdrawal: 0,
    deferredWithdrawal: 30_000,
    rothConversion: 60_000,
    rothWithdrawal: 0,
    qcd: 0,
  };

  const state = resolveWithdrawalPlannerAccountState(p, requested);
  assert.strictEqual(state.valid, true);
  assert.deepStrictEqual(state.balances, {
    taxable: 1_200_000,
    traditional: 100_000,
    roth: 750_000,
  });
  assert.strictEqual(state.limits.taxableWithdrawal.max, 1_200_000);
  assert.strictEqual(state.limits.rothWithdrawal.max, 750_000);
  assert.strictEqual(state.limits.rothConversion.max, 70_000);
  assert.strictEqual(state.limits.deferredWithdrawal.max, 40_000);
  assert.strictEqual(state.limits.qcd.max, 10_000);
  assert.deepStrictEqual(state.pools.traditional, {
    available: 100_000,
    used: 90_000,
    remaining: 10_000,
  });

  const approval = approveWithdrawalPlannerLeverChange(p, requested, 'qcd', 25_000);
  assert.strictEqual(approval.approved, true);
  assert.strictEqual(approval.clamped, true);
  assert.strictEqual(approval.requestedValue, 25_000);
  assert.strictEqual(approval.approvedValue, 10_000);
  assert.strictEqual(approval.levers.rothConversion, 60_000);
  assert.strictEqual(approval.levers.deferredWithdrawal, 30_000);
  assert.strictEqual(approval.levers.qcd, 10_000);
  assert.strictEqual(approval.state.pools.traditional.remaining, 0);
});

test('withdrawal planner account limits reserve fixed traditional distributions', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 100_000 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];

  const state = resolveWithdrawalPlannerAccountState(
    p,
    { rothConversion: 20_000 },
    { traditional: 80_000 }
  );
  assert.strictEqual(state.valid, true);
  assert.strictEqual(state.limits.rothConversion.max, 20_000);
  assert.strictEqual(state.limits.deferredWithdrawal.max, 0);
  assert.deepStrictEqual(state.reservations, {
    traditional: 80_000,
    traditionalTotal: 80_000,
    rmdEligibleCash: 0,
    taxYear: 2026,
  });
  assert.strictEqual(state.pools.traditional.remaining, 0);

  const approval = approveWithdrawalPlannerLeverChange(
    p,
    { rothConversion: 0 },
    'rothConversion',
    80_000,
    { traditional: 80_000 }
  );
  assert.strictEqual(approval.approvedValue, 20_000);
  assert.strictEqual(approval.clamped, true);
});

test('withdrawal planner does not approve a change while another shared-pool violation remains', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts.traditional.balance = 100_000;
  p.portfolio.extraAccounts = [];
  const approval = approveWithdrawalPlannerLeverChange(p, {
    deferredWithdrawal: 100_000,
    rothConversion: 100_000,
    qcd: 0,
  }, 'taxableWithdrawal', 0);
  assert.strictEqual(approval.approved, false);
  assert.strictEqual(approval.state.valid, false);
  assert.ok(approval.state.issues.some(issue => issue.code === 'TRADITIONAL_POOL_EXCEEDED'));
});

test('withdrawal planner rejects an impossible lever vector without inventing priority', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts.traditional.balance = 100_000;
  p.portfolio.extraAccounts = [];
  const state = resolveWithdrawalPlannerAccountState(p, {
    taxableWithdrawal: 0,
    deferredWithdrawal: 100_000,
    rothConversion: 100_000,
    rothWithdrawal: 0,
    qcd: 100_000,
  });
  assert.strictEqual(state.valid, false);
  assert.ok(state.issues.some(issue => issue.code === 'TRADITIONAL_POOL_EXCEEDED'));
});

test('withdrawal planner excludes tax-bucket-ineligible balances from approved limits', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('roth_ira', { owner: 'client', balance: 100_000 }),
    createAccount('hsa', { owner: 'client', balance: 500_000 }),
    createAccount('checking', { owner: 'client', balance: 250_000 }),
  ];
  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.balances.roth, 100_000);
  assert.strictEqual(state.balances.taxable, 0);
  assert.strictEqual(state.limits.rothWithdrawal.max, 100_000);
  assert.ok(state.excludedAccountIds.includes(p.portfolio.extraAccounts[1].id));
  assert.ok(state.excludedAccountIds.includes(p.portfolio.extraAccounts[2].id));
});

test('withdrawal planner excludes an account whose household tax reporting is unconfirmed', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const joint = createAccount('joint_brokerage', { balance: 100_000 });
  p.portfolio.extraAccounts = [joint];

  const state = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(state.balances.taxable, 0);
  assert.strictEqual(state.limits.taxableWithdrawal.max, 0);
  assert.ok(state.excludedAccountIds.includes(joint.id));
  assert.ok(state.sourceIssues.includes(`TAX_REPORTING_INCLUSION_UNKNOWN:${joint.id}`));
});

test('stale spouse-owned facts are not reassigned to a single client', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.spouse = null;
  p.income.socialSecurity.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const spouseAccount = createAccount('traditional_ira', {
    owner: 'spouse', balance: 100_000,
  });
  p.portfolio.extraAccounts = [spouseAccount];
  const accountState = resolveWithdrawalPlannerAccountState(p, {});
  assert.strictEqual(accountState.balances.traditional, 0);
  assert.strictEqual(accountState.limits.deferredWithdrawal.max, 0);
  assert.ok(accountState.excludedAccountIds.includes(spouseAccount.id));
  assert.ok(accountState.sourceIssues.includes(`ACCOUNT_OWNER_UNAVAILABLE:${spouseAccount.id}`));
  assert.throws(
    () => resolveInputs(p, {}),
    error => error?.code === 'ACCOUNT_OWNER_UNAVAILABLE'
  );

  p.portfolio.extraAccounts = [];
  p.income.other = [{
    typeId: 'rental', owner: 'spouse', amount: 12_000,
    startAge: p.household.primary.currentAge,
    endAge: p.household.primary.planEndAge,
  }];
  const resolved = resolveInputs(p, {});
  const income = householdIncomeAtYear(resolved, 0);
  assert.strictEqual(income.otherIncome, null);
  assert.strictEqual(income.grossOtherIncome, null);
  assert.strictEqual(income.available, true);
  assert.ok(income.incomeIssues.includes('INCOME_OWNER_UNAVAILABLE:spouse:rental'));
});

test('withdrawal planner does not approve an ambiguous legacy plus typed account pool', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 100_000, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('brokerage_taxable', { owner: 'client', balance: 100_000 }),
  ];
  const state = resolveWithdrawalPlannerAccountState(p, { taxableWithdrawal: 1 });
  assert.strictEqual(state.limits.taxableWithdrawal.max, null);
  assert.strictEqual(state.valid, false);
  assert.ok(state.issues.some(issue => issue.code === 'ACCOUNT_POOL_AMBIGUOUS'));
});

test('withdrawal planner net cash uses incremental tax and excludes conversions and QCDs from cash', () => {
  const cash = buildWithdrawalPlannerCashContract({
    taxableWithdrawal: 5_000,
    deferredWithdrawal: 20_000,
    rothConversion: 50_000,
    rothWithdrawal: 10_000,
    qcd: 15_000,
  }, 12_000);
  assert.deepStrictEqual(cash, {
    grossWithdrawalCash: 35_000,
    incrementalModeledFederalIncomeTax: 12_000,
    netAfterIncrementalModeledFederalIncomeTax: 23_000,
  });
});

test('withdrawal planner preserves gross cash but leaves net cash blank when incremental tax is unavailable', () => {
  const cash = buildWithdrawalPlannerCashContract({
    taxableWithdrawal: 5_000,
    deferredWithdrawal: 20_000,
    rothConversion: 50_000,
    rothWithdrawal: 10_000,
    qcd: 0,
  }, null);
  assert.deepStrictEqual(cash, {
    grossWithdrawalCash: 35_000,
    incrementalModeledFederalIncomeTax: null,
    netAfterIncrementalModeledFederalIncomeTax: null,
  });
});

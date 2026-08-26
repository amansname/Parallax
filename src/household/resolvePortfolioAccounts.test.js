import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_SCHEMA_VERSION,
  UNSUPPORTED_TYPE_ID,
  getAccountTypeById,
  getWizardAccountTypes,
} from './accountTypes.js';
import { createAccount } from './createAccount.js';
import {
  ASSET_KEYS,
  resolveCashOnlyAllocation,
  snapshotLegacyRiskProfileAllocation,
  snapshotPresetAllocation,
} from './investmentAllocation.js';
import { LEGACY_BASE_ACCOUNT_IDS } from './migrateAccounts.js';
import { resolvePortfolioAccounts } from './resolvePortfolioAccounts.js';
import { investableTotal } from '../../ui/household.js';

function planWithBase(taxable = 0, traditional = 0, roth = 0){
  return {
    meta: { householdId: 'hh1', name: 'Test Household' },
    portfolio: {
      accounts: {
        taxable: { balance: taxable, basisPct: 0.6 },
        traditional: { balance: traditional },
        roth: { balance: roth },
      },
      extraAccounts: [],
    },
  };
}

function currentPlanWithBase(taxable = 0, traditional = 0, roth = 0){
  const plan = planWithBase(taxable, traditional, roth);
  plan.meta.accountSchemaVersion = ACCOUNT_SCHEMA_VERSION;
  const allocation = snapshotLegacyRiskProfileAllocation(3);
  for(const bucket of ['taxable', 'traditional', 'roth']){
    plan.portfolio.accounts[bucket].id = LEGACY_BASE_ACCOUNT_IDS[bucket];
    plan.portfolio.accounts[bucket].investmentAllocation = structuredClone(allocation);
  }
  return plan;
}

function account(typeId, id, balance, options = {}){
  return { ...createAccount(typeId, { balance, valuationDate: options.valuationDate ?? null }), id, ...options };
}

test('approved account taxonomy maps to the three current Tax Buckets groups', () => {
  const expected = {
    taxable: ['checking', 'savings', 'money_market', 'certificate_of_deposit', 'brokerage_taxable', 'joint_brokerage', 'trust_brokerage', 'tod_brokerage'],
    traditional: ['traditional_ira', 'rollover_ira', 'sep_ira', 'simple_ira', 'inherited_traditional_ira', '401k', '403b', '457', '401a', 'tsp', 'solo_401k', 'qualified_plan'],
    roth: ['roth_ira', 'inherited_roth_ira', 'roth_401k', 'roth_403b', 'roth_457', 'roth_tsp'],
  };
  for(const [group, typeIds] of Object.entries(expected)){
    for(const typeId of typeIds){
      assert.equal(getAccountTypeById(typeId)?.taxBucketGroup, group, `${typeId} must map to ${group}`);
    }
  }
  assert.equal(getAccountTypeById('hsa')?.taxBucketGroup, null);
  assert.equal(getAccountTypeById('legacy_529')?.taxBucketGroup, null);
  assert.equal(getAccountTypeById('inherited_traditional_ira')?.strategyRulesPending, true);
  assert.equal(getAccountTypeById('inherited_roth_ira')?.strategyRulesPending, true);
  assert.deepEqual(getWizardAccountTypes().map(type => type.typeId), [
    'checking', 'savings', 'money_market', 'certificate_of_deposit',
    'brokerage_taxable', 'joint_brokerage', 'tod_brokerage',
    'traditional_ira', 'rollover_ira', 'sep_ira', 'simple_ira',
    '401k', '403b', '457', '401a', 'tsp', 'solo_401k',
    'roth_ira', 'roth_401k', 'roth_403b', 'roth_457', 'roth_tsp', 'hsa',
  ]);
});

test('one fold preserves strategy-ready engine totals while limiting Tax Buckets to approved types', () => {
  const plan = planWithBase(100, 50, 25);
  plan.portfolio.extraAccounts = [
    account('brokerage_taxable', 'broker', 100),
    account('checking', 'checking', 10),
    account('inherited_traditional_ira', 'inherited-trad', 40),
    account('roth_403b', 'roth-403b', 30),
    account('hsa', 'hsa', 20),
    account('legacy_529', '529', 5),
    {
      id: 'unsupported', typeId: UNSUPPORTED_TYPE_ID, type: 'Other account', owner: 'client',
      bucket: 'taxable', balance: 15, valuationDate: null, basis: null,
    },
  ];

  const fold = resolvePortfolioAccounts(plan);
  assert.equal(fold.totalBalance, 395);
  assert.equal(fold.engineBalance, 355);
  assert.deepEqual(Object.fromEntries(Object.entries(fold.engineBuckets).map(([key, value]) => [key, value.balance])), {
    taxable: 225,
    traditional: 50,
    roth: 80,
  });
  assert.deepEqual(Object.fromEntries(Object.entries(fold.taxBuckets).map(([key, value]) => [key, value.balance])), {
    taxable: 210,
    traditional: 90,
    roth: 55,
  });
  assert.equal(fold.includedBalance, 355);
  assert.equal(fold.excludedBalance, 40);
  assert.equal(fold.pendingStrategyBalance, 40);
  assert.deepEqual(fold.pendingStrategyAccounts.map(item => item.id), ['inherited-trad']);
  assert.deepEqual(fold.excludedAccounts.map(item => item.id), ['hsa', '529', 'unsupported']);
  assert.deepEqual(fold.issues, ['LEGACY_TYPED_OVERLAP', 'ACCOUNT_UNSUPPORTED:unsupported']);
  assert.equal(investableTotal(plan), fold.totalBalance);
});

test('inherited accounts remain in current totals but are tagged rules-pending', () => {
  const plan = planWithBase();
  plan.portfolio.extraAccounts = [
    account('inherited_traditional_ira', 'it', 125000),
    account('inherited_roth_ira', 'ir', 75000),
  ];
  const fold = resolvePortfolioAccounts(plan);
  assert.equal(fold.taxBuckets.traditional.balance, 125000);
  assert.equal(fold.taxBuckets.roth.balance, 75000);
  assert.equal(fold.engineBuckets.traditional.balance, 0);
  assert.equal(fold.engineBuckets.roth.balance, 0);
  assert.equal(fold.engineBalance, 0);
  assert.equal(fold.pendingStrategyBalance, 200000);
  assert.deepEqual(fold.pendingStrategyAccounts.map(item => item.id), ['it', 'ir']);
});

test('bucket conflicts and invalid classifications are never silently reassigned', () => {
  const plan = planWithBase();
  plan.portfolio.extraAccounts = [
    { ...account('roth_ira', 'conflict', 100), bucket: 'taxable' },
    {
      id: 'invalid', typeId: UNSUPPORTED_TYPE_ID, type: 'Mystery', owner: 'client',
      bucket: null, balance: 50, valuationDate: null, basis: null,
    },
  ];
  const fold = resolvePortfolioAccounts(plan);
  assert.equal(fold.engineBuckets.taxable.balance, 100);
  assert.equal(fold.taxBuckets.taxable.balance, 0);
  assert.equal(fold.unclassifiedBalance, 50);
  assert.equal(fold.includedBalance, 0);
  assert.deepEqual(fold.issues, [
    'ACCOUNT_BUCKET_CONFLICT:conflict',
    'ACCOUNT_INVALID_CLASSIFICATION:invalid',
  ]);
});

test('fold is deterministic, frozen, and does not mutate its source plan', () => {
  const plan = planWithBase();
  plan.portfolio.extraAccounts = [account('savings', 'bank', 1234, { valuationDate: '2026-07-12' })];
  const before = structuredClone(plan);
  const first = resolvePortfolioAccounts(plan);
  const second = resolvePortfolioAccounts(plan);
  assert.deepEqual(first, second);
  assert.deepEqual(plan, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.accounts), true);
  assert.equal(Object.isFrozen(first.accounts[0]), true);
  assert.throws(() => { first.taxBuckets.taxable.balance = 0; }, TypeError);
});

test('malformed balances fail closed while bare basisPct is not basis evidence', () => {
  for(const balance of ['100', null, -1, NaN, Infinity]){
    const plan = planWithBase();
    plan.portfolio.extraAccounts = [{ bucket: 'taxable', balance }];
    assert.throws(() => resolvePortfolioAccounts(plan), /finite nonnegative number/);
  }
  const plan = planWithBase(100);
  plan.portfolio.accounts.taxable.basisPct = null;
  const resolved = resolvePortfolioAccounts(plan);
  const taxable = resolved.accounts.find(account => account.id === 'base-taxable');
  assert.equal(taxable.basis.amount, 50);
  assert.equal(taxable.basis.method, 'assumed-50-50');
});

test('fold exposes allocation-bearing accounts and a balance-weighted household roll-up', () => {
  const plan = planWithBase();
  const balanced = createAccount('brokerage_taxable', {
    balance: 300,
    investmentAllocation: snapshotPresetAllocation('balanced'),
  });
  balanced.id = 'balanced';
  const cash = createAccount('savings', { balance: 100 });
  cash.id = 'cash';
  plan.portfolio.extraAccounts = [balanced, cash];

  const fold = resolvePortfolioAccounts(plan);
  assert.deepEqual(fold.allocationAccounts.map(account => account.id), ['balanced', 'cash']);
  assert.equal(fold.accounts.find(account => account.id === 'balanced').investmentAllocationEligible, true);
  assert.equal(fold.accounts.find(account => account.id === 'cash').investmentAllocationEligible, false);
  assert.equal(fold.householdAllocation.totalBalance, 400);
  assert.deepEqual(fold.householdAllocation.accountIds, ['balanced', 'cash']);
  const balancedWeights = snapshotPresetAllocation('balanced').weights;
  const cashWeights = resolveCashOnlyAllocation().weights;
  for(const key of ASSET_KEYS){
    assert.ok(Math.abs(
      fold.householdAllocation.weights[key]
      - ((balancedWeights[key] * 300 + cashWeights[key] * 100) / 400)
    ) < 1e-12, key);
  }
});

test('current-schema resolver fails before including positive balances with missing or invalid allocation', () => {
  const missingBase = currentPlanWithBase(100);
  delete missingBase.portfolio.accounts.taxable.investmentAllocation;
  assert.throws(
    () => resolvePortfolioAccounts(missingBase),
    /portfolio\.accounts\.taxable\.investmentAllocation is required/i,
  );

  const missingEligible = currentPlanWithBase();
  const eligible = createAccount('brokerage_taxable', { balance: 100 });
  delete eligible.investmentAllocation;
  missingEligible.portfolio.extraAccounts = [eligible];
  assert.throws(
    () => resolvePortfolioAccounts(missingEligible),
    /portfolio\.extraAccounts\.0\.investmentAllocation is required/i,
  );

  const mismatchedPreset = currentPlanWithBase();
  const malformed = createAccount('roth_ira', { balance: 100 });
  malformed.investmentAllocation = structuredClone(malformed.investmentAllocation);
  malformed.investmentAllocation.weights.usLarge += 0.01;
  malformed.investmentAllocation.weights.cash -= 0.01;
  mismatchedPreset.portfolio.extraAccounts = [malformed];
  assert.throws(
    () => resolvePortfolioAccounts(mismatchedPreset),
    /do not match their provenance/i,
  );

  const missingUnsupported = currentPlanWithBase();
  missingUnsupported.portfolio.extraAccounts = [{
    id: 'unsupported',
    typeId: UNSUPPORTED_TYPE_ID,
    type: 'Mystery account',
    owner: 'client',
    bucket: 'taxable',
    balance: 100,
    valuationDate: null,
    basis: null,
    investmentAllocation: null,
  }];
  assert.throws(
    () => resolvePortfolioAccounts(missingUnsupported),
    /portfolio\.extraAccounts\.0\.investmentAllocation is required/i,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs } from '../../engine.js';
import { createAccount } from '../household/createAccount.js';
import { resolveTaxableStartingBasis } from '../household/resolveTaxableStartingBasis.js';
import {
  buildRetirementEntryPlan,
  deriveExactRetirementEntryAccounts,
  deriveRetirementEntryAccounts,
} from './buildRetirementEntryPlan.js';

function account(typeId, id, balance, basisAmount = null, owner = 'client'){
  const result = createAccount(typeId, { balance, owner });
  result.id = id;
  if(basisAmount !== null){
    result.basis = { ...result.basis, amount: basisAmount };
  }
  return result;
}

function accountStatesFor(plan, changes = {}){
  return resolveInputs(plan, {}).projectionAccounts.map(state => ({ ...state, ...changes[state.id] }));
}

function bucketView({ taxable, traditional, roth }){
  return { taxable, traditional, roth };
}

test('retirement entry preserves the projected bucket mix and taxable basis', () => {
  const plan = structuredClone(defaultPlan);
  plan.household.primary = { currentAge: 60, retirementAge: 65, planEndAge: 95, birthYear: 1966 };
  plan.household.spouse = { currentAge: 58, retirementAge: 67, planEndAge: 95, birthYear: 1968 };
  plan.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  plan.portfolio.extraAccounts = [
    account('brokerage_taxable', 'brokerage', 100, 60),
    account('traditional_ira', 'ira', 200),
    account('roth_401k', 'roth-401k', 100),
    account('inherited_traditional_ira', 'inherited', 75),
  ];
  const before = structuredClone(plan);
  const analysis = {
    envelope: Array.from({ length: 6 }, (_, index) => (
      index === 5 ? { p50: 1400 } : { p50: 400 }
    )),
    paths: {
      p50: {
        rows: Array.from({ length: 5 }, (_, index) => (
          index === 4
            ? {
                accountBalances: { taxable: 150, traditional: 500, roth: 50 },
                taxableEndingBasis: 125,
                traditionalEndingBalancesByOwner: {
                  client: 500, spouse: 0, unattributed: 0,
                },
                accountStates: accountStatesFor(plan, {
                  brokerage: { balance: 150, basis: 125 }, ira: { balance: 500 }, 'roth-401k': { balance: 50 },
                }),
              }
            : {
                accountBalances: { taxable: 100, traditional: 200, roth: 100 },
                taxableEndingBasis: 60,
                traditionalEndingBalancesByOwner: {
                  client: 200, spouse: 0, unattributed: 0,
                },
              }
        )),
      },
    },
  };
  const fallbackAccounts = {
    taxable: { balance: 100, basis: 60 },
    traditional: {
      balance: 200,
      byOwner: { client: 200, spouse: 0, unattributed: 0 },
    },
    roth: { balance: 100 },
  };

  const exactEntryAccounts = deriveExactRetirementEntryAccounts(
    analysis,
    5,
    fallbackAccounts
  );
  const entryAccounts = deriveRetirementEntryAccounts(
    analysis,
    5,
    fallbackAccounts
  );
  const result = buildRetirementEntryPlan(plan, {
    entryAccounts,
    currentAge: 60,
    retirementAge: 65,
  });
  const inputs = resolveInputs(result, {});
  const resolved = inputs.accounts;
  const startingBasis = resolveTaxableStartingBasis(result);

  assert.deepEqual(plan, before, 'the source Household plan must remain unchanged');
  assert.deepEqual(bucketView(exactEntryAccounts), {
    taxable: { balance: 150, basis: 125 },
    traditional: {
      balance: 500,
      byOwner: { client: 500, spouse: 0, unattributed: 0 },
    },
    roth: { balance: 50 },
  }, 'Cash Flow must preserve the exact displayed accumulation endpoint');
  assert.deepEqual(bucketView(entryAccounts), {
    taxable: { balance: 300, basis: 250 },
    traditional: { balance: 1000, byOwner: { client: 1000, spouse: 0, unattributed: 0 } },
    roth: { balance: 100 },
  });
  // The resolved traditional sleeve now also carries per-owner buckets, so
  // compare the balance contract rather than whole-object identity.
  assert.deepEqual({
    taxable: resolved.taxable,
    traditional: { balance: resolved.traditional.balance, byOwner: resolved.traditional.byOwner },
    roth: resolved.roth,
  }, bucketView(entryAccounts),
  'the historical clone must start from the modeled retirement engine state');
  assert.equal(startingBasis.basisOverride, 250);
  assert.equal(startingBasis.appliedBasis, 250);
  assert.equal(startingBasis.appliedMode, 'calculated-carried-forward');
  assert.deepEqual(
    result.portfolio.extraAccounts.map(({ id, balance }) => ({ id, balance })),
    [
      { id: 'brokerage', balance: 300 },
      { id: 'ira', balance: 1000 },
      { id: 'roth-401k', balance: 100 },
      { id: 'inherited', balance: 75 },
    ]
  );
  assert.equal(result.portfolio.extraAccounts[0].basis.amount, 60, 'recorded basis is not replaced by calculated basis');
  assert.equal(result.portfolio.accounts.traditional.balance, 0);
  assert.equal(inputs.rmdContract.owner, 'client');
  assert.equal(inputs.rmdContract.available, true);
  assert.equal(result.meta.planningAsOfYear, 2031);
  assert.equal(result.household.primary.currentAge, 65);
  assert.equal(result.household.primary.retirementAge, 65);
  assert.equal(result.household.spouse.currentAge, 63);
  assert.equal(result.household.spouse.retirementAge, 67);
});

test('exact Traditional ownership survives the retirement-entry handoff', () => {
  const plan = structuredClone(defaultPlan);
  plan.household.primary = {
    currentAge: 56, retirementAge: 57, planEndAge: 95, birthYear: 1970,
  };
  plan.household.spouse = {
    currentAge: 53, retirementAge: 54, planEndAge: 95, birthYear: 1973,
  };
  plan.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  plan.portfolio.extraAccounts = [
    account('traditional_ira', 'client-ira', 3_000_000, null, 'client'),
    account('traditional_ira', 'spouse-ira', 2_000_000, null, 'spouse'),
  ];
  const entryAccounts = {
    taxable: { balance: 0, basis: 0 },
    traditional: {
      balance: 5_012_000,
      byOwner: { client: 3_012_000, spouse: 2_000_000, unattributed: 0 },
    },
    roth: { balance: 0 },
    accountStates: accountStatesFor(plan, { 'client-ira': { balance: 3_012_000 } }),
  };

  const retirementPlan = buildRetirementEntryPlan(plan, {
    entryAccounts,
    currentAge: 56,
    retirementAge: 57,
  });
  const resolved = resolveInputs(retirementPlan, {}).accounts.traditional;

  assert.deepEqual(resolved.byOwner, entryAccounts.traditional.byOwner);
  assert.equal(resolved.balance, entryAccounts.traditional.balance);
  assert.equal(
    Object.values(resolved.byOwner).reduce((sum, value) => sum + value, 0),
    resolved.balance
  );
  assert.deepEqual(
    retirementPlan.portfolio.extraAccounts.map(({ id, balance }) => ({ id, balance })),
    [
      { id: 'client-ira', balance: 3_012_000 },
      { id: 'spouse-ira', balance: 2_000_000 },
    ]
  );
});

test('exact retirement entry fails closed when owner reporting is missing', () => {
  const plan = structuredClone(defaultPlan);
  const fallbackAccounts = resolveInputs(plan, {}).accounts;
  const analysis = {
    paths: { p50: { rows: [{
      accountBalances: { taxable: 0, traditional: 100, roth: 0 },
      taxableEndingBasis: 0,
      accountStates: accountStatesFor(plan, {
        'base-taxable': { balance: 0, basis: 0 }, 'base-traditional': { balance: 100 }, 'base-roth': { balance: 0 },
      }),
    }] } },
  };

  assert.throws(
    () => deriveExactRetirementEntryAccounts(analysis, 1, fallbackAccounts),
    /traditional\.byOwner\.client does not reconcile/
  );
});

test('exact retirement entry fails closed when an owner has no modeled source', () => {
  const plan = structuredClone(defaultPlan);
  plan.household.spouse = {
    currentAge: 63, retirementAge: 65, planEndAge: 95, birthYear: 1963,
  };
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.extraAccounts = [
    account('traditional_ira', 'client-ira', 100, null, 'client'),
  ];
  const entryAccounts = {
    taxable: { balance: 0, basis: 0 },
    traditional: {
      balance: 100,
      byOwner: { client: 0, spouse: 100, unattributed: 0 },
    },
    roth: { balance: 0 },
    accountStates: accountStatesFor(plan, {
      'base-taxable': { balance: 0, basis: 0 }, 'base-roth': { balance: 0 },
    }),
  };

  assert.throws(
    () => buildRetirementEntryPlan(plan, {
      entryAccounts,
      currentAge: 65,
      retirementAge: 65,
    }),
    /traditional\.byOwner\.client does not reconcile/
  );
});

test('exact retirement entry uses a real zero-opening owner account for contributions', () => {
  const plan = structuredClone(defaultPlan);
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.extraAccounts = [
    account('traditional_ira', 'client-zero-ira', 0, null, 'client'),
  ];
  const entryAccounts = {
    taxable: { balance: 0, basis: 0 },
    traditional: {
      balance: 12_000,
      byOwner: { client: 12_000, spouse: 0, unattributed: 0 },
    },
    roth: { balance: 0 },
    accountStates: accountStatesFor(plan, {
      'base-taxable': { balance: 0, basis: 0 }, 'base-roth': { balance: 0 },
      'client-zero-ira': { balance: 12_000 },
    }),
  };

  const retirementPlan = buildRetirementEntryPlan(plan, {
    entryAccounts,
    currentAge: plan.household.primary.currentAge,
    retirementAge: plan.household.primary.currentAge,
  });
  const resolved = resolveInputs(retirementPlan, {}).accounts.traditional;

  assert.equal(retirementPlan.portfolio.extraAccounts[0].balance, 12_000);
  assert.deepEqual(resolved.byOwner, entryAccounts.traditional.byOwner);
  assert.equal(resolved.balance, 12_000);
});

test('retirement entry reuses an eligible spouse IRA after an exact survivor rollover', () => {
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.household.primary = {
    currentAge: 72, retirementAge: 75, planEndAge: 80, birthYear: 1954,
  };
  plan.household.spouse = {
    currentAge: 60, retirementAge: 60, planEndAge: 60, birthYear: 1966,
  };
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.extraAccounts = [
    account('traditional_ira', 'spouse-only-ira', 265_000, null, 'spouse'),
  ];
  const before = structuredClone(plan);
  const entryAccounts = {
    taxable: { balance: 0, basis: 0 },
    traditional: {
      balance: 250_000,
      byOwner: { client: 250_000, spouse: 0, unattributed: 0 },
    },
    roth: { balance: 0 },
    accountStates: accountStatesFor(plan, {
      'base-taxable': { balance: 0, basis: 0 }, 'base-roth': { balance: 0 },
      'spouse-only-ira': { owner: 'client', balance: 250_000 },
    }),
  };

  const retirementPlan = buildRetirementEntryPlan(plan, {
    entryAccounts,
    currentAge: 72,
    retirementAge: 75,
  });
  const resolved = resolveInputs(retirementPlan, {}).accounts.traditional;

  assert.deepEqual(plan, before, 'the persisted Household plan stays untouched');
  assert.equal(retirementPlan.household.spouse, null);
  assert.equal(retirementPlan.meta.filingStatus, 'single');
  assert.equal(retirementPlan.portfolio.extraAccounts[0].owner, 'client');
  assert.equal(retirementPlan.portfolio.extraAccounts[0].balance, 250_000);
  assert.deepEqual(resolved.byOwner, entryAccounts.traditional.byOwner);
  assert.equal(resolved.balance, entryAccounts.traditional.balance);
});

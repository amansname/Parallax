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
  if(basisAmount !== null) result.basis = { ...result.basis, amount: basisAmount };
  return result;
}

function statesWith(plan, updates = {}){
  return resolveInputs(plan, {}).projectionAccounts.map(state => ({
    ...state,
    ...(updates[state.id] ?? {}),
  }));
}

function aggregateView(entry){
  return {
    taxable: entry.taxable,
    traditional: entry.traditional,
    roth: entry.roth,
  };
}

test('retirement entry preserves exact account identity, allocation, balance, owner, and taxable basis', () => {
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
  const fallback = resolveInputs(plan, {});
  const retirementStates = statesWith(plan, {
    brokerage: { balance: 150, basis: 125 },
    ira: { balance: 500 },
    'roth-401k': { balance: 50 },
  });
  const analysis = {
    envelope: Array.from({ length: 6 }, (_, index) => (
      index === 5 ? { p50: 1400 } : { p50: 400 }
    )),
    paths: {
      p50: {
        rows: Array.from({ length: 5 }, (_, index) => (
          index === 4
            ? {
                accountStates: retirementStates,
                accountBalances: { taxable: 150, traditional: 500, roth: 50 },
                taxableEndingBasis: 125,
                traditionalEndingBalancesByOwner: {
                  client: 500, spouse: 0, unattributed: 0,
                },
              }
            : {}
        )),
      },
    },
  };

  const exactEntry = deriveExactRetirementEntryAccounts(
    analysis,
    5,
    fallback.accounts,
    fallback.projectionAccounts,
  );
  const entry = deriveRetirementEntryAccounts(
    analysis,
    5,
    fallback.accounts,
    fallback.projectionAccounts,
  );
  const result = buildRetirementEntryPlan(plan, {
    entryAccounts: entry,
    currentAge: 60,
    retirementAge: 65,
  });
  const inputs = resolveInputs(result, {});
  const startingBasis = resolveTaxableStartingBasis(result);

  assert.deepEqual(plan, before, 'the source Household plan must remain unchanged');
  assert.deepEqual(aggregateView(exactEntry), {
    taxable: { balance: 150, basis: 125 },
    traditional: {
      balance: 500,
      byOwner: { client: 500, spouse: 0, unattributed: 0 },
    },
    roth: { balance: 50 },
  });
  assert.deepEqual(aggregateView(entry), {
    taxable: { balance: 300, basis: 250 },
    traditional: {
      balance: 1000,
      byOwner: { client: 1000, spouse: 0, unattributed: 0 },
    },
    roth: { balance: 100 },
  });
  assert.deepEqual(
    Object.fromEntries(inputs.projectionAccounts.map(({ id, balance }) => [id, balance])),
    Object.fromEntries(entry.accountStates.map(({ id, balance }) => [id, balance])),
  );
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
    ],
  );
  assert.equal(inputs.rmdContract.owner, 'client');
  assert.equal(inputs.rmdContract.available, true);
  assert.equal(result.meta.planningAsOfYear, 2031);
  assert.equal(result.household.primary.currentAge, 65);
  assert.equal(result.household.spouse.currentAge, 63);
});

test('exact Traditional account balances and ownership survive the handoff', () => {
  const plan = structuredClone(defaultPlan);
  plan.household.primary = {
    currentAge: 56, retirementAge: 57, planEndAge: 95, birthYear: 1970,
  };
  plan.household.spouse = {
    currentAge: 53, retirementAge: 54, planEndAge: 95, birthYear: 1973,
  };
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.extraAccounts = [
    account('traditional_ira', 'client-ira', 3_000_000, null, 'client'),
    account('traditional_ira', 'spouse-ira', 2_000_000, null, 'spouse'),
  ];
  const entryAccounts = {
    accountStates: statesWith(plan, {
      'client-ira': { balance: 3_012_000, owner: 'client' },
      'spouse-ira': { balance: 2_000_000, owner: 'spouse' },
    }),
  };

  const retirementPlan = buildRetirementEntryPlan(plan, {
    entryAccounts,
    currentAge: 56,
    retirementAge: 57,
  });
  const resolved = resolveInputs(retirementPlan, {}).accounts.traditional;

  assert.deepEqual(resolved.byOwner, {
    client: 3_012_000, spouse: 2_000_000, unattributed: 0,
  });
  assert.equal(resolved.balance, 5_012_000);
  assert.deepEqual(
    retirementPlan.portfolio.extraAccounts.map(({ id, balance }) => ({ id, balance })),
    [
      { id: 'client-ira', balance: 3_012_000 },
      { id: 'spouse-ira', balance: 2_000_000 },
    ],
  );
});

test('exact retirement entry fails closed without engine-owned account state', () => {
  const plan = structuredClone(defaultPlan);
  const fallback = resolveInputs(plan, {});
  const analysis = { paths: { p50: { rows: [{
    accountBalances: { taxable: 0, traditional: 100, roth: 0 },
    taxableEndingBasis: 0,
  }] } } };

  assert.throws(
    () => deriveExactRetirementEntryAccounts(
      analysis,
      1,
      fallback.accounts,
      fallback.projectionAccounts,
    ),
    /projection account states are required/,
  );
});

test('retirement entry fails closed when account identity has no modeled source', () => {
  const plan = structuredClone(defaultPlan);
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.extraAccounts = [
    account('traditional_ira', 'client-ira', 100, null, 'client'),
  ];
  const accountStates = statesWith(plan);
  accountStates.push({
    ...accountStates.find(state => state.id === 'client-ira'),
    id: 'unknown-spouse-ira',
    owner: 'spouse',
  });

  assert.throws(
    () => buildRetirementEntryPlan(plan, {
      entryAccounts: { accountStates },
      currentAge: 65,
      retirementAge: 65,
    }),
    /does not match the modeled account ledger/,
  );
});

test('exact retirement entry uses a real zero-opening account that received contributions', () => {
  const plan = structuredClone(defaultPlan);
  plan.portfolio.accounts.traditional.balance = 0;
  plan.portfolio.extraAccounts = [
    account('traditional_ira', 'client-zero-ira', 0, null, 'client'),
  ];
  const entryAccounts = {
    accountStates: statesWith(plan, {
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
  assert.deepEqual(resolved.byOwner, { client: 12_000, spouse: 0, unattributed: 0 });
});

test('retirement entry reuses the exact spouse IRA identity after survivor rollover', () => {
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
    accountStates: statesWith(plan, {
      'spouse-only-ira': { balance: 250_000, owner: 'client' },
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
  assert.deepEqual(resolved.byOwner, { client: 250_000, spouse: 0, unattributed: 0 });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs } from '../../engine.js';
import { createAccount } from '../household/createAccount.js';
import {
  buildRetirementEntryPlan,
  deriveRetirementEntryAccounts,
} from './buildRetirementEntryPlan.js';

function account(typeId, id, balance, basisAmount = null){
  const result = createAccount(typeId, { balance });
  result.id = id;
  if(basisAmount !== null){
    result.basis = { ...result.basis, amount: basisAmount };
  }
  return result;
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
              }
            : {
                accountBalances: { taxable: 100, traditional: 200, roth: 100 },
                taxableEndingBasis: 60,
              }
        )),
      },
    },
  };
  const fallbackAccounts = {
    taxable: { balance: 100, basis: 60 },
    traditional: { balance: 200 },
    roth: { balance: 100 },
  };

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

  assert.deepEqual(plan, before, 'the source Household plan must remain unchanged');
  assert.deepEqual(entryAccounts, {
    taxable: { balance: 300, basis: 250 },
    traditional: { balance: 1000 },
    roth: { balance: 100 },
  });
  assert.deepEqual(resolved, entryAccounts,
    'the historical clone must start from the modeled retirement engine state');
  assert.deepEqual(
    result.portfolio.extraAccounts.map(({ id, balance }) => ({ id, balance })),
    [
      { id: 'brokerage', balance: 0 },
      { id: 'ira', balance: 1000 },
      { id: 'roth-401k', balance: 0 },
      { id: 'inherited', balance: 75 },
    ]
  );
  assert.equal(result.portfolio.extraAccounts[0].basis.amount, 0);
  assert.equal(result.portfolio.accounts.traditional.balance, 0);
  assert.equal(inputs.rmdContract.owner, 'client');
  assert.equal(inputs.rmdContract.available, true);
  assert.equal(result.meta.planningAsOfYear, 2031);
  assert.equal(result.household.primary.currentAge, 65);
  assert.equal(result.household.primary.retirementAge, 65);
  assert.equal(result.household.spouse.currentAge, 63);
  assert.equal(result.household.spouse.retirementAge, 67);
});

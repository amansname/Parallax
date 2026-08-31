// Engine contract: historical allocation. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { RETURN_DATA, runHistoricalPath, runSinglePath, resolveInputs } from '../../engine.js';
import { createAccount } from '../../src/household/createAccount.js';
import { ASSET_KEYS as CANONICAL_ASSET_KEYS, snapshotPresetAllocation, withCustomAssetWeights } from '../../src/household/investmentAllocation.js';
import { currentAllocationPlan, typedInvestmentAccount } from './fixtures.js';

function oneAssetAllocation(assetKey){
  const weights = Object.fromEntries(
    CANONICAL_ASSET_KEYS.map(key => [key, key === assetKey ? 1 : 0]),
  );
  return withCustomAssetWeights(snapshotPresetAllocation('balanced'), weights);
}

test('historical playback uses one eight-class row with each account saved allocation', () => {
  const p = currentAllocationPlan();
  p.portfolio.accounts.taxable.balance = 0;
  p.portfolio.accounts.traditional.balance = 0;
  p.portfolio.accounts.roth.balance = 0;
  p.portfolio.extraAccounts = [
    typedInvestmentAccount('brokerage_taxable', 'custom-taxable', 2000000, oneAssetAllocation('usLarge')),
    typedInvestmentAccount('traditional_ira', 'custom-traditional', 2000000, oneAssetAllocation('usBonds')),
    typedInvestmentAccount('roth_ira', 'custom-roth', 1000000, oneAssetAllocation('cash')),
  ];
  const result = runHistoricalPath(p, 2024, 'taxable-first');
  const first = result.rows[0];
  const source = RETURN_DATA.find(row => row.y === 2024);

  assert.strictEqual(first.source, 2024);
  assert.strictEqual(first.accountReturns['custom-taxable'].sourceYear, 2024);
  assert.strictEqual(first.accountReturns['custom-traditional'].sourceYear, 2024);
  assert.strictEqual(first.accountReturns['custom-roth'].sourceYear, 2024);
  assert.strictEqual(first.accountReturns['custom-taxable'].baseRealReturn, source.usLarge);
  assert.strictEqual(first.accountReturns['custom-traditional'].baseRealReturn, source.usBonds);
  assert.strictEqual(first.accountReturns['custom-roth'].baseRealReturn, source.cash);
  assert.ok(Math.abs(first.returnDollars - Object.values(first.accountReturns)
    .reduce((sum, accountReturn) => sum + accountReturn.returnDollars, 0)) < 1e-9);
});

test('1973 historical playback redistributes the Growth preset only within its unavailable sleeve', () => {
  const p = currentAllocationPlan();
  p.portfolio.accounts.taxable.balance = 0;
  p.portfolio.accounts.traditional.balance = 0;
  p.portfolio.accounts.roth.balance = 0;
  p.portfolio.extraAccounts = [
    typedInvestmentAccount(
      'brokerage_taxable',
      'growth-account',
      1000000,
      snapshotPresetAllocation('growth'),
    ),
  ];

  const result = runHistoricalPath(p, 1973, 'taxable-first');
  const first = result.rows[0];
  const source = RETURN_DATA.find(row => row.y === 1973);
  const accountReturn = first.accountReturns['growth-account'];
  const expectedEffectiveWeights = {
    usLarge: 0.60,
    usSmall: 0.15,
    intlDev: 0,
    emerging: 0,
    usBonds: 0.20,
    cash: 0.02,
    reit: 0,
    gold: 0.03,
  };
  const expectedReturn = Object.entries(expectedEffectiveWeights)
    .reduce((sum, [key, weight]) => sum + weight * (source[key] ?? 0), 0);

  assert.strictEqual(first.source, 1973);
  assert.deepStrictEqual(accountReturn.requestedWeights, {
    usLarge: 0.36,
    usSmall: 0.09,
    intlDev: 0.21,
    emerging: 0.05,
    usBonds: 0.20,
    cash: 0.02,
    reit: 0.04,
    gold: 0.03,
  });
  assert.deepStrictEqual(accountReturn.unavailableAssetKeys, [
    'intlDev',
    'emerging',
    'reit',
  ]);
  assert.strictEqual(accountReturn.redistributionKind, 'within-sleeve');
  for(const [key, expected] of Object.entries(expectedEffectiveWeights)){
    assert.ok(Math.abs(accountReturn.effectiveWeights[key] - expected) < 1e-12);
    assert.ok(
      Math.abs(first.householdEffectiveAllocation.effectiveWeights[key] - expected) < 1e-12,
    );
  }
  assert.ok(Math.abs(accountReturn.baseRealReturn - expectedReturn) < 1e-12);
  assert.ok(Math.abs(accountReturn.returnDollars - 1000000 * expectedReturn) < 1e-9);
  assert.ok(Math.abs(first.returnDollars - accountReturn.returnDollars) < 1e-9);
  assert.ok(Math.abs(first.returnRate - expectedReturn) < 1e-12);
});

test('a typed bank account earns cash while return adjustment remains separate', () => {
  const p = currentAllocationPlan();
  p.portfolio.accounts.taxable.balance = 0;
  p.portfolio.accounts.traditional.balance = 0;
  p.portfolio.accounts.roth.balance = 0;
  const bank = createAccount('savings', { owner: 'client', balance: 100000 });
  bank.id = 'bank-cash';
  p.portfolio.extraAccounts = [bank];
  p.household.primary.planEndAge = p.household.primary.currentAge;
  const inputs = resolveInputs(p, { returnAdj: 1 });
  const source = RETURN_DATA.find(row => row.y === 2024);
  const result = runSinglePath(inputs, [source]);
  const accountReturn = result.rows[0].accountReturns['bank-cash'];

  assert.strictEqual(accountReturn.baseRealReturn, source.cash);
  assert.strictEqual(accountReturn.returnAdj, 0.01);
  assert.ok(Math.abs(accountReturn.appliedReturn - (source.cash + 0.01)) < 1e-12);
  assert.strictEqual(result.rows[0].returnRate, accountReturn.appliedReturn);
});

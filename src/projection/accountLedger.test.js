import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_KEYS,
  resolveCashOnlyAllocation,
  snapshotPresetAllocation,
  withCustomAssetWeights,
} from '../household/investmentAllocation.js';
import {
  applyProjectionContributions,
  applyProjectionOwnerRmd,
  applyProjectionYearReturnsAndWithdrawals,
  buildProjectionAccountLedger,
  fundProjectionGap,
  resolveProjectionReturnFrame,
} from './accountLedger.js';

function oneAssetAllocation(assetKey){
  const weights = Object.fromEntries(ASSET_KEYS.map(key => [key, key === assetKey ? 1 : 0]));
  return withCustomAssetWeights(snapshotPresetAllocation('balanced'), weights);
}

function account({ id, bucket, balance, basis = 0, owner = 'client', allocation }){
  return {
    id,
    bucket,
    owner,
    sourceKind: 'typed-account',
    typeId: bucket === 'taxable' ? 'brokerage_taxable' : `${bucket}_ira`,
    taxCharacter: bucket,
    balance,
    basis,
    investmentAllocation: allocation,
  };
}

function returnRow(year, overrides = {}){
  return {
    y: year,
    ...Object.fromEntries(ASSET_KEYS.map(key => [key, 0])),
    ...overrides,
  };
}

test('one shared market row produces account-specific returns and an exact aggregate', () => {
  const ledger = [
    account({ id: 'equity', bucket: 'taxable', balance: 100, allocation: oneAssetAllocation('usLarge') }),
    account({ id: 'bonds', bucket: 'traditional', balance: 300, allocation: oneAssetAllocation('usBonds') }),
  ];
  const frame = resolveProjectionReturnFrame(
    ledger,
    returnRow(2025, { usLarge: 0.2, usBonds: 0.05 }),
    0.01,
  );

  assert.equal(frame.accountReturns.equity.sourceYear, 2025);
  assert.equal(frame.accountReturns.bonds.sourceYear, 2025);
  assert.equal(frame.accountReturns.equity.baseRealReturn, 0.2);
  assert.equal(frame.accountReturns.bonds.baseRealReturn, 0.05);
  assert.ok(Math.abs(frame.accountReturns.equity.appliedReturn - 0.21) < 1e-12);
  assert.equal(frame.accountReturns.bonds.appliedReturn, 0.060000000000000005);
  assert.ok(Math.abs(frame.returnDollars - (100 * 0.21 + 300 * 0.06)) < 1e-12);
  assert.ok(Math.abs(frame.returnRate - (frame.returnDollars / 400)) < 1e-12);
  assert.equal(frame.householdAllocation.requestedWeights.usLarge, 0.25);
  assert.equal(frame.householdAllocation.requestedWeights.usBonds, 0.75);
});

test('bank allocation earns the cash return from the common market row', () => {
  const ledger = [
    account({ id: 'bank', bucket: 'taxable', balance: 500, allocation: resolveCashOnlyAllocation() }),
  ];
  const frame = resolveProjectionReturnFrame(
    ledger,
    returnRow(2025, { usLarge: 0.19, cash: 0.032 }),
    0,
  );

  assert.equal(frame.accountReturns.bank.baseRealReturn, 0.032);
  assert.equal(frame.accountReturns.bank.returnDollars, 16);
  assert.equal(frame.returnRate, 0.032);
});

test('ordinary withdrawals are pro rata within a bucket and taxable basis reconciles per account', () => {
  const ledger = [
    account({ id: 'tax-a', bucket: 'taxable', balance: 100, basis: 50, allocation: oneAssetAllocation('usLarge') }),
    account({ id: 'tax-b', bucket: 'taxable', balance: 300, basis: 240, allocation: oneAssetAllocation('usLarge') }),
  ];
  const frame = resolveProjectionReturnFrame(ledger, returnRow(2025), 0);
  const funding = fundProjectionGap(
    ledger,
    frame,
    80,
    { ordinary: 0, capitalGains: 0 },
    'taxable-first',
  );

  assert.equal(funding.grossById['tax-a'], 20);
  assert.equal(funding.grossById['tax-b'], 60);
  assert.equal(funding.breakdown.taxable, 80);
  const applied = applyProjectionYearReturnsAndWithdrawals(ledger, frame, funding.grossById);
  assert.ok(Math.abs(applied.taxableCapitalGain - 22) < 1e-12);
  assert.equal(ledger[0].balance, 80);
  assert.equal(ledger[1].balance, 240);
  assert.equal(ledger[0].basis, 40);
  assert.equal(ledger[1].basis, 192);
});

test('unavailable taxable evidence cannot override the approved aggregate basis fallback', () => {
  const allocation = oneAssetAllocation('usLarge');
  const taxable = {
    ...account({
      id: 'loss-position',
      bucket: 'taxable',
      balance: 100000,
      allocation,
    }),
    engineBucket: 'taxable',
  };
  const ledger = buildProjectionAccountLedger({
    plan: {
      meta: { accountSchemaVersion: 2 },
      portfolio: { accounts: {} },
      household: { spouse: null },
    },
    accountFold: {
      accounts: [taxable],
      engineBuckets: {
        taxable: { accountIds: ['loss-position'] },
        traditional: { accountIds: [] },
        roth: { accountIds: [] },
      },
    },
    taxableBasis: {
      basisOverride: null,
      appliedBasis: 50000,
      appliedMode: 'unavailable',
      evidence: [{ accountId: 'loss-position', amount: 125000 }],
    },
  });

  assert.equal(ledger[0].basis, 50000);
});

test('contributions are pro rata by opening account balance and fail closed without a target account', () => {
  const ledger = [
    account({ id: 'ira-a', bucket: 'traditional', balance: 100, allocation: oneAssetAllocation('usBonds') }),
    account({ id: 'ira-b', bucket: 'traditional', balance: 300, allocation: oneAssetAllocation('usBonds') }),
  ];
  const frame = resolveProjectionReturnFrame(ledger, returnRow(2025), 0);
  const contributions = applyProjectionContributions(
    ledger,
    frame,
    { taxable: 0, traditional: 40, roth: 0 },
  );

  assert.equal(contributions['ira-a'], 10);
  assert.equal(contributions['ira-b'], 30);
  assert.equal(ledger[0].balance, 110);
  assert.equal(ledger[1].balance, 330);

  assert.throws(
    () => applyProjectionContributions([], { accountReturns: {} }, {
      taxable: 0,
      traditional: 1,
      roth: 0,
    }),
    error => error?.code === 'ALLOCATION_REQUIRED_FOR_CONTRIBUTIONS',
  );
});

test('traditional contributions use existing 401(k)s only and preserve their opening-balance proportions', () => {
  const allocation = oneAssetAllocation('usBonds');
  const ledger = [
    { ...account({ id: 'client-401k', bucket: 'traditional', balance: 100, allocation }), typeId: '401k' },
    { ...account({ id: 'second-401k', bucket: 'traditional', balance: 300, allocation }), typeId: '401k' },
    account({ id: 'client-ira', bucket: 'traditional', balance: 600, allocation }),
  ];
  const frame = resolveProjectionReturnFrame(ledger, returnRow(2025), 0);
  const contributions = applyProjectionContributions(
    ledger,
    frame,
    { taxable: 0, traditional: 40, roth: 0 },
  );

  assert.deepEqual(contributions, {
    'client-401k': 10,
    'second-401k': 30,
    'client-ira': 0,
  });
  assert.deepEqual(ledger.map(value => value.balance), [110, 330, 600]);
});

test('explicit savings entries reach only matching owner and account type', () => {
  const allocation = oneAssetAllocation('usBonds');
  const ledger = [
    { ...account({ id: 'client-401k', bucket: 'traditional', balance: 0, allocation }), typeId: '401k' },
    { ...account({ id: 'spouse-401k', bucket: 'traditional', owner: 'spouse', balance: 0, allocation }), typeId: '401k' },
    { ...account({ id: 'client-roth', bucket: 'roth', balance: 0, allocation }), typeId: 'roth_ira' },
  ];
  const frame = resolveProjectionReturnFrame(ledger, returnRow(2025), 0);
  const contributions = applyProjectionContributions(
    ledger,
    frame,
    { taxable: 0, traditional: 28_300, roth: 7_000 },
    [
      { owner: 'client', typeId: '401k', bucket: 'traditional', amount: 28_300 },
      { owner: 'client', typeId: 'roth_ira', bucket: 'roth', amount: 7_000 },
    ],
  );

  assert.deepEqual(contributions, {
    'client-401k': 28_300,
    'spouse-401k': 0,
    'client-roth': 7_000,
  });
  assert.deepEqual(ledger.map(value => value.balance), [28_300, 0, 7_000]);
  assert.throws(
    () => applyProjectionContributions(
      ledger,
      frame,
      { taxable: 0, traditional: 1, roth: 0 },
      [{ owner: 'spouse', typeId: 'traditional_ira', bucket: 'traditional', amount: 1 }],
    ),
    error => error?.code === 'SAVINGS_ACCOUNT_DESTINATION_UNAVAILABLE',
  );
});

test('RMD draws remain owner-first and pro rata within each owner', () => {
  const allocation = oneAssetAllocation('usBonds');
  const ledger = [
    account({ id: 'client-a', bucket: 'traditional', owner: 'client', balance: 100, allocation }),
    account({ id: 'client-b', bucket: 'traditional', owner: 'client', balance: 300, allocation }),
    account({ id: 'spouse-a', bucket: 'traditional', owner: 'spouse', balance: 200, allocation }),
  ];
  const result = applyProjectionOwnerRmd(ledger, { client: 80, spouse: 20 });

  assert.equal(result.byId['client-a'], 20);
  assert.equal(result.byId['client-b'], 60);
  assert.equal(result.byId['spouse-a'], 20);
  assert.deepEqual(result.byOwner, { client: 80, spouse: 20, unattributed: 0 });
  assert.equal(result.total, 100);
  assert.deepEqual(ledger.map(value => value.balance), [80, 240, 180]);
});

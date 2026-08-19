import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs } from '../../engine.js';
import { createAccount } from './createAccount.js';
import { resolveTaxableStartingBasis } from './resolveTaxableStartingBasis.js';

function plan(){
  const value = structuredClone(defaultPlan);
  value.meta.filingStatus = 'marriedFilingJointly';
  value.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  value.portfolio.extraAccounts = [];
  return value;
}

function confirmedBasis(amount){
  return {
    amount,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-07-12T12:00:00Z',
    version: 1,
  };
}

function assumedBasis(amount){
  return {
    amount,
    method: 'legacy-proportional',
    status: 'assumed',
    source: 'planner-assumption',
    confirmedAt: null,
    version: 1,
  };
}

function account(typeId, id, balance, changes = {}){
  return {
    ...createAccount(typeId, { owner: changes.owner ?? 'client', balance }),
    id,
    ...changes,
  };
}

test('complete confirmed brokerage basis plus bank principal remains exact', () => {
  const value = plan();
  value.portfolio.extraAccounts = [
    account('brokerage_taxable', 'broker-one', 100000, { basis: confirmedBasis(25000) }),
    account('tod_brokerage', 'broker-two', 50000, { basis: confirmedBasis(60000) }),
    account('checking', 'bank', 10000),
  ];

  const resolved = resolveTaxableStartingBasis(value);
  assert.equal(resolved.status, 'confirmed');
  assert.equal(resolved.taxableBalance, 160000);
  assert.equal(resolved.basisOverride, 95000);
  assert.equal(resolved.appliedBasis, 95000);
  assert.equal(resolved.evidence.length, 3);
  assert.equal(resolved.evidence.reduce((sum, item) => sum + item.amount, 0), 95000);
  assert.equal(resolved.evidence.find(item => item.accountId === 'bank').method, 'principal');
  assert.equal(Object.isFrozen(resolved.evidence[0].reporting), true);
  assert.equal(resolveInputs(value, {}).accounts.taxable.basis, 95000);
});

test('unknown or assumed taxable-account basis uses the approved 50/50 planning assumption', () => {
  for(const secondBasis of [
    undefined,
    assumedBasis(1000),
  ]){
    const value = plan();
    const second = account('brokerage_taxable', 'second', 50000);
    if(secondBasis) second.basis = secondBasis;
    value.portfolio.extraAccounts = [
      account('brokerage_taxable', 'confirmed', 100000, { basis: confirmedBasis(25000) }),
      second,
    ];
    const resolved = resolveTaxableStartingBasis(value);
    assert.equal(resolved.status, 'assumed-50-50');
    assert.equal(resolved.basisOverride, 50000);
    assert.equal(resolved.appliedBasis, 50000);
    assert.equal(resolved.appliedMode, 'assumed-50-50');
    assert.deepEqual(resolved.assumptions, [{
      code: 'TAXABLE_BASIS_ASSUMED_50_50',
      mode: 'assumed-50-50',
      accountId: 'second',
      applicableBalance: 50000,
      basisAmount: 25000,
      gainAmount: 25000,
      basisFraction: 0.5,
      gainFraction: 0.5,
    }]);
    assert.equal(resolveInputs(value, {}).accounts.taxable.basis, 50000);
  }
});

test('confirmed zero basis applies while a loss position waits for loss-tax rules', () => {
  const zero = plan();
  zero.portfolio.extraAccounts = [
    account('brokerage_taxable', 'zero', 100000, { basis: confirmedBasis(0) }),
  ];
  assert.equal(resolveTaxableStartingBasis(zero).basisOverride, 0);
  assert.equal(resolveInputs(zero, {}).accounts.taxable.basis, 0);

  const loss = plan();
  loss.portfolio.extraAccounts = [
    account('brokerage_taxable', 'loss', 100000, { basis: confirmedBasis(125000) }),
  ];
  const lossResolution = resolveTaxableStartingBasis(loss);
  assert.equal(lossResolution.status, 'rules-pending');
  assert.equal(lossResolution.basisOverride, null);
  assert.equal(lossResolution.records[0].basisAmount, 125000);
  assert.equal(lossResolution.records[0].disposition, 'readiness-only');
  assert.ok(lossResolution.gaps.some(gap => gap.code === 'TAXABLE_LOSS_TREATMENT_PENDING'));
  assert.equal(resolveInputs(loss, {}).accounts.taxable.basis, 50000);
});

test('unknown, separate, fractional, MFS, owner-mismatched, and trust reporting block application', () => {
  const cases = [
    raw => { raw.taxReporting.inclusion = 'unknown'; raw.taxReporting.householdReturnShare = null; },
    raw => { raw.taxReporting.inclusion = 'separate-return'; },
    raw => { raw.taxReporting.householdReturnShare = 0.5; },
    raw => { raw.taxReporting.reportingTaxpayer = 'spouse'; },
  ];
  for(const change of cases){
    const value = plan();
    const raw = account('brokerage_taxable', 'broker', 100000, { basis: confirmedBasis(50000) });
    change(raw);
    value.portfolio.extraAccounts = [raw];
    assert.equal(resolveTaxableStartingBasis(value).basisOverride, null);
  }

  const mfs = plan();
  mfs.meta.filingStatus = 'marriedFilingSeparately';
  mfs.portfolio.extraAccounts = [
    account('brokerage_taxable', 'broker', 100000, { basis: confirmedBasis(50000) }),
  ];
  assert.equal(resolveTaxableStartingBasis(mfs).basisOverride, null);

  const trust = plan();
  const trustAccount = account('trust_brokerage', 'trust', 100000, {
    owner: 'trust',
    basis: confirmedBasis(50000),
  });
  trustAccount.taxReporting = {
    inclusion: 'household-return',
    reportingTaxpayer: 'return-level',
    householdReturnShare: 1,
  };
  trust.portfolio.extraAccounts = [trustAccount];
  assert.equal(resolveTaxableStartingBasis(trust).basisOverride, null);

  for(const change of cases){
    const value = plan();
    const raw = account('checking', 'bank', 100000);
    change(raw);
    value.portfolio.extraAccounts = [raw];
    const resolved = resolveTaxableStartingBasis(value);
    assert.equal(resolved.basisOverride, null);
    assert.ok(resolved.gaps.some(gap => gap.kind === 'reporting'));
  }

  const mfsBank = plan();
  mfsBank.meta.filingStatus = 'marriedFilingSeparately';
  mfsBank.portfolio.extraAccounts = [account('checking', 'bank', 100000)];
  assert.equal(resolveTaxableStartingBasis(mfsBank).basisOverride, null);
});

test('current base-sleeve taxable balances default to 50/50 without basis provenance', () => {
  for(const [balance, expectedBasis] of [[100000, 50000], [500000, 250000]]){
    for(const basisPct of [0.6, 1, null, undefined]){
      const value = plan();
      value.portfolio.accounts.taxable = { balance };
      if(basisPct !== undefined){
        value.portfolio.accounts.taxable.basisPct = basisPct;
      }
      const resolved = resolveTaxableStartingBasis(value);

      assert.equal(resolved.status, 'assumed-50-50');
      assert.equal(resolved.basisOverride, expectedBasis);
      assert.equal(resolved.appliedBasis, expectedBasis);
      assert.equal(resolved.appliedMode, 'assumed-50-50');
      assert.deepEqual(
        resolved.assumptions.map(item => [
          item.code,
          item.applicableBalance,
          item.basisAmount,
        ]),
        [['TAXABLE_BASIS_ASSUMED_50_50', balance, expectedBasis]],
      );
      assert.equal(
        resolveInputs(value, {}).accounts.taxable.basis,
        expectedBasis,
      );
    }
  }
});

test('a spouse-owned taxable account cannot supply basis without a spouse household member', () => {
  const value = plan();
  value.household.spouse = null;
  const raw = account('brokerage_taxable', 'orphan-spouse', 100000, {
    owner: 'spouse',
    basis: confirmedBasis(50000),
  });
  raw.taxReporting.reportingTaxpayer = 'spouse';
  value.portfolio.extraAccounts = [raw];
  const resolved = resolveTaxableStartingBasis(value);
  assert.equal(resolved.basisOverride, null);
  assert.ok(resolved.gaps.some(gap => gap.code === 'ACCOUNT_OWNER_WITHOUT_SPOUSE'));
});

test('filing-return ownership and trust treatment gate confirmed taxable basis', () => {
  const single = plan();
  single.meta.filingStatus = 'single';
  single.household.spouse = { currentAge: 64, retirementAge: 65, planEndAge: 95 };
  const spouseAccount = account('brokerage_taxable', 'spouse-brokerage', 100000, {
    owner: 'spouse',
    basis: confirmedBasis(50000),
  });
  spouseAccount.taxReporting.reportingTaxpayer = 'spouse';
  single.portfolio.extraAccounts = [spouseAccount];
  const singleResolution = resolveTaxableStartingBasis(single);
  assert.equal(singleResolution.basisOverride, null);
  assert.ok(singleResolution.gaps.some(gap => (
    gap.code === 'FILING_STATUS_ACCOUNT_OWNER_MISMATCH'
  )));

  const trust = plan();
  const genericTrust = account('brokerage_taxable', 'generic-trust', 100000, {
    owner: 'trust',
    basis: confirmedBasis(50000),
  });
  genericTrust.taxReporting = {
    inclusion: 'household-return', reportingTaxpayer: 'return-level', householdReturnShare: 1,
  };
  trust.portfolio.extraAccounts = [genericTrust];
  const trustResolution = resolveTaxableStartingBasis(trust);
  assert.equal(trustResolution.basisOverride, null);
  assert.ok(trustResolution.gaps.some(gap => (
    gap.code === 'TRUST_ACCOUNT_TAX_TREATMENT_UNSUPPORTED'
  )));
});

test('resolver is deterministic, deeply frozen, and does not mutate Household data', () => {
  const value = plan();
  value.portfolio.extraAccounts = [
    account('brokerage_taxable', 'broker', 100000, { basis: confirmedBasis(50000) }),
  ];
  const before = structuredClone(value);
  const first = resolveTaxableStartingBasis(value);
  const second = resolveTaxableStartingBasis(value);
  assert.deepEqual(first, second);
  assert.deepEqual(value, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.records), true);
  assert.equal(Object.isFrozen(first.records[0]), true);
  assert.throws(() => { first.records[0].basisAmount = 1; }, TypeError);
});

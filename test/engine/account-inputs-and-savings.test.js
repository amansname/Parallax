// Engine contract: account inputs and savings. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { generateReturnPath, runSimulation, runHistoricalPath, runSinglePath, resolveInputs, defaultPlan } from '../../engine.js';
import { createAccount } from '../../src/household/createAccount.js';
import { snapshotPresetAllocation } from '../../src/household/investmentAllocation.js';
import { resolvePortfolioAccounts } from '../../src/household/resolvePortfolioAccounts.js';
import { flatAssetReturnRow, currentAllocationPlan, typedInvestmentAccount } from './fixtures.js';

// ── Multi-row income / expenses / goals (the add-row data model) ─────────────
// income.other is now an ARRAY of timed streams: each is summed only while active,
// and a legacy single object is still accepted.
test('annual savings increases terminal wealth during accumulation', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 40, retirementAge: 65, planEndAge: 95 };
  p.portfolio.accounts = { taxable: { balance: 500000, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } };
  p.goals = [];
  p.savings.annual = 0;
  const base = runHistoricalPath(p, 1995, 'taxable-first');
  p.savings.annual = 50000;
  p.savings.split = { taxable: 1, traditional: 0, roth: 0 };
  const saving = runHistoricalPath(p, 1995, 'taxable-first');
  assert.ok(saving.terminalBalance > base.terminalBalance + 1,
    'annual savings must raise ending wealth during working years');
});

// ── Contribution split (Roth / brokerage contributions in accumulation) ─────
// Savings can land in any of the three sleeves. Default is 100% pre-tax so old
// plans are unchanged; a Roth/taxable split routes the money differently.
test('savings split: default is all pre-tax; resolveInputs normalizes a custom split', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.savings = { annual: 30000 };                       // no split → back-compat default
  const d = resolveInputs(p, {});
  assert.ok(Math.abs(d.savingsSplit.traditional - 1) < 1e-9 && d.savingsSplit.roth === 0 && d.savingsSplit.taxable === 0,
    'missing split → 100% traditional');
  const q = JSON.parse(JSON.stringify(defaultPlan));
  q.savings = { annual: 30000, split: { traditional: 1, roth: 1, taxable: 2 } };  // 1:1:2
  const e = resolveInputs(q, {});
  assert.ok(Math.abs(e.savingsSplit.taxable - 0.5) < 1e-9 && Math.abs(e.savingsSplit.roth - 0.25) < 1e-9,
    'split normalizes to fractions');
  // override beats the plan's split
  const o = resolveInputs(p, { savingsSplit: { roth: 1 } });
  assert.ok(o.savingsSplit.roth === 1 && o.savingsSplit.traditional === 0, 'ov.savingsSplit wins');
});

test('Roth contributions end higher than the same dollars pre-tax (split flows through)', () => {
  const horizon = 95 - 50 + 1;
  const bundle = Array.from({ length: 200 }, () => generateReturnPath(horizon));
  // Well-funded so the plan SURVIVES — then the withdrawal-side tax treatment
  // (Roth tax-free + no RMD vs Traditional taxed + RMD drag) shows in the terminal.
  const mk = split => {
    const p = JSON.parse(JSON.stringify(defaultPlan));
    p.household.primary = { currentAge: 50, retirementAge: 65, planEndAge: 95 };
    p.savings   = { annual: 150000, split };
    p.expenses  = { living: 60000, housing: 0, debt: 0, healthcare: 0 };
    p.portfolio.accounts = { taxable:{balance:200000,basisPct:1}, traditional:{balance:0}, roth:{balance:0} };
    return runSimulation(p, {}, bundle);
  };
  const allTrad = mk({ traditional:1, roth:0, taxable:0 });
  const allRoth = mk({ traditional:0, roth:1, taxable:0 });
  assert.ok(allRoth.terminal.p50 > allTrad.terminal.p50 + 1,
    'tax-free Roth (no RMD) must end higher than the same dollars in pre-tax');
});

// ── Typed accounts (401k, SEP, …) fold into their tax sleeve ────────────────
test('extra typed accounts sum into their bucket; empty = unchanged', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));
  const baseR = resolveInputs(base, {});
  base.portfolio.extraAccounts = [];                       // explicit empty = no change
  assert.strictEqual(resolveInputs(base, {}).accounts.traditional.balance, baseR.accounts.traditional.balance,
    'empty extras → identical resolved balances');
  // a $500k 401(k) lands in the pre-tax (traditional) sleeve
  const withAcct = JSON.parse(JSON.stringify(defaultPlan));
  withAcct.portfolio.extraAccounts = [{ type:'401k', bucket:'traditional', balance:500000 }];
  const fold = resolvePortfolioAccounts(withAcct);
  const r = resolveInputs(withAcct, {});
  assert.strictEqual(r.accounts.traditional.balance, fold.engineBuckets.traditional.balance,
    'engine resolved balance must come from the shared account fold');
  assert.strictEqual(r.accounts.traditional.balance, baseR.accounts.traditional.balance + 500000,
    '401(k) adds to the pre-tax bucket');
  assert.strictEqual(r.accounts.roth.balance, baseR.accounts.roth.balance, 'Roth untouched');
  // a taxable add also lifts basis at the account basis %
  const withTax = JSON.parse(JSON.stringify(defaultPlan));
  withTax.portfolio.extraAccounts = [{ type:'brokerage', bucket:'taxable', balance:100000 }];
  const rt = resolveInputs(withTax, {});
  assert.strictEqual(rt.accounts.taxable.balance, baseR.accounts.taxable.balance + 100000, 'taxable add folds into taxable balance');
  assert.ok(rt.accounts.taxable.basis > baseR.accounts.taxable.basis, 'taxable add lifts basis');
});

test('confirmed taxable basis is preserved and unknown basis uses the approved 50/50 assumption', () => {
  const p = structuredClone(defaultPlan);
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const brokerage = createAccount('brokerage_taxable', { owner: 'client', balance: 100000 });
  brokerage.id = 'confirmed-brokerage';
  brokerage.basis = {
    amount: 25000,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-07-12T12:00:00Z',
    version: 1,
  };
  p.portfolio.extraAccounts = [brokerage];

  assert.strictEqual(resolveInputs(p, {}).accounts.taxable.basis, 25000,
    'complete confirmed account basis reaches engine starting basis');

  brokerage.basis = {
    amount: null,
    method: 'unknown',
    status: 'unknown',
    source: null,
    confirmedAt: null,
    version: 1,
  };
  const assumed = resolveInputs(p, {});
  assert.strictEqual(assumed.accounts.taxable.basis, 50000,
    'unknown basis uses 50% of the applicable taxable balance');
});

test('inherited accounts appear in current folds but stay out of engine inputs until rules exist', () => {
  const base = JSON.parse(JSON.stringify(defaultPlan));
  const baseInputs = resolveInputs(base, {});
  const withInherited = JSON.parse(JSON.stringify(defaultPlan));
  withInherited.portfolio.extraAccounts = [
    { typeId:'inherited_traditional_ira', type:'Inherited Traditional IRA', bucket:'traditional', balance:500000 },
    { typeId:'inherited_roth_ira', type:'Inherited Roth IRA', bucket:'roth', balance:250000 },
  ];
  const fold = resolvePortfolioAccounts(withInherited);
  const inputs = resolveInputs(withInherited, {});

  assert.equal(fold.taxBuckets.traditional.balance, baseInputs.accounts.traditional.balance + 500000);
  assert.equal(fold.taxBuckets.roth.balance, baseInputs.accounts.roth.balance + 250000);
  assert.equal(inputs.accounts.traditional.balance, baseInputs.accounts.traditional.balance);
  assert.equal(inputs.accounts.roth.balance, baseInputs.accounts.roth.balance);
  assert.deepEqual(fold.pendingStrategyAccounts.map(account => account.typeId), [
    'inherited_traditional_ira', 'inherited_roth_ira',
  ]);
});

test('savingsAnnual models positive scenario savings over a zero-dollar base', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 60, retirementAge: 62, planEndAge: 62 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];
  p.savings.annual = 0;
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {
    savingsAnnual: 24_000,
    savingsSplit: { taxable: 1 },
  });
  const result = runSinglePath(params, [
    flatAssetReturnRow(2026),
    flatAssetReturnRow(2027),
    flatAssetReturnRow(2028),
  ]);

  assert.equal(params.savingsAnnual, 24_000);
  assert.deepEqual(params.savingsSplit, { traditional: 0, roth: 0, taxable: 1 });
  assert.equal(result.rows[1].accountBalances.taxable, 48_000);
  assert.equal(result.rows[1].taxableEndingBasis, 48_000);
});

test('Scenario traditional savings flow only to existing 401(k)s', () => {
  const p = currentAllocationPlan();
  p.household.primary = { currentAge: 50, retirementAge: 51, planEndAge: 51 };
  p.household.spouse = null;
  p.portfolio.accounts.taxable.balance = 0;
  p.portfolio.accounts.traditional.balance = 0;
  p.portfolio.accounts.roth.balance = 0;
  p.portfolio.extraAccounts = [
    typedInvestmentAccount('401k', 'client-401k', 100_000, snapshotPresetAllocation('balanced')),
    typedInvestmentAccount('401k', 'second-401k', 300_000, snapshotPresetAllocation('balanced')),
    typedInvestmentAccount('traditional_ira', 'client-ira', 600_000, snapshotPresetAllocation('balanced')),
  ];
  p.savings.annual = 0;
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {
    savingsAnnual: 40_000,
    savingsSplit: { traditional: 1 },
  });
  const result = runSinglePath(params, [
    flatAssetReturnRow(2026),
    flatAssetReturnRow(2027),
  ]);

  const first = result.rows[0];
  assert.deepEqual(first.accountContributionsById, {
    'base-taxable': 0,
    'base-traditional': 0,
    'base-roth': 0,
    'client-401k': 10_000,
    'second-401k': 30_000,
    'client-ira': 0,
  });
  assert.equal(first.accountBalancesById['client-401k'], 110_000);
  assert.equal(first.accountBalancesById['second-401k'], 330_000);
  assert.equal(first.accountBalancesById['client-ira'], 600_000);
  assert.equal(first.accountBalances.traditional, 1_040_000);
  assert.equal(first.accountBalancesById['base-taxable'], 0);
  assert.equal(first.accountBalancesById['base-traditional'], 0);
  assert.equal(first.accountBalancesById['base-roth'], 0);
});

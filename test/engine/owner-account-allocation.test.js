// Engine contract: owner account allocation. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { generateReturnPath, runSimulation, runHistoricalPath, runSinglePath, resolveInputs, defaultPlan, resetSeed } from '../../engine.js';
import { createAccount } from '../../src/household/createAccount.js';
import { flatAssetReturnRow } from './fixtures.js';

/* ── Per-owner RMDs ─────────────────────────────────────────────────────────
   RMDs are legally per owner — you cannot satisfy your spouse's RMD out of your
   IRA. These lock the owner-level traditional sleeve that makes that possible.
   Regression origin: a married couple who each owned a pre-tax account (the
   ordinary case) aborted every scenario at the first RMD year, so Scenarios
   rendered a dash with no explanation. */
function mfjTwoOwnerPlan() {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = { currentAge: 56, retirementAge: 63, planEndAge: 95, birthYear: 1970 };
  p.household.spouse  = { currentAge: 53, retirementAge: 60, planEndAge: 95, birthYear: 1973 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse:  { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings = { annual: 0, split: { traditional: 1, roth: 0, taxable: 0 } };
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 3000000 }),
    createAccount('rollover_ira', { owner: 'spouse', balance: 2000000 }),
  ];
  return p;
}

function agedTwoOwnerPlan(clientAge, spouseAge, living) {
  const p = mfjTwoOwnerPlan();
  p.household.primary = {
    currentAge: clientAge, retirementAge: clientAge, planEndAge: clientAge + 6,
    birthYear: 2026 - clientAge,
  };
  p.household.spouse = {
    currentAge: spouseAge, retirementAge: spouseAge, planEndAge: spouseAge + 6,
    birthYear: 2026 - spouseAge,
  };
  if (living != null) {
    p.expenses = { living, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
  }
  return p;
}

test('a couple who each own a pre-tax account completes a projection', () => {
  const p = mfjTwoOwnerPlan();
  resetSeed();
  const r = resolveInputs(p, {});
  const res = runSimulation(p, {}, [generateReturnPath(r.horizonYears, r.portfolio)]);
  assert.ok(Number.isFinite(res.successRate), 'must produce a probability, not abort');
  assert.notStrictEqual(res.projectionStatus, 'unavailable');
});

test('each spouse RMD uses their own balance and their own age', () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 76), 1995, 'taxable-first').rows[0];
  // Same age, different balances: requirements differ strictly by balance.
  assert.ok(Math.abs(row.rmdRequiredByOwner.client - 3000000 / 23.7) < 1);
  assert.ok(Math.abs(row.rmdRequiredByOwner.spouse - 2000000 / 23.7) < 1);
  assert.strictEqual(row.rmdOwner, null, 'two owners means no single household owner');
});

test('a spouse below their applicable age owes nothing', () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 70), 1995, 'taxable-first').rows[0];
  assert.ok(row.rmdRequiredByOwner.client > 0);
  assert.strictEqual(row.rmdRequiredByOwner.spouse, 0);
});

test('an ordinary withdrawal is allocated RMD-first, not pro rata', () => {
  // Client is past their applicable age, spouse is not, and spending needs a draw.
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 60, 120000), 1995, 'taxable-first').rows[0];
  const required = row.rmdRequiredByOwner.client;
  assert.ok(required > 0, 'client owes an RMD');
  const drawn = row.accountBreakdown.traditional;
  assert.ok(drawn > required, 'this case needs a draw larger than the requirement');
  // The client's own RMD comes out of the client's share first; only the
  // remainder is spread pro rata, so the spouse still takes part of the excess.
  assert.ok(row.rmdGrossByOwner.client >= required - 1,
    'the draw is charged to the owner who owes the RMD before anyone else');
  assert.ok(row.rmdGrossByOwner.spouse > 0,
    'the leftover above the requirement is shared pro rata');
  // The payoff: nothing has to be forced on top. Naive pro rata would have
  // given the client only ~60% of the draw, leaving ~$48k of their requirement
  // unmet and forcing it out separately — pulling more from tax-deferred money
  // than the plan actually needed.
  assert.ok(row.rmd < 1, 'no additional forced distribution is needed');
});

test("one spouse's withdrawal never satisfies the other's RMD", () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(60, 76, 200000), 1995, 'taxable-first').rows[0];
  const spouseRequired = row.rmdRequiredByOwner.spouse;
  assert.ok(spouseRequired > 0);
  assert.strictEqual(row.rmdRequiredByOwner.client, 0, 'the client is too young to owe');
  const spouseCovered = row.rmdGrossByOwner.spouse + row.rmd;
  assert.ok(spouseCovered + 1 >= spouseRequired,
    "the spouse's requirement is met from the spouse's own money");
});

test('row.rmd stays forced-only so Form 1040 cannot double-count', () => {
  const row = runHistoricalPath(agedTwoOwnerPlan(76, 76, 150000), 1995, 'taxable-first').rows[0];
  // The tax adapter computes accountBreakdown.traditional + row.rmd, so row.rmd
  // must exclude whatever the ordinary draw already took.
  assert.ok(row.rmd <= Math.max(0, row.rmdRequired - row.accountBreakdown.traditional) + 1,
    'row.rmd counts only the forced remainder');
  const distributed = row.rmdGrossByOwner.client + row.rmdGrossByOwner.spouse + row.rmd;
  assert.ok(distributed + 1 >= row.rmdRequired, 'the full requirement is still distributed');
});

test('owner buckets sum to the traditional balance, shocked or not', () => {
  for (const initialShock of [0, 0.3]) {
    const p = agedTwoOwnerPlan(76, 74, 150000);
    const r = resolveInputs(p, { initialShock });
    const t = r.accounts.traditional;
    const sum = t.byOwner.client + t.byOwner.spouse + t.byOwner.unattributed;
    assert.ok(Math.abs(t.balance - sum) < 0.01,
      'seed invariant holds at initialShock=' + initialShock);
    if (initialShock > 0) {
      const raw = r.rmdContract.openingBalanceByOwner;
      assert.ok(sum < raw.client + raw.spouse,
        'buckets follow the shocked sleeve, not the raw account dollars');
    }
    resetSeed();
    const sim = runSinglePath(r, generateReturnPath(r.horizonYears, r.portfolio));
    for (const row of sim.rows) {
      if (!row.accountBalances) continue;
      assert.ok(row.accountBalances.traditional >= -0.01, 'buckets never go negative');
    }
  }
});

test('an initial shock does not retroactively shrink the year-0 RMD basis', () => {
  const p = agedTwoOwnerPlan(76, 76);
  const plain = runSinglePath(resolveInputs(p, {}), generateReturnPath(30));
  const shocked = runSinglePath(resolveInputs(p, { initialShock: 0.3 }), generateReturnPath(30));
  assert.strictEqual(plain.rows[0].rmdBasisSource, 'opening-balance-assumption');
  assert.ok(Math.abs(plain.rows[0].rmdRequired - shocked.rows[0].rmdRequired) < 1,
    'the assumed prior-Dec-31 basis is unchanged by a shock during year 0');
  assert.strictEqual(plain.rows[1].rmdBasisSource, 'simulated-prior-year-close');
});

test('simulation paths do not share owner buckets', () => {
  const r = resolveInputs(agedTwoOwnerPlan(76, 76, 150000), {});
  const opening = Object.assign({}, r.accounts.traditional.byOwner);
  resetSeed();
  const path = generateReturnPath(r.horizonYears, r.portfolio);
  const a = runSinglePath(r, path);
  assert.deepStrictEqual(r.accounts.traditional.byOwner, opening,
    'a path must not mutate the shared resolved inputs');
  const b = runSinglePath(r, path);
  assert.strictEqual(
    a.rows[a.rows.length - 1].accountBalances.traditional,
    b.rows[b.rows.length - 1].accountBalances.traditional,
    'replaying the same path gives the same result'
  );
});

test('traditional contributions ignore legacy owner hints and remain balance-proportional', () => {
  const accumulating = () => {
    const p = mfjTwoOwnerPlan();
    p.household.primary = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
    p.household.spouse  = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
    p.savings = { annual: 45000, split: { traditional: 1, roth: 0, taxable: 0 } };
    return p;
  };

  const baseline = accumulating();
  const legacyHint = accumulating();
  legacyHint.savings.split.byOwner = { client: 1, spouse: 0 };
  const horizon = resolveInputs(baseline, {}).horizonYears;
  const path = Array.from({ length: horizon }, (_, index) => flatAssetReturnRow(2026 + index));
  const withoutHint = runSinglePath(resolveInputs(baseline, {}), path).rows[0];
  const withHint = runSinglePath(resolveInputs(legacyHint, {}), path).rows[0];

  assert.deepStrictEqual(
    withHint.traditionalEndingBalancesByOwner,
    withoutHint.traditionalEndingBalancesByOwner,
    'legacy owner hints do not override account-balance contribution shares',
  );
});

test('accumulation rows report exact Traditional ending balances by owner', () => {
  const p = mfjTwoOwnerPlan();
  p.household.primary = {
    ...p.household.primary, retirementAge: 57, planEndAge: 57,
  };
  p.household.spouse = {
    ...p.household.spouse, retirementAge: 54, planEndAge: 54,
  };
  p.savings = {
    annual: 12_000,
    split: {
      traditional: 1, roth: 0, taxable: 0,
      byOwner: { client: 1, spouse: 0 },
    },
  };

  const inputs = resolveInputs(p, {});
  const row = runSinglePath(inputs, [
    flatAssetReturnRow(2026),
    flatAssetReturnRow(2027),
  ]).rows[0];

  assert.deepStrictEqual(row.traditionalEndingBalancesByOwner, {
    client: 3_007_200,
    spouse: 2_004_800,
    unattributed: 0,
  });
  assert.equal(
    Object.values(row.traditionalEndingBalancesByOwner)
      .reduce((sum, value) => sum + value, 0),
    row.accountBalances.traditional
  );
});

test('unresolvable ownership fails closed instead of throwing', () => {
  const p = agedTwoOwnerPlan(74, 73);
  p.portfolio.accounts.traditional.balance = 400000;   // legacy aggregate, no owner
  p.portfolio.extraAccounts = [];
  const r = resolveInputs(p, {});
  let res;
  assert.doesNotThrow(() => {
    res = runSimulation(p, {}, [generateReturnPath(r.horizonYears, r.portfolio)]);
  }, 'no uncontrolled exception may escape');
  assert.strictEqual(res.projectionStatus, 'unavailable');
  assert.strictEqual(res.successRate, null);
  assert.strictEqual(res.issue, 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE');
  assert.ok(Number.isInteger(res.issueAge), 'the failing age is reported');
});

test('the live Scenarios entry point completes for a two-owner household', async () => {
  const { runFederalFundingSimulation } = await import('../../src/planning/tax/runMonteCarloWithFederalFunding.js');
  const { buildReadyCurrent1040Intake } = await import('../../src/planning/tax/buildCurrent1040Intake.js');
  const p = mfjTwoOwnerPlan();
  const r = resolveInputs(p, {});
  resetSeed();
  const paths = [generateReturnPath(r.horizonYears, r.portfolio)];
  const res = runFederalFundingSimulation(p, {}, paths, {
    baseTaxYear: 2026,
    scenarioId: 'per-owner-rmd',
    filingStatus: 'marriedFilingJointly',
    current1040Intake: buildReadyCurrent1040Intake(p),
  });
  // runSimulation alone did not reproduce the original defect; the federal
  // funding path is what Scenarios actually calls, so it is tested explicitly.
  assert.notStrictEqual(res.projectionStatus, 'unavailable');
  assert.ok(Number.isFinite(res.successRate));
});

test('a heavy-withdrawal projection cannot corrupt a later untouched one', () => {
  // Required-distribution and account-funding helpers share frozen owner
  // buckets when no draw is due. If a refactor ever mutated those buckets, one plan's
  // withdrawals would leak into every later plan's no-draw years — silently,
  // and everywhere at once. Guarded behaviorally so no test-only export is
  // needed: run a draw-heavy plan first, then confirm a quiet plan is bit-for-
  // bit identical to running it on its own.
  const quiet = () => {
    const q = mfjTwoOwnerPlan();          // no expenses, so no traditional draw
    q.household.primary = { currentAge: 55, retirementAge: 60, planEndAge: 70, birthYear: 1971 };
    q.household.spouse  = { currentAge: 55, retirementAge: 60, planEndAge: 70, birthYear: 1971 };
    return q;
  };
  const pathFor = (plan) => {
    const r = resolveInputs(plan, {});
    resetSeed();
    return runSinglePath(r, generateReturnPath(r.horizonYears, r.portfolio));
  };

  const alone = pathFor(quiet());
  pathFor(agedTwoOwnerPlan(76, 74, 400000));   // draw-heavy run in between
  const after = pathFor(quiet());

  assert.strictEqual(after.terminalBalance, alone.terminalBalance,
    'a prior plan with heavy withdrawals must not change this one');
  assert.deepStrictEqual(
    after.rows.map(r => r.accountBalances && r.accountBalances.traditional),
    alone.rows.map(r => r.accountBalances && r.accountBalances.traditional),
    'every year of the traditional sleeve must match'
  );
});

test('balance-proportional contributions do not surface a guessed-owner assumption', () => {
  const p = mfjTwoOwnerPlan();
  p.household.primary = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
  p.household.spouse  = { currentAge: 50, retirementAge: 60, planEndAge: 70, birthYear: 1976 };
  p.savings = { annual: 45000, split: { traditional: 1, roth: 0, taxable: 0 } };

  const r = resolveInputs(p, {});
  resetSeed();
  const sim = runSinglePath(r, generateReturnPath(r.horizonYears, r.portfolio));
  assert.ok(Array.isArray(sim.assumptions), 'each path reports its assumptions');
  assert.ok(!sim.assumptions.includes('TRADITIONAL_CONTRIBUTION_OWNER_PRORATED'),
    'account-balance allocation is a deterministic mechanic, not a guessed owner');

  resetSeed();
  const analysis = runSimulation(p, {}, [generateReturnPath(r.horizonYears, r.portfolio)]);
  assert.ok(!analysis.assumptions.includes('TRADITIONAL_CONTRIBUTION_OWNER_PRORATED'),
    'analysis does not revive the retired owner-allocation assumption');

  // An explicit per-owner split is determinate, so it carries no assumption.
  const explicit = structuredClone(p);
  explicit.savings.split.byOwner = { client: 1, spouse: 0 };
  resetSeed();
  const clean = runSinglePath(resolveInputs(explicit, {}), generateReturnPath(25));
  assert.deepStrictEqual(
    clean.rows[0].traditionalEndingBalancesByOwner,
    sim.rows[0].traditionalEndingBalancesByOwner,
    'legacy owner hints do not alter the account ledger',
  );
});

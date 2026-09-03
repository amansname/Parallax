// Engine contract: rmd lifecycle. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { generateReturnPath, runSimulation, runHistoricalPath, runSinglePath, resolveInputs, defaultPlan, resetSeed, resolveHouseholdTimeline, householdIncomeAtYear, resolveWithdrawalPlannerAccountState } from '../../engine.js';
import { createAccount } from '../../src/household/createAccount.js';
import { createFederalTaxResolver } from '../../src/planning/tax/createFederalTaxResolver.js';
import { flatAssetReturnRow } from './fixtures.js';

test('spousal rollover transfers full account ownership regardless of remaining cents', () => {
  for(const decedent of ['client', 'spouse']){
    for(const balance of [0, 0.009, 0.01, 0.02, 265000]){
      for(const federal of [false, true]){
        const p = structuredClone(defaultPlan);
        p.meta.filingStatus = 'marriedFilingJointly';
        p.meta.planningAsOfYear = 2026;
        p.household.primary = { currentAge: 90, retirementAge: 65, planEndAge: decedent === 'client' ? 90 : 92, birthYear: 1936 };
        p.household.spouse = { currentAge: 88, retirementAge: 62, planEndAge: decedent === 'spouse' ? 88 : 90, birthYear: 1938 };
        p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: { pia: 0, claimAge: 67 } };
        p.income.other = [];
        p.income.pension = { base: 0 };
        p.savings.annual = 0;
        p.goals = [];
        p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
        p.portfolio.accounts = { taxable: { balance: 1000000, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } };
        const survivor = decedent === 'client' ? 'spouse' : 'client';
        const inherited = createAccount('rollover_ira', { owner: decedent, balance: 1 });
        // Engine state can contain fractional cents after years of funding/returns.
        // createAccount intentionally rounds entered amounts to whole dollars.
        inherited.balance = balance;
        p.portfolio.extraAccounts = [inherited, createAccount('rollover_ira', { owner: survivor, balance: 600000 })];
        const before = JSON.stringify(p);
        const params = resolveInputs(p, {});
        const path = [flatAssetReturnRow(2026), flatAssetReturnRow(2027, 0.2), flatAssetReturnRow(2028)];
        const options = federal ? {
          taxPolicy: createFederalTaxResolver(params, { filingStatus: 'marriedFilingJointly', baseTaxYear: 2026 }),
          fundTaxPolicyDelta: true,
        } : {};
        const result = runSinglePath(params, path, options);
        assert.equal(result.rows.length, 3, `${decedent}/${balance}/${federal}`);
        assert.ok(Math.abs(result.rows[1].accountStartingBalances.traditional
          - result.rows[0].accountBalances.traditional) < 1e-8,
        'death-boundary transfer must conserve the entire pre-tax balance');
        if(balance > 0){
          for(const row of result.rows.slice(1)){
            const account = row.accountStates.find(account => account.id === inherited.id);
            assert.equal(account.owner, survivor);
            assert.ok(account.balance > 0, 'transfer must preserve rather than discard the remainder');
          }
        }
        assert.equal(JSON.stringify(p), before, 'projection must not mutate saved ownership');
      }
    }
  }
});

// ── RMDs (Required Minimum Distributions) ───────────────────────────────────
// From age 73 the pre-tax sleeve must distribute a minimum even if spending
// doesn't need it; the full gross amount is treated as spending and does not
// silently move into the taxable sleeve.
// Roth / taxable-only plans have no RMD.
test('RMDs force pre-tax distributions from 73 and spend the full gross amount', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 95, birthYear: 1953,
  };
  p.portfolio.accounts.taxable.balance     = 0;     // starts empty…
  p.portfolio.accounts.traditional.balance = 10e6;  // big pre-tax → RMD >> spending
  p.portfolio.accounts.roth.balance        = 0;
  const r = runHistoricalPath(p, 1995, 'taxable-first');
  const at73 = r.rows.find(x => x.age === 73);
  assert.ok(at73 && at73.rmd > 0, 'a required distribution fires at age 73');
  // Taxable began at $0 and this plan has no other taxable funding source.
  // Excess RMD proceeds are spent, never silently saved in taxable.
  assert.ok(r.rows.every(x => x.accountBalances.taxable <= 0.01),
    'full gross RMD is spent rather than reinvested into the taxable sleeve');

  const federalFunding = runHistoricalPath(
    p,
    1995,
    'taxable-first',
    undefined,
    undefined,
    { taxPolicy: (_row, { shortcutTax }) => shortcutTax, fundTaxPolicyDelta: true }
  );
  assert.ok(federalFunding.rows.every(x => x.accountBalances.taxable <= 0.01),
    'federal-tax funding also leaves forced RMD proceeds out of taxable savings');

  // No pre-tax balance → no RMD ever (Roth/taxable are exempt).
  const q = JSON.parse(JSON.stringify(defaultPlan));
  q.portfolio.accounts.taxable.balance     = 10e6;
  q.portfolio.accounts.traditional.balance = 0;
  q.portfolio.accounts.roth.balance        = 0;
  const r2 = runHistoricalPath(q, 1995, 'taxable-first');
  assert.ok(r2.rows.every(x => !(x.rmd > 0)), 'no Traditional balance → no RMD');
});

test('forced gross-spent RMDs reconcile exactly in normal, federal-funded, and accumulation routes', () => {
  const build = (retirementAge, portfolioFundedGoal = 0) => {
    const p = structuredClone(defaultPlan);
    p.household.primary = {
      currentAge: 73, retirementAge, planEndAge: 73, birthYear: 1953,
    };
    p.household.spouse = null;
    p.portfolio.accounts = {
      taxable: { balance: 0, basisPct: 1 },
      traditional: { balance: 10_000_000 },
      roth: { balance: 0 },
    };
    p.portfolio.extraAccounts = [];
    p.savings = { annual: 0, split: { taxable: 0, traditional: 0, roth: 0 } };
    p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
    p.income.other = [];
    p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
    p.expenses = {
      living: 0, housing: 0, debt: 0, healthcare: 0,
      healthcareRealGrowth: 0, extra: [],
    };
    p.goals = portfolioFundedGoal > 0 ? [{
      name: 'Pre-retirement outlay', amount: portfolioFundedGoal,
      startAge: 73, endAge: 73, fundFromPortfolioBeforeRetirement: true,
    }] : [];
    p.liabilities = [];
    p.properties = [];
    p.ltc = { amount: 0, onsetAge: 99 };
    return resolveInputs(p, {});
  };
  const rmd = 10_000_000 / 26.5;
  const assertGrossSpentRmd = (sim, expectedTax, phase) => {
    const row = sim.rows[0];
    assert.equal(row.phase, phase);
    assert.ok(Math.abs(row.rmdRequired - rmd) < 0.01);
    assert.ok(Math.abs(row.rmd - rmd) < 0.01);
    assert.deepEqual(row.rmdRequiredByOwner, { client: rmd, spouse: 0, unattributed: 0 });
    assert.equal(row.rmdGrossByOwner.client, 0, 'no spending withdrawal satisfies the RMD');
    assert.equal(row.rmdGrossByOwner.spouse, 0);
    assert.ok(Math.abs(row.accountWithdrawalsById['base-traditional'] - rmd) < 0.01);
    assert.equal(row.accountWithdrawalsById['base-taxable'] ?? 0, 0);
    assert.equal(row.accountWithdrawalsById['base-roth'] ?? 0, 0);
    assert.deepEqual(row.accountBalances, {
      taxable: 0,
      traditional: 10_000_000 - rmd,
      roth: 0,
    });
    assert.deepEqual(row.accountBalancesById, {
      'base-taxable': 0,
      'base-traditional': 10_000_000 - rmd,
      'base-roth': 0,
    });
    assert.equal(row.taxableStartingBasis, 0);
    assert.equal(row.taxableEndingBasis, 0);
    assert.equal(row.taxableCapitalGain, 0);
    assert.ok(Math.abs(row.taxes - expectedTax) < 0.01);
    assert.ok(Math.abs(sim.lifetimeTax - expectedTax) < 0.01);
    assert.ok(Math.abs(row.balance - (10_000_000 - rmd)) < 0.01);
    assert.ok(Math.abs(sim.terminalBalance - row.balance) < 0.01);
  };

  const normalInputs = build(73);
  const normal = runSinglePath(normalInputs, [flatAssetReturnRow(2026)]);
  assertGrossSpentRmd(normal, rmd * normalInputs.taxRates.ordinary, undefined);

  const federallyFunded = runSinglePath(normalInputs, [flatAssetReturnRow(2026)], {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });
  assertGrossSpentRmd(federallyFunded, 0, undefined);
  assert.equal(federallyFunded.rows[0].taxFundingConvergence.taxSavingsReinvested, 0,
    'a lower federal RMD liability must not recreate taxable cash');

  const accumulationInputs = build(74);
  const accumulation = runSinglePath(accumulationInputs, [flatAssetReturnRow(2026)]);
  assertGrossSpentRmd(accumulation, rmd * accumulationInputs.taxRates.ordinary, 'accum');

  const accumulationOutlayInputs = build(74, 100_000);
  const accumulationOutlay = runSinglePath(
    accumulationOutlayInputs,
    [flatAssetReturnRow(2026)],
  );
  const outlayRow = accumulationOutlay.rows[0];
  assert.ok(Math.abs(outlayRow.rmdRequired - rmd) < 0.01);
  assert.ok(Math.abs(outlayRow.rmd - (rmd - 100_000)) < 0.01,
    'only the RMD amount not satisfied by the Traditional outlay is forced');
  assert.equal(outlayRow.rmdGrossByOwner.client, 100_000);
  assert.ok(Math.abs(outlayRow.accountWithdrawalsById['base-traditional'] - rmd) < 0.01);
  assert.equal(outlayRow.accountBalances.traditional, 10_000_000 - rmd);
  assert.equal(outlayRow.accountBalances.taxable, 0);
  assert.equal(outlayRow.accountBalances.roth, 0);
  assert.ok(Math.abs(outlayRow.taxes - rmd * accumulationOutlayInputs.taxRates.ordinary) < 0.01);
  assert.ok(Math.abs(accumulationOutlay.lifetimeTax - outlayRow.taxes) < 0.01);

  const compactAccumulation = runSinglePath(accumulationInputs, [flatAssetReturnRow(2026)], {
    includeAccountDiagnostics: false,
  }).rows[0];
  assert.equal(compactAccumulation.rmdRequiredByOwner, undefined);
  assert.equal(compactAccumulation.rmdGrossByOwner, undefined);
});

test('engine rows separate total required RMD from the forced top-up', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 72, retirementAge: 72, planEndAge: 74 };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 10_000_000 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 100_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };
  const params = resolveInputs(p, {});
  const sim = runSinglePath(params, [
    flatAssetReturnRow(2025),
    flatAssetReturnRow(2026),
    flatAssetReturnRow(2027),
  ]);
  const pre73 = sim.rows.find(row => row.age === 72);
  const at73 = sim.rows.find(row => row.age === 73);
  assert.equal(pre73.rmdRequired, 0);
  assert.ok(at73.rmdRequired > 0);
  assert.ok(Math.abs(
    at73.rmdRequired - at73.accountStartingBalances.traditional / 26.5
  ) < 0.01);
  assert.ok(at73.accountBreakdown.traditional + at73.rmd >= at73.rmdRequired - 0.01);
  assert.deepEqual(at73.preTaxDeltaAccountBreakdown, at73.accountBreakdown);
  assert.ok(at73.rmd < at73.rmdRequired,
    'row.rmd remains only the portion forced beyond the spending withdrawal');
});

test('RMD cohort inference ignores prior-return years and unconfirmed birth dates', () => {
  const p = structuredClone(defaultPlan);
  const currentYear = 2026;
  p.meta.planningAsOfYear = currentYear;
  const boundaryAge = currentYear - 1960;
  p.household.primary = {
    currentAge: boundaryAge,
    retirementAge: boundaryAge,
    planEndAge: boundaryAge + 10,
  };
  p.incomeTax = { current1040: { taxYear: currentYear - 1 } };
  p.taxProfiles = {
    client: {
      birthDate: { value: '1960-01-01', status: 'unknown' },
    },
  };

  assert.strictEqual(resolveHouseholdTimeline(p).people.client.rmdStartAge, null);
  p.taxProfiles.client.birthDate.status = 'confirmed';
  assert.strictEqual(resolveHouseholdTimeline(p).people.client.rmdStartAge, 75);
  p.household.primary.birthYear = 1959;
  assert.strictEqual(resolveHouseholdTimeline(p).people.client.birthYear, 1960);
  assert.strictEqual(resolveHouseholdTimeline(p).people.client.rmdStartAge, null);
});

test('cash IRA distributions and Roth conversions remain separate RMD facts', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [
    {
      typeId: 'ira_distribution', owner: 'client', amount: 10_000,
      startAge: 65, endAge: 65, taxablePct: 1,
    },
    {
      typeId: 'roth_conversion', owner: 'client', amount: 20_000,
      startAge: 65, endAge: 65, taxablePct: 1,
    },
  ];

  const facts = householdIncomeAtYear(resolveInputs(p, {}), 0);
  assert.strictEqual(facts.iraDistributions, 30_000);
  assert.strictEqual(facts.iraCashDistributions, 10_000);
  assert.strictEqual(facts.rothConversions, 20_000);
  assert.strictEqual(facts.taxableIra, 30_000);
});

test('RMD uses the known Traditional-account owner age and refuses unknown couple ownership', () => {
  const spouseOwned = structuredClone(defaultPlan);
  spouseOwned.meta.filingStatus = 'marriedFilingJointly';
  spouseOwned.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  spouseOwned.household.spouse = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  spouseOwned.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  spouseOwned.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'spouse', balance: 265_000 }),
  ];
  spouseOwned.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: { pia: 0, claimAge: 67 } };
  spouseOwned.income.other = [];
  spouseOwned.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };

  const spouseRow = runHistoricalPath(spouseOwned, 1995, 'taxable-first').rows[0];
  assert.strictEqual(spouseRow.rmdOwner, 'spouse');
  assert.strictEqual(spouseRow.rmdAvailable, true);
  assert.ok(Math.abs(spouseRow.rmdRequired - 10_000) < 0.01);

  const youngerSpouse = structuredClone(spouseOwned);
  youngerSpouse.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  youngerSpouse.household.spouse = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  const youngerSpouseRow = runHistoricalPath(youngerSpouse, 1995, 'taxable-first').rows[0];
  assert.strictEqual(youngerSpouseRow.rmdRequired, 0);

  const unknownCouple = structuredClone(spouseOwned);
  unknownCouple.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  unknownCouple.portfolio.accounts.traditional.balance = 265_000;
  unknownCouple.portfolio.extraAccounts = [];
  assert.throws(
    () => runHistoricalPath(unknownCouple, 1995, 'taxable-first'),
    error => error?.code === 'HOUSEHOLD_RMD_UNAVAILABLE'
      && error.rmdIssue === 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE'
      && error.age === 73
  );
  assert.strictEqual(
    resolveWithdrawalPlannerAccountState(unknownCouple).limits.deferredWithdrawal.max,
    265_000,
    'current-year planner limits remain available even when full-plan RMD ownership is not'
  );

  const single = structuredClone(unknownCouple);
  single.meta.filingStatus = 'single';
  single.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  single.household.spouse = null;
  single.income.socialSecurity.spouse = null;
  const singleRow = runHistoricalPath(single, 1995, 'taxable-first').rows[0];
  assert.strictEqual(singleRow.rmdOwner, 'client');
  assert.ok(Math.abs(singleRow.rmdRequired - 10_000) < 0.01);
});

test('an older non-owner spouse does not create an RMD for a younger known owner', () => {
  const p = structuredClone(defaultPlan);
  const currentYear = 2026;
  p.meta.planningAsOfYear = currentYear;
  const ownerAge = currentYear - 1960;
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = {
    currentAge: ownerAge,
    retirementAge: ownerAge,
    planEndAge: ownerAge + 1,
  };
  p.household.spouse = { currentAge: 73, retirementAge: 73, planEndAge: 74 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 70 },
    spouse: { pia: 0, claimAge: 70 },
  };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];

  const rows = runHistoricalPath(p, 1995, 'taxable-first').rows;
  assert.strictEqual(rows[0].rmdRequired, 0);
  assert.strictEqual(rows[0].rmdAvailable, true);
  assert.strictEqual(rows[0].rmdOwner, 'client');
});

test('a known RMD owner receives required distributions during household accumulation years', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 73, retirementAge: 75, planEndAge: 75 };
  p.household.spouse = { currentAge: 65, retirementAge: 67, planEndAge: 67 };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };

  const first = runHistoricalPath(p, 1995, 'taxable-first').rows[0];
  assert.strictEqual(first.phase, 'accum');
  assert.strictEqual(first.rmdOwner, 'client');
  assert.ok(Math.abs(first.rmdRequired - 10_000) < 0.01);
  assert.ok(Math.abs(first.rmd - 10_000) < 0.01);
  assert.ok(first.taxBySource.traditional > 0);
  assert.ok(first.accountBalances.taxable <= 0.01,
    'an accumulation-year RMD is spent rather than added to taxable savings');
});

test('RMD applicable age follows the owner birth cohort', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 65,
    retirementAge: 65,
    planEndAge: 75,
    birthYear: 1961,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 246_000 }),
  ];
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 999 };
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };

  const rows = runSinglePath(
    resolveInputs(p, {}),
    Array.from({ length: 11 }, (_, index) => flatAssetReturnRow(2026 + index))
  ).rows;
  assert.strictEqual(rows.find(row => row.age === 73).rmdRequired, 0);
  assert.strictEqual(rows.find(row => row.age === 74).rmdRequired, 0);
  const at75 = rows.find(row => row.age === 75);
  assert.ok(Math.abs(
    at75.rmdRequired - at75.accountStartingBalances.traditional / 24.6
  ) < 0.01);
});

test('a working-owner employer plan does not receive an invented RMD', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = {
    currentAge: 73,
    retirementAge: 75,
    planEndAge: 75,
    birthYear: 1953,
  };
  p.household.spouse = null;
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('401k', { owner: 'client', balance: 265_000 }),
  ];

  assert.throws(
    () => runHistoricalPath(p, 1995, 'taxable-first'),
    error => error?.code === 'HOUSEHOLD_RMD_UNAVAILABLE'
      && error.rmdIssue === 'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE'
      && error.age === 73
  );
});

// Superseded: multi-owner pre-tax money used to abort the whole projection.
// Each spouse now gets their own RMD, off their own balance and their own age —
// a married couple who each own an IRA is the ordinary case, not an error.
test('multi-owner households project with a per-owner RMD each', () => {
  const multiOwner = structuredClone(defaultPlan);
  multiOwner.meta.filingStatus = 'marriedFilingJointly';
  multiOwner.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 75 };
  multiOwner.household.spouse = { currentAge: 65, retirementAge: 65, planEndAge: 67 };
  multiOwner.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  multiOwner.income.other = [];
  multiOwner.savings.annual = 0;
  multiOwner.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  multiOwner.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 132_500 }),
    createAccount('traditional_ira', { owner: 'spouse', balance: 132_500 }),
  ];
  multiOwner.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0, extra: [] };

  const rows = runHistoricalPath(multiOwner, 1995, 'taxable-first').rows;
  const first = rows[0];
  // Client is 73 and past their applicable age; spouse is 65 and not.
  assert.strictEqual(first.rmdAvailable, true);
  assert.ok(first.rmdRequired > 0, 'the client owes a distribution');
  assert.ok(first.rmdRequiredByOwner.client > 0, 'charged to the client');
  assert.strictEqual(first.rmdRequiredByOwner.spouse, 0, 'the spouse owes nothing yet');
  // No single household owner exists once two people hold pre-tax money.
  assert.strictEqual(first.rmdOwner, null);
  // Each requirement runs off that owner's own balance, not the household total.
  assert.ok(
    Math.abs(first.rmdRequiredByOwner.client - 132_500 / 26.5) < 1,
    'client RMD = their own $132,500 over the age-73 divisor'
  );

  assert.strictEqual(
    resolveWithdrawalPlannerAccountState(multiOwner).limits.deferredWithdrawal.max,
    265_000
  );
});

test('a surviving spouse receives a single-owner Traditional IRA by rollover', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 73, retirementAge: 73, planEndAge: 73, birthYear: 1953,
  };
  p.household.spouse = {
    currentAge: 65, retirementAge: 65, planEndAge: 80, birthYear: 1961,
  };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings.annual = 0;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('traditional_ira', { owner: 'client', balance: 265_000 }),
  ];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };

  const result = runHistoricalPath(p, 1995, 'taxable-first');
  const firstSurvivorRow = result.rows.find(row => row.age === 74);
  const survivorRmdRow = result.rows.find(row => row.people.spouse.age === 75);

  assert.strictEqual(firstSurvivorRow.rmdOwner, 'spouse');
  assert.strictEqual(firstSurvivorRow.rmdRequired, 0);
  assert.strictEqual(survivorRmdRow.rmdOwner, 'spouse');
  assert.ok(survivorRmdRow.rmdRequired > 0);
  assert.strictEqual(survivorRmdRow.rmdAvailable, true);
});

test('young spouses with two contributing 401(k)s keep a full projection after one owner dies', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 36, retirementAge: 65, planEndAge: 90, birthYear: 1990,
  };
  p.household.spouse = {
    currentAge: 33, retirementAge: 62, planEndAge: 95, birthYear: 1993,
  };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings = {
    annual: 24_000,
    split: { traditional: 1, roth: 0, taxable: 0 },
  };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('401k', { owner: 'client', balance: 265_000 }),
    createAccount('401k', { owner: 'spouse', balance: 185_000 }),
  ];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };

  const result = runHistoricalPath(p, 1995, 'taxable-first');
  const lastWorkingRow = result.rows.find(row => row.age === 64);
  const retirementRow = result.rows.find(row => row.age === 65);
  const firstSurvivorRow = result.rows.find(row => row.age === 91);
  const laterSurvivorRmdRow = result.rows.find(row => (
    row.people.spouse.alive && row.people.spouse.age === 89
  ));

  assert.equal(lastWorkingRow.phase, 'accum');
  assert.equal(lastWorkingRow.savings, 24_000);
  assert.notEqual(retirementRow.phase, 'accum');
  assert.equal(retirementRow.savings, undefined);
  assert.equal(firstSurvivorRow.people.client.alive, false);
  assert.equal(firstSurvivorRow.people.spouse.alive, true);
  assert.equal(firstSurvivorRow.rmdOwner, 'spouse');
  assert.equal(firstSurvivorRow.rmdAvailable, true);
  assert.equal(laterSurvivorRmdRow.rmdOwner, 'spouse');
  assert.ok(laterSurvivorRmdRow.rmdRequired > 0);
  assert.equal(result.rows.at(-1).age, 98);

  resetSeed();
  const resolved = resolveInputs(p, {});
  const simulation = runSimulation(
    p,
    {},
    [generateReturnPath(resolved.horizonYears, resolved.portfolio)],
  );
  assert.ok(Number.isFinite(simulation.successRate));
  assert.notEqual(simulation.projectionStatus, 'unavailable');
});

test('a zero-balance owned 401(k) can receive explicit savings and roll to the surviving spouse', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.meta.planningAsOfYear = 2026;
  p.household.primary = {
    currentAge: 66, retirementAge: 68, planEndAge: 70, birthYear: 1960,
  };
  p.household.spouse = {
    currentAge: 65, retirementAge: 70, planEndAge: 75, birthYear: 1961,
  };
  p.income.socialSecurity = {
    primary: { pia: 0, claimAge: 67 },
    spouse: { pia: 0, claimAge: 67 },
  };
  p.income.other = [];
  p.savings = {
    annual: 28_300,
    split: { traditional: 1, roth: 0, taxable: 0 },
    entries: [{
      id: 'savings_client_401k',
      typeId: '401k',
      label: '401(k) deferral',
      owner: 'client',
      amount: 28_300,
      bucket: 'traditional',
    }],
  };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    createAccount('401k', { owner: 'client', balance: 0 }),
  ];
  p.expenses = {
    living: 0, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };

  const resolved = resolveInputs(p, {});
  const result = runSinglePath(
    resolved,
    Array.from({ length: resolved.horizonYears }, (_, index) => flatAssetReturnRow(2026 + index)),
  );
  const firstWorkingRow = result.rows.find(row => row.age === 66);
  const firstSurvivorRow = result.rows.find(row => row.age === 71);

  assert.equal(firstWorkingRow.accountContributionsById[p.portfolio.extraAccounts[0].id], 28_300);
  assert.equal(firstSurvivorRow.people.client.alive, false);
  assert.equal(firstSurvivorRow.people.spouse.alive, true);
  assert.equal(firstSurvivorRow.accountStates[0].owner, 'spouse');
  assert.equal(firstSurvivorRow.rmdAvailable, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs, runSimulation } from '../../../engine.js';
import { createAccount } from '../../household/createAccount.js';
import { createBlankTaxProfiles } from '../../household/factEnvelope.js';
import { buildCurrentTaxBucketSnapshot } from '../taxBuckets/buildCurrentTaxBucketSnapshot.js';
import {
  FEDERAL_FUNDING_PATH_KEYS,
  buildFederalFundingPathSidecar,
} from './buildFederalFundingPathSidecar.js';
import { buildWithdrawalTaxCounterfactualContext } from './buildWithdrawalTaxCounterfactualContext.js';
import { runWithdrawalTaxCounterfactual } from './runWithdrawalTaxCounterfactual.js';

const BUCKET_KEYS = ['taxable', 'traditional', 'roth'];

function fixturePlan(){
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'single';
  plan.household.primary = { currentAge: 63, retirementAge: 65, planEndAge: 68 };
  plan.household.spouse = null;
  plan.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  plan.portfolio.extraAccounts = [
    {
      id: '401k', typeId: '401k', type: '401(k)', bucket: 'traditional', balance: 250000,
    },
    {
      id: 'inherited', typeId: 'inherited_traditional_ira',
      type: 'Inherited Traditional IRA', bucket: 'traditional', balance: 5000,
    },
    {
      id: 'hsa', typeId: 'hsa', type: 'HSA', bucket: 'roth', balance: 10000,
    },
    {
      id: '529', typeId: 'legacy_529', type: '529', bucket: 'roth', balance: 7000,
    },
  ];
  plan.savings = { annual: 0, split: { traditional: 1, roth: 0, taxable: 0 } };
  plan.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  plan.income.other = [];
  plan.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  plan.expenses = {
    living: 300000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  plan.liabilities = [];
  plan.properties = [];
  plan.goals = [];
  plan.ltc = { amount: 0, onsetAge: 85 };
  plan.simulation.iterations = 20;
  return plan;
}

function returnPaths(plan){
  const horizonYears = resolveInputs(plan, {}).horizonYears;
  return Array.from({ length: 20 }, (_, simIndex) =>
    Array.from({ length: horizonYears }, (_, yearIndex) => ({
      y: 2025 + yearIndex,
      proxyReturn: simIndex === 0 ? -0.01 : 0,
    }))
  );
}

function compactExpected(row, counterfactualContext){
  const phase = row.phase === 'accum'
    ? 'accumulation'
    : row.failed === true && row.source === null
      ? 'depleted'
      : 'retirement';
  return {
    year: row.year,
    age: row.age,
    phase,
    sourceYear: row.source ?? null,
    failed: row.failed,
    convergedFederalTax: phase === 'retirement' ? row.taxes : null,
    grossWithdrawal: row.withdrawal ?? 0,
    grossWithdrawalsByBucket: Object.fromEntries(
      BUCKET_KEYS.map(bucket => [bucket, row.accountBreakdown[bucket]])
    ),
    ...(phase === 'retirement' ? {
      rmdForced: row.rmd ?? 0,
      rmdRequired: row.rmdRequired,
      preTaxDeltaGrossWithdrawalsByBucket: row.preTaxDeltaAccountBreakdown,
      startingBalances: row.accountStartingBalances,
      taxableStartingBasis: row.taxableStartingBasis,
      taxableCapitalGain: row.taxableCapitalGain,
      withdrawalTaxCounterfactual: runWithdrawalTaxCounterfactual(
        row,
        counterfactualContext
      ),
      convergence: {
        status: 'converged',
        iterations: row.taxFundingConvergence.iterations,
        tolerance: row.taxFundingConvergence.tolerance,
        residual: row.taxFundingConvergence.residual,
        fundingAdjustment: row.taxFundingConvergence.fundingAdjustment,
        taxSavingsReinvested: row.taxFundingConvergence.taxSavingsReinvested,
      },
    } : {}),
    endingBalances: {
      ...Object.fromEntries(BUCKET_KEYS.map(bucket => [bucket, row.accountBalances[bucket]])),
      total: row.balance,
    },
  };
}

function buildFixture(){
  const plan = fixturePlan();
  const paths = returnPaths(plan);
  const shortcut = runSimulation(plan, {}, paths);
  const federal = runSimulation(plan, {}, paths, {
    taxPolicy: (_row, context) => context.shortcutTax + 10000,
    fundTaxPolicyDelta: true,
  });
  return { plan, shortcut, federal };
}

test('sidecar preserves compact converged federal-funded bucket paths', () => {
  const { plan, shortcut, federal } = buildFixture();
  const shortcutBefore = structuredClone(shortcut);
  const federalBefore = structuredClone(federal);
  const sidecar = buildFederalFundingPathSidecar(shortcut, federal, plan);
  const counterfactualContext = buildWithdrawalTaxCounterfactualContext(
    plan,
    shortcut.params
  );

  assert.equal(sidecar.schemaVersion, 3);
  assert.equal(sidecar.successRate, federal.successRate);
  assert.equal(sidecar.total, federal.total);
  assert.equal(sidecar.survived, federal.survived);
  assert.equal(sidecar.semantics.fundingMethod, 'signed-fixed-point');
  assert.equal(sidecar.semantics.convergence, 'per-year-to-one-cent');
  assert.equal(sidecar.semantics.pathSelection, 'federal-funded-selected-anchors');
  assert.equal(
    sidecar.semantics.lowerTaxTreatment,
    'reduce-withdrawals-then-reinvest-excess-tax-saving'
  );
  assert.equal(sidecar.semantics.balanceTiming, 'row-opening-and-row-ending');
  assert.deepEqual(sidecar.startingBalances, {
    source: 'resolved-engine-accounts',
    accountScope: 'engine-compatible',
    taxable: 0,
    traditional: 250000,
    roth: 17000,
    total: 267000,
  });
  assert.deepEqual(
    sidecar.projectionScope.currentOnlyRulesPendingAccounts.map(account => account.id),
    ['inherited']
  );
  assert.deepEqual(
    sidecar.projectionScope.outsideTaxBucketsButModeledAccounts.map(account => account.id),
    ['hsa', '529']
  );
  assert.equal(sidecar.projectionScope.status, 'ready-with-scope-difference');
  assert.equal(sidecar.projectionScope.balanceScope, 'scope-difference');
  const currentSnapshot = buildCurrentTaxBucketSnapshot(plan);
  assert.equal(currentSnapshot.buckets.traditional.balance, 255000);
  assert.equal(currentSnapshot.buckets.roth.balance, 0);
  assert.equal(sidecar.startingBalances.traditional, 250000,
    'rules-pending inherited balance must remain current-only');

  for(const pathKey of FEDERAL_FUNDING_PATH_KEYS){
    const anchor = federal.paths[pathKey];
    const funded = federal.sims.find(sim => sim.simIndex === anchor.simIndex);
    const shortcutSim = shortcut.sims.find(sim => sim.simIndex === anchor.simIndex);
    const compact = sidecar.paths[pathKey];
    assert.equal(funded.returnPath, anchor.returnPath);
    assert.equal(funded.returnPath, shortcutSim.returnPath);
    assert.equal(compact.simIndex, anchor.simIndex);
    assert.deepEqual(
      compact.rows,
      funded.rows.map(row => compactExpected(row, counterfactualContext))
    );
    for(const row of compact.rows){
      const balanceSum = BUCKET_KEYS.reduce((sum, key) => sum + row.endingBalances[key], 0);
      const withdrawalSum = BUCKET_KEYS.reduce(
        (sum, key) => sum + row.grossWithdrawalsByBucket[key],
        0
      );
      assert.ok(Math.abs(balanceSum - row.endingBalances.total) <= 0.01);
      assert.ok(Math.abs(withdrawalSum - row.grossWithdrawal) <= 0.01);
    }
  }

  const phases = sidecar.paths.p50.rows.map(row => row.phase);
  assert.deepEqual(phases, [
    'accumulation', 'accumulation', 'retirement', 'depleted', 'depleted', 'depleted',
  ]);
  assert.equal(sidecar.paths.p50.rows[0].convergedFederalTax, null);
  assert.ok(sidecar.paths.p50.rows[2].convergedFederalTax > 0);
  assert.equal(sidecar.paths.p50.rows[2].convergence.status, 'converged');
  assert.ok(Math.abs(sidecar.paths.p50.rows[2].convergence.residual) <= 0.01);
  assert.equal(
    sidecar.paths.p50.rows[2].withdrawalTaxCounterfactual.semantics.convergence,
    'converged'
  );
  assert.equal(
    sidecar.paths.p50.rows[2].withdrawalTaxCounterfactual.comparisonEligibility.reasonCodes
      .includes('PHASE_6_FUNDING_NOT_CONVERGED'),
    false
  );

  assert.deepEqual(shortcut, shortcutBefore);
  assert.deepEqual(federal, federalBefore);
  assert.deepEqual(sidecar, buildFederalFundingPathSidecar(shortcut, federal, plan));
  assert.equal(Object.isFrozen(sidecar), true);
  assert.equal(Object.isFrozen(sidecar.paths), true);
  assert.equal(Object.isFrozen(sidecar.paths.p50.rows), true);
  assert.equal(Object.isFrozen(sidecar.paths.p50.rows[0].endingBalances), true);
  assert.throws(() => { sidecar.paths.p50.rows[0].endingBalances.total = 1; }, TypeError);
});

test('sidecar carries the reconciled immutable Household tax-fact contract', () => {
  const plan = fixturePlan();
  plan.taxProfiles = createBlankTaxProfiles();
  const brokerage = createAccount('brokerage_taxable', { owner: 'client', balance: 200000 });
  brokerage.id = 'confirmed-brokerage';
  brokerage.basis = {
    amount: 50000,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-07-12T12:00:00Z',
    version: 1,
  };
  const employer = createAccount('401k', { owner: 'client', balance: 250000 });
  employer.id = 'current-401k';
  plan.portfolio.extraAccounts = [brokerage, employer];

  const paths = returnPaths(plan);
  const shortcut = runSimulation(plan, {}, paths);
  const federal = runSimulation(plan, {}, paths, {
    taxPolicy: (_row, context) => context.shortcutTax + 10000,
    fundTaxPolicyDelta: true,
  });
  const shortcutBefore = structuredClone(shortcut);
  const federalBefore = structuredClone(federal);
  const sidecar = buildFederalFundingPathSidecar(shortcut, federal, plan);

  assert.equal(
    sidecar.taxFacts.calculationInputs.taxableBasisOverride.amount,
    shortcut.params.accounts.taxable.basis
  );
  assert.deepEqual(
    sidecar.taxFacts.calculationInputs.taxableBasisOverride.accountIds,
    ['confirmed-brokerage']
  );
  assert.equal(sidecar.taxFacts.readiness.purpose, 'distribution-strategy-tax-comparison');
  assert.equal(Object.isFrozen(sidecar.taxFacts), true);
  assert.equal(Object.isFrozen(sidecar.taxFacts.readiness.gaps), true);
  assert.equal(Object.isFrozen(sidecar.taxFacts.calculationInputs.taxableBasisOverride.evidence), true);
  assert.deepEqual(shortcut, shortcutBefore);
  assert.deepEqual(federal, federalBefore);
});

test('duplicate shortcut anchors reuse one compact path without retaining all simulations', () => {
  const { plan, shortcut, federal } = buildFixture();
  const sidecar = buildFederalFundingPathSidecar(shortcut, federal, plan);
  const compactPaths = new Set(Object.values(sidecar.paths));
  const selectedSimIndexes = new Set(
    FEDERAL_FUNDING_PATH_KEYS.map(pathKey => federal.paths[pathKey].simIndex)
  );
  assert.equal(compactPaths.size, selectedSimIndexes.size);
  assert.equal('sims' in sidecar, false);
  for(const pathKey of FEDERAL_FUNDING_PATH_KEYS){
    for(const otherKey of FEDERAL_FUNDING_PATH_KEYS){
      if(federal.paths[pathKey].simIndex === federal.paths[otherKey].simIndex){
        assert.equal(sidecar.paths[pathKey], sidecar.paths[otherKey]);
      }
    }
  }
});

test('mismatched params and cloned return paths fail closed', () => {
  const { plan, shortcut, federal } = buildFixture();
  const mismatchedParams = {
    ...federal,
    params: { ...federal.params, currentAge: federal.params.currentAge + 1 },
  };
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, mismatchedParams, plan),
    /params must match/
  );

  const clonedReturnPath = {
    ...federal,
    sims: federal.sims.map((sim, index) => index === 0
      ? { ...sim, returnPath: [...sim.returnPath] }
      : sim),
  };
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, clonedReturnPath, plan),
    /preserve shortcut simIndex and returnPath identity/
  );
});

test('zero delta preserves funding while lower federal tax reduces the final-funded draw', () => {
  const plan = fixturePlan();
  plan.expenses.living = 100000;
  const paths = returnPaths(plan);
  const shortcut = runSimulation(plan, {}, paths);
  const unchanged = runSimulation(plan, {}, paths, {
    taxPolicy: (_row, context) => context.shortcutTax,
    fundTaxPolicyDelta: true,
  });
  const lowerTax = runSimulation(plan, {}, paths, {
    taxPolicy: (_row, context) => Math.max(0, context.shortcutTax - 10000),
    fundTaxPolicyDelta: true,
  });
  const unchangedSidecar = buildFederalFundingPathSidecar(shortcut, unchanged, plan);
  const lowerSidecar = buildFederalFundingPathSidecar(shortcut, lowerTax, plan);

  for(const compact of Object.values(unchangedSidecar.paths)){
    const shortcutSim = shortcut.sims.find(sim => sim.simIndex === compact.simIndex);
    assert.deepEqual(
      compact.rows.map(row => row.endingBalances),
      shortcutSim.rows.map(row => ({ ...row.accountBalances, total: row.balance }))
    );
  }
  for(const compact of Object.values(lowerSidecar.paths)){
    const shortcutSim = shortcut.sims.find(sim => sim.simIndex === compact.simIndex);
    const fundedRetirement = compact.rows.find(row => row.phase === 'retirement');
    const shortcutRetirement = shortcutSim.rows.find(row => row.phase !== 'accum');
    assert.ok(fundedRetirement.grossWithdrawal < shortcutRetirement.withdrawal);
    assert.ok(fundedRetirement.endingBalances.total > shortcutRetirement.balance);
    assert.ok(fundedRetirement.convergence.fundingAdjustment < 0);
  }
});

test('sidecar rejects retirement rows without proven convergence metadata', () => {
  const { plan, shortcut, federal } = buildFixture();
  const selectedIndex = federal.paths.p50.simIndex;
  const missingConvergence = {
    ...federal,
    sims: federal.sims.map(sim => sim.simIndex === selectedIndex
      ? {
          ...sim,
          rows: sim.rows.map(row => row.phase === 'accum'
            ? row
            : { ...row, taxFundingConvergence: undefined }),
        }
      : sim),
  };
  missingConvergence.paths = {
    ...federal.paths,
    p50: missingConvergence.sims.find(sim => sim.simIndex === selectedIndex),
  };
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, missingConvergence, plan),
    /taxFundingConvergence must be a plain object/
  );
});

test('selected rows with unreconciled bucket totals fail closed', () => {
  const { plan, shortcut, federal } = buildFixture();
  const selectedIndex = federal.paths.p50.simIndex;
  const invalid = {
    ...federal,
    sims: federal.sims.map(sim => sim.simIndex === selectedIndex
      ? {
          ...sim,
          rows: sim.rows.map((row, index) => index === 0
            ? {
                ...row,
                accountBalances: {
                  ...row.accountBalances,
                  taxable: row.accountBalances.taxable + 100,
                },
              }
            : row),
        }
      : sim),
  };
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, invalid, plan),
    /accountBalances does not reconcile/
  );
});

test('mismatched scope plan, invalid phase, and invalid market source fail closed', () => {
  const { plan, shortcut, federal } = buildFixture();
  const mismatchedPlan = structuredClone(plan);
  mismatchedPlan.portfolio.accounts.traditional.balance += 1;
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, federal, mismatchedPlan),
    /plan and overrides must match/
  );

  const selectedIndex = federal.paths.p50.simIndex;
  const invalidFederal = (change) => ({
    ...federal,
    sims: federal.sims.map(sim => sim.simIndex === selectedIndex
      ? {
          ...sim,
          rows: sim.rows.map((row, index) => index === 2 ? { ...row, ...change } : row),
        }
      : sim),
  });
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, invalidFederal({ phase: 'future' }), plan),
    /phase is invalid/
  );
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, invalidFederal({ source: 'not-a-year' }), plan),
    /source must be an integer year or null/
  );
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, invalidFederal({ source: 1900 }), plan),
    /source must match the funded return path/
  );
});

test('household issues block sidecar readiness without hiding scope differences', () => {
  const plan = fixturePlan();
  plan.portfolio.accounts.taxable.balance = 100;
  const paths = returnPaths(plan);
  const shortcut = runSimulation(plan, {}, paths);
  const federal = runSimulation(plan, {}, paths, {
    taxPolicy: (_row, context) => context.shortcutTax + 10000,
    fundTaxPolicyDelta: true,
  });
  const sidecar = buildFederalFundingPathSidecar(shortcut, federal, plan);

  assert.equal(sidecar.projectionScope.status, 'blocked-household-issues');
  assert.equal(sidecar.projectionScope.balanceScope, 'scope-difference');
  assert.deepEqual(sidecar.projectionScope.householdIssues, ['LEGACY_TYPED_OVERLAP']);
});

test('depletion metadata must match the first real failure row', () => {
  const { plan, shortcut, federal } = buildFixture();
  const selectedIndex = federal.paths.p50.simIndex;
  const invalid = {
    ...federal,
    sims: federal.sims.map(sim => sim.simIndex === selectedIndex
      ? { ...sim, depletionAge: sim.depletionAge + 1 }
      : sim),
  };
  assert.throws(
    () => buildFederalFundingPathSidecar(shortcut, invalid, plan),
    /depletionAge must match the first real failure row/
  );
});

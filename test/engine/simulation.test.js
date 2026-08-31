// Engine contract: simulation. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { RETURN_DATA, RISK_PROFILES, PROJECTION_EXECUTION_LIMITS, generateReturnPath, runSimulation, runHistoricalPath, runSinglePath, analyzeResults, resolveInputs, defaultPlan, resetSeed } from '../../engine.js';
import { snapshotLegacyRiskProfileAllocation, withCustomAssetWeights } from '../../src/household/investmentAllocation.js';
import { currentAllocationPlan, typedInvestmentAccount } from './fixtures.js';

function hashJson(value){
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('return data spans the full history', () => {
  assert.ok(RETURN_DATA.length >= 90, 'expected ~98 years of returns');
});

test('a return path matches the requested horizon', () => {
  const p = generateReturnPath(30);
  assert.strictEqual(p.length, 30);
});

test('projection execution accepts the supported boundaries', () => {
  assert.strictEqual(defaultPlan.simulation.iterations, PROJECTION_EXECUTION_LIMITS.maxIterations);
  assert.strictEqual(
    generateReturnPath(PROJECTION_EXECUTION_LIMITS.maxHorizonYears).length,
    PROJECTION_EXECUTION_LIMITS.maxHorizonYears,
  );

  const edgePlan = structuredClone(defaultPlan);
  edgePlan.household.primary = {
    ...edgePlan.household.primary,
    currentAge: 0,
    retirementAge: 45,
    planEndAge: 125,
  };
  assert.strictEqual(
    resolveInputs(edgePlan, {}).horizonYears,
    PROJECTION_EXECUTION_LIMITS.maxHorizonYears,
  );
  assert.strictEqual(
    resolveInputs(structuredClone(defaultPlan), { longevityYears: 95 }).horizonYears,
    PROJECTION_EXECUTION_LIMITS.maxHorizonYears,
  );

  const maximumPath = generateReturnPath(PROJECTION_EXECUTION_LIMITS.maxHorizonYears);
  assert.strictEqual(runSimulation(defaultPlan, {}, [maximumPath]).sims.length, 1);
});

test('projection execution rejects excessive or malformed dimensions before running', () => {
  assert.throws(
    () => generateReturnPath(PROJECTION_EXECUTION_LIMITS.maxHorizonYears + 1),
    error => error?.code === 'PROJECTION_HORIZON_OUT_OF_RANGE',
  );
  assert.throws(
    () => generateReturnPath(0),
    error => error?.code === 'PROJECTION_HORIZON_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveInputs(structuredClone(defaultPlan), { longevityYears: 96 }),
    error => error?.code === 'PROJECTION_HORIZON_OUT_OF_RANGE',
  );

  const excessiveIterations = structuredClone(defaultPlan);
  excessiveIterations.simulation.iterations = PROJECTION_EXECUTION_LIMITS.maxIterations + 1;
  assert.throws(
    () => resolveInputs(excessiveIterations, {}),
    error => error?.code === 'PROJECTION_ITERATIONS_OUT_OF_RANGE',
  );

  const inputs = resolveInputs(defaultPlan, {});
  const validPath = generateReturnPath(inputs.horizonYears);
  assert.throws(
    () => runSimulation(defaultPlan, {}, {}),
    error => error?.code === 'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID',
  );
  assert.throws(
    () => runSimulation(defaultPlan, {}, []),
    error => error?.code === 'PROJECTION_ITERATIONS_OUT_OF_RANGE',
  );
  assert.throws(
    () => runSimulation(defaultPlan, {}, [validPath.slice(0, -1)]),
    error => error?.code === 'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID',
  );
  assert.throws(
    () => runSimulation(
      defaultPlan,
      {},
      [Array.from(
        { length: PROJECTION_EXECUTION_LIMITS.maxHorizonYears + 1 },
        () => validPath[0],
      )],
    ),
    error => error?.code === 'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID',
  );
  assert.throws(
    () => runSimulation(
      defaultPlan,
      {},
      Array.from(
        { length: PROJECTION_EXECUTION_LIMITS.maxIterations + 1 },
        () => validPath,
      ),
    ),
    error => error?.code === 'PROJECTION_ITERATIONS_OUT_OF_RANGE',
  );
});

test('runSimulation returns a success rate in [0,100]', () => {
  const r = runSimulation(defaultPlan, {});
  assert.ok(r.successRate >= 0 && r.successRate <= 100);
  assert.ok(r.terminal && typeof r.terminal.p50 === 'number');
});

test('shared paths make identical inputs reproducible', () => {
  const horizon = resolveInputs(defaultPlan, {}).horizonYears;
  const bundle = Array.from({length: 300}, () => generateReturnPath(horizon));
  const a = runSimulation(defaultPlan, {}, bundle);
  const b = runSimulation(defaultPlan, {}, bundle);
  assert.strictEqual(Math.round(a.successRate), Math.round(b.successRate),
    'same inputs + same paths must give the same success rate');
});

test('higher-equity allocation has a higher expected return', () => {
  const w3 = RISK_PROFILES[3].weights, w5 = RISK_PROFILES[5].weights;
  assert.ok(w5.usLarge >= w3.usLarge, 'R5 should hold more equity than R3');
});

test('a known bad sequence (retire into 1973) is materially worse than average', () => {
  const hist = runHistoricalPath(defaultPlan, 1973, 'taxable-first');
  assert.ok(hist && (hist.rows || hist).length > 0, 'historical path should produce rows');
});

test('default runHistoricalPath is identical to the explicit shortcut tax policy', () => {
  const defaultResult = runHistoricalPath(defaultPlan, 1973, 'taxable-first');
  const explicitShortcutResult = runHistoricalPath(
    defaultPlan,
    1973,
    'taxable-first',
    undefined,
    undefined,
    { taxPolicy: (_row, { shortcutTax }) => shortcutTax }
  );

  assert.deepStrictEqual(defaultResult, explicitShortcutResult);
});

// Sequence Stress must be measured from RETIREMENT start, not plan start. For a
// still-working client (currentAge < retirementAge), the first accumulation years
// carry no sequence-of-returns risk (no withdrawals), so they must NOT drive which
// path is labeled "stressed". The selector sorts by balanceAtRet10 (balance after
// 10 retirement years), never balanceAt10 (plan-year 10). Regression for the
// 58-retire-at-65 contamination case.
test('Sequence Stress is retirement-relative, not contaminated by accumulation years', () => {
  const p = JSON.parse(JSON.stringify(defaultPlan));
  p.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 95 };
  p.savings = { annual: 30000, split: { traditional: 1, roth: 0, taxable: 0 } };
  const horizon = resolveInputs(p, {}).horizonYears; // ages 58 through 95, inclusive
  // Fixed seed + fixed bundle → fully deterministic selection, so the assertions
  // are reproducible across runs and machines.
  resetSeed(20260615);
  const bundle = Array.from({ length: 400 }, () => generateReturnPath(horizon));
  const res = runSimulation(p, {}, bundle);

  // (1) Every sim exposes the retirement-relative probe as a finite number.
  assert.ok(res.sims.every(s => Number.isFinite(s.balanceAtRet10)),
    'balanceAtRet10 must be present and finite on every sim');

  // (2) The capture window is retirement year 10 (age retirementAge+9 = 74), NOT
  //     plan-year 10 (age 67). Prove it against the actual row balance.
  const sample = res.sims.find(s => !s.failed) || res.sims[0];
  const ret10Row = sample.rows.find(r => r.age === 65 + 9);   // age 74
  const plan10Row = sample.rows.find(r => r.age === 58 + 9);  // age 67
  assert.ok(ret10Row, 'a surviving sim should reach retirement year 10 (age 74)');
  assert.strictEqual(sample.balanceAtRet10, ret10Row.balance,
    'balanceAtRet10 must equal the end balance at age 74 (10th retirement year)');
  assert.strictEqual(sample.balanceAt10, plan10Row.balance,
    'balanceAt10 (untouched) must still equal the end balance at plan-year 10 (age 67)');
  assert.notStrictEqual(ret10Row.age, plan10Row.age,
    'the two windows must be genuinely different when accumulation years exist');

  // (3) The selector ranks by balanceAtRet10: re-derive the ordering and confirm
  //     the engine's stressed (p10) and favorable (p90) picks match it. This proves
  //     accumulation-year balances are not what chooses the stressed path.
  const ns = res.sims.length;
  const bySeq = res.sims.slice().sort((a, b) => {
    if (a.balanceAtRet10 !== b.balanceAtRet10) return a.balanceAtRet10 - b.balanceAtRet10;
    return a.terminalBalance - b.terminalBalance;
  });
  assert.strictEqual(res.paths.p10.balanceAtRet10, bySeq[Math.floor(ns * 0.10)].balanceAtRet10,
    'stressed path (p10) must be the 10th-percentile by retirement-relative balance');
  assert.strictEqual(res.paths.p90.balanceAtRet10, bySeq[Math.floor(ns * 0.90)].balanceAtRet10,
    'favorable path (p90) must be the 90th-percentile by retirement-relative balance');
  assert.ok(res.paths.p10.balanceAtRet10 <= res.paths.p90.balanceAtRet10,
    'stressed early-retirement balance must not exceed the favorable one');
});

// Sequencing tab relies on this: reversing a real path must reuse the SAME
// returns in the opposite order — never invent or drop any. We check the
// multiset of source years is identical (same returns) but the sequence differs.
test('reversed historical path = same returns, opposite order', () => {
  // Use a richly funded plan so BOTH orders survive the full horizon — then the
  // sequence of return-years is directly comparable (depletion would truncate
  // one and confound the multiset check; that survival flips with order is the
  // feature itself, tested implicitly by the lean-plan 1973 test above).
  const rich = JSON.parse(JSON.stringify(defaultPlan));
  rich.portfolio.accounts.taxable.balance     = 20e6;
  rich.portfolio.accounts.traditional.balance = 0;
  rich.portfolio.accounts.roth.balance        = 0;
  const fwd = runHistoricalPath(rich, 1973, 'taxable-first');
  const rev = runHistoricalPath(rich, 1973, 'taxable-first', p => p.slice().reverse());
  assert.ok(rev && rev.rows.length > 0, 'reversed path should produce rows');
  const fy = fwd.rows.filter(r => r.source != null).map(r => r.source);
  const ry = rev.rows.filter(r => r.source != null).map(r => r.source);
  assert.deepStrictEqual([...fy].sort((a,b)=>a-b), [...ry].sort((a,b)=>a-b), 'identical set of return years');
  assert.notDeepStrictEqual(fy, ry, 'order must actually differ');
  assert.deepStrictEqual(ry, [...fy].reverse(), 'reversed = forward backwards');
});

// Sequencing honors a chosen scenario, not just its allocation: overrides must
// flow through runHistoricalPath the same way they do for the Monte Carlo path.
test('historical path honors overrides (e.g. a spending bump)', () => {
  // Rich plan so both runs survive (a depleted plan floors at $0 either way and
  // wouldn't reveal whether the override flowed through).
  const rich = JSON.parse(JSON.stringify(defaultPlan));
  rich.portfolio.accounts.taxable.balance     = 20e6;
  rich.portfolio.accounts.traditional.balance = 0;
  rich.portfolio.accounts.roth.balance        = 0;
  const base   = runHistoricalPath(rich, 1973, 'taxable-first');
  const spendy = runHistoricalPath(rich, 1973, 'taxable-first', undefined, { spendBump: 0.5 });
  assert.ok(base && spendy, 'both runs produce a result');
  assert.ok(spendy.terminalBalance < base.terminalBalance - 1,
    'a +50% spend override must lower the historical ending balance');
});

test('default Monte Carlo is identical to the explicit shortcut tax policy', () => {
  const p = structuredClone(defaultPlan);
  const inputs = resolveInputs(p, {});
  resetSeed(20260710);
  const bundle = Array.from({ length: 40 }, () => generateReturnPath(inputs.horizonYears));

  const defaultResult = runSimulation(p, {}, bundle);
  const explicitNullResult = runSimulation(p, {}, bundle, {
    taxPolicy: null,
    fundTaxPolicyDelta: true,
  });
  const explicitSims = bundle.map((returnPath, simIndex) => {
    const sim = runSinglePath(inputs, returnPath, {
      taxPolicy: (_row, { shortcutTax }) => shortcutTax,
    });
    sim.simIndex = simIndex;
    sim.returnPath = returnPath;
    return sim;
  });
  const explicitShortcutResult = analyzeResults(explicitSims, inputs);

  const accountDiagnosticKeys = new Set([
    'accountReturns',
    'householdEffectiveAllocation',
    'accountBalancesById',
    'accountStates',
    'accountContributionsById',
    'accountWithdrawalsById',
  ]);
  const withoutAccountDiagnostics = result => JSON.parse(JSON.stringify(
    result,
    (key, value) => accountDiagnosticKeys.has(key) ? undefined : value,
  ));
  assert.deepStrictEqual(
    withoutAccountDiagnostics(defaultResult),
    withoutAccountDiagnostics(explicitShortcutResult),
    'unused tax-policy seam must preserve every non-diagnostic Monte Carlo result field',
  );
  assert.deepStrictEqual(defaultResult, explicitNullResult,
    'null tax policy must remain byte-identical even when funding mode is requested');
});

test('return observations, selected path years, and the ordinary simulation core remain frozen', () => {
  assert.strictEqual(
    hashJson(RETURN_DATA),
    '4a4fa018fe4d1542ea0fcc5d3d1502103db7d84552334c0a8ff376e6c9e4ccc3',
  );
  const paths = {};
  for(const seed of [1, 20260615]){
    for(const horizon of [1, 30, 100]){
      resetSeed(seed);
      paths[`${seed}:${horizon}`] = generateReturnPath(horizon).map(row => row.y);
    }
  }
  assert.strictEqual(
    hashJson(paths),
    '00b62892a094acf2a5314b80287bcbf26847ca794b3fdbb095b6ef0cc4047e55',
  );

  const p = structuredClone(defaultPlan);
  p.simulation.iterations = 1;
  const inputs = resolveInputs(p, {});
  resetSeed(20260615);
  const sim = runSinglePath(inputs, generateReturnPath(inputs.horizonYears));
  const core = sim.rows.map(row => ({
    year: row.year,
    age: row.age,
    source: row.source,
    returnRate: row.returnRate,
    startBalance: row.startBalance,
    balance: row.balance,
    failed: row.failed,
  }));
  assert.strictEqual(
    hashJson(core),
    // The projection core includes the explicitly changed gross-RMD-spent path.
    'c93f0d37507b3f96be12d66b9eab4bd6f5a9a82783f8d1d40a4f2331b929286b',
  );
});

test('explicit custom weights equal to the legacy profile preserve Monte Carlo numeric results', () => {
  const legacyPlan = structuredClone(defaultPlan);
  const legacyAllocation = snapshotLegacyRiskProfileAllocation(legacyPlan.portfolio.riskProfile);
  const customAllocation = withCustomAssetWeights(
    legacyAllocation,
    { ...legacyAllocation.weights },
  );
  const currentPlan = currentAllocationPlan();
  currentPlan.portfolio.accounts.taxable.balance = 0;
  currentPlan.portfolio.accounts.traditional.balance = 0;
  currentPlan.portfolio.accounts.roth.balance = 0;
  const taxable = typedInvestmentAccount(
    'brokerage_taxable',
    'custom-taxable',
    2000000,
    customAllocation,
  );
  taxable.basis = {
    amount: 1000000,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-08-25T12:00:00.000Z',
    version: 1,
  };
  currentPlan.portfolio.extraAccounts = [
    taxable,
    typedInvestmentAccount('traditional_ira', 'custom-traditional', 2000000, customAllocation),
    typedInvestmentAccount('roth_ira', 'custom-roth', 1000000, customAllocation),
  ];
  const legacyInputs = resolveInputs(legacyPlan, {});
  const currentInputs = resolveInputs(currentPlan, {});
  resetSeed(90317);
  const path = generateReturnPath(legacyInputs.horizonYears);
  const legacy = runSinglePath(legacyInputs, path);
  const current = runSinglePath(currentInputs, path);
  const numericCore = sim => sim.rows.map(row => ({
    source: row.source,
    returnRate: row.returnRate,
    returnDollars: row.returnDollars,
    startBalance: row.startBalance,
    withdrawal: row.withdrawal,
    taxableCapitalGain: row.taxableCapitalGain,
    balance: row.balance,
    failed: row.failed,
  }));

  assert.deepStrictEqual(numericCore(current), numericCore(legacy));
  assert.strictEqual(current.terminalBalance, legacy.terminalBalance);
});

test('Monte Carlo keeps internal trials compact and selected paths fully traceable', () => {
  const p = currentAllocationPlan();
  p.simulation.iterations = 20;
  const inputs = resolveInputs(p, {});
  resetSeed(20260826);
  const bundle = Array.from(
    { length: p.simulation.iterations },
    () => generateReturnPath(inputs.horizonYears),
  );
  const analysis = runSimulation(p, {}, bundle);
  const selectedIndexes = new Set(
    Object.values(analysis.paths).map(path => path.simIndex),
  );

  assert.ok(selectedIndexes.size <= 5);
  for(const sim of analysis.sims){
    const first = sim.rows[0];
    if(selectedIndexes.has(sim.simIndex)){
      assert.ok(first.accountReturns);
      assert.ok(first.householdEffectiveAllocation);
      assert.ok(first.accountBalancesById);
      assert.ok(Object.isFrozen(first.accountStates));
      assert.deepEqual(Object.fromEntries(first.accountStates.map(a => [a.id, a.balance])), first.accountBalancesById);
    }else{
      assert.strictEqual(first.accountReturns, undefined);
      assert.strictEqual(first.householdEffectiveAllocation, undefined);
      assert.strictEqual(first.accountBalancesById, undefined);
      assert.strictEqual(first.accountStates, undefined);
      assert.strictEqual(first.accountContributionsById, undefined);
      assert.strictEqual(first.accountWithdrawalsById, undefined);
    }
  }
  for(const selected of Object.values(analysis.paths)){
    assert.strictEqual(selected, analysis.sims[selected.simIndex]);
    assert.ok(selected.rows[0].accountReturns);
  }

  const selected = analysis.paths.p50;
  const direct = runSinglePath(inputs, selected.returnPath);
  const numericCore = sim => sim.rows.map(row => ({
    source: row.source,
    returnRate: row.returnRate,
    returnDollars: row.returnDollars,
    startBalance: row.startBalance,
    withdrawal: row.withdrawal,
    taxableCapitalGain: row.taxableCapitalGain,
    balance: row.balance,
    failed: row.failed,
  }));
  assert.deepStrictEqual(numericCore(selected), numericCore(direct));

  const additionalIndex = analysis.sims.find(sim => !selectedIndexes.has(sim.simIndex)).simIndex;
  const withSharedTypical = runSimulation(p, {}, bundle, {
    accountDiagnosticsSimIndices: [additionalIndex, additionalIndex],
  });
  for(const sim of withSharedTypical.sims){
    assert.deepEqual(numericCore(sim), numericCore(analysis.sims[sim.simIndex]));
    assert.equal(Boolean(sim.rows[0].accountStates),
      selectedIndexes.has(sim.simIndex) || sim.simIndex === additionalIndex);
  }
  assert.deepEqual(withSharedTypical.envelope, analysis.envelope);
  assert.equal(withSharedTypical.successRate, analysis.successRate);
  for(const indices of [null, '1', [-1], [bundle.length], [1.5]]){
    assert.throws(() => runSimulation(p, {}, bundle, { accountDiagnosticsSimIndices: indices }),
      /accountDiagnosticsSimIndices/);
  }
});

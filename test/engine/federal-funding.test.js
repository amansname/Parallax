// Engine contract: federal funding. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { runSinglePath, resolveInputs, defaultPlan } from '../../engine.js';
import { createFederalTaxResolver } from '../../src/planning/tax/createFederalTaxResolver.js';
import { createAccount } from '../../src/household/createAccount.js';
import { flatAssetReturnRow } from './fixtures.js';

function explicitlyBasedBrokerage(balance, basisAmount){
  const account = createAccount('brokerage_taxable', {
    owner: 'client',
    balance,
  });
  account.basis = {
    amount: basisAmount,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-08-19T12:00:00.000Z',
    version: 1,
  };
  return account;
}

test('reporting-only federal policy sets accumulation row taxes to Form 1040 line 24', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'marriedFilingJointly';
  p.household.primary = { currentAge: 64, retirementAge: 66, planEndAge: 68 };
  p.household.spouse = { currentAge: 63, retirementAge: 65, planEndAge: 67 };
  p.portfolio.accounts = {
    taxable: { balance: 1000000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: { pia: 0, claimAge: 67 } };
  p.income.other = [
    { label: 'Client wages', amount: 90000, startAge: 64, endAge: 65, taxablePct: 1 },
    { label: 'Co-client wages', amount: 90000, startAge: 63, endAge: 64, taxablePct: 1 },
  ];
  p.income.pension = { benefitByAge: {}, startAge: 65, colaPct: 0 };
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0 };
  p.goals = [];

  const inputs = resolveInputs(p, {});
  const returnPath = Array.from(
    { length: inputs.horizonYears },
    (_, index) => flatAssetReturnRow(2026 + index),
  );
  const shortcutPath = runSinglePath(inputs, returnPath);
  const federalResolver = createFederalTaxResolver(inputs, {
    filingStatus: 'marriedFilingJointly',
    baseTaxYear: 2026,
    scenarioId: 'accum_federal_reporting_test',
  });
  const federalPath = runSinglePath(inputs, returnPath, { taxPolicy: federalResolver });
  const accumRows = federalPath.rows.filter((row) => row.phase === 'accum' && row.otherIncome > 0);

  assert.ok(accumRows.length >= 2, 'fixture must include multiple accumulation income years');
  for(const row of accumRows){
    const expected = federalResolver(row);
    assert.ok(Math.abs(row.taxes - expected) < 0.01,
      `age ${row.age} must report federal line 24 on accumulation rows`);
    assert.ok(row.taxes > 0, `age ${row.age} must carry a positive federal tax`);
  }
  assert.ok(
    federalPath.rows.some((row, index) => row.taxes !== shortcutPath.rows[index].taxes),
    'federal reporting must differ from shortcut on at least one accumulation row'
  );
});

test('opt-in single path reports federal line 24 as row tax', () => {
  const p = structuredClone(defaultPlan);
  p.meta.filingStatus = 'single';
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 68 };
  p.portfolio.accounts = {
    taxable: { balance: 10000000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [{ label: 'Taxable income', amount: 100000, startAge: 65, endAge: 68, taxablePct: 1 }];
  p.income.pension = { benefitByAge: {}, startAge: 65, colaPct: 0 };
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0 };
  p.goals = [];

  const inputs = resolveInputs(p, {});
  const returnPath = Array.from(
    { length: inputs.horizonYears },
    (_, index) => flatAssetReturnRow(2026 + index),
  );
  const shortcutPath = runSinglePath(inputs, returnPath);
  const federalResolver = createFederalTaxResolver(inputs, {
    filingStatus: 'single',
    baseTaxYear: 2026,
    scenarioId: 't6_engine_policy_test',
  });
  const expectedFederalTax = shortcutPath.rows.map((row) => federalResolver(row));
  const federalPath = runSinglePath(inputs, returnPath, { taxPolicy: federalResolver });

  assert.deepStrictEqual(federalPath.rows.map((row) => row.taxes), expectedFederalTax,
    'every wired row tax must equal federal Form 1040 line 24');
  assert.ok(federalPath.rows.some((row, index) => row.taxes !== shortcutPath.rows[index].taxes),
    'fixture must prove the federal resolver differs from the shortcut');
  assert.ok(Math.abs(
    federalPath.lifetimeTax - federalPath.rows.reduce((sum, row) => sum + row.taxes, 0)
  ) < 0.01, 'single-path lifetime tax must follow resolved federal row taxes');
});

test('tax-policy funding mode grosses up a positive delta before depletion', () => {
  const build = (balance, living, bucket = 'taxable') => {
    const p = structuredClone(defaultPlan);
    p.meta.filingStatus = 'single';
    p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
    p.household.spouse = null;
    p.portfolio.accounts = {
      taxable: { balance: 0, basisPct: 1 },
      traditional: { balance: bucket === 'traditional' ? balance : 0 },
      roth: { balance: 0 },
    };
    p.portfolio.extraAccounts = bucket === 'taxable'
      ? [explicitlyBasedBrokerage(balance, balance)]
      : [];
    p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
    p.income.other = [];
    p.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
    p.expenses = {
      living,
      housing: 0,
      debt: 0,
      healthcare: 0,
      healthcareRealGrowth: 0,
      extra: [],
    };
    p.liabilities = [];
    p.properties = [];
    p.goals = [];
    p.ltc = { amount: 0, onsetAge: 85 };
    return resolveInputs(p, {});
  };
  const returnPath = [flatAssetReturnRow(2026)];

  const ampleInputs = build(100000, 10000);
  const shortcut = runSinglePath(ampleInputs, returnPath);
  const reportingOnly = runSinglePath(ampleInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 5000,
  });
  const funded = runSinglePath(ampleInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 5000,
    fundTaxPolicyDelta: true,
  });

  assert.strictEqual(reportingOnly.rows[0].withdrawal, shortcut.rows[0].withdrawal,
    'reporting-only T7 mode must keep shortcut funding unchanged');
  assert.strictEqual(reportingOnly.terminalBalance, shortcut.terminalBalance);
  assert.strictEqual(funded.rows[0].withdrawal, shortcut.rows[0].withdrawal + 5000,
    'positive resolved-tax delta must create an additional portfolio withdrawal');
  assert.strictEqual(funded.terminalBalance, shortcut.terminalBalance - 5000);
  assert.strictEqual(funded.rows[0].taxes, shortcut.rows[0].taxes + 5000);
  assert.strictEqual(funded.rows[0].taxFundingConvergence.status, 'converged');
  assert.ok(Math.abs(funded.rows[0].taxFundingConvergence.residual) <= 0.01);

  const traditionalInputs = build(100000, 10000, 'traditional');
  const traditionalShortcut = runSinglePath(traditionalInputs, returnPath);
  const traditionalFunded = runSinglePath(traditionalInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 5000,
    fundTaxPolicyDelta: true,
  });
  const extraGross = traditionalFunded.rows[0].withdrawal
    - traditionalShortcut.rows[0].withdrawal;
  assert.ok(extraGross > 5000, 'traditional funding must gross up the federal delta');
  assert.ok(Math.abs(extraGross * (1 - traditionalInputs.taxRates.ordinary) - 5000) < 0.01,
    'additional traditional withdrawal must net the resolved-tax delta after shortcut tax');

  const tightInputs = build(12000, 10000);
  const tightShortcut = runSinglePath(tightInputs, returnPath);
  const tightFunded = runSinglePath(tightInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 3000,
    fundTaxPolicyDelta: true,
  });
  assert.strictEqual(tightShortcut.failed, false, 'shortcut fixture must survive');
  assert.strictEqual(tightFunded.failed, true,
    'unfunded federal-tax delta must be able to change the path outcome');

  const lowerTax = runSinglePath(traditionalInputs, returnPath, {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax - 1000,
    fundTaxPolicyDelta: true,
  });
  assert.ok(lowerTax.rows[0].withdrawal < traditionalShortcut.rows[0].withdrawal,
    'a lower federal liability must rebuild the year with a smaller withdrawal');
  assert.ok(lowerTax.terminalBalance > traditionalShortcut.terminalBalance);
  assert.strictEqual(lowerTax.rows[0].taxFundingConvergence.fundingAdjustment, -1000);
});

test('federal funding rejects non-finite spending inputs before convergence', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  p.household.spouse = null;
  p.expenses = {
    living: 10_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };

  assert.throws(
    () => resolveInputs(p, { spendBump: Infinity }),
    /spendBump must be finite/
  );
  assert.throws(
    () => resolveInputs(p, { spendCut: NaN }),
    /spendCut must be finite/
  );
  for(const value of [NaN, Infinity, -1, null, '24000']){
    assert.throws(
      () => resolveInputs(p, { livingAnnual: value }),
      /livingAnnual must be a finite non-negative number/
    );
    assert.throws(
      () => resolveInputs(p, { savingsAnnual: value }),
      /savingsAnnual must be a finite non-negative number/
    );
  }

  // This block previously corrupted plan.expenses.housing and asserted the
  // row-level funding guard caught the resulting NaN. That field is retired —
  // spending is goals now — so the equivalent protection is that a corrupt
  // spending figure is sanitized at resolve time and never reaches the funding
  // calculation at all. The row-level guard remains as defense in depth.
  p.goals = [{ name: 'Corrupt', amount: NaN, startAge: 0, endAge: 999 }];
  const params = resolveInputs(p, {});
  const corrupt = params.goals.find(g => g.name === 'Corrupt');
  assert.strictEqual(corrupt.amount, 0, 'a non-finite goal amount resolves to zero');
  for(const g of params.goals){
    assert.ok(Number.isFinite(g.amount), 'no non-finite spending survives resolveInputs');
    assert.ok(Number.isFinite(g.realGrowth), 'nor a non-finite growth rate');
  }
});

test('converged age-68 cash-flow row funds the visible federal-tax identity', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 68, retirementAge: 68, planEndAge: 68 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 1_000_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [];
  p.portfolio.withdrawalStrategy = 'taxable-first';
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [{
    label: 'Retirement income', amount: 65_000,
    startAge: 68, endAge: 68, taxablePct: 1,
  }];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 170_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [{ name: 'Age-68 goal', amount: 50_000, startAge: 68, endAge: 68 }];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {});
  const result = runSinglePath(params, [flatAssetReturnRow(2026)], {
    taxPolicy: () => 30_000,
    fundTaxPolicyDelta: true,
  });
  const row = result.rows[0];
  const grossIncome = row.socialSecurity + row.otherIncome + row.pension;
  const visibleOutflows = row.expenses + row.goals + row.taxes;
  const visibleResidual = grossIncome + row.withdrawal - visibleOutflows;

  assert.equal(row.age, 68);
  assert.equal(grossIncome, 65_000);
  assert.equal(row.expenses, 170_000);
  assert.equal(row.goals, 50_000);
  assert.equal(row.taxes, 30_000);
  assert.equal(row.rmd, 0);
  assert.equal(row.rmdRequired, 0);
  assert.equal(row.liabilities, 0);
  assert.equal(row.lumpSum, 0);
  assert.equal(row.assetSale, 0);
  assert.equal(row.failed, false, 'ample taxable assets must leave no funding shortfall');
  assert.equal(row.taxFundingConvergence.status, 'converged');
  assert.ok(Math.abs(row.taxFundingConvergence.residual) <= 0.01);
  assert.ok(Math.abs(row.withdrawal - 185_000) <= 0.01,
    'the converged portfolio draw must fund expenses, goals, and resolved federal tax');
  assert.ok(Math.abs(visibleResidual) <= 0.01,
    `visible cash-flow columns must reconcile within one cent; residual=${visibleResidual}`);
});

test('converged taxable funding rebuilds exact final gain facts from the opening state', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 73 };
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    explicitlyBasedBrokerage(1_000_000, 200_000),
    createAccount('traditional_ira', {
      owner: 'client',
      balance: 10_000_000,
    }),
  ];
  p.portfolio.withdrawalStrategy = 'taxable-first';
  p.expenses = {
    living: 100_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {});
  const result = runSinglePath(params, [flatAssetReturnRow(2025)], {
    taxPolicy: (_row, { shortcutTax }) => shortcutTax + 200_000,
    fundTaxPolicyDelta: true,
  });
  const row = result.rows[0];
  const gainFraction = 0.80;
  const firstWithdrawal = 100_000 / (1 - gainFraction * 0.15);
  const expectedWithdrawal = 300_000 / (1 - gainFraction * 0.15);
  const expectedGain = expectedWithdrawal * gainFraction;

  assert.ok(Math.abs(row.accountBreakdown.taxable - expectedWithdrawal) < 0.01);
  assert.ok(Math.abs(
    row.preTaxDeltaAccountBreakdown.taxable - firstWithdrawal
  ) < 0.01);
  assert.ok(Math.abs(row.taxableCapitalGain - expectedGain) < 0.01);
  assert.ok(Math.abs(row.taxableGainFraction - expectedGain / expectedWithdrawal) < 1e-12);
  assert.equal(row.taxableGainFraction, gainFraction);
  assert.deepEqual(row.accountStartingBalances, {
    taxable: 1_000_000,
    traditional: 10_000_000,
    roth: 0,
  });
  assert.equal(row.taxableStartingBasis, 200_000);
  assert.equal(row.taxFundingConvergence.status, 'converged');
});

test('lower federal tax beyond a zero draw retains only the incremental saving as taxable basis', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 65 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.portfolio.extraAccounts = [
    explicitlyBasedBrokerage(100_000, 100_000),
  ];
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [{
    label: 'Pension-like income', amount: 100_000,
    startAge: 65, endAge: 65, taxablePct: 1,
  }];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 90_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };
  const params = resolveInputs(p, {});
  const shortcut = runSinglePath(params, [flatAssetReturnRow(2026)]);
  const funded = runSinglePath(params, [flatAssetReturnRow(2026)], {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });

  assert.equal(shortcut.rows[0].withdrawal, 12_000);
  assert.equal(funded.rows[0].withdrawal, 0);
  assert.equal(funded.rows[0].taxFundingConvergence.taxSavingsReinvested, 10_000);
  assert.equal(funded.rows[0].accountBalances.taxable, 110_000);
  assert.equal(funded.rows[0].taxableStartingBasis, 100_000);
});

test('lower federal tax retains only non-RMD savings when an RMD is forced', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 73, retirementAge: 73, planEndAge: 73, birthYear: 1953 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const rmdIra = createAccount('traditional_ira', { owner: 'client', balance: 10_000_000 });
  rmdIra.id = 'rmd-ira';
  p.portfolio.extraAccounts = [
    explicitlyBasedBrokerage(100_000, 100_000),
    rmdIra,
  ];
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 70 }, spouse: null };
  p.income.other = [{
    label: 'Pension-like income', amount: 100_000,
    startAge: 73, endAge: 73, taxablePct: 1,
  }];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 90_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };

  const params = resolveInputs(p, {});
  const funded = runSinglePath(params, [flatAssetReturnRow(2026)], {
    taxPolicy: () => 0,
    fundTaxPolicyDelta: true,
  });
  const row = funded.rows[0];
  const rmd = 10_000_000 / 26.5;

  assert.equal(row.taxFundingConvergence.taxSavingsReinvested, 10_000);
  assert.equal(row.accountBalances.taxable, 110_000);
  assert.equal(row.taxableStartingBasis, 100_000);
  assert.equal(row.taxableEndingBasis, 110_000);
  assert.equal(row.taxableCapitalGain, 0);
  assert.ok(Math.abs(row.rmd - rmd) < 0.01);
  assert.equal(row.rmdGrossByOwner.client, 0);
  assert.ok(Math.abs(row.accountWithdrawalsById['rmd-ira'] - rmd) < 0.01);
  assert.ok(Math.abs(row.accountBalances.traditional - (10_000_000 - rmd)) < 0.01);
  assert.equal(row.accountBalances.roth, 0);

  const flatReduction = runSinglePath(params, [flatAssetReturnRow(2026)], {
    taxPolicy: (_row, { shortcutTax }) => Math.max(0, shortcutTax - 22_000),
    fundTaxPolicyDelta: true,
  });
  const flatReductionRow = flatReduction.rows[0];
  assert.equal(flatReductionRow.taxFundingConvergence.taxSavingsReinvested, 10_000,
    'an RMD-independent flat tax reduction remains taxable cash even below the RMD shortcut tax');
  assert.equal(flatReductionRow.accountBalances.taxable, 110_000);
  assert.equal(flatReductionRow.taxableEndingBasis, 110_000);
  assert.equal(flatReductionRow.taxableCapitalGain, 0);
});

test('converged funding fails closed when a discontinuous tax policy has no fixed point', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  p.household.spouse = null;
  p.portfolio.accounts = {
    taxable: { balance: 100_000, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  p.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  p.income.other = [];
  p.income.pension = { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 };
  p.expenses = {
    living: 10_000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  p.goals = [];
  p.liabilities = [];
  p.properties = [];
  p.ltc = { amount: 0, onsetAge: 99 };
  const params = resolveInputs(p, {});

  assert.throws(() => runSinglePath(params, [
    flatAssetReturnRow(2026),
    flatAssetReturnRow(2027),
  ], {
    taxPolicy: row => row.withdrawal > 12_000 ? 0 : 5_000,
    fundTaxPolicyDelta: true,
  }), error => error?.code === 'TAX_POLICY_FUNDING_DID_NOT_CONVERGE');
});

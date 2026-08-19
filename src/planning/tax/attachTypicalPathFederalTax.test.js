import { test } from 'node:test';
import assert from 'node:assert';
import {
  generateReturnPath,
  runSimulation,
  runHistoricalPath,
  resolveInputs,
  defaultPlan,
} from '../../../engine.js';
import { attachTypicalPathFederalTax } from './attachTypicalPathFederalTax.js';
import { buildPlanMetaFromEngineParams, buildRowPlanMetaFromOptions } from './buildPlanMetaFromEngineParams.js';
import { runTaxForScenarioPath } from './runTaxForScenarioPath.js';
import { buildRowTaxableGainPlanMeta } from './taxableBasisTracker.js';

function cloneDefaultPlan(){
  return JSON.parse(JSON.stringify(defaultPlan));
}

function removeNonTestIncomeAndOutflows(plan){
  plan.income.socialSecurity = { primary: null, spouse: null };
  plan.income.other = [];
  plan.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  plan.expenses = {
    living: 0,
    housing: 0,
    debt: 0,
    healthcare: 0,
    extra: [],
    healthcareRealGrowth: 0,
  };
  plan.goals = [];
  plan.liabilities = [];
  plan.ltc = { amount: 0, onsetAge: 85 };
}

function historicalAnalysis(plan){
  const path = runHistoricalPath(plan, 1995, 'taxable-first');
  return {
    path,
    analysis: {
      params: resolveInputs(plan, {}),
      paths: { p50: path },
    },
  };
}

test('buildPlanMetaFromEngineParams requires filing status and optional overrides', () => {
  const planMeta = buildPlanMetaFromEngineParams({
    accounts: {
      taxable: { balance: 1000000, basis: 600000 },
      traditional: { balance: 0 },
      roth: { balance: 0 },
    },
  }, { filingStatus: 'marriedFilingJointly', baseTaxYear: 2025, taxableGainFraction: 0.4 });

  assert.strictEqual(planMeta.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(planMeta.taxableGainFraction, 0.4);
  assert.deepStrictEqual(planMeta.deductions, { useStandard: true });

  const rowPlanMeta = buildRowPlanMetaFromOptions({ baseTaxYear: 2025 });
  assert.deepStrictEqual(rowPlanMeta({ year: 3 }), { taxYear: 2026 });
  assert.deepStrictEqual(rowPlanMeta({ year: 99 }), { taxYear: 2026 });
});

test('row tax metadata never copies current-return facts into projected years', () => {
  const current1040Intake = {
    taxYear: 2026,
    income: { wages: 90_000 },
    deductions: { method: 'itemized', source: 'supplied-line12e', line12e: 40_000 },
    taxpayers: { client: { birthDate: '1960-01-01' } },
    returnScope: { modeledTaxpayer: 'client' },
  };
  const rowPlanMeta = buildRowPlanMetaFromOptions({
    baseTaxYear: 2026,
    current1040Intake,
  });

  assert.deepStrictEqual(rowPlanMeta({ year: 1 }), { taxYear: 2026 });
  assert.deepStrictEqual(rowPlanMeta({ year: 2 }), { taxYear: 2026 });
});

test('buildPlanMetaFromEngineParams uses household filing status without an MFJ default', () => {
  for(const filingStatus of [
    'single',
    'marriedFilingJointly',
    'headOfHousehold',
    'marriedFilingSeparately',
  ]){
    const planMeta = buildPlanMetaFromEngineParams({
      meta: { filingStatus },
      accounts: { taxable: { balance: 0, basis: 0 } },
    });
    assert.strictEqual(planMeta.filingStatus, filingStatus);
  }

  assert.throws(
    () => buildPlanMetaFromEngineParams({
      accounts: { taxable: { balance: 0, basis: 0 } },
    }),
    /plan\.meta\.filingStatus/
  );
});

test('attachTypicalPathFederalTax returns slim summary without mutating analysis', () => {
  const horizon = resolveInputs(defaultPlan, {}).horizonYears;
  const paths = Array.from({ length: 12 }, () => generateReturnPath(horizon));
  const analysis = runSimulation(defaultPlan, {}, paths);

  const beforeLifetimeTax = analysis.paths.p50.lifetimeTax;
  const beforeFirstRowTax = analysis.paths.p50.rows[0].taxes;

  const summary = attachTypicalPathFederalTax(analysis, {
    baseTaxYear: 2025,
    scenarioId: 'attach_test',
    filingStatus: 'marriedFilingJointly',
  });

  assert.strictEqual(analysis.paths.p50.lifetimeTax, beforeLifetimeTax);
  assert.strictEqual(analysis.paths.p50.rows[0].taxes, beforeFirstRowTax);
  assert.strictEqual(summary.path, 'p50');
  assert.strictEqual(typeof summary.simIndex, 'number');
  assert.ok(Array.isArray(summary.years));
  assert.ok(summary.years.length > 0);
  assert.strictEqual(typeof summary.totals.federalTaxLiability, 'number');
  assert.strictEqual(typeof summary.totals.enginePathTax, 'number');
  assert.strictEqual(summary.totals.engineLifetimeTax, beforeLifetimeTax);
  assert.ok(Math.abs(
    summary.totals.deltaVsEnginePath
    - (summary.totals.federalTaxLiability - summary.totals.enginePathTax)
  ) < 0.01);
  assert.ok(Array.isArray(summary.warnings));
  assert.ok(summary.scope);
  assert.ok(summary.years.every((year) =>
    year.engineTax != null
    && Math.abs(year.delta - (year.federalTaxLiability - year.engineTax)) < 0.01
  ));
});

test('attachTypicalPathFederalTax skips accumulation and failed filler rows', () => {
  const analysis = {
    params: { retirementAge: 65, currentAge: 60, accounts: { taxable: { balance: 0, basis: 0 } } },
    paths: {
      p50: {
        simIndex: 0,
        lifetimeTax: 5000,
        rows: [
          { year: 1, age: 61, phase: 'accum', taxes: 0, accountBreakdown: { taxable: 0, traditional: 0, roth: 0 } },
          {
            year: 6,
            source: 2025,
            age: 66,
            socialSecurity: 30000,
            pension: 0,
            taxes: 4000,
            accountBreakdown: { taxable: 0, traditional: 20000, roth: 0 },
            rmd: 0,
          },
          {
            year: 7,
            source: 2026,
            age: 67,
            socialSecurity: 0,
            pension: 0,
            otherIncome: 0,
            taxes: 0,
            accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
            rmd: 0,
          },
          {
            year: 8,
            source: null,
            age: 68,
            failed: true,
            socialSecurity: 0,
            otherIncome: 0,
            taxes: 0,
            accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
          },
        ],
      },
    },
  };

  const summary = attachTypicalPathFederalTax(analysis, { baseTaxYear: 2025, filingStatus: 'single' });
  const mfjSummary = attachTypicalPathFederalTax(analysis, {
    baseTaxYear: 2025,
    filingStatus: 'marriedFilingJointly',
  });
  assert.strictEqual(summary.years.length, 2);
  assert.strictEqual(summary.years[0].year, 6);
  assert.strictEqual(summary.years[1].year, 7);
  assert.strictEqual(summary.years[1].federalTaxLiability, 0);
  assert.strictEqual(summary.totals.enginePathTax, 4000);
  assert.ok(summary.totals.federalTaxLiability > mfjSummary.totals.federalTaxLiability);
});

test('attachTypicalPathFederalTax throws when p50 rows are missing', () => {
  assert.throws(
    () => attachTypicalPathFederalTax({ paths: {} }),
    /analysis\.paths\.p50\.rows is required/
  );
});

test('attachTypicalPathFederalTax uses taxable other income instead of gross', () => {
  const buildAnalysis = (otherIncomeTaxable) => ({
    params: {
      retirementAge: 65,
      currentAge: 65,
      meta: { filingStatus: 'single' },
      accounts: { taxable: { balance: 0, basis: 0 } },
    },
    paths: {
      p50: {
        simIndex: 0,
        lifetimeTax: 0,
        rows: [{
          year: 1,
          source: 2025,
          age: 65,
          socialSecurity: 0,
          pension: 0,
          otherIncome: 40000,
          ...(otherIncomeTaxable !== undefined ? { otherIncomeTaxable } : {}),
          taxes: 0,
          accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
          rmd: 0,
        }],
      },
    },
  });

  const halfTaxable = attachTypicalPathFederalTax(buildAnalysis(20000), { baseTaxYear: 2025 });
  const grossFallback = attachTypicalPathFederalTax(buildAnalysis(undefined), { baseTaxYear: 2025 });

  assert.strictEqual(halfTaxable.years[0].agi, 20000);
  assert.strictEqual(grossFallback.years[0].agi, 40000);
  assert.ok(
    halfTaxable.years[0].federalTaxLiability
      < grossFallback.years[0].federalTaxLiability
  );
});

test('planner integration preserves MFJ and single status through line 8 and line 24', () => {
  const plan = cloneDefaultPlan();
  plan.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 72 };
  removeNonTestIncomeAndOutflows(plan);
  plan.income.other = [{
    label: 'Partly taxable annuity',
    amount: 80000,
    startAge: 65,
    endAge: 72,
    taxablePct: 0.5,
  }];

  const { analysis, path } = historicalAnalysis(plan);
  const row = path.rows[0];
  const liabilityByStatus = {};

  for(const filingStatus of ['marriedFilingJointly', 'single']){
    const summary = attachTypicalPathFederalTax(analysis, {
      filingStatus,
      baseTaxYear: 2026,
    });
    const direct = runTaxForScenarioPath([row], {
      filingStatus,
      taxYear: 2026,
    }).results[0];

    assert.strictEqual(direct.facts.filingStatus, filingStatus);
    assert.strictEqual(direct.input.filingStatus, filingStatus);
    assert.strictEqual(row.otherIncomeTaxable, 40000);
    assert.strictEqual(direct.facts.income.otherIncome, row.otherIncomeTaxable);
    assert.strictEqual(direct.input.supplied.line8, row.otherIncomeTaxable);
    assert.strictEqual(direct.result.form1040.line8.value, row.otherIncomeTaxable);
    assert.strictEqual(
      summary.years[0].federalTaxLiability,
      direct.result.form1040.line24.value
    );
    liabilityByStatus[filingStatus] = summary.years[0].federalTaxLiability;
  }

  assert.ok(liabilityByStatus.single > liabilityByStatus.marriedFilingJointly);
});

test('SS-heavy planner path calculates line 6b and attaches without throwing', () => {
  const plan = cloneDefaultPlan();
  plan.household.primary = { currentAge: 67, retirementAge: 67, planEndAge: 75 };
  plan.household.spouse = { currentAge: 67, retirementAge: 67, planEndAge: 75 };
  plan.portfolio.accounts.taxable.balance += plan.portfolio.accounts.traditional.balance;
  plan.portfolio.accounts.traditional.balance = 0;
  removeNonTestIncomeAndOutflows(plan);
  plan.income.socialSecurity = {
    primary: { pia: 70000, claimAge: 67 },
    spouse: { pia: 50000, claimAge: 67 },
  };

  const { analysis, path } = historicalAnalysis(plan);
  const row = path.rows[0];
  const filingStatus = 'marriedFilingJointly';
  const summary = attachTypicalPathFederalTax(analysis, {
    filingStatus,
    baseTaxYear: 2026,
  });
  const direct = runTaxForScenarioPath([row], {
    filingStatus,
    taxYear: 2026,
  }).results[0];
  const line6b = direct.result.form1040.line6b;

  assert.strictEqual(direct.facts.income.socialSecurityBenefits, row.socialSecurity);
  assert.strictEqual(direct.input.supplied.line6a, row.socialSecurity);
  assert.strictEqual(direct.input.socialSecurity.socialSecurityBenefits, row.socialSecurity);
  assert.strictEqual(line6b.status, 'CALCULATED');
  assert.strictEqual(line6b.ruleId, 'FED_TAXABLE_SOCIAL_SECURITY');
  assert.ok(line6b.value > 0 && line6b.value <= row.socialSecurity * 0.85);
  assert.strictEqual(summary.years[0].agi, line6b.value);
  assert.strictEqual(summary.years[0].federalTaxLiability, direct.result.form1040.line24.value);
});

test('RMD and taxable-withdrawal planner facts match sidecar intake and attached line 24', () => {
  const plan = cloneDefaultPlan();
  plan.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 95 };
  plan.portfolio.accounts.traditional.balance = 10000000;
  plan.portfolio.accounts.roth.balance = 0;

  const { analysis, path } = historicalAnalysis(plan);
  const row = path.rows.find((candidate) =>
    (candidate.rmd ?? 0) > 0
      && (candidate.accountBreakdown?.taxable ?? 0) > 0
      && candidate.taxableGainFraction !== undefined
  );
  assert.ok(row, 'expected a row with both an RMD and taxable withdrawal');

  const filingStatus = 'single';
  const rowPlanMeta = buildRowTaxableGainPlanMeta();
  const direct = runTaxForScenarioPath([row], {
    filingStatus,
    taxYear: 2026,
  }, { rowPlanMeta }).results[0];
  const summary = attachTypicalPathFederalTax(analysis, {
    filingStatus,
    baseTaxYear: 2026,
  });
  const attachedYear = summary.years.find((year) => year.year === row.year);

  const taxableWithdrawal = row.accountBreakdown.taxable;
  const iraGross = (row.accountBreakdown.traditional ?? 0) + row.rmd;
  const expectedCapitalGain = taxableWithdrawal * row.taxableGainFraction;
  const impliedGainFraction = row.taxBySource.taxable
    / (taxableWithdrawal * analysis.params.taxRates.capitalGains);

  assert.ok(Math.abs(row.taxableGainFraction - impliedGainFraction) < 1e-9);
  assert.strictEqual(direct.facts.income.iraDistributions, iraGross);
  assert.strictEqual(
    direct.facts.scheduleD.netLongTermGainOrLoss,
    expectedCapitalGain
  );
  assert.strictEqual(direct.input.supplied.line4a, iraGross);
  assert.strictEqual(direct.input.supplied.line4b, iraGross);
  assert.strictEqual(
    direct.input.scheduleD.netLongTermGainOrLoss,
    expectedCapitalGain
  );
  assert.strictEqual(
    direct.result.form1040.line7a.value,
    Math.round((expectedCapitalGain + Number.EPSILON) * 100) / 100
  );
  assert.strictEqual(
    direct.result.form1040.line7a.ruleId,
    'FED_SCHEDULE_D_CLASSIFICATION'
  );
  assert.ok(direct.result.form1040.line24.value > 0);
  assert.ok(attachedYear, 'expected RMD/taxable row in attached summary');
  assert.strictEqual(attachedYear.federalTaxLiability, direct.result.form1040.line24.value);
});

test('survivor filing-status transition integration', () => {
  const plan = cloneDefaultPlan();
  plan.meta.filingStatus = 'marriedFilingJointly';
  plan.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 92 };
  plan.household.spouse = { currentAge: 64, retirementAge: 64, planEndAge: 68 };
  plan.portfolio.accounts.taxable.balance += plan.portfolio.accounts.traditional.balance;
  plan.portfolio.accounts.traditional.balance = 0;
  plan.income.socialSecurity = {
    primary: { pia: 30000, claimAge: 65 },
    spouse: { pia: 20000, claimAge: 64 },
  };
  plan.expenses = { living: 20000, housing: 0, debt: 0, healthcare: 0, extra: [], healthcareRealGrowth: 0 };
  plan.goals = [];
  plan.liabilities = [];
  const { analysis, path } = historicalAnalysis(plan);
  const before = path.rows.find(row => row.age === 69);
  const after = path.rows.find(row => row.age === 70);
  assert.strictEqual(before.filingStatus, 'marriedFilingJointly');
  assert.strictEqual(before.survivor, false);
  assert.strictEqual(after.filingStatus, 'single');
  assert.strictEqual(after.survivor, true);
  assert.ok(after.socialSecurity < before.socialSecurity, 'deceased spouse benefit stops');

  const summary = attachTypicalPathFederalTax(analysis, {
    filingStatus: 'marriedFilingJointly',
    baseTaxYear: 2026,
  });
  assert.strictEqual(summary.years.find(year => year.age === 69).filingStatus, 'marriedFilingJointly');
  assert.strictEqual(summary.years.find(year => year.age === 70).filingStatus, 'single');
});

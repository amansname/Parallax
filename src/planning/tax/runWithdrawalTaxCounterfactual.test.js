import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs, runSimulation } from '../../../engine.js';
import { createAccount } from '../../household/createAccount.js';
import { createBlankTaxProfiles, createFact } from '../../household/factEnvelope.js';
import {
  getLineMapEntry,
  LINE_COVERAGE,
} from '../../tax/core/1040BasicLineMap.js';
import { buildWithdrawalTaxCounterfactualContext } from './buildWithdrawalTaxCounterfactualContext.js';
import { createFederalTaxResolver } from './createFederalTaxResolver.js';
import { runWithdrawalTaxCounterfactual } from './runWithdrawalTaxCounterfactual.js';
import { runTaxForScenarioPath } from './runTaxForScenarioPath.js';

const CONFIRMED_AT = '2026-01-01T00:00:00.000Z';
const confirmed = value => createFact(value, 'confirmed', 'household-entry', CONFIRMED_AT);

function confirmedBasis(amount){
  return {
    amount,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: CONFIRMED_AT,
    version: 1,
  };
}

function readyPlan(){
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'single';
  plan.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 70 };
  plan.household.spouse = null;
  plan.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 1 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  const taxable = createAccount('brokerage_taxable', {
    owner: 'client',
    balance: 500_000,
  });
  taxable.id = 'taxable';
  taxable.basis = confirmedBasis(200_000);
  const traditional = createAccount('traditional_ira', {
    owner: 'client',
    balance: 500_000,
  });
  traditional.id = 'traditional';
  const roth = createAccount('roth_ira', {
    owner: 'client',
    balance: 500_000,
  });
  roth.id = 'roth';
  plan.portfolio.extraAccounts = [taxable, traditional, roth];
  plan.taxProfiles = createBlankTaxProfiles();
  for(const key of Object.keys(plan.taxProfiles.client.traditionalIra)){
    plan.taxProfiles.client.traditionalIra[key] = confirmed(0);
  }
  plan.taxProfiles.client.rothIra.firstContributionYear = confirmed(2010);
  plan.taxProfiles.client.birthDate = confirmed('1960-07-01');
  plan.taxProfiles.client.blind = confirmed(false);
  return plan;
}

function row(overrides = {}){
  const value = {
    year: 1,
    age: 65,
    source: 2025,
    failed: false,
    socialSecurity: 40_000,
    pension: 0,
    otherIncome: 0,
    accountBreakdown: { taxable: 100_000, traditional: 80_000, roth: 50_000 },
    preTaxDeltaAccountBreakdown: {
      taxable: 100_000, traditional: 80_000, roth: 50_000,
    },
    withdrawal: 230_000,
    rmd: 0,
    rmdRequired: 0,
    startBalance: 1_500_000,
    accountStartingBalances: { taxable: 500_000, traditional: 500_000, roth: 500_000 },
    taxableStartingBasis: 200_000,
    taxableCapitalGain: 60_000,
    taxes: 50_000,
    ...overrides,
  };
  if(!Object.prototype.hasOwnProperty.call(overrides, 'preTaxDeltaAccountBreakdown')){
    value.preTaxDeltaAccountBreakdown = { ...value.accountBreakdown };
  }
  return value;
}

function context(plan = readyPlan(), options = {}){
  return buildWithdrawalTaxCounterfactualContext(plan, resolveInputs(plan, {}), {
    filingStatus: plan.meta.filingStatus,
    baseTaxYear: 2026,
    scenarioId: 'phase_5_test',
    contextOverrides: { calculatedAt: '2026-01-01T00:00:00.000Z' },
    ...options,
  });
}

test('counterfactual runs all eight 1040 coalitions and reconciles tax attribution', () => {
  const sourcePlan = readyPlan();
  const sourceRow = row();
  const planBefore = structuredClone(sourcePlan);
  const rowBefore = structuredClone(sourceRow);
  const counterfactualContext = context(sourcePlan);
  const result = runWithdrawalTaxCounterfactual(sourceRow, counterfactualContext);

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.status, 'modeled-only');
  assert.deepEqual(result.coalitions.map(item => item.id), [
    'none',
    'taxable',
    'traditional',
    'roth',
    'taxable+traditional',
    'taxable+roth',
    'traditional+roth',
    'taxable+traditional+roth',
  ]);
  assert.ok(result.coalitions.every(item => item.status === 'modeled'));
  assert.equal(result.attributedModeledFederalIncomeTaxByBucket.roth, 0,
    'qualified Roth is a dummy player in federal line 24');
  assert.equal(result.attributionReconciliation.differenceSixthCents, 0);
  assert.equal(
    result.baselineModeledFederalIncomeTax,
    result.coalitions[0].modeledFederalIncomeTax
  );
  assert.equal(
    result.fullCoalitionModeledFederalIncomeTax,
    result.coalitions.at(-1).modeledFederalIncomeTax
  );
  assert.equal(result.taxCoverage.status, 'modeled-income-tax-only');
  assert.equal(result.taxCoverage.taxTotalScope, 'INCOME_TAX_ONLY');
  const niitCoverage = getLineMapEntry('niit');
  assert.equal(niitCoverage.coverage, LINE_COVERAGE.CAPTURED);
  assert.equal(
    niitCoverage.intakePath,
    'schedule2.netInvestmentIncomeTax'
  );
  assert.match(niitCoverage.notes, /Supplied Form 8960 component/);
  assert.ok(result.comparisonEligibility.reasonCodes.includes('NIIT_NOT_MODELED'));
  assert.ok(result.comparisonEligibility.reasonCodes.includes(
    'TAXABLE_PORTFOLIO_YIELD_INCOME_NOT_MODELED'
  ));
  assert.ok(result.comparisonEligibility.reasonCodes.includes(
    'SOCIAL_SECURITY_TAX_EXEMPT_INTEREST_ASSUMED_ZERO'
  ));
  assert.ok(result.comparisonEligibility.reasonCodes.includes(
    'STANDARD_DEDUCTION_AGE_ADDITION_NOT_MODELED'
  ));
  assert.equal(result.comparisonEligibility.status, 'blocked');
  assert.deepEqual(result.distributionTaxEvidence.roth.accounts, [{
    accountId: 'roth',
    owner: 'client',
    taxCharacter: 'roth_ira',
    ownerAge: 65,
    ownerBirthDate: '1960-07-01',
    birthDateSource: 'confirmed-household-tax-profile',
    modeledDistributionDate: '2026-01-01',
    distributionDateAssumption: 'start-of-year-conservative',
    firstContributionYear: 2010,
    engineAgeReconciled: true,
    qualified: true,
    ageTestMet: true,
    fiveYearTestMet: true,
    ageQualificationDate: '2020-01-01',
    status: 'qualified',
  }]);
  assert.equal(
    result.distributionTaxEvidence.roth.rule.ruleId,
    'FED_QUALIFIED_ROTH_DISTRIBUTION'
  );
  const direct = runTaxForScenarioPath([sourceRow], {
    ...counterfactualContext.planMeta,
    taxYear: 2026,
  }, {
    contextOverrides: {
      taxYear: 2026,
      calculatedAt: '2026-01-01T00:00:00.000Z',
      scenarioId: 'direct_full_row',
    },
  }).results[0].annual1040Result.lines.line24.value;
  assert.equal(result.fullCoalitionModeledFederalIncomeTax, direct,
    'full coalition must equal a direct 1040 rerun of the completed row');
  assert.equal(result.fundedFederalTax, sourceRow.taxes);
  assert.notEqual(result.deltaVsFundedFederalTax, 0,
    'a row without convergence metadata remains comparable evidence, not a convergence claim');
  assert.equal(result.semantics.convergence, 'not-converged');
  assert.ok(result.comparisonEligibility.reasonCodes.includes(
    'PHASE_6_FUNDING_NOT_CONVERGED'
  ));
  assert.deepEqual(sourcePlan, planBefore);
  assert.deepEqual(sourceRow, rowBefore);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.coalitions), true);
  assert.deepEqual(
    runWithdrawalTaxCounterfactual(sourceRow, context(sourcePlan)),
    result,
    'slim output is deterministic even though the tax audit context has timestamps'
  );
});

test('coalition reruns capture Social Security and capital-gain interactions', () => {
  const result = runWithdrawalTaxCounterfactual(row(), context());
  const byId = Object.fromEntries(result.coalitions.map(item => [item.id, item]));
  const traditionalAgiIncrease = byId.traditional.lines.line11.value
    - byId.none.lines.line11.value;
  assert.ok(traditionalAgiIncrease > 80_000,
    'Traditional income must also expose more Social Security to tax');
  const taxableAgiIncrease = byId.taxable.lines.line11.value
    - byId.none.lines.line11.value;
  assert.ok(taxableAgiIncrease > 60_000,
    'taxable gains must also interact with the Social Security worksheet');
  const singletonDelta = (
    byId.taxable.modeledFederalIncomeTax - byId.none.modeledFederalIncomeTax
  ) + (
    byId.traditional.modeledFederalIncomeTax - byId.none.modeledFederalIncomeTax
  );
  const jointDelta = byId['taxable+traditional'].modeledFederalIncomeTax
    - byId.none.modeledFederalIncomeTax;
  assert.notEqual(jointDelta, singletonDelta,
    'joint tax must come from a real rerun rather than adding shortcut rates');
});

test('a converged engine row reconciles the full coalition to funded federal tax', () => {
  const plan = readyPlan();
  plan.simulation.iterations = 1;
  const params = resolveInputs(plan, {});
  const taxOptions = {
    filingStatus: 'single',
    baseTaxYear: 2026,
    scenarioId: 'phase_6_converged_counterfactual_test',
    contextOverrides: { calculatedAt: '2026-01-01T00:00:00.000Z' },
  };
  const taxPolicy = createFederalTaxResolver(params, taxOptions);
  const returnPath = Array.from({ length: params.horizonYears }, (_, index) => ({
    y: 2026 + index,
    proxyReturn: 0,
  }));
  const analysis = runSimulation(plan, {}, [returnPath], {
    taxPolicy,
    fundTaxPolicyDelta: true,
  });
  const fundedRow = analysis.paths.p50.rows.find(item => item.phase !== 'accum');
  const result = runWithdrawalTaxCounterfactual(fundedRow, context(plan, taxOptions));

  assert.equal(fundedRow.taxFundingConvergence.status, 'converged');
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.semantics.convergence, 'converged');
  assert.equal(result.fundedFederalTax, fundedRow.taxes);
  assert.equal(result.fullCoalitionModeledFederalIncomeTax, fundedRow.taxes);
  assert.ok(Math.abs(result.deltaVsFundedFederalTax) <= 0.01);
  assert.equal(
    result.comparisonEligibility.reasonCodes.includes('PHASE_6_FUNDING_NOT_CONVERGED'),
    false
  );
});

test('RMD rows preserve engine facts but withhold tax attribution until legal facts exist', () => {
  const base = row({
    age: 73,
    accountBreakdown: { taxable: 0, traditional: 10_000, roth: 0 },
    withdrawal: 10_000,
    rmd: 20_000,
    rmdRequired: 30_000,
    taxableCapitalGain: 0,
    taxes: 4_000,
  });
  const mandatoryOnly = runWithdrawalTaxCounterfactual(base, context());
  assert.equal(mandatoryOnly.status, 'unavailable');
  assert.equal(mandatoryOnly.withdrawals.modeledRmdBaseline, 30_000);
  assert.equal(mandatoryOnly.withdrawals.discretionaryByBucket.traditional, 0);
  assert.ok(mandatoryOnly.reasonCodes.includes(
    'RMD_PRIOR_YEAR_END_ACCOUNT_BALANCES_NOT_PROVEN'
  ));
  assert.ok(mandatoryOnly.coalitions.every(item => item.status === 'unavailable'));

  const aboveRmd = runWithdrawalTaxCounterfactual(row({
    age: 73,
    accountBreakdown: { taxable: 0, traditional: 50_000, roth: 0 },
    withdrawal: 50_000,
    rmd: 0,
    rmdRequired: 30_000,
    taxableCapitalGain: 0,
    taxes: 8_000,
  }), context());
  assert.equal(aboveRmd.status, 'unavailable');
  assert.equal(aboveRmd.withdrawals.modeledRmdBaseline, 30_000);
  assert.equal(aboveRmd.withdrawals.discretionaryByBucket.traditional, 20_000);

  const taxDeltaAfterForcedRmd = runWithdrawalTaxCounterfactual(row({
    age: 73,
    accountBreakdown: { taxable: 0, traditional: 20_000, roth: 0 },
    preTaxDeltaAccountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
    withdrawal: 20_000,
    rmd: 10_000,
    rmdRequired: 30_000,
    taxableCapitalGain: 0,
    taxes: 8_000,
  }), context());
  assert.equal(taxDeltaAfterForcedRmd.status, 'unavailable');
  assert.equal(taxDeltaAfterForcedRmd.withdrawals.actualTraditionalDistribution, 30_000);
  assert.equal(
    taxDeltaAfterForcedRmd.withdrawals.discretionaryByBucket.traditional,
    0,
    'the final-funded Traditional draw reduces the separate forced RMD amount'
  );
});

test('RMD accumulation gate follows the resolved retirement window, not raw plan age', () => {
  const plan = readyPlan();
  plan.household.primary = { currentAge: 74, retirementAge: 74, planEndAge: 76 };
  plan.taxProfiles.client.birthDate = confirmed('1952-01-01');
  const rmdRow = row({
    age: 74,
    accountBreakdown: { taxable: 0, traditional: 0, roth: 0 },
    withdrawal: 0,
    rmd: 30_000,
    rmdRequired: 30_000,
    taxableCapitalGain: 0,
  });
  const immediateContext = buildWithdrawalTaxCounterfactualContext(
    plan,
    resolveInputs(plan, {}),
    { filingStatus: 'single', baseTaxYear: 2026 }
  );
  const immediate = runWithdrawalTaxCounterfactual(rmdRow, immediateContext);
  assert.equal(immediate.status, 'unavailable');
  assert.equal(immediate.reasonCodes.includes('RMD_BEFORE_RETIREMENT_NOT_MODELED'), false);

  const delayedContext = buildWithdrawalTaxCounterfactualContext(
    plan,
    resolveInputs(plan, { retireDelay: 1 }),
    { filingStatus: 'single', baseTaxYear: 2026 }
  );
  const delayed = runWithdrawalTaxCounterfactual({ ...rmdRow, age: 75 }, delayedContext);
  assert.equal(delayed.status, 'unavailable');
  assert.ok(delayed.reasonCodes.includes('RMD_BEFORE_RETIREMENT_NOT_MODELED'));
});

test('approved taxable-basis assumption remains usable while unsupported tax character fails closed', () => {
  const unknownBasis = readyPlan();
  unknownBasis.portfolio.extraAccounts[0].basis = {
    amount: null, method: 'unknown', status: 'unknown', source: null,
    confirmedAt: null, version: 1,
  };
  const assumedContext = context(unknownBasis);
  const assumedTaxable = runWithdrawalTaxCounterfactual(row(), assumedContext);
  assert.equal(assumedTaxable.status, 'modeled-only');
  assert.equal(
    assumedContext.taxFacts.calculationInputs.taxableBasisMode,
    'assumed-50-50'
  );
  assert.deepEqual(
    assumedContext.taxFacts.calculationInputs.taxableBasisAssumptions
      .map(item => item.code),
    ['TAXABLE_BASIS_ASSUMED_50_50']
  );
  assert.ok(assumedTaxable.baselineModeledFederalIncomeTax >= 0);
  assert.ok(assumedTaxable.fullCoalitionModeledFederalIncomeTax >= 0);
  assert.ok(assumedTaxable.coalitions.find(item => item.id === 'taxable')
    .status === 'modeled');

  const traditionalOnly = runWithdrawalTaxCounterfactual(row({
    accountBreakdown: { taxable: 0, traditional: 80_000, roth: 0 },
    withdrawal: 80_000,
    taxableCapitalGain: 0,
  }), assumedContext);
  assert.equal(traditionalOnly.status, 'modeled-only',
    'an unused Taxable gap must not block a supported Traditional result');

  const iraBasis = readyPlan();
  iraBasis.taxProfiles.client.traditionalIra.priorYearCarryforwardBasis = confirmed(1_000);
  const fullyTaxableTraditional = runWithdrawalTaxCounterfactual(row(), context(iraBasis));
  assert.equal(fullyTaxableTraditional.status, 'modeled-only');
  assert.equal(
    fullyTaxableTraditional.reasonCodes.includes('TRADITIONAL_IRA_BASIS_RULE_REQUIRED'),
    false,
  );

  const unqualifiedRoth = readyPlan();
  unqualifiedRoth.taxProfiles.client.rothIra.firstContributionYear = confirmed(2024);
  const blockedRoth = runWithdrawalTaxCounterfactual(row(), context(unqualifiedRoth));
  assert.equal(blockedRoth.status, 'partial');
  assert.ok(blockedRoth.reasonCodes.includes('ROTH_DISTRIBUTION_NOT_PROVEN_QUALIFIED'));
  assert.equal(blockedRoth.distributionTaxEvidence.roth.accounts[0].qualified, false);

  const missingRothBirthDate = readyPlan();
  missingRothBirthDate.taxProfiles.client.birthDate = createFact();
  const missingBirthResult = runWithdrawalTaxCounterfactual(
    row(),
    context(missingRothBirthDate)
  );
  assert.equal(missingBirthResult.status, 'partial');
  assert.ok(missingBirthResult.reasonCodes.includes('ROTH_BIRTH_DATE_NOT_CONFIRMED'));
  assert.equal(
    missingBirthResult.distributionTaxEvidence.roth.accounts[0].birthDateSource,
    null
  );

  const mismatchedRothAge = readyPlan();
  mismatchedRothAge.taxProfiles.client.birthDate = confirmed('1980-01-01');
  const mismatchedAgeResult = runWithdrawalTaxCounterfactual(row(), context(mismatchedRothAge));
  assert.equal(mismatchedAgeResult.status, 'partial');
  assert.ok(mismatchedAgeResult.reasonCodes.includes(
    'ROTH_OWNER_AGE_BIRTH_DATE_MISMATCH'
  ));
});

test('scope-only accounts remain visible while modeled HSA and employer gaps block their bucket', () => {
  const inheritedPlan = readyPlan();
  const inherited = createAccount('inherited_traditional_ira', {
    owner: 'client', balance: 10_000,
  });
  inherited.id = 'inherited';
  inheritedPlan.portfolio.extraAccounts.push(inherited);
  const inheritedResult = runWithdrawalTaxCounterfactual(row(), context(inheritedPlan));
  assert.equal(inheritedResult.status, 'modeled-only');
  assert.equal(inheritedResult.projectionScope.status, 'scope-difference');
  assert.ok(inheritedResult.projectionScope.reasonCodes.includes(
    'PROJECTION_SCOPE_RULES_PENDING_ACCOUNTS'
  ));
  assert.ok(inheritedResult.comparisonEligibility.reasonCodes.includes(
    'PROJECTION_SCOPE_RULES_PENDING_ACCOUNTS'
  ));

  const hsaPlan = readyPlan();
  const hsa = createAccount('hsa', { owner: 'client', balance: 10_000 });
  hsa.id = 'hsa';
  hsaPlan.portfolio.extraAccounts.push(hsa);
  const hsaResult = runWithdrawalTaxCounterfactual(row(), context(hsaPlan));
  assert.equal(hsaResult.status, 'partial');
  assert.ok(hsaResult.reasonCodes.includes('ROTH_ACCOUNT_TAX_TREATMENT_UNSUPPORTED'));

  const employerPlan = readyPlan();
  const employer = createAccount('401k', { owner: 'client', balance: 10_000 });
  employer.id = 'work-plan';
  employerPlan.portfolio.extraAccounts.push(employer);
  const employerResult = runWithdrawalTaxCounterfactual(row(), context(employerPlan));
  assert.equal(employerResult.status, 'partial');
  assert.ok(employerResult.reasonCodes.includes('EMPLOYER_AFTER_TAX_BASIS_NOT_CONFIRMED'));
});

test('asset sales, bank return treatment, and MFS Social Security fail closed', () => {
  const saleYear = runWithdrawalTaxCounterfactual(row({ assetSale: 250_000 }), context());
  assert.equal(saleYear.status, 'unavailable');
  assert.ok(saleYear.reasonCodes.includes('ASSET_SALE_TAX_INTERACTION_UNSUPPORTED'));
  assert.equal(saleYear.coalitions.length, 0);

  const bankPlan = readyPlan();
  const bank = createAccount('checking', { owner: 'client', balance: 25_000 });
  bank.id = 'checking';
  bankPlan.portfolio.extraAccounts.push(bank);
  const bankResult = runWithdrawalTaxCounterfactual(row(), context(bankPlan));
  assert.equal(bankResult.status, 'unavailable');
  assert.ok(bankResult.reasonCodes.includes('BANK_RETURN_TAX_TREATMENT_PENDING'));

  const mfsPlan = readyPlan();
  mfsPlan.meta.filingStatus = 'marriedFilingSeparately';
  const mfsResult = runWithdrawalTaxCounterfactual(row(), context(mfsPlan));
  assert.equal(mfsResult.status, 'unavailable');
  assert.ok(mfsResult.reasonCodes.includes(
    'MFS_SOCIAL_SECURITY_LIVED_WITH_SPOUSE_NOT_CONFIRMED'
  ));

  const mfsResolved = runWithdrawalTaxCounterfactual(row({
    accountBreakdown: { taxable: 0, traditional: 80_000, roth: 0 },
    withdrawal: 80_000,
    taxableCapitalGain: 0,
  }), context(mfsPlan, {
    socialSecurityWorksheet: { livedWithSpouse: false },
  }));
  assert.notEqual(mfsResolved.status, 'unavailable');
  assert.equal(
    mfsResolved.reasonCodes.includes(
      'MFS_SOCIAL_SECURITY_LIVED_WITH_SPOUSE_NOT_CONFIRMED'
    ),
    false
  );
});

test('coverage discloses fully-taxable pension and supplemental-income assumptions', () => {
  const result = runWithdrawalTaxCounterfactual(row({ pension: 25_000 }), context());
  assert.ok(result.comparisonEligibility.reasonCodes.includes(
    'PENSION_TAXABLE_PORTION_ASSUMED_FULLY_TAXABLE'
  ));
  assert.equal(result.semantics.pensionTaxablePortion, 'modeled-as-fully-taxable');
  assert.equal(result.semantics.taxablePortfolioYieldIncome, 'not-modeled');
});

test('early Traditional distributions are withheld until additional-tax rules exist', () => {
  const result = runWithdrawalTaxCounterfactual(row({
    age: 58,
    accountBreakdown: { taxable: 0, traditional: 80_000, roth: 0 },
    withdrawal: 80_000,
    taxableCapitalGain: 0,
  }), context());
  assert.equal(result.status, 'partial');
  assert.ok(result.reasonCodes.includes(
    'EARLY_TRADITIONAL_DISTRIBUTION_ADDITIONAL_TAX_UNSUPPORTED'
  ));
  assert.equal(result.coalitions.find(item => item.id === 'traditional').status, 'unavailable');
  assert.equal(result.coalitions.find(item => item.id === 'none').status, 'modeled');
});

test('malformed rows throw while accumulation and depleted fillers are not applicable', () => {
  assert.throws(() => runWithdrawalTaxCounterfactual(row({
    taxableCapitalGain: 100_001,
  }), context()), /cannot exceed/);
  assert.throws(() => runWithdrawalTaxCounterfactual(row({
    accountBreakdown: { taxable: -1, traditional: 0, roth: 0 },
  }), context()), /finite non-negative/);
  assert.throws(() => runWithdrawalTaxCounterfactual(row({
    socialSecurity: undefined,
  }), context()), /row.socialSecurity must be/);
  assert.throws(() => runWithdrawalTaxCounterfactual(row({
    pension: Number.NaN,
  }), context()), /row.pension must be/);
  assert.throws(() => runWithdrawalTaxCounterfactual(row({
    otherIncome: 10_000,
  }), context()), /row.otherIncomeTaxable is required/);
  assert.throws(() => runWithdrawalTaxCounterfactual(row({
    otherIncome: 10_000,
    otherIncomeTaxable: 10_001,
  }), context()), /cannot exceed/);
  assert.throws(() => runWithdrawalTaxCounterfactual(row({
    accountBreakdown: { taxable: 0, traditional: 50_000, roth: 0 },
    withdrawal: 50_000,
    rmd: 20_000,
    rmdRequired: 30_000,
    taxableCapitalGain: 0,
  }), context()), /exceeds the final-funding forced amount/);
  const sourcePlan = readyPlan();
  assert.throws(() => buildWithdrawalTaxCounterfactualContext(
    sourcePlan,
    resolveInputs(sourcePlan, {}),
    { filingStatus: 'single', taxableGainFraction: 0.5 }
  ), /exact engine-row taxable gain/);
  assert.throws(() => buildWithdrawalTaxCounterfactualContext(
    sourcePlan,
    resolveInputs(sourcePlan, {}),
    { filingStatus: 'single', resolved: { taxableIra: 0 } }
  ), /cannot override/);

  const accumulation = runWithdrawalTaxCounterfactual({
    year: 1, age: 64, phase: 'accum', failed: false,
  }, context());
  assert.equal(accumulation.schemaVersion, 2);
  assert.equal(accumulation.status, 'not-applicable');
  const filler = runWithdrawalTaxCounterfactual({
    year: 2, age: 66, source: null, failed: true,
  }, context());
  assert.equal(filler.schemaVersion, 2);
  assert.equal(filler.status, 'not-applicable');
});

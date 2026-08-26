import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPlan, resolveInputs, runSinglePath } from '../../../engine.js';
import { flatAssetReturnRow } from '../../../test/fixtures/assetReturnRows.js';
import { createAccount } from '../../household/createAccount.js';
import { applyHouseholdTaxFactEdit } from '../../household/taxFactEdits.js';
import {
  createBlankTaxProfiles,
  createFact,
} from '../../household/factEnvelope.js';
import { buildHouseholdTaxFactContract } from './buildHouseholdTaxFactContract.js';
import { createFederalTaxResolver } from './createFederalTaxResolver.js';

function plan(){
  const value = structuredClone(defaultPlan);
  value.meta.filingStatus = 'single';
  value.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 66 };
  value.household.spouse = null;
  value.portfolio.accounts = {
    taxable: { balance: 0, basisPct: 0.6 },
    traditional: { balance: 0 },
    roth: { balance: 0 },
  };
  value.portfolio.extraAccounts = [];
  value.taxProfiles = createBlankTaxProfiles();
  value.income.socialSecurity = { primary: { pia: 0, claimAge: 67 }, spouse: null };
  value.income.other = [];
  value.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
  value.expenses = {
    living: 120000, housing: 0, debt: 0, healthcare: 0,
    healthcareRealGrowth: 0, extra: [],
  };
  value.liabilities = [];
  value.properties = [];
  value.goals = [];
  value.ltc = { amount: 0, onsetAge: 85 };
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

function account(typeId, id, balance, changes = {}){
  return {
    ...createAccount(typeId, { owner: changes.owner ?? 'client', balance }),
    id,
    ...changes,
  };
}

function fact(value){
  return createFact(value, 'confirmed', 'household-entry', '2026-07-12T12:00:00Z');
}

function factRecord(contract, path){
  return contract.factRecords.find(record => record.path === path);
}

test('contract exposes complete confirmed taxable basis as the only calculation input', () => {
  const value = plan();
  value.portfolio.extraAccounts = [
    account('brokerage_taxable', 'broker', 200000, { basis: confirmedBasis(20000) }),
    account('checking', 'bank', 10000),
  ];
  const before = structuredClone(value);
  const first = buildHouseholdTaxFactContract(value);
  const second = buildHouseholdTaxFactContract(value);

  const override = first.calculationInputs.taxableBasisOverride;
  assert.equal(override.amount, 30000);
  assert.equal(override.taxableBalance, 210000);
  assert.deepEqual(override.accountIds, ['broker', 'bank']);
  assert.equal(override.evidence.reduce((sum, item) => sum + item.amount, 0), 30000);
  assert.deepEqual(override.evidence.map(item => item.method), [
    'reported-cost-basis', 'principal',
  ]);
  assert.equal(override.evidence[0].reporting.reportingTaxpayer, 'client');
  assert.equal(factRecord(first, 'portfolio.extraAccounts.0.basis').disposition, 'calculation');
  assert.equal(factRecord(first, 'portfolio.extraAccounts.0.basis').method, 'reported-cost-basis');
  assert.equal(factRecord(first, 'portfolio.extraAccounts.1.basis').disposition, 'calculation');
  assert.equal(factRecord(first, 'portfolio.extraAccounts.1.basis').reason, 'structural-principal');
  assert.equal(resolveInputs(value, {}).accounts.taxable.basis, 30000);
  assert.deepEqual(first, second);
  assert.deepEqual(value, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.factRecords), true);
  assert.equal(Object.isFrozen(first.calculationInputs.taxableBasisOverride), true);
  assert.throws(() => { first.readiness.status = 'ready'; }, TypeError);
});

test('Household editor facts flow through the contract without a second translation path', () => {
  const value = plan();
  value.portfolio.extraAccounts = [
    account('brokerage_taxable', 'broker', 200000),
    account('checking', 'bank', 10000),
  ];
  applyHouseholdTaxFactEdit(value, {
    kind: 'confirm-account-basis', accountId: 'broker', value: 25000,
  }, { now: '2026-07-12T15:00:00.000Z' });

  const contract = buildHouseholdTaxFactContract(value);
  assert.equal(contract.calculationInputs.taxableBasisOverride.amount, 35000);
  assert.equal(resolveInputs(value, {}).accounts.taxable.basis, 35000);
  assert.equal(factRecord(contract, 'portfolio.extraAccounts.0.basis').source, 'household-entry');
});

test('unknown and assumed brokerage basis use the approved 50/50 calculation input', () => {
  const cases = [
    null,
    {
      amount: 1000, method: 'legacy-proportional', status: 'assumed',
      source: 'planner-assumption', confirmedAt: null, version: 1,
    },
  ];
  for(const basis of cases){
    const value = plan();
    const brokerage = account('brokerage_taxable', 'broker', 200000);
    if(basis) brokerage.basis = basis;
    value.portfolio.extraAccounts = [brokerage];
    const contract = buildHouseholdTaxFactContract(value);
    assert.equal(contract.calculationInputs.taxableBasisOverride.amount, 100000);
    assert.equal(contract.calculationInputs.provisionalTaxableBasis, 100000);
    assert.equal(contract.calculationInputs.taxableBasisMode, 'assumed-50-50');
    assert.deepEqual(
      contract.calculationInputs.taxableBasisAssumptions.map(item => item.code),
      ['TAXABLE_BASIS_ASSUMED_50_50']
    );
    assert.equal(resolveInputs(value, {}).accounts.taxable.basis, 100000);
    assert.equal(contract.readiness.status, 'rules-pending');
    assert.equal(contract.readiness.factCompleteness, 'incomplete');
    assert.ok(contract.readiness.gaps.some(
      gap => gap.code === 'TAXABLE_BASIS_ASSUMED_50_50'
    ));
  }
});

test('confirmed zero, false, and empty arrays retain value and provenance', () => {
  const value = plan();
  value.household.spouse = { currentAge: 64, retirementAge: 65, planEndAge: 66 };
  value.portfolio.extraAccounts = [
    account('traditional_ira', 'trad', 100000),
    account('roth_ira', 'roth', 100000),
  ];
  value.taxProfiles.client.blind = fact(false);
  value.taxProfiles.client.traditionalIra.priorYearCarryforwardBasis = fact(0);
  value.taxProfiles.client.rothIra.conversionCohorts = fact([]);

  const contract = buildHouseholdTaxFactContract(value);
  const blind = factRecord(contract, 'taxProfiles.client.blind');
  const ira = factRecord(contract, 'taxProfiles.client.traditionalIra.priorYearCarryforwardBasis');
  const cohorts = factRecord(contract, 'taxProfiles.client.rothIra.conversionCohorts');
  assert.equal(blind.value, false);
  assert.equal(ira.value, 0);
  assert.deepEqual(cohorts.value, []);
  assert.equal(blind.status, 'confirmed');
  assert.equal(ira.source, 'household-entry');
  assert.equal(Object.isFrozen(cohorts.value), true);
  assert.equal(ira.disposition, 'readiness-only');
});

test('semantically invalid confirmed values block readiness without reaching calculations', () => {
  const value = plan();
  value.taxProfiles.client.blind = fact('false');
  value.taxProfiles.client.rothIra.conversionCohorts = fact(false);
  const contract = buildHouseholdTaxFactContract(value);
  assert.equal(contract.readiness.status, 'blocked');
  assert.ok(contract.readiness.gaps.some(gap => (
    gap.code === 'FACT_VALUE_INVALID' && gap.path === 'taxProfiles.client.blind'
  )));
  assert.equal(factRecord(contract, 'taxProfiles.client.blind').disposition, 'excluded');
});

test('IRA, Roth, and employer facts remain readiness-only and never alter resolved engine inputs', () => {
  const blank = plan();
  blank.portfolio.extraAccounts = [
    account('traditional_ira', 'trad', 100000),
    account('roth_ira', 'roth', 50000),
    account('401k', 'work', 75000),
    account('roth_401k', 'roth-work', 25000),
  ];
  const completed = structuredClone(blank);
  completed.taxProfiles.client.traditionalIra.priorYearCarryforwardBasis = fact(50000);
  completed.taxProfiles.client.rothIra.contributionBasis = fact(25000);
  completed.portfolio.extraAccounts[2].employerPlanFacts.afterTaxContributionBasis = fact(10000);
  completed.portfolio.extraAccounts[3].designatedRothFacts.contributionBasis = fact(5000);

  assert.deepEqual(resolveInputs(completed, {}), resolveInputs(blank, {}));
  const contract = buildHouseholdTaxFactContract(completed);
  assert.equal(contract.calculationInputs.taxableBasisOverride, null);
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'FORM_8606_DISTRIBUTION_RULE_PENDING'));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'ROTH_DISTRIBUTION_RULE_PENDING'));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'EMPLOYER_AFTER_TAX_BASIS_RULE_PENDING'));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'DESIGNATED_ROTH_DISTRIBUTION_RULE_PENDING'));
});

test('inherited, HSA, and 529 accounts remain explicit scope limits', () => {
  const value = plan();
  value.portfolio.extraAccounts = [
    account('inherited_traditional_ira', 'inherited', 50000),
    account('hsa', 'hsa', 25000),
    account('legacy_529', '529', 10000),
  ];
  const contract = buildHouseholdTaxFactContract(value);
  assert.deepEqual(contract.scope.inheritedRulesPending.map(account => account.id), ['inherited']);
  assert.deepEqual(contract.scope.hsaUnsupported.map(account => account.id), ['hsa']);
  assert.deepEqual(contract.scope.outsideTaxBuckets.map(account => account.id), ['529']);
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'HSA_TAX_TREATMENT_UNSUPPORTED'));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'INHERITED_ACCOUNT_RULES_PENDING'));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'ACCOUNT_OUTSIDE_TAX_BUCKET_SCOPE'));
  assert.equal(contract.readiness.status, 'rules-pending');
});

test('loss-position basis is preserved but not advertised as calculation-ready', () => {
  const value = plan();
  value.portfolio.extraAccounts = [
    account('brokerage_taxable', 'loss', 100000, { basis: confirmedBasis(125000) }),
  ];
  const contract = buildHouseholdTaxFactContract(value);
  const basis = factRecord(contract, 'portfolio.extraAccounts.0.basis');
  assert.equal(basis.value, 125000);
  assert.equal(basis.status, 'confirmed');
  assert.equal(basis.method, 'reported-cost-basis');
  assert.equal(basis.disposition, 'readiness-only');
  assert.equal(contract.calculationInputs.taxableBasisOverride, null);
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'TAXABLE_LOSS_TREATMENT_PENDING'));
});

test('filing status is required and validated before strategy-tax use', () => {
  const missing = plan();
  delete missing.meta.filingStatus;
  const missingContract = buildHouseholdTaxFactContract(missing);
  assert.equal(missingContract.filingStatus, null);
  assert.ok(missingContract.readiness.gaps.some(gap => gap.code === 'FILING_STATUS_MISSING'));

  const invalid = plan();
  invalid.meta.filingStatus = 'martian';
  const invalidContract = buildHouseholdTaxFactContract(invalid);
  assert.equal(invalidContract.readiness.status, 'blocked');
  assert.ok(invalidContract.readiness.gaps.some(gap => gap.code === 'FILING_STATUS_INVALID'));

  const jointWithoutSpouse = plan();
  jointWithoutSpouse.meta.filingStatus = 'marriedFilingJointly';
  assert.ok(buildHouseholdTaxFactContract(jointWithoutSpouse).readiness.gaps.some(gap => (
    gap.code === 'FILING_STATUS_HOUSEHOLD_MISMATCH'
  )));

  const singleWithSpouse = plan();
  singleWithSpouse.household.spouse = { currentAge: 64, retirementAge: 65, planEndAge: 66 };
  assert.equal(buildHouseholdTaxFactContract(singleWithSpouse).readiness.status, 'blocked');

  const hohWithSpouse = plan();
  hohWithSpouse.meta.filingStatus = 'headOfHousehold';
  hohWithSpouse.household.spouse = { currentAge: 64, retirementAge: 65, planEndAge: 66 };
  assert.ok(buildHouseholdTaxFactContract(hohWithSpouse).readiness.gaps.some(gap => (
    gap.code === 'FILING_STATUS_HOUSEHOLD_MISMATCH'
  )));
});

test('return reporting gates Traditional IRA owner facts', () => {
  const value = plan();
  const ira = account('traditional_ira', 'separate-ira', 100000);
  ira.taxReporting.inclusion = 'separate-return';
  value.portfolio.extraAccounts = [ira];
  const contract = buildHouseholdTaxFactContract(value);
  const iraFact = factRecord(
    contract,
    'taxProfiles.client.traditionalIra.priorYearCarryforwardBasis'
  );
  assert.equal(iraFact.disposition, 'excluded');
  assert.deepEqual(iraFact.applicableAccountIds, []);
  assert.deepEqual(contract.scope.outsideHouseholdReturn.map(item => item.id), ['separate-ira']);
  assert.ok(contract.readiness.gaps.some(gap => (
    gap.code === 'TAX_REPORTING_OUTSIDE_HOUSEHOLD_RETURN'
    && gap.accountId === 'separate-ira'
  )));
});

test('return reporting also gates Roth and employer account facts', () => {
  const cases = [
    {
      typeId: 'roth_ira',
      path: 'taxProfiles.client.rothIra.contributionBasis',
    },
    {
      typeId: '401k',
      path: 'portfolio.extraAccounts.0.employerPlanFacts.afterTaxContributionBasis',
    },
    {
      typeId: 'roth_401k',
      path: 'portfolio.extraAccounts.0.designatedRothFacts.contributionBasis',
    },
  ];
  for(const item of cases){
    const value = plan();
    const raw = account(item.typeId, `separate-${item.typeId}`, 100000);
    raw.taxReporting.inclusion = 'separate-return';
    value.portfolio.extraAccounts = [raw];
    const contract = buildHouseholdTaxFactContract(value);
    assert.equal(factRecord(contract, item.path).disposition, 'excluded');
    assert.ok(contract.readiness.gaps.some(gap => (
      gap.code === 'TAX_REPORTING_OUTSIDE_HOUSEHOLD_RETURN'
      && gap.accountId === raw.id
    )));
  }

  const mfs = plan();
  mfs.meta.filingStatus = 'marriedFilingSeparately';
  mfs.portfolio.extraAccounts = [account('roth_ira', 'mfs-roth', 100000)];
  assert.ok(buildHouseholdTaxFactContract(mfs).readiness.gaps.some(gap => (
    gap.code === 'MFS_ACCOUNT_ATTRIBUTION_UNSUPPORTED'
  )));

  const mismatch = plan();
  const work = account('401k', 'mismatch-work', 100000);
  work.taxReporting.reportingTaxpayer = 'spouse';
  mismatch.portfolio.extraAccounts = [work];
  assert.ok(buildHouseholdTaxFactContract(mismatch).readiness.gaps.some(gap => (
    gap.code === 'TAX_REPORTING_OWNER_MISMATCH'
  )));
});

test('legacy Traditional and Roth sleeves remain explicit unattributed assumptions', () => {
  const value = plan();
  value.portfolio.accounts.traditional.balance = 100000;
  value.portfolio.accounts.roth.balance = 50000;
  const contract = buildHouseholdTaxFactContract(value);
  assert.deepEqual(contract.scope.legacyUnattributed.map(item => item.id), [
    'base-traditional', 'base-roth',
  ]);
  assert.ok(contract.readiness.gaps.some(gap => (
    gap.code === 'LEGACY_TRADITIONAL_TAX_FACTS_UNATTRIBUTED'
  )));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'LEGACY_ROTH_TAX_FACTS_UNATTRIBUTED'));
});

test('invalid ownership and malformed basis fail closed while unknown values stay unknown', () => {
  const value = plan();
  const spouseAccount = account('brokerage_taxable', 'orphan-spouse', 100000, {
    owner: 'spouse',
    basis: confirmedBasis(50000),
  });
  spouseAccount.taxReporting.reportingTaxpayer = 'spouse';
  const jointIra = account('traditional_ira', 'joint-ira', 50000, { owner: 'joint' });
  jointIra.taxReporting = {
    inclusion: 'household-return', reportingTaxpayer: 'return-level', householdReturnShare: 1,
  };
  const malformed = account('brokerage_taxable', 'bad-basis', 25000);
  malformed.basis.amount = '1000';
  value.portfolio.extraAccounts = [spouseAccount, jointIra, malformed];
  value.taxProfiles.client.blind = {
    value: true, status: 'unknown', source: null, confirmedAt: null, version: 1,
  };

  const contract = buildHouseholdTaxFactContract(value);
  assert.equal(contract.readiness.status, 'blocked');
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'ACCOUNT_OWNER_WITHOUT_SPOUSE'));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'INDIVIDUAL_ACCOUNT_OWNER_UNSUPPORTED'));
  assert.ok(contract.readiness.gaps.some(gap => gap.code === 'BASIS_ENVELOPE_INVALID'));
  assert.equal(factRecord(contract, 'taxProfiles.client.blind').value, null);
});

test('confirmed cost basis reaches row gain facts and changes federal line 24', () => {
  const confirmed = plan();
  confirmed.portfolio.extraAccounts = [
    account('brokerage_taxable', 'broker', 200000, { basis: confirmedBasis(20000) }),
  ];
  const unknown = plan();
  unknown.portfolio.extraAccounts = [account('brokerage_taxable', 'broker', 200000)];
  const confirmedParams = resolveInputs(confirmed, {});
  const unknownParams = resolveInputs(unknown, {});
  const returnPath = Array.from(
    { length: confirmedParams.horizonYears },
    (_, yearIndex) => flatAssetReturnRow(2025 + yearIndex),
  );
  const confirmedRow = runSinglePath(confirmedParams, returnPath).rows[0];
  const unknownRow = runSinglePath(unknownParams, returnPath).rows[0];
  assert.ok(confirmedRow.taxableGainFraction > unknownRow.taxableGainFraction);

  const options = { filingStatus: 'single', baseTaxYear: 2025, scenarioId: 'phase4a_basis' };
  const confirmedTax = createFederalTaxResolver(confirmedParams, options)(confirmedRow);
  const unknownTax = createFederalTaxResolver(unknownParams, options)(unknownRow);
  assert.ok(confirmedTax > unknownTax,
    `confirmed low basis tax ${confirmedTax} must exceed fallback-basis tax ${unknownTax}`);
});

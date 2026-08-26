import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCOUNT_SCHEMA_VERSION,
  UNSUPPORTED_TYPE_ID,
  getAccountTypeRegistry,
  getWizardAccountTypes,
  resolveTypeFromLabel,
} from './accountTypes.js';
import { createAccount } from './createAccount.js';
import {
  createBlankTaxProfiles,
  createFact,
  taxProfileHasConfirmedFacts,
  validateFactEnvelope,
} from './factEnvelope.js';
import {
  ACCOUNT_SCHEMA_VERSION_UNSUPPORTED,
  LEGACY_BASE_ACCOUNT_IDS,
  deriveHouseholdIssues,
  deterministicLegacyAccountId,
  mergeNonAccountDefaults,
  migrateHouseholdRecord,
  migrateHouseholdsDb,
  validateCurrentSchemaHousehold,
} from './migrateAccounts.js';
import {
  INVALID_ASSET_WEIGHTS,
  ASSET_ALLOCATION_PRESET_CATALOG_ID,
  resolveCashOnlyAllocation,
  snapshotPresetAllocation,
  snapshotLegacyRiskProfileAllocation,
  withCustomAssetWeights,
} from './investmentAllocation.js';
import {
  createMemoryStorage,
  prepareHouseholdStore,
  readHouseholdStore,
  commitPreparedHouseholdStore,
  HHDB_KEY,
  ACTIVE_KEY,
} from './persistence.js';

const LEGACY_RISK_PROFILE = 3;

function baseSleeve(bucket, values){
  return {
    id: LEGACY_BASE_ACCOUNT_IDS[bucket],
    ...values,
    investmentAllocation: snapshotLegacyRiskProfileAllocation(LEGACY_RISK_PROFILE),
  };
}

const pristinePlan = { meta: {}, household: { primary: { currentAge: 60, retirementAge: 65, planEndAge: 90 } }, portfolio: { riskProfile: LEGACY_RISK_PROFILE, accounts: { taxable: baseSleeve('taxable', { balance: 0, basisPct: 1 }), traditional: baseSleeve('traditional', { balance: 0 }), roth: baseSleeve('roth', { balance: 0 }) }, extraAccounts: [] }, income: {}, expenses: {}, savings: {}, simulation: {} };

function createBlankHousehold(id){
  const p = JSON.parse(JSON.stringify(pristinePlan));
  p.meta = { householdId: id, name: 'New Household', accountSchemaVersion: ACCOUNT_SCHEMA_VERSION };
  p.taxProfiles = createBlankTaxProfiles();
  return p;
}

function createSelectableDefaultHouseholds(){
  const p = createBlankHousehold('now-household');
  p.meta.name = 'Now Household';
  p.meta.isSelectableDefault = true;
  return [p];
}

function createLegacyHousehold(id = 'hh1', extraAccounts = []){
  return {
    meta: { householdId: id },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: {
        taxable: { balance: 0, basisPct: 1 },
        traditional: { balance: 0 },
        roth: { balance: 0 },
      },
      extraAccounts,
    },
  };
}

const deps = {
  createSelectableDefaultHouseholds,
  createBlankHousehold,
  pristinePlan,
  currentYear: () => 2026,
};

test('resolveTypeFromLabel matches aliases and never defaults unknown to taxable', () => {
  assert.equal(resolveTypeFromLabel('401(k)').typeId, '401k');
  assert.equal(resolveTypeFromLabel(' brokerage ').typeId, 'brokerage_taxable');
  const unknown = resolveTypeFromLabel('Mystery account');
  assert.equal(unknown.known, false);
  assert.equal(unknown.engineBucket, null);
});

test('every documented alias resolves to its canonical registry entry', () => {
  for(const entry of getAccountTypeRegistry()){
    for(const alias of [...entry.aliases, entry.label]){
      const resolved = resolveTypeFromLabel(alias);
      assert.equal(resolved.typeId, entry.id, `${alias} should resolve to ${entry.id}`);
      assert.equal(resolved.engineBucket, entry.engineBucket);
    }
  }
});

test('registry exports are immutable', () => {
  const registry = getAccountTypeRegistry();
  assert.throws(() => { registry[0] = {}; });
  assert.throws(() => { registry[0].label = 'changed'; });
});

test('getWizardAccountTypes exposes the approved grouped account choices in order', () => {
  assert.deepEqual(getWizardAccountTypes().map(w => w.label), [
    'Checking', 'Savings', 'Money Market', 'CD',
    'Brokerage (taxable)', 'Joint brokerage', 'TOD brokerage',
    'Traditional IRA', 'Rollover IRA', 'SEP IRA', 'SIMPLE IRA',
    '401(k)', '403(b)', '457', '401(a)', 'TSP', 'Solo 401(k)',
    'Roth IRA', 'Roth 401(k)', 'Roth 403(b)', 'Roth 457', 'Roth TSP', 'HSA',
  ]);
  const joint = getWizardAccountTypes().filter(type => type.owners.includes('joint')).map(type => type.typeId);
  assert.deepEqual(joint, [
    'checking', 'savings', 'money_market', 'certificate_of_deposit',
    'brokerage_taxable', 'joint_brokerage',
  ]);
});

test('registry marks only the locked canonical account IDs as allocation eligible', () => {
  const eligibleIds = getAccountTypeRegistry()
    .filter(type => type.investmentAllocationEligible)
    .map(type => type.id);
  assert.deepEqual(eligibleIds, [
    'brokerage_taxable', 'joint_brokerage', 'trust_brokerage', 'tod_brokerage',
    'traditional_ira', 'rollover_ira', 'sep_ira', 'simple_ira',
    'inherited_traditional_ira', '401k', '403b', '457', '401a', 'tsp',
    'solo_401k', 'qualified_plan', 'roth_ira', 'inherited_roth_ira',
    'roth_401k', 'roth_403b', 'roth_457', 'roth_tsp', 'hsa', 'legacy_529',
  ]);
  assert.deepEqual(
    getAccountTypeRegistry().filter(type => !type.investmentAllocationEligible).map(type => type.id),
    ['checking', 'savings', 'money_market', 'certificate_of_deposit'],
  );
});

test('createFact preserves explicit status and confirmed empty arrays count', () => {
  const fact = createFact([], 'confirmed', 'household-entry', '2026-01-01T00:00:00.000Z');
  assert.equal(fact.status, 'confirmed');
  const profile = createBlankTaxProfiles().spouse;
  profile.rothIra.conversionCohorts = fact;
  assert.equal(taxProfileHasConfirmedFacts(profile), true);
});

test('confirmed zero, false, and empty arrays remain meaningful confirmed facts', () => {
  for(const value of [0, false, []]){
    const profile = createBlankTaxProfiles().client;
    profile.rothIra.conversionCohorts = createFact(
      value,
      'confirmed',
      'household-entry',
      '2026-01-01T00:00:00.000Z',
    );
    assert.equal(taxProfileHasConfirmedFacts(profile), true);
  }
});

test('fact constructors and validators enforce complete provenance and timestamps', () => {
  const assumed = createFact(10, 'assumed', 'planner-assumption', null);
  assert.equal(assumed.status, 'assumed');
  assert.throws(() => createFact(10, 'assumed'), /requires source/i);
  assert.throws(() => createFact(null, 'confirmed', 'household-entry', '2026-01-01T00:00:00.000Z'), /require.*value/i);
  assert.throws(() => createFact(10, 'confirmed', 'bad-source', '2026-01-01T00:00:00.000Z'), /invalid source/i);
  assert.throws(() => createFact(10, 'confirmed', 'household-entry', '2026-02-30T00:00:00.000Z'), /confirmedAt/i);

  const incomplete = createFact(null);
  delete incomplete.source;
  assert.throws(() => validateFactEnvelope(incomplete, 'fact'), /source is required/i);
});

test('createAccount rejects invalid balances and accepts omitted balance', () => {
  assert.throws(() => createAccount('brokerage_taxable', { balance: -1 }));
  assert.throws(() => createAccount('brokerage_taxable', { balance: Infinity }));
  assert.equal(createAccount('brokerage_taxable').balance, 0);
});

test('createAccount rejects explicit nonnumeric values, nulls, invalid owners, and invalid dates', () => {
  for(const balance of ['100', '', null, undefined, true, false, [], {}, NaN, Infinity, -Infinity, -1]){
    assert.throws(() => createAccount('brokerage_taxable', { balance }), /balance/i);
  }
  for(const owner of ['', null, 'other']){
    assert.throws(() => createAccount('brokerage_taxable', { owner }), /owner/i);
  }
  for(const valuationDate of [undefined, '', '2026-02-29', '2026-99-99', 20260101]){
    assert.throws(() => createAccount('brokerage_taxable', { valuationDate }), /valuationDate/i);
  }
  assert.equal(createAccount('brokerage_taxable', { valuationDate: '2024-02-29' }).valuationDate, '2024-02-29');
});

test('new accounts persist explicit Balanced or cash-only allocation without a runtime fallback', () => {
  const eligible = createAccount('roth_ira');
  assert.deepEqual(eligible.investmentAllocation, snapshotPresetAllocation('balanced'));
  assert.equal(eligible.investmentAllocation.presetVersion, ASSET_ALLOCATION_PRESET_CATALOG_ID);

  const bank = createAccount('savings');
  assert.deepEqual(bank.investmentAllocation, resolveCashOnlyAllocation());
  assert.throws(
    () => createAccount('savings', { investmentAllocation: snapshotPresetAllocation('balanced') }),
    /cash-only/i,
  );
  assert.throws(
    () => createAccount('roth_ira', { investmentAllocation: { weights: {} } }),
    error => error?.code === INVALID_ASSET_WEIGHTS,
  );

  const allCashWeights = Object.fromEntries(
    Object.keys(snapshotPresetAllocation('balanced').weights).map(key => [key, key === 'cash' ? 1 : 0]),
  );
  const explicitCustom = withCustomAssetWeights(snapshotPresetAllocation('balanced'), allCashWeights);
  const customAccount = createAccount('roth_ira', { investmentAllocation: explicitCustom });
  assert.deepEqual(customAccount.investmentAllocation, explicitCustom);
  assert.equal(customAccount.investmentAllocation.source, 'custom');
  assert.throws(
    () => createAccount('roth_ira', { investmentAllocation: resolveCashOnlyAllocation() }),
    /reserved|require/i,
  );
});

test('every registered account constructor emits its complete canonical shape', () => {
  for(const entry of getAccountTypeRegistry()){
    const account = createAccount(entry.id);
    assert.ok(account.id.startsWith('acct_'));
    assert.equal(account.typeId, entry.id);
    assert.equal(account.type, entry.label);
    assert.equal(account.bucket, entry.engineBucket);
    assert.equal(account.balance, 0);
    assert.equal(account.valuationDate, null);
    assert.deepEqual(Object.keys(account.basis).sort(), ['amount', 'confirmedAt', 'method', 'source', 'status', 'version']);
    assert.deepEqual(Object.keys(account.taxReporting).sort(), ['householdReturnShare', 'inclusion', 'reportingTaxpayer']);
    assert.equal(account.employerPlanFacts !== null, entry.taxCharacter === 'employer_pretax');
    assert.equal(account.designatedRothFacts !== null, entry.taxCharacter === 'designated_roth');
    validateCurrentSchemaHousehold({
      ...createBlankHousehold('constructor'),
      portfolio: {
        ...createBlankHousehold('constructor').portfolio,
        extraAccounts: [account],
      },
    }, 'constructor');
  }
});

test('invalid legacy balance fails migration instead of becoming zero', () => {
  const legacy = {
    meta: { householdId: 'hh1' },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'Brokerage (taxable)', bucket: 'taxable', owner: 'client', balance: -5 }],
    },
  };
  assert.throws(() => migrateHouseholdRecord(legacy, 'hh1'), /invalid balance/i);
});

test('legacy missing balance fails migration instead of becoming zero', () => {
  const legacy = {
    meta: { householdId: 'hh1' },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'HSA', bucket: 'roth', owner: 'client' }],
    },
  };
  assert.throws(() => migrateHouseholdRecord(legacy, 'hh1'), /invalid balance/i);
});

test('current and legacy migration reject every malformed balance category', () => {
  const invalidBalances = [-1, '100', '', null, undefined, true, false, [], {}, NaN, Infinity, -Infinity];
  for(const balance of invalidBalances){
    const current = createBlankHousehold('current');
    const account = createAccount('hsa', { balance: 1 });
    account.balance = balance;
    current.portfolio.extraAccounts = [account];
    assert.throws(
      () => migrateHouseholdRecord(current, 'current'),
      /invalid balance/i,
      `current balance ${String(balance)} should fail`,
    );

    const legacy = createLegacyHousehold('legacy', [{ type: 'HSA', bucket: 'roth', owner: 'client', balance }]);
    assert.throws(
      () => migrateHouseholdRecord(legacy, 'legacy'),
      /invalid balance/i,
      `legacy balance ${String(balance)} should fail`,
    );
  }
});

test('legacy classification follows known and unknown bucket matrix', () => {
  const knownMissing = migrateHouseholdRecord(createLegacyHousehold('missing', [
    { type: '401(k)', owner: 'client', balance: 100 },
  ]), 'missing').plan;
  assert.equal(knownMissing.portfolio.extraAccounts[0].bucket, 'traditional');

  const knownMatching = migrateHouseholdRecord(createLegacyHousehold('matching', [
    { type: '401(k)', bucket: 'traditional', owner: 'client', balance: 100 },
  ]), 'matching').plan;
  assert.equal(knownMatching.portfolio.extraAccounts[0].bucket, 'traditional');

  const knownConflict = migrateHouseholdRecord(createLegacyHousehold('conflict', [
    { type: '401(k)', bucket: 'roth', owner: 'client', balance: 100 },
  ]), 'conflict').plan;
  assert.equal(knownConflict.portfolio.extraAccounts[0].bucket, 'roth');
  assert.ok(deriveHouseholdIssues(knownConflict).some(issue => issue.startsWith('ACCOUNT_BUCKET_CONFLICT:')));

  for(const bucket of [null, '', 0, 'invalid']){
    assert.throws(
      () => migrateHouseholdRecord(createLegacyHousehold('known-invalid', [
        { type: '401(k)', bucket, owner: 'client', balance: 100 },
      ]), 'known-invalid'),
      /invalid bucket/i,
    );
  }

  const unknownValid = migrateHouseholdRecord(createLegacyHousehold('unknown-valid', [
    { type: 'Mystery account', bucket: 'taxable', owner: 'client', balance: 100 },
  ]), 'unknown-valid').plan;
  assert.equal(unknownValid.portfolio.extraAccounts[0].typeId, UNSUPPORTED_TYPE_ID);
  assert.equal(unknownValid.portfolio.extraAccounts[0].bucket, 'taxable');
  assert.ok(deriveHouseholdIssues(unknownValid).some(issue => issue.startsWith('ACCOUNT_UNSUPPORTED:')));

  for(const bucket of [undefined, null, '', 0, 'invalid']){
    const entry = { type: 'Mystery account', owner: 'client', balance: 100 };
    if(bucket !== undefined) entry.bucket = bucket;
    const migrated = migrateHouseholdRecord(createLegacyHousehold(`unknown-${bucket}`, [entry]), `unknown-${bucket}`).plan;
    assert.equal(migrated.portfolio.extraAccounts[0].type, 'Mystery account');
    assert.equal(migrated.portfolio.extraAccounts[0].balance, 100);
    assert.equal(migrated.portfolio.extraAccounts[0].bucket, null);
    assert.ok(deriveHouseholdIssues(migrated).some(issue => issue.startsWith('ACCOUNT_INVALID_CLASSIFICATION:')));
  }
});

test('legacy owner defaults only when missing and rejects explicit invalid owners', () => {
  const missing = migrateHouseholdRecord(createLegacyHousehold('missing-owner', [
    { type: 'HSA', bucket: 'roth', balance: 100 },
  ]), 'missing-owner').plan;
  assert.equal(missing.portfolio.extraAccounts[0].owner, 'joint');

  for(const owner of ['', null, 'other', 123]){
    const legacy = createLegacyHousehold('bad-owner', [{ type: 'HSA', bucket: 'roth', owner, balance: 100 }]);
    assert.throws(() => migrateHouseholdRecord(legacy, 'bad-owner'), /invalid owner/i);
  }
});

test('v1 household with one legacy-shaped account blocks without rewriting valid accounts', () => {
  const validAcct = createAccount('brokerage_taxable', { owner: 'client', balance: 50000, valuationDate: '2026-01-15' });
  validAcct.basis = {
    amount: 40000,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
  const plan = createBlankHousehold('hh1');
  plan.portfolio.extraAccounts = [
    validAcct,
    { type: 'HSA', bucket: 'roth', owner: 'client', balance: 1000 },
  ];
  const rawDb = { hh1: JSON.parse(JSON.stringify(plan)) };
  const result = migrateHouseholdsDb(rawDb);
  assert.equal(result.ok, false);
  assert.equal(rawDb.hh1.portfolio.extraAccounts[0].id, validAcct.id);
  assert.equal(rawDb.hh1.portfolio.extraAccounts[0].valuationDate, '2026-01-15');
  assert.equal(rawDb.hh1.portfolio.extraAccounts[0].basis.status, 'confirmed');
});

test('v1 validation rejects numeric-string balances and impossible valuation dates', () => {
  const plan = createBlankHousehold('hh1');
  const acct = createAccount('brokerage_taxable', { owner: 'client', balance: 1000 });
  acct.balance = '1000';
  plan.portfolio.extraAccounts = [acct];
  assert.throws(() => validateCurrentSchemaHousehold(plan, 'hh1'), /invalid balance/i);

  const acct2 = createAccount('brokerage_taxable', { owner: 'client', balance: 1000 });
  acct2.valuationDate = '2026-99-99';
  plan.portfolio.extraAccounts = [acct2];
  assert.throws(() => validateCurrentSchemaHousehold(plan, 'hh1'), /valuationDate/i);
});

test('v1 validation rejects confirmed basis without required metadata', () => {
  const plan = createBlankHousehold('hh1');
  const acct = createAccount('brokerage_taxable', { owner: 'client', balance: 1000 });
  acct.basis = { amount: 500, method: 'reported-cost-basis', status: 'confirmed', source: null, confirmedAt: null, version: 1 };
  plan.portfolio.extraAccounts = [acct];
  assert.throws(() => validateCurrentSchemaHousehold(plan, 'hh1'), /confirmed fact requires/i);
});

test('v1 validation rejects missing required account and profile subtrees without repair', () => {
  const mutations = [
    plan => { delete plan.portfolio.accounts; },
    plan => { delete plan.portfolio.accounts.roth; },
    plan => { delete plan.portfolio.extraAccounts; },
    plan => { plan.portfolio.extraAccounts = {}; },
    plan => { plan.portfolio.extraAccounts = [null]; },
    plan => { plan.portfolio.extraAccounts = [[]]; },
    plan => { delete plan.taxProfiles; },
    plan => { delete plan.taxProfiles.client; },
    plan => { delete plan.taxProfiles.client.rothIra; },
    plan => { delete plan.taxProfiles.client.rothIra.firstContributionYear; },
  ];
  for(const mutate of mutations){
    const plan = createBlankHousehold('strict');
    mutate(plan);
    const before = structuredClone(plan);
    const result = migrateHouseholdsDb({ strict: plan });
    assert.equal(result.ok, false);
    assert.deepEqual(plan, before);
  }
});

test('v1 account validation requires complete basis and reporting records', () => {
  const mutations = [
    account => { delete account.basis.source; },
    account => { account.basis.amount = '100'; account.basis.status = 'assumed'; account.basis.source = 'planner-assumption'; },
    account => { account.basis.amount = 100; account.basis.status = 'assumed'; account.basis.source = null; },
    account => { account.basis.amount = 100; account.basis.status = 'confirmed'; account.basis.source = 'household-entry'; account.basis.confirmedAt = '2026-02-30T00:00:00.000Z'; },
    account => { delete account.taxReporting.householdReturnShare; },
    account => { account.taxReporting.householdReturnShare = '1'; },
    account => { account.taxReporting = []; },
  ];
  for(const mutate of mutations){
    const plan = createBlankHousehold('strict');
    const account = createAccount('brokerage_taxable', { balance: 100 });
    mutate(account);
    plan.portfolio.extraAccounts = [account];
    assert.throws(() => validateCurrentSchemaHousehold(plan, 'strict'));
  }
});

test('v1 account validation requires every persisted account field', () => {
  const requiredFields = [
    'id', 'typeId', 'type', 'owner', 'bucket', 'balance', 'valuationDate',
    'basis', 'taxReporting', 'employerPlanFacts', 'designatedRothFacts',
    'investmentAllocation',
  ];
  for(const field of requiredFields){
    const plan = createBlankHousehold(`field-${field}`);
    const account = createAccount('hsa', { balance: 100 });
    delete account[field];
    plan.portfolio.extraAccounts = [account];
    assert.throws(
      () => validateCurrentSchemaHousehold(plan, `field-${field}`),
      new RegExp(`${field}.*required|${field}.*invalid`, 'i'),
    );
  }
});

test('v1 account validation requires type-appropriate employer and designated Roth facts', () => {
  const employerMissing = createBlankHousehold('employer');
  const employer = createAccount('401k', { balance: 100 });
  employer.employerPlanFacts = null;
  employerMissing.portfolio.extraAccounts = [employer];
  assert.throws(() => validateCurrentSchemaHousehold(employerMissing, 'employer'), /employerPlanFacts is required/i);

  const employerIncomplete = createBlankHousehold('employer-incomplete');
  const incomplete = createAccount('401k', { balance: 100 });
  delete incomplete.employerPlanFacts.planSubtypeConfirmed;
  employerIncomplete.portfolio.extraAccounts = [incomplete];
  assert.throws(() => validateCurrentSchemaHousehold(employerIncomplete, 'employer-incomplete'), /planSubtypeConfirmed is required/i);

  const designatedMissing = createBlankHousehold('designated');
  const designated = createAccount('roth_401k', { balance: 100 });
  designated.designatedRothFacts = null;
  designatedMissing.portfolio.extraAccounts = [designated];
  assert.throws(() => validateCurrentSchemaHousehold(designatedMissing, 'designated'), /designatedRothFacts is required/i);

  const wrongType = createBlankHousehold('wrong-type');
  const ira = createAccount('traditional_ira', { balance: 100 });
  ira.employerPlanFacts = createAccount('401k').employerPlanFacts;
  wrongType.portfolio.extraAccounts = [ira];
  assert.throws(() => validateCurrentSchemaHousehold(wrongType, 'wrong-type'), /not valid for this account type/i);
});

test('v1 profile validation rejects malformed fact metadata and incomplete groups', () => {
  const invalidProfiles = [
    profile => { delete profile.traditionalIra.otherForm8606Adjustments; },
    profile => { profile.birthDate.source = 'bad-source'; },
    profile => {
      profile.birthDate.value = '1960-01-01';
      profile.birthDate.status = 'confirmed';
      profile.birthDate.source = 'household-entry';
      profile.birthDate.confirmedAt = 123;
    },
    profile => { profile.rothIra.conversionCohorts.version = 2; },
  ];
  for(const mutate of invalidProfiles){
    const plan = createBlankHousehold('profile');
    mutate(plan.taxProfiles.client);
    assert.throws(() => validateCurrentSchemaHousehold(plan, 'profile'));
  }
});

test('base sleeves and legacy basisPct require strict numeric values while loss percentages above one remain valid', () => {
  for(const balance of ['0', null, true, [], NaN, Infinity, -1]){
    const plan = createBlankHousehold('base');
    plan.portfolio.accounts.taxable.balance = balance;
    assert.throws(() => validateCurrentSchemaHousehold(plan, 'base'), /invalid balance/i);
  }
  for(const basisPct of ['1', null, true, [], NaN, Infinity, -1]){
    const plan = createBlankHousehold('basis');
    plan.portfolio.accounts.taxable.basisPct = basisPct;
    assert.throws(() => validateCurrentSchemaHousehold(plan, 'basis'), /basisPct/i);
  }
  const loss = createBlankHousehold('loss');
  loss.portfolio.accounts.taxable.basisPct = 1.25;
  assert.doesNotThrow(() => validateCurrentSchemaHousehold(loss, 'loss'));
});

test('invalid present schema versions block and do not mutate input', () => {
  for(const version of [null, '', undefined, -1, 1.5, '1', 'bad', NaN, Infinity]){
    const plan = createBlankHousehold('version');
    plan.meta.accountSchemaVersion = version;
    const before = structuredClone(plan);
    const result = migrateHouseholdsDb({ version: plan });
    assert.equal(result.ok, false);
    assert.deepEqual(plan, before);
  }
});

test('future schema version blocks without mutation', () => {
  const future = createBlankHousehold('hh1');
  future.meta.accountSchemaVersion = ACCOUNT_SCHEMA_VERSION + 1;
  const before = structuredClone(future);
  const result = migrateHouseholdsDb({ hh1: future });
  assert.equal(result.ok, false);
  assert.equal(result.code, ACCOUNT_SCHEMA_VERSION_UNSUPPORTED);
  assert.deepEqual(future, before);
});

test('mixed valid and malformed database is rejected as a whole', () => {
  const good = {
    meta: { householdId: 'good' },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'HSA', bucket: 'roth', owner: 'client', balance: 1000 }],
    },
  };
  const result = migrateHouseholdsDb({ good, bad: null });
  assert.equal(result.ok, false);
});

test('legacy migration rejects missing or malformed nested portfolio shapes and account entries', () => {
  const cases = [
    { meta: { householdId: 'missing-portfolio' } },
    { meta: { householdId: 'array-portfolio' }, portfolio: [] },
    { meta: { householdId: 'missing-accounts' }, portfolio: { extraAccounts: [] } },
    { meta: { householdId: 'missing-extras' }, portfolio: { accounts: createLegacyHousehold().portfolio.accounts } },
    { meta: { householdId: 'object-extras' }, portfolio: { accounts: createLegacyHousehold().portfolio.accounts, extraAccounts: {} } },
    createLegacyHousehold('null-account', [null]),
    createLegacyHousehold('array-account', [[]]),
  ];
  for(const record of cases){
    assert.equal(migrateHouseholdsDb({ record }).ok, false);
  }
});

test('multiple valid legacy households migrate atomically together', () => {
  const db = {
    one: createLegacyHousehold('one', [{ type: 'HSA', bucket: 'roth', owner: 'client', balance: 100 }]),
    two: createLegacyHousehold('two', [{ type: '401(k)', bucket: 'traditional', owner: 'spouse', balance: 200 }]),
  };
  const result = migrateHouseholdsDb(db);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.db.one.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.equal(result.db.two.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.equal(result.db.one.portfolio.extraAccounts[0].balance, 100);
  assert.equal(result.db.two.portfolio.extraAccounts[0].balance, 200);
});

test('v1 migration snapshots exact legacy risk weights onto base and typed accounts', () => {
  const plan = createBlankHousehold('v1-allocation');
  plan.meta.accountSchemaVersion = 1;
  plan.portfolio.riskProfile = 5;
  for(const sleeve of Object.values(plan.portfolio.accounts)){
    delete sleeve.id;
    delete sleeve.investmentAllocation;
  }
  const typed = createAccount('401k', { balance: 250000 });
  delete typed.investmentAllocation;
  const bank = createAccount('savings', { balance: 10000 });
  delete bank.investmentAllocation;
  plan.portfolio.extraAccounts = [typed, bank];

  const migrated = migrateHouseholdRecord(plan, 'v1-allocation');
  const expected = snapshotLegacyRiskProfileAllocation(5);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.plan.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.deepEqual(migrated.plan.portfolio.accounts.taxable.investmentAllocation, expected);
  assert.deepEqual(migrated.plan.portfolio.accounts.traditional.investmentAllocation, expected);
  assert.deepEqual(migrated.plan.portfolio.accounts.roth.investmentAllocation, expected);
  assert.deepEqual(migrated.plan.portfolio.extraAccounts[0].investmentAllocation, expected);
  assert.deepEqual(migrated.plan.portfolio.extraAccounts[1].investmentAllocation, resolveCashOnlyAllocation());
  assert.deepEqual(
    Object.fromEntries(Object.entries(migrated.plan.portfolio.accounts).map(([key, value]) => [key, value.id])),
    LEGACY_BASE_ACCOUNT_IDS,
  );
});

test('legacy allocation migration fails closed without a valid risk profile', () => {
  for(const riskProfile of [undefined, null, 0, 7, 3.5, '3']){
    const legacy = createLegacyHousehold('invalid-risk', [
      { type: 'Roth IRA', bucket: 'roth', owner: 'client', balance: 100 },
    ]);
    if(riskProfile === undefined) delete legacy.portfolio.riskProfile;
    else legacy.portfolio.riskProfile = riskProfile;
    const before = structuredClone(legacy);
    const result = migrateHouseholdsDb({ 'invalid-risk': legacy });
    assert.equal(result.ok, false);
    assert.deepEqual(legacy, before);
  }
});

test('unsupported positive engine accounts migrate with explicit review-required legacy allocation', () => {
  const migrated = migrateHouseholdRecord(createLegacyHousehold('unsupported-allocation', [
    { type: 'Mystery account', bucket: 'traditional', owner: 'client', balance: 500 },
    { type: 'Unknown empty', owner: 'client', balance: 0 },
  ]), 'unsupported-allocation').plan;
  assert.deepEqual(
    migrated.portfolio.extraAccounts[0].investmentAllocation,
    snapshotLegacyRiskProfileAllocation(LEGACY_RISK_PROFILE),
  );
  assert.equal(migrated.portfolio.extraAccounts[0].investmentAllocation.reviewRequired, true);
  assert.equal(migrated.portfolio.extraAccounts[1].investmentAllocation, null);
});

test('current schema fails closed when an explicit account allocation is missing or invalid', () => {
  const missing = createBlankHousehold('missing-allocation');
  const account = createAccount('brokerage_taxable', { balance: 100 });
  delete account.investmentAllocation;
  missing.portfolio.extraAccounts = [account];
  assert.throws(
    () => validateCurrentSchemaHousehold(missing, 'missing-allocation'),
    /investmentAllocation.*required/i,
  );

  const invalid = createBlankHousehold('invalid-allocation');
  invalid.portfolio.extraAccounts = [createAccount('brokerage_taxable', { balance: 100 })];
  invalid.portfolio.extraAccounts[0].investmentAllocation = structuredClone(
    invalid.portfolio.extraAccounts[0].investmentAllocation,
  );
  invalid.portfolio.extraAccounts[0].investmentAllocation.weights.usLarge = -1;
  assert.throws(
    () => validateCurrentSchemaHousehold(invalid, 'invalid-allocation'),
    error => error?.code === INVALID_ASSET_WEIGHTS,
  );

  const cashOnlyEligible = createBlankHousehold('cash-only-eligible');
  const eligible = createAccount('brokerage_taxable', { balance: 100 });
  eligible.investmentAllocation = structuredClone(resolveCashOnlyAllocation());
  cashOnlyEligible.portfolio.extraAccounts = [eligible];
  assert.throws(
    () => validateCurrentSchemaHousehold(cashOnlyEligible, 'cash-only-eligible'),
    /cash-only provenance is reserved/i,
  );

  const nonCashBank = createBlankHousehold('non-cash-bank');
  const bank = createAccount('savings', { balance: 100 });
  bank.investmentAllocation = structuredClone(snapshotPresetAllocation('balanced'));
  nonCashBank.portfolio.extraAccounts = [bank];
  assert.throws(
    () => validateCurrentSchemaHousehold(nonCashBank, 'non-cash-bank'),
    /must be cash-only/i,
  );

  const unsupported = migrateHouseholdRecord(createLegacyHousehold('unsupported-current', [
    { type: 'Mystery account', bucket: 'taxable', owner: 'client', balance: 100 },
  ]), 'unsupported-current').plan;
  unsupported.portfolio.extraAccounts[0].investmentAllocation = null;
  assert.throws(
    () => validateCurrentSchemaHousehold(unsupported, 'unsupported-current'),
    error => error?.code === INVALID_ASSET_WEIGHTS,
  );
});

test('duplicate account IDs fail validation', () => {
  const acct = createAccount('hsa', { owner: 'client', balance: 1000 });
  const plan = createBlankHousehold('hh1');
  plan.portfolio.extraAccounts = [{ ...acct }, { ...acct, balance: 2000 }];
  assert.throws(() => validateCurrentSchemaHousehold(plan, 'hh1'), /duplicate account id/i);
});

test('synthetic base account IDs are reserved across current and v1 migration paths', () => {
  for(const reservedId of Object.values(LEGACY_BASE_ACCOUNT_IDS)){
    const current = createBlankHousehold(`current-${reservedId}`);
    const typed = createAccount('hsa', { owner: 'client', balance: 1000 });
    typed.id = reservedId;
    current.portfolio.extraAccounts = [typed];
    assert.throws(
      () => validateCurrentSchemaHousehold(current, `current-${reservedId}`),
      new RegExp(`duplicate account id ${reservedId}`),
    );

    const unsupportedSource = createLegacyHousehold(`unsupported-${reservedId}`, [
      { type: 'Mystery account', bucket: 'taxable', owner: 'client', balance: 100 },
    ]);
    const unsupported = migrateHouseholdRecord(unsupportedSource, `unsupported-${reservedId}`).plan;
    unsupported.portfolio.extraAccounts[0].id = reservedId;
    assert.throws(
      () => validateCurrentSchemaHousehold(unsupported, `unsupported-${reservedId}`),
      new RegExp(`duplicate account id ${reservedId}`),
    );

    const v1 = createBlankHousehold(`v1-${reservedId}`);
    v1.meta.accountSchemaVersion = 1;
    for(const sleeve of Object.values(v1.portfolio.accounts)){
      delete sleeve.id;
      delete sleeve.investmentAllocation;
    }
    const v1Typed = createAccount('roth_ira', { balance: 100 });
    v1Typed.id = reservedId;
    delete v1Typed.investmentAllocation;
    v1.portfolio.extraAccounts = [v1Typed];
    assert.throws(
      () => migrateHouseholdRecord(v1, `v1-${reservedId}`),
      new RegExp(`duplicate account id ${reservedId}`),
    );
  }
});

test('deriveHouseholdIssues reports overlap and bucket conflict without changing balances', () => {
  const plan = createBlankHousehold('hh1');
  plan.portfolio.accounts.taxable.balance = 1000;
  const acct = createAccount('roth_ira', { owner: 'client', balance: 500 });
  acct.bucket = 'traditional';
  plan.portfolio.extraAccounts = [acct];
  const issues = deriveHouseholdIssues(plan);
  assert.ok(issues.includes('LEGACY_TYPED_OVERLAP'));
  assert.ok(issues.some(x => x.startsWith('ACCOUNT_BUCKET_CONFLICT:')));
  assert.equal(plan.portfolio.accounts.taxable.balance, 1000);
});

test('corrupt JSON preserves bytes and serves runtime defaults read-only', () => {
  const storage = createMemoryStorage({ [HHDB_KEY]: '{not json', [ACTIVE_KEY]: 'demo' });
  const read = readHouseholdStore(storage);
  assert.equal(read.kind, 'corrupt');
  const prepared = prepareHouseholdStore(read, deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mode, 'read_only');
  assert.deepEqual(Object.keys(prepared.db), ['now-household']);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(commitPreparedHouseholdStore(storage, prepared).readOnly, true);
  assert.equal(storage.snapshot()[HHDB_KEY], '{not json');
});

test('missing key creates one current-schema selectable default without activating it', () => {
  const storage = createMemoryStorage();
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.changed, true);
  assert.equal(prepared.activeHouseholdId, null);
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.ok, true);
  assert.ok(storage.getItem(HHDB_KEY));
});

test('empty stored database seeds the current runtime defaults', () => {
  const storage = createMemoryStorage({ [HHDB_KEY]: '{}', [ACTIVE_KEY]: 'demo' });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mode, 'normal');
  assert.deepEqual(Object.keys(prepared.db), ['now-household']);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(commitPreparedHouseholdStore(storage, prepared).ok, true);
  assert.equal(JSON.parse(storage.getItem(HHDB_KEY))['now-household'].meta.name, 'Now Household');
  assert.equal(storage.getItem(ACTIVE_KEY), null);
});

test('write failure preserves original database and enters read-only clone', () => {
  const legacy = {
    meta: { householdId: 'hh1' },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'HSA', bucket: 'roth', owner: 'client', balance: 5000 }],
    },
  };
  const storage = createMemoryStorage({ [HHDB_KEY]: JSON.stringify({ hh1: legacy }), [ACTIVE_KEY]: 'hh1' });
  storage.setItem = () => { throw new Error('quota'); };
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.readOnly, true);
});

test('migration is idempotent after save/reload', () => {
  const legacy = {
    meta: { householdId: 'hh1' },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'Brokerage (taxable)', bucket: 'taxable', owner: 'client', balance: 100000 }],
    },
  };
  const first = migrateHouseholdRecord(legacy, 'hh1').plan;
  const second = migrateHouseholdRecord(JSON.parse(JSON.stringify(first)), 'hh1');
  assert.equal(second.changed, false);
});

test('deterministicLegacyAccountId is stable', () => {
  const legacy = { type: '401(k)', bucket: 'traditional', owner: 'client', balance: 500000 };
  assert.equal(
    deterministicLegacyAccountId('hh1', 'extraAccounts', 0, legacy),
    deterministicLegacyAccountId('hh1', 'extraAccounts', 0, legacy),
  );
});

test('deterministic IDs remain stable across household migration, persistence, and reload', () => {
  const duplicateShape = { type: '401(k)', bucket: 'traditional', owner: 'client', balance: 500000 };
  const legacy = createLegacyHousehold('stable', [structuredClone(duplicateShape), structuredClone(duplicateShape)]);
  const first = migrateHouseholdRecord(legacy, 'stable').plan;
  const ids = first.portfolio.extraAccounts.map(account => account.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids[0], deterministicLegacyAccountId('stable', 'extraAccounts', 0, duplicateShape));
  assert.equal(ids[1], deterministicLegacyAccountId('stable', 'extraAccounts', 1, duplicateShape));

  const reloaded = migrateHouseholdRecord(JSON.parse(JSON.stringify(first)), 'stable');
  assert.equal(reloaded.changed, false);
  assert.deepEqual(reloaded.plan.portfolio.extraAccounts.map(account => account.id), ids);
});

test('mergeNonAccountDefaults does not pre-stamp accountSchemaVersion', () => {
  const merged = mergeNonAccountDefaults({ meta: { name: 'Saved' } }, { meta: { accountSchemaVersion: 1 } });
  assert.equal(merged.meta.accountSchemaVersion, undefined);
});

test('mergeNonAccountDefaults never creates a missing meta version or required account subtree', () => {
  const defaults = createBlankHousehold('defaults');
  const withoutMeta = mergeNonAccountDefaults({}, defaults);
  assert.equal(withoutMeta.meta.accountSchemaVersion, undefined);
  assert.equal(withoutMeta.portfolio, undefined);
  assert.equal(withoutMeta.taxProfiles, undefined);

  const record = { meta: { accountSchemaVersion: 1 }, portfolio: {} };
  const merged = mergeNonAccountDefaults(record, defaults);
  assert.equal(merged.portfolio.accounts, undefined);
  assert.equal(merged.portfolio.extraAccounts, undefined);
  assert.equal(merged.taxProfiles, undefined);
});

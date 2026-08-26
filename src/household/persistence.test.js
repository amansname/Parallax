import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACCOUNT_SCHEMA_VERSION } from './accountTypes.js';
import { createAccount } from './createAccount.js';
import { createBlankTaxProfiles } from './factEnvelope.js';
import {
  snapshotLegacyRiskProfileAllocation,
  snapshotPresetAllocation,
} from './investmentAllocation.js';
import { LEGACY_BASE_ACCOUNT_IDS } from './migrateAccounts.js';
import { SPENDING_SCHEMA_VERSION } from './migrateSpendingToGoals.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from './householdRecordSchema.js';
import {
  NET_WORTH_ONLY_TREATMENT,
  createEmptyNetWorthRecords,
} from './netWorthRecords.js';
import {
  ACTIVE_KEY,
  HHDB_KEY,
  RETIRED_BUILT_IN_HOUSEHOLD_IDS,
  commitPreparedHouseholdStore,
  createMemoryStorage,
  isProvenAutomaticRuntimeCopy,
  prepareHouseholdRecordForSave,
  prepareHouseholdStore,
  readHouseholdStore,
} from './persistence.js';

const LEGACY_RISK_PROFILE = 3;
const legacyAllocation = snapshotLegacyRiskProfileAllocation(LEGACY_RISK_PROFILE);
const pristinePlan = { meta: {}, household: { primary: { currentAge: 60, retirementAge: 65, planEndAge: 90 } }, portfolio: { riskProfile: LEGACY_RISK_PROFILE, accounts: { taxable: { id: LEGACY_BASE_ACCOUNT_IDS.taxable, balance: 0, basisPct: 1, investmentAllocation: structuredClone(legacyAllocation) }, traditional: { id: LEGACY_BASE_ACCOUNT_IDS.traditional, balance: 0, investmentAllocation: structuredClone(legacyAllocation) }, roth: { id: LEGACY_BASE_ACCOUNT_IDS.roth, balance: 0, investmentAllocation: structuredClone(legacyAllocation) } }, extraAccounts: [] }, income: {}, expenses: {}, savings: {}, simulation: {} };

function createBlankHousehold(id){
  const p = JSON.parse(JSON.stringify(pristinePlan));
  p.meta = {
    householdId: id,
    name: 'New Household',
    accountSchemaVersion: ACCOUNT_SCHEMA_VERSION,
    householdRecordSchemaVersion: HOUSEHOLD_RECORD_SCHEMA_VERSION,
    spendingSchemaVersion: SPENDING_SCHEMA_VERSION,
  };
  p.income.other = [];
  p.incomeTax = { adjustments: [], deductions: [], credits: [] };
  p.taxProfiles = createBlankTaxProfiles();
  p.netWorth = createEmptyNetWorthRecords();
  return p;
}

function createSelectableHousehold(id = 'now-household'){
  const p = createBlankHousehold(id);
  p.meta.name = id === 'now-household' ? 'Now Household' : 'Selectable Household';
  p.meta.isSelectableDefault = true;
  return p;
}

const deps = {
  createBlankHousehold,
  createSelectableDefaultHouseholds: () => [createSelectableHousehold()],
  pristinePlan,
  currentYear: () => 2026,
};

function createCountingStorage(initial = {}){
  const storage = createMemoryStorage(initial);
  const setItem = storage.setItem.bind(storage);
  let writes = 0;
  storage.setItem = (key, value) => {
    writes += 1;
    setItem(key, value);
  };
  const removeItem = storage.removeItem.bind(storage);
  storage.removeItem = key => {
    writes += 1;
    removeItem(key);
  };
  storage.writeCount = () => writes;
  return storage;
}

test('readHouseholdStore distinguishes missing, corrupt, and valid data', () => {
  assert.equal(readHouseholdStore(createMemoryStorage()).kind, 'missing');
  assert.equal(readHouseholdStore(createMemoryStorage({ [HHDB_KEY]: '{' })).kind, 'corrupt');
  assert.equal(readHouseholdStore(createMemoryStorage({ [HHDB_KEY]: '[]' })).kind, 'corrupt');
  const valid = createSelectableHousehold();
  const read = readHouseholdStore(createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ 'now-household': valid }),
  }));
  assert.equal(read.kind, 'valid');
});

test('invalid root shapes preserve stored bytes and expose runtime defaults read-only', () => {
  for(const raw of ['null', '[]', '"text"']){
    const retiredScenarioKey = 'parallax.scenarios.demo.v1';
    const storage = createCountingStorage({
      [HHDB_KEY]: raw,
      [ACTIVE_KEY]: 'stale',
      [retiredScenarioKey]: 'must-survive-read-only',
    });
    const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, 'read_only');
    assert.equal(prepared.activeHouseholdId, null);
    assert.equal(prepared.hydrate, false);
    assert.deepEqual(Object.keys(prepared.db), ['now-household']);
    const commit = commitPreparedHouseholdStore(storage, prepared);
    assert.equal(commit.readOnly, true);
    assert.equal(storage.writeCount(), 0);
    assert.equal(storage.getItem(HHDB_KEY), raw);
    assert.equal(storage.getItem(ACTIVE_KEY), 'stale');
    assert.equal(storage.getItem(retiredScenarioKey), 'must-survive-read-only');
  }
});

test('an empty database is seeded with current runtime defaults', () => {
  const storage = createCountingStorage({ [HHDB_KEY]: '{}', [ACTIVE_KEY]: 'stale' });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mode, 'normal');
  assert.deepEqual(Object.keys(prepared.db), ['now-household']);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.equal(commitPreparedHouseholdStore(storage, prepared).ok, true);
  assert.equal(JSON.parse(storage.getItem(HHDB_KEY))['now-household'].meta.name, 'Now Household');
  assert.equal(storage.getItem(ACTIVE_KEY), null);
});

test('storage read exception is unreadable', () => {
  let writes = 0;
  const storage = {
    getItem(){ throw new Error('blocked'); },
    setItem(){ writes += 1; },
  };
  const read = readHouseholdStore(storage);
  assert.equal(read.kind, 'unreadable');
  const prepared = prepareHouseholdStore(read, deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mode, 'read_only');
  assert.deepEqual(Object.keys(prepared.db), ['now-household']);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.equal(commitPreparedHouseholdStore(storage, prepared).readOnly, true);
  assert.equal(writes, 0);
});

test('missing key creates exactly one validated shipped option without activating it', () => {
  const storage = createMemoryStorage();
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.deepEqual(Object.keys(prepared.db), ['now-household']);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.equal(prepared.db['now-household'].meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.ok(prepared.db['now-household'].taxProfiles.client.rothIra);
});

test('automatic runtime-copy classification is provenance-only and fails closed', () => {
  const runtimeIds = ['now-household', 'future-household'];
  const proven = createBlankHousehold('hh_proven1');
  Object.assign(proven.meta, {
    name: 'Any display name',
    runtimeSourceHouseholdId: 'now-household',
    isDemo: false,
    isSelectableDefault: false,
  });
  assert.equal(isProvenAutomaticRuntimeCopy('hh_proven1', proven, runtimeIds), true);
  proven.meta.name = 'Renamed by the user';
  assert.equal(isProvenAutomaticRuntimeCopy('hh_proven1', proven, runtimeIds), true);

  const nameOnly = createBlankHousehold('hh_nameonly');
  nameOnly.meta.name = 'Now Household copy';
  assert.equal(isProvenAutomaticRuntimeCopy('hh_nameonly', nameOnly, runtimeIds), false);
  assert.equal(isProvenAutomaticRuntimeCopy('hh_proven1', proven, undefined), false);
  assert.equal(isProvenAutomaticRuntimeCopy('hh_proven1', proven, new Set(runtimeIds)), false);
  assert.equal(isProvenAutomaticRuntimeCopy('custom-proven', proven, runtimeIds), false);
  assert.equal(isProvenAutomaticRuntimeCopy('hh_otherid', proven, runtimeIds), false);

  for(const patch of [
    { runtimeSourceHouseholdId: 'unknown-household' },
    { isDemo: true },
    { isSelectableDefault: true },
    { isDemo: undefined },
    { isSelectableDefault: undefined },
  ]){
    const candidate = structuredClone(proven);
    Object.assign(candidate.meta, patch);
    assert.equal(
      isProvenAutomaticRuntimeCopy('hh_proven1', candidate, runtimeIds),
      false,
    );
  }
});

test('validated legacy store removes only stable retired ids and proven runtime copies', () => {
  const dualRuntimeDeps = {
    ...deps,
    createSelectableDefaultHouseholds: () => {
      const now = createSelectableHousehold('now-household');
      const future = createSelectableHousehold('future-household');
      future.meta.name = 'Future Household';
      return [now, future];
    },
  };
  const retired = Object.fromEntries(RETIRED_BUILT_IN_HOUSEHOLD_IDS.map(id => [
    id,
    createSelectableHousehold(id),
  ]));
  const provenSpecs = [
    ['hh_zfuture9', 'future-household', 'Renamed future experiment'],
    ['hh_anow1', 'now-household', 'Renamed now experiment'],
  ];
  const provenCopies = Object.fromEntries(provenSpecs.map(([id, sourceId, name]) => {
    const household = createBlankHousehold(id);
    Object.assign(household.meta, {
      name,
      runtimeSourceHouseholdId: sourceId,
      isDemo: false,
      isSelectableDefault: false,
    });
    return [id, household];
  }));
  const lookalikeNames = [
    'Now Household copy',
    'Future Household copy',
    'New Household',
    'Demo Household copy',
    'Pre-Retirement Couple copy',
  ];
  const lookalikes = Object.fromEntries(lookalikeNames.map((name, index) => {
    const id = `hh_lookalike${index}`;
    const household = createBlankHousehold(id);
    household.meta.name = name;
    return [id, household];
  }));
  const unknownSource = createBlankHousehold('hh_unknownsource');
  Object.assign(unknownSource.meta, {
    name: 'Ambiguous unknown source',
    runtimeSourceHouseholdId: 'not-a-shipped-household',
    isDemo: false,
    isSelectableDefault: false,
  });
  const mismatchedContract = createBlankHousehold('hh_contractmismatch');
  Object.assign(mismatchedContract.meta, {
    name: 'Ambiguous metadata contract',
    runtimeSourceHouseholdId: 'now-household',
    isDemo: false,
    isSelectableDefault: true,
  });
  const custom = createBlankHousehold('custom-one');
  custom.meta.name = 'Custom One';
  custom.portfolio.accounts.taxable.balance = 123_456;
  const survivors = {
    ...lookalikes,
    'hh_unknownsource': unknownSource,
    'hh_contractmismatch': mismatchedContract,
    'custom-one': custom,
  };
  const survivorBytes = Object.fromEntries(
    Object.entries(survivors).map(([id, household]) => [id, JSON.stringify(household)]),
  );
  const storedDb = {
    ...retired,
    ...provenCopies,
    ...survivors,
  };
  const scenarioIds = [
    ...RETIRED_BUILT_IN_HOUSEHOLD_IDS,
    ...provenSpecs.map(([id]) => id),
    ...Object.keys(survivors),
  ];
  const scenarioEntries = Object.fromEntries(scenarioIds.map((id, index) => [
    `parallax.scenarios.${id}.v1`,
    `scenario-bytes-${index}`,
  ]));
  scenarioEntries['parallax.scenarios.unrelated.v1'] = 'unrelated-bytes';
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify(storedDb),
    [ACTIVE_KEY]: 'custom-one',
    ...scenarioEntries,
  });
  const scenarioBytesBefore = Object.fromEntries(
    Object.entries(storage.snapshot()).filter(([key]) => key.startsWith('parallax.scenarios.')),
  );

  const prepared = prepareHouseholdStore(readHouseholdStore(storage), dualRuntimeDeps);
  assert.equal(prepared.mode, 'normal');
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.deepEqual(prepared.removedAutomaticRuntimeCopyIds, ['hh_anow1', 'hh_zfuture9']);
  const expectedIds = ['now-household', 'future-household', ...Object.keys(survivors)].sort();
  assert.deepEqual(Object.keys(prepared.db).sort(), expectedIds);
  for(const [id, bytes] of Object.entries(survivorBytes)){
    assert.equal(JSON.stringify(prepared.db[id]), bytes);
  }

  assert.equal(commitPreparedHouseholdStore(storage, prepared).ok, true);
  const committedDb = JSON.parse(storage.getItem(HHDB_KEY));
  assert.deepEqual(Object.keys(committedDb).sort(), expectedIds);
  for(const [id, bytes] of Object.entries(survivorBytes)){
    assert.equal(JSON.stringify(committedDb[id]), bytes);
  }
  assert.equal(storage.getItem(ACTIVE_KEY), null);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(storage.snapshot()).filter(([key]) => key.startsWith('parallax.scenarios.')),
    ),
    scenarioBytesBefore,
  );
});

test('apparent runtime-copy provenance cannot bypass read-only validation', () => {
  const malformed = createBlankHousehold('hh_malformedcopy');
  Object.assign(malformed.meta, {
    name: 'Malformed runtime copy',
    runtimeSourceHouseholdId: 'now-household',
    isDemo: false,
    isSelectableDefault: false,
  });
  delete malformed.portfolio.extraAccounts;
  const raw = JSON.stringify({ hh_malformedcopy: malformed });
  const scenarioKey = 'parallax.scenarios.hh_malformedcopy.v1';
  const storage = createCountingStorage({
    [HHDB_KEY]: raw,
    [ACTIVE_KEY]: 'hh_malformedcopy',
    [scenarioKey]: 'must-survive-read-only',
  });

  const prepared = prepareHouseholdStore(readHouseholdStore(storage), {
    ...deps,
    createSelectableDefaultHouseholds: () => [
      createSelectableHousehold('now-household'),
      createSelectableHousehold('future-household'),
    ],
  });
  assert.equal(prepared.mode, 'read_only');
  assert.equal(commitPreparedHouseholdStore(storage, prepared).readOnly, true);
  assert.equal(storage.writeCount(), 0);
  assert.equal(storage.getItem(HHDB_KEY), raw);
  assert.equal(storage.getItem(ACTIVE_KEY), 'hh_malformedcopy');
  assert.equal(storage.getItem(scenarioKey), 'must-survive-read-only');
});

test('missing key seeds selectable production defaults with no active household', () => {
  const storage = createMemoryStorage();
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), {
    ...deps,
    createSelectableDefaultHouseholds: () => [
      { ...createBlankHousehold('default-one'), meta: {
        ...createBlankHousehold('default-one').meta,
        householdId: 'default-one',
        name: 'Default One',
      } },
      { ...createBlankHousehold('default-two'), meta: {
        ...createBlankHousehold('default-two').meta,
        householdId: 'default-two',
        name: 'Default Two',
      } },
    ],
  });

  assert.equal(prepared.ok, true);
  assert.deepEqual(Object.keys(prepared.db), ['default-one', 'default-two']);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
});

test('existing stores boot blank with fresh defaults without overwriting user households', () => {
  const userHousehold = createBlankHousehold('advisor-household');
  userHousehold.meta.name = 'Advisor Household';
  userHousehold.portfolio.accounts.taxable.balance = 123_456;
  const originalUserBytes = JSON.stringify(userHousehold);
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ 'advisor-household': userHousehold }),
    [ACTIVE_KEY]: 'advisor-household',
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), {
    ...deps,
    createSelectableDefaultHouseholds: () => [
      createBlankHousehold('default-one'),
      createBlankHousehold('default-two'),
    ],
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.changed, true);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.equal(prepared.pointerChanged, true);
  assert.deepEqual(
    Object.keys(prepared.db),
    ['default-one', 'default-two', 'advisor-household'],
  );
  assert.equal(JSON.stringify(prepared.db['advisor-household']), originalUserBytes);
});

test('stored reserved records are replaced by exact current-build templates', () => {
  const staleDefault = createBlankHousehold('default-one');
  staleDefault.meta.primaryName = 'Stale Default';
  const freshDefault = createBlankHousehold('default-one');
  freshDefault.meta.primaryName = 'Current Default';
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ 'default-one': staleDefault }),
    [ACTIVE_KEY]: 'default-one',
  });

  const prepared = prepareHouseholdStore(readHouseholdStore(storage), {
    ...deps,
    createSelectableDefaultHouseholds: () => [freshDefault],
  });

  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.deepEqual(prepared.db['default-one'], freshDefault);
});

test('unchanged current-schema database does not rewrite on commit', () => {
  const shipped = createSelectableHousehold();
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ 'now-household': shipped }),
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.changed, false);
  assert.equal(prepared.pointerChanged, false);
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.wrote, false);
});

test('dangling active pointer is cleared only after validation', () => {
  const shipped = createSelectableHousehold();
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ 'now-household': shipped }),
    [ACTIVE_KEY]: 'missing-id',
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.equal(prepared.pointerChanged, true);
});

test('a valid saved pointer is ignored after all households migrate', () => {
  const one = createBlankHousehold('one');
  one.meta.name = 'Migrated Household One';
  delete one.meta.accountSchemaVersion;
  delete one.meta.householdRecordSchemaVersion;
  const two = createBlankHousehold('two');
  two.meta.name = 'Migrated Household Two';
  delete two.meta.accountSchemaVersion;
  delete two.meta.householdRecordSchemaVersion;
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ one, two }),
    [ACTIVE_KEY]: 'two',
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.activeHouseholdId, null);
  assert.equal(prepared.hydrate, false);
  assert.equal(prepared.pointerChanged, true);
  assert.equal(prepared.db.one.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.equal(prepared.db.two.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
});

test('a mixed valid and malformed database preserves bytes and uses runtime defaults read-only', () => {
  const valid = createBlankHousehold('valid');
  const raw = JSON.stringify({ valid, malformed: null });
  const storage = createCountingStorage({ [HHDB_KEY]: raw, [ACTIVE_KEY]: 'valid' });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mode, 'read_only');
  assert.deepEqual(Object.keys(prepared.db), ['now-household']);
  assert.equal(commitPreparedHouseholdStore(storage, prepared).readOnly, true);
  assert.equal(storage.writeCount(), 0);
  assert.equal(storage.getItem(HHDB_KEY), raw);
  assert.equal(storage.getItem(ACTIVE_KEY), 'valid');
});

test('invalid current-schema records cannot overwrite storage and fall back read-only', () => {
  const cases = [
    plan => { delete plan.portfolio.extraAccounts; },
    plan => { delete plan.portfolio.accounts.roth; },
    plan => { delete plan.taxProfiles.client.rothIra; },
    plan => { delete plan.portfolio.accounts.taxable.investmentAllocation; },
    plan => {
      const account = createAccount('brokerage_taxable', { balance: 100 });
      delete account.investmentAllocation;
      plan.portfolio.extraAccounts = [account];
    },
    plan => {
      const account = createAccount('brokerage_taxable', { balance: 100 });
      account.investmentAllocation = structuredClone(snapshotPresetAllocation('balanced'));
      account.investmentAllocation.weights.usLarge += 0.01;
      account.investmentAllocation.weights.cash -= 0.01;
      plan.portfolio.extraAccounts = [account];
    },
  ];
  for(const [index, mutate] of cases.entries()){
    const plan = createBlankHousehold('strict');
    plan.meta.name = 'Invalid Schema Household';
    mutate(plan);
    const raw = JSON.stringify({ strict: plan });
    const scenarioKey = `parallax.scenarios.strict-${index}.v1`;
    const scenarioBytes = `strict-scenario-bytes-${index}`;
    const storage = createCountingStorage({
      [HHDB_KEY]: raw,
      [ACTIVE_KEY]: 'strict',
      [scenarioKey]: scenarioBytes,
    });
    const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, 'read_only');
    assert.deepEqual(Object.keys(prepared.db), ['now-household']);
    assert.equal(commitPreparedHouseholdStore(storage, prepared).readOnly, true);
    assert.equal(storage.writeCount(), 0);
    assert.equal(storage.getItem(HHDB_KEY), raw);
    assert.equal(storage.getItem(ACTIVE_KEY), 'strict');
    assert.equal(storage.getItem(scenarioKey), scenarioBytes);
  }
});

test('validated records still receive only non-account defaults', () => {
  const plan = createBlankHousehold('defaults');
  delete plan.meta.name;
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ defaults: plan }),
    [ACTIVE_KEY]: 'defaults',
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.changed, true);
  assert.equal(prepared.db.defaults.meta.name, 'New Household');
});

test('database write failure preserves original bytes and pointer while exposing only the validated clone', () => {
  const legacy = {
    meta: { householdId: 'legacy' },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'HSA', bucket: 'roth', owner: 'client', balance: 5000 }],
    },
  };
  const originalDb = JSON.stringify({ legacy });
  const storage = createMemoryStorage({ [HHDB_KEY]: originalDb, [ACTIVE_KEY]: 'legacy' });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.db.legacy.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.ok(prepared.db.legacy.portfolio.extraAccounts[0].id);
  storage.setItem = () => { throw new Error('quota'); };
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.ok, false);
  assert.equal(commit.readOnly, true);
  assert.equal(commit.partialWrite, false);
  assert.equal(commit.databasePersisted, false);
  assert.equal(storage.getItem(HHDB_KEY), originalDb);
  assert.equal(storage.getItem(ACTIVE_KEY), 'legacy');
  assert.equal(JSON.parse(originalDb).legacy.meta.accountSchemaVersion, undefined);
});

test('stale-pointer removal failure leaves the completed database and reports partial persistence', () => {
  const data = { [HHDB_KEY]: '{}', [ACTIVE_KEY]: 'stale' };
  const storage = {
    getItem(key){ return data[key] ?? null; },
    setItem(key, value){ data[key] = value; },
    removeItem(key){
      if(key === ACTIVE_KEY) throw new Error('pointer failed');
      delete data[key];
    },
  };
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.ok, false);
  assert.equal(commit.readOnly, true);
  assert.equal(commit.partialWrite, true);
  assert.equal(commit.databasePersisted, true);
  assert.equal(commit.pointerPersisted, false);
  assert.equal(JSON.parse(data[HHDB_KEY])['now-household'].meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.equal(data[ACTIVE_KEY], 'stale');
});

test('commit performs no new storage reads after preparation', () => {
  const written = {};
  let removed = null;
  const storage = {
    getItem(){ throw new Error('commit must not read'); },
    setItem(key, value){ written[key] = value; },
    removeItem(key){ removed = key; },
  };
  const shipped = createSelectableHousehold();
  const commit = commitPreparedHouseholdStore(storage, {
    ok: true,
    mode: 'normal',
    changed: true,
    pointerChanged: true,
    db: { 'now-household': shipped },
    activeHouseholdId: null,
  });
  assert.equal(commit.ok, true);
  assert.ok(written[HHDB_KEY]);
  assert.equal(written[ACTIVE_KEY], undefined);
  assert.equal(removed, ACTIVE_KEY);
});

test('durable save preparation validates stable row identity before cloning', () => {
  const valid = createBlankHousehold('save');
  valid.income.other.push({
    id: 'income_save',
    typeId: 'wages',
    label: 'Wages or salary',
    owner: 'client',
    amount: 100000,
    startAge: 60,
    endAge: 64,
    realGrowth: 0,
    taxablePct: 1,
  });

  const prepared = prepareHouseholdRecordForSave(valid, 'save');
  assert.notEqual(prepared, valid);
  assert.equal(prepared.income.other[0].id, 'income_save');

  const invalid = structuredClone(valid);
  delete invalid.income.other[0].id;
  assert.throws(
    () => prepareHouseholdRecordForSave(invalid, 'save'),
    /income\.other\[0\]\.id is required/,
  );
});

test('Net Worth shell records and Property/Mortgage metadata survive Save and reload exactly', () => {
  const household = createBlankHousehold('net-worth-save');
  household.meta.name = 'Net Worth Household';
  household.netWorth.shellEntries.push({
    id: 'nw-insurance',
    categoryId: 'insurance',
    name: 'Anonymized policy',
    type: 'Whole Life',
    owner: 'client',
    tax: '',
    value: 50000,
    projectionTreatment: NET_WORTH_ONLY_TREATMENT,
  });
  household.properties = [{
    name: 'Anonymized property',
    value: 500000,
    purchasePrice: 200000,
    netWorthMeta: { type: 'Second Home', owner: 'joint' },
    mortgage: {
      balance: 120000,
      rate: 5,
      termYears: 30,
      netWorthMeta: {
        present: true,
        name: 'Anonymized lender',
        type: 'Second Home',
        owner: 'joint',
      },
    },
  }];
  const preparedRecord = prepareHouseholdRecordForSave(
    household,
    'net-worth-save',
  );
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ 'net-worth-save': preparedRecord }),
    [ACTIVE_KEY]: 'net-worth-save',
  });

  const reloaded = prepareHouseholdStore(readHouseholdStore(storage), deps);
  const record = reloaded.db['net-worth-save'];
  assert.deepEqual(record.netWorth, preparedRecord.netWorth);
  assert.deepEqual(record.properties, preparedRecord.properties);
  assert.deepEqual(
    prepareHouseholdRecordForSave(record, 'net-worth-save'),
    record,
  );
});

test('v1 fixture without an allocation source fails closed and preserves exact bytes', () => {
  const legacyKeys = {
    dbKey: 'parallax.households.v1',
    activeKey: 'parallax.activeHouseholdId',
  };
  const fixturePath = new URL(
    '../../test/fixtures/persisted/legacy-net-worth-v1.json',
    import.meta.url,
  );
  const fixtureBytes = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(fixtureBytes);
  const sourceDatabaseBytes = fixture.storage[legacyKeys.dbKey];
  const sourcePointerBytes = fixture.storage[legacyKeys.activeKey];
  const sourceRecord = JSON.parse(sourceDatabaseBytes)['anonymized-net-worth-v1'];
  const storage = createCountingStorage(fixture.storage);

  const read = readHouseholdStore(storage, legacyKeys);
  assert.equal(storage.getItem(legacyKeys.dbKey), sourceDatabaseBytes);
  assert.equal(storage.getItem(legacyKeys.activeKey), sourcePointerBytes);
  const first = prepareHouseholdStore(read, deps);
  assert.equal(storage.getItem(legacyKeys.dbKey), sourceDatabaseBytes);
  assert.equal(storage.getItem(legacyKeys.activeKey), sourcePointerBytes);
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'read_only');
  assert.equal(first.changed, false);
  assert.equal(first.hydrate, false);
  assert.equal(first.error.includes('riskProfile'), true);
  assert.equal(sourceRecord.portfolio.riskProfile, undefined);

  const committed = commitPreparedHouseholdStore(storage, first, legacyKeys);
  assert.equal(committed.ok, true);
  assert.equal(committed.readOnly, true);
  assert.equal(committed.wrote, false);
  assert.equal(storage.writeCount(), 0);
  assert.equal(storage.getItem(legacyKeys.dbKey), sourceDatabaseBytes);
  assert.equal(storage.getItem(legacyKeys.activeKey), sourcePointerBytes);
});

test('Tax completion zeros and planning source overrides survive Save and reload', () => {
  const household = createBlankHousehold('tax-save');
  household.meta.name = 'Tax Household';
  household.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    planningIncomeOverrides: ['wages', 'interest'],
    income: {
      wages: 125000,
      taxableInterest: 0,
      taxExemptInterest: 0,
    },
    adjustments: { mode: 'supplied-line10', amount: 0 },
    deductions: {
      method: 'itemized',
      source: 'supplied-line12e',
      line12e: 0,
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
      line23: 0,
    },
  };
  const prepared = prepareHouseholdRecordForSave(household, 'tax-save');
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ 'tax-save': prepared }),
    [ACTIVE_KEY]: 'tax-save',
  });

  const reloaded = prepareHouseholdStore(readHouseholdStore(storage), deps);
  const current = reloaded.db['tax-save'].incomeTax.current1040;

  assert.equal(current.incomeSourcesComplete, true);
  assert.deepEqual(current.planningIncomeOverrides, ['wages', 'interest']);
  assert.equal(Object.hasOwn(current.income, 'taxableInterest'), true);
  assert.equal(Object.hasOwn(current.income, 'taxExemptInterest'), true);
  assert.equal(current.adjustments.amount, 0);
  assert.equal(current.deductions.line12e, 0);
  assert.equal(current.deductions.qbi, 0);
  assert.equal(current.deductions.schedule1A.amount, 0);
  assert.deepEqual(current.passThrough, {
    line17: 0,
    line19: 0,
    line20: 0,
    line23: 0,
  });
});

test('legacy duplicate-wage repair persists once and reloads byte-stably', () => {
  const legacy = createBlankHousehold('legacy-wages');
  legacy.meta.name = 'Legacy Wages Household';
  delete legacy.meta.householdRecordSchemaVersion;
  const wage = {
    typeId: 'wages',
    label: 'Wages or salary',
    owner: 'client',
    amount: 125000,
    startAge: 60,
    endAge: 64,
    realGrowth: 0,
    taxablePct: 1,
  };
  legacy.income.other = [structuredClone(wage), structuredClone(wage)];
  const storage = createCountingStorage({
    [HHDB_KEY]: JSON.stringify({ 'legacy-wages': legacy }),
    [ACTIVE_KEY]: 'legacy-wages',
  });

  const first = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.db['legacy-wages'].income.other.length, 1);
  assert.match(first.db['legacy-wages'].income.other[0].id, /^row_legacy_/);
  assert.deepEqual(first.db['legacy-wages'].meta.legacyRepairArchive, [{
    version: 1,
    code: 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED',
    householdId: 'legacy-wages',
    keptLegacyIndex: 0,
    removedLegacyIndex: 1,
    row: wage,
  }]);

  const committed = commitPreparedHouseholdStore(storage, first);
  assert.equal(committed.ok, true);
  const persistedBytes = storage.getItem(HHDB_KEY);
  const writesAfterFirstCommit = storage.writeCount();

  const second = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.repairsByHousehold['legacy-wages'], []);
  assert.equal(commitPreparedHouseholdStore(storage, second).wrote, false);
  assert.equal(storage.writeCount(), writesAfterFirstCommit);
  assert.equal(storage.getItem(HHDB_KEY), persistedBytes);
});

test('pointer write failure reports partial persistence without destructive rollback', () => {
  const legacy = {
    meta: { householdId: 'hh1' },
    portfolio: {
      riskProfile: LEGACY_RISK_PROFILE,
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'HSA', bucket: 'roth', owner: 'client', balance: 5000 }],
    },
  };
  const originalDb = JSON.stringify({ hh1: legacy });
  const storage = {
    data: { [HHDB_KEY]: originalDb, [ACTIVE_KEY]: 'missing-id' },
    getItem(key){ return this.data[key] ?? null; },
    setItem(key, value){
      if(key === ACTIVE_KEY) throw new Error('pointer failed');
      this.data[key] = value;
    },
  };
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.changed, true);
  assert.equal(prepared.pointerChanged, true);
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.ok, false);
  assert.equal(commit.readOnly, true);
  assert.equal(commit.wrote, false);
  assert.equal(commit.partialWrite, true);
  assert.equal(commit.databasePersisted, true);
  assert.equal(commit.pointerPersisted, false);
  assert.notEqual(storage.data[HHDB_KEY], originalDb);
  assert.equal(JSON.parse(storage.data[HHDB_KEY]).hh1.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.equal(storage.data[ACTIVE_KEY], 'missing-id');
});

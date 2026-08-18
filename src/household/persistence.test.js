import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACCOUNT_SCHEMA_VERSION } from './accountTypes.js';
import { createBlankTaxProfiles } from './factEnvelope.js';
import { SPENDING_SCHEMA_VERSION } from './migrateSpendingToGoals.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from './householdRecordSchema.js';
import {
  NET_WORTH_ONLY_TREATMENT,
  createEmptyNetWorthRecords,
} from './netWorthRecords.js';
import {
  ACTIVE_KEY,
  HHDB_KEY,
  commitPreparedHouseholdStore,
  createMemoryStorage,
  prepareHouseholdRecordForSave,
  prepareHouseholdStore,
  readHouseholdStore,
} from './persistence.js';

const pristinePlan = { meta: {}, household: { primary: { currentAge: 60, retirementAge: 65, planEndAge: 90 } }, portfolio: { accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } }, extraAccounts: [] }, income: {}, expenses: {}, savings: {}, simulation: {} };

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

function createDemoHousehold(){
  const p = createBlankHousehold('demo');
  p.meta.name = 'Demo Household';
  p.meta.isDemo = true;
  return p;
}

const deps = {
  createDemoHousehold,
  createBlankHousehold,
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
  storage.writeCount = () => writes;
  return storage;
}

test('readHouseholdStore distinguishes missing, corrupt, and valid data', () => {
  assert.equal(readHouseholdStore(createMemoryStorage()).kind, 'missing');
  assert.equal(readHouseholdStore(createMemoryStorage({ [HHDB_KEY]: '{' })).kind, 'corrupt');
  assert.equal(readHouseholdStore(createMemoryStorage({ [HHDB_KEY]: '[]' })).kind, 'corrupt');
  const valid = createDemoHousehold();
  const read = readHouseholdStore(createMemoryStorage({ [HHDB_KEY]: JSON.stringify({ demo: valid }) }));
  assert.equal(read.kind, 'valid');
});

test('invalid root shapes preserve stored bytes and expose runtime defaults read-only', () => {
  for(const raw of ['null', '[]', '"text"']){
    const storage = createCountingStorage({ [HHDB_KEY]: raw, [ACTIVE_KEY]: 'demo' });
    const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, 'read_only');
    assert.equal(prepared.activeHouseholdId, 'demo');
    assert.deepEqual(Object.keys(prepared.db), ['demo']);
    const commit = commitPreparedHouseholdStore(storage, prepared);
    assert.equal(commit.readOnly, true);
    assert.equal(storage.writeCount(), 0);
    assert.equal(storage.getItem(HHDB_KEY), raw);
    assert.equal(storage.getItem(ACTIVE_KEY), 'demo');
  }
});

test('an empty database is seeded with current runtime defaults', () => {
  const storage = createCountingStorage({ [HHDB_KEY]: '{}', [ACTIVE_KEY]: 'demo' });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mode, 'normal');
  assert.deepEqual(Object.keys(prepared.db), ['demo']);
  assert.equal(commitPreparedHouseholdStore(storage, prepared).ok, true);
  assert.equal(JSON.parse(storage.getItem(HHDB_KEY)).demo.meta.name, 'Demo Household');
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
  assert.deepEqual(Object.keys(prepared.db), ['demo']);
  assert.equal(commitPreparedHouseholdStore(storage, prepared).readOnly, true);
  assert.equal(writes, 0);
});

test('missing key creates exactly one validated current-schema demo', () => {
  const storage = createMemoryStorage();
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.deepEqual(Object.keys(prepared.db), ['demo']);
  assert.equal(prepared.db.demo.meta.accountSchemaVersion, ACCOUNT_SCHEMA_VERSION);
  assert.ok(prepared.db.demo.taxProfiles.client.rothIra);
});

test('missing key seeds selectable production defaults while keeping blank Demo active', () => {
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
  assert.deepEqual(Object.keys(prepared.db), ['demo', 'default-one', 'default-two']);
  assert.equal(prepared.activeHouseholdId, 'demo');
  assert.equal(prepared.db.demo.meta.name, 'Demo Household');
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
  assert.equal(prepared.activeHouseholdId, 'demo');
  assert.equal(prepared.pointerChanged, true);
  assert.deepEqual(
    Object.keys(prepared.db),
    ['demo', 'default-one', 'default-two', 'advisor-household'],
  );
  assert.equal(JSON.stringify(prepared.db['advisor-household']), originalUserBytes);
});

test('stored reserved records are replaced by exact current-build templates', () => {
  const staleDemo = createDemoHousehold();
  staleDemo.meta.primaryName = 'Stale Demo';
  const staleDefault = createBlankHousehold('default-one');
  staleDefault.meta.primaryName = 'Stale Default';
  const freshDefault = createBlankHousehold('default-one');
  freshDefault.meta.primaryName = 'Current Default';
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ demo: staleDemo, 'default-one': staleDefault }),
    [ACTIVE_KEY]: 'default-one',
  });

  const prepared = prepareHouseholdStore(readHouseholdStore(storage), {
    ...deps,
    createSelectableDefaultHouseholds: () => [freshDefault],
  });

  assert.equal(prepared.activeHouseholdId, 'demo');
  assert.equal(prepared.db.demo.meta.primaryName, undefined);
  assert.deepEqual(prepared.db['default-one'], freshDefault);
});

test('unchanged current-schema database does not rewrite on commit', () => {
  const demo = createDemoHousehold();
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ demo }),
    [ACTIVE_KEY]: 'demo',
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.changed, false);
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.wrote, false);
});

test('dangling active pointer resolves only after validation', () => {
  const demo = createDemoHousehold();
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ demo }),
    [ACTIVE_KEY]: 'missing-id',
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.activeHouseholdId, 'demo');
  assert.equal(prepared.pointerChanged, true);
});

test('a valid saved pointer is ignored after all households migrate', () => {
  const one = createBlankHousehold('one');
  delete one.meta.accountSchemaVersion;
  delete one.meta.householdRecordSchemaVersion;
  const two = createBlankHousehold('two');
  delete two.meta.accountSchemaVersion;
  delete two.meta.householdRecordSchemaVersion;
  const storage = createMemoryStorage({
    [HHDB_KEY]: JSON.stringify({ one, two }),
    [ACTIVE_KEY]: 'two',
  });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.activeHouseholdId, 'demo');
  assert.equal(prepared.pointerChanged, true);
  assert.equal(prepared.db.one.meta.accountSchemaVersion, 1);
  assert.equal(prepared.db.two.meta.accountSchemaVersion, 1);
});

test('a mixed valid and malformed database preserves bytes and uses runtime defaults read-only', () => {
  const valid = createBlankHousehold('valid');
  const raw = JSON.stringify({ valid, malformed: null });
  const storage = createCountingStorage({ [HHDB_KEY]: raw, [ACTIVE_KEY]: 'valid' });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.mode, 'read_only');
  assert.deepEqual(Object.keys(prepared.db), ['demo']);
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
  ];
  for(const mutate of cases){
    const plan = createBlankHousehold('strict');
    mutate(plan);
    const raw = JSON.stringify({ strict: plan });
    const storage = createCountingStorage({ [HHDB_KEY]: raw, [ACTIVE_KEY]: 'strict' });
    const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, 'read_only');
    assert.deepEqual(Object.keys(prepared.db), ['demo']);
    assert.equal(commitPreparedHouseholdStore(storage, prepared).readOnly, true);
    assert.equal(storage.writeCount(), 0);
    assert.equal(storage.getItem(HHDB_KEY), raw);
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
      accounts: { taxable: { balance: 0, basisPct: 1 }, traditional: { balance: 0 }, roth: { balance: 0 } },
      extraAccounts: [{ type: 'HSA', bucket: 'roth', owner: 'client', balance: 5000 }],
    },
  };
  const originalDb = JSON.stringify({ legacy });
  const storage = createMemoryStorage({ [HHDB_KEY]: originalDb, [ACTIVE_KEY]: 'legacy' });
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.db.legacy.meta.accountSchemaVersion, 1);
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

test('first-use pointer failure leaves the completed database and clearly reports partial persistence', () => {
  const data = {};
  const storage = {
    getItem(key){ return data[key] ?? null; },
    setItem(key, value){
      if(key === ACTIVE_KEY) throw new Error('pointer failed');
      data[key] = value;
    },
  };
  const prepared = prepareHouseholdStore(readHouseholdStore(storage), deps);
  const commit = commitPreparedHouseholdStore(storage, prepared);
  assert.equal(commit.ok, false);
  assert.equal(commit.readOnly, true);
  assert.equal(commit.partialWrite, true);
  assert.equal(commit.databasePersisted, true);
  assert.equal(commit.pointerPersisted, false);
  assert.equal(JSON.parse(data[HHDB_KEY]).demo.meta.accountSchemaVersion, 1);
  assert.equal(data[ACTIVE_KEY], undefined);
});

test('commit performs no new storage reads after preparation', () => {
  const written = {};
  const storage = {
    getItem(){ throw new Error('commit must not read'); },
    setItem(key, value){ written[key] = value; },
  };
  const demo = createDemoHousehold();
  const commit = commitPreparedHouseholdStore(storage, {
    ok: true,
    mode: 'normal',
    changed: true,
    pointerChanged: true,
    db: { demo },
    activeHouseholdId: 'demo',
  });
  assert.equal(commit.ok, true);
  assert.ok(written[HHDB_KEY]);
  assert.equal(written[ACTIVE_KEY], 'demo');
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

test('exact v1 Net Worth fixture migrates once and the committed bytes reload unchanged', () => {
  const fixturePath = new URL(
    '../../test/fixtures/persisted/legacy-net-worth-v1.json',
    import.meta.url,
  );
  const fixtureBytes = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(fixtureBytes);
  const sourceDatabaseBytes = fixture.storage[HHDB_KEY];
  const sourcePointerBytes = fixture.storage[ACTIVE_KEY];
  const sourceRecord = JSON.parse(sourceDatabaseBytes)['anonymized-net-worth-v1'];
  const storage = createCountingStorage(fixture.storage);

  const read = readHouseholdStore(storage);
  assert.equal(storage.getItem(HHDB_KEY), sourceDatabaseBytes);
  assert.equal(storage.getItem(ACTIVE_KEY), sourcePointerBytes);
  const first = prepareHouseholdStore(read, deps);
  assert.equal(storage.getItem(HHDB_KEY), sourceDatabaseBytes);
  assert.equal(storage.getItem(ACTIVE_KEY), sourcePointerBytes);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const migrated = first.db['anonymized-net-worth-v1'];
  assert.equal(
    migrated.meta.householdRecordSchemaVersion,
    HOUSEHOLD_RECORD_SCHEMA_VERSION,
  );
  assert.deepEqual(migrated.netWorth, createEmptyNetWorthRecords());
  assert.deepEqual(migrated.properties, sourceRecord.properties);
  assert.ok(first.repairsByHousehold['anonymized-net-worth-v1'].some(repair =>
    repair.code === 'NET_WORTH_RECORDS_INITIALIZED'));

  const committed = commitPreparedHouseholdStore(storage, first);
  assert.equal(committed.ok, true);
  const destinationDatabaseBytes = storage.getItem(HHDB_KEY);
  assert.notEqual(destinationDatabaseBytes, sourceDatabaseBytes);
  const writesAfterMigration = storage.writeCount();

  const second = prepareHouseholdStore(readHouseholdStore(storage), deps);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.repairsByHousehold['anonymized-net-worth-v1'], []);
  assert.equal(commitPreparedHouseholdStore(storage, second).wrote, false);
  assert.equal(storage.writeCount(), writesAfterMigration);
  assert.equal(storage.getItem(HHDB_KEY), destinationDatabaseBytes);
});

test('Tax completion zeros and planning source overrides survive Save and reload', () => {
  const household = createBlankHousehold('tax-save');
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
  assert.equal(JSON.parse(storage.data[HHDB_KEY]).hh1.meta.accountSchemaVersion, 1);
  assert.equal(storage.data[ACTIVE_KEY], 'missing-id');
});

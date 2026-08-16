import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUSEHOLD_RECORD_SCHEMA_VERSION,
  deterministicLegacyRowId,
  migrateHouseholdRecordSchema,
  validateHouseholdRecordSchema,
} from './householdRecordSchema.js';

function legacyWage(overrides = {}){
  return {
    typeId: 'wages',
    label: 'Wages or salary',
    owner: 'client',
    amount: 215000,
    startAge: 50,
    endAge: 64,
    realGrowth: 0,
    taxablePct: 1,
    ...overrides,
  };
}

function subject(incomeRows = []){
  return {
    meta: { householdId: 'hh_schema' },
    income: { other: incomeRows },
    incomeTax: { adjustments: [], deductions: [], credits: [] },
    portfolio: { extraAccounts: [] },
  };
}

test('removes only exact historical GPC wage clones and archives every removed row', () => {
  const interest = {
    typeId: 'interest',
    label: 'Interest',
    owner: 'client',
    amount: 2000,
    startAge: 50,
    endAge: 999,
    realGrowth: 0,
    taxablePct: 1,
  };
  const plan = subject([
    legacyWage(),
    interest,
    legacyWage(),
    legacyWage(),
  ]);

  const migrated = migrateHouseholdRecordSchema(plan);

  assert.equal(migrated.changed, true);
  assert.equal(migrated.plan.income.other.length, 2);
  assert.equal(migrated.plan.income.other[0].amount, 215000);
  assert.equal(migrated.plan.income.other[1].typeId, 'interest');
  // Filter to the repair under test — migration emits other receipts too
  // (spending moving onto the Goals page), and this test is about wage clones.
  const wageRepairs = migrated.repairs.filter(r => r.code === 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED');
  assert.deepEqual(wageRepairs, [{
    code: 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED',
    owner: 'client',
    keptLegacyIndex: 0,
    removedLegacyIndices: [2, 3],
    count: 2,
  }]);
  assert.deepEqual(
    migrated.plan.meta.legacyRepairArchive.map(entry => entry.removedLegacyIndex),
    [2, 3],
  );
  assert.equal(migrated.plan.meta.householdRecordSchemaVersion, HOUSEHOLD_RECORD_SCHEMA_VERSION);
  assert.ok(migrated.plan.income.other.every(row => typeof row.id === 'string'));
  assert.equal(new Set(migrated.plan.income.other.map(row => row.id)).size, 2);
});

test('preserves legitimate lookalikes, non-wages, and ID-bearing rows', () => {
  const rows = [
    legacyWage(),
    legacyWage({ amount: 215001 }),
    legacyWage({ label: 'Second job' }),
    legacyWage({ owner: 'joint' }),
    legacyWage({ startAge: 51 }),
    legacyWage({ endAge: 65 }),
    legacyWage({ realGrowth: 0.01 }),
    legacyWage({ taxablePct: 0.9 }),
    { ...legacyWage(), id: 'income_a' },
    { ...legacyWage(), id: 'income_b' },
    {
      ...legacyWage(),
      typeId: 'pension',
      label: 'Pension',
    },
    {
      ...legacyWage(),
      typeId: 'pension',
      label: 'Pension',
    },
  ];

  const migrated = migrateHouseholdRecordSchema(subject(rows));

  assert.equal(migrated.plan.income.other.length, rows.length);
  assert.equal(migrated.plan.meta.legacyRepairArchive, undefined);
  // No WAGE repair — the spending-to-goals receipt is a separate concern.
  assert.deepEqual(
    migrated.repairs.filter(r => r.code === 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED'),
    []
  );
});

test('duplicate repair and stable-ID backfill are idempotent and a current-schema ID gap fails closed', () => {
  const first = migrateHouseholdRecordSchema(subject([legacyWage(), legacyWage()]));
  const second = migrateHouseholdRecordSchema(first.plan);

  assert.equal(second.changed, false);
  assert.deepEqual(second.plan, first.plan);
  assert.throws(
    () => migrateHouseholdRecordSchema({
      ...first.plan,
      income: { other: [{ ...legacyWage() }] },
    }),
    /id is required/,
  );
});

test('deterministic IDs are stable and duplicate IDs fail validation', () => {
  const row = legacyWage();
  assert.equal(
    deterministicLegacyRowId('hh_a', 'income.other', 0, row),
    deterministicLegacyRowId('hh_a', 'income.other', 0, row),
  );

  const migrated = migrateHouseholdRecordSchema(subject([row]));
  migrated.plan.income.other.push({ ...migrated.plan.income.other[0] });
  assert.throws(
    () => validateHouseholdRecordSchema(migrated.plan, 'hh_schema'),
    /duplicate wizard row id/,
  );
});

test('adds a versioned displayName without changing canonical account type data', () => {
  const plan = subject([]);
  plan.portfolio.extraAccounts.push({
    id: 'acct_a',
    typeId: 'brokerage_taxable',
    type: 'Brokerage (taxable)',
  });

  const migrated = migrateHouseholdRecordSchema(plan);

  assert.equal(migrated.plan.portfolio.extraAccounts[0].displayName, '');
  assert.equal(migrated.plan.portfolio.extraAccounts[0].typeId, 'brokerage_taxable');
  assert.equal(migrated.plan.portfolio.extraAccounts[0].type, 'Brokerage (taxable)');
});

test('v1 household records add empty durable Net Worth state without altering saved property facts', () => {
  const current = migrateHouseholdRecordSchema(subject([])).plan;
  const legacy = structuredClone(current);
  legacy.meta.householdRecordSchemaVersion = 1;
  delete legacy.netWorth;
  legacy.properties = [{
    name: 'Anonymized property',
    value: 500000,
    purchasePrice: 200000,
    mortgage: { balance: 120000, rate: 5, termYears: 30 },
  }];
  const sourceBytes = JSON.stringify(legacy);

  const first = migrateHouseholdRecordSchema(legacy, 'hh-v1-net-worth');
  assert.equal(JSON.stringify(legacy), sourceBytes);
  assert.equal(first.changed, true);
  assert.deepEqual(first.plan.netWorth, {
    schemaVersion: 1,
    shellEntries: [],
  });
  assert.deepEqual(first.plan.properties, legacy.properties);
  assert.ok(first.repairs.some(repair =>
    repair.code === 'NET_WORTH_RECORDS_INITIALIZED'));

  const second = migrateHouseholdRecordSchema(first.plan, 'hh-v1-net-worth');
  assert.equal(second.changed, false);
  assert.deepEqual(second.plan, first.plan);
  assert.deepEqual(second.repairs, []);
});

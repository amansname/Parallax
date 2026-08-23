import {
  ACCOUNT_MIGRATION_BLOCKED,
  ACCOUNT_MIGRATION_READ_ONLY,
  BLOCKED_MESSAGE,
  READ_ONLY_MESSAGE,
  mergeNonAccountDefaults,
  migrateHouseholdsDb,
  validateCurrentSchemaHousehold,
} from './migrateAccounts.js';
import {
  migrateHouseholdRecordDatabase,
  validateHouseholdRecordSchema,
} from './householdRecordSchema.js';

export const HHDB_KEY = 'parallax.households.v1';
export const ACTIVE_KEY = 'parallax.activeHouseholdId';
export const RETIRED_BUILT_IN_HOUSEHOLD_IDS = Object.freeze([
  'demo',
  'default-pre-retirement-solo',
  'default-pre-retirement-couple',
]);
export const RETIRED_HOUSEHOLD_DISPLAY_NAMES = Object.freeze([
  'New Household',
  'Demo Household copy',
  'Pre-Retirement Couple copy',
]);

const RETIRED_HOUSEHOLD_DISPLAY_NAME_SET = new Set(RETIRED_HOUSEHOLD_DISPLAY_NAMES);

function householdDisplayName(household){
  const meta = household?.meta || {};
  return meta.name || meta.primaryName || 'Household';
}

export function createMemoryStorage(initial = {}){
  const store = new Map(Object.entries(initial));
  return {
    getItem(key){ return store.has(key) ? store.get(key) : null; },
    setItem(key, value){ store.set(key, value); },
    removeItem(key){ store.delete(key); },
    snapshot(){ return Object.fromEntries(store); },
  };
}

export function readHouseholdStore(storage, keys = { dbKey: HHDB_KEY, activeKey: ACTIVE_KEY }){
  let raw;
  try{
    raw = storage.getItem(keys.dbKey);
  }catch(error){
    return { kind: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
  if(raw == null) return { kind: 'missing' };

  let activePointer = null;
  try{
    activePointer = storage.getItem(keys.activeKey);
  }catch(error){
    return { kind: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }

  try{
    const parsed = JSON.parse(raw);
    if(parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)){
      return { kind: 'corrupt', raw, activePointer };
    }
    if(Object.keys(parsed).length === 0){
      return { kind: 'empty_database', raw, activePointer };
    }
    for(const [recordId, record] of Object.entries(parsed)){
      if(!record || typeof record !== 'object' || Array.isArray(record)){
        return { kind: 'corrupt', raw, activePointer, error: `Invalid household record ${recordId}` };
      }
    }
    return { kind: 'valid', database: parsed, activePointer, raw };
  }catch(error){
    return { kind: 'corrupt', raw, activePointer, error: error instanceof Error ? error.message : String(error) };
  }
}

export function prepareHouseholdStore(readResult, dependencies){
  const {
    createBlankHousehold,
    createSelectableDefaultHouseholds = () => [],
    pristinePlan,
    currentYear,
  } = dependencies;
  const preparationYear = currentYear();
  const selectableDefaults = () => createSelectableDefaultHouseholds(
    pristinePlan,
    preparationYear,
  );

  function prepareRuntimeDefaults(){
    const defaults = selectableDefaults();
    const seededDb = Object.fromEntries(
      defaults.map(household => [household.meta.householdId, household]),
    );
    const migration = migrateHouseholdsDb(seededDb);
    if(!migration.ok){
      return {
        ok: false,
        mode: 'blocked',
        code: migration.code || ACCOUNT_MIGRATION_BLOCKED,
        message: BLOCKED_MESSAGE,
        hydrate: false,
        error: migration.error,
      };
    }
    let recordMigration;
    try{
      recordMigration = migrateHouseholdRecordDatabase(migration.db);
    }catch(error){
      return {
        ok: false,
        mode: 'blocked',
        code: ACCOUNT_MIGRATION_BLOCKED,
        message: BLOCKED_MESSAGE,
        hydrate: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      ok: true,
      db: recordMigration.db,
      activeHouseholdId: null,
      issuesByHousehold: Object.fromEntries(
        Object.keys(recordMigration.db).map(householdId => [householdId, []]),
      ),
      repairsByHousehold: recordMigration.repairsByHousehold,
    };
  }

  const runtimeDefaults = prepareRuntimeDefaults();
  if(!runtimeDefaults.ok) return runtimeDefaults;

  function readOnlyRuntimeFallback(error){
    return {
      ...runtimeDefaults,
      mode: 'read_only',
      code: ACCOUNT_MIGRATION_READ_ONLY,
      message: READ_ONLY_MESSAGE,
      changed: false,
      pointerChanged: false,
      hydrate: false,
      error: error || readResult.error,
    };
  }

  if(readResult.kind === 'unreadable' || readResult.kind === 'corrupt'){
    return readOnlyRuntimeFallback();
  }

  if(readResult.kind === 'missing' || readResult.kind === 'empty_database'){
    return {
      ...runtimeDefaults,
      mode: 'normal',
      changed: true,
      pointerChanged: readResult.activePointer !== null,
      hydrate: false,
    };
  }

  // Shipped records are application templates, never browser-owned truth.
  // Recreate current templates on every boot and exclude retired reserved ids
  // and exact known-junk display names so stale built-in copies cannot hydrate.
  const runtimeDefaultsById = runtimeDefaults.db;
  const reservedIds = new Set([
    ...Object.keys(runtimeDefaultsById),
    ...RETIRED_BUILT_IN_HOUSEHOLD_IDS,
  ]);
  const savedHouseholds = Object.fromEntries(
    Object.entries(readResult.database).filter(([householdId, household]) => (
      !reservedIds.has(householdId)
        && !RETIRED_HOUSEHOLD_DISPLAY_NAME_SET.has(householdDisplayName(household))
    )),
  );
  const databaseWithDefaults = {
    ...runtimeDefaultsById,
    ...savedHouseholds,
  };
  const defaultsRefreshed = Object.entries(runtimeDefaultsById).some(([householdId, household]) => (
    JSON.stringify(readResult.database[householdId]) !== JSON.stringify(household)
  ));
  const retiredBuiltInIdsRemoved = RETIRED_BUILT_IN_HOUSEHOLD_IDS.filter(
    householdId => Object.hasOwn(readResult.database, householdId),
  );
  const retiredNamedHouseholdIdsRemoved = Object.entries(readResult.database)
    .filter(([, household]) => (
      RETIRED_HOUSEHOLD_DISPLAY_NAME_SET.has(householdDisplayName(household))
    ))
    .map(([householdId]) => householdId);

  const migration = migrateHouseholdsDb(databaseWithDefaults);
  if(!migration.ok){
    return readOnlyRuntimeFallback(migration.error);
  }

  let recordMigration;
  try{
    recordMigration = migrateHouseholdRecordDatabase(migration.db);
  }catch(error){
    return readOnlyRuntimeFallback(error instanceof Error ? error.message : String(error));
  }

  let mergedDb;
  try{
    mergedDb = Object.fromEntries(Object.entries(recordMigration.db).map(([recordId, record]) => {
      if(runtimeDefaultsById[recordId]){
        return [recordId, structuredClone(runtimeDefaultsById[recordId])];
      }
      const defaults = createBlankHousehold(pristinePlan, recordId, preparationYear);
      return [recordId, mergeNonAccountDefaults(record, defaults)];
    }));
  }catch(error){
    return readOnlyRuntimeFallback(error instanceof Error ? error.message : String(error));
  }

  // Startup is deliberately origin-independent. Saved households remain in
  // the selector, but only an explicit visible selection may activate one.
  const activeHouseholdId = null;
  const pointerChanged = readResult.activePointer !== null;
  const schemaFilled = JSON.stringify(migration.db) !== JSON.stringify(mergedDb);

  return {
    ok: true,
    mode: 'normal',
    db: mergedDb,
    activeHouseholdId,
    changed: retiredBuiltInIdsRemoved.length > 0 || retiredNamedHouseholdIdsRemoved.length > 0
      || defaultsRefreshed || migration.changed || schemaFilled || recordMigration.changed,
    pointerChanged,
    hydrate: false,
    issuesByHousehold: migration.issuesByHousehold || {},
    repairsByHousehold: recordMigration.repairsByHousehold,
  };
}

export function prepareHouseholdRecordForSave(plan, householdId){
  validateCurrentSchemaHousehold(plan, householdId);
  validateHouseholdRecordSchema(plan, householdId);
  return structuredClone(plan);
}

export function commitPreparedHouseholdStore(storage, preparedResult, keys = { dbKey: HHDB_KEY, activeKey: ACTIVE_KEY }){
  if(!preparedResult.ok){
    return { ok: false, wrote: false };
  }
  if(preparedResult.mode === 'blocked'){
    return { ok: false, wrote: false };
  }
  if(preparedResult.mode === 'read_only'){
    return { ok: true, wrote: false, readOnly: true };
  }

  if(!preparedResult.changed && !preparedResult.pointerChanged){
    return { ok: true, wrote: false };
  }

  let dbWritten = false;

  try{
    if(preparedResult.changed){
      storage.setItem(keys.dbKey, JSON.stringify(preparedResult.db));
      dbWritten = true;
    }
    if(preparedResult.pointerChanged){
      if(preparedResult.activeHouseholdId == null){
        storage.removeItem(keys.activeKey);
      }else{
        storage.setItem(keys.activeKey, preparedResult.activeHouseholdId);
      }
    }
    return { ok: true, wrote: true };
  }catch(error){
    return {
      ok: false,
      wrote: false,
      readOnly: true,
      partialWrite: dbWritten && preparedResult.pointerChanged,
      databasePersisted: !preparedResult.changed || dbWritten,
      pointerPersisted: !preparedResult.pointerChanged,
      message: READ_ONLY_MESSAGE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyPreparedReadOnlyFallback(preparedResult){
  return {
    ...preparedResult,
    mode: 'read_only',
    message: READ_ONLY_MESSAGE,
  };
}

export function getBlockedMessage(){
  return BLOCKED_MESSAGE;
}

export function getReadOnlyMessage(){
  return READ_ONLY_MESSAGE;
}

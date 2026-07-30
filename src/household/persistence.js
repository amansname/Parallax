import {
  ACCOUNT_MIGRATION_BLOCKED,
  ACCOUNT_MIGRATION_READ_ONLY,
  ACCOUNT_SCHEMA_VERSION_UNSUPPORTED,
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

function resolveActiveHouseholdId(db, activePointer){
  if(activePointer && db[activePointer]) return activePointer;
  const ids = Object.keys(db);
  return ids[0] || null;
}

export function prepareHouseholdStore(readResult, dependencies){
  const {
    createDemoHousehold,
    createBlankHousehold,
    pristinePlan,
    currentYear,
  } = dependencies;

  if(readResult.kind === 'unreadable' || readResult.kind === 'corrupt' || readResult.kind === 'empty_database'){
    return {
      ok: false,
      mode: 'blocked',
      code: ACCOUNT_MIGRATION_BLOCKED,
      message: BLOCKED_MESSAGE,
      hydrate: false,
    };
  }

  if(readResult.kind === 'missing'){
    const demo = createDemoHousehold(pristinePlan, currentYear());
    const migration = migrateHouseholdsDb({ [demo.meta.householdId]: demo });
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
      mode: 'normal',
      db: recordMigration.db,
      activeHouseholdId: demo.meta.householdId,
      changed: true,
      pointerChanged: true,
      hydrate: true,
      issuesByHousehold: { [demo.meta.householdId]: [] },
      repairsByHousehold: recordMigration.repairsByHousehold,
    };
  }

  const migration = migrateHouseholdsDb(readResult.database);
  if(!migration.ok){
    return {
      ok: false,
      mode: 'blocked',
      code: migration.code || ACCOUNT_MIGRATION_BLOCKED,
      message: migration.code === ACCOUNT_SCHEMA_VERSION_UNSUPPORTED
        ? BLOCKED_MESSAGE
        : BLOCKED_MESSAGE,
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

  const mergedDb = Object.fromEntries(Object.entries(recordMigration.db).map(([recordId, record]) => {
    const defaults = recordId === 'demo'
      ? createDemoHousehold(pristinePlan, currentYear())
      : createBlankHousehold(pristinePlan, recordId, currentYear());
    return [recordId, mergeNonAccountDefaults(record, defaults)];
  }));

  const activeHouseholdId = resolveActiveHouseholdId(mergedDb, readResult.activePointer);
  if(!activeHouseholdId){
    return {
      ok: false,
      mode: 'blocked',
      code: ACCOUNT_MIGRATION_BLOCKED,
      message: BLOCKED_MESSAGE,
      hydrate: false,
    };
  }

  const pointerChanged = readResult.activePointer !== activeHouseholdId;
  const schemaFilled = JSON.stringify(migration.db) !== JSON.stringify(mergedDb);

  return {
    ok: true,
    mode: 'normal',
    db: mergedDb,
    activeHouseholdId,
    changed: migration.changed || schemaFilled || recordMigration.changed,
    pointerChanged,
    hydrate: true,
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
      storage.setItem(keys.activeKey, preparedResult.activeHouseholdId);
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

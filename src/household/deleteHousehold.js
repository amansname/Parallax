export const DELETE_HOUSEHOLD_FAILURE = Object.freeze({
  INVALID_REQUEST: 'invalid-request',
  PROTECTED: 'protected-household',
  NOT_FOUND: 'household-not-found',
  READ_FAILED: 'storage-read-failed',
  WRITE_FAILED: 'storage-write-failed',
  ROLLBACK_FAILED: 'storage-rollback-failed',
});

function restoreExactValue(storage, key, value){
  if(value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

export function deleteStoredHousehold({
  storage,
  householdId,
  protectedHouseholdIds = [],
  databaseKey,
  activeHouseholdKey,
  scenarioKey,
}){
  if(!storage || !householdId || !databaseKey || !activeHouseholdKey || !scenarioKey){
    return { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.INVALID_REQUEST };
  }
  if(new Set(protectedHouseholdIds).has(householdId)){
    return { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.PROTECTED };
  }

  let originalDatabaseBytes;
  let originalActiveBytes;
  let originalScenarioBytes;
  let database;
  try{
    originalDatabaseBytes = storage.getItem(databaseKey);
    originalActiveBytes = storage.getItem(activeHouseholdKey);
    originalScenarioBytes = storage.getItem(scenarioKey);
    database = JSON.parse(originalDatabaseBytes || 'null');
  }catch{
    return { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.READ_FAILED };
  }

  if(!database || typeof database !== 'object' || Array.isArray(database) || !database[householdId]){
    return { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.NOT_FOUND };
  }

  const nextDatabase = { ...database };
  delete nextDatabase[householdId];

  try{
    storage.removeItem(scenarioKey);
    if(originalActiveBytes === householdId) storage.removeItem(activeHouseholdKey);
    storage.setItem(databaseKey, JSON.stringify(nextDatabase));
  }catch{
    let rollbackFailed = false;
    for(const [key, value] of [
      [databaseKey, originalDatabaseBytes],
      [activeHouseholdKey, originalActiveBytes],
      [scenarioKey, originalScenarioBytes],
    ]){
      try{ restoreExactValue(storage, key, value); }
      catch{ rollbackFailed = true; }
    }
    if(rollbackFailed) return { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.ROLLBACK_FAILED };
    return { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.WRITE_FAILED };
  }

  return { ok: true, database: nextDatabase };
}

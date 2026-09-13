// An applied add must never be replayed merely because browser storage failed.
// Keep this one editor pending and retry persistence of the current plan only.
export function createHouseholdExplicitSave({ root, transientState, retrySave, syncHousehold }){
  function accept(result, kind){
    if(!result?.saveFailed) return true;
    transientState.explicitSavePending = { kind, householdId: root.dataset.householdId, changed: result.changed !== false };
    syncHousehold();
    return false;
  }
  function retry(kind){
    const pending = transientState.explicitSavePending;
    if(!pending) return null;
    if(pending.kind !== kind || pending.householdId !== root.dataset.householdId) return { saved: false };
    const saved = retrySave() === true;
    if(saved) transientState.explicitSavePending = null;
    else syncHousehold();
    return { saved, changed: pending.changed };
  }
  return { accept, retry };
}

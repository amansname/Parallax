// A mobile editor is an unsaved copy. Apply only fields changed in that copy,
// preserving unrelated updates and the canonical goal's identity/protection.
export function createMobileGoalDraft(goal){
  return { original: structuredClone(goal), value: structuredClone(goal) };
}

export function applyMobileGoalDraft(current, draft){
  const differs = (left, right, key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]);
  const groups = [['startAge', 'endAge', 'startsAtRetirement'], ['amount', 'per']];
  for(const group of groups){
    if(group.some(key => differs(draft.original, draft.value, key))
        && group.some(key => differs(draft.original, current, key))){
      throw new Error('This goal changed while you were editing. Return to Goals and reopen it to use the latest values.');
    }
  }
  let changed = false;
  const keys = new Set([...Object.keys(draft.original), ...Object.keys(draft.value)]);
  for(const key of keys){
    if(key === 'id' || key === 'system') continue;
    if(JSON.stringify(draft.original[key]) === JSON.stringify(draft.value[key])) continue;
    if(Object.hasOwn(draft.value, key)) current[key] = structuredClone(draft.value[key]);
    else delete current[key];
    changed = true;
  }
  return changed;
}

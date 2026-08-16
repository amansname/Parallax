function requiredText(value, label){
  const text = String(value ?? '').trim();
  if(!text) throw new Error(`${label} is required`);
  return text;
}

export function createDurableRuntimeCopy(plan, {
  sourceHouseholdId,
  targetHouseholdId,
}){
  if(!plan || typeof plan !== 'object' || Array.isArray(plan)){
    throw new Error('Runtime household plan is required');
  }
  const sourceId = requiredText(sourceHouseholdId, 'sourceHouseholdId');
  const targetId = requiredText(targetHouseholdId, 'targetHouseholdId');
  if(sourceId === targetId) throw new Error('Runtime copy needs a new household id');
  const copy = structuredClone(plan);
  if(!copy.meta || typeof copy.meta !== 'object' || Array.isArray(copy.meta)){
    throw new Error('Runtime household metadata is required');
  }
  const sourceName = requiredText(copy.meta.name || 'Household', 'household name');
  copy.meta.householdId = targetId;
  copy.meta.name = `${sourceName} copy`;
  copy.meta.isDemo = false;
  copy.meta.isSelectableDefault = false;
  copy.meta.runtimeSourceHouseholdId = sourceId;
  return copy;
}

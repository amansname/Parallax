export const NET_WORTH_RECORD_SCHEMA_VERSION = 1;
export const NET_WORTH_ONLY_TREATMENT = 'net-worth-only';

export const NET_WORTH_SHELL_CATEGORIES = Object.freeze([
  'bank',
  'investment',
  'insurance',
  'card',
  'loan',
]);

const CATEGORY_SET = new Set(NET_WORTH_SHELL_CATEGORIES);
const OWNER_SET = new Set(['', 'client', 'spouse', 'joint']);

const isRecord = value =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function requireText(value, path){
  if(typeof value !== 'string') throw new Error(`${path} must be a string`);
}

function validateDisplayMeta(meta, path, { mortgage = false } = {}){
  if(meta == null) return;
  if(!isRecord(meta)) throw new Error(`${path} must be an object`);
  requireText(meta.type, `${path}.type`);
  requireText(meta.owner, `${path}.owner`);
  if(!OWNER_SET.has(meta.owner)) throw new Error(`${path}.owner is unsupported`);
  if(mortgage){
    if(meta.present !== true) throw new Error(`${path}.present must be true`);
    requireText(meta.name, `${path}.name`);
  }
}

export function createEmptyNetWorthRecords(){
  return {
    schemaVersion: NET_WORTH_RECORD_SCHEMA_VERSION,
    shellEntries: [],
  };
}

export function migrateNetWorthRecords(plan){
  if(!isRecord(plan)) throw new Error('plan must be an object');
  if(plan.netWorth == null){
    plan.netWorth = createEmptyNetWorthRecords();
    return { changed: true };
  }
  if(!isRecord(plan.netWorth)) throw new Error('netWorth must be an object');
  if(plan.netWorth.schemaVersion !== NET_WORTH_RECORD_SCHEMA_VERSION){
    throw new Error('unsupported netWorth schemaVersion');
  }
  return { changed: false };
}

export function validateNetWorthRecords(plan, householdId = 'household'){
  const state = plan?.netWorth;
  if(!isRecord(state)
      || state.schemaVersion !== NET_WORTH_RECORD_SCHEMA_VERSION){
    throw new Error(`${householdId}: unsupported netWorth schemaVersion`);
  }
  if(!Array.isArray(state.shellEntries)){
    throw new Error(`${householdId}: netWorth.shellEntries must be an array`);
  }
  const ids = new Set();
  state.shellEntries.forEach((entry, index) => {
    const path = `${householdId}: netWorth.shellEntries[${index}]`;
    if(!isRecord(entry)) throw new Error(`${path} must be an object`);
    if(typeof entry.id !== 'string' || !entry.id.trim()){
      throw new Error(`${path}.id is required`);
    }
    if(ids.has(entry.id)) throw new Error(`${householdId}: duplicate Net Worth record id ${entry.id}`);
    ids.add(entry.id);
    if(!CATEGORY_SET.has(entry.categoryId)){
      throw new Error(`${path}.categoryId is unsupported`);
    }
    for(const key of ['name', 'type', 'owner', 'tax']){
      requireText(entry[key], `${path}.${key}`);
    }
    if(!OWNER_SET.has(entry.owner)) throw new Error(`${path}.owner is unsupported`);
    if(!Number.isInteger(entry.value) || entry.value < 0){
      throw new Error(`${path}.value must be a non-negative whole dollar amount`);
    }
    if(entry.projectionTreatment !== NET_WORTH_ONLY_TREATMENT){
      throw new Error(`${path}.projectionTreatment must be ${NET_WORTH_ONLY_TREATMENT}`);
    }
  });

  for(const [index, property] of (plan.properties || []).entries()){
    if(!isRecord(property)) continue;
    validateDisplayMeta(
      property.netWorthMeta,
      `${householdId}: properties[${index}].netWorthMeta`,
    );
    validateDisplayMeta(
      property.mortgage?.netWorthMeta,
      `${householdId}: properties[${index}].mortgage.netWorthMeta`,
      { mortgage: true },
    );
  }
  return true;
}

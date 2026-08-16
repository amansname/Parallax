import { migrateSpendingToGoals } from './migrateSpendingToGoals.js';
import {
  migrateNetWorthRecords,
  validateNetWorthRecords,
} from './netWorthRecords.js';

export const HOUSEHOLD_RECORD_SCHEMA_VERSION = 2;

const ROW_COLLECTIONS = Object.freeze([
  Object.freeze({ path: ['income', 'other'], prefix: 'income' }),
  Object.freeze({ path: ['incomeTax', 'adjustments'], prefix: 'adjustment' }),
  Object.freeze({ path: ['incomeTax', 'deductions'], prefix: 'deduction' }),
  Object.freeze({ path: ['incomeTax', 'credits'], prefix: 'credit' }),
]);

const LEGACY_GPC_WAGE_KEYS = Object.freeze([
  'amount',
  'endAge',
  'label',
  'owner',
  'realGrowth',
  'startAge',
  'taxablePct',
  'typeId',
]);

function stableHash(value){
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for(let index = 0; index < text.length; index += 1){
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getPath(record, path){
  let current = record;
  for(const key of path){
    if(current == null || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

function ensureLegacyCollection(record, path){
  let current = record;
  for(const key of path.slice(0, -1)){
    if(!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])){
      current[key] = {};
    }
    current = current[key];
  }
  const leaf = path[path.length - 1];
  if(!Array.isArray(current[leaf])) current[leaf] = [];
  return current[leaf];
}

function legacyGpcWageSignature(row){
  if(!row || typeof row !== 'object' || Array.isArray(row) || row.id != null) return null;
  const keys = Object.keys(row).sort();
  if(keys.length !== LEGACY_GPC_WAGE_KEYS.length
      || keys.some((key, index) => key !== LEGACY_GPC_WAGE_KEYS[index])){
    return null;
  }
  if(row.typeId !== 'wages'
      || row.label !== 'Wages or salary'
      || !['client', 'spouse'].includes(row.owner)
      || !Number.isInteger(row.amount)
      || row.amount <= 0
      || !Number.isInteger(row.startAge)
      || !Number.isInteger(row.endAge)
      || row.startAge > row.endAge
      || row.realGrowth !== 0
      || row.taxablePct !== 1){
    return null;
  }
  return JSON.stringify(LEGACY_GPC_WAGE_KEYS.map(key => row[key]));
}

function repairExactLegacyGpcWageDuplicates(rows){
  const firstIndexBySignature = new Map();
  const retained = [];
  const removed = [];
  for(const [index, row] of rows.entries()){
    const signature = legacyGpcWageSignature(row);
    if(signature && firstIndexBySignature.has(signature)){
      removed.push({
        owner: row.owner,
        keptLegacyIndex: firstIndexBySignature.get(signature),
        removedLegacyIndex: index,
        row: structuredClone(row),
      });
      continue;
    }
    if(signature) firstIndexBySignature.set(signature, index);
    retained.push(row);
  }
  return { retained, removed };
}

export function newWizardRowId(prefix = 'row'){
  if(typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'){
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function deterministicLegacyRowId(householdId, collectionPath, index, row){
  return `row_legacy_${stableHash({
    householdId,
    collectionPath,
    index,
    row,
  })}`;
}

export function validateHouseholdRecordSchema(plan, householdId = 'household'){
  if(!plan?.meta || plan.meta.householdRecordSchemaVersion !== HOUSEHOLD_RECORD_SCHEMA_VERSION){
    throw new Error(`${householdId}: unsupported householdRecordSchemaVersion`);
  }
  for(const descriptor of ROW_COLLECTIONS){
    const rows = getPath(plan, descriptor.path);
    if(!Array.isArray(rows)){
      throw new Error(`${householdId}: ${descriptor.path.join('.')} must be an array`);
    }
    const ids = new Set();
    rows.forEach((row, index) => {
      if(!row || typeof row !== 'object' || Array.isArray(row)){
        throw new Error(`${householdId}: ${descriptor.path.join('.')}[${index}] must be an object`);
      }
      if(typeof row.id !== 'string' || !row.id.trim()){
        throw new Error(`${householdId}: ${descriptor.path.join('.')}[${index}].id is required`);
      }
      if(ids.has(row.id)){
        throw new Error(`${householdId}: duplicate wizard row id ${row.id}`);
      }
      ids.add(row.id);
    });
  }
  for(const [index, account] of (plan.portfolio?.extraAccounts || []).entries()){
    if(typeof account.displayName !== 'string'){
      throw new Error(`${householdId}: portfolio.extraAccounts[${index}].displayName is required`);
    }
  }
  validateNetWorthRecords(plan, householdId);
  return true;
}

export function migrateHouseholdRecordSchema(plan, householdId = plan?.meta?.householdId || 'household'){
  const migrated = structuredClone(plan);
  const repairs = [];
  const priorVersion = migrated.meta?.householdRecordSchemaVersion;
  if(priorVersion != null
      && priorVersion !== 1
      && priorVersion !== HOUSEHOLD_RECORD_SCHEMA_VERSION){
    throw new Error(`${householdId}: unsupported householdRecordSchemaVersion`);
  }
  let changed = priorVersion !== HOUSEHOLD_RECORD_SCHEMA_VERSION;
  if(!migrated.meta || typeof migrated.meta !== 'object') migrated.meta = {};

  if(priorVersion == null){
    for(const descriptor of ROW_COLLECTIONS){
      if(!Array.isArray(getPath(migrated, descriptor.path))){
        ensureLegacyCollection(migrated, descriptor.path);
        changed = true;
      }
    }
  }

  if(priorVersion == null && Array.isArray(migrated.income?.other)){
    const duplicateRepair = repairExactLegacyGpcWageDuplicates(migrated.income.other);
    if(duplicateRepair.removed.length > 0){
      migrated.income.other = duplicateRepair.retained;
      const archive = Array.isArray(migrated.meta.legacyRepairArchive)
        ? migrated.meta.legacyRepairArchive
        : [];
      const receipts = new Map();
      for(const removal of duplicateRepair.removed){
        const key = `${removal.owner}:${removal.keptLegacyIndex}`;
        if(!receipts.has(key)){
          receipts.set(key, {
            code: 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED',
            owner: removal.owner,
            keptLegacyIndex: removal.keptLegacyIndex,
            removedLegacyIndices: [],
            count: 0,
          });
        }
        const receipt = receipts.get(key);
        receipt.removedLegacyIndices.push(removal.removedLegacyIndex);
        receipt.count += 1;
        archive.push({
          version: 1,
          code: 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED',
          householdId,
          keptLegacyIndex: removal.keptLegacyIndex,
          removedLegacyIndex: removal.removedLegacyIndex,
          row: removal.row,
        });
      }
      migrated.meta.legacyRepairArchive = archive;
      repairs.push(...receipts.values());
      changed = true;
    }
  }

  for(const descriptor of ROW_COLLECTIONS){
    const rows = getPath(migrated, descriptor.path);
    if(!Array.isArray(rows)) continue;
    rows.forEach((row, index) => {
      if(typeof row.id === 'string' && row.id.trim()) return;
      if(priorVersion != null) return;
      row.id = deterministicLegacyRowId(
        householdId,
        descriptor.path.join('.'),
        index,
        row,
      );
      changed = true;
    });
  }

  for(const account of migrated.portfolio?.extraAccounts || []){
    if(typeof account.displayName === 'string') continue;
    if(priorVersion != null) continue;
    account.displayName = '';
    changed = true;
  }

  // Spending moved onto the Goals page. Convert plan.expenses into goals so a
  // saved household carries one spending channel, not two. Idempotent, and the
  // engine folds legacy expenses in independently, so a plan that somehow
  // reaches the engine unmigrated still charges the same spending.
  const spending = migrateSpendingToGoals(migrated);
  if(spending.changed){
    Object.assign(migrated, spending.plan);
    repairs.push({ code: 'SPENDING_MIGRATED_TO_GOALS' });
    changed = true;
  }

  if(priorVersion !== HOUSEHOLD_RECORD_SCHEMA_VERSION){
    const netWorth = migrateNetWorthRecords(migrated);
    if(netWorth.changed){
      repairs.push({ code: 'NET_WORTH_RECORDS_INITIALIZED' });
      changed = true;
    }
  }

  migrated.meta.householdRecordSchemaVersion = HOUSEHOLD_RECORD_SCHEMA_VERSION;
  validateHouseholdRecordSchema(migrated, householdId);
  return { plan: migrated, changed, repairs };
}

export function migrateHouseholdRecordDatabase(database){
  const migrated = {};
  const repairsByHousehold = {};
  let changed = false;
  for(const [householdId, plan] of Object.entries(database)){
    const result = migrateHouseholdRecordSchema(plan, householdId);
    migrated[householdId] = result.plan;
    repairsByHousehold[householdId] = result.repairs;
    changed ||= result.changed;
  }
  return { db: migrated, changed, repairsByHousehold };
}

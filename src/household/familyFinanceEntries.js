import { engineBucketForTypeId } from './accountTypes.js';
import {
  createIncomeSource,
  incomeType,
  retirementAgeForOwner,
} from './incomeTaxModel.js';
import { newWizardRowId } from './householdRecordSchema.js';
import { writeItemizedSavingsAggregate } from './savingsPlan.js';

const freezeRows = rows => Object.freeze(
  rows.map(row => Object.freeze({ ...row })),
);

export const FAMILY_INCOME_SOURCE_TYPES = freezeRows([
  { id: 'social_security', label: 'Social Security' },
  { id: 'pension', label: 'Pension' },
  { id: 'wages', label: 'Wages or salary' },
  { id: 'self_employment', label: 'Self-employment' },
  { id: 'rental', label: 'Rental net income' },
  { id: 'annuity', label: 'Annuity' },
  { id: 'interest', label: 'Interest' },
  { id: 'dividends', label: 'Dividends' },
  { id: 'deferred_comp', label: 'Deferred compensation' },
  { id: 'other', label: 'Other income' },
]);

export const FAMILY_SAVINGS_SOURCE_TYPES = freezeRows([
  { id: '401k', label: '401(k) deferral' },
  { id: 'roth_401k', label: 'Roth 401(k) deferral' },
  { id: 'traditional_ira', label: 'Traditional IRA' },
  { id: 'roth_ira', label: 'Roth IRA' },
  { id: 'hsa', label: 'HSA' },
  { id: 'brokerage_taxable', label: 'Taxable brokerage' },
  { id: 'savings', label: 'Cash savings' },
]);

const SOURCE_TYPES = Object.freeze({
  income: FAMILY_INCOME_SOURCE_TYPES,
  savings: FAMILY_SAVINGS_SOURCE_TYPES,
});

export function familyFinanceSourceTypes(mode){
  return SOURCE_TYPES[mode] || SOURCE_TYPES.savings;
}

function sourceType(mode, typeId){
  const type = familyFinanceSourceTypes(mode)
    .find(candidate => candidate.id === typeId);
  if(!type) throw new Error(`Unsupported ${mode} source`);
  return type;
}

function validOwner(plan, owner){
  if(owner !== 'client' && owner !== 'spouse'){
    throw new Error('Choose a household member');
  }
  if(owner === 'spouse' && !plan.household?.spouse){
    throw new Error('Co-client source requires an active co-client');
  }
  return owner;
}

function positiveAmount(value){
  const amount = Number(value);
  if(!Number.isFinite(amount) || amount <= 0){
    throw new Error('Enter an annual amount greater than zero');
  }
  return Math.round(amount);
}

function nonnegativeAmount(value){
  const amount = Number(value);
  if(!Number.isFinite(amount) || amount < 0){
    throw new Error('Enter zero or a positive annual amount');
  }
  return Math.round(amount);
}

function uniqueMatch(rows, predicate, label){
  const matches = rows.filter(predicate);
  if(matches.length > 1){
    throw new Error(`${label} must resolve exactly once`);
  }
  return matches[0] || null;
}

function addIncomeEntry(plan, typeId, owner, amount){
  const type = sourceType('income', typeId);
  if(type.id === 'social_security'){
    if(!plan.income.socialSecurity || typeof plan.income.socialSecurity !== 'object'){
      plan.income.socialSecurity = { primary: null, spouse: null };
    }
    const key = owner === 'spouse' ? 'spouse' : 'primary';
    const current = plan.income.socialSecurity[key] || {};
    plan.income.socialSecurity[key] = {
      ...current,
      pia: amount,
      claimAge: Number.isFinite(Number(current.claimAge))
        ? Number(current.claimAge)
        : 67,
    };
    return;
  }

  if(!Array.isArray(plan.income.other)) plan.income.other = [];
  const canonicalType = incomeType(type.id);
  const existing = uniqueMatch(
    plan.income.other,
    row => row?.owner === owner && row?.typeId === type.id,
    `${type.label} for this household member`,
  );
  if(existing){
    existing.amount = amount;
    return;
  }
  const row = createIncomeSource(plan, type.id, owner);
  if(canonicalType.timing === 'retirement'){
    row.startAge = retirementAgeForOwner(plan, owner);
  }
  row.amount = amount;
  row.label = canonicalType.label;
  plan.income.other.push(row);
}

function ensureSavingsEntries(plan){
  if(!plan.savings || typeof plan.savings !== 'object'){
    plan.savings = {
      annual: 0,
      split: { taxable: 0, traditional: 1, roth: 0 },
    };
  }
  if(!Array.isArray(plan.savings.entries)) plan.savings.entries = [];
  return plan.savings.entries;
}

export function syncSavingsAggregate(plan){
  return writeItemizedSavingsAggregate(plan);
}

function addSavingsEntry(plan, typeId, owner, amount){
  const type = sourceType('savings', typeId);
  const bucket = engineBucketForTypeId(type.id);
  if(!bucket){
    throw new Error(`${type.label} is not available to the projection engine`);
  }
  const entries = ensureSavingsEntries(plan);
  const existing = uniqueMatch(
    entries,
    row => row?.owner === owner && row?.typeId === type.id,
    `${type.label} for this household member`,
  );
  if(amount === 0){
    if(existing) entries.splice(entries.indexOf(existing), 1);
    syncSavingsAggregate(plan);
    return;
  }
  if(existing){
    existing.amount = amount;
    existing.bucket = bucket;
    existing.label = type.label;
  }else{
    entries.push({
      id: newWizardRowId('savings'),
      typeId: type.id,
      label: type.label,
      owner,
      amount,
      bucket,
    });
  }
  syncSavingsAggregate(plan);
}

export function addFamilyFinanceEntry(plan, command){
  const mode = command.mode === 'income' ? 'income' : 'savings';
  const owner = validOwner(plan, command.owner);
  const amount = mode === 'savings'
    ? nonnegativeAmount(command.amount)
    : positiveAmount(command.amount);
  if(mode === 'income') addIncomeEntry(plan, command.typeId, owner, amount);
  else addSavingsEntry(plan, command.typeId, owner, amount);
  return plan;
}

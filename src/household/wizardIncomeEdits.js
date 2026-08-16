import {
  createIncomeSource,
  PLANNING_INCOME_SOURCE_TYPES,
  planningIncomeType,
} from './incomeTaxModel.js';

const SOURCE_TYPE_IDS = new Set(PLANNING_INCOME_SOURCE_TYPES.map(type => type.id));
const UNIT_TOTAL_TOLERANCE = 1e-9;
const hasOwn = (value, key) =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

function text(value){
  return String(value ?? '').trim();
}

function number(value, {
  min,
  max,
  integer = false,
  allowBlank = false,
}){
  if(allowBlank && (value === '' || value === null || value === undefined)){
    return null;
  }
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[$,%\s,]/g, ''));
  if(!Number.isFinite(parsed)) throw new Error('Enter a valid number');
  const normalized = integer ? Math.round(parsed) : parsed;
  if(normalized < min || normalized > max){
    throw new Error(`Enter a value from ${min} through ${max}`);
  }
  return normalized;
}

function ensureIncome(plan){
  if(!plan.income || typeof plan.income !== 'object' || Array.isArray(plan.income)){
    plan.income = {};
  }
  if(!Array.isArray(plan.income.other)) plan.income.other = [];
  if(!plan.income.socialSecurity
      || typeof plan.income.socialSecurity !== 'object'
      || Array.isArray(plan.income.socialSecurity)){
    plan.income.socialSecurity = { primary: null, spouse: null };
  }
  if(!plan.income.pension
      || typeof plan.income.pension !== 'object'
      || Array.isArray(plan.income.pension)){
    plan.income.pension = {
      benefitByAge: {},
      base: 0,
      startAge: 65,
      colaPct: 0,
    };
  }
  if(!plan.income.pension.benefitByAge
      || typeof plan.income.pension.benefitByAge !== 'object'
      || Array.isArray(plan.income.pension.benefitByAge)){
    plan.income.pension.benefitByAge = {};
  }
}

function ensureSavings(plan){
  if(!plan.savings || typeof plan.savings !== 'object' || Array.isArray(plan.savings)){
    plan.savings = { annual: 0, split: {} };
  }
  if(!plan.savings.split
      || typeof plan.savings.split !== 'object'
      || Array.isArray(plan.savings.split)){
    plan.savings.split = {};
  }
}

function incomeStepError(message, field, code){
  const error = new Error(message);
  error.field = field;
  error.code = code;
  return error;
}

function finiteShare(value){
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : null;
}

function validUnitTotal(values){
  return values.every(value => value !== null)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1)
      <= UNIT_TOTAL_TOLERANCE;
}

export function validateIncomeWizardStep(plan){
  const split = plan.savings?.split;
  const hasSleeveEntry = ['traditional', 'roth', 'taxable']
    .some(key => hasOwn(split, key));
  if(hasSleeveEntry){
    const sleeveShares = ['traditional', 'roth', 'taxable']
      .map(key => finiteShare(split?.[key] ?? 0));
    if(!validUnitTotal(sleeveShares)){
      throw incomeStepError(
        'Traditional, Roth, and Taxable percentages must total 100% before continuing.',
        'savings.split.taxable',
        'SAVINGS_SPLIT_MUST_TOTAL_100',
      );
    }
  }

  const byOwner = split?.byOwner;
  const hasOwnerEntry = ['client', 'spouse'].some(key => hasOwn(byOwner, key));
  if(hasOwnerEntry){
    const ownerShares = ['client', 'spouse']
      .map(key => finiteShare(byOwner?.[key] ?? 0));
    if(!validUnitTotal(ownerShares)){
      throw incomeStepError(
        'Client and co-client contribution shares must total 100% before continuing.',
        plan.household?.spouse
          ? 'savings.split.byOwner.spouse'
          : 'savings.split.byOwner.client',
        'SAVINGS_OWNER_SPLIT_MUST_TOTAL_100',
      );
    }
    if(!plan.household?.spouse && (ownerShares[1] ?? 0) > 0){
      throw incomeStepError(
        'Co-client contribution ownership requires a co-client.',
        'savings.split.byOwner.client',
        'SAVINGS_OWNER_UNAVAILABLE',
      );
    }
  }
  return true;
}

function sourceForId(plan, rowId){
  const matches = plan.income.other
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source?.id === rowId);
  if(matches.length !== 1){
    throw new Error(`Income source id must resolve exactly once: ${rowId}`);
  }
  return matches[0];
}

function editSocialSecurity(plan, field, value){
  const match = /^socialSecurity\.(primary|spouse)\.(pia|claimAge)$/.exec(field);
  if(!match) return false;
  const [, owner, attribute] = match;
  if(owner === 'spouse' && !plan.household?.spouse){
    throw new Error('Co-client Social Security requires a co-client');
  }
  const current = plan.income.socialSecurity[owner];
  const benefit = current && typeof current === 'object' && !Array.isArray(current)
    ? current
    : { pia: null, claimAge: 67 };
  plan.income.socialSecurity[owner] = benefit;
  if(attribute === 'pia'){
    benefit.pia = number(value, {
      min: 0,
      max: 99_000_000,
      integer: true,
      allowBlank: true,
    });
  }else{
    benefit.claimAge = number(value, { min: 62, max: 70, integer: true });
  }
  return true;
}

function editPension(plan, field, value){
  if(field === 'pension.base'){
    plan.income.pension.base = number(value, {
      min: 0,
      max: 99_000_000,
      integer: true,
    });
    return true;
  }
  if(field === 'pension.startAge'){
    plan.income.pension.startAge = number(value, {
      min: 45,
      max: 125,
      integer: true,
    });
    return true;
  }
  if(field === 'pension.colaPct'){
    plan.income.pension.colaPct = number(value, { min: 0, max: 20 });
    return true;
  }
  const match = /^pension\.benefitByAge\.(\d+)$/.exec(field);
  if(!match) return false;
  const age = number(match[1], { min: 45, max: 125, integer: true });
  plan.income.pension.benefitByAge[age] = number(value, {
    min: 0,
    max: 99_000_000,
    integer: true,
  });
  return true;
}

function editSavings(plan, field, value){
  if(field === 'savings.annual'){
    plan.savings.annual = number(value, {
      min: 0,
      max: 99_000_000,
      integer: true,
    });
    return true;
  }
  const splitMatch = /^savings\.split\.(traditional|roth|taxable)$/.exec(field);
  if(splitMatch){
    plan.savings.split[splitMatch[1]] = number(value, { min: 0, max: 100 }) / 100;
    return true;
  }
  const ownerMatch = /^savings\.split\.byOwner\.(client|spouse)$/.exec(field);
  if(!ownerMatch) return false;
  if(ownerMatch[1] === 'spouse' && !plan.household?.spouse){
    throw new Error('Co-client contribution ownership requires a co-client');
  }
  if(!plan.savings.split.byOwner
      || typeof plan.savings.split.byOwner !== 'object'
      || Array.isArray(plan.savings.split.byOwner)){
    plan.savings.split.byOwner = {};
  }
  const parsed = number(value, { min: 0, max: 100, allowBlank: true });
  if(parsed === null) delete plan.savings.split.byOwner[ownerMatch[1]];
  else plan.savings.split.byOwner[ownerMatch[1]] = parsed / 100;
  if(Object.keys(plan.savings.split.byOwner).length === 0){
    delete plan.savings.split.byOwner;
  }
  return true;
}

function editSource(plan, command){
  if(!command.field?.startsWith('source.')) return false;
  const { source } = sourceForId(plan, command.rowId);
  const field = command.field.slice('source.'.length);
  if(field === 'typeId'){
    const type = planningIncomeType(command.value);
    if(!type || !SOURCE_TYPE_IDS.has(command.value)){
      throw new Error('Unsupported planning income source type');
    }
    source.typeId = command.value;
    if(type.taxTreatment === 'fully-taxable'
        || type.taxTreatment === 'qualified-share'){
      source.taxablePct = 1;
    }else if(!Number.isFinite(Number(source.taxablePct))){
      source.taxablePct = type.taxablePct;
    }
    if(type.taxTreatment === 'qualified-share'){
      if(!Number.isFinite(Number(source.qualifiedPct))) source.qualifiedPct = 0;
    }else{
      delete source.qualifiedPct;
    }
  }else if(field === 'label'){
    source.label = text(command.value);
  }else if(field === 'owner'){
    if(!['client', 'spouse', 'joint'].includes(command.value)){
      throw new Error('Unsupported income source owner');
    }
    if(command.value === 'spouse' && !plan.household?.spouse){
      throw new Error('Co-client income requires a co-client');
    }
    source.owner = command.value;
  }else if(field === 'amount'){
    source.amount = number(command.value, {
      min: source.typeId === 'long_term_capital_gain' ? -99_000_000 : 0,
      max: 99_000_000,
      integer: true,
    });
  }else if(field === 'startAge' || field === 'endAge'){
    source[field] = number(command.value, { min: 0, max: 999, integer: true });
    if(Number(source.startAge) > Number(source.endAge)){
      throw new Error('Income start age cannot follow end age');
    }
  }else if(field === 'realGrowth'){
    source.realGrowth = number(command.value, { min: -20, max: 20 }) / 100;
  }else if(field === 'taxablePct'){
    if(planningIncomeType(source.typeId)?.taxTreatment !== 'taxable-share'){
      throw new Error('This planning income type does not use a taxable percentage');
    }
    source.taxablePct = number(command.value, { min: 0, max: 100 }) / 100;
  }else if(field === 'qualifiedPct'){
    if(planningIncomeType(source.typeId)?.taxTreatment !== 'qualified-share'){
      throw new Error('Only dividend income uses a qualified percentage');
    }
    source.qualifiedPct = number(command.value, { min: 0, max: 100 }) / 100;
  }else{
    throw new Error(`Unsupported income source field: ${field}`);
  }
  return true;
}

function addPensionAge(plan, requestedAge){
  const schedule = plan.income.pension.benefitByAge;
  const occupied = new Set(Object.keys(schedule).map(Number).filter(Number.isFinite));
  let age = requestedAge == null
    ? Number(plan.income.pension.startAge) || 65
    : number(requestedAge, { min: 45, max: 125, integer: true });
  while(age <= 125 && occupied.has(age)) age += 1;
  if(age > 125){
    age = 45;
    while(age <= 125 && occupied.has(age)) age += 1;
  }
  if(age > 125) throw new Error('No pension ages are available');
  schedule[age] = 0;
  return age;
}

export function applyIncomeWizardEdit(plan, command){
  ensureIncome(plan);
  ensureSavings(plan);

  if(command.action === 'validate-step'){
    validateIncomeWizardStep(plan);
    return;
  }
  if(command.action === 'add-income-source'){
    const owner = command.owner || 'client';
    if(owner === 'spouse' && !plan.household?.spouse){
      throw new Error('Co-client income requires a co-client');
    }
    const typeId = command.typeId || 'other';
    if(!SOURCE_TYPE_IDS.has(typeId)){
      throw new Error('Unsupported planning income source type');
    }
    plan.income.other.push(createIncomeSource(plan, typeId, owner));
    return;
  }
  if(command.action === 'remove-income-source'){
    const { index } = sourceForId(plan, command.rowId);
    plan.income.other.splice(index, 1);
    return;
  }
  if(command.action === 'add-pension-age'){
    addPensionAge(plan, command.age);
    return;
  }
  if(command.action === 'remove-pension-age'){
    const age = number(command.age, { min: 45, max: 125, integer: true });
    if(!Object.prototype.hasOwnProperty.call(plan.income.pension.benefitByAge, age)){
      throw new Error('Pension age must resolve exactly once');
    }
    delete plan.income.pension.benefitByAge[age];
    return;
  }
  if(editSocialSecurity(plan, command.field, command.value)) return;
  if(editPension(plan, command.field, command.value)) return;
  if(editSavings(plan, command.field, command.value)) return;
  if(editSource(plan, command)) return;
  throw new Error(`Unsupported income field: ${command.field}`);
}

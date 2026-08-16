import { newWizardRowId } from './householdRecordSchema.js';

const freezeRows = rows => Object.freeze(rows.map(row => Object.freeze({ ...row })));

export const INCOME_SOURCE_TYPES = freezeRows([
  { id: 'wages', label: 'Wages or salary', timing: 'working', taxablePct: 1 },
  { id: 'bonus', label: 'Bonus', timing: 'working', taxablePct: 1 },
  { id: 'self_employment', label: 'Self-employment', timing: 'working', taxablePct: 1 },
  { id: 'social_security', label: 'Social Security', timing: 'retirement', taxablePct: null },
  { id: 'pension', label: 'Pension', timing: 'retirement', taxablePct: 1 },
  { id: 'annuity', label: 'Annuity', timing: 'retirement', taxablePct: 1 },
  { id: 'rental', label: 'Rental net income', timing: 'ongoing', taxablePct: 1 },
  { id: 'interest', label: 'Interest', timing: 'ongoing', taxablePct: 1 },
  { id: 'tax_exempt_interest', label: 'Tax-exempt interest', timing: 'current', taxablePct: 0 },
  { id: 'dividends', label: 'Dividends', timing: 'ongoing', taxablePct: 1 },
  { id: 'ira_distribution', label: 'IRA distribution', timing: 'current', taxablePct: 1 },
  { id: 'roth_conversion', label: 'Roth conversion', timing: 'current', taxablePct: 1 },
  { id: 'short_term_capital_gain', label: 'Short-term capital gain', timing: 'current', taxablePct: 1 },
  { id: 'long_term_capital_gain', label: 'Long-term capital gain', timing: 'current', taxablePct: 0 },
  { id: 'deferred_comp', label: 'Deferred compensation', timing: 'retirement', taxablePct: 1 },
  { id: 'other', label: 'Other income', timing: 'ongoing', taxablePct: 1 },
]);

// The Income step owns recurring planning cash flows, not current-year Form
// 1040 lines. Social Security and pension also have dedicated canonical
// controls on that step, so neither belongs in this add/type-change catalog.
// `taxTreatment` controls which tax attribute, if any, is editable in the UI.
export const PLANNING_INCOME_SOURCE_TYPES = freezeRows([
  { id: 'wages', label: 'Wages or salary', timing: 'working', taxablePct: 1, taxTreatment: 'fully-taxable' },
  { id: 'bonus', label: 'Bonus', timing: 'working', taxablePct: 1, taxTreatment: 'fully-taxable' },
  { id: 'self_employment', label: 'Self-employment', timing: 'working', taxablePct: 1, taxTreatment: 'fully-taxable' },
  { id: 'annuity', label: 'Annuity', timing: 'retirement', taxablePct: 1, taxTreatment: 'taxable-share' },
  { id: 'rental', label: 'Rental net income', timing: 'ongoing', taxablePct: 1, taxTreatment: 'fully-taxable' },
  { id: 'interest', label: 'Taxable interest', timing: 'ongoing', taxablePct: 1, taxTreatment: 'fully-taxable' },
  { id: 'dividends', label: 'Dividends', timing: 'ongoing', taxablePct: 1, taxTreatment: 'qualified-share' },
  { id: 'deferred_comp', label: 'Deferred compensation', timing: 'retirement', taxablePct: 1, taxTreatment: 'fully-taxable' },
  { id: 'other', label: 'Other income', timing: 'ongoing', taxablePct: 1, taxTreatment: 'taxable-share' },
]);

export function planningIncomeType(id){
  return PLANNING_INCOME_SOURCE_TYPES.find(type => type.id === id) || null;
}

export const CURRENT_1040_INCOME_SOURCE_GROUPS = Object.freeze([
  Object.freeze({
    id: 'wages',
    typeIds: Object.freeze(['wages', 'bonus']),
    fields: Object.freeze(['wages']),
  }),
  Object.freeze({
    id: 'interest',
    typeIds: Object.freeze(['interest', 'tax_exempt_interest']),
    fields: Object.freeze(['taxableInterest', 'taxExemptInterest']),
  }),
  Object.freeze({
    id: 'dividends',
    typeIds: Object.freeze(['dividends']),
    fields: Object.freeze(['ordinaryDividends', 'qualifiedDividends']),
  }),
  Object.freeze({
    id: 'ira',
    typeIds: Object.freeze(['ira_distribution']),
    fields: Object.freeze(['iraDistributions', 'taxableIra']),
  }),
  Object.freeze({
    id: 'roth-conversion',
    typeIds: Object.freeze(['roth_conversion']),
    fields: Object.freeze(['rothConversion']),
  }),
  Object.freeze({
    id: 'pension',
    typeIds: Object.freeze(['pension', 'annuity']),
    fields: Object.freeze(['pensionAmount', 'taxablePensions']),
  }),
  Object.freeze({
    id: 'other-income',
    typeIds: Object.freeze([
      'self_employment',
      'rental',
      'deferred_comp',
      'other',
    ]),
    fields: Object.freeze(['otherIncome']),
  }),
  Object.freeze({
    id: 'long-term-gain-loss',
    typeIds: Object.freeze(['long_term_capital_gain']),
    fields: Object.freeze([]),
  }),
]);

export const CURRENT_1040_INCOME_SOURCE_GROUP_IDS = Object.freeze(
  CURRENT_1040_INCOME_SOURCE_GROUPS.map(group => group.id),
);

export function current1040IncomeSourceGroup(typeId){
  return CURRENT_1040_INCOME_SOURCE_GROUPS.find(
    group => group.typeIds.includes(typeId),
  ) || null;
}

export const ADJUSTMENT_TYPES = freezeRows([
  { id: '401k', label: '401(k) contribution', note: 'pre-tax · while working' },
  { id: 'hsa', label: 'HSA contribution', note: 'reduces AGI' },
  { id: 'ira_deduction', label: 'Deductible IRA contribution', note: 'deductibility requires tax facts' },
  { id: 'other', label: 'Other adjustment', note: 'reduces AGI' },
]);

export const DEDUCTION_TYPES = freezeRows([
  { id: 'medical', label: 'Medical expenses', note: 'AGI floor not yet calculated' },
  { id: 'charitable', label: 'Charitable contributions', note: '' },
  { id: 'mortgage_interest', label: 'Mortgage interest', note: '' },
  { id: 'real_estate_tax', label: 'Real-estate taxes', note: 'SALT cap rule not yet calculated' },
  { id: 'personal_property_tax', label: 'Personal-property taxes', note: 'SALT cap rule not yet calculated' },
  { id: 'salt', label: 'State & local taxes', note: 'cap not yet calculated' },
  { id: 'other', label: 'Other itemized deduction', note: '' },
]);

export const CREDIT_TYPES = freezeRows([
  { id: 'premium_tax_credit', label: 'Premium Tax Credit', note: 'applied as entered on Form 1040 line 20' },
]);

const byId = (rows, id, fallback = 'other') =>
  rows.find(row => row.id === id) || rows.find(row => row.id === fallback) || rows[0];

export const incomeType = id => byId(INCOME_SOURCE_TYPES, id);
export const adjustmentType = id => byId(ADJUSTMENT_TYPES, id);
export const deductionType = id => byId(DEDUCTION_TYPES, id);
export const creditType = id => byId(CREDIT_TYPES, id, 'premium_tax_credit');

export function createIncomeTaxInputs(){
  return {
    adjustments: [],
    deductions: [],
    credits: [],
    deductionMode: 'auto',
  };
}

export function currentAgeForOwner(plan, owner){
  if(owner === 'spouse' && plan.household?.spouse?.currentAge != null){
    return plan.household.spouse.currentAge;
  }
  return plan.household?.primary?.currentAge ?? 0;
}

export function retirementAgeForOwner(plan, owner){
  if(owner === 'spouse' && plan.household?.spouse?.retirementAge != null){
    return plan.household.spouse.retirementAge;
  }
  return plan.household?.primary?.retirementAge ?? currentAgeForOwner(plan, owner);
}

function retirementAgeForSource(plan, owner){
  if(owner !== 'joint') return retirementAgeForOwner(plan, owner);
  return Math.max(
    retirementAgeForOwner(plan, 'client'),
    plan.household?.spouse ? retirementAgeForOwner(plan, 'spouse') : 0,
  );
}

export function ownerLabel(plan, owner){
  if(owner === 'joint') return 'Joint';
  if(owner === 'spouse') return plan.meta?.spouseName || 'Client 2';
  return plan.meta?.primaryName || 'Client 1';
}

export function normalizedIncomeSource(plan, source = {}){
  const type = incomeType(source.typeId || source.type || 'other');
  const planningType = planningIncomeType(type.id);
  const owner = source.owner === 'spouse' || source.owner === 'joint' ? source.owner : 'client';
  const currentAge = currentAgeForOwner(plan, owner);
  const retirementAge = retirementAgeForOwner(plan, owner);
  const enteredAmount = Number(source.amount);
  const amount = type.id === 'long_term_capital_gain'
    ? (Number.isFinite(enteredAmount) ? enteredAmount : 0)
    : Math.max(0, enteredAmount || 0);
  return {
    ...source,
    typeId: type.id,
    label: source.label || type.label,
    owner,
    amount,
    startAge: source.startAge ?? currentAge,
    endAge: source.endAge ?? (type.timing === 'working'
      ? retirementAge - 1
      : type.timing === 'current' ? currentAge : 999),
    realGrowth: Number(source.realGrowth) || 0,
    taxablePct: planningType?.taxTreatment === 'fully-taxable'
      || planningType?.taxTreatment === 'qualified-share'
      ? 1
      : (source.taxablePct == null ? type.taxablePct : source.taxablePct),
    qualifiedPct: source.qualifiedPct == null ? 0 : source.qualifiedPct,
    timing: type.timing,
  };
}

export function isSourceActiveNow(plan, source){
  const row = normalizedIncomeSource(plan, source);
  const age = currentAgeForOwner(plan, row.owner);
  return age >= row.startAge && age <= row.endAge;
}

export function incomePhase(plan, source){
  const row = normalizedIncomeSource(plan, source);
  return row.startAge >= retirementAgeForSource(plan, row.owner) ? 'retirement' : 'working';
}

export function incomeSourceGroups(plan){
  const sources = (plan.income?.other || []).map(source => normalizedIncomeSource(plan, source));
  return {
    working: sources.filter(source => incomePhase(plan, source) === 'working'),
    retirement: sources.filter(source => incomePhase(plan, source) === 'retirement'),
  };
}

export function enteredIncomeTotal(plan){
  return (plan.income?.other || [])
    .filter(source => isSourceActiveNow(plan, source))
    .reduce((sum, source) => sum + (Number(source.amount) || 0), 0);
}

export function enteredAdjustmentTotal(plan){
  return (plan.incomeTax?.adjustments || [])
    .filter(row => isAdjustmentActiveNow(plan, row))
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

export function isAdjustmentActiveNow(plan, row = {}){
  const type = adjustmentType(row.typeId);
  const whileWorkingOnly = row.whileWorkingOnly == null
    ? type.id === '401k'
    : row.whileWorkingOnly === true;
  if(!whileWorkingOnly) return true;
  if(row.owner === 'joint'){
    return currentAgeForOwner(plan, 'client') < retirementAgeForOwner(plan, 'client')
      || (plan.household?.spouse
        && currentAgeForOwner(plan, 'spouse') < retirementAgeForOwner(plan, 'spouse'));
  }
  const owner = row.owner === 'spouse' ? 'spouse' : 'client';
  return currentAgeForOwner(plan, owner) < retirementAgeForOwner(plan, owner);
}

export function enteredDeductionTotal(plan){
  return (plan.incomeTax?.deductions || [])
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

export function enteredCreditTotal(plan){
  return (plan.incomeTax?.credits || [])
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

export function createIncomeSource(plan, typeId = 'wages', owner = 'client'){
  const type = incomeType(typeId);
  const currentAge = currentAgeForOwner(plan, owner);
  const retirementAge = retirementAgeForOwner(plan, owner);
  return {
    id: newWizardRowId('income'),
    typeId: type.id,
    label: type.label,
    owner,
    amount: 0,
    startAge: currentAge,
    endAge: type.timing === 'working'
      ? Math.max(currentAge, retirementAge - 1)
      : type.timing === 'current' ? currentAge : 999,
    realGrowth: 0,
    taxablePct: type.taxablePct,
    qualifiedPct: type.id === 'dividends' ? 0 : undefined,
  };
}

export function createAdjustment(typeId = '401k', owner = 'client'){
  const type = adjustmentType(typeId);
  return {
    id: newWizardRowId('adjustment'),
    typeId: type.id,
    label: type.label,
    owner,
    amount: 0,
    whileWorkingOnly: type.id === '401k',
  };
}

export function createDeduction(typeId = 'charitable'){
  const type = deductionType(typeId);
  return { id: newWizardRowId('deduction'), typeId: type.id, label: type.label, amount: 0 };
}

export function createCredit(typeId = 'premium_tax_credit'){
  const type = creditType(typeId);
  return { id: newWizardRowId('credit'), typeId: type.id, label: type.label, amount: 0 };
}

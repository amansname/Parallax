import {
  ensureWizardCurrent1040,
  restrictTaxpayersToBaseAndAge,
} from './wizardCurrent1040.js';
import {
  INCOME_FIELD_GROUPS,
  readWizardPlanningIncome,
} from './wizardPlanningIncome.js';
import {
  cloneWizardValue,
  hasOwn,
  wizardTaxError,
} from './wizardIntakeSupport.js';
import { newWizardRowId } from './householdRecordSchema.js';
import { setWizardIrmaaLookbackField } from './wizardIrmaa.js';

const INCOME_FIELDS = new Set([
  'wages',
  'taxableInterest',
  'taxExemptInterest',
  'ordinaryDividends',
  'qualifiedDividends',
  'iraDistributions',
  'taxableIra',
  'rothConversion',
  'pensionAmount',
  'taxablePensions',
  'socialSecurityBenefits',
  'taxableSS',
  'otherIncome',
]);

const SIGNED_INCOME_FIELDS = new Set(['otherIncome']);
const PASS_THROUGH_FIELDS = new Set(['line17', 'line19', 'line20', 'line23']);
export const SCHEDULE_2_FIELDS = new Set([
  'netInvestmentIncomeTax',
  'additionalMedicareTax',
  'otherPartIITaxes',
]);
const ITEMIZED_FIELDS = Object.freeze({
  medicalExpensesPaid: 'medicalExpensesPaid',
  mortgageInterestDeductible: 'mortgageInterestDeductible',
  charitableContributionsDeductible: 'charitableContributionsDeductible',
  otherItemizedDeductions: 'otherItemizedDeductions',
});

export function parseWizardNumber(value, { signed = false } = {}){
  if(value === '' || value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[$,\s]/g, ''));
  if(!Number.isFinite(parsed)){
    throw new Error('Enter a valid number');
  }
  if(!signed && parsed < 0){
    throw new Error('Enter zero or a positive amount');
  }
  return parsed;
}

function setOrDelete(record, key, value){
  if(value === undefined) delete record[key];
  else record[key] = value;
}

function removeObjectWhenEmpty(parent, key){
  const value = parent[key];
  if(value && typeof value === 'object' && Object.keys(value).length === 0){
    delete parent[key];
  }
}

function ensureSchedule1A(deductions){
  if(!deductions.schedule1A || typeof deductions.schedule1A !== 'object'){
    deductions.schedule1A = { mode: 'supplied-line13b' };
  }
  deductions.schedule1A.mode = 'supplied-line13b';
  return deductions.schedule1A;
}

function preserveDeductionPassThrough(previous, next){
  if(hasOwn(previous, 'qbi')) next.qbi = previous.qbi;
  if(previous.schedule1A){
    next.schedule1A = cloneWizardValue(previous.schedule1A);
  }
  return next;
}

function setDeductionMode(plan, current, mode){
  const previous = current.deductions || {};
  if(mode === 'standard'){
    current.deductions = preserveDeductionPassThrough(previous, {
      method: 'standard',
      source: 'calculated',
      standardScope: 'base-and-age',
    });
    restrictTaxpayersToBaseAndAge(plan, current);
    return;
  }
  if(mode === 'itemized-details'){
    current.deductions = preserveDeductionPassThrough(previous, {
      method: 'itemized',
      source: 'calculated',
      itemized: previous.itemized ? cloneWizardValue(previous.itemized) : {},
    });
    return;
  }
  if(mode === 'itemized-total'){
    const next = preserveDeductionPassThrough(previous, {
      method: 'itemized',
      source: 'supplied-line12e',
    });
    if(hasOwn(previous, 'line12e')) next.line12e = previous.line12e;
    current.deductions = next;
    return;
  }
  throw new Error('Unsupported deduction method');
}

function assertIncomeGroupEditable(plan, current, groupId, field, value){
  const planning = readWizardPlanningIncome(plan, current);
  const group = planning.groups[groupId];
  if(group.rowSourced){
    throw wizardTaxError(
      'Use current-year amount before editing a planning-income value',
      field,
      'CURRENT_1040_INCOME_OVERRIDE_REQUIRED',
    );
  }
  if(group.overridden
      && group.rowIds.length > 0
      && parseWizardNumber(value, {
        signed: field === 'scheduleD.netLongTermGainOrLoss'
          || SIGNED_INCOME_FIELDS.has(field.replace(/^income\./, '')),
      }) === undefined){
    throw wizardTaxError(
      'Enter 0 or use planning income again',
      field,
      'CURRENT_1040_INCOME_OVERRIDE_VALUE_REQUIRED',
    );
  }
}

function setIncomeField(plan, current, field, value){
  if(!INCOME_FIELDS.has(field)){
    throw new Error(`Unsupported income field: ${field}`);
  }
  const groupId = INCOME_FIELD_GROUPS.get(field);
  if(groupId){
    assertIncomeGroupEditable(plan, current, groupId, `income.${field}`, value);
  }
  const parsed = parseWizardNumber(value, {
    signed: SIGNED_INCOME_FIELDS.has(field),
  });
  setOrDelete(current.income, field, parsed);
  current.incomeSourcesComplete = false;
  if(field === 'taxableSS' && parsed !== undefined){
    current.income.socialSecurity = { mode: 'supplied-form1040-lines' };
  }
}

function setMemberWages(plan, current, owner, value){
  if(owner !== 'client' && owner !== 'spouse'){
    throw new Error('Unsupported wage owner');
  }
  if(owner === 'spouse' && !plan.household?.spouse){
    throw new Error('Co-client wages require a co-client');
  }
  const parsed = parseWizardNumber(value);
  const planningAsOfYear = Number.isInteger(plan.meta?.planningAsOfYear)
    ? plan.meta.planningAsOfYear
    : current.taxYear;
  if(Number(current.taxYear) !== Number(planningAsOfYear)){
    const byOwner = current.wagesByOwner
      && typeof current.wagesByOwner === 'object'
      && !Array.isArray(current.wagesByOwner)
      ? current.wagesByOwner
      : {};
    setOrDelete(byOwner, owner, parsed);
    if(Object.keys(byOwner).length > 0) current.wagesByOwner = byOwner;
    else delete current.wagesByOwner;
    const values = Object.values(byOwner).filter(Number.isFinite);
    setOrDelete(
      current.income,
      'wages',
      values.length > 0 ? values.reduce((sum, amount) => sum + amount, 0) : undefined,
    );
    const overrides = new Set(
      Array.isArray(current.planningIncomeOverrides)
        ? current.planningIncomeOverrides
        : [],
    );
    overrides.add('wages');
    current.planningIncomeOverrides = [...overrides];
    current.incomeSourcesComplete = false;
    return;
  }
  const rows = Array.isArray(plan.income?.other) ? plan.income.other : [];
  plan.income.other = rows.filter(row => !(
    row?.owner === owner && (row?.typeId === 'wages' || row?.typeId === 'bonus')
  ));
  if(parsed !== undefined){
    const person = owner === 'spouse'
      ? plan.household.spouse
      : plan.household.primary;
    const currentAge = Number(person?.currentAge);
    const retirementAge = Number(person?.retirementAge);
    const currentYearOnly = Number.isFinite(currentAge)
      && (person?.employmentStatus === 'retired'
        || (Number.isFinite(retirementAge) && currentAge >= retirementAge));
    plan.income.other.push({
      id: newWizardRowId('income'),
      typeId: 'wages',
      label: 'Wages or salary',
      owner,
      amount: parsed,
      ...(currentYearOnly ? { startAge: currentAge, endAge: currentAge } : {}),
      realGrowth: 0,
      taxablePct: 1,
    });
  }
  delete current.wagesByOwner;
  delete current.income.wages;
  if(Array.isArray(current.planningIncomeOverrides)){
    current.planningIncomeOverrides = current.planningIncomeOverrides
      .filter(groupId => groupId !== 'wages');
    if(current.planningIncomeOverrides.length === 0){
      delete current.planningIncomeOverrides;
    }
  }
  current.incomeSourcesComplete = false;
}

function setSocialSecurityMode(current, mode){
  current.incomeSourcesComplete = false;
  if(mode === 'supplied-form1040-lines'){
    current.income.socialSecurity = { mode };
    return;
  }
  if(mode === 'calculate-taxable-benefits'){
    const previous = current.income.socialSecurity || {};
    current.income.socialSecurity = {
      mode,
      ...(hasOwn(previous, 'otherIncome')
        ? { otherIncome: previous.otherIncome }
        : {}),
      ...(hasOwn(previous, 'excludedIncomeAddBacks')
        ? { excludedIncomeAddBacks: previous.excludedIncomeAddBacks }
        : {}),
      ...(hasOwn(previous, 'adjustments')
        ? { adjustments: previous.adjustments }
        : {}),
    };
    delete current.income.taxableSS;
    return;
  }
  throw new Error('Unsupported Social Security source');
}

function setSocialSecurityWorksheetField(current, field, value){
  if(!['otherIncome', 'excludedIncomeAddBacks', 'adjustments'].includes(field)){
    throw new Error(`Unsupported Social Security worksheet field: ${field}`);
  }
  if(current.income.socialSecurity?.mode !== 'calculate-taxable-benefits'){
    setSocialSecurityMode(current, 'calculate-taxable-benefits');
  }
  const parsed = parseWizardNumber(value, { signed: field === 'otherIncome' });
  setOrDelete(current.income.socialSecurity, field, parsed);
  current.incomeSourcesComplete = false;
}

function setScheduleD(plan, current, value){
  assertIncomeGroupEditable(
    plan,
    current,
    'long-term-gain-loss',
    'scheduleD.netLongTermGainOrLoss',
    value,
  );
  const parsed = parseWizardNumber(value, { signed: true });
  current.incomeSourcesComplete = false;
  if(parsed === undefined){
    delete current.scheduleD;
    return;
  }
  current.scheduleD = {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: parsed,
  };
}

function setAdjustmentLine10(current, value){
  const parsed = parseWizardNumber(value);
  if(parsed === undefined){
    delete current.adjustments;
    return;
  }
  current.adjustments = { mode: 'supplied-line10', amount: parsed };
}

function setDeductionScalar(current, field, value){
  const parsed = parseWizardNumber(value);
  if(field === 'line12e'){
    if(current.deductions.source !== 'supplied-line12e'){
      setDeductionMode(null, current, 'itemized-total');
    }
    setOrDelete(current.deductions, 'line12e', parsed);
    return;
  }
  if(field === 'qbi'){
    setOrDelete(current.deductions, 'qbi', parsed);
    return;
  }
  if(field === 'line13b'){
    if(parsed === undefined){
      delete current.deductions.schedule1A;
      return;
    }
    const schedule1A = ensureSchedule1A(current.deductions);
    setOrDelete(schedule1A, 'amount', parsed);
    return;
  }
  throw new Error(`Unsupported deduction scalar: ${field}`);
}

function setItemizedField(current, field, value){
  const target = ITEMIZED_FIELDS[field];
  if(!target) throw new Error(`Unsupported itemized field: ${field}`);
  if(current.deductions.method !== 'itemized'
      || current.deductions.source !== 'calculated'){
    setDeductionMode(null, current, 'itemized-details');
  }
  const parsed = parseWizardNumber(value);
  setOrDelete(current.deductions.itemized, target, parsed);
}

function setSaltField(current, field, value){
  if(current.deductions.method !== 'itemized'
      || current.deductions.source !== 'calculated'){
    setDeductionMode(null, current, 'itemized-details');
  }
  const itemized = current.deductions.itemized;
  if(!itemized.salt || typeof itemized.salt !== 'object') itemized.salt = {};
  if(field === 'eligibleTaxesPaid'){
    setOrDelete(itemized.salt, field, parseWizardNumber(value));
  }else if(field === 'magi'){
    const parsed = parseWizardNumber(value);
    if(parsed === undefined) delete itemized.salt.magi;
    else itemized.salt.magi = { mode: 'supplied-magi', amount: parsed };
  }else{
    throw new Error(`Unsupported SALT field: ${field}`);
  }
  removeObjectWhenEmpty(itemized, 'salt');
}

function setPassThrough(current, field, value){
  if(!PASS_THROUGH_FIELDS.has(field)){
    throw new Error(`Unsupported pass-through field: ${field}`);
  }
  const parsed = parseWizardNumber(value);
  if(field === 'line23'
      && parsed !== undefined
      && (hasOwn(current, 'schedule2') || hasOwn(current, 'scheduleSE'))){
    throw wizardTaxError(
      'Remove Schedule 2 and Schedule SE before supplying line 23',
      'passThrough.line23',
      'SCHEDULE_2_SOURCE_CONFLICT',
    );
  }
  if(!current.passThrough || typeof current.passThrough !== 'object'){
    current.passThrough = {};
  }
  setOrDelete(current.passThrough, field, parsed);
  removeObjectWhenEmpty(current, 'passThrough');
}

function setSchedule2(current, field, value){
  if(!SCHEDULE_2_FIELDS.has(field)){
    throw new Error(`Unsupported Schedule 2 field: ${field}`);
  }
  const parsed = parseWizardNumber(value);
  if(parsed !== undefined && hasOwn(current.passThrough, 'line23')){
    throw wizardTaxError(
      'Remove supplied line 23 before entering Schedule 2 components',
      `schedule2.${field}`,
      'SCHEDULE_2_SOURCE_CONFLICT',
    );
  }
  if(!current.schedule2 || typeof current.schedule2 !== 'object'){
    current.schedule2 = {};
  }
  setOrDelete(current.schedule2, field, parsed);
  removeObjectWhenEmpty(current, 'schedule2');
}

function ensureScheduleSE(current){
  if(hasOwn(current.passThrough, 'line23')){
    throw wizardTaxError(
      'Remove supplied line 23 before adding Schedule SE',
      'scheduleSE.netEarningsFromSelfEmployment',
      'SCHEDULE_2_SOURCE_CONFLICT',
    );
  }
  if(!Array.isArray(current.scheduleSE) || current.scheduleSE.length === 0){
    current.scheduleSE = [{
      taxpayerOwner: 'client',
      socialSecurityWagesAndTipsIsScheduleSELine8d: true,
    }];
  }
  if(current.scheduleSE.length > 1){
    throw new Error('The wizard supports one Schedule SE taxpayer entry at a time');
  }
  return current.scheduleSE[0];
}

function setScheduleSE(current, field, value){
  if(field === 'enabled'){
    if(value === true) ensureScheduleSE(current);
    else delete current.scheduleSE;
    return;
  }
  const entry = ensureScheduleSE(current);
  if(field === 'taxpayerOwner'){
    if(!['client', 'spouse'].includes(value)){
      throw new Error('Unsupported Schedule SE owner');
    }
    entry.taxpayerOwner = value;
    return;
  }
  if(field === 'netEarningsFromSelfEmployment'
      || field === 'socialSecurityWagesAndTips'){
    setOrDelete(entry, field, parseWizardNumber(value));
    return;
  }
  throw new Error(`Unsupported Schedule SE field: ${field}`);
}

export function setWizardTaxField(plan, field, value){
  if(field.startsWith('irmaa.lookback.')){
    return setWizardIrmaaLookbackField(plan, field, value);
  }
  const current = ensureWizardCurrent1040(plan);
  current.incomeSourcesComplete = false;
  if(field === 'taxYear'){
    const year = Number(value);
    if(year !== 2025 && year !== 2026){
      throw new Error('Tax year must be 2025 or 2026');
    }
    current.taxYear = year;
    return current;
  }
  if(field === 'deductionMode'){
    setDeductionMode(plan, current, value);
    return current;
  }
  if(field === 'socialSecurity.mode'){
    setSocialSecurityMode(current, value);
    return current;
  }
  if(field.startsWith('socialSecurity.')){
    setSocialSecurityWorksheetField(
      current,
      field.slice('socialSecurity.'.length),
      value,
    );
    return current;
  }
  if(field === 'scheduleD.netLongTermGainOrLoss'){
    setScheduleD(plan, current, value);
    return current;
  }
  if(field === 'adjustments.line10'){
    setAdjustmentLine10(current, value);
    return current;
  }
  if(field.startsWith('deductions.itemized.salt.')){
    setSaltField(
      current,
      field.slice('deductions.itemized.salt.'.length),
      value,
    );
    return current;
  }
  if(field.startsWith('deductions.itemized.')){
    setItemizedField(
      current,
      field.slice('deductions.itemized.'.length),
      value,
    );
    return current;
  }
  if(field.startsWith('deductions.')){
    setDeductionScalar(current, field.slice('deductions.'.length), value);
    return current;
  }
  if(field.startsWith('passThrough.')){
    setPassThrough(current, field.slice('passThrough.'.length), value);
    return current;
  }
  if(field.startsWith('schedule2.')){
    setSchedule2(current, field.slice('schedule2.'.length), value);
    return current;
  }
  if(field.startsWith('scheduleSE.')){
    setScheduleSE(current, field.slice('scheduleSE.'.length), value);
    return current;
  }
  if(field === 'income.wages.client' || field === 'income.wages.spouse'){
    setMemberWages(plan, current, field.slice('income.wages.'.length), value);
    return current;
  }
  if(field.startsWith('income.')){
    setIncomeField(plan, current, field.slice('income.'.length), value);
    return current;
  }
  throw new Error(`Unsupported tax field: ${field}`);
}

export function removeWizardTaxItem(plan, item){
  const current = ensureWizardCurrent1040(plan);
  current.incomeSourcesComplete = false;
  if(item === 'adjustments'){
    delete current.adjustments;
  }else if(item === 'line12e'){
    if(current.deductions.source === 'supplied-line12e'){
      setDeductionMode(plan, current, 'standard');
    }else{
      delete current.deductions.line12e;
    }
  }else if(item === 'qbi'){
    delete current.deductions.qbi;
  }else if(item === 'line13b'){
    delete current.deductions.schedule1A;
  }else if(item === 'socialSecurity'){
    delete current.income.taxableSS;
    delete current.income.socialSecurity;
  }else if(item === 'schedule2'){
    if(hasOwn(current, 'scheduleSE')){
      throw wizardTaxError(
        'Remove Schedule SE before removing its Schedule 2 components',
        'schedule2.netInvestmentIncomeTax',
        'MISSING_SCHEDULE_2_INPUT',
      );
    }
    delete current.schedule2;
  }else if(item === 'scheduleSE'){
    delete current.scheduleSE;
  }else if(PASS_THROUGH_FIELDS.has(item)){
    if(current.passThrough) delete current.passThrough[item];
    removeObjectWhenEmpty(current, 'passThrough');
  }else{
    throw new Error(`Unsupported optional tax item: ${item}`);
  }
}

export function deductionModeForWizard(current){
  const deductions = current?.deductions;
  if(deductions?.method === 'itemized' && deductions.source === 'calculated'){
    return 'itemized-details';
  }
  if(deductions?.source === 'supplied-line12e') return 'itemized-total';
  return 'standard';
}

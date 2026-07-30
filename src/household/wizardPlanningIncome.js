import {
  CURRENT_1040_INCOME_SOURCE_GROUPS,
  CURRENT_1040_INCOME_SOURCE_GROUP_IDS,
  current1040IncomeSourceGroup,
  isSourceActiveNow,
  normalizedIncomeSource,
} from './incomeTaxModel.js';
import { ensureWizardCurrent1040 } from './wizardCurrent1040.js';
import {
  hasOwn,
  wizardTaxError,
} from './wizardIntakeSupport.js';

const INCOME_OVERRIDE_GROUPS =
  new Set(CURRENT_1040_INCOME_SOURCE_GROUP_IDS);

export const INCOME_FIELD_GROUPS = new Map(
  CURRENT_1040_INCOME_SOURCE_GROUPS.flatMap(group =>
    group.fields.map(field => [field, group.id])),
);

function activeReturnOwners(plan, current){
  const filingStatus = plan.meta?.filingStatus;
  if(filingStatus === 'marriedFilingJointly'){
    return new Set(['client', 'spouse', 'joint']);
  }
  if(filingStatus === 'marriedFilingSeparately'){
    const owner = current?.returnScope?.modeledTaxpayer;
    return new Set(owner === 'client' || owner === 'spouse' ? [owner] : []);
  }
  return new Set(['client']);
}

function validFraction(value, fallback){
  const selected = value == null ? fallback : value;
  return typeof selected === 'number'
    && Number.isFinite(selected)
    && selected >= 0
    && selected <= 1
    ? selected
    : null;
}

function planningIncomeOverrideSet(current){
  return new Set(
    Array.isArray(current?.planningIncomeOverrides)
      ? current.planningIncomeOverrides.filter(groupId =>
          INCOME_OVERRIDE_GROUPS.has(groupId))
      : [],
  );
}

export function validatePlanningIncomeOverrides(current){
  if(!hasOwn(current, 'planningIncomeOverrides')) return;
  const raw = current.planningIncomeOverrides;
  if(!Array.isArray(raw)){
    throw wizardTaxError(
      'Current-year income source selections need review',
      'planningIncomeOverrides',
      'CURRENT_1040_INCOME_OVERRIDE_GROUPS_INVALID',
    );
  }
  const seen = new Set();
  for(const groupId of raw){
    if(!INCOME_OVERRIDE_GROUPS.has(groupId) || seen.has(groupId)){
      throw wizardTaxError(
        'Current-year income source selections need review',
        'planningIncomeOverrides',
        'CURRENT_1040_INCOME_OVERRIDE_GROUP_INVALID',
      );
    }
    seen.add(groupId);
  }
}

function setPlanningIncomeOverrides(current, overrides){
  const selected = CURRENT_1040_INCOME_SOURCE_GROUP_IDS
    .filter(groupId => overrides.has(groupId));
  if(selected.length > 0) current.planningIncomeOverrides = selected;
  else delete current.planningIncomeOverrides;
}

function emptyPlanningIncomeGroup(group){
  return {
    id: group.id,
    rowIds: [],
    values: Object.fromEntries(group.fields.map(field => [field, 0])),
    invalid: false,
    overridden: false,
    rowSourced: false,
  };
}

function addPlanningValue(group, field, amount){
  group.values[field] = (group.values[field] || 0) + amount;
}

export function readWizardPlanningIncome(
  plan,
  current = plan.incomeTax?.current1040,
){
  const groups = Object.fromEntries(
    CURRENT_1040_INCOME_SOURCE_GROUPS.map(group => [
      group.id,
      emptyPlanningIncomeGroup(group),
    ]),
  );
  const overrides = planningIncomeOverrideSet(current);
  const owners = activeReturnOwners(plan, current);
  let hasActivePlanningSocialSecurity = false;
  let hasNonzeroShortTermCapitalGain = false;

  for(const raw of plan.income?.other || []){
    if(!isSourceActiveNow(plan, raw)) continue;
    const source = normalizedIncomeSource(plan, raw);
    if(!owners.has(source.owner)) continue;
    if(source.typeId === 'social_security'){
      hasActivePlanningSocialSecurity ||= Number(source.amount) !== 0;
      continue;
    }
    if(source.typeId === 'short_term_capital_gain'){
      hasNonzeroShortTermCapitalGain ||= Number(source.amount) !== 0;
      continue;
    }
    const descriptor = current1040IncomeSourceGroup(source.typeId);
    if(!descriptor) continue;
    const group = groups[descriptor.id];
    group.rowIds.push(raw.id || null);

    if(source.typeId === 'wages' || source.typeId === 'bonus'){
      addPlanningValue(group, 'wages', source.amount);
    }else if(source.typeId === 'interest'){
      const taxablePct = validFraction(raw.taxablePct, 1);
      if(taxablePct === null){
        group.invalid = true;
      }else{
        addPlanningValue(group, 'taxableInterest', source.amount * taxablePct);
        addPlanningValue(group, 'taxExemptInterest', source.amount * (1 - taxablePct));
      }
    }else if(source.typeId === 'tax_exempt_interest'){
      addPlanningValue(group, 'taxExemptInterest', source.amount);
    }else if(source.typeId === 'dividends'){
      const qualifiedPct = validFraction(raw.qualifiedPct, 0);
      if(qualifiedPct === null){
        group.invalid = true;
      }else{
        addPlanningValue(group, 'ordinaryDividends', source.amount);
        addPlanningValue(group, 'qualifiedDividends', source.amount * qualifiedPct);
      }
    }else if(source.typeId === 'ira_distribution'){
      const taxablePct = validFraction(raw.taxablePct, 1);
      if(taxablePct === null){
        group.invalid = true;
      }else{
        addPlanningValue(group, 'iraDistributions', source.amount);
        addPlanningValue(group, 'taxableIra', source.amount * taxablePct);
      }
    }else if(source.typeId === 'roth_conversion'){
      addPlanningValue(group, 'rothConversion', source.amount);
    }else if(source.typeId === 'pension' || source.typeId === 'annuity'){
      const taxablePct = validFraction(raw.taxablePct, 1);
      if(taxablePct === null){
        group.invalid = true;
      }else{
        addPlanningValue(group, 'pensionAmount', source.amount);
        addPlanningValue(group, 'taxablePensions', source.amount * taxablePct);
      }
    }else if(source.typeId === 'long_term_capital_gain'){
      group.values.netLongTermGainOrLoss =
        (group.values.netLongTermGainOrLoss || 0) + source.amount;
    }else{
      const taxablePct = validFraction(raw.taxablePct, 1);
      if(taxablePct === null){
        group.invalid = true;
      }else{
        addPlanningValue(group, 'otherIncome', source.amount * taxablePct);
      }
    }
  }

  const socialSecurity = plan.income?.socialSecurity || {};
  const activeBenefits = [
    ['client', plan.household?.primary, socialSecurity.primary],
    ['spouse', plan.household?.spouse, socialSecurity.spouse],
  ];
  hasActivePlanningSocialSecurity ||= activeBenefits.some(
    ([owner, person, benefit]) =>
      owners.has(owner)
      && person
      && benefit
      && Number(benefit.pia) > 0
      && Number(person.currentAge) >= Number(benefit.claimAge ?? 67),
  );

  for(const group of Object.values(groups)){
    group.overridden = overrides.has(group.id);
    group.rowSourced = group.rowIds.length > 0 && !group.overridden;
    Object.freeze(group.rowIds);
    Object.freeze(group.values);
    Object.freeze(group);
  }
  return Object.freeze({
    groups: Object.freeze(groups),
    hasActivePlanningSocialSecurity,
    hasNonzeroShortTermCapitalGain,
  });
}

function sourceGroup(groupId){
  const group = CURRENT_1040_INCOME_SOURCE_GROUPS
    .find(candidate => candidate.id === groupId);
  if(!group){
    throw wizardTaxError(
      'Unsupported current-year income source',
      'planningIncomeOverrides',
      'CURRENT_1040_INCOME_OVERRIDE_GROUP_INVALID',
    );
  }
  return group;
}

function assertPlanningGroupCanOverride(group){
  if(group.rowIds.length === 0){
    throw wizardTaxError(
      'No planning income is available for this tax item',
      `income.${group.id}`,
      'CURRENT_1040_INCOME_OVERRIDE_SOURCE_REQUIRED',
    );
  }
  if(group.invalid){
    throw wizardTaxError(
      'Review the planning income rows before using this amount',
      `income.${group.id}`,
      'CURRENT_1040_INCOME_OVERRIDE_SOURCE_INVALID',
    );
  }
}

function copyPlanningGroupToCurrent(current, descriptor, group){
  if(descriptor.id === 'long-term-gain-loss'){
    current.scheduleD = {
      mode: 'manual-net-long-term',
      netLongTermGainOrLoss: group.values.netLongTermGainOrLoss || 0,
    };
    return;
  }
  for(const field of descriptor.fields){
    current.income[field] = group.values[field] || 0;
  }
}

function removeCurrentGroupValues(current, descriptor){
  if(descriptor.id === 'long-term-gain-loss'){
    current.scheduleD = { mode: 'manual-net-long-term' };
    return;
  }
  for(const field of descriptor.fields){
    delete current.income[field];
  }
}

export function overrideWizardIncomeGroup(plan, groupId){
  const current = ensureWizardCurrent1040(plan);
  validatePlanningIncomeOverrides(current);
  const descriptor = sourceGroup(groupId);
  const planning = readWizardPlanningIncome(plan, current);
  const group = planning.groups[groupId];
  assertPlanningGroupCanOverride(group);

  const overrides = planningIncomeOverrideSet(current);
  overrides.add(groupId);
  copyPlanningGroupToCurrent(current, descriptor, group);
  setPlanningIncomeOverrides(current, overrides);
  current.incomeSourcesComplete = false;
  return current;
}

export function revertWizardIncomeGroup(plan, groupId){
  const current = ensureWizardCurrent1040(plan);
  validatePlanningIncomeOverrides(current);
  const descriptor = sourceGroup(groupId);
  const overrides = planningIncomeOverrideSet(current);
  if(!overrides.has(groupId)){
    throw wizardTaxError(
      'This tax item is already using planning income',
      `income.${groupId}`,
      'CURRENT_1040_INCOME_OVERRIDE_NOT_SELECTED',
    );
  }

  removeCurrentGroupValues(current, descriptor);
  overrides.delete(groupId);
  setPlanningIncomeOverrides(current, overrides);
  current.incomeSourcesComplete = false;
  return current;
}

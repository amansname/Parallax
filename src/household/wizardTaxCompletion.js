import {
  resolveLawVersionForTaxYear,
  validateClient1040Intake,
} from '../tax/annual1040.js';
import { buildCurrent1040Intake } from '../planning/tax/buildCurrent1040Intake.js';
import {
  CURRENT_1040_INCOME_SOURCE_GROUPS,
} from './incomeTaxModel.js';
import { ensureWizardCurrent1040 } from './wizardCurrent1040.js';
import {
  readWizardPlanningIncome,
  validatePlanningIncomeOverrides,
} from './wizardPlanningIncome.js';
import { SCHEDULE_2_FIELDS } from './wizardTaxMutations.js';
import {
  cloneWizardValue,
  hasOwn,
  wizardTaxError,
} from './wizardIntakeSupport.js';

const COMPLETION_PASS_THROUGH_FIELDS =
  Object.freeze(['line17', 'line19', 'line20']);
const SIMPLE_SCHEDULE_D_CONFIRMATIONS = Object.freeze([
  'shortTermNetIsZero',
  'noCapitalLossCarryovers',
  'line18NotApplicable',
  'line19NotApplicable',
  'form4952Line4gIsZeroOrNotApplicable',
]);
const ITEMIZED_COMPLETION_FIELDS = Object.freeze([
  'medicalExpensesPaid',
  'mortgageInterestDeductible',
  'charitableContributionsDeductible',
  'otherItemizedDeductions',
]);

function normalizedWizardField(path){
  return String(path || '')
    .replace(/^incomeTax\.current1040\./, '')
    .replace(/^intake\./, '');
}

function missingWizardFact(message, field, code){
  throw wizardTaxError(message, normalizedWizardField(field), code);
}

function groupDirectFields(current, descriptor){
  if(descriptor.id === 'long-term-gain-loss'){
    return hasOwn(current.scheduleD, 'netLongTermGainOrLoss')
      ? ['scheduleD.netLongTermGainOrLoss']
      : [];
  }
  return descriptor.fields
    .filter(field => hasOwn(current.income, field));
}

function ensureIncomeCompletionFacts(current, planning, { materialize }){
  for(const descriptor of CURRENT_1040_INCOME_SOURCE_GROUPS){
    if(descriptor.id === 'long-term-gain-loss') continue;
    const group = planning.groups[descriptor.id];
    if(group.invalid){
      missingWizardFact(
        'Review the planning income rows before confirming Tax',
        `income.${descriptor.fields[0]}`,
        'CURRENT_1040_INCOME_OVERRIDE_SOURCE_INVALID',
      );
    }
    const directFields = groupDirectFields(current, descriptor);
    if(group.rowSourced){
      const conflictingFields = directFields
        .filter(field => current.income[field] !== 0);
      if(conflictingFields.length > 0){
        missingWizardFact(
          'Choose planning income or a current-year amount for this tax item',
          `income.${descriptor.fields[0]}`,
          'CURRENT_1040_INCOME_SOURCE_CONFLICT',
        );
      }
      if(materialize){
        for(const field of directFields) delete current.income[field];
      }
      continue;
    }
    for(const field of descriptor.fields){
      if(hasOwn(current.income, field)) continue;
      if(materialize) current.income[field] = 0;
      else{
        missingWizardFact(
          'Confirm the Tax page again after changing income facts',
          `income.${field}`,
          'CURRENT_1040_COMPLETION_FACT_MISSING',
        );
      }
    }
  }
}

function ensureSocialSecurityCompletion(current, { materialize }){
  const income = current.income;
  const socialSecurity = income.socialSecurity;
  const mode = socialSecurity?.mode;
  if(mode === undefined){
    if(materialize){
      if(!hasOwn(income, 'socialSecurityBenefits')) income.socialSecurityBenefits = 0;
      if(!hasOwn(income, 'taxableSS')) income.taxableSS = 0;
      income.socialSecurity = { mode: 'supplied-form1040-lines' };
      return;
    }
    missingWizardFact(
      'Confirm the Tax page again after changing Social Security facts',
      'income.socialSecurityBenefits',
      'CURRENT_1040_COMPLETION_FACT_MISSING',
    );
  }
  if(!hasOwn(income, 'socialSecurityBenefits')){
    if(materialize) income.socialSecurityBenefits = 0;
    else{
      missingWizardFact(
        'Enter current-year Social Security benefits, including 0 when none',
        'income.socialSecurityBenefits',
        'MISSING_SOCIAL_SECURITY_GROSS_BENEFITS',
      );
    }
  }
  if(mode === 'supplied-form1040-lines' && !hasOwn(income, 'taxableSS')){
    if(materialize) income.taxableSS = 0;
    else{
      missingWizardFact(
        'Enter taxable Social Security, including 0 when none is taxable',
        'income.taxableSS',
        'MISSING_SOCIAL_SECURITY_TAXABLE_BENEFITS',
      );
    }
  }
}

function ensureScheduleDCompletion(current, planning, { materialize }){
  const group = planning.groups['long-term-gain-loss'];
  if(group.invalid){
    missingWizardFact(
      'Review the planning long-term gain or loss rows before confirming Tax',
      'scheduleD.netLongTermGainOrLoss',
      'CURRENT_1040_INCOME_OVERRIDE_SOURCE_INVALID',
    );
  }
  if(planning.hasNonzeroShortTermCapitalGain){
    missingWizardFact(
      'A nonzero short-term gain or loss cannot use this long-term-only field',
      'scheduleD.netLongTermGainOrLoss',
      'CURRENT_1040_MANUAL_NET_LONG_TERM_SHORT_TERM_CONFLICT',
    );
  }
  if(group.rowSourced){
    if(current.scheduleD?.mode === 'manual-net-long-term'
        && current.scheduleD.netLongTermGainOrLoss === 0){
      if(materialize) delete current.scheduleD.netLongTermGainOrLoss;
      return;
    }
    if(!current.scheduleD && materialize){
      current.scheduleD = { mode: 'manual-net-long-term' };
      return;
    }
    if(current.scheduleD?.mode === 'manual-net-long-term'
        && !hasOwn(current.scheduleD, 'netLongTermGainOrLoss')){
      return;
    }
    missingWizardFact(
      'Choose planning income or a current-year long-term amount',
      'scheduleD.netLongTermGainOrLoss',
      'CURRENT_1040_SCHEDULE_D_SOURCE_CONFLICT',
    );
  }

  let scheduleD = current.scheduleD;
  if(!scheduleD
      || !hasOwn(scheduleD, 'netLongTermGainOrLoss')){
    if(materialize){
      if(!scheduleD || typeof scheduleD !== 'object' || Array.isArray(scheduleD)){
        current.scheduleD = {
          mode: 'manual-net-long-term',
          netLongTermGainOrLoss: 0,
        };
      }else{
        scheduleD.mode = scheduleD.mode || 'manual-net-long-term';
        scheduleD.netLongTermGainOrLoss = 0;
        current.scheduleD = scheduleD;
      }
      scheduleD = current.scheduleD;
    }else{
      missingWizardFact(
        'Enter 0 when there is no long-term capital gain or loss',
        'scheduleD.netLongTermGainOrLoss',
        'CURRENT_1040_SCHEDULE_D_AMOUNT_REQUIRED',
      );
    }
  }
  if(typeof scheduleD.netLongTermGainOrLoss !== 'number'
      || !Number.isFinite(scheduleD.netLongTermGainOrLoss)){
    missingWizardFact(
      'Enter a valid long-term capital gain or loss',
      'scheduleD.netLongTermGainOrLoss',
      'INVALID_SCHEDULE_D_AMOUNT',
    );
  }
  if(scheduleD.mode === 'manual-net-long-term') return;
  if(scheduleD.mode === 'simple-net-long-term'
      && SIMPLE_SCHEDULE_D_CONFIRMATIONS.every(
        key => scheduleD.confirmations?.[key] === true)){
    return;
  }
  missingWizardFact(
    'This Tax page requires the manual long-term gain or loss source',
    'scheduleD.netLongTermGainOrLoss',
    'CURRENT_1040_SCHEDULE_D_SOURCE_CONFLICT',
  );
}

function ensureZeroCompletionFact(target, field, path, { materialize }){
  if(hasOwn(target, field)) return;
  if(materialize){
    target[field] = 0;
    return;
  }
  missingWizardFact(
    'Confirm the Tax page again after changing deductions',
    path,
    'CURRENT_1040_COMPLETION_FACT_MISSING',
  );
}

function ensureCompletionObject(parent, field, path, { materialize }){
  if(parent[field]) return parent[field];
  if(!materialize){
    missingWizardFact(
      'Confirm the Tax page again after changing deductions',
      path,
      'CURRENT_1040_COMPLETION_FACT_MISSING',
    );
  }
  parent[field] = {};
  return parent[field];
}

function ensureDeductionCompletion(current, options){
  const deductions = current.deductions;
  if(deductions.source === 'supplied-line12e'){
    ensureZeroCompletionFact(
      deductions, 'line12e', 'deductions.line12e', options,
    );
    return;
  }
  if(deductions.method !== 'itemized'
      || deductions.source !== 'calculated') return;

  const itemized = ensureCompletionObject(
    deductions,
    'itemized',
    'deductions.itemized.medicalExpensesPaid',
    options,
  );
  for(const field of ITEMIZED_COMPLETION_FIELDS){
    ensureZeroCompletionFact(
      itemized, field, `deductions.itemized.${field}`, options,
    );
  }
  const salt = ensureCompletionObject(
    itemized,
    'salt',
    'deductions.itemized.salt.eligibleTaxesPaid',
    options,
  );
  ensureZeroCompletionFact(
    salt,
    'eligibleTaxesPaid',
    'deductions.itemized.salt.eligibleTaxesPaid',
    options,
  );
  if(!salt.magi){
    if(!options.materialize){
      missingWizardFact(
        'Confirm the Tax page again after changing deductions',
        'deductions.itemized.salt.magi',
        'CURRENT_1040_COMPLETION_FACT_MISSING',
      );
    }
    salt.magi = { mode: 'supplied-magi', amount: 0 };
  }
}

function ensureAdditionalCompletionFacts(current, { materialize }){
  if(!current.adjustments){
    if(materialize){
      current.adjustments = { mode: 'supplied-line10', amount: 0 };
    }else{
      missingWizardFact(
        'Confirm the Tax page again after changing adjustments',
        'adjustments.line10',
        'CURRENT_1040_COMPLETION_FACT_MISSING',
      );
    }
  }
  if(!hasOwn(current.deductions, 'qbi')){
    if(materialize) current.deductions.qbi = 0;
    else{
      missingWizardFact(
        'Confirm the Tax page again after changing deductions',
        'deductions.qbi',
        'CURRENT_1040_COMPLETION_FACT_MISSING',
      );
    }
  }
  if(!current.deductions.schedule1A){
    if(materialize){
      current.deductions.schedule1A = {
        mode: 'supplied-line13b',
        amount: 0,
      };
    }else{
      missingWizardFact(
        'Confirm the Tax page again after changing deductions',
        'deductions.line13b',
        'CURRENT_1040_COMPLETION_FACT_MISSING',
      );
    }
  }
  if(!current.passThrough || typeof current.passThrough !== 'object'){
    if(materialize) current.passThrough = {};
    else{
      missingWizardFact(
        'Confirm the Tax page again after changing optional tax lines',
        'passThrough.line17',
        'CURRENT_1040_COMPLETION_FACT_MISSING',
      );
    }
  }
  for(const field of COMPLETION_PASS_THROUGH_FIELDS){
    if(hasOwn(current.passThrough, field)) continue;
    if(materialize) current.passThrough[field] = 0;
    else{
      missingWizardFact(
        'Confirm the Tax page again after changing optional tax lines',
        `passThrough.${field}`,
        'CURRENT_1040_COMPLETION_FACT_MISSING',
      );
    }
  }

  const schedule2OwnsLine23 = hasOwn(current, 'schedule2')
    || hasOwn(current, 'scheduleSE');
  if(schedule2OwnsLine23){
    if(hasOwn(current.passThrough, 'line23')){
      missingWizardFact(
        'Choose supplied line 23 or Schedule 2 components, not both',
        'passThrough.line23',
        'SCHEDULE_2_SOURCE_CONFLICT',
      );
    }
    if(!current.schedule2 || typeof current.schedule2 !== 'object'){
      if(materialize) current.schedule2 = {};
      else{
        missingWizardFact(
          'Confirm the Tax page again after changing Schedule 2',
          'schedule2.netInvestmentIncomeTax',
          'CURRENT_1040_COMPLETION_FACT_MISSING',
        );
      }
    }
    for(const field of SCHEDULE_2_FIELDS){
      if(hasOwn(current.schedule2, field)) continue;
      if(materialize) current.schedule2[field] = 0;
      else{
        missingWizardFact(
          'Confirm the Tax page again after changing Schedule 2',
          `schedule2.${field}`,
          'CURRENT_1040_COMPLETION_FACT_MISSING',
        );
      }
    }
    return;
  }
  if(!hasOwn(current.passThrough, 'line23')){
    if(materialize) current.passThrough.line23 = 0;
    else{
      missingWizardFact(
        'Confirm the Tax page again after changing optional tax lines',
        'passThrough.line23',
        'CURRENT_1040_COMPLETION_FACT_MISSING',
      );
    }
  }
}

function assertCanonicalWizardCompletion(plan){
  const built = buildCurrent1040Intake(plan);
  if(built.gaps.length > 0){
    const gap = built.gaps[0];
    missingWizardFact(gap.message, gap.path, gap.code);
  }
  const taxYear = built.intake.taxYear;
  const validation = validateClient1040Intake(built.intake, {
    taxYear,
    lawVersion: resolveLawVersionForTaxYear(taxYear),
  });
  if(validation.errors.length > 0){
    const error = validation.errors[0];
    missingWizardFact(
      error.message,
      error.path || 'tax',
      error.code || 'CURRENT_1040_VALIDATION_FAILED',
    );
  }
}

function ensureWizardTaxCompletion(plan, { materialize }){
  const current = ensureWizardCurrent1040(plan);
  validatePlanningIncomeOverrides(current);
  const planning = readWizardPlanningIncome(plan, current);
  ensureIncomeCompletionFacts(current, planning, { materialize });
  ensureSocialSecurityCompletion(current, { materialize });
  ensureScheduleDCompletion(current, planning, { materialize });
  ensureDeductionCompletion(current, { materialize });
  ensureAdditionalCompletionFacts(current, { materialize });
  return current;
}

export function confirmWizardTaxInputs(plan){
  const current = ensureWizardTaxCompletion(plan, { materialize: true });
  current.incomeSourcesComplete = true;
  assertCanonicalWizardCompletion(plan);
  return current;
}

export function clearWizardTaxConfirmation(plan){
  const current = ensureWizardCurrent1040(plan);
  current.incomeSourcesComplete = false;
  return current;
}

export function invalidateWizardTaxCompletion(plan){
  const current = plan.incomeTax?.current1040;
  if(current && typeof current === 'object' && !Array.isArray(current)){
    current.incomeSourcesComplete = false;
  }
}

export function isWizardTaxComplete(plan){
  const candidate = cloneWizardValue(plan);
  const current = candidate.incomeTax?.current1040;
  if(!current || current.incomeSourcesComplete !== true) return false;
  try{
    ensureWizardTaxCompletion(candidate, { materialize: false });
    assertCanonicalWizardCompletion(candidate);
    return true;
  }catch{
    return false;
  }
}

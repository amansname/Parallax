import { accountDisplayTreatment, getAccountTypeById } from '../src/household/accountTypes.js';
import { renderHouseholdWizardFamily } from './householdWizardFamily.js';
import { renderHouseholdWizardNetWorth } from './householdWizardNetWorth.js';
import { renderHouseholdWizardTax } from './householdWizardTax.js';
import { renderHouseholdWizardSummary } from './householdWizardSummary.js';
import { escHtml } from './dom.js';

export const HOUSEHOLD_WIZARD_STEPS = Object.freeze([
  Object.freeze({ id: 'family', number: 1, label: 'Family' }),
  Object.freeze({ id: 'net-worth', number: 2, label: 'Net Worth' }),
  Object.freeze({ id: 'tax', number: 3, label: 'Tax' }),
  Object.freeze({ id: 'summary', number: 4, label: 'Summary' }),
]);

function money(value){
  const amount = Math.round(Number(value) || 0);
  const sign = amount < 0 ? '−' : '';
  return `${sign}$${Math.abs(amount).toLocaleString('en-US')}`;
}

function fieldValue(value){
  if(value === undefined || value === null || value === '') return '';
  return escHtml(String(value));
}

function optionList(options, selected){
  return options.map(option => {
    const [value, label] = Array.isArray(option)
      ? option
      : [option.value ?? option.typeId, option.label];
    return `<option value="${escHtml(String(value))}" ${value === selected ? 'selected' : ''}>${escHtml(String(label))}</option>`;
  }).join('');
}

function ageFor(plan, owner){
  const person = owner === 'spouse'
    ? plan.household?.spouse
    : plan.household?.primary;
  return Number.isFinite(person?.currentAge) ? person.currentAge : null;
}

function accountBasis(plan, account){
  const entry = getAccountTypeById(account.typeId);
  if(!entry){
    return { editable: false, value: null, label: 'Basis unavailable', placeholder: '—' };
  }
  if(entry.taxCharacter === 'capital_asset'){
    return {
      editable: true,
      value: account.basis?.amount,
      label: 'Reported cost basis',
      placeholder: 'Cost basis',
    };
  }
  if(entry.taxCharacter === 'traditional_ira'){
    return {
      editable: account.owner === 'client' || account.owner === 'spouse',
      value: plan.taxProfiles?.[account.owner]?.traditionalIra
        ?.priorYearCarryforwardBasis?.value,
      label: 'Owner-level after-tax IRA basis',
      placeholder: 'After-tax basis',
    };
  }
  if(entry.taxCharacter === 'roth_ira'){
    return {
      editable: account.owner === 'client' || account.owner === 'spouse',
      value: plan.taxProfiles?.[account.owner]?.rothIra?.contributionBasis?.value,
      label: 'Owner-level Roth contribution basis',
      placeholder: 'Contribution basis',
    };
  }
  if(entry.taxCharacter === 'employer_pretax'){
    return {
      editable: true,
      value: account.employerPlanFacts?.afterTaxContributionBasis?.value,
      label: 'After-tax contribution basis',
      placeholder: 'After-tax basis',
    };
  }
  if(entry.taxCharacter === 'designated_roth'){
    return {
      editable: true,
      value: account.designatedRothFacts?.contributionBasis?.value,
      label: 'Designated Roth contribution basis',
      placeholder: 'Contribution basis',
    };
  }
  return {
    editable: false,
    value: null,
    label: 'Basis is not entered for this account type',
    placeholder: '—',
  };
}

export function createHouseholdWizard(dependencies){
  const renderers = {
    family: renderHouseholdWizardFamily,
    'net-worth': renderHouseholdWizardNetWorth,
    tax: renderHouseholdWizardTax,
    summary: renderHouseholdWizardSummary,
  };

  function context(){
    const plan = dependencies.plan;
    const taxState = dependencies.taxState();
    return {
      plan,
      uiState: dependencies.uiState,
      esc: escHtml,
      fieldValue,
      optionList,
      money,
      states: dependencies.states,
      accountTypes: dependencies.accountTypes,
      accountTreatment: accountDisplayTreatment,
      accountBasis: account => accountBasis(plan, account),
      ageFor: owner => ageFor(plan, owner),
      taxBucketSnapshot: dependencies.taxBucketSnapshot(),
      taxSummary: dependencies.incomeTaxSummary(),
      current: taxState.current,
      deductionMode: taxState.deductionMode,
      planningIncome: taxState.planningIncome,
      taxView: dependencies.uiState.taxView,
      optionalItems: dependencies.uiState.optionalTaxItems,
      optionalMenuOpen: dependencies.uiState.optionalMenuOpen,
    };
  }

  function render(stepId){
    const renderer = renderers[stepId] || renderers.family;
    return renderer(context());
  }

  function footer(stepId){
    const index = HOUSEHOLD_WIZARD_STEPS.findIndex(step => step.id === stepId);
    const isFirst = index <= 0;
    const isLast = index === HOUSEHOLD_WIZARD_STEPS.length - 1;
    return `
      <button type="button" class="hh-footer-back" data-hh-action="step-back"
        ${isFirst ? 'disabled' : ''}>Back</button>
      <div class="hh-footer-progress">Step ${index + 1} of ${HOUSEHOLD_WIZARD_STEPS.length}</div>
      <button type="button" class="hh-footer-next" data-hh-action="step-next">
        ${isLast ? 'Enter planning' : 'Continue'}
      </button>
    `;
  }

  return { render, footer };
}

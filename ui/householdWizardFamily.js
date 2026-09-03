import { renderBirthDateField } from './birthDateField.js';

export function renderHouseholdWizardFamily(ctx){
  const {
    plan,
    uiState,
    esc,
    fieldValue,
    moneyFieldValue,
    optionList,
    states,
    ageFor,
    financeSourceTypes,
  } = ctx;
  const filingStatus = plan.meta?.filingStatus || 'single';
  const supportedFilingStatus = [
    'marriedFilingJointly',
    'single',
    'headOfHousehold',
  ].includes(filingStatus);
  const hasSpouse = filingStatus === 'marriedFilingJointly' || Boolean(plan.household?.spouse);

  const savedFinanceAmount = (owner, mode, typeId) => {
    if(mode === 'income' && typeId === 'social_security'){
      const key = owner === 'spouse' ? 'spouse' : 'primary';
      return plan.income?.socialSecurity?.[key]?.pia;
    }
    const rows = mode === 'income'
      ? plan.income?.other
      : plan.savings?.entries;
    return (Array.isArray(rows) ? rows : []).find(
      row => row?.owner === owner && row?.typeId === typeId,
    )?.amount;
  };

  const financePanel = owner => {
    if(uiState.financeOwner !== owner) return '';
    const mode = uiState.financeMode;
    const selectedTypeId = uiState.financeTypeId;
    const types = financeSourceTypes(mode);
    const selectedType = types.find(type => type.id === selectedTypeId) || null;
    const selectedAmount = selectedType
      ? savedFinanceAmount(owner, mode, selectedType.id)
      : null;
    const ownerName = owner === 'spouse'
      ? plan.meta?.spouseName || 'Co-client'
      : plan.meta?.primaryName || 'Client';
    return `
      <aside class="hh-finance-entry" id="hh-finance-entry-${owner}"
        data-finance-entry-panel data-finance-owner="${owner}"
        aria-label="Add income or savings for ${esc(ownerName)}">
        <div class="hh-finance-mode" role="group" aria-label="Entry type">
          ${['savings', 'income'].map(candidate => `
            <button type="button" class="${candidate === mode ? 'is-active' : ''}"
              data-hh-action="set-finance-mode" data-finance-mode="${candidate}"
              aria-pressed="${candidate === mode ? 'true' : 'false'}">
              ${candidate === 'savings' ? 'Savings' : 'Income'}
            </button>
          `).join('')}
        </div>
        <div class="hh-finance-source-list" role="group"
          aria-label="${mode === 'savings' ? 'Savings types' : 'Income sources'}">
          ${types.map(type => `
            <button type="button"
              class="${type.id === selectedTypeId ? 'is-selected' : ''}"
              data-hh-action="select-finance-source" data-finance-type-id="${esc(type.id)}"
              aria-pressed="${type.id === selectedTypeId ? 'true' : 'false'}">
              ${esc(type.label)}
            </button>
          `).join('')}
        </div>
        ${selectedType ? `
          <div class="hh-finance-amount-row">
            <span aria-hidden="true">$</span>
            <input type="text" inputmode="decimal" autocomplete="off"
              data-finance-amount aria-label="${esc(selectedType.label)} annual amount"
              value="${moneyFieldValue(selectedAmount)}"
              placeholder="0">
            <span aria-hidden="true">/yr</span>
            <button type="button" data-hh-action="commit-finance-entry"
              aria-label="Add ${esc(selectedType.label)}">↵</button>
          </div>
        ` : ''}
      </aside>
    `;
  };

  const personCard = (owner, label) => {
    const nameField = owner === 'client' ? 'primaryName' : 'spouseName';
    const name = plan.meta?.[nameField] || '';
    const person = owner === 'client'
      ? plan.household?.primary || {}
      : plan.household?.spouse || {};
    const ssKey = owner === 'client' ? 'primary' : 'spouse';
    const birthDate = plan.taxProfiles?.[owner]?.birthDate?.value || '';
    const age = ageFor(owner);
    const status = person.employmentStatus || 'employed';
    const financeOpen = uiState.financeOwner === owner;
    return `
      <section class="hh-person-card${financeOpen ? ' is-finance-open' : ''}"
        data-person-owner="${owner}">
        <div class="hh-card-head">
          <button type="button" class="hh-finance-person-trigger"
            data-hh-action="toggle-finance-entry" data-finance-owner="${owner}"
            aria-expanded="${financeOpen ? 'true' : 'false'}"
            aria-controls="hh-finance-entry-${owner}">
            <span>${esc(name || label)}</span>
            <small>${esc(label)} · ${age == null ? 'Age —' : `Age ${esc(age)}`}</small>
          </button>
          ${owner === 'spouse' ? `
            <button type="button" class="hh-card-action"
              data-hh-action="remove-spouse">Remove co-client</button>
          ` : ''}
        </div>
        ${financePanel(owner)}
        <div class="hh-person-fields">
          <label class="hh-field hh-field--wide">
            <span>Legal name</span>
            <input type="text" value="${esc(name)}"
              data-hh-field="${owner}.legalName"
              data-wizard-scope="family" data-wizard-field="${nameField}">
          </label>
          <label class="hh-field hh-field--date">
            <span>Date of birth</span>
            ${renderBirthDateField({ owner, iso: birthDate, esc })}
          </label>
          <div class="hh-field hh-field--age">
            <span>Age</span>
            <output data-hh-age="${owner}">${age == null ? '—' : esc(age)}</output>
          </div>
          <label class="hh-field">
            <span>Status</span>
            <select data-hh-field="${owner}.status"
              data-wizard-scope="family" data-wizard-field="${owner}.status">
              ${optionList([
                ['employed', 'Employed'],
                ['self-employed', 'Self-employed'],
                ['retired', 'Retired'],
              ], status)}
            </select>
          </label>
          <label class="hh-field">
            <span>Retires at</span>
            <input type="number" min="45" max="90" value="${fieldValue(person.retirementAge)}"
              data-hh-field="${owner}.retirementAge"
              data-wizard-scope="family" data-wizard-field="${owner}.retirementAge">
          </label>
          <label class="hh-field">
            <span>Social Security at</span>
            <input type="number" min="62" max="70"
              value="${fieldValue(plan.income?.socialSecurity?.[ssKey]?.claimAge)}"
              data-hh-field="${owner}.socialSecurityAge"
              data-wizard-scope="family" data-wizard-field="${owner}.socialSecurityAge">
          </label>
          <label class="hh-field">
            <span>Live to age</span>
            <input type="number" min="45" max="125" value="${fieldValue(person.planEndAge)}"
              data-hh-field="${owner}.planEndAge"
              data-wizard-scope="family" data-wizard-field="${owner}.planEndAge">
          </label>
          <label class="hh-field hh-field--social-security-benefit">
            <span>Annual Social Security at full retirement age</span>
            <input type="text" inputmode="decimal"
              value="${moneyFieldValue(plan.income?.socialSecurity?.[ssKey]?.pia)}"
              data-hh-field="${owner}.socialSecurityBenefit"
              data-wizard-scope="family" data-wizard-field="${owner}.socialSecurityBenefit">
          </label>
        </div>
      </section>
    `;
  };

  return `
    <div class="hh-screen hh-family-screen" data-hh-wizard-screen="family"
      id="hh-panel-family" role="tabpanel" aria-labelledby="hh-nav-family">
      <header class="hh-screen-intro">
        <span class="t-eyebrow">Step 01</span>
      </header>
      <div class="hh-family-people${hasSpouse ? '' : ' is-single'}">
        ${personCard('client', 'Client')}
        ${hasSpouse ? personCard('spouse', 'Co-client') : ''}
      </div>

      <section class="hh-form-section">
        <div class="hh-family-filing">
          <label class="hh-field">
            <span>Filing status</span>
            <select data-hh-field="filingStatus"
              data-wizard-scope="family" data-wizard-field="filingStatus">
              ${supportedFilingStatus ? '' : `
                <option value="${esc(filingStatus)}" selected disabled>
                  Unsupported saved filing status · choose a supported status
                </option>
              `}
              ${optionList([
                ['marriedFilingJointly', 'Married filing jointly'],
                ['single', 'Single'],
                ['headOfHousehold', 'Head of household'],
              ], filingStatus)}
            </select>
          </label>
          <label class="hh-field">
            <span>State of residence</span>
            <select data-hh-field="state"
              data-wizard-scope="family" data-wizard-field="state">
              ${optionList(states, plan.meta?.state || 'VA')}
            </select>
          </label>
        </div>
      </section>
    </div>
  `;
}

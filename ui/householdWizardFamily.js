import { renderBirthDateField } from './birthDateField.js';

export function renderHouseholdWizardFamily(ctx){
  const {
    plan,
    uiState,
    esc,
    fieldValue,
    moneyFieldValue,
    money,
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
    const selectedAmountValue = moneyFieldValue(selectedAmount);
    const ownerName = owner === 'spouse'
      ? plan.meta?.spouseName || 'Co-client'
      : plan.meta?.primaryName || 'Client';
    return `
      <section class="hh-finance-entry" id="hh-finance-entry-${owner}"
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
        <div class="hh-finance-source-select" data-finance-source-select>
          <span>${selectedType
            ? esc(selectedType.label)
            : mode === 'savings' ? 'Select savings type' : 'Select income source'}</span>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 4.25 6 7.75l3.5-3.5" />
          </svg>
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
              value="${selectedAmountValue}"
              size="${Math.max(1, selectedAmountValue.length)}"
              placeholder="0">
            <span aria-hidden="true">/yr</span>
            <button type="button" data-hh-action="commit-finance-entry"
              aria-label="Add ${esc(selectedType.label)}">↵</button>
          </div>
        ` : ''}
      </section>
    `;
  };

  const railPerson = (owner, label) => {
    const nameField = owner === 'client' ? 'primaryName' : 'spouseName';
    const name = plan.meta?.[nameField] || label;
    const age = ageFor(owner);
    const selected = uiState.financeOwner === owner;
    return `
      <button type="button" class="hh-finances-person${selected ? ' is-selected' : ''}"
        data-hh-action="toggle-finance-entry" data-finances-person-owner="${owner}"
        data-finance-owner="${owner}" aria-pressed="${selected ? 'true' : 'false'}">
        <span class="hh-finances-avatar" aria-hidden="true"></span>
        <span class="hh-finances-person-copy">
          <strong class="hh-finances-person-name">${esc(name)}</strong>
          <small>${esc(label)} · ${age == null ? 'Age —' : `Age ${esc(age)}`}</small>
        </span>
        <span class="hh-finances-person-check" aria-hidden="true">
          <svg viewBox="0 0 14 14"><path d="m2.5 7 3 3 6-7" /></svg>
        </span>
      </button>
    `;
  };

  const financesRail = () => {
    const open = uiState.financeRailOpen === true;
    const ownerAvailable = uiState.financeOwner === 'client'
      || (uiState.financeOwner === 'spouse' && hasSpouse);
    const hasOwner = open && ownerAvailable;
    return `
      <aside class="hh-finances-rail${open ? ' is-open' : ''}${hasOwner ? ' has-owner' : ''}"
        data-finances-rail aria-label="Savings and Income">
        <header class="hh-finances-rail-head">
          <span>Savings and Income</span>
          <button type="button" class="hh-finances-rail-toggle"
            data-hh-action="toggle-finances-rail" aria-expanded="${open ? 'true' : 'false'}"
            aria-controls="hh-finances-rail-body"
            aria-label="${open ? 'Collapse' : 'Expand'} Savings and Income rail">
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="${open ? 'M2.5 8.5 7 4l4.5 4.5' : 'M2.5 5.5 7 10l4.5-4.5'}" />
            </svg>
          </button>
        </header>
        <div class="hh-finances-rail-body" id="hh-finances-rail-body" ${open ? '' : 'hidden'}>
          <div class="hh-finances-people">
            ${open ? railPerson('client', 'Primary') : ''}
            ${open && hasSpouse ? railPerson('spouse', 'Spouse') : ''}
          </div>
          <div class="hh-finances-control">
            ${hasOwner ? financePanel(uiState.financeOwner) : ''}
          </div>
          <div class="hh-finances-summary" data-finances-summary>
            <span>Savings</span>
            <strong>${money(plan.savings?.annual)}/yr</strong>
          </div>
        </div>
      </aside>
    `;
  };

  const personCard = owner => {
    const nameField = owner === 'client' ? 'primaryName' : 'spouseName';
    const name = plan.meta?.[nameField] || '';
    const person = owner === 'client'
      ? plan.household?.primary || {}
      : plan.household?.spouse || {};
    const ssKey = owner === 'client' ? 'primary' : 'spouse';
    const birthDate = plan.taxProfiles?.[owner]?.birthDate?.value || '';
    const age = ageFor(owner);
    const status = person.employmentStatus || 'employed';
    return `
      <section class="hh-person-card" data-person-owner="${owner}">
        ${owner === 'spouse' ? `
          <button type="button" class="hh-card-action"
            data-hh-action="remove-spouse">Remove co-client</button>
        ` : ''}
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
            <span>Social Security</span>
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
      ${financesRail()}
      <div class="hh-family-people${hasSpouse ? '' : ' is-single'}">
        ${personCard('client')}
        ${hasSpouse ? personCard('spouse') : ''}
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
          <label class="hh-field hh-field--children">
            <span>Children?</span>
            <input type="number" min="0" max="20"
              value="${fieldValue(plan.household?.dependentsCount)}"
              data-hh-field="dependents"
              data-wizard-scope="family" data-wizard-field="dependents">
          </label>
        </div>
      </section>
    </div>
  `;
}

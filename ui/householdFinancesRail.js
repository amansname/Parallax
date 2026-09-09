import { renderSavingsHistory, renderSavingsReplacement } from './householdSavingsReview.js';

export function renderHouseholdFinancesRail(ctx){
  const { plan, uiState, esc, moneyFieldValue, money, ageFor, financeSourceTypes } = ctx;
  const hasSpouse = plan.meta?.filingStatus === 'marriedFilingJointly' || Boolean(plan.household?.spouse);

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
    const draft = uiState.financeDraft;
    const selectedAmountValue = draft?.owner === owner && draft.mode === mode && draft.typeId === selectedTypeId
      ? esc(draft.amount) : moneyFieldValue(selectedAmount);
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
        <p class="hh-finance-source-heading" data-finance-source-select>
          <span>${selectedType
            ? esc(selectedType.label)
            : mode === 'savings' ? 'Select savings type' : 'Select income source'}</span>
        </p>
        <div class="hh-finance-source-list" role="group"
          ${uiState.financePending ? 'hidden' : ''}
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
        ${selectedType && uiState.financePending ? renderSavingsReplacement({
          pending: uiState.financePending, ownerName, typeLabel: selectedType.label, money, esc,
        }) : selectedType ? `
          <div class="hh-finance-amount-row">
            <span aria-hidden="true">$</span>
            <input type="text" inputmode="decimal" autocomplete="off"
              data-finance-amount aria-label="${esc(selectedType.label)} annual amount"
              value="${selectedAmountValue}"
              size="${Math.max(1, selectedAmountValue.length)}"
              placeholder="0">
            <span aria-hidden="true">/yr</span>
            <button type="button" data-hh-action="commit-finance-entry"
              aria-label="Save ${esc(selectedType.label)}">↵</button>
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
        data-finance-owner="${owner}" aria-pressed="${selected ? 'true' : 'false'}"
        aria-expanded="${selected ? 'true' : 'false'}" aria-controls="hh-finances-entry-content">
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
          <div class="hh-finances-control" id="hh-finances-entry-content">
            ${hasOwner ? financePanel(uiState.financeOwner) : uiState.financeSaveStatus === true ? `
              <p class="hh-finances-save-status" data-finance-save-status
                role="status" aria-live="polite" aria-atomic="true">
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  <path d="m2.5 7 3 3 6-7" />
                </svg>
                <span class="hh-sr-only">Saved to plan</span>
              </p>
            ` : ''}
          </div>
          <div class="hh-finances-summary" data-finances-summary>
            <span>Savings</span>
            <strong>${money(plan.savings?.annual)}/yr</strong>
          </div>
          ${renderSavingsHistory(plan, money)}
        </div>
      </aside>
    `;
  };

  return financesRail();
}

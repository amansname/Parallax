export function renderHouseholdWizardNetWorth(ctx){
  const {
    plan,
    esc,
    fieldValue,
    money,
    accountTypes,
    accountTreatment,
    accountBasis,
    taxBucketSnapshot,
    uiState,
  } = ctx;
  const accounts = plan.portfolio?.extraAccounts || [];
  const typeOptions = accountTypes.map(type =>
    `<option value="${esc(type.typeId)}">${esc(type.label)}</option>`
  ).join('');

  const ownerOptions = (typeId, selected) => {
    const type = accountTypes.find(item => item.typeId === typeId);
    const allowed = type?.owners || ['client', 'spouse'];
    const labels = {
      client: plan.meta?.primaryName || 'Client',
      spouse: plan.meta?.spouseName || 'Co-client',
      joint: 'Joint',
    };
    return allowed.map(owner =>
      `<option value="${owner}" ${owner === selected ? 'selected' : ''}>${esc(labels[owner])}</option>`
    ).join('');
  };

  const rows = accounts.map(account => {
    const treatment = accountTreatment(account.typeId);
    const basis = accountBasis(account);
    return `
      <div class="hh-account-row" data-account-id="${esc(account.id)}">
        <label class="hh-cell hh-cell--name">
          <span class="hh-sr-only">Account name</span>
          <input type="text" value="${esc(account.displayName || '')}"
            placeholder="${esc(account.type || 'Account')}"
            data-hh-field="account.${esc(account.id)}.displayName"
            data-account-field="displayName" data-account-id="${esc(account.id)}">
        </label>
        <label class="hh-cell hh-cell--type">
          <span class="hh-sr-only">Account type</span>
          <select data-hh-field="account.${esc(account.id)}.typeId"
            data-account-field="typeId" data-account-id="${esc(account.id)}">
            ${accountTypes.map(type =>
              `<option value="${esc(type.typeId)}" ${type.typeId === account.typeId ? 'selected' : ''}>${esc(type.label)}</option>`
            ).join('')}
          </select>
        </label>
        <label class="hh-cell hh-cell--owner">
          <span class="hh-sr-only">Owner</span>
          <select data-hh-field="account.${esc(account.id)}.owner"
            data-account-field="owner" data-account-id="${esc(account.id)}">
            ${ownerOptions(account.typeId, account.owner)}
          </select>
        </label>
        <div class="hh-cell hh-cell--treatment" data-derived-treatment="${esc(account.id)}">
          <span class="hh-treatment-dot" style="--treatment-color:${esc(treatment.color)}"></span>
          ${esc(treatment.label)}
        </div>
        <label class="hh-cell hh-cell--amount">
          <span class="hh-sr-only">Balance</span>
          <input type="text" inputmode="decimal" value="${fieldValue(account.balance)}"
            data-hh-field="account.${esc(account.id)}.balance"
            data-account-field="balance" data-account-id="${esc(account.id)}">
        </label>
        <label class="hh-cell hh-cell--basis${basis.editable ? '' : ' is-disabled'}">
          <span class="hh-sr-only">${esc(basis.label)}</span>
          <input type="text" inputmode="decimal" value="${fieldValue(basis.value)}"
            placeholder="${esc(basis.placeholder)}" ${basis.editable ? '' : 'disabled'}
            aria-label="${esc(basis.label)}"
            data-hh-field="account.${esc(account.id)}.basis"
            data-account-field="basis" data-account-id="${esc(account.id)}">
        </label>
        <button class="hh-row-remove" type="button"
          data-hh-action="remove-account" data-account-id="${esc(account.id)}"
          aria-label="Remove ${esc(account.displayName || account.type || 'account')}">Remove</button>
      </div>
    `;
  }).join('');

  const addForm = uiState.accountFormOpen ? `
    <div class="hh-account-add-form" data-hh-account-add-form>
      <label class="hh-field">
        <span>Account name</span>
        <input type="text" value="${esc(uiState.accountDraft.displayName || '')}"
          data-account-draft="displayName" placeholder="e.g. Joint brokerage">
      </label>
      <label class="hh-field">
        <span>Type</span>
        <select data-account-draft="typeId">
          <option value="">Choose account type</option>
          ${typeOptions}
        </select>
      </label>
      <label class="hh-field">
        <span>Owner</span>
        <select data-account-draft="owner">
          <option value="client">${esc(plan.meta?.primaryName || 'Client')}</option>
          ${plan.household?.spouse ? `<option value="spouse">${esc(plan.meta?.spouseName || 'Co-client')}</option>` : ''}
          <option value="joint">Joint</option>
        </select>
      </label>
      <label class="hh-field">
        <span>Balance</span>
        <input type="text" inputmode="decimal" value="${esc(uiState.accountDraft.balance || '')}"
          data-account-draft="balance" placeholder="0">
      </label>
      <div class="hh-account-add-actions">
        <button type="button" class="hh-button hh-button--quiet" data-hh-action="cancel-account">Cancel</button>
        <button type="button" class="hh-button hh-button--gold" data-hh-action="save-account">Add account</button>
      </div>
    </div>
  ` : `
    <button type="button" class="hh-add-row" data-hh-action="add-account">+ Add another account</button>
  `;

  const buckets = taxBucketSnapshot.buckets;
  return `
    <div class="hh-screen hh-net-worth-screen" data-hh-wizard-screen="net-worth"
      id="hh-panel-net-worth" role="tabpanel" aria-labelledby="hh-nav-net-worth">
      <header class="hh-screen-head">
        <div>
          <div class="hh-step-kicker">Step 02</div>
          <h1>Net Worth</h1>
        </div>
        <div class="hh-screen-count">${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}</div>
      </header>

      <div class="hh-account-table">
        <div class="hh-account-head" aria-hidden="true">
          <span>Account</span><span>Type</span><span>Owner</span>
          <span>Tax treatment</span><span class="is-right">Balance</span>
          <span class="is-right">Basis</span><span></span>
        </div>
        <div class="hh-account-rows">
          ${rows || `<div class="hh-empty-row">No accounts entered yet.</div>`}
        </div>
      </div>
      ${addForm}

      <div class="hh-bucket-totals" aria-label="Portfolio by tax treatment">
        ${['taxable', 'traditional', 'roth'].map(key => `
          <div class="hh-bucket-total" data-bucket="${key}">
            <span>${esc(buckets[key].label)}</span>
            <strong>${money(buckets[key].balance)}</strong>
            <small>${buckets[key].accountCount} ${buckets[key].accountCount === 1 ? 'account' : 'accounts'}</small>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

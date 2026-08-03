export function renderHouseholdWizardNetWorth(ctx){
  const {
    plan,
    esc,
    moneyFieldValue,
    money,
    accountTypes,
    accountTreatment,
    accountBasis,
    taxBucketSnapshot,
    uiState,
  } = ctx;
  const accounts = plan.portfolio?.extraAccounts || [];
  const visibleAccountTypes = accountTypes.filter(type => type.typeId !== 'joint_brokerage');
  const visibleTypeId = typeId => typeId === 'joint_brokerage'
    ? 'brokerage_taxable'
    : typeId;
  const typeOptions = visibleAccountTypes.map(type =>
    `<option value="${esc(type.typeId)}">${esc(type.label)}</option>`
  ).join('');

  const ownerOptions = (typeId, selected) => {
    const type = visibleAccountTypes.find(item => item.typeId === visibleTypeId(typeId));
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
    const selectedTypeId = visibleTypeId(account.typeId);
    return `
      <div class="hh-account-row" data-account-id="${esc(account.id)}">
        <div class="hh-cell hh-cell--type">
          <label>
            <span class="hh-sr-only">Account type</span>
            <select data-hh-field="account.${esc(account.id)}.typeId"
              data-account-field="typeId" data-account-id="${esc(account.id)}">
              ${visibleAccountTypes.map(type =>
                `<option value="${esc(type.typeId)}" ${type.typeId === selectedTypeId ? 'selected' : ''}>${esc(type.label)}</option>`
              ).join('')}
            </select>
          </label>
          <span class="hh-account-meta" data-derived-treatment="${esc(account.id)}">
            <span class="hh-treatment-dot" style="--treatment-color:${esc(treatment.color)}"></span>
            ${esc(treatment.label)}
          </span>
        </div>
        <label class="hh-cell hh-cell--owner">
          <span class="hh-sr-only">Account owner</span>
          <select data-hh-field="account.${esc(account.id)}.owner"
            data-account-field="owner" data-account-id="${esc(account.id)}">
            ${ownerOptions(selectedTypeId, account.owner)}
          </select>
        </label>
        <div class="hh-cell hh-cell--amount">
          <label>
            <span class="hh-sr-only">Balance</span>
            <input type="text" inputmode="decimal" value="${moneyFieldValue(account.balance)}"
              data-hh-field="account.${esc(account.id)}.balance"
              data-account-field="balance" data-account-id="${esc(account.id)}">
          </label>
          ${basis.editable ? `
            <label class="hh-account-basis">
              <span>${esc(basis.label)}</span>
              <input type="text" inputmode="decimal" value="${moneyFieldValue(basis.value)}"
                placeholder="${esc(basis.placeholder)}" aria-label="${esc(basis.label)}"
                data-hh-field="account.${esc(account.id)}.basis"
                data-account-field="basis" data-account-id="${esc(account.id)}">
            </label>
          ` : ''}
        </div>
        <button class="hh-row-remove" type="button"
          data-hh-action="remove-account" data-account-id="${esc(account.id)}"
          aria-label="Remove ${esc(account.type || 'account')}">Remove</button>
      </div>
    `;
  }).join('');

  const addForm = uiState.accountFormOpen ? `
    <div class="hh-account-add-form" data-hh-account-add-form>
      <label class="hh-field">
        <span>Account type</span>
        <select data-account-draft="typeId">
          <option value="">Choose account type</option>
          ${typeOptions}
        </select>
      </label>
      <label class="hh-field">
        <span>Account owner</span>
        <select data-account-draft="owner">
          <option value="client">${esc(plan.meta?.primaryName || 'Client')}</option>
          ${plan.household?.spouse ? `<option value="spouse">${esc(plan.meta?.spouseName || 'Co-client')}</option>` : ''}
          <option value="joint">Joint</option>
        </select>
      </label>
      <label class="hh-field">
        <span>Balance</span>
        <input type="text" inputmode="decimal" value="${moneyFieldValue(uiState.accountDraft.balance)}"
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
          <span>Account type</span><span>Account owner</span>
          <span class="is-right">Balance</span><span></span>
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

import { getAccountTypeById } from '../src/household/accountTypes.js';
import { NET_WORTH_ONLY_TREATMENT } from '../src/household/netWorthRecords.js';

const ALL_OWNERS = Object.freeze(['client', 'spouse', 'joint']);
const BANK_TYPE_IDS = new Set([
  'checking',
  'savings',
  'money_market',
  'certificate_of_deposit',
]);

const CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'bank',
    label: 'Bank',
    group: 'Assets',
    icon: 'M3 9.6 12 4.2l9 5.4M5.4 10.4v7.8M9.8 10.4v7.8M14.2 10.4v7.8M18.6 10.4v7.8M3.4 19.4h17.2',
    types: Object.freeze([
      Object.freeze({ label: 'Checking', accountTypeId: 'checking', owners: ALL_OWNERS, canonicalTax: 'Taxable' }),
      Object.freeze({ label: 'Savings', accountTypeId: 'savings', owners: ALL_OWNERS, canonicalTax: 'Taxable' }),
      Object.freeze({ label: 'Money Market', accountTypeId: 'money_market', owners: ALL_OWNERS, canonicalTax: 'Taxable' }),
      Object.freeze({ label: 'CD', accountTypeId: 'certificate_of_deposit', owners: ALL_OWNERS, canonicalTax: 'Taxable' }),
    ]),
  }),
  Object.freeze({
    id: 'investment',
    label: 'Investment',
    group: 'Assets',
    icon: 'M4 19.2h16M7.2 16.2V9.4M12 16.2V5.2M16.8 16.2v-4.6',
    chips: 6,
    types: Object.freeze([
      Object.freeze({ label: 'TOD Brokerage', accountTypeId: 'tod_brokerage', owners: Object.freeze(['client', 'spouse']), canonicalTax: 'Taxable' }),
      Object.freeze({ label: 'Joint Brokerage', accountTypeId: 'joint_brokerage', owners: Object.freeze(['joint']), canonicalTax: 'Taxable' }),
      Object.freeze({ label: 'Traditional IRA', accountTypeId: 'traditional_ira', owners: Object.freeze(['client', 'spouse']), canonicalTax: 'Tax-Deferred' }),
      Object.freeze({ label: 'Rollover IRA', accountTypeId: 'rollover_ira', owners: Object.freeze(['client', 'spouse']), canonicalTax: 'Tax-Deferred' }),
      Object.freeze({ label: 'Roth IRA', accountTypeId: 'roth_ira', owners: Object.freeze(['client', 'spouse']), canonicalTax: 'Tax-Free' }),
      Object.freeze({ label: '401(k)', accountTypeId: '401k', owners: Object.freeze(['client', 'spouse']), canonicalTax: 'Tax-Deferred' }),
      Object.freeze({ label: 'Trust', owners: ALL_OWNERS, canonicalTax: 'Taxable', shellOnly: true }),
      Object.freeze({ label: 'Roth 401(k)', accountTypeId: 'roth_401k', owners: Object.freeze(['client', 'spouse']), canonicalTax: 'Tax-Free' }),
    ]),
  }),
  Object.freeze({
    id: 'property',
    label: 'Property',
    group: 'Assets',
    icon: 'M3.8 11.2 12 4.2l8.2 7M6.2 10v9.4h11.6V10M10 19.4v-4.8h4v4.8',
    types: Object.freeze([
      Object.freeze({ label: 'Primary Residence', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Second Home', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Investment Property', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Land', owners: ALL_OWNERS }),
    ]),
  }),
  Object.freeze({
    id: 'insurance',
    label: 'Insurance',
    group: 'Assets',
    icon: 'M12 3.6 5.2 6.2v5.6c0 4.2 3 7.4 6.8 8.8 3.8-1.4 6.8-4.6 6.8-8.8V6.2z',
    chips: 3,
    shellOnly: true,
    types: Object.freeze([
      Object.freeze({ label: 'Whole Life', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Universal Life', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Long-Term Care', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Variable Life', owners: ALL_OWNERS }),
    ]),
  }),
  Object.freeze({
    id: 'card',
    label: 'Credit Card',
    group: 'Liabilities',
    icon: 'M3.4 7h17.2v10H3.4zM3.4 11h17.2M6.8 14.4h3.6',
    shellOnly: true,
    types: Object.freeze([
      Object.freeze({ label: 'Revolving', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Charge Card', owners: ALL_OWNERS }),
    ]),
  }),
  Object.freeze({
    id: 'mortgage',
    label: 'Mortgage',
    group: 'Liabilities',
    icon: 'M6 3.6h8.2L18 7.4v13H6zM14.2 3.6v3.8H18M9 13h6M9 16.6h4',
    link: true,
    types: Object.freeze([
      Object.freeze({ label: 'Primary Residence', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Second Home', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Investment Property', owners: ALL_OWNERS }),
      Object.freeze({ label: 'HELOC', owners: ALL_OWNERS }),
    ]),
  }),
  Object.freeze({
    id: 'loan',
    label: 'Loan',
    group: 'Liabilities',
    icon: 'M12 4.2v15.6M8.2 8.2h6a2.1 2.1 0 0 1 0 4.2H9.6a2.1 2.1 0 0 0 0 4.2h7',
    shellOnly: true,
    types: Object.freeze([
      Object.freeze({ label: 'Auto', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Student', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Personal', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Margin', owners: ALL_OWNERS }),
      Object.freeze({ label: 'Securities-Based', owners: ALL_OWNERS }),
    ]),
  }),
]);

const DESIGN_LABEL_BY_ACCOUNT_TYPE = Object.freeze({
  checking: 'Checking',
  savings: 'Savings',
  money_market: 'Money Market',
  certificate_of_deposit: 'CD',
  tod_brokerage: 'TOD Brokerage',
  joint_brokerage: 'Joint Brokerage',
  traditional_ira: 'Traditional IRA',
  rollover_ira: 'Rollover IRA',
  roth_ira: 'Roth IRA',
  '401k': '401(k)',
  roth_401k: 'Roth 401(k)',
});

const TAX_LABELS = Object.freeze({
  Taxable: 'Taxable',
  'Tax-deferred': 'Tax-Deferred',
  'Tax-free': 'Tax-Free',
  Roth: 'Tax-Free',
});

function number(value){
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function icon(path, className = ''){
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" aria-hidden="true"
    stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
    <path d="${path}"></path>
  </svg>`;
}

function closeIcon(){
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <path d="M18 6 6 18M6 6l12 12"></path>
  </svg>`;
}

function ownerLabel(owner){
  if(owner === 'client') return 'Client';
  if(owner === 'spouse') return 'Spouse';
  if(owner === 'joint') return 'Joint';
  if(owner === 'trust') return 'Trust';
  return '';
}

function treatmentLabel(value){
  return TAX_LABELS[value] || value || '';
}

function categoryForAccount(account){
  return BANK_TYPE_IDS.has(account?.typeId) ? 'bank' : 'investment';
}

function displayTypeForAccount(account){
  return DESIGN_LABEL_BY_ACCOUNT_TYPE[account?.typeId]
    || getAccountTypeById(account?.typeId)?.label
    || account?.type
    || '';
}

function renderSavedRow(entry, esc){
  const scope = entry.projectionTreatment === NET_WORTH_ONLY_TREATMENT
    ? 'Net worth only · not projected'
    : '';
  const meta = [entry.type, entry.owner, entry.tax, entry.link, scope]
    .filter(Boolean)
    .join(' · ');
  const sourceAttrs = entry.source === 'account'
    ? `data-entry-source="account" data-account-id="${esc(entry.id)}"`
    : entry.source === 'property'
      ? `data-entry-source="property" data-property-index="${entry.index}"`
      : entry.source === 'mortgage'
        ? `data-entry-source="mortgage" data-property-index="${entry.index}"`
        : `data-entry-source="shell" data-shell-id="${esc(entry.id)}"`;
  return `
    <div class="nw-saved-row">
      <div class="nw-saved-copy">
        <div class="nw-saved-name">${esc(entry.name || '—')}</div>
        <div class="nw-saved-meta">${esc(meta || '—')}</div>
      </div>
      <div class="nw-saved-actions">
        <span>${esc(entry.value || '—')}</span>
        <button type="button" class="nw-icon-button nw-remove-entry"
          data-hh-action="net-worth-remove-entry" ${sourceAttrs}
          aria-label="Remove ${esc(entry.name || entry.type || 'entry')}">${closeIcon()}</button>
      </div>
    </div>
  `;
}

function ownersForPlan(owners, plan){
  const configured = owners || ALL_OWNERS;
  return plan.household?.spouse
    ? configured
    : configured.filter(owner => owner !== 'spouse');
}

function renderTypeButton(type, category, plan, esc){
  const owners = ownersForPlan(type.owners, plan);
  return `
    <button type="button" class="nw-type-chip" data-hh-action="net-worth-pick-type"
      data-category-id="${category.id}" data-type-label="${esc(type.label)}"
      data-account-type-id="${esc(type.accountTypeId || '')}"
      data-canonical-tax="${esc(type.canonicalTax || '')}"
      data-shell-only="${type.shellOnly || category.shellOnly ? 'true' : 'false'}"
      data-owners="${owners.join(',')}">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
        stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M12 5v14M5 12h14"></path>
      </svg>
      ${esc(type.label)}
    </button>
  `;
}

function renderPanel({ category, entries, draft, moreOpen, plan, mortgageMeta, esc }){
  if(!category) return '';
  const selected = Boolean(draft && (draft.type || draft.custom));
  const chips = category.chips || 4;
  const topTypes = category.types.slice(0, chips);
  const restTypes = category.types.slice(chips);
  const owners = ownersForPlan(
    Array.isArray(draft?.owners) && draft.owners.length ? draft.owners : ALL_OWNERS,
    plan,
  );
  const propertyChoices = (plan.properties || []).map((property, index) => {
    const name = String(property?.name || '').trim() || `Property ${index + 1}`;
    const available = number(property?.mortgage?.balance) === 0
      && mortgageMeta[index]?.present !== true;
    return { index: String(index), name, available };
  });
  const eligibleProperties = propertyChoices.filter(property => property.available);
  const draftLink = draft?.link == null ? '' : String(draft.link);
  const resolvedLink = category.id === 'mortgage'
      && draftLink === ''
      && eligibleProperties.length === 1
    ? eligibleProperties[0].index
    : draftLink;
  const resolvedProperty = propertyChoices.find(property => property.index === resolvedLink);
  const resolvedLinkAvailable = Boolean(resolvedProperty?.available);
  const propertyOptions = propertyChoices.map(property => `
    <option value="${property.index}"
      data-net-worth-link-available="${property.available ? 'true' : 'false'}"
      ${property.available ? '' : 'disabled'}
      ${property.index === resolvedLink ? 'selected' : ''}>${esc(property.name)}</option>
  `).join('');

  const picker = !selected ? `
    <div class="nw-type-picker">
      ${topTypes.map(type => renderTypeButton(type, category, plan, esc)).join('')}
      <button type="button" class="nw-type-chip nw-type-chip--more"
        data-hh-action="net-worth-toggle-more">
        More
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"></path>
        </svg>
      </button>
      ${moreOpen ? `
        <div class="nw-more-menu">
          ${restTypes.map(type => `
            <button type="button" data-hh-action="net-worth-pick-type"
              data-category-id="${category.id}" data-type-label="${esc(type.label)}"
              data-account-type-id="${esc(type.accountTypeId || '')}"
              data-canonical-tax="${esc(type.canonicalTax || '')}"
              data-shell-only="${type.shellOnly || category.shellOnly ? 'true' : 'false'}"
              data-owners="${ownersForPlan(type.owners, plan).join(',')}">${esc(type.label)}</button>
          `).join('')}
          ${restTypes.length ? '<div class="nw-more-rule"></div>' : ''}
          <button type="button" class="nw-type-own"
            data-hh-action="net-worth-pick-custom" data-category-id="${category.id}">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
              stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4z"></path>
            </svg>
            Type your own
          </button>
        </div>
      ` : ''}
    </div>
  ` : '';

  const form = selected ? `
    <div class="nw-form">
      <div class="nw-type-selection">
        ${draft.custom
          ? `<input type="text" value="${esc(draft.type || '')}"
              data-net-worth-draft="type">`
          : `<span>${esc(draft.type)}</span>`}
        <button type="button" class="nw-icon-button" data-hh-action="net-worth-clear-type"
          aria-label="Clear selected type">${closeIcon()}</button>
      </div>
      <div class="nw-form-grid">
        <label class="nw-field nw-field--wide">
          <span>Institution</span>
          <input type="text" value="${esc(draft.name || '')}"
            data-net-worth-draft="name">
        </label>
        <label class="nw-field">
          <span>Ownership</span>
          <select data-net-worth-draft="owner">
            <option value=""></option>
            ${owners.map(owner => `<option value="${owner}" ${draft.owner === owner ? 'selected' : ''}>${ownerLabel(owner)}</option>`).join('')}
          </select>
        </label>
        ${category.link ? `
          <label class="nw-field">
            <span>Property</span>
            <select data-net-worth-draft="link">
              <option value=""></option>
              ${propertyOptions}
            </select>
          </label>
        ` : ''}
        <label class="nw-field">
          <span>Value</span>
          <input type="text" inputmode="decimal" value="${esc(draft.value || '$')}"
            data-net-worth-draft="value">
        </label>
      </div>
    </div>
  ` : '';

  const ownerRequired = selected
    && (category.id === 'bank' || category.id === 'investment')
    && Boolean(draft.accountTypeId)
    && draft.shellOnly !== true;
  const ownerValid = !ownerRequired || owners.includes(draft.owner);
  const linkRequired = category.id === 'mortgage';
  const saveDisabled = !ownerValid || (linkRequired && !resolvedLinkAvailable);

  return `
    <div class="nw-overlay" data-net-worth-overlay>
      <div class="nw-scrim" data-hh-action="net-worth-close-panel"></div>
      <aside class="nw-panel" aria-label="${esc(category.label)}"
        data-net-worth-category-id="${category.id}">
        <div class="nw-sheet-grabber" aria-hidden="true"></div>
        <header class="nw-panel-head">
          <div>${icon(category.icon, 'nw-panel-icon')}<h2>${esc(category.label)}</h2></div>
          <button type="button" class="nw-icon-button nw-panel-close"
            data-hh-action="net-worth-close-panel" aria-label="Close">${closeIcon()}</button>
        </header>
        <div class="nw-panel-body">
          ${entries.map(entry => renderSavedRow(entry, esc)).join('')}
          ${form}
          ${picker}
        </div>
        <footer class="nw-panel-footer">
          ${selected ? `
            <button type="button" class="nw-secondary-button"
              data-hh-action="net-worth-cancel-draft">Cancel</button>
            <button type="button" class="nw-primary-button"
              data-hh-action="net-worth-save-entry"
              data-net-worth-resolved-link="${esc(resolvedLink)}"
              data-net-worth-resolved-link-label="${esc(resolvedProperty?.name || '')}"
              data-net-worth-resolved-link-available="${resolvedLinkAvailable ? 'true' : 'false'}"
              data-net-worth-owner-required="${ownerRequired ? 'true' : 'false'}"
              data-net-worth-link-required="${linkRequired ? 'true' : 'false'}"
              ${saveDisabled ? 'disabled' : ''}>Save</button>
          ` : `
            <button type="button" class="nw-primary-button"
              data-hh-action="net-worth-close-panel">Done</button>
          `}
        </footer>
      </aside>
    </div>
  `;
}

export function renderHouseholdWizardNetWorth(ctx){
  const {
    plan,
    esc,
    money,
    accountTreatment,
    taxBucketSnapshot,
    uiState,
  } = ctx;
  const accounts = plan.portfolio?.extraAccounts || [];
  const properties = plan.properties || [];
  const shellEntries = plan.netWorth?.shellEntries || [];
  const mortgageMeta = properties.map(property =>
    property?.mortgage?.netWorthMeta || {});
  const entriesByCategory = Object.fromEntries(CATEGORIES.map(category => [category.id, []]));

  for(const account of accounts){
    const treatment = treatmentLabel(accountTreatment(account.typeId)?.label);
    const categoryId = categoryForAccount(account);
    entriesByCategory[categoryId].push({
      source: 'account',
      id: account.id,
      name: account.displayName,
      type: displayTypeForAccount(account),
      owner: ownerLabel(account.owner),
      tax: categoryId === 'investment' ? treatment : '',
      value: money(account.balance),
    });
  }

  properties.forEach((property, index) => {
    const meta = property?.netWorthMeta || {};
    entriesByCategory.property.push({
      source: 'property',
      index,
      name: property?.name,
      type: meta.type || '',
      owner: ownerLabel(meta.owner),
      value: money(property?.value || 0),
    });
    const balance = number(property?.mortgage?.balance);
    const mortgage = mortgageMeta[index] || {};
    if(balance > 0 || mortgage.present){
      entriesByCategory.mortgage.push({
        source: 'mortgage',
        index,
        name: mortgage.name || '',
        type: mortgage.type || '',
        owner: ownerLabel(mortgage.owner),
        link: property?.name || `Property ${index + 1}`,
        value: money(balance),
      });
    }
  });

  for(const entry of shellEntries){
    if(!entriesByCategory[entry.categoryId]) continue;
    entriesByCategory[entry.categoryId].push({
      source: 'shell',
      id: entry.id,
      name: entry.name,
      type: entry.type,
      owner: ownerLabel(entry.owner),
      tax: entry.tax || '',
      value: money(entry.value),
      projectionTreatment: entry.projectionTreatment,
    });
  }

  const shellTotals = Object.fromEntries(CATEGORIES.map(category => [category.id, 0]));
  for(const entry of shellEntries){
    if(entry?.categoryId in shellTotals){
      shellTotals[entry.categoryId] += number(entry.value);
    }
  }
  const canonicalBankTotal = accounts
    .filter(account => BANK_TYPE_IDS.has(account.typeId))
    .reduce((sum, account) => sum + number(account.balance), 0);
  const portfolioTotal = number(taxBucketSnapshot.totalBalance);
  const canonicalInvestmentTotal = Math.max(0, portfolioTotal - canonicalBankTotal);
  const canonicalPropertyTotal = properties
    .reduce((sum, property) => sum + number(property?.value), 0);
  const canonicalMortgageTotal = properties
    .reduce((sum, property) => sum + number(property?.mortgage?.balance), 0);
  const basePortfolioTotal = Object.values(plan.portfolio?.accounts || {})
    .reduce((sum, sleeve) => sum + number(sleeve?.balance), 0);
  const categoryAmounts = {
    bank: canonicalBankTotal + shellTotals.bank,
    investment: canonicalInvestmentTotal + shellTotals.investment,
    property: canonicalPropertyTotal + shellTotals.property,
    insurance: shellTotals.insurance,
    card: shellTotals.card,
    mortgage: canonicalMortgageTotal + shellTotals.mortgage,
    loan: shellTotals.loan,
  };
  const presence = Object.fromEntries(CATEGORIES.map(category => [
    category.id,
    entriesByCategory[category.id].length > 0
      || (category.id === 'investment' && basePortfolioTotal > 0),
  ]));
  const assetTotal = CATEGORIES
    .filter(category => category.group === 'Assets')
    .reduce((sum, category) => sum + number(categoryAmounts[category.id]), 0);
  const liabilityTotal = CATEGORIES
    .filter(category => category.group === 'Liabilities')
    .reduce((sum, category) => sum + number(categoryAmounts[category.id]), 0);
  const netWorthTotal = assetTotal - liabilityTotal;
  const hasWiredData = Object.values(presence).some(Boolean);
  const amountForCategory = categoryId =>
    presence[categoryId] ? money(categoryAmounts[categoryId]) : '—';
  const groups = ['Assets', 'Liabilities'].map(label => ({
    label,
    categories: CATEGORIES.filter(category => category.group === label),
  }));

  const tiles = groups.map(group => `
    <section class="nw-group">
      <h2>${group.label}</h2>
      <div class="nw-tile-grid">
        ${group.categories.map(category => {
          const hasEntries = presence[category.id];
          return `
            <button type="button" class="nw-tile ${hasEntries ? 'has-entries' : ''}"
              data-hh-action="net-worth-open-category" data-category-id="${category.id}">
              <span class="nw-tile-top">
                ${icon(category.icon, 'nw-tile-icon')}
                ${hasEntries ? '<span class="nw-tile-dot"></span>' : ''}
              </span>
              <span class="nw-tile-copy">
                <strong>${category.label}</strong>
                <span>${amountForCategory(category.id)}</span>
              </span>
            </button>
          `;
        }).join('')}
      </div>
    </section>
  `).join('');

  const entryView = `
    <div class="nw-entry-view">
      <main class="nw-grid-region">${tiles}</main>
      <aside class="nw-rail" aria-label="Net worth total">
        <span class="nw-total-label">Net Worth</span>
        <strong>${hasWiredData ? money(netWorthTotal) : '—'}</strong>
        <div class="nw-rail-actions">
          <button type="button" class="nw-primary-button" data-hh-action="step-next">Continue</button>
          <button type="button" class="nw-secondary-button" data-hh-action="step-back">Back</button>
        </div>
      </aside>
    </div>
  `;

  const activeCategory = CATEGORIES.find(category =>
    category.id === uiState.netWorthPanelCategory) || null;
  return `
    <div class="hh-screen nw-workflow" data-hh-wizard-screen="net-worth"
      id="hh-panel-net-worth" role="tabpanel" aria-labelledby="hh-nav-net-worth">
      ${entryView}
      ${renderPanel({
        category: activeCategory,
        entries: activeCategory ? entriesByCategory[activeCategory.id] : [],
        draft: uiState.netWorthDraft,
        moreOpen: uiState.netWorthMoreOpen,
        plan,
        mortgageMeta,
        esc,
      })}
    </div>
  `;
}

function pctValue(value, fieldValue){
  return value === null || value === undefined || value === ''
    ? ''
    : fieldValue(Number(value) * 100);
}

export function renderHouseholdWizardIncome(ctx){
  const {
    plan,
    esc,
    fieldValue,
    moneyFieldValue,
    optionList,
    incomeSourceTypes,
  } = ctx;
  const hasSpouse = Boolean(plan.household?.spouse);
  const socialSecurity = plan.income?.socialSecurity || {};
  const sources = Array.isArray(plan.income?.other) ? plan.income.other : [];
  const pension = plan.income?.pension || {};
  const benefitByAge = pension.benefitByAge && typeof pension.benefitByAge === 'object'
    ? pension.benefitByAge
    : {};
  const savings = plan.savings || {};
  const split = savings.split || {};
  const hasSleeveEntry = ['traditional', 'roth', 'taxable']
    .some(key => Object.prototype.hasOwnProperty.call(split, key));
  const effectiveSplit = {
    traditional: hasSleeveEntry ? Number(split.traditional ?? 0) : 1,
    roth: hasSleeveEntry ? Number(split.roth ?? 0) : 0,
    taxable: hasSleeveEntry ? Number(split.taxable ?? 0) : 0,
  };
  const sleeveTotal = Object.values(effectiveSplit)
    .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const sleeveValid = Math.abs(sleeveTotal - 1) <= 1e-9;
  const byOwner = split.byOwner && typeof split.byOwner === 'object'
    ? split.byOwner
    : null;
  const hasOwnerEntry = ['client', 'spouse']
    .some(key => Object.prototype.hasOwnProperty.call(byOwner || {}, key));
  const ownerTotal = hasOwnerEntry
    ? ['client', 'spouse'].reduce(
      (sum, key) => sum + (Number.isFinite(Number(byOwner?.[key])) ? Number(byOwner[key]) : 0),
      0,
    )
    : null;
  const ownerValid = ownerTotal === null || Math.abs(ownerTotal - 1) <= 1e-9;

  const sourceTypeOptions = source => {
    const known = incomeSourceTypes.some(type => type.id === source.typeId);
    return `${known ? '' : `<option value="${esc(source.typeId || '')}" selected disabled>Saved type · ${esc(source.typeId || 'unknown')}</option>`}
      ${optionList(incomeSourceTypes, source.typeId)}`;
  };

  const ownerOptions = source => {
    const options = [['client', plan.meta?.primaryName || 'Client']];
    if(hasSpouse){
      options.push(['spouse', plan.meta?.spouseName || 'Co-client']);
      options.push(['joint', 'Joint']);
    }
    const known = options.some(([value]) => value === source.owner);
    return `${known ? '' : `<option value="${esc(source.owner || '')}" selected disabled>Saved owner · ${esc(source.owner || 'unassigned')}</option>`}
      ${optionList(options, source.owner)}`;
  };

  const ssCard = (owner, key) => {
    const benefit = socialSecurity[key] || {};
    const label = owner === 'client'
      ? plan.meta?.primaryName || 'Client'
      : plan.meta?.spouseName || 'Co-client';
    return `
      <article class="hh-income-person" data-income-owner="${owner}">
        <div class="hh-income-card-title">${esc(label)}</div>
        <div class="hh-income-inline-fields">
          <label class="hh-field">
            <span>Annual benefit at full retirement age</span>
            <input type="text" inputmode="decimal" value="${moneyFieldValue(benefit.pia)}"
              placeholder="0" data-wizard-scope="income" data-wizard-field="socialSecurity.${key}.pia">
          </label>
          <label class="hh-field hh-field--age-entry">
            <span>Claim age</span>
            <input type="number" min="62" max="70" value="${fieldValue(benefit.claimAge ?? 67)}"
              data-wizard-scope="income" data-wizard-field="socialSecurity.${key}.claimAge">
          </label>
        </div>
      </article>
    `;
  };

  const sourceTaxFields = source => {
    const type = incomeSourceTypes.find(candidate => candidate.id === source.typeId);
    if(type?.taxTreatment === 'taxable-share'){
      return `
        <label class="hh-field hh-income-source-rate">
          <span>Taxable %</span>
          <input type="number" min="0" max="100" step="0.1" value="${pctValue(source.taxablePct, fieldValue)}"
            data-wizard-scope="income" data-wizard-field="source.taxablePct"
            data-income-row-id="${esc(source.id || '')}">
        </label>
      `;
    }
    if(type?.taxTreatment === 'qualified-share'){
      return `
        <label class="hh-field hh-income-source-rate">
          <span>Qualified %</span>
          <input type="number" min="0" max="100" step="0.1" value="${pctValue(source.qualifiedPct, fieldValue)}"
            data-wizard-scope="income" data-wizard-field="source.qualifiedPct"
            data-income-row-id="${esc(source.id || '')}">
        </label>
      `;
    }
    const savedPct = Number.isFinite(Number(source.taxablePct))
      ? `${fieldValue(Number(source.taxablePct) * 100)}% taxable`
      : 'Saved tax treatment';
    return `
      <div class="hh-income-source-treatment" data-income-tax-treatment="${type ? 'fully-taxable' : 'saved'}">
        <span>Tax treatment</span>
        <strong>${type ? '100% taxable' : esc(savedPct)}</strong>
      </div>
    `;
  };

  const sourceRows = sources.map(source => `
    <div class="hh-income-source-row" data-income-source-row="${esc(source.id || '')}"
      data-income-source-type="${esc(source.typeId || '')}">
      <label class="hh-field hh-income-source-type">
        <span>Type</span>
        <select data-wizard-scope="income" data-wizard-field="source.typeId"
          data-income-row-id="${esc(source.id || '')}">${sourceTypeOptions(source)}</select>
      </label>
      <label class="hh-field hh-income-source-name">
        <span>Name</span>
        <input type="text" value="${esc(source.label || '')}" placeholder="Income source"
          data-wizard-scope="income" data-wizard-field="source.label"
          data-income-row-id="${esc(source.id || '')}">
      </label>
      <label class="hh-field hh-income-source-owner">
        <span>Owner</span>
        <select data-wizard-scope="income" data-wizard-field="source.owner"
          data-income-row-id="${esc(source.id || '')}">${ownerOptions(source)}</select>
      </label>
      <label class="hh-field hh-income-source-amount">
        <span>Annual amount</span>
        <input type="text" inputmode="decimal" value="${moneyFieldValue(source.amount)}" placeholder="0"
          data-wizard-scope="income" data-wizard-field="source.amount"
          data-income-row-id="${esc(source.id || '')}">
      </label>
      <label class="hh-field hh-field--age-entry">
        <span>Starts</span>
        <input type="number" min="0" max="999" value="${fieldValue(source.startAge)}"
          data-wizard-scope="income" data-wizard-field="source.startAge"
          data-income-row-id="${esc(source.id || '')}">
      </label>
      <label class="hh-field hh-field--age-entry">
        <span>Ends</span>
        <input type="number" min="0" max="999" value="${fieldValue(source.endAge)}"
          data-wizard-scope="income" data-wizard-field="source.endAge"
          data-income-row-id="${esc(source.id || '')}">
      </label>
      <label class="hh-field hh-income-source-rate">
        <span>Real growth %</span>
        <input type="number" min="-20" max="20" step="0.1" value="${pctValue(source.realGrowth ?? 0, fieldValue)}"
          data-wizard-scope="income" data-wizard-field="source.realGrowth"
          data-income-row-id="${esc(source.id || '')}">
      </label>
      ${sourceTaxFields(source)}
      <button type="button" class="hh-income-remove" data-hh-action="remove-income-source"
        data-income-row-id="${esc(source.id || '')}" aria-label="Remove ${esc(source.label || 'income source')}">&times;</button>
    </div>
  `).join('');

  const pensionRows = Object.entries(benefitByAge)
    .map(([age, amount]) => [Number(age), amount])
    .filter(([age]) => Number.isFinite(age))
    .sort(([a], [b]) => a - b)
    .map(([age, amount]) => `
      <div class="hh-pension-age-row" data-pension-age="${age}">
        <span>Age ${age}</span>
        <label class="hh-field">
          <span class="hh-sr-only">Annual benefit at age ${age}</span>
          <input type="text" inputmode="decimal" value="${moneyFieldValue(amount)}" placeholder="0"
            data-wizard-scope="income" data-wizard-field="pension.benefitByAge.${age}">
        </label>
        <button type="button" data-hh-action="remove-pension-age" data-pension-age="${age}"
          aria-label="Remove pension benefit at age ${age}">&times;</button>
      </div>
    `).join('');

  return `
    <div class="hh-screen hh-income-screen" data-hh-wizard-screen="income"
      id="hh-panel-income" role="tabpanel" aria-labelledby="hh-nav-income">
      <section class="hh-income-section">
        <div class="hh-section-title">Social Security</div>
        <div class="hh-income-person-grid">
          ${ssCard('client', 'primary')}
          ${hasSpouse ? ssCard('spouse', 'spouse') : ''}
        </div>
      </section>

      <section class="hh-income-section">
        <div class="hh-income-section-head">
          <div><div class="hh-section-title">Recurring income</div><p>Wages and every other long-term planning source.</p></div>
          <button type="button" class="hh-add-row" data-hh-action="add-income-source" data-income-type-id="other">Add income</button>
        </div>
        <div class="hh-income-source-list">${sourceRows || '<p class="hh-empty-copy">No recurring income sources entered.</p>'}</div>
      </section>

      <section class="hh-income-section hh-income-two-column">
        <div>
          <div class="hh-section-title">Pension</div>
          <div class="hh-income-inline-fields hh-income-inline-fields--three">
            <label class="hh-field"><span>Base annual benefit</span><input type="text" inputmode="decimal"
              value="${moneyFieldValue(pension.base)}" data-wizard-scope="income" data-wizard-field="pension.base"></label>
            <label class="hh-field"><span>Start age</span><input type="number" min="45" max="125"
              value="${fieldValue(pension.startAge)}" data-wizard-scope="income" data-wizard-field="pension.startAge"></label>
            <label class="hh-field"><span>COLA %</span><input type="number" min="0" max="20" step="0.1"
              value="${fieldValue(pension.colaPct)}" data-wizard-scope="income" data-wizard-field="pension.colaPct"></label>
          </div>
          <div class="hh-pension-ages">${pensionRows}</div>
          <button type="button" class="hh-add-row" data-hh-action="add-pension-age">Add benefit age</button>
        </div>
        <div>
          <div class="hh-section-title">Savings and contributions</div>
          <div class="hh-savings-grid">
            <label class="hh-field hh-savings-annual"><span>Annual savings</span><input type="text" inputmode="decimal"
              value="${moneyFieldValue(savings.annual)}" data-wizard-scope="income" data-wizard-field="savings.annual"></label>
            <label class="hh-field"><span>Traditional %</span><input type="number" min="0" max="100" step="0.1"
              value="${pctValue(effectiveSplit.traditional, fieldValue)}" data-wizard-scope="income" data-wizard-field="savings.split.traditional"></label>
            <label class="hh-field"><span>Roth %</span><input type="number" min="0" max="100" step="0.1"
              value="${pctValue(effectiveSplit.roth, fieldValue)}" data-wizard-scope="income" data-wizard-field="savings.split.roth"></label>
            <label class="hh-field"><span>Taxable %</span><input type="number" min="0" max="100" step="0.1"
              value="${pctValue(effectiveSplit.taxable, fieldValue)}" data-wizard-scope="income" data-wizard-field="savings.split.taxable"></label>
            <label class="hh-field"><span>Client share %</span><input type="number" min="0" max="100" step="0.1"
              value="${pctValue(split.byOwner?.client, fieldValue)}" data-wizard-scope="income" data-wizard-field="savings.split.byOwner.client"></label>
            ${hasSpouse ? `<label class="hh-field"><span>Co-client share %</span><input type="number" min="0" max="100" step="0.1"
              value="${pctValue(split.byOwner?.spouse, fieldValue)}" data-wizard-scope="income" data-wizard-field="savings.split.byOwner.spouse"></label>` : ''}
          </div>
          <p class="hh-allocation-status ${sleeveValid ? 'is-valid' : 'is-invalid'}"
            data-savings-allocation="sleeves" data-allocation-status="${sleeveValid ? 'valid' : 'invalid'}">
            ${sleeveValid
              ? `Account allocation totals ${fieldValue(sleeveTotal * 100)}%.`
              : `Account allocation must total 100% before continuing; currently ${fieldValue(sleeveTotal * 100)}%.`}
          </p>
          <p class="hh-allocation-status ${ownerValid ? 'is-valid' : 'is-invalid'}"
            data-savings-allocation="owners" data-allocation-status="${ownerValid ? (hasOwnerEntry ? 'valid' : 'optional') : 'invalid'}">
            ${ownerTotal === null
              ? 'Contribution owner shares are optional; if entered, they must total 100%.'
              : ownerValid
                ? `Contribution owner shares total ${fieldValue(ownerTotal * 100)}%.`
                : `Contribution owner shares must total 100% before continuing; currently ${fieldValue(ownerTotal * 100)}%.`}
          </p>
        </div>
      </section>
    </div>
  `;
}

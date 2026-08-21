import { readWizardIrmaaLookback } from '../src/household/wizardIrmaa.js';

export function renderHouseholdWizardTax(ctx){
  const {
    plan,
    esc,
    fieldValue,
    current,
    deductionMode,
    planningIncome,
    optionalItems,
    optionalMenuOpen,
    taxSummary,
  } = ctx;
  const income = current.income || {};
  const deductions = current.deductions || {};
  const itemized = deductions.itemized || {};
  const salt = itemized.salt || {};
  const schedule1A = deductions.schedule1A || {};
  const passThrough = current.passThrough || {};
  const schedule2 = current.schedule2 || {};
  const scheduleSE = current.scheduleSE?.[0] || {};
  const detailed = true;
  const planningGroups = planningIncome?.groups || {};
  const wagesByOwner = planningIncome?.wagesByOwner || {};
  const hasSpouse = Boolean(plan.household?.spouse);
  const irmaaLookback = readWizardIrmaaLookback(plan);

  const groupState = groupId => planningGroups[groupId] || {
    rowIds: [],
    values: {},
    rowSourced: false,
    overridden: false,
    invalid: false,
  };
  const showTaxableIra = detailed
    || Number(income.iraDistributions) > 0
    || Number(groupState('ira').values.iraDistributions) > 0
    || Object.hasOwn(income, 'taxableIra');
  const showTaxablePension = detailed
    || Number(income.pensionAmount) > 0
    || Number(groupState('pension').values.pensionAmount) > 0
    || Object.hasOwn(income, 'taxablePensions');

  const effectiveIncomeValue = (groupId, field, fallback) => {
    const group = groupState(groupId);
    return group.rowSourced ? group.values[field] : fallback;
  };

  const groupSourceControl = groupId => {
    const group = groupState(groupId);
    if(group.rowIds.length === 0) return '';
    if(group.rowSourced){
      return `
        <span class="hh-tax-source">
          <span>From planning income</span>
          <button type="button" data-hh-action="override-income-group"
            data-income-group="${esc(groupId)}">Use current-year amount</button>
        </span>
      `;
    }
    if(group.overridden){
      return `
        <span class="hh-tax-source hh-tax-source--override">
          <span>Current-year amount</span>
          <button type="button" data-hh-action="revert-income-group"
            data-income-group="${esc(groupId)}">Use planning income</button>
        </span>
      `;
    }
    return '';
  };

  const amountInput = (
    field,
    value,
    {
      signed = false,
      placeholder = '0',
      disabled = false,
      id = null,
    } = {},
  ) => `
    <input class="hh-tax-amount" type="text" inputmode="decimal"
      ${id ? `id="${esc(id)}"` : ''}
      value="${fieldValue(value)}" placeholder="${placeholder}"
      data-hh-field="${esc(field)}" data-tax-field="${esc(field)}"
      ${signed ? 'data-signed="true"' : ''}
      ${disabled ? 'disabled aria-disabled="true"' : ''}>
  `;

  const wageValue = owner => {
    const member = wagesByOwner[owner];
    if(member?.present) return member.value;
    if(owner === 'client' && !hasSpouse
        && Object.prototype.hasOwnProperty.call(income, 'wages')){
      return income.wages;
    }
    return undefined;
  };

  const incomeRow = (
    label,
    field,
    value,
    { groupId = null, showSource = false, help = '', ...options } = {},
  ) => {
    const group = groupId ? groupState(groupId) : null;
    const groupField = groupId === 'long-term-gain-loss'
      ? 'netLongTermGainOrLoss'
      : field.replace(/^income\./, '');
    const displayed = groupId
      ? effectiveIncomeValue(groupId, groupField, value)
      : value;
    const inputId = `hh-tax-${field.replaceAll('.', '-')}`;
    return `
    <div class="hh-tax-row" data-tax-row="${esc(field)}"
      ${groupId ? `data-income-source-group="${esc(groupId)}"` : ''}>
      <div class="hh-tax-row-label">
        <label for="${esc(inputId)}">
          <span>${esc(label)}</span>
          ${help ? `<small>${esc(help)}</small>` : ''}
        </label>
        ${showSource && groupId ? groupSourceControl(groupId) : ''}
      </div>
      ${amountInput(field, displayed, {
        ...options,
        id: inputId,
        disabled: group?.rowSourced || options.disabled === true,
      })}
    </div>
  `;
  };

  const optionalSection = (item, title, body) => `
    <section class="hh-tax-optional" data-tax-optional="${esc(item)}">
      <div class="hh-tax-optional-head">
        <h3>${esc(title)}</h3>
        <button type="button" data-hh-action="remove-tax-item" data-tax-item="${esc(item)}">Remove</button>
      </div>
      ${body}
    </section>
  `;

  const suppliedZeroIsVisible = value => value !== 0;

  const itemIsVisible = item => optionalItems.has(item)
    || (item === 'adjustments'
      && current.adjustments
      && suppliedZeroIsVisible(current.adjustments.amount))
    || (item === 'qbi'
      && Object.hasOwn(deductions, 'qbi')
      && suppliedZeroIsVisible(deductions.qbi))
    || (item === 'line13b'
      && Object.hasOwn(schedule1A, 'amount')
      && suppliedZeroIsVisible(schedule1A.amount))
    || (item.startsWith('line')
      && Object.hasOwn(passThrough, item)
      && suppliedZeroIsVisible(passThrough[item]))
    || (item === 'schedule2'
      && (current.scheduleSE
        || Object.values(schedule2).some(value => value !== 0)))
    || (item === 'scheduleSE' && current.scheduleSE);

  const optionalChoices = [
    ['adjustments', 'Schedule 1 adjustments · line 10'],
    ['qbi', 'Qualified business income deduction · line 13a'],
    ['line13b', 'Additional deductions · line 13b'],
    ['line17', 'Other tax before credits · line 17'],
    ['line19', 'Child and dependent credits · line 19'],
    ['line20', 'Schedule 3 credits · line 20'],
    ['line23', 'Other taxes total · line 23'],
    ['schedule2', 'Schedule 2 tax components'],
    ...(detailed ? [['scheduleSE', 'Schedule SE']] : []),
  ].filter(([id]) => !itemIsVisible(id));

  const filingLabel = {
    marriedFilingJointly: 'Married filing jointly',
    single: 'Single',
    headOfHousehold: 'Head of household',
  }[plan.meta?.filingStatus] || 'Unsupported saved filing status';
  const irmaaFilingStatusOptions = selected => [
    ['single', 'Single'],
    ['marriedFilingJointly', 'Married filing jointly'],
    ['headOfHousehold', 'Head of household'],
    ['marriedFilingSeparately', 'Married filing separately'],
  ].map(([value, label]) => (
    `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
  )).join('');

  return `
    <div class="hh-screen hh-tax-screen" data-hh-wizard-screen="tax"
      data-tax-view="detailed" id="hh-panel-tax" role="tabpanel"
      aria-labelledby="hh-nav-tax">
      <section class="hh-tax-profile" aria-label="Tax profile">
        <label class="hh-field" data-tax-summary-box="tax-year">
          <span>Tax year</span>
          <select data-hh-field="taxYear" data-tax-field="taxYear">
            <option value="2025" ${current.taxYear === 2025 ? 'selected' : ''}>2025</option>
            <option value="2026" ${current.taxYear === 2026 ? 'selected' : ''}>2026</option>
          </select>
        </label>
        <div class="hh-tax-static" data-tax-summary-box="filing-status">
          <span>Filing status</span>
          <strong>${esc(filingLabel)}</strong>
        </div>
        <label class="hh-field hh-deduction-method" data-tax-summary-box="deduction-method">
          <span>Deduction method</span>
          <select data-hh-field="deductionMode" data-tax-field="deductionMode">
            <option value="standard" ${deductionMode === 'standard' ? 'selected' : ''}>Standard deduction</option>
            <option value="itemized-details" ${deductionMode === 'itemized-details' ? 'selected' : ''}>Itemized · enter details</option>
            <option value="itemized-total" ${deductionMode === 'itemized-total' ? 'selected' : ''}>Itemized · supplied line 12e</option>
          </select>
        </label>
      </section>

      <section class="hh-irmaa-lookback" data-tax-input-section="irmaa-lookback">
        <h2>IRMAA lookback</h2>
        <div class="hh-irmaa-lookback-table" aria-label="IRMAA lookback inputs">
          <div class="hh-irmaa-lookback-row hh-irmaa-lookback-row--head" aria-hidden="true">
            <span>Tax year</span>
            <span>MAGI</span>
            <span>Filing status</span>
          </div>
          ${irmaaLookback.map(row => {
            const prefix = `irmaa.lookback.${row.taxYear}`;
            return `
              <div class="hh-irmaa-lookback-row" data-irmaa-tax-year="${row.taxYear}"
                data-tax-summary-box="irmaa-${row.taxYear}">
                <strong>${row.taxYear}</strong>
                <span class="hh-irmaa-lookback-input">
                  ${amountInput(`${prefix}.magi`, row.magi, {
                    id: `hh-${prefix.replaceAll('.', '-')}-magi`,
                  })}
                </span>
                <label class="hh-sel hh-irmaa-lookback-status">
                  <span class="hh-sr-only">Filing status for ${row.taxYear}</span>
                  <select data-hh-field="${prefix}.filingStatus"
                    data-tax-field="${prefix}.filingStatus">
                    ${irmaaFilingStatusOptions(row.filingStatus)}
                  </select>
                </label>
              </div>
            `;
          }).join('')}
        </div>
      </section>

      <section class="hh-tax-section">
        <div class="hh-tax-section-head">
          <span class="hh-tax-section-number">1</span>
          <h2>Federal income-tax facts</h2>
        </div>
        <div class="hh-tax-table">
          <div class="hh-tax-table-head"><span>Income type</span><span>Amount</span></div>
          ${incomeRow('Client wages', 'income.wages.client', wageValue('client'))}
          ${hasSpouse
            ? incomeRow('Co-client wages', 'income.wages.spouse', wageValue('spouse'))
            : ''}
          ${incomeRow('Tax-exempt interest', 'income.taxExemptInterest', income.taxExemptInterest, {
            groupId: 'interest',
            showSource: true,
          })}
          ${incomeRow('Taxable interest', 'income.taxableInterest', income.taxableInterest, {
            groupId: 'interest',
          })}
          ${incomeRow('Qualified dividends', 'income.qualifiedDividends', income.qualifiedDividends, {
            groupId: 'dividends',
            showSource: true,
          })}
          ${incomeRow('Ordinary dividends', 'income.ordinaryDividends', income.ordinaryDividends, {
            groupId: 'dividends',
          })}
          ${incomeRow('Traditional IRA distribution', 'income.iraDistributions', income.iraDistributions, {
            groupId: 'ira',
            showSource: true,
          })}
          ${showTaxableIra ? incomeRow('Taxable IRA amount · line 4b', 'income.taxableIra', income.taxableIra, {
            groupId: 'ira',
          }) : ''}
          ${incomeRow('Roth conversion', 'income.rothConversion', income.rothConversion, {
            groupId: 'roth-conversion',
            showSource: true,
          })}
          ${incomeRow('Pension or annuity', 'income.pensionAmount', income.pensionAmount, {
            groupId: 'pension',
            showSource: true,
          })}
          ${showTaxablePension ? incomeRow('Taxable pension amount · line 5b', 'income.taxablePensions', income.taxablePensions, {
            groupId: 'pension',
          }) : ''}
          ${incomeRow('Social Security', 'income.socialSecurityBenefits', income.socialSecurityBenefits)}
          ${detailed && income.socialSecurity?.mode === 'supplied-form1040-lines'
            ? incomeRow('Taxable Social Security · line 6b', 'income.taxableSS', income.taxableSS)
            : ''}
          ${incomeRow('Long-term capital gain or loss', 'scheduleD.netLongTermGainOrLoss',
            current.scheduleD?.netLongTermGainOrLoss, {
              signed: true,
              groupId: 'long-term-gain-loss',
              showSource: true,
              help: 'Enter 0 when none applies.',
            })}
          ${incomeRow('Other taxable income', 'income.otherIncome', income.otherIncome, {
            signed: true,
            groupId: 'other-income',
            showSource: true,
          })}
        </div>
        ${planningIncome?.hasActivePlanningSocialSecurity ? `
          <p class="hh-tax-source-note" data-tax-planning-social-security>
            Planning Social Security rows are not current-year Form 1040 facts.
            Enter the current-year amounts above.
          </p>
        ` : ''}
      </section>

      ${detailed ? `
        <section class="hh-tax-subsection">
          <div class="hh-tax-subsection-head">
            <h3>Social Security source</h3>
          </div>
          <label class="hh-field hh-field--compact-select">
            <span>Taxable-benefit source</span>
            <select data-hh-field="socialSecurity.mode" data-tax-field="socialSecurity.mode">
              <option value="supplied-form1040-lines"
                ${income.socialSecurity?.mode !== 'calculate-taxable-benefits' ? 'selected' : ''}>Client return · line 6b</option>
              <option value="calculate-taxable-benefits"
                ${income.socialSecurity?.mode === 'calculate-taxable-benefits' ? 'selected' : ''}>Federal worksheet</option>
            </select>
          </label>
          ${income.socialSecurity?.mode === 'calculate-taxable-benefits' ? `
            <div class="hh-tax-mini-grid">
              <label class="hh-field"><span>Worksheet other income</span>
                ${amountInput('socialSecurity.otherIncome', income.socialSecurity.otherIncome, { signed: true })}
              </label>
              <label class="hh-field"><span>Excluded-income add-backs</span>
                ${amountInput('socialSecurity.excludedIncomeAddBacks', income.socialSecurity.excludedIncomeAddBacks)}
              </label>
              <label class="hh-field"><span>Worksheet-eligible adjustments</span>
                ${amountInput('socialSecurity.adjustments', income.socialSecurity.adjustments)}
              </label>
            </div>
          ` : ''}
        </section>
      ` : ''}

      ${deductionMode === 'itemized-details' ? `
        <section class="hh-tax-section hh-itemized-section">
          <div class="hh-tax-section-head">
            <span class="hh-tax-section-number">2</span>
            <h2>Itemized deductions</h2>
          </div>
          <div class="hh-itemized-grid">
            <label class="hh-field">
              <span>Eligible unreimbursed medical expenses</span>
              ${amountInput('deductions.itemized.medicalExpensesPaid', itemized.medicalExpensesPaid)}
              <small>Enter the raw eligible amount before the 7.5% AGI floor.</small>
            </label>
            <label class="hh-field">
              <span>Eligible state and local taxes paid</span>
              ${amountInput('deductions.itemized.salt.eligibleTaxesPaid', salt.eligibleTaxesPaid)}
              <small>Enter the raw eligible amount before the federal SALT limit.</small>
            </label>
            <label class="hh-field">
              <span>MAGI for the SALT limit</span>
              ${amountInput('deductions.itemized.salt.magi', salt.magi?.amount)}
            </label>
            <label class="hh-field">
              <span>Deductible mortgage interest</span>
              ${amountInput('deductions.itemized.mortgageInterestDeductible', itemized.mortgageInterestDeductible)}
              <small>Enter the deductible amount after any category-specific limits.</small>
            </label>
            <label class="hh-field">
              <span>Deductible charitable contributions</span>
              ${amountInput('deductions.itemized.charitableContributionsDeductible', itemized.charitableContributionsDeductible)}
              <small>Enter the deductible amount after any category-specific limits.</small>
            </label>
            <label class="hh-field">
              <span>Other deductible itemized amounts</span>
              ${amountInput('deductions.itemized.otherItemizedDeductions', itemized.otherItemizedDeductions)}
              <small>Enter the deductible amount after any applicable limits.</small>
            </label>
          </div>
        </section>
      ` : ''}

      ${deductionMode === 'itemized-total' ? `
        <section class="hh-tax-section hh-supplied-deduction">
          <div class="hh-tax-section-head">
            <span class="hh-tax-section-number">2</span>
            <h2>Supplied deduction</h2>
          </div>
          <label class="hh-field">
            <span>Form 1040 line 12e / Schedule A total</span>
            ${amountInput('deductions.line12e', deductions.line12e)}
          </label>
        </section>
      ` : ''}

      ${itemIsVisible('adjustments') ? optionalSection('adjustments', 'Schedule 1 adjustments',
        `<label class="hh-field"><span>Form 1040 line 10</span>${amountInput('adjustments.line10', current.adjustments?.amount)}</label>`) : ''}
      ${itemIsVisible('qbi') ? optionalSection('qbi', 'Qualified business income deduction',
        `<label class="hh-field"><span>Form 1040 line 13a</span>${amountInput('deductions.qbi', deductions.qbi)}</label>`) : ''}
      ${itemIsVisible('line13b') ? optionalSection('line13b', 'Additional deductions',
        `<label class="hh-field"><span>Form 1040 line 13b</span>${amountInput('deductions.line13b', schedule1A.amount)}</label>`) : ''}
      ${['line17', 'line19', 'line20', 'line23'].map(line =>
        itemIsVisible(line) ? optionalSection(line, `Form 1040 ${line}`,
          `<label class="hh-field"><span>Supplied ${line} amount</span>${amountInput(`passThrough.${line}`, passThrough[line])}</label>`) : ''
      ).join('')}
      ${itemIsVisible('schedule2') ? optionalSection('schedule2', 'Schedule 2 tax components', `
        <div class="hh-tax-mini-grid">
          <label class="hh-field"><span>Net Investment Income Tax</span>
            ${amountInput('schedule2.netInvestmentIncomeTax', schedule2.netInvestmentIncomeTax)}</label>
          <label class="hh-field"><span>Additional Medicare Tax</span>
            ${amountInput('schedule2.additionalMedicareTax', schedule2.additionalMedicareTax)}</label>
          <label class="hh-field"><span>Other Schedule 2 Part II taxes</span>
            ${amountInput('schedule2.otherPartIITaxes', schedule2.otherPartIITaxes)}</label>
        </div>
      `) : ''}
      ${detailed && itemIsVisible('scheduleSE') ? optionalSection('scheduleSE', 'Schedule SE', `
        <div class="hh-tax-mini-grid">
          <label class="hh-field"><span>Taxpayer</span>
            <select data-hh-field="scheduleSE.taxpayerOwner" data-tax-field="scheduleSE.taxpayerOwner">
              <option value="client" ${scheduleSE.taxpayerOwner !== 'spouse' ? 'selected' : ''}>${esc(plan.meta?.primaryName || 'Client')}</option>
              ${plan.meta?.filingStatus === 'marriedFilingJointly'
                ? `<option value="spouse" ${scheduleSE.taxpayerOwner === 'spouse' ? 'selected' : ''}>${esc(plan.meta?.spouseName || 'Co-client')}</option>`
                : ''}
            </select>
          </label>
          <label class="hh-field"><span>Resolved Schedule SE line 6</span>
            ${amountInput('scheduleSE.netEarningsFromSelfEmployment', scheduleSE.netEarningsFromSelfEmployment)}</label>
          <label class="hh-field"><span>Resolved Schedule SE line 8d wages and tips</span>
            ${amountInput('scheduleSE.socialSecurityWagesAndTips', scheduleSE.socialSecurityWagesAndTips)}</label>
        </div>
        <small class="hh-tax-source-note">When Schedule SE is used, enter all three Schedule 2 components, including explicit zeros.</small>
      `) : ''}

      <div class="hh-tax-add-wrap">
        <button type="button" class="hh-add-row" data-hh-action="toggle-tax-menu">+ Add tax item</button>
        ${optionalMenuOpen ? `
          <div class="hh-tax-add-menu" role="menu">
            ${optionalChoices.length
              ? optionalChoices.map(([id, label]) =>
                  `<button type="button" role="menuitem" data-hh-action="show-tax-item" data-tax-item="${id}">${esc(label)}</button>`
                ).join('')
              : '<span>All available items are shown.</span>'}
          </div>
        ` : ''}
      </div>

      <div class="hh-tax-readiness"
        data-tax-readiness="${taxSummary.status === 'ready' ? 'ready' : 'needs-facts'}"
        data-tax-reason="${esc(taxSummary.reasonCodes?.[0] || '')}">
        ${taxSummary.status === 'ready'
          ? `<span class="hh-status-dot"></span> Tax inputs are ready`
          : `<span class="hh-status-dot"></span> ${esc(taxSummary.message || 'Additional tax facts are needed')}`}
      </div>
    </div>
  `;
}

// Phone deduction choices delegate to the sole canonical Tax select.
const selector = '[data-tax-field="deductionMode"]';

export function syncHouseholdTaxChoices(root){
  const select = root.querySelector(selector);
  if(!select) return;
  const mode = select.value;
  for(const button of root.querySelectorAll('[data-mobile-tax-choice]')){
    const choice = button.dataset.mobileTaxChoice;
    const active = choice === 'itemized' ? mode !== 'standard' : choice === mode;
    button.setAttribute('aria-pressed', String(active));
    button.disabled = select.disabled;
    button.setAttribute('aria-disabled', String(select.disabled));
  }
  const secondary = root.querySelector('.hh-mobile-deduction-source');
  if(secondary) secondary.hidden = mode === 'standard';
}

export function mountHouseholdTaxChoices(section){
  const doc = section.ownerDocument;
  const group = doc.createElement('div');
  group.className = 'hh-mobile-deduction-choices';
  const choices = (className, label, entries) => {
    const row = doc.createElement('div');
    row.className = className;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', label);
    for(const [value, text] of entries){
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.mobileTaxChoice = value;
      button.textContent = text;
      row.append(button);
    }
    group.append(row);
  };
  choices('hh-mobile-deduction-primary', 'Deduction method', [['standard', 'Standard'], ['itemized', 'Itemized']]);
  choices('hh-mobile-deduction-source', 'Itemized deduction source', [
    ['itemized-details', 'Enter details'], ['itemized-total', 'Use supplied Form 1040 total'],
  ]);
  group.addEventListener('click', event => {
    const button = event.target.closest('[data-mobile-tax-choice]');
    const select = section.querySelector(selector);
    if(!button || button.disabled || !select?.isConnected || select.disabled) return;
    const choice = button.dataset.mobileTaxChoice;
    const mode = choice === 'itemized' ? (select.value === 'standard' ? 'itemized-details' : select.value) : choice;
    if(select.value === mode || ![...select.options].some(option => option.value === mode)) return;
    select.value = mode;
    select.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  });
  section.insertBefore(group, section.querySelector('[data-tax-summary-box="deduction-method"]'));
  syncHouseholdTaxChoices(section);
}

export function visibleHouseholdTaxControl(control, root){
  if(control?.dataset.taxField !== 'deductionMode' || root.dataset.mobileInputs !== 'true') return control;
  return root.querySelector(`[data-mobile-tax-choice="${control.value === 'standard' ? 'standard' : 'itemized'}"]`) || control;
}

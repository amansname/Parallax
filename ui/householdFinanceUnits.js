function parsed(value){
  const text = String(value ?? '').replace(/[$,\s]/g, '');
  return text === '' ? Number.NaN : Number(text);
}

// A fractional monthly display must remain fractional during typing/deletion.
// Leave incomplete or invalid text available to the production validator.
export function formatFinanceAmountInput(control){
  const old = control.value;
  const text = old.replace(/[$,\s]/g, '');
  if(!/^\d*(?:\.\d*)?$/.test(text)) return;
  const prefixLength = old.slice(0, control.selectionStart ?? old.length).replace(/[$,\s]/g, '').length;
  const [whole, fraction] = text.split('.');
  const firstLength = whole.length % 3 || 3;
  const groups = [whole.slice(0, firstLength)];
  for(let offset = firstLength; offset < whole.length; offset += 3) groups.push(whole.slice(offset, offset + 3));
  const grouped = groups.join(',');
  control.value = grouped + (fraction === undefined ? '' : `.${fraction}`);
  let caret = 0; let seen = 0;
  while(caret < control.value.length && seen < prefixLength){
    if(control.value[caret] !== ',') seen += 1;
    caret += 1;
  }
  control.setSelectionRange(caret, caret);
}

// The mounted control owns its unit, even if the viewport changes mid-edit.
export function readFinanceAnnualAmount(control){
  if(control.dataset.financeUnit !== 'month') return control.value;
  if(control.value === control.dataset.financeDisplayedValue) return control.dataset.financeAnnualValue;
  const value = parsed(control.value);
  return Number.isFinite(value) ? value * 12 : control.value;
}

export function syncFinanceAmountUnit(root, mobile){
  const control = root.querySelector('[data-finance-social-security]');
  if(!control) return;
  const next = mobile ? 'month' : 'year';
  const unit = control.dataset.financeUnit || 'year';
  if(next === unit || root.ownerDocument.activeElement === control) return;
  const annual = readFinanceAnnualAmount(control);
  const value = parsed(annual);
  // Preserve incomplete text in its current unit until it is corrected.
  if(!Number.isFinite(value) && String(annual).trim() !== '') return;
  control.dataset.financeAnnualValue = String(annual);
  control.value = Number.isFinite(value)
    ? (next === 'month' ? value / 12 : value).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
  control.dataset.financeDisplayedValue = control.value;
  control.dataset.financeUnit = next;
  control.setAttribute('aria-label', `Social Security ${next === 'month' ? 'monthly' : 'annual'} amount`);
  control.parentElement.querySelector('[data-finance-unit-label]').textContent = next === 'month' ? '/mo' : '/yr';
}

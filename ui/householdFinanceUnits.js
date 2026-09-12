function parsed(value){
  const text = String(value ?? '').replace(/[$,\s]/g, '');
  return text === '' ? NaN : Number(text);
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

import { formatIsoBirthDate, readBirthDateGroup } from '../birthDateInput.js';
export function valueFromControl(control) {
  if (control.type === 'checkbox') return control.checked;
  if (control.matches?.('[data-birth-date-value]')) {
    const group = control.closest('[data-birth-date-group]');
    const iso = group ? readBirthDateGroup(group) : null;
    return iso ?? control.value;
  }
  return control.value;
}
export function formatCommittedTaxAmount(control) {
  const raw = String(control.value ?? '').trim();
  if (!raw) return;
  const numeric = Number(raw.replace(/[\s,]/g, ''));
  if (!Number.isFinite(numeric)) return;
  control.value = numeric.toLocaleString('en-US', {
    maximumFractionDigits: 2
  });
}
export function birthDateValidityControl(control) {
  if (!control?.matches?.('[data-birth-date-value]')) return control;
  const group = control.closest('[data-birth-date-group]');
  return group?.querySelector('[data-birth-date-display]') || control;
}
export function clearBirthDateValidity(group) {
  if (!group) return;
  for (const input of group.querySelectorAll('[data-birth-date-display], [data-birth-part]')) {
    input.removeAttribute('aria-invalid');
    if (typeof input.setCustomValidity === 'function') input.setCustomValidity('');
  }
}
export function syncBirthDateDisplay(group, iso) {
  if (!group) return;
  const display = group.querySelector('[data-birth-date-display]');
  if (display) display.value = formatIsoBirthDate(iso);
}

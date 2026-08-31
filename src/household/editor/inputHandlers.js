import { deleteBirthDateDigit, formatBirthDateEntry, birthDateCaretAfterDigits, readBirthDateGroup } from '../birthDateInput.js';
import { clearBirthDateValidity, formatCommittedTaxAmount, valueFromControl, syncBirthDateDisplay } from './valueControls.js';
import { updateNetWorthDraft } from './netWorthDraft.js';
export function createHouseholdInputHandlers({
  transientState,
  liveCommas,
  root,
  commit
}) {
  return {
    'beforeinput': event => {
      const birthDateDisplay = event.target.closest?.('[data-birth-date-display]');
      if (!birthDateDisplay || birthDateDisplay.selectionStart !== birthDateDisplay.selectionEnd) {
        return;
      }
      const direction = event.inputType === 'deleteContentBackward' ? 'backward' : event.inputType === 'deleteContentForward' ? 'forward' : null;
      if (!direction) return;
      const caret = birthDateDisplay.selectionStart ?? 0;
      const adjacentIndex = direction === 'backward' ? caret - 1 : caret;
      if (/\d/.test(birthDateDisplay.value[adjacentIndex] || '')) return;
      const edit = deleteBirthDateDigit(birthDateDisplay.value, caret, direction);
      if (!edit) return;
      event.preventDefault();
      birthDateDisplay.value = edit.value;
      birthDateDisplay.setSelectionRange(edit.caret, edit.caret);
      birthDateDisplay.dispatchEvent(new Event('input', {
        bubbles: true
      }));
    },
    'input': event => {
      const birthDateDisplay = event.target.closest?.('[data-birth-date-display]');
      if (birthDateDisplay) {
        const selectionStart = birthDateDisplay.selectionStart ?? birthDateDisplay.value.length;
        const digitsBeforeCaret = (birthDateDisplay.value.slice(0, selectionStart).match(/\d/g) || []).length;
        const formatted = formatBirthDateEntry(birthDateDisplay.value);
        if (birthDateDisplay.value !== formatted) birthDateDisplay.value = formatted;
        const caret = birthDateCaretAfterDigits(formatted, digitsBeforeCaret);
        birthDateDisplay.setSelectionRange(caret, caret);
        const group = birthDateDisplay.closest('[data-birth-date-group]');
        clearBirthDateValidity(group);
        const hidden = group?.querySelector('[data-birth-date-value]');
        const iso = group ? readBirthDateGroup(group) : null;
        if (hidden && iso) {
          hidden.value = iso;
          hidden.dispatchEvent(new Event('change', {
            bubbles: true
          }));
        }
        return;
      }
      if (event.target.matches?.('[data-tax-field]')) {
        event.target.removeAttribute('aria-invalid');
        if (typeof event.target.setCustomValidity === 'function') {
          event.target.setCustomValidity('');
        }
      }
      const netWorthDraft = event.target.closest?.('[data-net-worth-draft]');
      if (netWorthDraft) {
        updateNetWorthDraft(transientState, netWorthDraft);
        return;
      }
      if (event.target.classList.contains('hh-tax-amount')) {
        if (event.target.dataset.signed !== 'true') liveCommas(event.target);
      }
    },
    'focusin': event => {
      const control = event.target.closest?.('.hh-tax-amount');
      if (control && control.dataset.householdCommittedValue === undefined) {
        control.dataset.householdCommittedValue = control.value;
      }
    },
    'focusout': event => {
      // Replacing the wizard view blurs its focused control while the old DOM is
      // being removed. Do not turn that teardown blur into a nested edit/render.
      if (root.dataset.wizardReady === 'false') return;
      const control = event.target.closest?.('.hh-tax-amount');
      if (control) formatCommittedTaxAmount(control);
      if (!control || control.dataset.householdCommittedValue === control.value) return;
      control.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    },
    'change': event => {
      const netWorthDraft = event.target.closest?.('[data-net-worth-draft]');
      if (netWorthDraft) {
        updateNetWorthDraft(transientState, netWorthDraft);
        return;
      }
      const family = event.target.closest('[data-wizard-scope="family"][data-wizard-field]');
      if (family) {
        const priorValue = family.matches?.('[data-birth-date-value]') ? family.value : family.querySelector?.('option[selected]')?.value;
        const applied = commit({
          scope: 'family',
          field: family.dataset.wizardField,
          value: valueFromControl(family)
        }, family);
        if (!applied && priorValue != null) {
          if (family.matches?.('[data-birth-date-value]')) {
            family.value = priorValue;
            syncBirthDateDisplay(family.closest('[data-birth-date-group]'), priorValue);
          } else {
            family.value = priorValue;
          }
        }
        return;
      }
      const tax = event.target.closest('[data-tax-field]');
      if (tax) {
        const applied = commit({
          scope: 'tax',
          action: 'set',
          field: tax.dataset.taxField,
          value: valueFromControl(tax)
        }, tax);
        if (applied) tax.dataset.householdCommittedValue = tax.value;
      }
    }
  };
}

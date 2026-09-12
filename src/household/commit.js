import { createHouseholdInputHandlers } from './editor/inputHandlers.js';
import { createNavigationActions } from './editor/navigationActions.js';
import { createNetWorthViewsActions } from './editor/netWorthViewsActions.js';
import { createNetWorthMutationsActions } from './editor/netWorthMutationsActions.js';
import { createFamilyActions } from './editor/familyActions.js';
import { createTaxActions } from './editor/taxActions.js';
import { birthDateValidityControl, clearBirthDateValidity } from './editor/valueControls.js';
import { createHouseholdInlineErrors } from '../../ui/householdInlineErrors.js';
export function bindHouseholdEditor({
  root,
  wizardRoot,
  transientState,
  guardPlanMutation,
  commitWizardEdit,
  preflightWizardEdit = () => true,
  syncHousehold,
  navigateWizard,
  syncHeaderStatus,
  liveCommas
}) {
  if (!root || !wizardRoot) return;
  const inlineErrors = createHouseholdInlineErrors(wizardRoot);
  function reportError(error, control = null) {
    const message = error instanceof Error ? error.message : String(error);
    wizardRoot.dataset.validationCode = error?.code || 'WIZARD_EDIT_REJECTED';
    const errorField = error?.field;
    const fieldControl = errorField ? Array.from(wizardRoot.querySelectorAll('[data-tax-field], [data-wizard-field]')).find(candidate => candidate.dataset.taxField === errorField || candidate.dataset.wizardField === errorField) : null;
    const rawTarget = fieldControl || control;
    const target = birthDateValidityControl(rawTarget);
    if (rawTarget?.closest?.('[data-birth-date-group]')) {
      clearBirthDateValidity(rawTarget.closest('[data-birth-date-group]'));
    }
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      if (typeof target.setCustomValidity === 'function') {
        target.setCustomValidity(message);
      }
      const inline = inlineErrors.report(target, message);
      target.focus();
      if (!inline && typeof target.reportValidity === 'function') target.reportValidity();
    }
    syncHeaderStatus(message);
  }
  function commit(command, control = null, returnResult = false) {
    if (!guardPlanMutation()) return false;
    try {
      const result = commitWizardEdit(command);
      if(result?.changed !== false) transientState.refreshFailed = Boolean(result?.refreshError);
      inlineErrors.clear(birthDateValidityControl(control));
      if (control) {
        if (control.matches?.('[data-birth-date-value]')) {
          clearBirthDateValidity(control.closest('[data-birth-date-group]'));
        } else {
          control.removeAttribute('aria-invalid');
          if (typeof control.setCustomValidity === 'function') {
            control.setCustomValidity('');
          }
        }
      }
      if (result?.refreshError) {
        // Rendering has stopped; do not leave its failure alert in a busy subtree.
        wizardRoot.setAttribute?.('aria-busy', 'false');
        wizardRoot.dataset.validationCode = 'WIZARD_REFRESH_FAILED';
        syncHeaderStatus('Edit applied, but the screen could not refresh');
        return returnResult ? result : true;
      }
      delete wizardRoot.dataset.validationCode;
      return returnResult ? result : true;
    } catch (error) {
      reportError(error, control);
      return false;
    }
  }
  const inputHandlers = createHouseholdInputHandlers({
    transientState,
    liveCommas,
    root,
    commit
  });
  const actionHandlers = {
    ...createNavigationActions({
      navigateWizard,
      root,
      commit
    }),
    ...createNetWorthViewsActions({
      transientState,
      syncHousehold
    }),
    ...createNetWorthMutationsActions({
      guardPlanMutation,
      transientState,
      syncHousehold,
      commit
    }),
    ...createFamilyActions({
      guardPlanMutation,
      preflightWizardEdit,
      reportError,
      commit,
      transientState,
      syncHousehold: () => syncHousehold({ financeOnly: true })
    }),
    ...createTaxActions({
      transientState,
      syncHousehold,
      commit
    })
  };
  root.addEventListener('beforeinput', inputHandlers.beforeinput);
  root.addEventListener('input', inputHandlers.input);
  root.addEventListener('focusin', inputHandlers.focusin);
  root.addEventListener('focusout', inputHandlers.focusout);
  root.addEventListener('change', inputHandlers.change);
  root.addEventListener('keydown', event => {
    const onFamily = wizardRoot.dataset.wizardStep === 'family';
    if(event.key === 'Escape' && onFamily && transientState.financePending){
      event.preventDefault();
      actionHandlers['cancel-savings-replacement']();
      return;
    }
    if(event.key === 'Escape' && onFamily && transientState.financeOwner){
      event.preventDefault();
      const owner = transientState.financeOwner;
      transientState.financeOwner = null;
      transientState.financeTypeId = null;
      syncHousehold({ financeOnly: true });
      root.querySelector(`[data-finances-person-owner="${owner}"]`)?.focus();
      return;
    }
    if(event.key === 'Escape' && onFamily && transientState.financeRailOpen){
      event.preventDefault();
      transientState.financeRailOpen = false;
      syncHousehold({ financeOnly: true });
      root.querySelector('[data-hh-action="toggle-finances-rail"]')?.focus();
      return;
    }
    const amount = event.target.closest?.('[data-finance-amount]');
    if(event.key !== 'Enter' || !amount) return;
    event.preventDefault();
    amount.closest('[data-finance-entry-panel]')
      ?.querySelector('[data-hh-action="commit-finance-entry"]')
      ?.click();
  });
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-hh-action]');
    if (!action) return;
    if (action.disabled || action.getAttribute('aria-disabled') === 'true') return;
    const kind = action.dataset.hhAction;
    if (Object.hasOwn(actionHandlers, kind)) actionHandlers[kind](action);
  });
  globalThis.document?.addEventListener('click', event => {
    if(wizardRoot.dataset.wizardStep !== 'family') return;
    if(!transientState.financeOwner) return;
    if(event.target.closest?.('[data-finances-rail]')){
      return;
    }
    transientState.financeOwner = null;
    transientState.financeTypeId = null;
    syncHousehold({ financeOnly: true });
  });
}

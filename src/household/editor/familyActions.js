export function createFamilyActions({
  guardPlanMutation,
  preflightWizardEdit,
  reportError,
  commit,
  transientState,
  syncHousehold,
}) {
  const closeFinanceEntry = () => {
    transientState.financeOwner = null;
    transientState.financeTypeId = null;
  };
  const focusFinanceControl = selector => {
    requestAnimationFrame(() => document.querySelector(selector)?.focus());
  };
  return {
    'toggle-finance-entry': action => {
      const owner = action.dataset.financeOwner;
      if(transientState.financeOwner === owner){
        closeFinanceEntry();
      }else{
        transientState.financeOwner = owner;
        transientState.financeMode = 'savings';
        transientState.financeTypeId = null;
      }
      syncHousehold();
      if(transientState.financeOwner){
        focusFinanceControl('[data-finance-entry-panel] [data-hh-action="select-finance-source"]');
      }
    },
    'set-finance-mode': action => {
      transientState.financeMode = action.dataset.financeMode;
      transientState.financeTypeId = null;
      syncHousehold();
      focusFinanceControl('[data-finance-entry-panel] [data-hh-action="select-finance-source"]');
    },
    'select-finance-source': action => {
      transientState.financeTypeId = action.dataset.financeTypeId;
      syncHousehold();
      focusFinanceControl('[data-finance-amount]');
    },
    'commit-finance-entry': action => {
      const panel = action.closest('[data-finance-entry-panel]');
      const amount = panel?.querySelector('[data-finance-amount]');
      if(!panel || !amount) return;
      const applied = commit({
        scope: 'finance',
        action: 'add',
        owner: panel.dataset.financeOwner,
        mode: transientState.financeMode,
        typeId: transientState.financeTypeId,
        amount: amount.value,
      }, amount);
      if(!applied) return;
      closeFinanceEntry();
      syncHousehold();
    },
    'remove-spouse': action => {
      if (!guardPlanMutation()) return;
      const command = {
        scope: 'family',
        action: 'remove-spouse',
        confirmed: true
      };
      try {
        preflightWizardEdit(command);
      } catch (error) {
        reportError(error, action);
        return;
      }
      const confirmed = window.confirm('Remove co-client from this household? Co-client identity, Social Security, and tax facts will be discarded.');
      if (!confirmed) return;
      commit(command, action);
      return;
    }
  };
}

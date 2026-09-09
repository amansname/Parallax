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
  const clearFinanceSaveStatus = () => {
    transientState.financeSaveStatus = false;
  };
  const focusFinanceControl = selector => {
    requestAnimationFrame(() => document.querySelector(selector)?.focus());
  };
  const finishFinanceEntry = (command, control) => {
    const result = commit(command, control, true);
    if(!result) return;
    closeFinanceEntry();
    transientState.financeSaveStatus = result.changed !== false;
    syncHousehold();
    focusFinanceControl(`[data-finances-person-owner="${command.owner}"]`);
  };
  return {
    'toggle-finances-rail': () => {
      clearFinanceSaveStatus();
      transientState.financeRailOpen = !transientState.financeRailOpen;
      if(!transientState.financeRailOpen) closeFinanceEntry();
      syncHousehold();
      if(transientState.financeRailOpen){
        focusFinanceControl('[data-finances-person-owner]');
      }
    },
    'toggle-finance-entry': action => {
      const owner = action.dataset.financeOwner;
      clearFinanceSaveStatus();
      transientState.financeRailOpen = true;
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
      clearFinanceSaveStatus();
      transientState.financeMode = action.dataset.financeMode;
      transientState.financeTypeId = null;
      syncHousehold();
      focusFinanceControl('[data-finance-entry-panel] [data-hh-action="select-finance-source"]');
    },
    'select-finance-source': action => {
      clearFinanceSaveStatus();
      transientState.financeTypeId = action.dataset.financeTypeId;
      syncHousehold();
      focusFinanceControl('[data-finance-amount]');
    },
    'commit-finance-entry': action => {
      const panel = action.closest('[data-finance-entry-panel]');
      const amount = panel?.querySelector('[data-finance-amount]');
      if(!panel || !amount) return;
      if(!guardPlanMutation()) return;
      const command = {
        scope: 'finance',
        action: 'add',
        owner: panel.dataset.financeOwner,
        mode: transientState.financeMode,
        typeId: transientState.financeTypeId,
        amount: amount.value,
      };
      try{
        preflightWizardEdit(command);
      }catch(error){
        if(error.code !== 'SAVINGS_REPLACEMENT_REQUIRED'){
          reportError(error, amount);
          return;
        }
        transientState.financeDraft = { ...command };
        transientState.financePending = { command, confirmation: error.confirmation };
        syncHousehold();
        focusFinanceControl('[data-savings-replacement-heading]');
        return;
      }
      finishFinanceEntry(command, amount);
    },
    'cancel-savings-replacement': () => {
      transientState.financePending = null;
      syncHousehold();
      focusFinanceControl('[data-finance-amount]');
    },
    'confirm-savings-replacement': () => {
      const pending = transientState.financePending;
      if(!pending || !guardPlanMutation()) return;
      const command = { ...pending.command, savingsConfirmation: pending.confirmation };
      try{
        preflightWizardEdit(command);
      }catch(error){
        transientState.financePending = null;
        syncHousehold();
        reportError(error, document.querySelector('[data-finance-amount]'));
        return;
      }
      finishFinanceEntry(command);
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

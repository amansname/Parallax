function valueFromControl(control){
  if(control.type === 'checkbox') return control.checked;
  return control.value;
}

export function bindHouseholdEditor({
  root,
  wizardRoot,
  transientState,
  guardPlanMutation,
  commitWizardEdit,
  preflightWizardEdit = () => true,
  syncHousehold,
  navigateWizard,
  canAdvanceTax = () => true,
  syncHeaderStatus,
  liveCommas,
}){
  if(!root || !wizardRoot) return;

  function reportError(error, control = null){
    const message = error instanceof Error ? error.message : String(error);
    wizardRoot.dataset.validationCode = error?.code || 'WIZARD_EDIT_REJECTED';
    if(control?.matches?.('[data-tax-confirmation]')){
      control.checked = false;
    }
    const errorField = error?.field;
    const fieldControl = errorField
      ? Array.from(wizardRoot.querySelectorAll(
        '[data-tax-field], [data-wizard-field]',
      )).find(candidate =>
        candidate.dataset.taxField === errorField
          || candidate.dataset.wizardField === errorField)
      : null;
    const target = fieldControl || control;
    if(target){
      target.setAttribute('aria-invalid', 'true');
      if(typeof target.setCustomValidity === 'function'){
        target.setCustomValidity(message);
      }
      target.focus();
      if(typeof target.reportValidity === 'function') target.reportValidity();
    }
    syncHeaderStatus(message);
  }

  function commit(command, control = null){
    if(!guardPlanMutation()) return false;
    try{
      const result = commitWizardEdit(command);
      if(result?.refreshError){
        wizardRoot.dataset.validationCode = 'WIZARD_REFRESH_FAILED';
        syncHeaderStatus('Edit applied, but the screen could not refresh');
        return true;
      }
      delete wizardRoot.dataset.validationCode;
      if(control){
        control.removeAttribute('aria-invalid');
        if(typeof control.setCustomValidity === 'function'){
          control.setCustomValidity('');
        }
      }
      return true;
    }catch(error){
      reportError(error, control);
      return false;
    }
  }

  root.addEventListener('input', event => {
    if(event.target.matches?.('[data-tax-field]')){
      event.target.removeAttribute('aria-invalid');
      if(typeof event.target.setCustomValidity === 'function'){
        event.target.setCustomValidity('');
      }
    }
    const draft = event.target.closest('[data-account-draft]');
    if(draft){
      transientState.accountDraft = {
        ...transientState.accountDraft,
        [draft.dataset.accountDraft]: draft.value,
      };
      return;
    }
    if(event.target.classList.contains('hh-tax-amount')
        || event.target.dataset.accountField === 'balance'
        || event.target.dataset.accountField === 'basis'){
      if(event.target.dataset.signed !== 'true') liveCommas(event.target);
    }
  });

  root.addEventListener('change', event => {
    const taxConfirmation = event.target.closest('[data-tax-confirmation]');
    if(taxConfirmation){
      commit({
        scope: 'tax',
        action: taxConfirmation.checked
          ? 'confirm-tax-inputs'
          : 'clear-tax-confirmation',
      }, taxConfirmation);
      return;
    }

    const family = event.target.closest('[data-wizard-scope="family"][data-wizard-field]');
    if(family){
      const priorValue = family.querySelector?.('option[selected]')?.value;
      const applied = commit({
        scope: 'family',
        field: family.dataset.wizardField,
        value: valueFromControl(family),
      }, family);
      if(!applied && priorValue != null) family.value = priorValue;
      return;
    }

    const account = event.target.closest('[data-account-field][data-account-id]');
    if(account){
      commit({
        scope: 'account',
        action: 'update',
        accountId: account.dataset.accountId,
        field: account.dataset.accountField,
        value: valueFromControl(account),
      }, account);
      return;
    }

    const tax = event.target.closest('[data-tax-field]');
    if(tax){
      commit({
        scope: 'tax',
        action: 'set',
        field: tax.dataset.taxField,
        value: valueFromControl(tax),
      }, tax);
    }
  });

  root.addEventListener('click', event => {
    const action = event.target.closest('[data-hh-action]');
    if(!action) return;
    const kind = action.dataset.hhAction;

    if(kind === 'step-back'){
      navigateWizard('back');
      return;
    }
    if(kind === 'step-next'){
      if((transientState.stepId === 'tax'
          || transientState.stepId === 'summary')
          && !canAdvanceTax()){
        const confirmation = wizardRoot.querySelector('[data-tax-confirmation]');
        reportError(
          Object.assign(
            new Error(
              transientState.stepId === 'summary'
                ? 'Complete and confirm the Tax step before entering planning'
                : 'Confirm the current-year Tax entries before continuing',
            ),
            { code: 'CURRENT_1040_TAX_CONFIRMATION_REQUIRED' },
          ),
          confirmation || action,
        );
        return;
      }
      navigateWizard('next');
      return;
    }
    if(kind === 'add-account'){
      if(!guardPlanMutation()) return;
      transientState.accountFormOpen = true;
      transientState.accountDraft = {
        displayName: '',
        typeId: '',
        owner: 'client',
        balance: '',
      };
      syncHousehold();
      return;
    }
    if(kind === 'remove-spouse'){
      if(!guardPlanMutation()) return;
      const command = {
        scope: 'family',
        action: 'remove-spouse',
        confirmed: true,
      };
      try{
        preflightWizardEdit(command);
      }catch(error){
        reportError(error, action);
        return;
      }
      const confirmed = window.confirm(
        'Remove co-client from this household? Co-client identity, Social Security, and tax facts will be discarded.',
      );
      if(!confirmed) return;
      commit(command, action);
      return;
    }
    if(kind === 'cancel-account'){
      transientState.accountFormOpen = false;
      syncHousehold();
      return;
    }
    if(kind === 'save-account'){
      const draft = transientState.accountDraft;
      transientState.accountFormOpen = false;
      if(!commit({
        scope: 'account',
        action: 'add',
        displayName: draft.displayName,
        typeId: draft.typeId,
        owner: draft.owner,
        balance: draft.balance,
      }, action)){
        transientState.accountFormOpen = true;
        syncHousehold();
      }
      return;
    }
    if(kind === 'remove-account'){
      commit({
        scope: 'account',
        action: 'remove',
        accountId: action.dataset.accountId,
      }, action);
      return;
    }
    if(kind === 'set-tax-view'){
      transientState.taxView = action.dataset.taxView;
      syncHousehold();
      return;
    }
    if(kind === 'toggle-tax-menu'){
      transientState.optionalMenuOpen = !transientState.optionalMenuOpen;
      syncHousehold();
      return;
    }
    if(kind === 'show-tax-item'){
      transientState.optionalTaxItems.add(action.dataset.taxItem);
      transientState.optionalMenuOpen = false;
      syncHousehold();
      return;
    }
    if(kind === 'remove-tax-item'){
      const item = action.dataset.taxItem;
      const wasVisible = transientState.optionalTaxItems.delete(item);
      if(!commit({ scope: 'tax', action: 'remove', item }, action)){
        if(wasVisible) transientState.optionalTaxItems.add(item);
        syncHousehold();
      }
      return;
    }
    if(kind === 'override-income-group'){
      commit({
        scope: 'tax',
        action: 'override-income-group',
        groupId: action.dataset.incomeGroup,
      }, action);
      return;
    }
    if(kind === 'revert-income-group'){
      commit({
        scope: 'tax',
        action: 'revert-income-group',
        groupId: action.dataset.incomeGroup,
      }, action);
    }
  });
}

import { readBirthDateGroup, splitIsoBirthDate } from './birthDateInput.js';

function valueFromControl(control){
  if(control.type === 'checkbox') return control.checked;
  if(control.matches?.('[data-birth-date-value]')){
    const group = control.closest('[data-birth-date-group]');
    const iso = group ? readBirthDateGroup(group) : null;
    return iso ?? control.value;
  }
  return control.value;
}

function birthDateValidityControl(control){
  if(!control?.matches?.('[data-birth-date-value]')) return control;
  const group = control.closest('[data-birth-date-group]');
  return group?.querySelector('[data-birth-part="year"]') || control;
}

function clearBirthDateValidity(group){
  if(!group) return;
  for(const part of group.querySelectorAll('[data-birth-part]')){
    part.removeAttribute('aria-invalid');
    if(typeof part.setCustomValidity === 'function') part.setCustomValidity('');
  }
}

function syncBirthDateParts(group, iso){
  if(!group) return;
  const parts = splitIsoBirthDate(iso);
  for(const name of ['month', 'day', 'year']){
    const part = group.querySelector(`[data-birth-part="${name}"]`);
    if(part) part.value = parts[name];
  }
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
  syncHeaderStatus,
  liveCommas,
}){
  if(!root || !wizardRoot) return;

  function reportError(error, control = null){
    const message = error instanceof Error ? error.message : String(error);
    wizardRoot.dataset.validationCode = error?.code || 'WIZARD_EDIT_REJECTED';
    const errorField = error?.field;
    const fieldControl = errorField
      ? Array.from(wizardRoot.querySelectorAll(
        '[data-tax-field], [data-wizard-field]',
      )).find(candidate =>
        candidate.dataset.taxField === errorField
          || candidate.dataset.wizardField === errorField)
      : null;
    const rawTarget = fieldControl || control;
    const target = birthDateValidityControl(rawTarget);
    if(rawTarget?.closest?.('[data-birth-date-group]')){
      clearBirthDateValidity(rawTarget.closest('[data-birth-date-group]'));
    }
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
        if(control.matches?.('[data-birth-date-value]')){
          clearBirthDateValidity(control.closest('[data-birth-date-group]'));
        }else{
          control.removeAttribute('aria-invalid');
          if(typeof control.setCustomValidity === 'function'){
            control.setCustomValidity('');
          }
        }
      }
      return true;
    }catch(error){
      reportError(error, control);
      return false;
    }
  }

  root.addEventListener('input', event => {
    const birthPart = event.target.closest?.('[data-birth-part]');
    if(birthPart){
      const group = birthPart.closest('[data-birth-date-group]');
      clearBirthDateValidity(group);
      const hidden = group?.querySelector('[data-birth-date-value]');
      const iso = group ? readBirthDateGroup(group) : null;
      if(hidden && iso){
        hidden.value = iso;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if(event.target.matches?.('[data-tax-field]')){
      event.target.removeAttribute('aria-invalid');
      if(typeof event.target.setCustomValidity === 'function'){
        event.target.setCustomValidity('');
      }
    }
    const draft = event.target.closest('[data-account-draft]');
    if(draft){
      if(draft.dataset.accountDraft === 'balance') liveCommas(draft);
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

  root.addEventListener('focusin', event => {
    const control = event.target.closest?.(
      '.hh-tax-amount, [data-account-field="balance"], [data-account-field="basis"]',
    );
    if(control && control.dataset.householdCommittedValue === undefined){
      control.dataset.householdCommittedValue = control.value;
    }
  });

  root.addEventListener('focusout', event => {
    const control = event.target.closest?.(
      '.hh-tax-amount, [data-account-field="balance"], [data-account-field="basis"]',
    );
    if(!control || control.dataset.householdCommittedValue === control.value) return;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });

  root.addEventListener('change', event => {
    const family = event.target.closest('[data-wizard-scope="family"][data-wizard-field]');
    if(family){
      const priorValue = family.matches?.('[data-birth-date-value]')
        ? family.value
        : family.querySelector?.('option[selected]')?.value;
      const applied = commit({
        scope: 'family',
        field: family.dataset.wizardField,
        value: valueFromControl(family),
      }, family);
      if(!applied && priorValue != null){
        if(family.matches?.('[data-birth-date-value]')){
          family.value = priorValue;
          syncBirthDateParts(family.closest('[data-birth-date-group]'), priorValue);
        }else{
          family.value = priorValue;
        }
      }
      return;
    }

    const account = event.target.closest('[data-account-field][data-account-id]');
    if(account){
      const applied = commit({
        scope: 'account',
        action: 'update',
        accountId: account.dataset.accountId,
        field: account.dataset.accountField,
        value: valueFromControl(account),
      }, account);
      if(applied) account.dataset.householdCommittedValue = account.value;
      return;
    }

    const tax = event.target.closest('[data-tax-field]');
    if(tax){
      const applied = commit({
        scope: 'tax',
        action: 'set',
        field: tax.dataset.taxField,
        value: valueFromControl(tax),
      }, tax);
      if(applied) tax.dataset.householdCommittedValue = tax.value;
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

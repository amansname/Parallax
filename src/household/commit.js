import {
  birthDateCaretAfterDigits,
  deleteBirthDateDigit,
  formatBirthDateEntry,
  formatIsoBirthDate,
  readBirthDateGroup,
} from './birthDateInput.js';
import { newWizardRowId } from './householdRecordSchema.js';

function valueFromControl(control){
  if(control.type === 'checkbox') return control.checked;
  if(control.matches?.('[data-birth-date-value]')){
    const group = control.closest('[data-birth-date-group]');
    const iso = group ? readBirthDateGroup(group) : null;
    return iso ?? control.value;
  }
  return control.value;
}

function hasDigits(value){
  return /\d/.test(String(value ?? ''));
}

function formatCommittedTaxAmount(control){
  const raw = String(control.value ?? '').trim();
  if(!raw) return;
  const numeric = Number(raw.replace(/[\s,]/g, ''));
  if(!Number.isFinite(numeric)) return;
  control.value = numeric.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatNetWorthCurrency(raw){
  let value = String(raw ?? '').replace(/[^0-9.]/g, '');
  const dot = value.indexOf('.');
  if(dot !== -1){
    value = value.slice(0, dot + 1) + value.slice(dot + 1).replace(/\./g, '');
  }
  if(!value) return '$';
  const parts = value.split('.');
  const integer = parts[0].replace(/^0+(?=\d)/, '') || '0';
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.length > 1
    ? `$${grouped}.${parts[1].slice(0, 2)}`
    : `$${grouped}`;
}

function blankNetWorthDraft(categoryId){
  return {
    categoryId,
    name: '',
    type: '',
    custom: false,
    owner: '',
    link: '',
    linkLabel: '',
    linkAvailable: false,
    value: '$',
    accountTypeId: '',
    canonicalTax: '',
    shellOnly: false,
    owners: ['client', 'spouse', 'joint'],
  };
}

function updateNetWorthDraft(transientState, control){
  const field = control.dataset.netWorthDraft;
  if(!field || !transientState.netWorthDraft) return false;
  let value = control.value;
  if(field === 'value'){
    value = formatNetWorthCurrency(value);
    control.value = value;
  }
  const next = {
    ...transientState.netWorthDraft,
    [field]: value,
  };
  if(field === 'link'){
    const selected = control.selectedOptions?.[0];
    next.linkLabel = selected?.textContent?.trim() || '';
    next.linkAvailable = selected?.dataset.netWorthLinkAvailable === 'true';
    const save = control.closest?.('.nw-panel')
      ?.querySelector('[data-hh-action="net-worth-save-entry"]');
    if(save){
      save.dataset.netWorthResolvedLink = next.linkAvailable ? next.link : '';
      save.dataset.netWorthResolvedLinkLabel = next.linkAvailable ? next.linkLabel : '';
      save.dataset.netWorthResolvedLinkAvailable = next.linkAvailable ? 'true' : 'false';
    }
  }
  const save = control.closest?.('.nw-panel')
    ?.querySelector('[data-hh-action="net-worth-save-entry"]');
  if(save){
    const ownerRequired = save.dataset.netWorthOwnerRequired === 'true';
    const ownerValid = !ownerRequired
      || Boolean(next.owner && next.owners.includes(next.owner));
    const linkRequired = save.dataset.netWorthLinkRequired === 'true';
    const linkValid = !linkRequired
      || (save.dataset.netWorthResolvedLinkAvailable === 'true'
        && Boolean(save.dataset.netWorthResolvedLink));
    save.disabled = !ownerValid || !linkValid;
  }
  transientState.netWorthDraft = next;
  return true;
}

function birthDateValidityControl(control){
  if(!control?.matches?.('[data-birth-date-value]')) return control;
  const group = control.closest('[data-birth-date-group]');
  return group?.querySelector('[data-birth-date-display]') || control;
}

function clearBirthDateValidity(group){
  if(!group) return;
  for(const input of group.querySelectorAll('[data-birth-date-display], [data-birth-part]')){
    input.removeAttribute('aria-invalid');
    if(typeof input.setCustomValidity === 'function') input.setCustomValidity('');
  }
}

function syncBirthDateDisplay(group, iso){
  if(!group) return;
  const display = group.querySelector('[data-birth-date-display]');
  if(display) display.value = formatIsoBirthDate(iso);
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

  function commit(command, control = null, returnResult = false){
    if(!guardPlanMutation()) return false;
    try{
      const result = commitWizardEdit(command);
      if(result?.refreshError){
        wizardRoot.dataset.validationCode = 'WIZARD_REFRESH_FAILED';
        syncHeaderStatus('Edit applied, but the screen could not refresh');
        return returnResult ? result : true;
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
      return returnResult ? result : true;
    }catch(error){
      reportError(error, control);
      return false;
    }
  }

  root.addEventListener('beforeinput', event => {
    const birthDateDisplay = event.target.closest?.('[data-birth-date-display]');
    if(!birthDateDisplay || birthDateDisplay.selectionStart !== birthDateDisplay.selectionEnd){
      return;
    }
    const direction = event.inputType === 'deleteContentBackward'
      ? 'backward'
      : event.inputType === 'deleteContentForward'
        ? 'forward'
        : null;
    if(!direction) return;

    const caret = birthDateDisplay.selectionStart ?? 0;
    const adjacentIndex = direction === 'backward' ? caret - 1 : caret;
    if(/\d/.test(birthDateDisplay.value[adjacentIndex] || '')) return;
    const edit = deleteBirthDateDigit(birthDateDisplay.value, caret, direction);
    if(!edit) return;

    event.preventDefault();
    birthDateDisplay.value = edit.value;
    birthDateDisplay.setSelectionRange(edit.caret, edit.caret);
    birthDateDisplay.dispatchEvent(new Event('input', { bubbles: true }));
  });

  root.addEventListener('input', event => {
    const birthDateDisplay = event.target.closest?.('[data-birth-date-display]');
    if(birthDateDisplay){
      const selectionStart = birthDateDisplay.selectionStart ?? birthDateDisplay.value.length;
      const digitsBeforeCaret = (birthDateDisplay.value
        .slice(0, selectionStart)
        .match(/\d/g) || []).length;
      const formatted = formatBirthDateEntry(birthDateDisplay.value);
      if(birthDateDisplay.value !== formatted) birthDateDisplay.value = formatted;
      const caret = birthDateCaretAfterDigits(formatted, digitsBeforeCaret);
      birthDateDisplay.setSelectionRange(caret, caret);

      const group = birthDateDisplay.closest('[data-birth-date-group]');
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
    const netWorthDraft = event.target.closest?.('[data-net-worth-draft]');
    if(netWorthDraft){
      updateNetWorthDraft(transientState, netWorthDraft);
      return;
    }
    if(event.target.classList.contains('hh-tax-amount')){
      if(event.target.dataset.signed !== 'true') liveCommas(event.target);
    }
  });

  root.addEventListener('focusin', event => {
    const control = event.target.closest?.('.hh-tax-amount');
    if(control && control.dataset.householdCommittedValue === undefined){
      control.dataset.householdCommittedValue = control.value;
    }
  });

  root.addEventListener('focusout', event => {
    // Replacing the wizard view blurs its focused control while the old DOM is
    // being removed. Do not turn that teardown blur into a nested edit/render.
    if(root.dataset.wizardReady === 'false') return;
    const control = event.target.closest?.('.hh-tax-amount');
    if(control) formatCommittedTaxAmount(control);
    if(!control || control.dataset.householdCommittedValue === control.value) return;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });

  root.addEventListener('change', event => {
    const netWorthDraft = event.target.closest?.('[data-net-worth-draft]');
    if(netWorthDraft){
      updateNetWorthDraft(transientState, netWorthDraft);
      return;
    }

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
          syncBirthDateDisplay(family.closest('[data-birth-date-group]'), priorValue);
        }else{
          family.value = priorValue;
        }
      }
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
    if(action.disabled || action.getAttribute('aria-disabled') === 'true') return;
    const kind = action.dataset.hhAction;

    if(kind === 'step-back'){
      navigateWizard('back');
      return;
    }
    if(kind === 'step-next'){
      if(root.dataset.wizardStep === 'tax'){
        const completed = commit({
          scope: 'tax',
          action: 'confirm-tax-inputs',
        }, action);
        if(!completed) return;
      }
      navigateWizard('next');
      return;
    }
    if(kind === 'net-worth-show-summary'){
      transientState.netWorthView = 'summary';
      transientState.netWorthPanelCategory = null;
      transientState.netWorthMoreOpen = false;
      transientState.netWorthDraft = null;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-show-entry'){
      transientState.netWorthView = 'entry';
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-open-category'){
      transientState.netWorthPanelCategory = action.dataset.categoryId;
      transientState.netWorthMoreOpen = false;
      transientState.netWorthDraft = null;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-edit-entry'){
      if(action.dataset.entrySource !== 'account') return;
      const owners = String(action.dataset.owners || '')
        .split(',')
        .filter(Boolean);
      transientState.netWorthPanelCategory = action.dataset.entryCategoryId;
      transientState.netWorthMoreOpen = false;
      transientState.netWorthDraft = {
        categoryId: action.dataset.entryCategoryId,
        name: action.dataset.entryName || '',
        type: action.dataset.entryType || '',
        custom: false,
        owner: action.dataset.entryOwner || '',
        link: '',
        linkLabel: '',
        linkAvailable: false,
        value: formatNetWorthCurrency(action.dataset.entryValue),
        accountTypeId: action.dataset.accountTypeId || '',
        canonicalTax: action.dataset.canonicalTax || '',
        shellOnly: false,
        owners,
        editSource: 'account',
        editId: action.dataset.accountId,
      };
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-close-panel'){
      transientState.netWorthPanelCategory = null;
      transientState.netWorthMoreOpen = false;
      transientState.netWorthDraft = null;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-toggle-more'){
      transientState.netWorthMoreOpen = !transientState.netWorthMoreOpen;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-pick-type'){
      const categoryId = action.dataset.categoryId;
      const current = transientState.netWorthDraft?.categoryId === categoryId
        ? transientState.netWorthDraft
        : blankNetWorthDraft(categoryId);
      const owners = String(action.dataset.owners || '')
        .split(',')
        .filter(Boolean);
      transientState.netWorthDraft = {
        ...current,
        categoryId,
        type: action.dataset.typeLabel || '',
        custom: false,
        owner: owners.includes(current.owner) ? current.owner : '',
        accountTypeId: action.dataset.accountTypeId || '',
        canonicalTax: action.dataset.canonicalTax || '',
        shellOnly: action.dataset.shellOnly === 'true',
        owners,
      };
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-pick-custom'){
      const categoryId = action.dataset.categoryId;
      const current = transientState.netWorthDraft?.categoryId === categoryId
        ? transientState.netWorthDraft
        : blankNetWorthDraft(categoryId);
      transientState.netWorthDraft = {
        ...current,
        categoryId,
        type: '',
        custom: true,
        accountTypeId: '',
        canonicalTax: '',
        shellOnly: true,
        owners: ['client', 'spouse', 'joint'],
      };
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-clear-type'){
      if(!transientState.netWorthDraft) return;
      transientState.netWorthDraft = {
        ...transientState.netWorthDraft,
        type: '',
        custom: false,
        accountTypeId: '',
        canonicalTax: '',
        shellOnly: false,
        owners: ['client', 'spouse', 'joint'],
      };
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-cancel-draft'){
      transientState.netWorthDraft = null;
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-save-entry'){
      if(!guardPlanMutation()) return;
      const currentDraft = transientState.netWorthDraft;
      if(!currentDraft || (!currentDraft.type && !currentDraft.custom)) return;
      const draft = currentDraft.categoryId === 'mortgage'
          && currentDraft.link === ''
          && action.dataset.netWorthResolvedLinkAvailable === 'true'
        ? {
            ...currentDraft,
            link: action.dataset.netWorthResolvedLink || '',
            linkLabel: action.dataset.netWorthResolvedLinkLabel || '',
            linkAvailable: true,
          }
        : currentDraft;
      if(!draft.name && !hasDigits(draft.value)) return;
      const restoreDraft = () => {
        transientState.netWorthDraft = draft;
        syncHousehold();
      };
      transientState.netWorthDraft = null;
      transientState.netWorthMoreOpen = false;

      const isCanonicalAccount = (draft.categoryId === 'bank' || draft.categoryId === 'investment')
        && draft.accountTypeId
        && draft.shellOnly !== true;
      if(isCanonicalAccount && (!draft.owner || !draft.owners.includes(draft.owner))){
        restoreDraft();
        return;
      }
      if(isCanonicalAccount){
        const editingAccount = draft.editSource === 'account' && Boolean(draft.editId);
        const result = commit({
          scope: 'account',
          action: editingAccount ? 'update' : 'add',
          ...(editingAccount
            ? {
                accountId: draft.editId,
                fields: {
                  typeId: draft.accountTypeId,
                  displayName: draft.name,
                  owner: draft.owner,
                  balance: draft.value,
                },
              }
            : {
                displayName: draft.name,
                typeId: draft.accountTypeId,
                owner: draft.owner,
                balance: draft.value,
              }),
        }, action, true);
        if(!result){
          restoreDraft();
          return;
        }
        syncHousehold();
        return;
      }

      if(draft.categoryId === 'property'){
        const result = commit({
          scope: 'property',
          action: 'add',
          name: draft.name,
          type: draft.type,
          owner: draft.owner,
          value: draft.value,
        }, action, true);
        if(!result){
          restoreDraft();
          return;
        }
        syncHousehold();
        return;
      }

      if(draft.categoryId === 'mortgage'
          && draft.link !== ''
          && draft.linkAvailable === true
          && hasDigits(draft.value)){
        const result = commit({
          scope: 'mortgage',
          action: 'set-balance',
          propertyIndex: draft.link,
          name: draft.name,
          type: draft.type,
          owner: draft.owner,
          value: draft.value,
        }, action, true);
        if(!result){
          restoreDraft();
          return;
        }
        syncHousehold();
        return;
      }

      if(draft.categoryId === 'mortgage'){
        restoreDraft();
        return;
      }

      if(!commit({
        scope: 'net-worth',
        action: 'add-shell-entry',
        entry: {
          id: newWizardRowId('net_worth'),
          categoryId: draft.categoryId,
          name: draft.name,
          type: draft.type,
          owner: draft.owner,
          tax: draft.categoryId === 'investment' ? draft.canonicalTax : '',
          value: draft.value,
        },
      }, action)){
        restoreDraft();
        return;
      }
      syncHousehold();
      return;
    }
    if(kind === 'net-worth-remove-entry'){
      if(!guardPlanMutation()) return;
      const source = action.dataset.entrySource;
      if(source === 'shell'){
        commit({
          scope: 'net-worth',
          action: 'remove-shell-entry',
          entryId: action.dataset.shellId,
        }, action);
        return;
      }
      if(source === 'account'){
        const accountId = action.dataset.accountId;
        commit({
          scope: 'account',
          action: 'remove',
          accountId,
        }, action);
        return;
      }
      if(source === 'property'){
        const index = Number(action.dataset.propertyIndex);
        commit({
          scope: 'property',
          action: 'remove',
          propertyIndex: index,
        }, action);
        return;
      }
      if(source === 'mortgage'){
        const index = Number(action.dataset.propertyIndex);
        commit({
          scope: 'mortgage',
          action: 'remove',
          propertyIndex: index,
        }, action);
        return;
      }
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

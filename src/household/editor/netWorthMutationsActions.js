import { hasDigits } from './netWorthDraft.js';
import { newWizardRowId } from '../householdRecordSchema.js';
export function createNetWorthMutationsActions({
  guardPlanMutation,
  transientState,
  syncHousehold,
  commit
}) {
  return {
    'net-worth-save-entry': action => {
      if (!guardPlanMutation()) return;
      const currentDraft = transientState.netWorthDraft;
      if (!currentDraft || !currentDraft.type && !currentDraft.custom) return;
      const draft = currentDraft.categoryId === 'mortgage' && currentDraft.link === '' && action.dataset.netWorthResolvedLinkAvailable === 'true' ? {
        ...currentDraft,
        link: action.dataset.netWorthResolvedLink || '',
        linkLabel: action.dataset.netWorthResolvedLinkLabel || '',
        linkAvailable: true
      } : currentDraft;
      if (!draft.name && !hasDigits(draft.value)) return;
      const restoreDraft = () => {
        transientState.netWorthDraft = draft;
        syncHousehold();
      };
      transientState.netWorthDraft = null;
      transientState.netWorthMoreOpen = false;
      const isCanonicalAccount = (draft.categoryId === 'bank' || draft.categoryId === 'investment') && draft.accountTypeId && draft.shellOnly !== true;
      if (isCanonicalAccount && (!draft.owner || !draft.owners.includes(draft.owner))) {
        restoreDraft();
        return;
      }
      if (isCanonicalAccount) {
        const editingAccount = draft.editSource === 'account' && Boolean(draft.editId);
        const result = commit({
          scope: 'account',
          action: editingAccount ? 'update' : 'add',
          ...(editingAccount ? {
            accountId: draft.editId,
            fields: {
              typeId: draft.accountTypeId,
              displayName: draft.name,
              owner: draft.owner,
              balance: draft.value,
              ...(draft.allocationSelectionChanged && draft.allocationPresetId ? {
                allocationPresetId: draft.allocationPresetId
              } : {})
            }
          } : {
            displayName: draft.name,
            typeId: draft.accountTypeId,
            owner: draft.owner,
            balance: draft.value,
            ...(draft.allocationPresetId ? {
              allocationPresetId: draft.allocationPresetId
            } : {})
          })
        }, action, true);
        if (!result) {
          restoreDraft();
          return;
        }
        syncHousehold();
        return;
      }
      if (draft.categoryId === 'property') {
        const result = commit({
          scope: 'property',
          action: 'add',
          name: draft.name,
          type: draft.type,
          owner: draft.owner,
          value: draft.value
        }, action, true);
        if (!result) {
          restoreDraft();
          return;
        }
        syncHousehold();
        return;
      }
      if (draft.categoryId === 'mortgage' && draft.link !== '' && draft.linkAvailable === true && hasDigits(draft.value)) {
        const result = commit({
          scope: 'mortgage',
          action: 'set-balance',
          propertyIndex: draft.link,
          name: draft.name,
          type: draft.type,
          owner: draft.owner,
          value: draft.value
        }, action, true);
        if (!result) {
          restoreDraft();
          return;
        }
        syncHousehold();
        return;
      }
      if (draft.categoryId === 'mortgage') {
        restoreDraft();
        return;
      }
      if (!commit({
        scope: 'net-worth',
        action: 'add-shell-entry',
        entry: {
          id: newWizardRowId('net_worth'),
          categoryId: draft.categoryId,
          name: draft.name,
          type: draft.type,
          owner: draft.owner,
          tax: draft.categoryId === 'investment' ? draft.canonicalTax : '',
          value: draft.value
        }
      }, action)) {
        restoreDraft();
        return;
      }
      syncHousehold();
      return;
    },
    'net-worth-remove-entry': action => {
      if (!guardPlanMutation()) return;
      const source = action.dataset.entrySource;
      if (source === 'shell') {
        commit({
          scope: 'net-worth',
          action: 'remove-shell-entry',
          entryId: action.dataset.shellId
        }, action);
        return;
      }
      if (source === 'account') {
        const accountId = action.dataset.accountId;
        commit({
          scope: 'account',
          action: 'remove',
          accountId
        }, action);
        return;
      }
      if (source === 'property') {
        const index = Number(action.dataset.propertyIndex);
        commit({
          scope: 'property',
          action: 'remove',
          propertyIndex: index
        }, action);
        return;
      }
      if (source === 'mortgage') {
        const index = Number(action.dataset.propertyIndex);
        commit({
          scope: 'mortgage',
          action: 'remove',
          propertyIndex: index
        }, action);
        return;
      }
    }
  };
}

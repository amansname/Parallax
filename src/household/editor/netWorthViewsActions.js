import { formatNetWorthCurrency, blankNetWorthDraft } from './netWorthDraft.js';
export function createNetWorthViewsActions({
  transientState,
  syncHousehold
}) {
  return {
    'net-worth-show-summary': () => {
      transientState.netWorthView = 'summary';
      transientState.netWorthPanelCategory = null;
      transientState.netWorthMoreOpen = false;
      transientState.netWorthDraft = null;
      syncHousehold();
      return;
    },
    'net-worth-show-entry': () => {
      transientState.netWorthView = 'entry';
      syncHousehold();
      return;
    },
    'net-worth-open-category': action => {
      transientState.netWorthPanelCategory = action.dataset.categoryId;
      transientState.netWorthMoreOpen = false;
      transientState.netWorthDraft = null;
      syncHousehold();
      return;
    },
    'net-worth-edit-entry': action => {
      if (action.dataset.entrySource !== 'account') return;
      const owners = String(action.dataset.owners || '').split(',').filter(Boolean);
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
        allocationPresetId: action.dataset.entryAllocationPresetId || '',
        initialAllocationPresetId: action.dataset.entryAllocationPresetId || '',
        allocationSelectionChanged: false,
        canonicalTax: action.dataset.canonicalTax || '',
        shellOnly: false,
        owners,
        editSource: 'account',
        editId: action.dataset.accountId
      };
      syncHousehold();
      return;
    },
    'net-worth-close-panel': () => {
      transientState.netWorthPanelCategory = null;
      transientState.netWorthMoreOpen = false;
      transientState.netWorthDraft = null;
      syncHousehold();
      return;
    },
    'net-worth-toggle-more': () => {
      transientState.netWorthMoreOpen = !transientState.netWorthMoreOpen;
      syncHousehold();
      return;
    },
    'net-worth-pick-type': action => {
      const categoryId = action.dataset.categoryId;
      const current = transientState.netWorthDraft?.categoryId === categoryId ? transientState.netWorthDraft : blankNetWorthDraft(categoryId);
      const owners = String(action.dataset.owners || '').split(',').filter(Boolean);
      transientState.netWorthDraft = {
        ...current,
        categoryId,
        type: action.dataset.typeLabel || '',
        custom: false,
        owner: owners.includes(current.owner) ? current.owner : '',
        accountTypeId: action.dataset.accountTypeId || '',
        allocationPresetId: action.dataset.allocationEligible === 'true' && current.editSource !== 'account' ? current.allocationPresetId || 'balanced' : current.allocationPresetId || '',
        canonicalTax: action.dataset.canonicalTax || '',
        shellOnly: action.dataset.shellOnly === 'true',
        owners
      };
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    },
    'net-worth-pick-custom': action => {
      const categoryId = action.dataset.categoryId;
      const current = transientState.netWorthDraft?.categoryId === categoryId ? transientState.netWorthDraft : blankNetWorthDraft(categoryId);
      transientState.netWorthDraft = {
        ...current,
        categoryId,
        type: '',
        custom: true,
        accountTypeId: '',
        allocationPresetId: '',
        initialAllocationPresetId: '',
        allocationSelectionChanged: false,
        canonicalTax: '',
        shellOnly: true,
        owners: ['client', 'spouse', 'joint']
      };
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    },
    'net-worth-clear-type': () => {
      if (!transientState.netWorthDraft) return;
      transientState.netWorthDraft = {
        ...transientState.netWorthDraft,
        type: '',
        custom: false,
        accountTypeId: '',
        canonicalTax: '',
        shellOnly: false,
        owners: ['client', 'spouse', 'joint']
      };
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    },
    'net-worth-cancel-draft': () => {
      transientState.netWorthDraft = null;
      transientState.netWorthMoreOpen = false;
      syncHousehold();
      return;
    }
  };
}

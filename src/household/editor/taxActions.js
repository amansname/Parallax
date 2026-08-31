export function createTaxActions({
  transientState,
  syncHousehold,
  commit
}) {
  return {
    'set-tax-view': action => {
      transientState.taxView = action.dataset.taxView;
      syncHousehold();
      return;
    },
    'toggle-tax-menu': () => {
      transientState.optionalMenuOpen = !transientState.optionalMenuOpen;
      syncHousehold();
      return;
    },
    'show-tax-item': action => {
      transientState.optionalTaxItems.add(action.dataset.taxItem);
      transientState.optionalMenuOpen = false;
      syncHousehold();
      return;
    },
    'remove-tax-item': action => {
      const item = action.dataset.taxItem;
      const wasVisible = transientState.optionalTaxItems.delete(item);
      if (!commit({
        scope: 'tax',
        action: 'remove',
        item
      }, action)) {
        if (wasVisible) transientState.optionalTaxItems.add(item);
        syncHousehold();
      }
      return;
    },
    'override-income-group': action => {
      commit({
        scope: 'tax',
        action: 'override-income-group',
        groupId: action.dataset.incomeGroup
      }, action);
      return;
    },
    'revert-income-group': action => {
      commit({
        scope: 'tax',
        action: 'revert-income-group',
        groupId: action.dataset.incomeGroup
      }, action);
    }
  };
}

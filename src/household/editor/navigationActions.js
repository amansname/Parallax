export function createNavigationActions({
  navigateWizard,
  root,
  commit
}) {
  return {
    'step-back': () => {
      navigateWizard('back');
      return;
    },
    'step-next': action => {
      if (root.dataset.wizardStep === 'tax') {
        const completed = commit({
          scope: 'tax',
          action: 'confirm-tax-inputs'
        }, action);
        if (!completed) return;
      }
      navigateWizard('next');
      return;
    }
  };
}

export function createFamilyActions({
  guardPlanMutation,
  preflightWizardEdit,
  reportError,
  commit
}) {
  return {
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

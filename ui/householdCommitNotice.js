// Presentation only: save failure comes from the existing persistence owner.
export function renderHouseholdCommitNotice(root, { activeHouseholdId, saveFailed, refreshFailed, explicitSavePending }){
  const workspace = root?.querySelector?.('.hh-wiz-workspace');
  if(!workspace || !root.ownerDocument?.createElement) return;
  let notice = root.querySelector('[data-household-commit-notice]');
  const message = !activeHouseholdId ? '' : saveFailed
    ? explicitSavePending
      ? 'Could not save to this browser. Keep this editor open and use Retry Save when storage is available.'
      : 'Automatic save failed · storage blocked or full. Keep this page open. Make another edit to retry saving.'
    : refreshFailed ? 'Edit applied, but the screen could not refresh. Select the current step again to refresh the form.' : '';
  if(!notice && !message) return;
  if(!notice){
    notice = root.ownerDocument.createElement('p');
    notice.className = 'hh-commit-notice';
    notice.id = 'hh-commit-notice';
    notice.dataset.householdCommitNotice = '';
    notice.setAttribute('role', 'alert');
    notice.setAttribute('aria-atomic', 'true');
  }
  const container = explicitSavePending && root.querySelector(explicitSavePending.kind === 'finance'
    ? '.hh-finance-amount-row' : '.nw-panel-footer') || workspace;
  if(notice.parentElement !== container) container.prepend(notice);
  notice.toggleAttribute('data-household-explicit-save', Boolean(explicitSavePending));
  notice.hidden = !message;
  if(notice.textContent !== message) notice.textContent = message;
}

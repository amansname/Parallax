// Presentation only: save failure comes from the existing persistence owner.
export function renderHouseholdCommitNotice(root, { activeHouseholdId, saveFailed, refreshFailed }){
  const workspace = root?.querySelector?.('.hh-wiz-workspace');
  if(!workspace || !root.ownerDocument?.createElement) return;
  let notice = workspace.querySelector('[data-household-commit-notice]');
  const message = !activeHouseholdId ? '' : saveFailed
    ? 'Automatic save failed · storage blocked or full. Keep this page open. Make another edit to retry saving.'
    : refreshFailed ? 'Edit applied, but the screen could not refresh. Select the current step again to refresh the form.' : '';
  if(!notice && !message) return;
  if(!notice){
    notice = root.ownerDocument.createElement('p');
    notice.className = 'hh-commit-notice';
    notice.dataset.householdCommitNotice = '';
    notice.setAttribute('role', 'alert');
    notice.setAttribute('aria-atomic', 'true');
    workspace.prepend(notice);
  }
  notice.hidden = !message;
  if(notice.textContent !== message) notice.textContent = message;
}

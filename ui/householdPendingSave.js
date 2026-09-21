// Freeze an already-applied explicit edit until its persistence retry succeeds.
export function createHouseholdPendingSavePresentation(){
  const previous = new Map();
  let header = null;
  let headerWasInert = false;
  return function sync(root, pending){
    for(const [control, state] of previous){
      if(!control.isConnected) continue;
      control.disabled = state.disabled;
      if(state.text !== undefined){
        control.textContent = state.text;
        if(state.label === null) control.removeAttribute('aria-label');
        else control.setAttribute('aria-label', state.label);
        if(state.description === null) control.removeAttribute('aria-describedby');
        else control.setAttribute('aria-describedby', state.description);
        delete control.dataset.householdRetrySave;
      }
    }
    previous.clear();
    if(header){ header.inert = headerWasInert; header = null; }
    if(!pending) return;
    const action = pending.kind === 'finance' ? 'commit-finance-entry' : 'net-worth-save-entry';
    for(const control of root.querySelectorAll('input, select, textarea, button')){
      const retry = control.dataset.hhAction === action;
      previous.set(control, { disabled: control.disabled, ...(retry ? {
        text: control.textContent, label: control.getAttribute('aria-label'), description: control.getAttribute('aria-describedby'),
      } : {}) });
      control.disabled = !retry;
      if(retry){
        control.textContent = 'Retry Save';
        control.setAttribute('aria-label', 'Retry Save');
        control.setAttribute('aria-describedby', 'hh-commit-notice');
        control.dataset.householdRetrySave = '';
      }
    }
    header = root.ownerDocument.querySelector('.app-header');
    if(header){ headerWasInert = header.inert; header.inert = true; }
    root.querySelector(`[data-hh-action="${action}"]`)?.focus({ preventScroll: true });
  };
}

// Freeze an already-applied explicit edit until its persistence retry succeeds.
export function createHouseholdPendingSavePresentation(){
  const previous = new Map();
  let header = null;
  let headerWasInert = false;
  return function sync(root, pending){
    for(const [control, state] of previous){
      if(!control.isConnected) continue;
      control.disabled = state.disabled;
      if(state.text !== undefined) control.textContent = state.text;
    }
    previous.clear();
    if(header){ header.inert = headerWasInert; header = null; }
    if(!pending) return;
    const action = pending.kind === 'finance' ? 'commit-finance-entry' : 'net-worth-save-entry';
    for(const control of root.querySelectorAll('input, select, textarea, button')){
      const retry = control.dataset.hhAction === action;
      previous.set(control, { disabled: control.disabled, ...(retry ? { text: control.textContent } : {}) });
      control.disabled = !retry;
      if(retry) control.textContent = 'Retry Save';
    }
    header = root.ownerDocument.querySelector('.app-header');
    if(header){ headerWasInert = header.inert; header.inert = true; }
    root.querySelector(`[data-hh-action="${action}"]`)?.focus({ preventScroll: true });
  };
}

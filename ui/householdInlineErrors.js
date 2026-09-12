// Presentation only. The Household command boundary still owns validation.
let nextErrorId = 0;

export function createHouseholdInlineErrors(root){
  const errors = new WeakMap();
  function clear(control){
    const error = control && errors.get(control);
    if(!error) return;
    const describedBy = (control.getAttribute('aria-describedby') || '')
      .split(/\s+/).filter(id => id && id !== error.id);
    if(describedBy.length) control.setAttribute('aria-describedby', describedBy.join(' '));
    else control.removeAttribute('aria-describedby');
    error.remove();
    errors.delete(control);
  }
  function report(control, message){
    if(!root.ownerDocument?.defaultView?.matchMedia('(max-width: 760px), (max-width: 1023px) and (max-height: 500px)').matches
        || !control || !root.contains(control)
        || !control.closest('[data-hh-wizard-screen="family"]')) return false;
    clear(control);
    const error = root.ownerDocument.createElement('span');
    error.id = `hh-inline-error-${++nextErrorId}`;
    error.dataset.householdInlineError = '';
    error.className = 'hh-inline-error';
    error.setAttribute('role', 'alert');
    error.textContent = message;
    const container = control.closest('.hh-field, .hh-finance-entry') || control.parentElement;
    // An error inside an implicit label must not become part of the field name.
    const label = control.labels?.[0];
    const labelText = label?.querySelector('span');
    if(labelText && !control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')){
      if(!labelText.id) labelText.id = `hh-field-label-${++nextErrorId}`;
      control.setAttribute('aria-labelledby', labelText.id);
    }
    container.append(error);
    const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    control.setAttribute('aria-describedby', [...ids, error.id].join(' '));
    errors.set(control, error);
    return true;
  }
  // Editing clears only this field's presentation, never the save/recovery status.
  root.addEventListener('input', event => {
    if(!errors.has(event.target)) return;
    clear(event.target);
    event.target.removeAttribute('aria-invalid');
    event.target.setCustomValidity?.('');
  });
  return { report, clear };
}

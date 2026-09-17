// The canonical renderer supplies both markup and an explicit field model.
// Keep matching controls, including their raw text, errors and event identity.
import { visibleHouseholdTaxControl } from './householdTaxChoices.js';
export function refreshHouseholdTaxFields(view, previous, next){
  if(!previous || !next || !view.ownerDocument?.createElement
      || !view.querySelector('[data-hh-wizard-screen="tax"]')) return null;
  const doc = view.ownerDocument;
  const controls = new Map();
  for(const control of view.querySelectorAll('[data-tax-field]')){
    const key = control.dataset.taxField;
    if(controls.has(key)) throw new Error(`Duplicate mounted Tax field: ${key}`);
    controls.set(key, control);
  }
  if(controls.size !== previous.controls.length
      || previous.controls.some(({ field }) => !controls.has(field))){
    throw new Error('Mounted Tax inventory does not match its presentation model');
  }
  const previousFields = new Map(previous.controls.map(control => [control.field, control]));
  const focused = view.contains(doc.activeElement) ? doc.activeElement : null;
  const focusTarget = focused ? {
    action: focused.dataset.hhAction, group: focused.dataset.incomeGroup,
    item: focused.dataset.taxItem, disclosure: focused.closest('details')?.dataset.mobileTaxGroup,
    taxChoice: focused.dataset.mobileTaxChoice,
  } : null;
  const selection = focused?.tagName === 'INPUT'
    ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  const sameStructure = JSON.stringify(previous.structure) === JSON.stringify(next.structure);
  if(!sameStructure){
    const template = doc.createElement('template');
    template.innerHTML = next.html;
    const incoming = [...template.content.querySelectorAll('[data-tax-field]')];
    if(incoming.length !== next.controls.length
        || incoming.some((control, index) => control.dataset.taxField !== next.controls[index].field)){
      throw new Error('Rendered Tax inventory does not match its presentation model');
    }
    for(const replacement of incoming){
      const control = controls.get(replacement.dataset.taxField);
      if(!control || control.tagName !== replacement.tagName) continue;
      // Keep inline errors through an unrelated conditional-section update.
      const container = replacement.closest('.hh-field, .hh-tax-row') || replacement.parentElement;
      const labelledBy = control.getAttribute('aria-labelledby');
      const label = replacement.closest('label')
        || [...template.content.querySelectorAll('label[for]')].find(node => node.htmlFor === replacement.id);
      const newLabel = label?.querySelector('span');
      if(labelledBy && newLabel) newLabel.id = labelledBy;
      for(const id of (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)){
        const error = doc.getElementById(id);
        if(error?.hasAttribute('data-household-inline-error')) container.append(error);
      }
      if(control.tagName === 'SELECT') control.replaceChildren(...replacement.children);
      replacement.replaceWith(control);
    }
    view.replaceChildren(template.content);
  }
  for(const nextField of next.controls){
    const control = controls.get(nextField.field);
    if(!control?.isConnected) continue;
    const prior = previousFields.get(nextField.field);
    const hasRawEdit = prior && control.tagName === 'INPUT'
      && control.value !== prior.value && control.value !== nextField.value;
    const sourceChanged = prior && prior.disabled !== nextField.disabled;
    if(!hasRawEdit || control.disabled || nextField.disabled) control.value = nextField.value;
    if(sourceChanged){
      control.removeAttribute('aria-invalid');
      control.setCustomValidity?.('');
      const descriptions = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      const retained = descriptions.filter(id => {
        const error = doc.getElementById(id);
        if(!error?.hasAttribute('data-household-inline-error')) return true;
        error.remove(); return false;
      });
      if(retained.length) control.setAttribute('aria-describedby', retained.join(' '));
      else control.removeAttribute('aria-describedby');
    }
    control.disabled = nextField.disabled;
    if(nextField.disabled) control.setAttribute('aria-disabled', 'true');
    else control.removeAttribute('aria-disabled');
    if(nextField.signed) control.dataset.signed = 'true';
    else delete control.dataset.signed;
    if(!hasRawEdit || sourceChanged) control.dataset.householdCommittedValue = control.value;
  }
  const readiness = view.querySelector('.hh-tax-readiness');
  if(readiness){
    readiness.dataset.taxReadiness = next.readiness.status;
    readiness.dataset.taxReason = next.readiness.reason;
    readiness.hidden = next.readiness.status !== 'ready';
    readiness.replaceChildren();
    if(!readiness.hidden){
      const dot = doc.createElement('span'); dot.className = 'hh-status-dot';
      readiness.append(dot, ' Tax inputs are ready');
    }
  }
  return { focused, focusTarget, selection, replaced: !sameStructure };
}

export function restoreHouseholdTaxFocus(update, root){
  let control = update?.focused;
  if(!control?.isConnected || !root.contains(control)){
    const target = update?.focusTarget;
    if(!target) return;
    if(target.taxChoice){
      control = [...root.querySelectorAll('[data-mobile-tax-choice]')].find(node => node.dataset.mobileTaxChoice === target.taxChoice);
    }else if(target.group){
      control = [...root.querySelectorAll('[data-income-group]')].find(node => node.dataset.incomeGroup === target.group);
    }else if(target.item && target.action === 'show-tax-item'){
      control = [...root.querySelectorAll('[data-tax-optional]')]
        .find(node => node.dataset.taxOptional === target.item)?.querySelector('[data-tax-field]');
    }else if(target.action){
      control = [...root.querySelectorAll('[data-hh-action]')].find(node => node.dataset.hhAction === target.action && !target.item)
        || root.querySelector('[data-hh-action="toggle-tax-menu"]');
    }else if(target.disclosure){
      control = [...root.querySelectorAll('[data-mobile-tax-group]')]
        .find(node => node.dataset.mobileTaxGroup === target.disclosure)?.querySelector('summary');
    }
    if(!control) return;
  }
  control = visibleHouseholdTaxControl(control, root);
  for(let parent = control.parentElement; parent && parent !== root; parent = parent.parentElement){
    if(parent.matches('details')) parent.open = true;
  }
  control.focus({ preventScroll: true });
  if(update.selection && control.tagName === 'INPUT') control.setSelectionRange(...update.selection);
}

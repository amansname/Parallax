function one(root, selector){
  const nodes = root.querySelectorAll(selector);
  if(nodes.length !== 1) throw new Error(`Family update expected one ${selector}; found ${nodes.length}`);
  return nodes[0];
}

function fragment(view, html){
  const template = view.ownerDocument.createElement('template');
  template.innerHTML = html;
  return template.content;
}

export function replaceHouseholdFinanceRail(view, html){
  const current = one(view, '[data-finances-rail]');
  const replacement = one(fragment(view, html), '[data-finances-rail]');
  current.replaceWith(replacement);
}

function familyControls(root){
  const controls = new Map();
  for(const control of root.querySelectorAll('[data-wizard-scope="family"][data-wizard-field], [data-birth-date-display]')){
    const key = control.dataset.wizardField
      || `birth-date-display:${control.closest('[data-birth-date-group]')?.dataset.birthDateGroup}`;
    if(controls.has(key)) throw new Error(`Duplicate Family control: ${key}`);
    controls.set(key, control);
  }
  return controls;
}

// Ordinary field commits must not remove the next pointer/keyboard target.
// Read canonical presentation from the same renderer, keeping controls mounted.
export function refreshHouseholdFamilyFields(view, html){
  const current = one(view, '[data-hh-wizard-screen="family"]');
  const replacement = one(fragment(view, html), '[data-hh-wizard-screen="family"]');
  const controls = familyControls(current);
  const nextControls = familyControls(replacement);
  if(controls.size !== nextControls.size || [...controls.keys()].some(key => !nextControls.has(key))){
    throw new Error('Nonstructural Family update changed its control inventory');
  }
  const textSelectors = [
    '[data-hh-age]', '.hh-finances-person-name', '.hh-finances-person-copy small',
    '[data-savings-replacement] h3', '[data-savings-replacement] p',
  ];
  const textUpdates = textSelectors.flatMap(selector => {
    const before = [...current.querySelectorAll(selector)];
    const after = [...replacement.querySelectorAll(selector)];
    if(before.length !== after.length) throw new Error(`Family update changed ${selector} inventory`);
    return before.map((node, index) => [node, after[index].textContent]);
  });
  for(const [key, control] of controls){
    const value = nextControls.get(key).value;
    if(control.value !== value) control.value = value;
  }
  for(const [node, text] of textUpdates){
    if(node.textContent !== text) node.textContent = text;
  }
  const panel = current.querySelector('[data-finance-entry-panel]');
  if(panel) panel.setAttribute('aria-label', one(replacement, '[data-finance-entry-panel]').getAttribute('aria-label'));
}

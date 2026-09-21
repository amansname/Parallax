// Reorder the existing draft controls; the production draft remains the owner.
export function createHouseholdAccountMobilePresentation(){
  const forms = new WeakMap();
  return {
    sync(root, mobile){
      const panel = root.querySelector('.nw-panel');
      if(!panel) return;
      const form = panel.querySelector('.nw-form');
      const heading = panel.querySelector('h2');
      const back = panel.querySelector('.nw-panel-close');
      heading.dataset.categoryTitle ||= heading.textContent;
      heading.textContent = mobile && form ? 'Account details' : heading.dataset.categoryTitle;
      back.setAttribute('aria-label', mobile ? 'Back to Net Worth' : 'Close');
      if(!form) return;
      const focused = form.contains(form.ownerDocument.activeElement) ? form.ownerDocument.activeElement : null;
      const selection = focused?.tagName === 'INPUT' && focused.type === 'text'
        ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
      const restoreFocus = () => {
        if(!focused?.isConnected) return;
        focused.focus({ preventScroll: true });
        if(selection) focused.setSelectionRange(...selection);
      };
      const prior = forms.get(form);
      if(prior){
        if(mobile) return;
        for(const { node, parent, next } of prior.moves.toReversed()){
          parent.insertBefore(node, next?.parentNode === parent ? next : null);
        }
        prior.valueLabel.textContent = prior.valueText;
        prior.layout.remove();
        forms.delete(form);
        restoreFocus();
        return;
      }
      if(!mobile) return;
      const grid = form.querySelector('.nw-form-grid');
      const name = grid.querySelector('[data-net-worth-draft="name"]').closest('label');
      const value = grid.querySelector('[data-net-worth-draft="value"]').closest('label');
      const owner = grid.querySelector('[data-net-worth-draft="owner"]').closest('label');
      const type = form.querySelector('.nw-type-selection');
      const doc = form.ownerDocument;
      const moves = [];
      const move = (node, parent) => {
        moves.push({ node, parent: node.parentNode, next: node.nextSibling });
        parent.append(node);
      };
      const layout = doc.createElement('div'); layout.className = 'nw-mobile-account-fields';
      const meta = doc.createElement('div'); meta.className = 'nw-mobile-account-meta';
      const typeField = doc.createElement('div'); typeField.className = 'nw-field nw-mobile-account-type';
      const typeLabel = doc.createElement('span'); typeLabel.textContent = 'Type';
      typeField.append(typeLabel);
      const valueLabel = value.querySelector('span');
      const valueText = valueLabel.textContent;
      valueLabel.textContent = 'Current value';
      form.prepend(layout);
      move(name, layout);
      move(value, layout);
      layout.append(meta);
      meta.append(typeField);
      move(type, typeField);
      move(owner, meta);
      forms.set(form, { moves, layout, valueLabel, valueText });
      restoreFocus();
    },
  };
}

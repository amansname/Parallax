// Responsive presentation over the existing Household controls and commands.
// Moving a control changes neither its canonical field nor its event binding.
export const HOUSEHOLD_MOBILE_QUERY = '(max-width: 760px), (max-width: 1023px) and (max-height: 500px)';

export function createHouseholdMobilePresentation(){
  let root = null;
  let media = null;
  let householdId = null;
  let selectedOwner = 'client';
  let priorPeople = 0;
  let detailOpen = false;
  let detailTrigger = null;

  function orderChildren(parent, mobileOrder, desktopOrder){
    // Resolve the current nodes on every render. Finance-only updates replace
    // their rail, so retaining earlier nodes would resurrect a stale editor.
    const order = media.matches ? mobileOrder : desktopOrder;
    if(order.every((node, index) => parent.children[index] === node)) return;
    const focused = parent.ownerDocument.activeElement;
    const restoreFocus = parent.contains(focused);
    for(const node of order) parent.append(node);
    if(restoreFocus) focused.focus({ preventScroll: true });
  }

  function familyPresentation(){
    const family = root.querySelector('[data-hh-wizard-screen="family"]');
    if(!family) return;
    const people = [...family.querySelectorAll('[data-person-owner]')];
    if(!people.some(person => person.dataset.personOwner === selectedOwner)) selectedOwner = 'client';
    if(priorPeople === 1 && people.length === 2) selectedOwner = 'spouse';
    priorPeople = people.length;
    let tabs = family.querySelector('[data-mobile-family-members]');
    if(!tabs){
      tabs = family.ownerDocument.createElement('div');
      tabs.className = 'hh-mobile-members';
      tabs.dataset.mobileFamilyMembers = '';
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', 'Family member');
      family.prepend(tabs);
    }
    tabs.hidden = !media.matches || people.length < 2;
    for(const person of people){
      const owner = person.dataset.personOwner;
      let button = tabs.querySelector(`[data-mobile-person="${owner}"]`);
      if(!button){
        button = family.ownerDocument.createElement('button');
        button.type = 'button';
        button.dataset.mobilePerson = owner;
        tabs.append(button);
      }
      button.textContent = person.querySelector('input[data-wizard-field$="Name"]')?.value || (owner === 'client' ? 'You' : 'Spouse');
      button.setAttribute('aria-pressed', String(selectedOwner === owner));
      person.hidden = media.matches && selectedOwner !== owner;
      const fields = person.querySelector('.hh-person-fields');
      const byClass = name => fields.querySelector(`.hh-field--${name}`);
      const desired = ['name', 'date', 'age', 'retirement', 'plan-end', 'status', 'social-security'].map(byClass);
      if(desired.some(node => !node)) throw new Error('Mobile Family field inventory is incomplete');
      orderChildren(fields, desired,
        ['name', 'date', 'age', 'status', 'retirement', 'social-security', 'plan-end'].map(byClass));
    }
    for(const button of tabs.querySelectorAll('[data-mobile-person]')){
      if(!people.some(person => person.dataset.personOwner === button.dataset.mobilePerson)) button.remove();
    }
    for(const label of family.querySelectorAll('[data-mobile-label]')){
      if(!label.dataset.desktopLabel) label.dataset.desktopLabel = label.textContent;
      label.textContent = media.matches ? label.dataset.mobileLabel : label.dataset.desktopLabel;
    }
    const intro = family.querySelector('.hh-screen-intro');
    const peopleContainer = family.querySelector('.hh-family-people');
    const finance = family.querySelector('[data-finances-rail]');
    const filing = family.querySelector('.hh-form-section');
    const add = family.querySelector('[data-hh-action="add-spouse"]');
    orderChildren(family, [tabs, intro, peopleContainer, add, finance, filing].filter(Boolean),
      [tabs, intro, finance, peopleContainer, add, filing].filter(Boolean));
  }

  function sync(nextRoot = root){
    if(!nextRoot?.ownerDocument?.defaultView?.matchMedia) return;
    root = nextRoot;
    if(!media){
      media = root.ownerDocument.defaultView.matchMedia(HOUSEHOLD_MOBILE_QUERY);
      media.addEventListener('change', () => sync());
      root.addEventListener('click', event => {
        const member = event.target.closest('[data-mobile-person]');
        if(member){ selectedOwner = member.dataset.mobilePerson; familyPresentation(); }
        if(event.target.closest('[data-hh-mobile-navigation]')){
          root.dataset.mobileNavigation = root.dataset.mobileNavigation !== 'true' ? 'true' : 'false';
          if(root.dataset.mobileNavigation === 'true') root.ownerDocument.querySelector('.htab[aria-current="page"]')?.focus();
        }
      });
      root.addEventListener('click', event => {
        const trigger = event.target.closest('[data-hh-action]');
        if(trigger && !trigger.closest('.nw-panel')) detailTrigger = { ...trigger.dataset };
      }, true);
    }
    root.dataset.mobileInputs = String(media.matches);
    if(root.dataset.householdId !== householdId){
      householdId = root.dataset.householdId;
      selectedOwner = 'client';
      priorPeople = 0;
      detailOpen = false;
      detailTrigger = null;
    }
    familyPresentation();
    const panel = root.querySelector('.nw-panel');
    if(media.matches && panel && !detailOpen){
      const heading = panel.querySelector('h2');
      if(heading){ heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      panel.scrollIntoView({ block: 'start' });
    }
    if(media.matches && !panel && detailOpen && detailTrigger){
      const trigger = [...root.querySelectorAll('[data-hh-action]')].find(button =>
        Object.entries(detailTrigger).every(([key, value]) => button.dataset[key] === value));
      trigger?.focus({ preventScroll: true });
    }
    detailOpen = Boolean(panel);
  }
  return { sync };
}

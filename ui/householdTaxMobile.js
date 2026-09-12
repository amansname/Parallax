// Recompose the mounted Tax inputs. No duplicate fields or tax calculations.
export function createHouseholdTaxMobilePresentation(){
  const screens = new WeakMap();
  let householdId = null;
  let expanded = new Set();

  function sync(root, mobile, nextHouseholdId){
    if(householdId !== nextHouseholdId){ householdId = nextHouseholdId; expanded = new Set(); }
    const screen = root.querySelector('[data-hh-wizard-screen="tax"]');
    if(!screen) return;
    const previous = screens.get(screen);
    if(previous){
      if(mobile) return;
      for(const { node, parent, next } of previous.moves.toReversed()){
        parent.insertBefore(node, next?.parentNode === parent ? next : null);
      }
      previous.layout.remove();
      screens.delete(screen);
      return;
    }
    if(!mobile) return;
    const doc = screen.ownerDocument;
    const moves = [];
    const create = (tag, className, text = '') => {
      const node = doc.createElement(tag); node.className = className; node.textContent = text; return node;
    };
    const move = (node, parent) => {
      if(!node) return;
      moves.push({ node, parent: node.parentNode, next: node.nextSibling }); parent.append(node);
    };
    const layout = create('div', 'hh-mobile-tax');
    screen.append(layout);
    const disclosure = (key, title) => {
      const details = create('details', 'hh-mobile-tax-details');
      details.dataset.mobileTaxGroup = key;
      details.open = expanded.has(key);
      details.append(create('summary', '', title));
      const body = create('div', 'hh-mobile-tax-detail-body'); details.append(body);
      details.addEventListener('toggle', () => {
        if(!details.isConnected) return;
        if(details.open) expanded.add(key); else expanded.delete(key);
      });
      layout.append(details); return body;
    };
    const profile = create('div', 'hh-mobile-tax-profile');
    profile.append(create('h2', '', 'Tax profile'));
    move(screen.querySelector('[data-tax-summary-box="tax-year"]'), profile);
    layout.append(profile);
    const context = create('button', 'hh-mobile-tax-context');
    context.type = 'button';
    const filing = screen.querySelector('[data-tax-summary-box="filing-status"]');
    context.textContent = `${filing.querySelector('strong').textContent} · ${filing.dataset.taxState || 'Set state of residence'} ›`;
    context.addEventListener('click', () => root.querySelector('[data-hh-wizard-nav="family"]').click());
    layout.append(context);

    const investments = create('section', 'hh-mobile-tax-investments');
    investments.append(create('h2', '', 'Investment income'));
    const table = create('div', 'hh-tax-table'); investments.append(table); layout.append(investments);
    const interest = screen.querySelector('[data-tax-row="income.taxableInterest"]');
    move(screen.querySelector('[data-tax-row="income.taxExemptInterest"] .hh-tax-source'), interest.querySelector('.hh-tax-row-label'));
    move(interest, table);
    move(screen.querySelector('[data-tax-row="income.qualifiedDividends"]'), table);
    const income = disclosure('income', 'Other income');
    const incomeTable = create('div', 'hh-tax-table'); income.append(incomeTable);
    const socialRows = [];
    for(const row of screen.querySelectorAll('.hh-tax-section > .hh-tax-table > .hh-tax-row')){
      if(['income.socialSecurityBenefits', 'income.taxableSS'].includes(row.dataset.taxRow)) socialRows.push(row);
      else move(row, incomeTable);
    }
    const social = disclosure('social-security', 'Social Security tax facts');
    const socialTable = create('div', 'hh-tax-table'); social.append(socialTable);
    for(const row of socialRows) move(row, socialTable);
    move(screen.querySelector('.hh-tax-subsection'), social);
    move(screen.querySelector('[data-tax-planning-social-security]'), social);
    const deductions = create('section', 'hh-mobile-tax-deductions');
    deductions.append(create('h2', '', 'Deductions'));
    move(screen.querySelector('[data-tax-summary-box="deduction-method"]'), deductions);
    move(screen.querySelector('.hh-itemized-section, .hh-supplied-deduction'), deductions);
    layout.append(deductions);
    move(screen.querySelector('.hh-irmaa-lookback'), disclosure('irmaa', 'IRMAA lookback'));
    const optional = disclosure('other', 'Other tax items');
    for(const section of screen.querySelectorAll('.hh-tax-optional')) move(section, optional);
    move(screen.querySelector('.hh-tax-add-wrap'), optional);
    // Capture the actual open state before the command handler replaces Tax.
    screen.addEventListener('change', () => {
      for(const details of layout.querySelectorAll('details')){
        if(details.open) expanded.add(details.dataset.mobileTaxGroup);
        else expanded.delete(details.dataset.mobileTaxGroup);
      }
    }, true);
    screens.set(screen, { layout, moves });
  }
  return { sync };
}

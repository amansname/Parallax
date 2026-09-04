// Wizard browser contract: family.
import { requireCondition } from './assertions.mjs';
import {
  clickWizardAction,
  goToWizardStep,
  openNetWorthCategory,
  reloadWizard,
  setWizardValue,
  waitForWizard,
  wizardState,
} from './actions.mjs';

async function replaceFinanceAmount(page, value) {
  await page.focus('[data-finance-amount]');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.type('[data-finance-amount]', value);
}

export async function verifyFamilyPropagation(page) {
  await goToWizardStep(page, 'family');
  await setWizardValue(page, '[data-wizard-field="client.birthDate"]', '1960-01-01');
  await setWizardValue(page, '[data-wizard-field="filingStatus"]', 'marriedFilingJointly');
  const family = await page.evaluate(() => ({
    people: document.querySelectorAll('[data-person-owner]').length,
    spouse: document.querySelectorAll('[data-person-owner="spouse"]').length
  }));
  requireCondition(family.people === 2 && family.spouse === 1, `MFJ did not render the co-client: ${JSON.stringify(family)}`);
  await setWizardValue(page, '[data-wizard-field="spouse.birthDate"]', '1961-01-01');

  const verifyFinanceEntry = async () => {
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-account-type-id="401k"]',
  );
  await setWizardValue(page, '[data-net-worth-draft="name"]', 'Verifier 401(k)', {
    expectRevision: false,
    eventType: 'input',
  });
  await setWizardValue(page, '[data-net-worth-draft="owner"]', 'client', {
    expectRevision: false,
  });
  await setWizardValue(page, '[data-net-worth-draft="value"]', '0', {
    expectRevision: false,
    eventType: 'input',
  });
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const client401k = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return db?.[active]?.portfolio?.extraAccounts?.find(account => (
      account.typeId === '401k' && account.owner === 'client'
    )) || null;
  });
  requireCondition(
    client401k?.id && client401k.balance === 0,
    `Client-owned 401(k) contribution destination was not saved: ${JSON.stringify(client401k)}`,
  );
  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  await goToWizardStep(page, 'family');

  const closedFinanceEntry = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-person-owner]')]
      .map(card => {
        const rect = card.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
        };
      });
    const rail = document.querySelector('[data-finances-rail]');
    const railRect = rail?.getBoundingClientRect();
    const railStyle = rail ? getComputedStyle(rail) : null;
    const railHead = document.querySelector('.hh-finances-rail-head');
    const railHeadStyle = railHead ? getComputedStyle(railHead) : null;
    const toggle = document.querySelector('[data-hh-action="toggle-finances-rail"]');
    const socialSecurityLabels = [...document.querySelectorAll('[data-wizard-field$=".socialSecurityAge"]')]
      .map(control => control.closest('label')?.querySelector('span')?.textContent.trim() || '');
    return {
      panels: document.querySelectorAll('[data-finance-entry-panel]').length,
      amounts: document.querySelectorAll('[data-finance-amount]').length,
      people: document.querySelectorAll('[data-finances-person-owner]').length,
      header: document.querySelector('.hh-finances-rail-head > span')?.textContent.trim() || '',
      expanded: toggle?.getAttribute('aria-expanded'),
      railWidth: railRect?.width || 0,
      railHeight: railRect?.height || 0,
      railBorders: railStyle ? [
        railStyle.borderTopWidth,
        railStyle.borderRightWidth,
        railStyle.borderBottomWidth,
        railStyle.borderLeftWidth,
      ] : [],
      railShadow: railStyle?.boxShadow || '',
      railHeadDivider: railHeadStyle?.borderBottomWidth || '',
      cards,
      socialSecurityLabels,
      benefitFields: document.querySelectorAll('[data-wizard-field$=".socialSecurityBenefit"]').length,
      benefitCopy: [...document.querySelectorAll('[data-person-owner] span')]
        .filter(node => /Annual Social Security at full retirement age/i.test(node.textContent)).length,
      dependents: document.querySelectorAll('[data-wizard-field="dependents"]').length,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewportWidth: innerWidth,
    };
  });
  const [firstCard, secondCard] = closedFinanceEntry.cards;
  const cardsDoNotOverlap = Boolean(firstCard && secondCard && (
    firstCard.right <= secondCard.left + 1 || firstCard.bottom <= secondCard.top + 1
  ));
  const desktopReferenceGeometry = closedFinanceEntry.viewportWidth <= 1700 || (
    Math.abs(firstCard?.width - 592) <= 1
      && Math.abs(secondCard?.width - 592) <= 1
      && Math.abs(firstCard?.top - secondCard?.top) <= 1
  );
  requireCondition(
    closedFinanceEntry.panels === 0
      && closedFinanceEntry.amounts === 0
      && closedFinanceEntry.people === 0
      && closedFinanceEntry.header === 'Savings and Income'
      && closedFinanceEntry.expanded === 'false'
      && Math.abs(closedFinanceEntry.railWidth - 326) <= 1
      && Math.abs(closedFinanceEntry.railHeight - 72) <= 1
      && closedFinanceEntry.railBorders.every(width => width === '0px')
      && closedFinanceEntry.railShadow === 'none'
      && closedFinanceEntry.railHeadDivider === '0px'
      && closedFinanceEntry.cards.length === 2
      && cardsDoNotOverlap
      && desktopReferenceGeometry
      && JSON.stringify(closedFinanceEntry.socialSecurityLabels) === JSON.stringify([
        'Social Security',
        'Social Security',
      ])
      && closedFinanceEntry.benefitFields === 0
      && closedFinanceEntry.benefitCopy === 0
      && closedFinanceEntry.dependents === 1
      && closedFinanceEntry.documentOverflow <= 1,
    `Family form and compact rail did not begin in the approved collapsed composition: ${JSON.stringify(closedFinanceEntry)}`,
  );
  await clickWizardAction(page, '[data-hh-action="toggle-finances-rail"]');
  await page.waitForFunction(() => {
    const rail = document.querySelector('[data-finances-rail]');
    const expectedHeight = innerWidth <= 1023
      ? innerHeight - 68
      : Math.max(680, innerHeight - 80);
    return document.querySelector('[data-hh-action="toggle-finances-rail"]')
      ?.getAttribute('aria-expanded') === 'true'
      && Math.abs((rail?.getBoundingClientRect().height || 0) - expectedHeight) <= 1;
  }, { timeout: 10000 });
  const openRail = await page.evaluate(beforeCards => {
    const cards = [...document.querySelectorAll('[data-person-owner]')]
      .map(card => {
        const rect = card.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
        };
      });
    const rail = document.querySelector('[data-finances-rail]');
    const railRect = rail?.getBoundingClientRect();
    const summary = document.querySelector('[data-finances-summary]');
    const people = [...document.querySelectorAll('[data-finances-person-owner]')]
      .map(button => ({
        owner: button.dataset.financesPersonOwner,
        name: button.querySelector('.hh-finances-person-name')?.textContent.trim() || '',
        detail: button.querySelector('small')?.textContent.trim() || '',
        fontSize: getComputedStyle(button.querySelector('.hh-finances-person-name')).fontSize,
      }));
    return {
      cards,
      cardsUnchanged: JSON.stringify(cards) === JSON.stringify(beforeCards),
      expanded: document.querySelector('[data-hh-action="toggle-finances-rail"]')
        ?.getAttribute('aria-expanded'),
      header: document.querySelector('.hh-finances-rail-head > span')?.textContent.trim() || '',
      railWidth: railRect?.width || 0,
      railHeight: railRect?.height || 0,
      railLeft: railRect?.left || 0,
      people,
      summaryLabel: summary?.querySelector('span')?.textContent.trim() || '',
      summaryValue: summary?.querySelector('strong')?.textContent.trim() || '',
      panels: document.querySelectorAll('[data-finance-entry-panel]').length,
      benefitFields: document.querySelectorAll('[data-wizard-field$=".socialSecurityBenefit"]').length,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, closedFinanceEntry.cards);
  requireCondition(
    openRail.cardsUnchanged
      && openRail.expanded === 'true'
      && openRail.header === 'Savings and Income'
      && Math.abs(openRail.railWidth - 326) <= 1
      && openRail.railHeight > 600
      && Math.max(...openRail.cards.map(card => card.right)) <= openRail.railLeft + 1
      && JSON.stringify(openRail.people.map(person => person.owner)) === JSON.stringify(['client', 'spouse'])
      && openRail.people.every(person => person.name && person.detail && person.fontSize === '14px')
      && openRail.summaryLabel === 'Savings'
      && /^\$[\d,]+\/yr$/.test(openRail.summaryValue)
      && openRail.panels === 0
      && openRail.benefitFields === 0
      && openRail.documentOverflow <= 1,
    `Open Family rail did not preserve the approved compact composition: ${JSON.stringify(openRail)}`,
  );
  await clickWizardAction(page, '[data-hh-action="toggle-finances-rail"]');
  await page.waitForFunction(() => (
    document.querySelector('[data-hh-action="toggle-finances-rail"]')?.getAttribute('aria-expanded') === 'false'
      && Math.abs((document.querySelector('[data-finances-rail]')?.getBoundingClientRect().height || 0) - 72) <= 1
      && document.querySelectorAll('[data-finances-person-owner]').length === 0
  ), { timeout: 10000 });
  await clickWizardAction(page, '[data-hh-action="toggle-finances-rail"]');
  await page.waitForFunction(() => {
    const rail = document.querySelector('[data-finances-rail]');
    const expectedHeight = innerWidth <= 1023
      ? innerHeight - 68
      : Math.max(680, innerHeight - 80);
    return document.querySelector('[data-hh-action="toggle-finances-rail"]')
      ?.getAttribute('aria-expanded') === 'true'
      && Math.abs((rail?.getBoundingClientRect().height || 0) - expectedHeight) <= 1
      && document.querySelectorAll('[data-finances-person-owner]').length === 2;
  }, { timeout: 10000 });
  await clickWizardAction(page, '[data-finances-person-owner="client"]');
  const savingsPicker = await page.evaluate(() => {
    const list = document.querySelector('.hh-finance-source-list');
    const lastSource = list?.querySelector('button:last-child');
    const listRect = list?.getBoundingClientRect();
    const lastSourceRect = lastSource?.getBoundingClientRect();
    return {
      owner: document.querySelector('[data-finance-entry-panel]')?.dataset.financeOwner || '',
      modes: [...document.querySelectorAll('[data-hh-action="set-finance-mode"]')]
        .map(button => ({ label: button.textContent.trim(), pressed: button.getAttribute('aria-pressed') })),
      sourceSelect: document.querySelector('[data-finance-source-select] span')?.textContent.trim() || '',
      sources: [...document.querySelectorAll('[data-hh-action="select-finance-source"]')]
        .map(button => button.textContent.trim()),
      allSourcesVisible: Boolean(listRect && lastSourceRect && lastSourceRect.bottom <= listRect.bottom + 1),
      amounts: document.querySelectorAll('[data-finance-amount]').length,
      saveLabels: [...document.querySelectorAll('[data-finance-entry-panel] button')]
        .filter(button => button.textContent.trim() === 'Save').length,
    };
  });
  requireCondition(
    savingsPicker.owner === 'client'
      && JSON.stringify(savingsPicker.modes) === JSON.stringify([
        { label: 'Savings', pressed: 'true' },
        { label: 'Income', pressed: 'false' },
      ])
      && JSON.stringify(savingsPicker.sources) === JSON.stringify([
        '401(k) deferral',
        'Roth 401(k) deferral',
        'Traditional IRA',
        'Roth IRA',
        'HSA',
        'Taxable brokerage',
        'Cash savings',
      ])
      && savingsPicker.sourceSelect === 'Select savings type'
      && savingsPicker.allSourcesVisible
      && savingsPicker.amounts === 0
      && savingsPicker.saveLabels === 0,
    `Family savings picker inventory changed: ${JSON.stringify(savingsPicker)}`,
  );
  await clickWizardAction(
    page,
    '[data-hh-action="select-finance-source"][data-finance-type-id="401k"]',
  );
  await page.waitForFunction(() => (
    document.activeElement?.matches?.('[data-finance-amount]') === true
  ), { timeout: 10000 });
  const amountState = await page.evaluate(() => {
    const row = document.querySelector('.hh-finance-amount-row');
    const [currency, input, unit, commitButton] = row ? [...row.children] : [];
    const rect = element => element?.getBoundingClientRect() || null;
    const currencyRect = rect(currency);
    const inputRect = rect(input);
    const unitRect = rect(unit);
    const commitRect = rect(commitButton);
    const rowRect = rect(row);
    const commitStyle = commitButton ? getComputedStyle(commitButton) : null;
    return {
      count: document.querySelectorAll('[data-finance-amount]').length,
      focused: document.activeElement?.matches?.('[data-finance-amount]') === true,
      currency: currency?.textContent.trim() || '',
      unit: unit?.textContent.trim() || '',
      inputWidth: inputRect?.width || 0,
      inputSize: input?.getAttribute('size') || '',
      currencyToInputGap: inputRect && currencyRect ? inputRect.left - currencyRect.right : null,
      inputToUnitGap: unitRect && inputRect ? unitRect.left - inputRect.right : null,
      unitToCommitGap: commitRect && unitRect ? commitRect.left - unitRect.right : null,
      commitRightGap: rowRect && commitRect ? rowRect.right - commitRect.right : null,
      commitBorder: commitStyle?.borderLeftWidth || '',
      commitBackground: commitStyle?.backgroundColor || '',
      sourceSelect: document.querySelector('[data-finance-source-select] span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    amountState.count === 1
      && amountState.focused
      && amountState.currency === '$'
      && amountState.unit === '/yr'
      && Math.abs(amountState.inputWidth - 24) <= 1
      && amountState.inputSize === '1'
      && amountState.currencyToInputGap <= 5
      && amountState.inputToUnitGap <= 5
      && amountState.unitToCommitGap >= 20
      && amountState.commitRightGap <= 2
      && amountState.commitBorder === '0px'
      && amountState.commitBackground === 'rgba(0, 0, 0, 0)'
      && amountState.sourceSelect === '401(k) deferral',
    `Selecting 401(k) did not reveal the compact approved amount control: ${JSON.stringify(amountState)}`,
  );
  const beforeSavingsCommit = await wizardState(page);
  await page.type('[data-finance-amount]', '16000');
  const typedAmountState = await page.$eval('[data-finance-amount]', input => {
    const unit = input.nextElementSibling;
    const inputRect = input.getBoundingClientRect();
    const unitRect = unit?.getBoundingClientRect();
    return {
      value: input.value,
      size: input.getAttribute('size'),
      width: inputRect.width,
      inputToUnitGap: unitRect ? unitRect.left - inputRect.right : null,
    };
  });
  requireCondition(
    typedAmountState.value === '16,000'
      && typedAmountState.size === '6'
      && typedAmountState.width >= 64
      && typedAmountState.width <= 70
      && typedAmountState.inputToUnitGap <= 5,
    `Typed Family amount did not remain tightly grouped: ${JSON.stringify(typedAmountState)}`,
  );
  await replaceFinanceAmount(page, '28300');
  await page.keyboard.press('Enter');
  await waitForWizard(page, {
    step: 'family',
    afterRevision: beforeSavingsCommit.revision,
  });
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-hh-wizard-root]');
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    return root?.dataset.wizardReady === 'true'
      && document.querySelectorAll('[data-finance-entry-panel]').length === 0
      && document.querySelector('[data-hh-action="toggle-finances-rail"]')
        ?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('[data-finances-summary] span')?.textContent.trim() === 'Savings'
      && document.querySelector('[data-finances-summary] strong')?.textContent.trim() === '$28,300/yr'
      && saved?.savings?.entries?.some(entry => (
        entry.owner === 'client'
          && entry.typeId === '401k'
          && entry.amount === 28300
      ));
  }, { timeout: 10000 });

  await clickWizardAction(page, '[data-finances-person-owner="client"]');
  await clickWizardAction(
    page,
    '[data-hh-action="set-finance-mode"][data-finance-mode="income"]',
  );
  await clickWizardAction(
    page,
    '[data-hh-action="select-finance-source"][data-finance-type-id="social_security"]',
  );
  const beforePrimarySocialSecurityCommit = await wizardState(page);
  await replaceFinanceAmount(page, '32000');
  await page.keyboard.press('Enter');
  await waitForWizard(page, {
    step: 'family',
    afterRevision: beforePrimarySocialSecurityCommit.revision,
  });
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return db?.[active]?.income?.socialSecurity?.primary?.pia === 32000
      && document.querySelectorAll('[data-finance-entry-panel]').length === 0;
  }, { timeout: 10000 });

  await clickWizardAction(page, '[data-finances-person-owner="spouse"]');
  await clickWizardAction(
    page,
    '[data-hh-action="set-finance-mode"][data-finance-mode="income"]',
  );
  await clickWizardAction(
    page,
    '[data-hh-action="select-finance-source"][data-finance-type-id="social_security"]',
  );
  const beforeSpouseSocialSecurityCommit = await wizardState(page);
  await replaceFinanceAmount(page, '22000');
  await page.keyboard.press('Enter');
  await waitForWizard(page, {
    step: 'family',
    afterRevision: beforeSpouseSocialSecurityCommit.revision,
  });
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return db?.[active]?.income?.socialSecurity?.spouse?.pia === 22000
      && document.querySelectorAll('[data-finance-entry-panel]').length === 0;
  }, { timeout: 10000 });

  await clickWizardAction(page, '[data-finances-person-owner="client"]');
  await clickWizardAction(
    page,
    '[data-hh-action="set-finance-mode"][data-finance-mode="income"]',
  );
  await clickWizardAction(
    page,
    '[data-hh-action="select-finance-source"][data-finance-type-id="rental"]',
  );
  const beforeIncomeCommit = await wizardState(page);
  await page.type('[data-finance-amount]', '18000');
  await page.keyboard.press('Enter');
  await waitForWizard(page, {
    step: 'family',
    afterRevision: beforeIncomeCommit.revision,
  });
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return db?.[active]?.income?.other?.some(entry => (
      entry.owner === 'client'
        && entry.typeId === 'rental'
        && entry.amount === 18000
    ));
  }, { timeout: 10000 });
  await reloadWizard(page);
  await goToWizardStep(page, 'family');
  const persistedFinanceEntries = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    return {
      savings: saved?.savings?.entries?.filter(entry => entry.owner === 'client') || [],
      income: saved?.income?.other?.filter(entry => entry.owner === 'client') || [],
      savingsAnnual: saved?.savings?.annual,
      savingsSplit: saved?.savings?.split,
      primarySocialSecurity: saved?.income?.socialSecurity?.primary?.pia,
      spouseSocialSecurity: saved?.income?.socialSecurity?.spouse?.pia,
      client401k: saved?.portfolio?.extraAccounts?.find(account => (
        account.typeId === '401k' && account.owner === 'client'
      )) || null,
    };
  });
  requireCondition(
    persistedFinanceEntries.savings.some(entry => entry.typeId === '401k' && entry.amount === 28300)
      && persistedFinanceEntries.income.some(entry => entry.typeId === 'rental' && entry.amount === 18000)
      && persistedFinanceEntries.savingsAnnual === 28300
      && persistedFinanceEntries.savingsSplit?.traditional === 1
      && persistedFinanceEntries.savingsSplit?.roth === 0
      && persistedFinanceEntries.savingsSplit?.taxable === 0
      && persistedFinanceEntries.primarySocialSecurity === 32000
      && persistedFinanceEntries.spouseSocialSecurity === 22000
      && persistedFinanceEntries.client401k?.id === client401k.id,
    `Family finance entries did not survive reload: ${JSON.stringify(persistedFinanceEntries)}`,
  );
  };
  for (const nextStatus of ['single', 'headOfHousehold']) {
    await setWizardValue(page, '[data-wizard-field="filingStatus"]', nextStatus, {
      expectRevision: false
    });
    const rejected = await page.evaluate(() => ({
      status: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
      code: document.querySelector('[data-hh-wizard-root]')?.dataset.validationCode || '',
      people: document.querySelectorAll('[data-person-owner]').length
    }));
    requireCondition(rejected.status === 'marriedFilingJointly' && rejected.code === 'CO_CLIENT_REMOVAL_REQUIRED' && rejected.people === 2, `Direct co-client filing transition did not fail closed: ${JSON.stringify(rejected)}`);
  }
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(page, '[data-hh-action="net-worth-pick-type"][data-account-type-id="roth_ira"]');
  await setWizardValue(page, '[data-net-worth-draft="owner"]', 'spouse', {
    expectRevision: false
  });
  await setWizardValue(page, '[data-net-worth-draft="value"]', '1000', {
    expectRevision: false,
    eventType: 'input'
  });
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const spouseAccountId = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return db?.[active]?.portfolio?.extraAccounts?.find(account => (
      account.typeId === 'roth_ira' && account.owner === 'spouse'
    ))?.id || '';
  });
  requireCondition(spouseAccountId, 'Saved co-client Roth IRA did not expose a stable account ID');
  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  await page.evaluate(() => {
    window.__coClientConfirmCalls = 0;
    window.confirm = () => {
      window.__coClientConfirmCalls += 1;
      return true;
    };
  });
  await goToWizardStep(page, 'family');
  await clickWizardAction(page, '[data-hh-action="remove-spouse"]', {
    expectRevision: false
  });
  const accountBlocked = await page.evaluate(() => ({
    code: document.querySelector('[data-hh-wizard-root]')?.dataset.validationCode || '',
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length
  }));
  requireCondition(accountBlocked.code === 'CO_CLIENT_ACCOUNTS_REQUIRE_REASSIGNMENT' && accountBlocked.confirms === 0 && accountBlocked.people === 2, `Co-client account guard did not precede confirmation: ${JSON.stringify(accountBlocked)}`);
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(page, `[data-hh-action="net-worth-remove-entry"][data-entry-source="account"][data-account-id="${spouseAccountId}"]`);
  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  await goToWizardStep(page, 'family');
  await page.evaluate(() => {
    window.__coClientConfirmCalls = 0;
    window.confirm = () => {
      window.__coClientConfirmCalls += 1;
      return false;
    };
  });
  await clickWizardAction(page, '[data-hh-action="remove-spouse"]', {
    expectRevision: false
  });
  const cancelled = await page.evaluate(() => ({
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length,
    status: document.querySelector('[data-wizard-field="filingStatus"]')?.value || ''
  }));
  requireCondition(cancelled.confirms === 1 && cancelled.people === 2 && cancelled.status === 'marriedFilingJointly', `Cancelled co-client removal changed the household: ${JSON.stringify(cancelled)}`);
  await page.evaluate(() => {
    window.__coClientConfirmCalls = 0;
    window.confirm = () => {
      window.__coClientConfirmCalls += 1;
      return true;
    };
  });
  await clickWizardAction(page, '[data-hh-action="remove-spouse"]');
  const removed = await page.evaluate(() => ({
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length,
    status: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
    removeAction: document.querySelectorAll('[data-hh-action="remove-spouse"]').length
  }));
  requireCondition(removed.confirms === 1 && removed.people === 1 && removed.status === 'single' && removed.removeAction === 0, `Confirmed co-client removal was not atomic: ${JSON.stringify(removed)}`);
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    return saved?.meta?.filingStatus === 'single' && saved?.household?.spouse == null;
  }, {
    timeout: 10000
  });
  await reloadWizard(page);
  await goToWizardStep(page, 'family');
  const persistedRemoval = await page.evaluate(() => ({
    people: document.querySelectorAll('[data-person-owner]').length,
    status: document.querySelector('[data-wizard-field="filingStatus"]')?.value || ''
  }));
  requireCondition(persistedRemoval.people === 1 && persistedRemoval.status === 'single', `Co-client removal did not survive reload: ${JSON.stringify(persistedRemoval)}`);
  await openNetWorthCategory(page, 'bank');
  await clickWizardAction(page, '[data-hh-action="net-worth-pick-type"][data-account-type-id="checking"]');
  const singleOwnerState = await page.evaluate(() => ({
    spouseOptions: document.querySelectorAll('[data-net-worth-draft="owner"] option[value="spouse"]').length,
    owner: document.querySelector('[data-net-worth-draft="owner"]')?.value || '',
    saveDisabled: document.querySelector('[data-hh-action="net-worth-save-entry"]')?.disabled === true
  }));
  requireCondition(singleOwnerState.spouseOptions === 0 && singleOwnerState.owner === '' && singleOwnerState.saveDisabled, `Single-household account ownership is unsafe: ${JSON.stringify(singleOwnerState)}`);
  await clickWizardAction(page, '[data-hh-action="net-worth-cancel-draft"]');
  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  await goToWizardStep(page, 'family');
  await setWizardValue(page, '[data-wizard-field="filingStatus"]', 'headOfHousehold');
  await setWizardValue(page, '[data-wizard-field="filingStatus"]', 'marriedFilingJointly');
  await setWizardValue(page, '[data-wizard-field="spouse.birthDate"]', '1961-01-01');
  await setWizardValue(page, '[data-wizard-field="client.retirementAge"]', '68');
  await setWizardValue(page, '[data-wizard-field="spouse.retirementAge"]', '70');
  await setWizardValue(page, '[data-wizard-field="client.socialSecurityAge"]', '67');
  await setWizardValue(page, '[data-wizard-field="spouse.socialSecurityAge"]', '69');
  await setWizardValue(page, '[data-wizard-field="client.planEndAge"]', '94');
  await setWizardValue(page, '[data-wizard-field="spouse.planEndAge"]', '101');
  await verifyFinanceEntry();
  await goToWizardStep(page, 'tax');
  const filing = await page.evaluate(() => document.querySelector('.hh-tax-static strong')?.textContent.trim() || '');
  requireCondition(filing === 'Married filing jointly', `Family filing status did not reach Tax: "${filing}"`);
}

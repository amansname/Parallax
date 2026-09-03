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

  const closedFinanceEntry = await page.evaluate(() => ({
    panels: document.querySelectorAll('[data-finance-entry-panel]').length,
    amounts: document.querySelectorAll('[data-finance-amount]').length,
    largeHeaders: [...document.querySelectorAll('#hh-view *')]
      .filter(node => /^(income\s*&\s*savings|finances)$/i.test(node.textContent.trim())).length,
  }));
  requireCondition(
    closedFinanceEntry.panels === 0
      && closedFinanceEntry.amounts === 0
      && closedFinanceEntry.largeHeaders === 0,
    `Family finance entry was not initially collapsed: ${JSON.stringify(closedFinanceEntry)}`,
  );
  await clickWizardAction(
    page,
    '[data-hh-action="toggle-finance-entry"][data-finance-owner="client"]',
  );
  const savingsPicker = await page.evaluate(() => ({
    owner: document.querySelector('[data-finance-entry-panel]')?.dataset.financeOwner || '',
    modes: [...document.querySelectorAll('[data-hh-action="set-finance-mode"]')]
      .map(button => ({ label: button.textContent.trim(), pressed: button.getAttribute('aria-pressed') })),
    sources: [...document.querySelectorAll('[data-hh-action="select-finance-source"]')]
      .map(button => button.textContent.trim()),
    amounts: document.querySelectorAll('[data-finance-amount]').length,
    saveLabels: [...document.querySelectorAll('[data-finance-entry-panel] button')]
      .filter(button => button.textContent.trim() === 'Save').length,
  }));
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
  const amountState = await page.evaluate(() => ({
    count: document.querySelectorAll('[data-finance-amount]').length,
    focused: document.activeElement?.matches?.('[data-finance-amount]') === true,
  }));
  requireCondition(
    amountState.count === 1 && amountState.focused,
    `Selecting 401(k) did not reveal and focus one amount field: ${JSON.stringify(amountState)}`,
  );
  const beforeSavingsCommit = await wizardState(page);
  await page.type('[data-finance-amount]', '28300');
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
      && saved?.savings?.entries?.some(entry => (
        entry.owner === 'client'
          && entry.typeId === '401k'
          && entry.amount === 28300
      ));
  }, { timeout: 10000 });

  await clickWizardAction(
    page,
    '[data-hh-action="toggle-finance-entry"][data-finance-owner="client"]',
  );
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
      && persistedFinanceEntries.client401k?.id === client401k.id,
    `Family finance entries did not survive reload: ${JSON.stringify(persistedFinanceEntries)}`,
  );
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
  await setWizardValue(page, '[data-wizard-field="client.socialSecurityBenefit"]', '32000');
  await setWizardValue(page, '[data-wizard-field="spouse.socialSecurityBenefit"]', '22000');
  await setWizardValue(page, '[data-wizard-field="client.planEndAge"]', '94');
  await setWizardValue(page, '[data-wizard-field="spouse.planEndAge"]', '101');
  await goToWizardStep(page, 'tax');
  const filing = await page.evaluate(() => document.querySelector('.hh-tax-static strong')?.textContent.trim() || '');
  requireCondition(filing === 'Married filing jointly', `Family filing status did not reach Tax: "${filing}"`);
}

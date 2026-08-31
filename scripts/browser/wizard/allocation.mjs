// Wizard browser contract: allocation.
import { snapshotPresetAllocation } from '../../../src/household/investmentAllocation.js';
import { requireCondition } from './assertions.mjs';
import { exactStorageSnapshot, snapshotStorage, restoreStorage } from './storage.mjs';
import { setWizardValue, clickWizardAction, openNetWorthCategory, selectNetWorthAllocation, reloadWizard } from './actions.mjs';
export async function verifyAssetAllocationPersistenceFlow(page) {
  const storageBefore = await snapshotStorage(page);
  const viewportBefore = page.viewport();
  const householdId = await page.$eval('#hh-switch', selector => selector.value || '');
  requireCondition(householdId, 'Allocation selector custom household is unavailable');
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(page, '[data-hh-action="net-worth-pick-type"][data-account-type-id="rollover_ira"]');
  const defaultSelector = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('[data-asset-allocation-selector] .nw-allocation-option span')].map(element => element.textContent.trim()),
    selected: document.querySelector('[data-asset-allocation-selector] input:checked')?.value || ''
  }));
  requireCondition(JSON.stringify(defaultSelector.labels) === JSON.stringify(['Defensive', 'Conservative', 'Balanced', 'Growth', 'Aggressive', 'All Equity']) && defaultSelector.selected === 'balanced', `New investment account did not visibly default to Balanced: ${JSON.stringify(defaultSelector)}`);
  await setWizardValue(page, '[data-net-worth-draft="name"]', 'Verifier allocation account', {
    expectRevision: false,
    eventType: 'input'
  });
  await setWizardValue(page, '[data-net-worth-draft="owner"]', 'client', {
    expectRevision: false
  });
  await setWizardValue(page, '[data-net-worth-draft="value"]', '1000000', {
    expectRevision: false,
    eventType: 'input'
  });
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const accountId = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.nw-saved-row')].find(candidate => candidate.querySelector('.nw-saved-name')?.textContent.trim() === 'Verifier allocation account');
    return row?.querySelector('[data-hh-action="net-worth-edit-entry"]')?.dataset.accountId || '';
  });
  requireCondition(accountId, 'Saved allocation account is unavailable for verification');
  await page.waitForFunction(expectedId => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const account = database?.[active]?.portfolio?.extraAccounts?.find(candidate => candidate.id === expectedId);
    return account?.investmentAllocation?.source === 'preset' && account.investmentAllocation.presetId === 'balanced';
  }, {
    timeout: 10000
  }, accountId);
  const savedBalanced = await page.evaluate(({
    expectedAccountId
  }) => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const allocationAccount = database?.[active]?.portfolio?.extraAccounts?.find(account => account.id === expectedAccountId);
    const rowAccountId = document.querySelector(`[data-hh-action="net-worth-edit-entry"][data-account-id="${expectedAccountId}"]`)?.dataset.accountId || '';
    return {
      active,
      storedAccountId: allocationAccount?.id || '',
      rowAccountId,
      allocationBytes: JSON.stringify(allocationAccount?.investmentAllocation || null)
    };
  }, {
    expectedAccountId: accountId
  });
  const expectedBalancedAllocationBytes = JSON.stringify(snapshotPresetAllocation('balanced'));
  requireCondition(savedBalanced.active === householdId && savedBalanced.storedAccountId === accountId && savedBalanced.rowAccountId === accountId && savedBalanced.allocationBytes === expectedBalancedAllocationBytes, `Saved Balanced allocation is not the canonical account snapshot: ${JSON.stringify({
    savedBalanced,
    expectedBalancedAllocationBytes
  })}`);
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(page, `[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`);
  const reopenedBalanced = await page.$eval('[data-asset-allocation-selector] input:checked', input => input.value);
  requireCondition(reopenedBalanced === 'balanced', `Saved Balanced allocation did not reopen as selected: ${reopenedBalanced}`);
  await selectNetWorthAllocation(page, 'growth');
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  await page.waitForFunction(expectedId => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const account = database?.[active]?.portfolio?.extraAccounts?.find(candidate => candidate.id === expectedId);
    return account?.investmentAllocation?.source === 'preset' && account.investmentAllocation.presetId === 'growth';
  }, {
    timeout: 10000
  }, accountId);
  const savedGrowth = await page.evaluate(({
    expectedAccountId
  }) => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const allocationAccount = database?.[active]?.portfolio?.extraAccounts?.find(account => account.id === expectedAccountId);
    const rowAccountId = document.querySelector(`[data-hh-action="net-worth-edit-entry"][data-account-id="${expectedAccountId}"]`)?.dataset.accountId || '';
    return {
      active,
      storedAccountId: allocationAccount?.id || '',
      rowAccountId,
      allocationBytes: JSON.stringify(allocationAccount?.investmentAllocation || null)
    };
  }, {
    expectedAccountId: accountId
  });
  const expectedGrowthAllocationBytes = JSON.stringify(snapshotPresetAllocation('growth'));
  requireCondition(savedGrowth.active === householdId && savedGrowth.storedAccountId === accountId && savedGrowth.rowAccountId === accountId && savedGrowth.allocationBytes === expectedGrowthAllocationBytes, `Saved Growth allocation is not the canonical account snapshot: ${JSON.stringify({
    savedGrowth,
    expectedGrowthAllocationBytes
  })}`);
  await reloadWizard(page);
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(page, `[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`);
  const persisted = await page.evaluate(({
    expectedAccountId
  }) => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const allocationAccount = database?.[active]?.portfolio?.extraAccounts?.find(account => account.id === expectedAccountId);
    return {
      active,
      selectedHousehold: document.querySelector('#hh-switch')?.value || '',
      rootHousehold: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
      selected: document.querySelector('[data-asset-allocation-selector] input:checked')?.value || '',
      selectedCount: document.querySelectorAll('[data-asset-allocation-selector] input:checked').length,
      storedAccountId: allocationAccount?.id || '',
      rowAccountId: document.querySelector(`[data-hh-action="net-worth-edit-entry"][data-account-id="${expectedAccountId}"]`)?.dataset.accountId || '',
      allocationBytes: JSON.stringify(allocationAccount?.investmentAllocation || null)
    };
  }, {
    expectedAccountId: accountId
  });
  requireCondition(persisted.active === householdId && persisted.selectedHousehold === householdId && persisted.rootHousehold === householdId && persisted.selected === 'growth' && persisted.selectedCount === 1 && persisted.storedAccountId === accountId && persisted.rowAccountId === accountId && persisted.allocationBytes === expectedGrowthAllocationBytes, `Growth allocation did not survive reload: ${JSON.stringify(persisted)}`);
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1
  });
  const mobileSelector = await page.evaluate(() => {
    const options = document.querySelector('.nw-allocation-options');
    const labels = [...(options?.querySelectorAll('.nw-allocation-option') || [])];
    const first = labels[0];
    const last = labels.at(-1);
    const firstInput = first?.querySelector('input');
    const lastInput = last?.querySelector('input');
    const intersectsHorizontally = (element, container) => {
      const elementRect = element?.getBoundingClientRect();
      const containerRect = container?.getBoundingClientRect();
      return Boolean(elementRect && containerRect && elementRect.right > containerRect.left && elementRect.left < containerRect.right);
    };
    if (options) options.scrollLeft = 0;
    const firstReachable = intersectsHorizontally(first, options);
    firstInput?.focus();
    const firstFocusable = document.activeElement === firstInput;
    if (options) options.scrollLeft = options.scrollWidth;
    const lastReachable = intersectsHorizontally(last, options);
    lastInput?.focus();
    const lastFocusable = document.activeElement === lastInput;
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      selectorScrollWidth: options?.scrollWidth || 0,
      selectorClientWidth: options?.clientWidth || 0,
      selectorOverflowX: options ? getComputedStyle(options).overflowX : '',
      firstReachable,
      lastReachable,
      firstFocusable,
      lastFocusable,
      firstDisabled: firstInput?.disabled === true,
      lastDisabled: lastInput?.disabled === true
    };
  });
  requireCondition(mobileSelector.documentScrollWidth <= mobileSelector.documentClientWidth + 1 && mobileSelector.selectorScrollWidth > mobileSelector.selectorClientWidth && ['auto', 'scroll'].includes(mobileSelector.selectorOverflowX) && mobileSelector.firstReachable && mobileSelector.lastReachable && mobileSelector.firstFocusable && mobileSelector.lastFocusable && !mobileSelector.firstDisabled && !mobileSelector.lastDisabled, `Mobile allocation selector containment failed: ${JSON.stringify(mobileSelector)}`);
  if (viewportBefore) await page.setViewport(viewportBefore);
  await clickWizardAction(page, '[data-hh-action="net-worth-cancel-draft"]');
  await restoreStorage(page, storageBefore);
  await reloadWizard(page);
  const storageAfter = await snapshotStorage(page);
  requireCondition(exactStorageSnapshot(storageAfter) === exactStorageSnapshot(storageBefore), 'Allocation selector proof did not restore its exact function-local storage snapshot');
}

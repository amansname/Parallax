// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForUnselectedWizard } from '../wizard-browser-contract.mjs';
import { waitForWizard } from '../wizard-browser-contract.mjs';
export async function verifyHouseholdDeletion({
  page,
  stableReload,
  stableClick
}) {
  await page.evaluate(() => localStorage.clear());
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForUnselectedWizard(page);
  await page.select('#hh-switch', 'now-household');
  await waitForWizard(page, {
    householdId: 'now-household'
  });
  if (await page.$eval('#hh-menu-pop', menu => menu.hidden)) await stableClick('#hh-menu-btn');
  const shippedDelete = await page.evaluate(() => ({
    disabled: Boolean(document.querySelector('#hh-delete')?.disabled),
    ariaDisabled: document.querySelector('#hh-delete')?.getAttribute('aria-disabled')
  }));
  if (!shippedDelete.disabled || shippedDelete.ariaDisabled !== 'true') {
    throw new Error(`shipped household delete action is not protected: ${JSON.stringify(shippedDelete)}`);
  }
  await stableClick('#hh-new');
  await page.waitForFunction(() => {
    const id = localStorage.getItem('parallax.activeHouseholdId');
    return id && Boolean(JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id]) && localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null;
  }, {
    timeout: 15000
  });
  const before = await page.evaluate(() => {
    const id = localStorage.getItem('parallax.activeHouseholdId');
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return {
      id,
      shippedBytes: JSON.stringify(db?.['now-household']),
      scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`)
    };
  });
  if (!before.id || !before.scenarioBytes) throw new Error(`custom household delete fixture was not persisted: ${JSON.stringify(before)}`);
  if (await page.$eval('#hh-menu-pop', menu => menu.hidden)) await stableClick('#hh-menu-btn');
  const customDelete = await page.evaluate(() => ({
    disabled: Boolean(document.querySelector('#hh-delete')?.disabled),
    ariaDisabled: document.querySelector('#hh-delete')?.getAttribute('aria-disabled')
  }));
  if (customDelete.disabled || customDelete.ariaDisabled !== 'false') {
    throw new Error(`custom household delete action is unavailable: ${JSON.stringify(customDelete)}`);
  }
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    let databaseCommitFailed = false;
    window.__deleteHouseholdWriteCalls = 0;
    Storage.prototype.setItem = function (key, value) {
      window.__deleteHouseholdWriteCalls += 1;
      if (key === 'parallax.households.v1' && !databaseCommitFailed) {
        databaseCommitFailed = true;
        throw new Error('forced delete database commit failure');
      }
      if (key === 'parallax.activeHouseholdId' && databaseCommitFailed) {
        throw new Error('forced delete rollback failure');
      }
      return originalSetItem.call(this, key, value);
    };
  });
  page.once('dialog', dialog => dialog.accept());
  await stableClick('#hh-delete');
  const blockedAfterRollback = await page.evaluate(() => ({
    status: document.querySelector('#status')?.textContent.trim() || '',
    newDisabled: Boolean(document.querySelector('#hh-new')?.disabled),
    deleteDisabled: Boolean(document.querySelector('#hh-delete')?.disabled),
    runDisabled: Boolean(document.querySelector('#run-btn')?.disabled),
    enabledFields: document.querySelectorAll('#hh-view input:not(:disabled), #hh-view select:not(:disabled), #hh-view textarea:not(:disabled)').length,
    writes: window.__deleteHouseholdWriteCalls
  }));
  await page.evaluate(() => {
    document.querySelector('#hh-new')?.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    }));
    document.querySelector('[data-wizard-field="primaryName"]')?.dispatchEvent(new Event('change', {
      bubbles: true
    }));
  });
  const writesAfterBlockedActions = await page.evaluate(() => window.__deleteHouseholdWriteCalls);
  if (blockedAfterRollback.status !== 'Household could not be deleted and related data could not be restored · reload before continuing' || !blockedAfterRollback.newDisabled || !blockedAfterRollback.deleteDisabled || !blockedAfterRollback.runDisabled || blockedAfterRollback.enabledFields || writesAfterBlockedActions !== blockedAfterRollback.writes) {
    throw new Error(`failed deletion rollback did not block later writes: ${JSON.stringify({
      blockedAfterRollback,
      writesAfterBlockedActions
    })}`);
  }
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForUnselectedWizard(page);
  await page.select('#hh-switch', before.id);
  await waitForWizard(page, {
    householdId: before.id
  });
  if (await page.$eval('#hh-menu-pop', menu => menu.hidden)) await stableClick('#hh-menu-btn');
  page.once('dialog', dialog => dialog.dismiss());
  await stableClick('#hh-delete');
  const afterCancel = await page.evaluate(id => ({
    active: localStorage.getItem('parallax.activeHouseholdId'),
    exists: Boolean(JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id]),
    scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`)
  }), before.id);
  if (afterCancel.active !== before.id || !afterCancel.exists || afterCancel.scenarioBytes !== before.scenarioBytes) {
    throw new Error(`cancelled delete changed persisted state: ${JSON.stringify(afterCancel)}`);
  }
  page.once('dialog', dialog => dialog.accept());
  await stableClick('#hh-delete');
  await waitForUnselectedWizard(page);
  const afterDelete = await page.evaluate(id => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return {
      deletedExists: Boolean(db?.[id]),
      active: localStorage.getItem('parallax.activeHouseholdId'),
      scenario: localStorage.getItem(`parallax.scenarios.${id}.v1`),
      selected: document.querySelector('#hh-switch')?.value || '',
      householdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
      shippedBytes: JSON.stringify(db?.['now-household']),
      status: document.querySelector('#status')?.textContent.trim() || ''
    };
  }, before.id);
  if (afterDelete.deletedExists || afterDelete.active !== null || afterDelete.scenario !== null || afterDelete.selected || afterDelete.householdId || afterDelete.screenCount !== 0 || afterDelete.shippedBytes !== before.shippedBytes || afterDelete.status !== 'Household deleted') {
    throw new Error(`household deletion contract failed: ${JSON.stringify(afterDelete)}`);
  }
}

// Wizard browser contract: ordered campaign and exact storage restoration.
import { mkdirSync } from 'node:fs';
import { WIZARD_STEP_IDS } from './browser/wizard/selectors.mjs';
import { requireCondition } from './browser/wizard/assertions.mjs';
import { waitForUnselectedWizard, openWizard, selectHouseholdVisible } from './browser/wizard/actions.mjs';
import { snapshotStorage, restoreStorage, stableStorageSnapshot } from './browser/wizard/storage.mjs';
import { seedStaleCopyMigrationFixture, verifyBlankStartupAndNowSelection, prepareContractFixture } from './browser/wizard/startup.mjs';
import { attachBrowserDiagnostics } from './browser/wizard/diagnostics.mjs';
import { verifyRuntimeTemplateSessionIsolation } from './browser/wizard/template-isolation.mjs';
import { assertFourStepStructure, assertViewport } from './browser/wizard/structure.mjs';
import { verifyFamilyPropagation } from './browser/wizard/family.mjs';
import { verifyNetWorthFlow } from './browser/wizard/net-worth.mjs';
import { verifyAssetAllocationPersistenceFlow } from './browser/wizard/allocation.mjs';
import { verifyPlanningSourceAndTaxFlow } from './browser/wizard/tax.mjs';
import { verifyAutoSaveReloadAndMemberWages, verifyDuplicateRepair } from './browser/wizard/autosave.mjs';
export { WIZARD_STEP_IDS } from './browser/wizard/selectors.mjs';
export { waitForWizard, waitForUnselectedWizard, openWizard, goToWizardStep, openNetWorthCategory, selectHouseholdVisible } from './browser/wizard/actions.mjs';
export { captureWizardScreens } from './browser/wizard/capture.mjs';
export { attachBrowserDiagnostics } from './browser/wizard/diagnostics.mjs';
export async function runWizardBrowserContract(page, {
  outDir = null,
  restoreStorageAfter = true
} = {}) {
  if (outDir) mkdirSync(outDir, {
    recursive: true
  });
  const diagnostics = attachBrowserDiagnostics(page);
  let originalStorage = null;
  let originalHouseholdId = null;
  const originalViewport = page.viewport();
  let failure = null;
  try {
    await openWizard(page);
    originalStorage = await snapshotStorage(page);
    originalHouseholdId = await page.$eval('#hh-switch', selector => selector.value || null);
    const expectedNameOnlyBytes = await seedStaleCopyMigrationFixture(page);
    await page.reload({
      waitUntil: 'networkidle2',
      timeout: 20000
    });
    await waitForUnselectedWizard(page);
    await verifyBlankStartupAndNowSelection(page, expectedNameOnlyBytes);
    await verifyRuntimeTemplateSessionIsolation(page);
    await prepareContractFixture(page);
    await assertFourStepStructure(page);
    await verifyFamilyPropagation(page);
    await verifyNetWorthFlow(page);
    await verifyPlanningSourceAndTaxFlow(page);
    await verifyAssetAllocationPersistenceFlow(page);
    await verifyAutoSaveReloadAndMemberWages(page);
    await verifyDuplicateRepair(page);
    const viewports = [{
      label: 'desktop',
      width: 1440,
      height: 900
    }, {
      label: 'narrow',
      width: 1180,
      height: 850
    }, {
      label: 'mobile',
      width: 390,
      height: 844
    }];
    for (const viewport of viewports) {
      for (const step of WIZARD_STEP_IDS) {
        await assertViewport(page, viewport, step, outDir, `wizard-${step}-${viewport.label}.png`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (restoreStorageAfter && originalStorage) {
        await restoreStorage(page, originalStorage);
        if (originalViewport) await page.setViewport(originalViewport);
        await page.reload({
          waitUntil: 'networkidle2',
          timeout: 20000
        });
        await waitForUnselectedWizard(page);
        if (originalHouseholdId) {
          const available = await page.$$eval('#hh-switch option', (options, householdId) => options.some(option => option.value === householdId), originalHouseholdId);
          if (available) await selectHouseholdVisible(page, originalHouseholdId);
        }
        const restoredStorage = await snapshotStorage(page);
        requireCondition(stableStorageSnapshot(restoredStorage) === stableStorageSnapshot(originalStorage), 'Wizard contract did not restore the original localStorage snapshot');
      }
      diagnostics.assertClean();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], `Wizard contract and restoration diagnostics both failed\n` + `Primary: ${failure.stack || failure.message || String(failure)}\n` + `Restoration: ${error.stack || error.message || String(error)}`) : error;
    }
    diagnostics.dispose();
  }
  if (failure) throw failure;
}

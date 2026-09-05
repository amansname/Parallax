// Wizard browser contract: ordered campaign and exact storage restoration.
import { mkdirSync } from 'node:fs';
import { formatDuration } from './browser/verification-runtime.mjs';
import { WIZARD_STEP_IDS } from './browser/wizard/selectors.mjs';
import { requireCondition } from './browser/wizard/assertions.mjs';
import { waitForWizard, openWizard, selectHouseholdVisible } from './browser/wizard/actions.mjs';
import { snapshotStorage, restoreStorage, stableStorageSnapshot } from './browser/wizard/storage.mjs';
import { seedStaleCopyMigrationFixture, verifyJoeStartupAndNowSelection, prepareContractFixture } from './browser/wizard/startup.mjs';
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
  // Keep the campaign order and every assertion; expose the cost of the
  // previously opaque multi-minute wizard contract in the GitHub log.
  const phase = async (name, run) => {
    const startedAt = performance.now();
    console.log(`    START wizard: ${name}`);
    try {
      const result = await run();
      console.log(`    OK wizard: ${name} (${formatDuration(performance.now() - startedAt)})`);
      return result;
    } catch (error) {
      console.error(`    FAIL wizard: ${name} (${formatDuration(performance.now() - startedAt)})`);
      throw error;
    }
  };
  try {
    await openWizard(page);
    originalStorage = await snapshotStorage(page);
    originalHouseholdId = await page.$eval('#hh-switch', selector => selector.value || null);
    const expectedNameOnlyBytes = await seedStaleCopyMigrationFixture(page);
    await page.reload({
      waitUntil: 'networkidle2',
      timeout: 20000
    });
    await waitForWizard(page, {
      householdId: 'joe-household'
    });
    await phase('Joe startup and Now selection', () => verifyJoeStartupAndNowSelection(page, expectedNameOnlyBytes));
    await phase('runtime template session isolation', () => verifyRuntimeTemplateSessionIsolation(page));
    await phase('custom household setup', () => prepareContractFixture(page));
    await assertFourStepStructure(page);
    await phase('Family propagation', () => verifyFamilyPropagation(page));
    await phase('Net Worth', () => verifyNetWorthFlow(page));
    await phase('planning sources and Tax', () => verifyPlanningSourceAndTaxFlow(page));
    await phase('asset allocation persistence', () => verifyAssetAllocationPersistenceFlow(page));
    await phase('autosave reload and member wages', () => verifyAutoSaveReloadAndMemberWages(page));
    await phase('duplicate repair', () => verifyDuplicateRepair(page));
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
        await waitForWizard(page, {
          householdId: 'joe-household'
        });
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

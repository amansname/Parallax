// Wizard browser contract: template isolation.
import { requireCondition, countMatches, requireUnique } from './assertions.mjs';
import { waitForWizard, openWizard, goToWizardStep, setWizardValue, clickWizardAction, openNetWorthCategory, selectNetWorthAllocation, selectHouseholdVisible } from './actions.mjs';
async function historicalCashFlowSnapshot(page, {
  pathId = 'historical-1973',
  previousEndingBalance = null
} = {}) {
  const netWorthOverlay = await page.$('[data-net-worth-overlay]');
  if (netWorthOverlay) {
    await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  }
  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(() => document.querySelector('.page.on')?.dataset.page === 'scenarios' && (document.querySelectorAll('#scn-view .scol__name').length > 0 || Boolean(document.querySelector('#scn-view .cf'))) && document.querySelector('#run-btn')?.disabled === false && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 15000
  });
  const cashActive = await page.$eval('#scn-cash-toggle', button => button.getAttribute('aria-checked') === 'true');
  if (!cashActive) await page.click('#scn-cash-toggle');
  await page.waitForFunction(() => Boolean(document.querySelector('#scn-view .cf') && document.querySelector('#cashflow-path-mode')), {
    timeout: 15000
  });
  await page.select('#cashflow-path-mode', pathId);
  await page.waitForFunction(({
    expectedPathId,
    priorEnding
  }) => {
    const cashFlow = document.querySelector(`#scn-view .cf[data-cash-path-id="${expectedPathId}"]`);
    const row = cashFlow?.querySelector('.cf-row[data-source-year="1973"]');
    if (!row) return false;
    return priorEnding == null || row.dataset.endingBalance !== priorEnding;
  }, {
    timeout: 15000
  }, {
    expectedPathId: pathId,
    priorEnding: previousEndingBalance
  });
  return page.evaluate(expectedPathId => {
    const cashFlow = document.querySelector(`#scn-view .cf[data-cash-path-id="${expectedPathId}"]`);
    const row = cashFlow?.querySelector('.cf-row[data-source-year="1973"]');
    return {
      pathId: cashFlow?.dataset.cashPathId || '',
      kind: cashFlow?.dataset.cashPathKind || '',
      sourceYear: row?.dataset.sourceYear || '',
      startBalance: row?.dataset.startBalance || '',
      endingBalance: row?.dataset.endingBalance || '',
      returnText: row?.querySelector('.cf-cell--ret')?.textContent.trim() || ''
    };
  }, pathId);
}
export async function verifyRuntimeTemplateSessionIsolation(page) {
  const runtimeIds = ['now-household', 'future-household', 'joe-household'];
  await openWizard(page);
  const baseline = await page.evaluate(ids => {
    const dbBytes = localStorage.getItem('parallax.households.v1');
    const db = JSON.parse(dbBytes || 'null');
    return {
      dbBytes,
      dbIds: Object.keys(db || {}).sort(),
      fixtureBytes: Object.fromEntries(ids.map(id => [id, JSON.stringify(db?.[id] || null)])),
      scenarioBytes: JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('parallax.scenarios.')).sort(([left], [right]) => left.localeCompare(right))),
      optionIds: [...document.querySelectorAll('#hh-switch option')].map(option => option.value)
    };
  }, runtimeIds);
  requireCondition(baseline.dbBytes && runtimeIds.every(id => baseline.fixtureBytes[id] !== 'null'), `Runtime fixtures were unavailable: ${JSON.stringify(baseline)}`);
  const persistentState = () => page.evaluate(ids => {
    const dbBytes = localStorage.getItem('parallax.households.v1');
    const db = JSON.parse(dbBytes || 'null');
    return {
      dbBytes,
      dbIds: Object.keys(db || {}).sort(),
      fixtureBytes: Object.fromEntries(ids.map(id => [id, JSON.stringify(db?.[id] || null)])),
      scenarioBytes: JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('parallax.scenarios.')).sort(([left], [right]) => left.localeCompare(right))),
      optionIds: [...document.querySelectorAll('#hh-switch option')].map(option => option.value),
      derivedIds: Object.entries(db || {}).filter(([, household]) => ids.includes(household?.meta?.runtimeSourceHouseholdId)).map(([id]) => id).sort(),
      active: localStorage.getItem('parallax.activeHouseholdId'),
      runtimeScenarioKeys: ids.filter(id => localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null)
    };
  }, runtimeIds);
  const requireUnchangedPersistence = async label => {
    const state = await persistentState();
    requireCondition(state.dbBytes === baseline.dbBytes && JSON.stringify(state.dbIds) === JSON.stringify(baseline.dbIds) && JSON.stringify(state.fixtureBytes) === JSON.stringify(baseline.fixtureBytes) && state.scenarioBytes === baseline.scenarioBytes && JSON.stringify(state.optionIds) === JSON.stringify(baseline.optionIds) && state.derivedIds.length === 0 && state.active === null && state.runtimeScenarioKeys.length === 0, `${label} changed persistent runtime state: ${JSON.stringify(state)}`);
  };
  for (const [index, householdId] of runtimeIds.entries()) {
    const otherHouseholdId = runtimeIds[(index + 1) % runtimeIds.length];
    const originalName = JSON.parse(baseline.fixtureBytes[householdId]).meta.primaryName;
    const editedName = `Temporary ${householdId} edit`;
    let runtimeAllocationCheck = null;
    await selectHouseholdVisible(page, householdId);
    await page.waitForFunction(() => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
      timeout: 30000
    });
    await goToWizardStep(page, 'family');
    await setWizardValue(page, '[data-wizard-field="primaryName"]', editedName);
    await page.waitForFunction(({
      expectedId,
      expectedName,
      expectedStatus
    }) => document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === expectedId && document.querySelector('#hh-switch')?.value === expectedId && document.querySelector('[data-wizard-field="primaryName"]')?.value === expectedName && document.querySelector('#status')?.textContent.trim() === expectedStatus && localStorage.getItem('parallax.activeHouseholdId') === null, {
      timeout: 10000
    }, {
      expectedId: householdId,
      expectedName: editedName,
      expectedStatus: 'Demo changes are temporary \u00b7 use New Household to save a plan'
    });
    await requireUnchangedPersistence(`${householdId} Family edit`);
    if (index === 0) {
      const baselineHistorical = await historicalCashFlowSnapshot(page);
      requireCondition(baselineHistorical.pathId === 'historical-1973' && baselineHistorical.kind === 'historical' && baselineHistorical.sourceYear === '1973' && baselineHistorical.returnText !== '' && baselineHistorical.endingBalance !== '' && Number.isFinite(Number(baselineHistorical.endingBalance)), `Now demo Historical Cash Flow baseline is unavailable: ${JSON.stringify(baselineHistorical)}`);
      await requireUnchangedPersistence('Now demo Historical Cash Flow baseline');
      await page.click('#scn-seg-compare');
      await page.waitForFunction(() => document.querySelector('#scn-seg-compare')?.classList.contains('is-active') && document.querySelector('#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]')?.selectedOptions?.[0], {
        timeout: 15000
      });
      const baselineAllocationText = await page.evaluate(() => document.querySelector('#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]')?.selectedOptions?.[0]?.textContent.trim() || '');
      await openNetWorthCategory(page, 'investment');
      const accountId = await page.$eval('[data-hh-action="net-worth-edit-entry"][data-entry-category-id="investment"]', button => button.dataset.accountId);
      await clickWizardAction(page, `[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`);
      const originalPresetId = await page.evaluate(() => document.querySelector('[data-asset-allocation-selector] input:checked')?.value || '');
      const fixtureAccount = JSON.parse(baseline.fixtureBytes[householdId]).portfolio.extraAccounts.find(account => account.id === accountId);
      const expectedOriginalPresetId = fixtureAccount?.investmentAllocation?.source === 'preset' ? fixtureAccount.investmentAllocation.presetId : '';
      requireCondition(originalPresetId === expectedOriginalPresetId, `Demo allocation selector misstated saved allocation provenance: ${JSON.stringify({
        accountId,
        source: fixtureAccount?.investmentAllocation?.source || '',
        expected: expectedOriginalPresetId,
        actual: originalPresetId
      })}`);
      const temporaryPresetId = originalPresetId === 'all-equity' ? 'defensive' : 'all-equity';
      await selectNetWorthAllocation(page, temporaryPresetId);
      await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
      const visiblePresetId = await page.$eval(`[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`, button => button.dataset.entryAllocationPresetId || '');
      requireCondition(visiblePresetId === temporaryPresetId, `Demo allocation edit was not visible in-session: ${visiblePresetId}`);
      await requireUnchangedPersistence(`${householdId} allocation edit`);
      const changedHistorical = await historicalCashFlowSnapshot(page, {
        previousEndingBalance: baselineHistorical.endingBalance
      });
      requireCondition(changedHistorical.pathId === baselineHistorical.pathId && changedHistorical.kind === baselineHistorical.kind && changedHistorical.sourceYear === baselineHistorical.sourceYear && changedHistorical.returnText !== baselineHistorical.returnText && changedHistorical.endingBalance !== baselineHistorical.endingBalance, `Visible demo allocation change did not reach Historical Cash Flow: ${JSON.stringify({
        baselineHistorical,
        changedHistorical
      })}`);
      await requireUnchangedPersistence('Now demo allocation downstream change');
      const baselineSessionSeed = await page.evaluate(async () => (await import('./src/state.js')).pathReplay.seed);
      runtimeAllocationCheck = {
        accountId,
        originalPresetId,
        baselineSessionSeed,
        baselineAllocationText,
        baselineHistorical,
        changedHistorical
      };
      await page.click('#scn-seg-compare');
      await page.waitForFunction(() => document.querySelector('.page.on')?.dataset.page === 'scenarios' && document.querySelector('#scn-seg-compare')?.classList.contains('is-active') && document.querySelectorAll('#scn-view .scol__name').length > 0, {
        timeout: 15000
      });
    }
    const scenariosActive = await page.evaluate(() => (
      document.querySelector('.page.on')?.dataset.page === 'scenarios'
    ));
    if(!scenariosActive) await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(() => document.querySelector('.page.on')?.dataset.page === 'scenarios' && document.querySelectorAll('#scn-view .scol__name').length > 0, {
      timeout: 10000
    });
    const defaultScenarioCount = await countMatches(page, '#scn-view .scol__name');
    await requireUnique(page, '#scn-add', 'Add scenario action');
    await page.click('#scn-add');
    await page.waitForFunction(expectedCount => document.querySelectorAll('#scn-view .scol__name').length === expectedCount, {
      timeout: 30000
    }, defaultScenarioCount + 1);
    await requireUnchangedPersistence(`${householdId} scenario edit`);
    await page.click('.htab[data-page="household"]');
    await waitForWizard(page, {
      householdId
    });
    await selectHouseholdVisible(page, otherHouseholdId);
    await selectHouseholdVisible(page, householdId);
    await goToWizardStep(page, 'family');
    const restoredName = await page.$eval('[data-wizard-field="primaryName"]', input => input.value);
    requireCondition(restoredName === originalName, `${householdId} did not restore its shipped Family state after reselection`);
    if (runtimeAllocationCheck) {
      await openNetWorthCategory(page, 'investment');
      await clickWizardAction(page, `[data-hh-action="net-worth-edit-entry"][data-account-id="${runtimeAllocationCheck.accountId}"]`);
      const restoredPresetId = await page.evaluate(() => document.querySelector('[data-asset-allocation-selector] input:checked')?.value || '');
      requireCondition(restoredPresetId === runtimeAllocationCheck.originalPresetId, `Demo allocation did not reset after household switch: ${JSON.stringify({
        expected: runtimeAllocationCheck.originalPresetId,
        actual: restoredPresetId
      })}`);
      await clickWizardAction(page, '[data-hh-action="net-worth-cancel-draft"]');
      await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
      const resetHistorical = await historicalCashFlowSnapshot(page, {
        previousEndingBalance: runtimeAllocationCheck.changedHistorical.endingBalance
      });
      const resetSessionSeed = await page.evaluate(async () => (await import('./src/state.js')).pathReplay.seed);
      await page.click('#scn-seg-compare');
      await page.waitForFunction(() => document.querySelector('#scn-seg-compare')?.classList.contains('is-active') && document.querySelector('#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]')?.selectedOptions?.[0], {
        timeout: 15000
      });
      const resetAllocationText = await page.evaluate(() => document.querySelector('#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]')?.selectedOptions?.[0]?.textContent.trim() || '');
      requireCondition(resetHistorical.pathId === runtimeAllocationCheck.baselineHistorical.pathId && resetHistorical.kind === runtimeAllocationCheck.baselineHistorical.kind && resetHistorical.sourceYear === runtimeAllocationCheck.baselineHistorical.sourceYear && resetHistorical.returnText === runtimeAllocationCheck.baselineHistorical.returnText && Number.isFinite(Number(resetHistorical.startBalance)) && Number.isFinite(Number(resetHistorical.endingBalance)) && resetHistorical.endingBalance !== runtimeAllocationCheck.changedHistorical.endingBalance && resetSessionSeed !== runtimeAllocationCheck.baselineSessionSeed && resetAllocationText === runtimeAllocationCheck.baselineAllocationText, `Demo allocation downstream result did not reset after reselection: ${JSON.stringify({
        baselineSessionSeed: runtimeAllocationCheck.baselineSessionSeed,
        resetSessionSeed,
        baselineAllocationText: runtimeAllocationCheck.baselineAllocationText,
        resetAllocationText,
        baselineHistorical: runtimeAllocationCheck.baselineHistorical,
        changedHistorical: runtimeAllocationCheck.changedHistorical,
        resetHistorical
      })}`);
      await requireUnchangedPersistence('Now demo allocation downstream reset');
      await page.waitForFunction(expectedCount => document.querySelector('.page.on')?.dataset.page === 'scenarios' && document.querySelector('#scn-seg-compare')?.classList.contains('is-active') && document.querySelectorAll('#scn-view .scol__name').length === expectedCount, {
        timeout: 15000
      }, defaultScenarioCount);
    }
    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(expectedCount => document.querySelector('.page.on')?.dataset.page === 'scenarios' && document.querySelectorAll('#scn-view .scol__name').length === expectedCount, {
      timeout: 10000
    }, defaultScenarioCount);
    await requireUnchangedPersistence(`${householdId} reselection`);
    await page.click('.htab[data-page="household"]');
    await waitForWizard(page, {
      householdId
    });
  }
  await page.reload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  await requireUnchangedPersistence('runtime reload');
  for (const householdId of runtimeIds) {
    await selectHouseholdVisible(page, householdId);
    await goToWizardStep(page, 'family');
    const visibleName = await page.$eval('[data-wizard-field="primaryName"]', input => input.value);
    requireCondition(visibleName === JSON.parse(baseline.fixtureBytes[householdId]).meta.primaryName, `${householdId} did not restore its shipped Family state after reload`);
    await requireUnchangedPersistence(`${householdId} explicit selection after reload`);
  }
  const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
  if (menuHidden) {
    await clickWizardAction(page, '#hh-menu-btn', {
      expectRevision: false
    });
  }
  await requireUnique(page, '#hh-menu-pop:not([hidden]) #hh-new', 'visible new household action');
  await clickWizardAction(page, '#hh-new');
  await page.waitForFunction(() => {
    const id = document.querySelector('#hh-switch')?.value || '';
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return /^hh_[a-z0-9]+$/i.test(id) && localStorage.getItem('parallax.activeHouseholdId') === id && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === id && Boolean(db?.[id]);
  }, {
    timeout: 10000
  });
  const customId = await page.$eval('#hh-switch', selector => selector.value);
  const expectedCustomIds = [...baseline.dbIds, customId].sort();
  for (const editedName of ['Lifecycle custom first edit', 'Lifecycle custom final edit']) {
    await goToWizardStep(page, 'family');
    await setWizardValue(page, '[data-wizard-field="primaryName"]', editedName);
    await page.waitForFunction(({
      expectedId,
      expectedName,
      expectedIds
    }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return localStorage.getItem('parallax.activeHouseholdId') === expectedId && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === expectedId && document.querySelector('#hh-switch')?.value === expectedId && db?.[expectedId]?.meta?.primaryName === expectedName && JSON.stringify(Object.keys(db || {}).sort()) === JSON.stringify(expectedIds) && !Object.values(db || {}).some(household => ['now-household', 'future-household', 'joe-household'].includes(household?.meta?.runtimeSourceHouseholdId));
    }, {
      timeout: 10000
    }, {
      expectedId: customId,
      expectedName: editedName,
      expectedIds: expectedCustomIds
    });
  }
  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(() => document.querySelector('.page.on')?.dataset.page === 'scenarios' && document.querySelectorAll('#scn-view .scol__name').length > 0, {
    timeout: 10000
  });
  const customScenarioCount = await countMatches(page, '#scn-view .scol__name');
  await page.click('#scn-add');
  await page.waitForFunction(({
    expectedId,
    expectedCount
  }) => {
    const saved = JSON.parse(localStorage.getItem(`parallax.scenarios.${expectedId}.v1`) || 'null');
    return localStorage.getItem('parallax.activeHouseholdId') === expectedId && document.querySelectorAll('#scn-view .scol__name').length === expectedCount && Array.isArray(saved) && saved.length === expectedCount;
  }, {
    timeout: 30000
  }, {
    expectedId: customId,
    expectedCount: customScenarioCount + 1
  });
  const savedCustom = await page.evaluate(id => ({
    householdBytes: JSON.stringify(JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id] || null),
    scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`)
  }), customId);
  await page.reload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  await selectHouseholdVisible(page, customId);
  await goToWizardStep(page, 'family');
  const restoredCustom = await page.evaluate(({
    id,
    expectedHousehold,
    expectedScenario
  }) => ({
    active: localStorage.getItem('parallax.activeHouseholdId'),
    selected: document.querySelector('#hh-switch')?.value || '',
    rootId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
    visibleName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    householdUnchanged: JSON.stringify(JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id] || null) === expectedHousehold,
    scenarioUnchanged: localStorage.getItem(`parallax.scenarios.${id}.v1`) === expectedScenario,
    matchingOptions: [...document.querySelectorAll('#hh-switch option')].filter(option => option.value === id).length
  }), {
    id: customId,
    expectedHousehold: savedCustom.householdBytes,
    expectedScenario: savedCustom.scenarioBytes
  });
  requireCondition(restoredCustom.active === customId && restoredCustom.selected === customId && restoredCustom.rootId === customId && restoredCustom.visibleName === 'Lifecycle custom final edit' && restoredCustom.householdUnchanged && restoredCustom.scenarioUnchanged && restoredCustom.matchingOptions === 1, `Custom household did not persist under one identity: ${JSON.stringify(restoredCustom)}`);
}

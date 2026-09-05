// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { goToWizardStep } from '../wizard-browser-contract.mjs';
const RUNTIME_HOUSEHOLD_IDS = Object.freeze([
  'now-household',
  'future-household',
  'joe-household'
]);
export async function verifyJoeStartupPersistence({
  page,
  stableReload,
  WITHDRAWAL_PLANNER_ORACLE
}) {
  await page.evaluate(() => {
    localStorage.clear();
  });
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  const s = await page.evaluate(() => ({
    db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    active: localStorage.getItem('parallax.activeHouseholdId'),
    selected: document.querySelector('#hh-switch')?.value || '',
    railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
    options: [...document.querySelectorAll('#hh-switch option')].map(option => ({
      value: option.value,
      label: option.textContent.trim(),
      disabled: option.disabled
    })),
    menuHidden: document.querySelector('#hh-menu-pop')?.hidden,
    newBtn: Boolean(document.querySelector('#hh-menu-pop #hh-new')),
    deleteDisabled: Boolean(document.querySelector('#hh-menu-pop #hh-delete')?.disabled),
    loadDemoBtn: Boolean(document.querySelector('#hh-load-demo')),
    screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
    rootId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    spouseName: document.querySelector('[data-wizard-field="spouseName"]')?.value || '',
    primaryAge: document.querySelector('[data-hh-age="client"]')?.textContent.trim() || '',
    spouseAge: document.querySelector('[data-hh-age="spouse"]')?.textContent.trim() || ''
  }));
  if (!s.db || typeof s.db !== 'object') throw new Error('households store not created on first load');
  const expectedFirstLoadIds = [...Object.keys(WITHDRAWAL_PLANNER_ORACLE.households), 'joe-household'].sort((left, right) => left.localeCompare(right));
  const actualFirstLoadIds = Object.keys(s.db).sort();
  if (JSON.stringify(actualFirstLoadIds) !== JSON.stringify(expectedFirstLoadIds)) {
    throw new Error(`first-load household set is wrong: ${JSON.stringify({
      actualFirstLoadIds,
      expectedFirstLoadIds
    })}`);
  }
  // Joe is selected on load; the shipped and saved options remain available
  // behind the household menu.
  const visibleOptions = s.options.slice(1).map(({
    value,
    label
  }) => ({
    value,
    label
  }));
  if (s.active !== null || s.selected !== 'joe-household' || s.railName !== 'Joe Household' || s.options[0]?.value !== '' || s.options[0]?.disabled !== true || JSON.stringify(visibleOptions) !== JSON.stringify([{
    value: 'now-household',
    label: 'Now Household'
  }, {
    value: 'future-household',
    label: 'Future Household'
  }, {
    value: 'joe-household',
    label: 'Joe Household'
  }]) || s.menuHidden !== true || !s.newBtn || !s.deleteDisabled || s.loadDemoBtn || s.screenCount !== 1 || s.rootId !== 'joe-household' || s.primaryName !== 'Joe' || s.spouseName !== 'Jane' || s.primaryAge !== '60' || s.spouseAge !== '60') {
    throw new Error(`first-load Joe selector contract failed: ${JSON.stringify(s)}`);
  }
}
export async function verifySavedHouseholdSelection({
  page,
  stableClick,
  WITHDRAWAL_PLANNER_ORACLE,
  stableReload
}) {
  const setFamilyField = async (field, value) => {
    const beforeRevision = await page.$eval('[data-hh-wizard-root]', element => Number(element.dataset.renderRevision));
    await page.evaluate(({
      field,
      value
    }) => {
      const control = document.querySelector(`[data-hh-wizard-screen="family"] [data-wizard-field="${field}"]`);
      if (!control) throw new Error(`missing Family field: ${field}`);
      control.value = value;
      control.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }, {
      field,
      value
    });
    await waitForWizard(page, {
      step: 'family',
      afterRevision: beforeRevision
    });
  };
  const runtimeBaseline = await page.evaluate(() => {
    const dbBytes = localStorage.getItem('parallax.households.v1');
    const db = JSON.parse(dbBytes || 'null');
    return {
      dbBytes,
      dbIds: Object.keys(db || {}).sort(),
      sourceBytes: JSON.stringify(db?.['now-household'] || null),
      scenarioBytes: JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('parallax.scenarios.')).sort(([left], [right]) => left.localeCompare(right)))
    };
  });
  await stableClick('#hh-menu-btn');
  await page.waitForSelector('#hh-menu-pop:not([hidden]) #hh-switch', {
    visible: true
  });
  await page.select('#hh-switch', 'now-household');
  await waitForWizard(page, {
    householdId: 'now-household'
  });
  await stableClick('.htab[data-sub-target="goals"]');
  const sourceGoal = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const goal = (db?.['now-household']?.goals || []).find(item => item?.system && item?.name === 'Essentials');
    return goal ? {
      id: goal.id,
      amount: goal.amount
    } : null;
  });
  if (!sourceGoal?.id) throw new Error('runtime Now Essentials goal is unavailable');
  await stableClick(`[data-goal-chip="${sourceGoal.id}"]`);
  const goalAmountBefore = await page.$eval('.gh-amount-input', input => input.value);
  await stableClick('.gh-rail [data-action="amount-plus"]');
  await page.waitForFunction(previousAmount => document.querySelector('.gh-amount-input')?.value !== previousAmount, {
    timeout: 10000
  }, goalAmountBefore);
  const runtimeGoalEdit = await page.evaluate(({
    expectedDb,
    expectedSource,
    expectedScenarios
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return {
      active: localStorage.getItem('parallax.activeHouseholdId'),
      rootId: document.querySelector('[data-gh-root]')?.dataset.householdId || document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
      visibleAmount: document.querySelector('.gh-amount-input')?.value || '',
      dbUnchanged: localStorage.getItem('parallax.households.v1') === expectedDb,
      sourceUnchanged: JSON.stringify(db?.['now-household'] || null) === expectedSource,
      ids: Object.keys(db || {}).sort(),
      derivedIds: Object.entries(db || {}).filter(([, household]) => ['now-household', 'future-household', 'joe-household'].includes(household?.meta?.runtimeSourceHouseholdId)).map(([id]) => id),
      scenarioBytesUnchanged: JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('parallax.scenarios.')).sort(([left], [right]) => left.localeCompare(right))) === expectedScenarios,
      runtimeScenarioKeys: ['now-household', 'future-household', 'joe-household'].filter(id => localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null)
    };
  }, {
    expectedDb: runtimeBaseline.dbBytes,
    expectedSource: runtimeBaseline.sourceBytes,
    expectedScenarios: runtimeBaseline.scenarioBytes
  });
  if (runtimeGoalEdit.active !== null || runtimeGoalEdit.rootId !== 'now-household' || runtimeGoalEdit.visibleAmount === goalAmountBefore || !runtimeGoalEdit.dbUnchanged || !runtimeGoalEdit.sourceUnchanged || JSON.stringify(runtimeGoalEdit.ids) !== JSON.stringify(runtimeBaseline.dbIds) || runtimeGoalEdit.derivedIds.length !== 0 || !runtimeGoalEdit.scenarioBytesUnchanged || runtimeGoalEdit.runtimeScenarioKeys.length !== 0) {
    throw new Error(`runtime Now Goal edit escaped session state: ${JSON.stringify(runtimeGoalEdit)}`);
  }
  await stableClick('.htab[data-page="household"]');
  await waitForWizard(page, {
    householdId: 'now-household'
  });
  await goToWizardStep(page, 'family');
  await setFamilyField('primaryName', 'Transient Now Edit');
  const runtimeFamilyEdit = await page.evaluate(({
    expectedDb,
    expectedSource,
    expectedScenarios
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return {
      active: localStorage.getItem('parallax.activeHouseholdId'),
      rootId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
      selected: document.querySelector('#hh-switch')?.value || '',
      visibleName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
      status: document.querySelector('#status')?.textContent.trim() || '',
      dbUnchanged: localStorage.getItem('parallax.households.v1') === expectedDb,
      sourceUnchanged: JSON.stringify(db?.['now-household'] || null) === expectedSource,
      ids: Object.keys(db || {}).sort(),
      derivedIds: Object.entries(db || {}).filter(([, household]) => ['now-household', 'future-household', 'joe-household'].includes(household?.meta?.runtimeSourceHouseholdId)).map(([id]) => id),
      scenarioBytesUnchanged: JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('parallax.scenarios.')).sort(([left], [right]) => left.localeCompare(right))) === expectedScenarios,
      runtimeScenarioKeys: ['now-household', 'future-household', 'joe-household'].filter(id => localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null)
    };
  }, {
    expectedDb: runtimeBaseline.dbBytes,
    expectedSource: runtimeBaseline.sourceBytes,
    expectedScenarios: runtimeBaseline.scenarioBytes
  });
  if (runtimeFamilyEdit.active !== null || runtimeFamilyEdit.rootId !== 'now-household' || runtimeFamilyEdit.selected !== 'now-household' || runtimeFamilyEdit.visibleName !== 'Transient Now Edit' || runtimeFamilyEdit.status !== 'Demo changes are temporary · use New Household to save a plan' || !runtimeFamilyEdit.dbUnchanged || !runtimeFamilyEdit.sourceUnchanged || JSON.stringify(runtimeFamilyEdit.ids) !== JSON.stringify(runtimeBaseline.dbIds) || runtimeFamilyEdit.derivedIds.length !== 0 || !runtimeFamilyEdit.scenarioBytesUnchanged || runtimeFamilyEdit.runtimeScenarioKeys.length !== 0) {
    throw new Error(`runtime Now Family edit escaped session state: ${JSON.stringify(runtimeFamilyEdit)}`);
  }
  const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
  if (menuHidden) await stableClick('#hh-menu-btn');
  await stableClick('#hh-new');
  await page.waitForFunction(() => {
    const id = document.querySelector('#hh-switch')?.value;
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const status = document.querySelector('#status')?.textContent || '';
    return id && localStorage.getItem('parallax.activeHouseholdId') === id && Boolean(db?.[id]) && !document.querySelector('#run-btn')?.disabled && /Plan updated|Partial run/i.test(status);
  }, {
    timeout: 15000
  });
  const pendingCustomId = await page.$eval('#hh-switch', element => element.value);
  if (!pendingCustomId) {
    throw new Error(`New Household did not become the working record (id="${pendingCustomId}")`);
  }
  const created = await page.evaluate(() => ({
    active: localStorage.getItem('parallax.activeHouseholdId'),
    db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')
  }));
  if (!created.active) throw new Error(`New Household did not become active (active="${created.active}")`);
  const customId = created.active;
  await setFamilyField('primaryName', 'Saved Client');
  await setFamilyField('client.socialSecurityAge', '70');
  await page.waitForFunction(id => {
    const record = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id];
    return record?.meta?.primaryName === 'Saved Client' && record?.income?.socialSecurity?.primary?.claimAge === 70;
  }, {
    timeout: 10000
  }, customId);
  const savedCustomBytes = await page.evaluate(id => JSON.stringify(JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id]), customId);
  const expectedCreatedIds = [...Object.keys(WITHDRAWAL_PLANNER_ORACLE.households), 'joe-household', customId].sort((left, right) => left.localeCompare(right));
  const actualCreatedIds = Object.keys(created.db).sort();
  if (JSON.stringify(actualCreatedIds) !== JSON.stringify(expectedCreatedIds)) {
    throw new Error(`household set after New is wrong: ${JSON.stringify({
      actualCreatedIds,
      expectedCreatedIds
    })}`);
  }
  if (!created.db[customId] || created.db[customId].meta.isDemo !== false) throw new Error('new household record is not marked isDemo=false');
  if (created.db[customId].income.socialSecurity.primary.claimAge !== 67) throw new Error(`new household primary claim age must default to 67: ${JSON.stringify(created.db[customId].income.socialSecurity)}`);
  const removedGlobalControls = await page.evaluate(() => ({
    save: Boolean(document.querySelector('#save-btn')),
    sticky: Boolean(document.querySelector('.sn-btn, .sn-note, .sn-overlay'))
  }));
  if (removedGlobalControls.save || removedGlobalControls.sticky) {
    throw new Error(`removed global controls still rendered: ${JSON.stringify(removedGlobalControls)}`);
  }

  // Reload must always return to the shipped Joe template. The saved household
  // remains available only through an explicit selector action.
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  const afterReload = await page.evaluate(() => ({
    active: localStorage.getItem('parallax.activeHouseholdId'),
    db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    selected: document.querySelector('#hh-switch')?.value || '',
    railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
    runtimeScenarioKeys: ['now-household', 'future-household', 'joe-household'].filter(id => localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null)
  }));
  if (afterReload.active !== null || afterReload.selected !== 'joe-household' || afterReload.railName !== 'Joe Household') {
    throw new Error(`reload did not return to Joe Household: ${JSON.stringify(afterReload)}`);
  }
  if (afterReload.db[customId].meta.isDemo !== false) throw new Error('custom record overwritten on reload');
  if (JSON.stringify(afterReload.db[customId]) !== savedCustomBytes) throw new Error('saved custom household bytes changed during Joe startup');
  if (JSON.stringify(afterReload.db['now-household']) !== runtimeBaseline.sourceBytes) throw new Error('shipped Now household bytes changed during Joe startup');
  if (Object.values(afterReload.db).some(household => RUNTIME_HOUSEHOLD_IDS.includes(household?.meta?.runtimeSourceHouseholdId))) throw new Error('runtime-derived household survived Joe startup');
  if (afterReload.runtimeScenarioKeys.length !== 0) {
    throw new Error('runtime template scenarios entered persistent storage');
  }
  await stableClick('#hh-menu-btn');
  await page.waitForSelector('#hh-menu-pop:not([hidden]) #hh-switch', {
    visible: true
  });
  const visibleSwitcher = await page.$eval('#hh-switch', selector => {
    const menu = selector.closest('#hh-menu-pop');
    return menu?.hidden === false;
  });
  if (!visibleSwitcher) throw new Error('household switcher was not visible for saved-record selection');
  await page.select('#hh-switch', customId);
  await waitForWizard(page, {
    step: 'family',
    householdId: customId
  });
  const selectedCustom = await page.evaluate(() => ({
    selected: document.querySelector('#hh-switch')?.value,
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value
  }));
  if (selectedCustom.selected !== customId || selectedCustom.primaryName !== 'Saved Client') {
    throw new Error(`saved household was not restored by explicit selection: ${JSON.stringify(selectedCustom)}`);
  }
}
export async function verifyScenarioStorageScope({
  page
}) {
  const customId = await page.evaluate(() => localStorage.getItem('parallax.activeHouseholdId'));
  const keys = await page.evaluate(() => Object.keys(localStorage));
  const nowKey = 'parallax.scenarios.now-household.v1';
  const futureKey = 'parallax.scenarios.future-household.v1';
  const joeKey = 'parallax.scenarios.joe-household.v1';
  const customKey = `parallax.scenarios.${customId}.v1`;
  if (keys.includes(nowKey) || keys.includes(futureKey) || keys.includes(joeKey)) {
    throw new Error(`runtime template scenarios entered persistent storage: ${JSON.stringify(keys)}`);
  }
  if (!keys.includes(customKey)) throw new Error(`custom scenarios not scoped by id (missing ${customKey}): ${JSON.stringify(keys)}`);
  if (keys.includes('parallax.scenarios.v2')) throw new Error('legacy global scenario key parallax.scenarios.v2 must not be written');
}

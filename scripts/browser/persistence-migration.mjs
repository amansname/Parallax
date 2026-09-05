// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { goToWizardStep } from '../wizard-browser-contract.mjs';
export async function verifySchemaMerge({
  page,
  stableReload,
  stableClick
}) {
  const customId = await page.evaluate(() => localStorage.getItem('parallax.activeHouseholdId'));
  await page.evaluate(id => {
    const key = 'parallax.households.v1';
    const db = JSON.parse(localStorage.getItem(key));
    db[id].meta.primaryName = 'Custom Saved';
    db[id].income.socialSecurity.primary.pia = 7777;
    delete db[id].income.socialSecurity.primary.claimAge;
    db['now-household'].meta.primaryName = 'Stale template';
    delete db['future-household'];
    localStorage.setItem(key, JSON.stringify(db));
    localStorage.setItem('parallax.activeHouseholdId', id);
  }, customId);
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  const merged = await page.evaluate(id => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return {
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db,
      record: db?.[id]
    };
  }, customId);
  if (merged.active !== null || merged.record?.meta?.primaryName !== 'Custom Saved' || merged.record?.income?.socialSecurity?.primary?.pia !== 7777) throw new Error(`schema merge overwrote saved custom values: ${JSON.stringify(merged)}`);
  if (merged.record.income.socialSecurity.primary.claimAge !== 67) throw new Error(`schema merge did not add missing claimAge=67: ${JSON.stringify(merged.record.income.socialSecurity)}`);
  if (merged.db['now-household']?.meta?.primaryName !== 'Aboysname' || merged.db['future-household']?.meta?.primaryName !== 'amansname' || merged.db['joe-household']?.meta?.primaryName !== 'Joe') {
    throw new Error(`bootstrap did not refresh all shipped templates: ${JSON.stringify(merged.db)}`);
  }
  await page.select('#hh-switch', customId);
  await waitForWizard(page, {
    householdId: customId
  });
  if (await page.$eval('#hh-menu-pop', menu => menu.hidden)) {
    await stableClick('#hh-menu-btn');
  }
  await page.select('#hh-switch', 'now-household');
  await waitForWizard(page, {
    householdId: 'now-household'
  });
  await goToWizardStep(page, 'family');
  const after = await page.evaluate(id => ({
    db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    selected: document.querySelector('#hh-switch')?.value,
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value,
    customId: id
  }), customId);
  if (after.selected !== 'now-household' || after.primaryName !== 'Aboysname') {
    throw new Error(`Now Household did not render current shipped facts: ${JSON.stringify(after)}`);
  }
  if (after.db[customId]?.meta?.primaryName !== 'Custom Saved' || after.db[customId]?.income?.socialSecurity?.primary?.pia !== 7777) throw new Error(`shipped selection altered the saved custom household: ${JSON.stringify(after.db[customId])}`);
}
export async function verifyCorruptStorage({
  page,
  stableReload,
  stableClick
}) {
  const readOnly = 'Household storage could not be upgraded. Viewing a read-only copy; reload after storage is available.';
  const corrupt = '{not-json';
  const seededScenarios = JSON.stringify([{
    name: 'Baseline',
    base: true,
    lev: {}
  }, {
    name: 'Scenario B',
    base: false,
    lev: {}
  }]);
  await page.evaluate(({
    raw,
    scenarios
  }) => {
    localStorage.clear();
    localStorage.setItem('parallax.households.v1', raw);
    localStorage.setItem('parallax.activeHouseholdId', 'demo');
    localStorage.setItem('parallax.scenarios.demo.v1', scenarios);
  }, {
    raw: corrupt,
    scenarios: seededScenarios
  });
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  await page.waitForFunction(expected => document.querySelector('#status')?.textContent.trim() === expected, {
    timeout: 10000
  }, readOnly);
  const readRecoveryBytes = () => page.evaluate(() => {
    const scenarios = {};
    const scenarioKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('parallax.scenarios.')) scenarioKeys.push(key);
    }
    for (const key of scenarioKeys.sort()) scenarios[key] = localStorage.getItem(key);
    return {
      db: localStorage.getItem('parallax.households.v1'),
      active: localStorage.getItem('parallax.activeHouseholdId'),
      scenarios
    };
  });
  const beforeBytes = await readRecoveryBytes();
  if (beforeBytes.db !== corrupt) throw new Error('read-only bootstrap replaced corrupt household bytes');
  if (beforeBytes.active !== 'demo') throw new Error(`read-only bootstrap changed the active pointer to "${beforeBytes.active}"`);
  if (beforeBytes.scenarios['parallax.scenarios.demo.v1'] !== seededScenarios) throw new Error('read-only bootstrap changed scenario bytes');
  const startup = await page.evaluate(() => ({
    status: document.querySelector('#status')?.textContent.trim() || '',
    selected: document.querySelector('#hh-switch')?.value || '',
    options: Array.from(document.querySelector('#hh-switch')?.options || [], option => ({
      value: option.value,
      label: option.textContent.trim()
    })),
    switchDisabled: Boolean(document.querySelector('#hh-switch')?.disabled),
    loadDemoExists: Boolean(document.querySelector('#hh-load-demo')),
    newDisabled: Boolean(document.querySelector('#hh-new')?.disabled),
    enabledFields: document.querySelectorAll('#hh-view input:not(:disabled), #hh-view select:not(:disabled), #hh-view textarea:not(:disabled)').length
  }));
  for (const expected of [['now-household', 'Now Household'], ['future-household', 'Future Household'], ['joe-household', 'Joe Household']]) {
    if (!startup.options.some(option => option.value === expected[0] && option.label === expected[1])) {
      throw new Error(`corrupt-origin recovery omitted current default ${expected[0]}: ${JSON.stringify(startup)}`);
    }
  }
  if (startup.status !== readOnly || startup.selected !== 'joe-household' || startup.switchDisabled || startup.loadDemoExists || !startup.newDisabled || startup.enabledFields) {
    throw new Error(`corrupt-origin runtime state is not safely usable: ${JSON.stringify(startup)}`);
  }
  await page.select('#hh-switch', 'now-household');
  await waitForWizard(page, {
    householdId: 'now-household'
  });
  await stableClick('.htab[data-page="tax-buckets"]');
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-taw-root]');
    return root?.dataset.tawHouseholdId === 'now-household' && root.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.taw-range:not(:disabled)').length === 5 && document.querySelector('[data-taw-federal-tax]')?.textContent.trim() !== '\u2014';
  }, {
    timeout: 15000
  });
  const beforeSlider = await page.evaluate(() => ({
    revision: Number(document.querySelector('[data-taw-root]')?.dataset.tawRenderRevision || -1),
    geometry: Array.from(document.querySelectorAll('[data-taw-col]'), column => column.querySelector('.taw-col-fill')?.style.height || '')
  }));
  await stableClick('[data-taw-lever="realizedGain"]');
  await page.keyboard.press('End');
  await page.waitForFunction(previousRevision => {
    const root = document.querySelector('[data-taw-root]');
    const input = document.querySelector('[data-taw-lever="realizedGain"]');
    return root?.getAttribute('aria-busy') === 'false' && Number(root.dataset.tawRenderRevision || -1) > previousRevision && input?.value === input?.max;
  }, {
    timeout: 15000
  }, beforeSlider.revision);
  const afterSlider = await page.evaluate(() => ({
    geometry: Array.from(document.querySelectorAll('[data-taw-col]'), column => column.querySelector('.taw-col-fill')?.style.height || ''),
    federalTax: document.querySelector('[data-taw-federal-tax]')?.textContent.trim() || ''
  }));
  if (JSON.stringify(afterSlider.geometry) === JSON.stringify(beforeSlider.geometry) || afterSlider.federalTax === '\u2014') {
    throw new Error(`default-household Withdrawal Planner did not update column fill: ${JSON.stringify({
      beforeSlider,
      afterSlider
    })}`);
  }
  const afterBytes = await readRecoveryBytes();
  if (JSON.stringify(afterBytes) !== JSON.stringify(beforeBytes)) {
    throw new Error(`read-only default use changed recovery bytes: ${JSON.stringify({
      beforeBytes,
      afterBytes
    })}`);
  }
}

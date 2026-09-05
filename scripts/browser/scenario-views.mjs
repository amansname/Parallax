// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { join } from 'node:path';
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { selectHouseholdVisible } from '../wizard-browser-contract.mjs';
export async function verifyCompareView({
  page,
  cashFlowSessionSnapshot,
  OUT
}) {
  await page.click('button[data-page="scenarios"]');
  await page.waitForFunction(() => {
    const scenariosPage = document.querySelector('.page[data-page="scenarios"]');
    const runButton = document.querySelector('#run-btn');
    const status = document.querySelector('#status')?.textContent || '';
    return scenariosPage?.classList.contains('on') && runButton && !runButton.disabled && /Plan updated|Partial run/i.test(status);
  }, {
    timeout: 30000
  });
  await page.click('#scn-seg-compare');
  await page.waitForFunction(() => {
    const view = document.querySelector('#scn-view');
    const columns = [...(view?.querySelectorAll('.scol') || [])];
    const probabilities = columns.map(column => column.querySelector('.scol__prob')?.textContent.trim() || '');
    return document.querySelector('#scn-seg-compare')?.classList.contains('is-active') && !!view?.querySelector('.compare') && columns.length > 0 && probabilities.every(value => /\d/.test(value));
  }, {
    timeout: 30000
  });
  const m = await page.evaluate(() => {
    const v = document.querySelector('#scn-view');
    return {
      compare: !!v?.querySelector('.compare'),
      cols: v?.querySelectorAll('.scol').length || 0,
      rings: v?.querySelectorAll('.ring__arc').length || 0,
      probs: [...(v?.querySelectorAll('.scol__prob') || [])].map(e => e.textContent.trim()),
      names: [...(v?.querySelectorAll('.scol__name') || [])].map(e => e.textContent.trim()),
      leverNames: [...(v?.querySelectorAll('.lever__name') || [])].map(e => e.textContent.trim()),
      goalCells: v?.querySelectorAll('.cell--goal').length || 0,
      goalPill: v?.querySelector('.goal-pill, .goal-note')?.textContent || '',
      reference: !!v?.querySelector('.tag-ref'),
      solveBtn: !!document.querySelector('#scn-solve'),
      addBtn: !!document.querySelector('#scn-add'),
      suggestBtn: !!document.querySelector('#scn-suggest'),
      // removed control — must stay gone
      status: document.querySelector('#status')?.textContent || '',
      segActive: document.querySelector('#scn-seg-compare')?.classList.contains('is-active') || false
    };
  });
  if (!m.compare) throw new Error(`Compare view did not render (status="${m.status}")`);
  if (m.cols < 1) throw new Error(`no scenario columns rendered (cols=${m.cols}, status="${m.status}")`);
  if (m.rings < m.cols) throw new Error(`success rings missing (rings=${m.rings}, cols=${m.cols})`);
  if (!m.probs.some(p => /\d/.test(p))) throw new Error(`scenario probabilities not populated: ${JSON.stringify(m.probs)}`);
  if (!m.leverNames.includes('Plan Levers')) throw new Error(`Plan Levers header missing: ${JSON.stringify(m.leverNames)}`);
  if (m.goalCells < m.cols) throw new Error(`goals row not mirrored across columns (cells=${m.goalCells}, cols=${m.cols})`);
  if (!/active/.test(m.goalPill)) throw new Error(`goals summary cell missing an active count: "${m.goalPill}"`);
  if (!m.reference) throw new Error('baseline Reference tag missing from Compare');
  if (m.solveBtn) throw new Error('removed Solve control is still present in Scenarios');
  if (!m.addBtn) throw new Error('Add toolbar action missing from Scenarios');
  if (m.suggestBtn) throw new Error('removed Suggest button is still present in the Scenarios toolbar');
  if (!m.segActive) throw new Error('Compare segment did not mark itself active');
  if (m.names.some(n => /sell\s*home/i.test(n))) throw new Error(`stale sale scenario visible: ${JSON.stringify(m.names)}`);

  // Compare is editable: discrete levers (ages, allocation) now show always-visible
  // .cmp-step-btn[data-scn-id] buttons; dollar levers show .cmp-lev-in type-in inputs.
  // Both carry data-scn-id. Step up then back so the baseline is left as found.
  const cmpStepBtns = await page.evaluate(() => document.querySelectorAll('#scn-view .compare .cmp-step-btn[data-scn-id]').length);
  const cmpInputs = await page.evaluate(() => document.querySelectorAll('#scn-view .compare .cmp-lev-in[data-scn-id]').length);
  if (cmpStepBtns < 2 && cmpInputs < 1) throw new Error(`Compare lever controls missing (stepBtns=${cmpStepBtns}, inputs=${cmpInputs})`);
  const compareEditSessionBefore = await cashFlowSessionSnapshot(page, {
    bundleSentinel: 'compare-scenario-edit',
    rememberBundle: true
  });
  const cmpStep = await page.evaluate(() => {
    const button = document.querySelector('#scn-view .compare .cmp-step-btn[data-dir="1"][data-scn-id]');
    return {
      scenarioId: button?.dataset.scnId || '',
      leverKey: button?.dataset.leverKey || '',
      value: button?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim() || ''
    };
  });
  await page.evaluate(({
    scenarioId,
    leverKey
  }) => {
    [...document.querySelectorAll('#scn-view .compare .cmp-step-btn[data-dir="1"][data-scn-id]')].find(button => button.dataset.scnId === scenarioId && button.dataset.leverKey === leverKey)?.click();
  }, cmpStep);
  await page.waitForFunction(({
    scenarioId,
    leverKey,
    value
  }) => {
    const button = [...document.querySelectorAll('#scn-view .compare .cmp-step-btn[data-dir="1"][data-scn-id]')].find(candidate => candidate.dataset.scnId === scenarioId && candidate.dataset.leverKey === leverKey);
    const current = button?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim() || '';
    return current !== value && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 30000
  }, cmpStep);
  await page.evaluate(({
    scenarioId,
    leverKey
  }) => {
    [...document.querySelectorAll('#scn-view .compare .cmp-step-btn[data-dir="-1"][data-scn-id]')].find(button => button.dataset.scnId === scenarioId && button.dataset.leverKey === leverKey)?.click();
  }, cmpStep);
  await page.waitForFunction(({
    scenarioId,
    leverKey,
    value
  }) => {
    const button = [...document.querySelectorAll('#scn-view .compare .cmp-step-btn[data-dir="-1"][data-scn-id]')].find(candidate => candidate.dataset.scnId === scenarioId && candidate.dataset.leverKey === leverKey);
    const current = button?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim() || '';
    return current === value && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 30000
  }, cmpStep);
  const compareEditSessionAfter = await cashFlowSessionSnapshot(page, {
    bundleSentinel: 'compare-scenario-edit'
  });
  if (JSON.stringify(compareEditSessionAfter) !== JSON.stringify(compareEditSessionBefore)) {
    throw new Error(`Scenario edit rebuilt or mutated the household-session Monte Carlo bundle: ${JSON.stringify({
      before: compareEditSessionBefore,
      after: compareEditSessionAfter
    })}`);
  }
  await page.screenshot({
    path: join(OUT, '03-scenarios.png'),
    fullPage: true
  });
}
export async function verifyFocusView({
  page,
  OUT
}) {
  await page.click('#scn-seg-focus');
  await new Promise(r => setTimeout(r, 400));
  const m = await page.evaluate(() => {
    const v = document.querySelector('#scn-view');
    return {
      focus: !!v?.querySelector('.focus'),
      heroRing: !!v?.querySelector('.hero .ring__arc'),
      heroNumeral: v?.querySelector('.hero__numeral')?.textContent || '',
      steppers: v?.querySelectorAll('.assum__stepper .stepper-btn[data-lever-key]').length || 0,
      goalRows: v?.querySelectorAll('.goal-row').length || 0,
      railCards: v?.querySelectorAll('.rail-card[data-pick]').length || 0,
      railFocus: !!v?.querySelector('.rail-card__tag--focus'),
      segActive: document.querySelector('#scn-seg-focus')?.classList.contains('is-active') || false
    };
  });
  if (!m.focus) throw new Error('Focus view did not render');
  if (!m.heroRing) throw new Error('Focus hero ring missing');
  if (!/\d/.test(m.heroNumeral)) throw new Error(`Focus hero probability not populated: "${m.heroNumeral}"`);
  if (m.steppers < 2) throw new Error(`Focus lever steppers missing (${m.steppers})`);
  if (m.goalRows < 1) throw new Error(`Focus goals list rendered no rows (${m.goalRows})`);
  if (m.railCards < 1) throw new Error(`Focus scenario rail rendered no cards (${m.railCards})`);
  if (!m.railFocus) throw new Error('Focus rail did not mark the in-focus scenario');
  if (!m.segActive) throw new Error('Focus segment did not mark itself active');

  // A lever stepper saves and runs automatically. Step up then back down so
  // the scenario's levers and results are left exactly as found.
  const focusedLeverBefore = await page.$eval('#scn-view .assum__stepper', element => element.textContent.replace(/\s+/g, ' ').trim());
  await page.evaluate(() => document.querySelector('#scn-view .assum__stepper .stepper-btn[data-dir="1"]')?.click());
  await page.waitForFunction(before => {
    const current = document.querySelector('#scn-view .assum__stepper')?.textContent.replace(/\s+/g, ' ').trim() || '';
    return current !== before && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 30000
  }, focusedLeverBefore);
  await page.evaluate(() => document.querySelector('#scn-view .assum__stepper .stepper-btn[data-dir="-1"]')?.click());
  await page.waitForFunction(before => {
    const current = document.querySelector('#scn-view .assum__stepper')?.textContent.replace(/\s+/g, ' ').trim() || '';
    return current === before && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 30000
  }, focusedLeverBefore);
  await page.screenshot({
    path: join(OUT, '03b-scenarios-focus.png'),
    fullPage: true
  });
}
export async function verifyZeroBaseSavings({
  page,
  withdrawalPlannerFixtureHouseholdId,
  cashFlowSessionSnapshot,
  stableReload,
  stableClick,
  OUT
}) {
  await page.click('#scn-seg-compare');
  await page.click('#scn-add');
  await page.waitForFunction(() => {
    const columns = [...document.querySelectorAll('#scn-view .scol')];
    const probabilities = columns.map(column => column.querySelector('.scol__prob')?.textContent.trim() || '');
    return columns.length === 4 && probabilities.every(value => /\d/.test(value)) && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 30000
  });
  const savingsInputs = await page.$$('#scn-view .cmp-lev-in[data-key="savings"]');
  const savingsInput = savingsInputs.at(-1);
  if (!savingsInput) throw new Error('fourth scenario savings input was not available');
  await savingsInput.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type('45000');
  await page.keyboard.press('Tab');
  await page.waitForFunction(householdId => {
    const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')].map(element => element.textContent.trim());
    const savings = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')].map(input => input.value.replace(/[^0-9.]/g, ''));
    const saved = JSON.parse(localStorage.getItem(`parallax.scenarios.${householdId}.v1`) || '[]');
    return probabilities.length === 4 && probabilities.every(value => /\d/.test(value)) && savings[3] === '45000' && saved.find(scenario => scenario.name === 'Scenario D')?.lev?.savings === 45000 && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 30000
  }, withdrawalPlannerFixtureHouseholdId);
  const beforeReload = await page.evaluate(householdId => {
    const medians = [...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim());
    const savings = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')].map(input => input.value.replace(/[^0-9.]/g, ''));
    const spending = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="spend"]')].map(input => input.value.replace(/[^0-9.]/g, ''));
    const saved = JSON.parse(localStorage.getItem(`parallax.scenarios.${householdId}.v1`) || '[]');
    return {
      medians,
      savings,
      spending,
      savedSavings: saved.find(scenario => scenario.name === 'Scenario D')?.lev?.savings
    };
  }, withdrawalPlannerFixtureHouseholdId);
  const zeroBaseSessionBeforeReload = await cashFlowSessionSnapshot(page, {
    includeBundleIdentity: true
  });
  const exactMedians = JSON.parse(zeroBaseSessionBeforeReload.probabilityRangeEnvelopeBytes).map(analysis => analysis?.envelope?.at(-1)?.p50 ?? null);
  if (beforeReload.medians.length !== 4 || beforeReload.medians.some(value => !/^\$[\d,.]+[KMB]?$/.test(value)) || exactMedians.length !== 4 || exactMedians.some(value => !Number.isFinite(value)) || exactMedians[3] === exactMedians[0] || beforeReload.savings[3] !== '45000' || beforeReload.spending[3] !== beforeReload.spending[0] || beforeReload.savedSavings !== 45000) {
    throw new Error(`zero-base savings did not reach the fourth scenario: ${JSON.stringify({
      ...beforeReload,
      exactMedians
    })}`);
  }
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  await stableClick('button[data-page="scenarios"]');
  await page.waitForFunction(() => {
    const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')].map(element => element.textContent.trim());
    const savings = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')].map(input => input.value.replace(/[^0-9.]/g, ''));
    return probabilities.length === 4 && probabilities.every(value => /\d/.test(value)) && savings[3] === '45000';
  }, {
    timeout: 30000
  });
  const zeroBaseSessionAfterReload = await cashFlowSessionSnapshot(page, {
    includeBundleIdentity: true
  });
  const afterReload = await page.evaluate(() => ({
    medians: [...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim()),
    spending: [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="spend"]')].map(input => input.value.replace(/[^0-9.]/g, '')),
    errors: [...document.querySelectorAll('#scn-view .scol__prob')].filter(element => !/\d/.test(element.textContent || '')).length
  }));
  if (afterReload.errors !== 0 || afterReload.medians.length !== beforeReload.medians.length || afterReload.medians.some(value => !/^\$[\d,.]+[KMB]?$/.test(value)) || JSON.stringify(afterReload.spending) !== JSON.stringify(beforeReload.spending)) {
    throw new Error(`saved scenarios changed or blanked after reload: ${JSON.stringify({
      beforeReload,
      afterReload
    })}`);
  }
  if (zeroBaseSessionAfterReload.seed === zeroBaseSessionBeforeReload.seed || zeroBaseSessionAfterReload.bundleIdentityHash === zeroBaseSessionBeforeReload.bundleIdentityHash) {
    throw new Error(`saved Scenario reload reused the previous Monte Carlo session: ${JSON.stringify({
      before: zeroBaseSessionBeforeReload,
      after: zeroBaseSessionAfterReload
    })}`);
  }
  await page.screenshot({
    path: join(OUT, '03c-scenarios-savings-reloaded.png'),
    fullPage: true
  });
}

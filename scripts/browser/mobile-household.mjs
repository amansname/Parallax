import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectHouseholdVisible, waitForPlanCalculation, waitForWizard } from './wizard/actions.mjs';

const retirement = '[data-wizard-field="client.retirementAge"]';
const socialSecurity = '[data-wizard-field="client.socialSecurityAge"]';
const primaryName = '[data-wizard-field="primaryName"]';
const financeToggle = '[data-hh-action="toggle-finances-rail"]';
const commitNotice = '[data-household-commit-notice]';
const saveFailureMessage = 'Automatic save failed · storage blocked or full. Keep this page open. Make another edit to retry saving.';

async function requireRenderedArtifact(page, artifactId){
  assert.match(artifactId, /^[a-f0-9]{64}$/, 'Mobile proof requires an immutable artifact');
  try{
    await page.waitForFunction(() => {
      const logo = document.querySelector('.hdr__logo img');
      return document.fonts.status === 'loaded' && logo?.complete && logo.naturalWidth > 0;
    }, { timeout: 15000 });
  }catch(error){
    const readiness = await page.evaluate(() => ({
      fonts: document.fonts.status,
      faces: [...document.fonts].map(font => ({ family: font.family, status: font.status })),
      logo: document.querySelector('.hdr__logo img')?.outerHTML,
      logoComplete: document.querySelector('.hdr__logo img')?.complete,
      logoWidth: document.querySelector('.hdr__logo img')?.naturalWidth,
    }));
    throw new Error(`Mobile visual readiness failed: ${JSON.stringify(readiness)}`, { cause: error });
  }
  const loaded = await page.evaluate(() => {
    const script = document.querySelector('script[type="module"][src]');
    const direct = script && new URL(script.src, location.href).searchParams.get('v');
    const map = document.querySelector('script[type="importmap"]');
    const mapped = map && JSON.parse(map.textContent).imports?.['./src/main.js'];
    return {
      artifactId: direct || (mapped && new URL(mapped, location.href).searchParams.get('v')) || '',
      failedFonts: [...document.fonts].filter(font => font.status === 'error').length,
    };
  });
  assert.equal(loaded.artifactId, artifactId, 'Rendered application differs from the served artifact');
  assert.equal(loaded.failedFonts, 0, 'Visual evidence requires the application fonts');
}

async function typeInto(page, selector, value){
  // A single real click followed by keyboard input exposes lost blur targets.
  await page.click(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
}

async function savedState(page, householdId){
  return page.evaluate(id => ({
    household: JSON.parse(localStorage.getItem('parallax.households.v1'))[id],
    scenarios: JSON.parse(localStorage.getItem(`parallax.scenarios.${id}.v1`)),
    householdBytes: localStorage.getItem('parallax.households.v1'),
    scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`),
  }), householdId);
}

async function requireRetirementName(client){
  const { root } = await client.send('DOM.getDocument');
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: retirement });
  const { nodes } = await client.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  assert.equal(nodes[0]?.name?.value, 'Retires at', 'Inline error changed the retirement field accessible name');
}

async function requireCommitNotice(page, message = saveFailureMessage){
  assert.equal(await page.$$eval(commitNotice, nodes => nodes.length), 1,
    'Failed Household commit has no persistent visible notice');
  await page.$eval(commitNotice, node => node.scrollIntoView({ block: 'center' }));
  const visible = await page.$eval(commitNotice, node => {
    const rect = node.getBoundingClientRect();
    const concealedAncestors = [];
    for(let ancestor = node; ancestor; ancestor = ancestor.parentElement){
      const style = getComputedStyle(ancestor);
      if(ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true'
        || ancestor.getAttribute('aria-busy') === 'true'
        || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
        || Number(style.opacity) === 0){
        concealedAncestors.push(ancestor.id || ancestor.className || ancestor.tagName);
      }
    }
    return {
      text: node.textContent.trim(), role: node.getAttribute('role'), concealedAncestors,
      width: rect.width, height: rect.height, left: rect.left, right: rect.right,
      top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight,
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      unobstructed: node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
    };
  });
  assert.equal(visible.text, message);
  assert.equal(visible.role, 'alert');
  assert.deepEqual(visible.concealedAncestors, [], 'Save failure notice is hidden from sight or accessibility');
  assert.ok(visible.width > 0 && visible.height > 0, 'Save failure notice has no visible bounds');
  assert.ok(visible.left >= 0 && visible.right <= visible.viewportWidth + 1
    && visible.top >= 0 && visible.bottom <= visible.viewportHeight + 1,
  'The full save failure notice cannot be scrolled into the viewport');
  assert.ok(visible.scrollHeight <= visible.clientHeight + 1, 'Save failure notice clips its text');
  assert.equal(visible.unobstructed, true, 'Household commit notice is covered by another surface');
  const accessibility = await page.createCDPSession();
  try{
    const { root } = await accessibility.send('DOM.getDocument');
    const { nodeId } = await accessibility.send('DOM.querySelector', { nodeId: root.nodeId, selector: commitNotice });
    const { nodes } = await accessibility.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: true });
    assert.ok(nodes.some(node => !node.ignored && node.role?.value === 'alert'),
      'Visible save failure is missing its accessibility alert role');
    assert.ok(nodes.some(node => !node.ignored && node.name?.value === message),
      'The accessibility tree does not expose the save failure text');
  }finally{
    await accessibility.detach();
  }
  return visible;
}

async function requireFooterAction(page, householdId){
  const selector = '[data-hh-action="step-next"]';
  await page.$eval(selector, node => node.scrollIntoView({ block: 'center' }));
  const hit = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return node.contains(target) && rect.left >= 0 && rect.right <= innerWidth + 1
      && rect.top >= 0 && rect.bottom <= innerHeight + 1;
  });
  assert.equal(hit, true, 'Continue cannot receive a pointer action inside the viewport');
  await page.click(selector);
  await waitForWizard(page, { householdId, step: 'net-worth' });
  await page.click('[data-hh-wizard-nav="family"]');
  await waitForWizard(page, { householdId, step: 'family' });
}

async function requireFamilyContainment(page){
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    controls: [...document.querySelectorAll('[data-hh-wizard-screen="family"] input:not([type="hidden"]), [data-hh-wizard-screen="family"] select')]
      .filter(node => node.getBoundingClientRect().height > 0).map(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, height: rect.height, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
      }),
  }));
  assert.ok(layout.overflow <= 1, `Family document overflows by ${layout.overflow}px`);
  for(const control of layout.controls){
    assert.ok(control.left >= -1 && control.right <= layout.width + 1, 'Family control escapes viewport width');
    assert.ok(control.scrollHeight <= control.clientHeight + 1, 'Family control clips its enlarged text vertically');
  }
  const dates = await page.$$eval('.hh-birth-date-input', controls => controls.map(control => {
    const style = getComputedStyle(control);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const spacing = parseFloat(style.letterSpacing) || 0;
    return {
      textWidth: context.measureText(control.value).width + Math.max(0, control.value.length - 1) * spacing,
      available: control.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    };
  }));
  assert.ok(dates.length > 0, 'Family date input is missing');
  for(const date of dates){
    assert.ok(date.textWidth <= date.available + 1, 'Family date is cut off at the current text size');
  }
}

async function requireMobileInventory(page){
  const inventory = await page.evaluate(() => {
    const geometry = node => {
      const rect = node.getBoundingClientRect();
      return { height: rect.height, left: rect.left, right: rect.right };
    };
    const fields = [...document.querySelectorAll(
      '[data-hh-wizard-screen="family"] input:not([type="hidden"]), [data-hh-wizard-screen="family"] select',
    )].filter(node => node.getBoundingClientRect().height > 0);
    return {
      nav: [...document.querySelectorAll('.hdr__tabs .htab')].map(node => ({
        label: node.textContent.trim(), ...geometry(node),
      })),
      steps: [...document.querySelectorAll('[data-hh-wizard-nav]')].map(node => ({
        label: node.querySelector('strong').textContent.trim(), ...geometry(node),
      })),
      fields: fields.map(node => ({
        field: node.dataset.wizardField || node.dataset.hhField || 'birth-date',
        fontSize: parseFloat(getComputedStyle(node).fontSize), ...geometry(node),
      })),
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      width: document.documentElement.clientWidth,
      footerPosition: getComputedStyle(document.querySelector('#hh-wiz-footer')).position,
    };
  });
  assert.deepEqual(inventory.nav.map(row => row.label), [
    'Household', 'Goals', 'Scenarios', 'Withdrawal planner', 'Sequencing',
  ]);
  assert.deepEqual(inventory.steps.map(row => row.label), ['Family', 'Net Worth', 'Tax', 'Summary']);
  assert.equal(inventory.screenCount, 1);
  assert.ok(inventory.overflow <= 1, `Mobile document overflows by ${inventory.overflow}px`);
  assert.equal(inventory.footerPosition, 'static');
  assert.ok(inventory.fields.some(row => row.field === 'client.retirementAge'));
  for(const row of [...inventory.nav, ...inventory.steps, ...inventory.fields]){
    assert.ok(row.height >= 44, `${row.label || row.field} height is ${row.height}px`);
    assert.ok(row.left >= -1 && row.right <= inventory.width + 1,
      `${row.label || row.field} escapes mobile width`);
  }
  for(const row of inventory.fields){
    assert.ok(row.fontSize >= 16, `${row.field} input font is ${row.fontSize}px`);
  }
}

async function verifyAutoSaveRecovery(page, householdId, artifactId, screenshotDir){
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(async version => {
    const url = new URL('./src/state.js', location.href);
    url.searchParams.set('v', version);
    const { uiState } = await import(url.href);
    return document.querySelector('#run-btn')?.disabled === false && uiState.plansDirty === false;
  }, { timeout: 30000 }, artifactId);
  await page.click('.htab[data-page="household"]');
  await waitForWizard(page, { householdId, step: 'family' });
  const before = await savedState(page, householdId);
  assert.equal(before.household.household.primary.retirementAge, 66);
  const captureResults = () => page.evaluateHandle(async version => {
    const url = new URL('./src/state.js', location.href);
    url.searchParams.set('v', version);
    const { scenarios, uiState } = await import(url.href);
    if(uiState.plansDirty || scenarios.some(scenario => !scenario.res || scenario.runError)){
      throw new Error('Save-failure fixture requires current successful results');
    }
    return scenarios.map(scenario => scenario.res);
  }, artifactId);
  let priorResults = await captureResults();
  const runtime = () => page.evaluate(async (version, earlier) => {
    const moduleUrl = path => {
      const url = new URL(path, location.href);
      url.searchParams.set('v', version);
      return url.href;
    };
    const [engine, state, configuration] = await Promise.all([
      import(moduleUrl('./engine.js')), import(moduleUrl('./src/state.js')),
      import(moduleUrl('./src/scenarios/scenarioConfiguration.js')),
    ]);
    return {
      retirement: engine.defaultPlan.household.primary.retirementAge,
      levers: state.scenarios.map(scenario => scenario.lev.retireAge),
      dirty: state.uiState.plansDirty,
      oldResults: state.scenarios.map((scenario, index) => scenario.res === earlier[index]),
      results: state.scenarios.map(scenario => ({
        successRate: scenario.res?.successRate ?? null,
        runError: scenario.runError || null,
        projectionStatus: scenario.res?.projectionStatus ?? null,
        resolvedRetirement: engine.resolveInputs(configuration.planForScenario(scenario.lev),
          configuration.leversToOverrides(scenario.lev)).retirementAge,
      })),
      status: document.querySelector('#status').textContent.trim(),
      headerState: document.querySelector('.app-header .cluster').dataset.state,
      activePage: document.querySelector('.page.on').dataset.page,
      scenarioVisible: getComputedStyle(document.querySelector('.page[data-page="scenarios"]')).display !== 'none',
      probabilities: [...document.querySelectorAll('#scn-view .scol__prob')].map(node => node.textContent.trim()),
    };
  }, artifactId, priorResults);
  // Test-context hook: fail only this write, leaving reads and every other key intact.
  const restoreStorage = await page.evaluateHandle(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value){
      if(this === localStorage && key === 'parallax.households.v1'){
        throw new DOMException('Mobile contract simulated full storage', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    return () => { Storage.prototype.setItem = original; };
  });
  let failed;
  let failureAfterRun;
  const noticeEvidence = {};
  try{
    await typeInto(page, retirement, '67');
    await page.click(socialSecurity);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.trim()
      === 'Automatic save failed · storage blocked or full');
    noticeEvidence.afterEdit = await requireCommitNotice(page);
    failed = await runtime();
    assert.equal(failed.retirement, 67, 'Valid edit was incorrectly rejected when persistence failed');
    assert.deepEqual(failed.levers, [67, 69, 67]);
    assert.deepEqual(await savedState(page, householdId), before,
      'A failed household write changed persisted household or scenario bytes');
    assert.equal(await page.$eval(retirement, control => control.value), '67');
    assert.equal(await page.$eval(retirement, control => control.getAttribute('aria-invalid')), null);
    assert.equal(failed.dirty, true);
    assert.deepEqual(failed.oldResults, [true, true, true], 'A Family edit unexpectedly ran the engine');
    assert.equal(failed.headerState, 'needs-run');
    assert.equal(failed.activePage, 'household');
    assert.equal(failed.scenarioVisible, false, 'Stale scenario results are displayed as the active surface');
    assert.equal(failed.status, 'Automatic save failed · storage blocked or full');
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-save-failure.png') });
    await page.$eval('[data-hh-action="step-next"]', node => node.scrollIntoView({ block: 'center' }));
    await page.click('[data-hh-action="step-next"]');
    await waitForWizard(page, { householdId, step: 'net-worth' });
    noticeEvidence.netWorth = await requireCommitNotice(page);
    await page.click('[data-hh-wizard-nav="family"]');
    await waitForWizard(page, { householdId, step: 'family' });
    noticeEvidence.returnedFamily = await requireCommitNotice(page);
    assert.deepEqual(await savedState(page, householdId), before);

    // A calculation can finish while saving remains blocked. Its ordinary status
    // must not erase the separate, visible persistence warning on returning home.
    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(async version => {
      const url = new URL('./src/state.js', location.href);
      url.searchParams.set('v', version);
      const { uiState } = await import(url.href);
      return document.querySelector('#run-btn')?.disabled === false && uiState.plansDirty === false;
    }, { timeout: 30000 }, artifactId);
    failureAfterRun = await runtime();
    assert.equal(failureAfterRun.dirty, false);
    assert.deepEqual(failureAfterRun.oldResults, [false, false, false]);
    assert.deepEqual(failureAfterRun.results.map(result => result.resolvedRetirement), [67, 69, 67]);
    assert.deepEqual(await savedState(page, householdId), before,
      'Running calculations retried or changed the failed saved inputs');
    await page.click('.htab[data-page="household"]');
    await waitForWizard(page, { householdId, step: 'family' });
    noticeEvidence.afterRun = await requireCommitNotice(page);
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-save-failure-after-run.png') });
    await priorResults.dispose();
    priorResults = await captureResults();
  }finally{
    await page.evaluate(restore => restore(), restoreStorage);
    await restoreStorage.dispose();
  }
  try{
    // Recovery is a subsequent real valid edit. Run does not retry autosave.
    noticeEvidence.beforeRecovery = await requireCommitNotice(page);
    await typeInto(page, retirement, '68');
    await page.click(socialSecurity);
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('parallax.households.v1'))[id]
      .household.primary.retirementAge === 68, {}, householdId);
    assert.equal(await page.$eval(commitNotice, node => node.hidden && !node.textContent.trim()), true,
      'Successful persistence left the prior save failure notice visible or announced');
    const recovered = await savedState(page, householdId);
    const expectedHousehold = structuredClone(before.household);
    expectedHousehold.household.primary.retirementAge = 68;
    assert.deepEqual(recovered.household, expectedHousehold, 'Recovery changed unrelated household facts');
    const expectedScenarios = structuredClone(before.scenarios);
    expectedScenarios.forEach(scenario => { scenario.lev.retireAge += 2; });
    assert.deepEqual(recovered.scenarios, expectedScenarios);
    const stale = await runtime();
    assert.equal(stale.retirement, 68);
    assert.equal(stale.status, 'Saved automatically · open Scenarios');
    assert.equal(stale.dirty, true, 'Saved inputs must not make prior engine results current');
    assert.deepEqual(stale.oldResults, [true, true, true]);
    assert.equal(stale.headerState, 'needs-run');
    assert.equal(stale.scenarioVisible, false);

    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(async version => {
      const url = new URL('./src/state.js', location.href);
      url.searchParams.set('v', version);
      const { uiState } = await import(url.href);
      return document.querySelector('#run-btn')?.disabled === false && uiState.plansDirty === false;
    }, { timeout: 30000 }, artifactId);
    const fresh = await runtime();
    assert.equal(fresh.dirty, false);
    assert.deepEqual(fresh.oldResults, [false, false, false], 'Rerun retained stale result objects');
    assert.deepEqual(fresh.results.map(result => result.resolvedRetirement), [68, 70, 68]);
    for(const [index, result] of fresh.results.entries()){
      assert.equal(result.runError, null);
      assert.notEqual(result.projectionStatus, 'unavailable');
      assert.ok(Number.isFinite(result.successRate));
      assert.equal(fresh.probabilities[index], `${result.successRate.toFixed(1)}%`);
    }
    assert.deepEqual(await savedState(page, householdId), recovered, 'Running altered recovered saved inputs');
    await writeFile(join(screenshotDir, 'mobile-household-save-recovery-proof.json'), JSON.stringify({
      artifactId, persistedAgeBefore: 66, failed, failureAfterRun, noticeEvidence,
      recoveredAge: 68, stale, fresh,
    }, null, 2));
  }finally{
    await priorResults.dispose();
  }
}

async function verifyAppliedRefreshFailure(page, householdId, artifactId, screenshotDir){
  await page.click('.htab[data-page="household"]');
  await waitForWizard(page, { householdId, step: 'family' });
  const before = await savedState(page, householdId);
  assert.equal(before.household.household.primary.retirementAge, 68);
  // Fail only the existing Family partial-refresh lookup, after the command and
  // autosave have completed. Restore the exact prior property in all outcomes.
  const refreshHook = await page.evaluateHandle(() => {
    const view = document.querySelector('#hh-view');
    const own = Object.getOwnPropertyDescriptor(view, 'querySelectorAll');
    const original = view.querySelectorAll;
    let calls = 0;
    Object.defineProperty(view, 'querySelectorAll', { configurable: true, value(selector){
      if(selector === '[data-hh-wizard-screen="family"]'){
        calls += 1;
        throw new Error('Mobile contract simulated Family refresh failure');
      }
      return original.call(this, selector);
    } });
    return {
      calls: () => calls,
      restore: () => {
        if(own) Object.defineProperty(view, 'querySelectorAll', own);
        else delete view.querySelectorAll;
      },
    };
  });
  let notice;
  try{
    await typeInto(page, retirement, '69');
    await page.click(socialSecurity);
    await page.waitForFunction(() => document.querySelector('[data-hh-wizard-root]')?.dataset.validationCode
      === 'WIZARD_REFRESH_FAILED');
    assert.ok(await page.evaluate(hook => hook.calls() > 0, refreshHook));
    const saved = await savedState(page, householdId);
    const expected = structuredClone(before.household);
    expected.household.primary.retirementAge = 69;
    assert.deepEqual(saved.household, expected, 'Refresh failure lost the applied save or changed unrelated facts');
    const expectedScenarios = structuredClone(before.scenarios);
    expectedScenarios.forEach(scenario => { scenario.lev.retireAge += 1; });
    assert.deepEqual(saved.scenarios, expectedScenarios);
    assert.equal(await page.$eval(retirement, control => control.getAttribute('aria-invalid')), null);
    assert.equal(await page.$eval(retirement, control => control.validationMessage), '');
    notice = await requireCommitNotice(page, 'Edit applied, but the screen could not refresh. Select the current step again to refresh the form.');
    for(const expanded of ['true', 'false']){
      await page.click(financeToggle);
      assert.equal(await page.$eval(financeToggle, node => node.getAttribute('aria-expanded')), expanded);
      await requireCommitNotice(page, 'Edit applied, but the screen could not refresh. Select the current step again to refresh the form.');
      assert.equal(await page.$eval('[data-hh-wizard-root]', node => node.dataset.wizardReady), 'false',
        'A finance-only render must not declare the stale Family form ready');
      assert.deepEqual(await savedState(page, householdId), saved,
        'Opening or closing finance controls must not repeat the applied save');
    }
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-applied-refresh-failure.png') });
  }finally{
    await page.evaluate(hook => hook.restore(), refreshHook);
    await refreshHook.dispose();
  }
  // A failed render is not declared ready. Reopen the existing Family step to
  // restore its DOM before the next edit; this is not a command/save retry.
  await page.click('[data-hh-wizard-nav="family"]');
  await waitForWizard(page, { householdId, step: 'family' });
  assert.equal(await page.$eval(commitNotice, node => node.hidden && !node.textContent.trim()), true,
    'A successful Family rerender must clear the recovered refresh warning');
  await typeInto(page, retirement, '70');
  await page.click(socialSecurity);
  await page.waitForFunction(id => JSON.parse(localStorage.getItem('parallax.households.v1'))[id]
    .household.primary.retirementAge === 70, {}, householdId);
  await waitForWizard(page, { householdId, step: 'family' });
  assert.equal(await page.$eval(commitNotice, node => node.hidden && !node.textContent.trim()), true);
  assert.equal(await page.$eval('[data-hh-wizard-root]', root => root.dataset.validationCode), undefined);
  const recovered = await savedState(page, householdId);
  const expected = structuredClone(before.household);
  expected.household.primary.retirementAge = 70;
  assert.deepEqual(recovered.household, expected);
  const expectedScenarios = structuredClone(before.scenarios);
  expectedScenarios.forEach(scenario => { scenario.lev.retireAge += 2; });
  assert.deepEqual(recovered.scenarios, expectedScenarios);
  await writeFile(join(screenshotDir, 'mobile-household-refresh-recovery-proof.json'), JSON.stringify({
    artifactId, persistedAgeBefore: 68, appliedAge: 69, notice, recoveredAge: 70,
  }, null, 2));
}

async function verifyNewHouseholdSaveFailure(page, previousId, artifactId, screenshotDir){
  const before = await savedState(page, previousId);
  assert.equal(before.household.household.primary.retirementAge, 70);
  const beforeDatabase = JSON.parse(before.householdBytes);
  const restoreStorage = await page.evaluateHandle(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value){
      if(this === localStorage && key === 'parallax.households.v1'){
        throw new DOMException('Mobile contract simulated initial save failure', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    return () => { Storage.prototype.setItem = original; };
  });
  let newId;
  let notice;
  try{
    await page.click('#hh-menu-btn');
    await page.click('#hh-new');
    await page.waitForFunction(previous => {
      const root = document.querySelector('[data-hh-wizard-root]');
      const id = document.querySelector('#hh-switch')?.value;
      return /^hh_/i.test(id || '') && id !== previous
        && root?.dataset.householdId === id && root.dataset.wizardReady === 'true';
    }, {}, previousId);
    newId = await page.$eval('#hh-switch', control => control.value);
    await waitForWizard(page, { householdId: newId, step: 'family' });
    notice = await requireCommitNotice(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('parallax.households.v1')),
      before.householdBytes, 'A failed initial save changed the household database bytes');
    assert.equal(await page.evaluate(id => Object.hasOwn(
      JSON.parse(localStorage.getItem('parallax.households.v1')), id,
    ), newId), false, 'The unsaved new household was represented as persisted');
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-new-save-failure.png') });
  }finally{
    await page.evaluate(restore => restore(), restoreStorage);
    await restoreStorage.dispose();
  }
  // Restoring storage alone does not save the active draft or clear its warning.
  await requireCommitNotice(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('parallax.households.v1')), before.householdBytes);
  await typeInto(page, primaryName, 'Taylor Jordan');
  await page.click(retirement);
  await page.waitForFunction(id => JSON.parse(localStorage.getItem('parallax.households.v1'))[id]
    ?.meta.primaryName === 'Taylor Jordan', {}, newId);
  assert.equal(await page.$eval(commitNotice, node => node.hidden && !node.textContent.trim()), true,
    'The recovered new household still displays its initial save failure');
  const recovered = await savedState(page, newId);
  const recoveredDatabase = JSON.parse(recovered.householdBytes);
  assert.deepEqual(Object.keys(recoveredDatabase).sort(), [...Object.keys(beforeDatabase), newId].sort());
  for(const [id, record] of Object.entries(beforeDatabase)){
    assert.deepEqual(recoveredDatabase[id], record, 'Saving the new household changed a pre-existing household');
  }
  assert.equal(recovered.household.meta.householdId, newId);
  assert.equal(recovered.household.meta.primaryName, 'Taylor Jordan');
  assert.ok(Array.isArray(recovered.scenarios) && recovered.scenarios.length === 3);
  assert.deepEqual((await savedState(page, previousId)).scenarios, before.scenarios);
  await writeFile(join(screenshotDir, 'mobile-household-new-save-recovery-proof.json'), JSON.stringify({
    artifactId, failedInitialSaveNotice: notice, recoveredName: 'Taylor Jordan',
    previousHouseholdPreserved: true, newHouseholdPersisted: true,
  }, null, 2));
}

export async function verifyMobileHousehold({ browser, url, screenshotDir }){
  const context = await browser.createBrowserContext();
  const pageErrors = [];
  try{
    const page = await context.newPage();
    const accessibility = await page.createCDPSession();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      const reportValidity = HTMLInputElement.prototype.reportValidity;
      window.__mobileHouseholdValidityCalls = 0;
      HTMLInputElement.prototype.reportValidity = function(...args){
        window.__mobileHouseholdValidityCalls += 1;
        return reportValidity.apply(this, args);
      };
    });
    // Readiness is the actual rendered wizard, fonts and versioned entrypoint.
    // Network inactivity can time out even after this application's navigation.
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const artifactId = response.headers()['x-parallax-artifact-id'];
    await waitForWizard(page, { householdId: 'joe-household', step: 'family' });
    await waitForPlanCalculation(page);
    await requireRenderedArtifact(page, artifactId);

    // Runtime templates are temporary. Create a durable fixture visibly.
    await page.click('#hh-menu-btn');
    await page.click('#hh-new');
    await page.waitForFunction(() => {
      const id = document.querySelector('#hh-switch')?.value;
      const saved = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      return /^hh_/i.test(id || '') && Boolean(saved[id])
        && document.querySelector('[data-hh-wizard-root]')?.dataset.wizardReady === 'true';
    }, { timeout: 15000 });
    const householdId = await page.$eval('#hh-switch', control => control.value);
    await typeInto(page, primaryName, 'Alex Morgan');
    await page.click(retirement);
    await page.waitForFunction(id => (
      JSON.parse(localStorage.getItem('parallax.households.v1'))[id].meta.primaryName
        === 'Alex Morgan'
    ), {}, householdId);
    await typeInto(page, '[data-birth-date-group="client"] [data-birth-date-display]', '01011966');
    await page.click(retirement);
    await page.waitForFunction(id => (
      JSON.parse(localStorage.getItem('parallax.households.v1'))[id].taxProfiles.client.birthDate.value === '1966-01-01'
    ), {}, householdId);
    await requireMobileInventory(page);

    // Opening the finance controls must push Family down, not cover it.
    const beforeRail = await savedState(page, householdId);
    await page.click(financeToggle);
    await page.waitForFunction(() => document.querySelector(
      '[data-hh-action="toggle-finances-rail"]',
    )?.getAttribute('aria-expanded') === 'true');
    await page.click('[data-finances-person-owner="client"]');
    await page.waitForSelector('[data-finance-entry-panel]');
    const rail = await page.evaluate(() => {
      const element = document.querySelector('[data-finances-rail]');
      const people = document.querySelector('.hh-family-people');
      return {
        position: getComputedStyle(element).position,
        bottom: element.getBoundingClientRect().bottom,
        peopleTop: people.getBoundingClientRect().top,
        sourceCount: document.querySelectorAll('[data-finance-type-id]').length,
      };
    });
    assert.equal(rail.position, 'static');
    assert.ok(rail.bottom <= rail.peopleTop + 1, 'Finance rail overlaps Family fields');
    assert.equal(rail.sourceCount, 7);
    await page.click(financeToggle);
    await page.waitForFunction(() => document.querySelector(
      '[data-hh-action="toggle-finances-rail"]',
    )?.getAttribute('aria-expanded') === 'false');
    assert.deepEqual(await savedState(page, householdId), beforeRail,
      'Opening and closing finance presentation mutated saved data');

    const before = await savedState(page, householdId);
    assert.equal(before.household.household.primary.retirementAge, 65);
    assert.deepEqual(before.scenarios.map(scenario => scenario.lev.retireAge), [65, 67, 65]);
    const mountedRetirement = await page.$(retirement);
    const mountedNext = await page.$(socialSecurity);
    await requireRetirementName(accessibility);
    const revision = await page.$eval('[data-hh-wizard-root]', root => root.dataset.renderRevision);
    await typeInto(page, retirement, '44');
    await page.keyboard.press('Tab');
    await page.waitForSelector('[data-household-inline-error]');
    const invalid = await page.$eval(retirement, control => {
      const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      const errors = ids.map(id => document.getElementById(id))
        .filter(node => node?.hasAttribute('data-household-inline-error'));
      return {
        invalid: control.getAttribute('aria-invalid'),
        messages: errors.map(node => node.textContent),
        roles: errors.map(node => node.getAttribute('role')),
        bubbleCalls: window.__mobileHouseholdValidityCalls,
        revision: document.querySelector('[data-hh-wizard-root]').dataset.renderRevision,
        status: document.querySelector('#status').textContent.trim(),
      };
    });
    assert.deepEqual(invalid, {
      invalid: 'true', messages: ['Enter a value from 45 through 90'],
      roles: ['alert'], bubbleCalls: 0, revision, status: 'Enter a value from 45 through 90',
    });
    await requireRetirementName(accessibility);
    assert.deepEqual(await savedState(page, householdId), before,
      'Rejected retirement age changed household or scenario bytes');
    await page.$eval('[data-household-inline-error]', element => element.scrollIntoView({ block: 'center' }));
    const errorBounds = await page.$eval('[data-household-inline-error]', element => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: document.documentElement.clientWidth, height: window.innerHeight,
      };
    });
    assert.ok(errorBounds.left >= 0 && errorBounds.right <= errorBounds.width + 1
      && errorBounds.top >= 0 && errorBounds.bottom <= errorBounds.height + 1,
    'Inline error is not fully reachable within the mobile viewport');
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-inline-error.png') });

    // Blank is also rejected by the domain boundary; it must not become saved zero.
    await page.click(retirement);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Tab');
    await page.waitForSelector('[data-household-inline-error]');
    assert.equal(await page.$eval(retirement, control => control.value), '');
    assert.equal(await page.$eval('[data-household-inline-error]', node => node.textContent), 'Enter a value from 45 through 90');
    assert.deepEqual(await savedState(page, householdId), before, 'Blank retirement age changed saved data');
    await requireRetirementName(accessibility);

    await typeInto(page, retirement, '66');
    // One click must survive the blur commit; do not refocus the next field.
    await page.click(socialSecurity);
    await page.waitForFunction(id => (
      JSON.parse(localStorage.getItem('parallax.households.v1'))[id].household.primary.retirementAge === 66
    ), {}, householdId);
    assert.equal(await mountedRetirement.evaluate(control => (
      control === document.querySelector('[data-wizard-field="client.retirementAge"]')
    )), true, 'Retirement control was replaced during its commit');
    assert.equal(await mountedNext.evaluate(control => (
      control === document.querySelector('[data-wizard-field="client.socialSecurityAge"]')
        && document.activeElement === control
    )), true, 'The first next-field click was lost during the blur commit');
    const corrected = await page.$eval(retirement, control => ({
      invalid: control.getAttribute('aria-invalid'),
      validity: control.validationMessage,
      errorCount: document.querySelectorAll('[data-household-inline-error]').length,
      describedBy: control.getAttribute('aria-describedby'),
      bubbleCalls: window.__mobileHouseholdValidityCalls,
    }));
    assert.deepEqual(corrected, {
      invalid: null, validity: '', errorCount: 0, describedBy: null, bubbleCalls: 0,
    });
    await requireRetirementName(accessibility);
    assert.equal(await page.$eval('#status', node => node.textContent.trim()), 'Saved automatically · open Scenarios');
    const after = await savedState(page, householdId);
    const expectedHousehold = structuredClone(before.household);
    expectedHousehold.household.primary.retirementAge = 66;
    assert.deepEqual(after.household, expectedHousehold, 'Retirement edit altered unrelated household facts');
    assert.deepEqual(after.scenarios.map(scenario => scenario.lev.retireAge), [66, 68, 66]);
    for(const [index, scenario] of after.scenarios.entries()){
      const expectedScenario = structuredClone(before.scenarios[index]);
      expectedScenario.lev.retireAge += 1;
      // Blank-household pension quotes cap the linked pension age at 65.
      assert.deepEqual(scenario, expectedScenario, 'Retirement reseed altered unrelated scenario choices');
    }
    await requireMobileInventory(page);
    await page.$eval(primaryName, element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-family.png') });
    await mountedRetirement.dispose();
    await mountedNext.dispose();

    // Run through the visible navigation, then inspect the exact loaded artifact modules.
    await requireRenderedArtifact(page, artifactId);
    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(async version => {
      const stateUrl = new URL('./src/state.js', location.href);
      stateUrl.searchParams.set('v', version);
      const { uiState } = await import(stateUrl.href);
      return document.querySelector('.page.on')?.dataset.page === 'scenarios'
        && document.querySelector('#run-btn')?.disabled === false && uiState.plansDirty === false;
    }, { timeout: 30000 }, artifactId);
    const engineProof = await page.evaluate(async version => {
      const moduleUrl = path => {
        const target = new URL(path, location.href);
        target.searchParams.set('v', version);
        return target.href;
      };
      const [engine, configuration, state] = await Promise.all([
        import(moduleUrl('./engine.js')),
        import(moduleUrl('./src/scenarios/scenarioConfiguration.js')),
        import(moduleUrl('./src/state.js')),
      ]);
      return {
        dirty: state.uiState.plansDirty,
        visibleText: document.querySelector('#scn-view').innerText,
        probabilities: [...document.querySelectorAll('#scn-view .scol__prob')].map(node => node.textContent.trim()),
        rows: state.scenarios.map(scenario => {
          const resolved = engine.resolveInputs(configuration.planForScenario(scenario.lev), configuration.leversToOverrides(scenario.lev));
          return {
            retirement: resolved.retirementAge,
            simulationAvailable: resolved.simulationAvailable,
            simulationIssues: resolved.simulationIssues,
            runError: scenario.runError || null,
            hasResult: Boolean(scenario.res),
            successRate: scenario.res?.successRate ?? null,
            projectionStatus: scenario.res?.projectionStatus ?? null,
            issue: scenario.res?.issue ?? null,
          };
        }),
      };
    }, artifactId);
    await writeFile(join(screenshotDir, 'mobile-household-engine-proof.json'), JSON.stringify({
      artifactId, dirty: engineProof.dirty, rows: engineProof.rows, probabilities: engineProof.probabilities,
    }, null, 2));
    assert.equal(engineProof.dirty, false);
    assert.deepEqual(engineProof.rows.map(row => row.retirement), [66, 68, 66]);
    assert.equal(engineProof.rows.length, 3);
    for(const [index, row] of engineProof.rows.entries()){
      assert.equal(row.simulationAvailable, true, 'The valid mobile fixture must permit simulation');
      assert.equal(row.runError, null, 'The valid mobile edit must produce a successful engine run');
      assert.equal(row.hasResult, true);
      assert.ok(Number.isFinite(row.successRate), 'The engine must return a finite probability');
      assert.notEqual(row.projectionStatus, 'unavailable');
      assert.equal(engineProof.probabilities[index], `${row.successRate.toFixed(1)}%`,
        'Visible probability differs from the actual engine result');
    }

    // All five existing destinations remain reachable by real navigation clicks.
    for(const destination of ['household', 'net-worth', 'scenarios', 'tax-buckets', 'sequencing']){
      await page.click(`.htab[data-page="${destination}"]`);
      await page.waitForFunction(expected => document.querySelector('.page.on')?.dataset.page === expected, {}, destination);
      assert.equal(await page.$eval(`.htab[data-page="${destination}"]`, button => button.getAttribute('aria-current')), 'page');
    }
    await page.click('.htab[data-page="household"]');
    await waitForWizard(page, { householdId, step: 'family' });

    // The short portrait viewport checks reduced space, not a native keyboard.
    for(const viewport of [{ width: 320, height: 568 }, { width: 760, height: 900 }, { width: 844, height: 390 }, { width: 390, height: 360 }]){
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await requireFamilyContainment(page);
      await requireMobileInventory(page);
      await requireFooterAction(page, householdId);
      await page.$eval(primaryName, element => element.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: join(screenshotDir, `mobile-household-${viewport.width}x${viewport.height}.png`) });
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    // Explicit 200% text fixture, not a claim of native OS text-size testing.
    const textScale = await page.addStyleTag({ content: `
      .hh-person-fields { font-size: 32px !important; }
      .hdr__tabs .htab, .app-header .status { font-size: 24px !important; }
      .hh-step strong, .hh-family-screen .hh-field > span { font-size: 28px !important; }
      .hh-family-screen input:not([type="hidden"]), .hh-family-screen select,
      .hh-family-screen button, #hh-wiz-footer button { font-size: 32px !important; }
      .hh-person-fields :is(input, select, output) { font-size: inherit !important; }
    ` });
    await requireFamilyContainment(page);
    await requireMobileInventory(page);
    await requireFooterAction(page, householdId);
    await page.$eval(retirement, element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-enlarged-text.png') });
    await textScale.evaluate(node => node.remove());
    await textScale.dispose();
    assert.deepEqual((await savedState(page, householdId)).household, after.household);
    await accessibility.detach();

    // Reload deliberately chooses runtime startup. Explicitly reopen the saved fixture.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForWizard(page, { householdId: 'joe-household', step: 'family' });
    await waitForPlanCalculation(page);
    await requireRenderedArtifact(page, artifactId);
    await selectHouseholdVisible(page, householdId);
    assert.equal(await page.$eval(retirement, control => control.value), '66');
    assert.deepEqual((await savedState(page, householdId)).household, after.household);
    assert.deepEqual((await savedState(page, householdId)).scenarios, after.scenarios);

    // Same browser storage, responsive desktop parity; this is not device sync.
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    assert.equal(await page.$eval(primaryName, control => control.value), 'Alex Morgan');
    assert.equal(await page.$eval(retirement, control => control.value), '66');
    assert.equal(await page.$$eval(retirement, controls => controls.length), 1);
    assert.deepEqual((await savedState(page, householdId)).household, after.household);
    assert.deepEqual((await savedState(page, householdId)).scenarios, after.scenarios);
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-desktop-reopen.png') });
    await verifyAutoSaveRecovery(page, householdId, artifactId, screenshotDir);
    await verifyAppliedRefreshFailure(page, householdId, artifactId, screenshotDir);
    await verifyNewHouseholdSaveFailure(page, householdId, artifactId, screenshotDir);
    assert.deepEqual(pageErrors, []);
  }finally{
    await context.close();
  }
}

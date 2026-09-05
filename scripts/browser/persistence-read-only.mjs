// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { goToWizardStep } from '../wizard-browser-contract.mjs';
import { openNetWorthCategory } from '../wizard-browser-contract.mjs';
export async function verifyReadOnlyPersistence({
  page,
  stableReload,
  stableClick
}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const readOnly = 'Household storage could not be upgraded. Viewing a read-only copy; reload after storage is available.';
  const readOnlyStorageHook = await page.evaluateOnNewDocument(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'parallax.households.v1') throw new Error('QuotaExceededError');
      return orig.call(this, key, value);
    };
  });
  await page.evaluate(() => {
    localStorage.clear();
    const base = (id, name, spouse) => ({
      meta: {
        householdId: id,
        name,
        isDemo: id === 'demo',
        primaryName: name,
        spouseName: spouse ? 'Co-Client' : '',
        filingStatus: spouse ? 'marriedFilingJointly' : 'single',
        state: 'VA',
        accountSchemaVersion: 0
      },
      household: {
        primary: {
          currentAge: 60,
          retirementAge: 65,
          planEndAge: 90,
          birthYear: 1966
        },
        spouse: spouse ? {
          currentAge: 59,
          retirementAge: 65,
          birthYear: 1967
        } : null,
        children: []
      },
      portfolio: {
        riskProfile: 3,
        accounts: {
          taxable: {
            balance: 0,
            basisPct: 1
          },
          traditional: {
            balance: 0
          },
          roth: {
            balance: 0
          }
        },
        extraAccounts: spouse ? [{
          type: 'Brokerage (taxable)',
          bucket: 'taxable',
          owner: 'client',
          balance: 1000
        }, {
          type: 'Roth IRA',
          bucket: 'roth',
          owner: 'spouse',
          balance: 2000
        }] : [{
          type: 'Traditional IRA',
          bucket: 'traditional',
          owner: 'client',
          balance: 3000
        }]
      },
      expenses: {
        living: spouse ? 24000 : 12000,
        healthcare: 0,
        healthcareRealGrowth: 0.02,
        extra: [{
          label: 'Travel',
          amount: 1200,
          startAge: 65,
          endAge: 80
        }]
      },
      income: {
        socialSecurity: {
          primary: {
            pia: 0,
            claimAge: 67
          },
          spouse: spouse ? {
            pia: 0,
            claimAge: 67
          } : null
        },
        pension: {
          benefitByAge: {},
          base: 0,
          startAge: 65,
          colaPct: 0
        },
        other: [{
          label: 'Consulting',
          amount: 2400,
          startAge: 60,
          endAge: 64,
          realGrowth: 0,
          taxablePct: 1
        }],
        workingIncome: 0
      },
      savings: {
        annual: 0
      },
      goals: [],
      simulation: {
        iterations: 1000
      }
    });
    const db = {
      demo: base('demo', 'Read Only Demo', true),
      other: base('other', 'Read Only Other', false)
    };
    localStorage.setItem('parallax.households.v1', JSON.stringify(db));
    localStorage.setItem('parallax.activeHouseholdId', 'demo');
    localStorage.setItem('parallax.scenarios.demo.v1', JSON.stringify([{
      name: 'Baseline',
      base: true,
      lev: {}
    }, {
      name: 'Scenario B',
      base: false,
      lev: {}
    }]));
    localStorage.setItem('parallax.scenarios.other.v1', JSON.stringify([{
      name: 'Baseline',
      base: true,
      lev: {}
    }, {
      name: 'Other B',
      base: false,
      lev: {}
    }]));
  });
  // Navigation only establishes the document. The exact Joe/wizard and pinned
  // recovery-state assertions below establish application readiness; waiting
  // for network idle also charges synchronous startup projection work to the
  // navigation deadline on a slower runner.
  await stableReload({
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  const readOnlyStartup = await page.evaluate(() => ({
    selected: document.querySelector('#hh-switch')?.value || '',
    railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
    screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
    options: [...document.querySelectorAll('#hh-switch option')].map(option => option.value)
  }));
  if (readOnlyStartup.selected !== 'joe-household' || readOnlyStartup.railName !== 'Joe Household' || readOnlyStartup.screenCount !== 1 || !readOnlyStartup.options.includes('now-household') || !readOnlyStartup.options.includes('future-household') || !readOnlyStartup.options.includes('joe-household') || !readOnlyStartup.options.includes('other') || readOnlyStartup.options.includes('demo')) {
    throw new Error(`read-only startup did not render Joe with the preserved selector: ${JSON.stringify(readOnlyStartup)}`);
  }
  const beforeSaved = await page.$eval('[data-hh-wizard-root]', element => Number(element.dataset.renderRevision));
  await page.select('#hh-switch', 'other');
  await waitForWizard(page, {
    afterRevision: beforeSaved,
    householdId: 'other'
  });
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
  const assertPinned = async label => {
    const status = await page.$eval('#status', el => el.textContent.trim());
    if (status !== readOnly) throw new Error(`${label}: read-only status was not pinned (got "${status}")`);
  };
  const assertBytesUnchanged = async label => {
    const current = await readRecoveryBytes();
    if (JSON.stringify(current) !== JSON.stringify(beforeBytes)) {
      throw new Error(`${label}: read-only interaction changed DB/pointer/scenario bytes`);
    }
  };
  await assertPinned('initial load');
  const globalControls = await page.evaluate(() => ({
    saveExists: Boolean(document.querySelector('#save-btn')),
    newHousehold: document.querySelector('#hh-new')?.disabled,
    switchDisabled: document.querySelector('#hh-switch')?.disabled,
    loadDemoExists: Boolean(document.querySelector('#hh-load-demo')),
    householdStepCount: document.querySelectorAll('.hh-step').length,
    householdStepsDisabled: [...document.querySelectorAll('.hh-step')].some(el => el.disabled)
  }));
  if (globalControls.saveExists || !globalControls.newHousehold) throw new Error(`read-only must omit Save and disable New: ${JSON.stringify(globalControls)}`);
  if (!globalControls.householdStepCount || globalControls.switchDisabled || globalControls.loadDemoExists || globalControls.householdStepsDisabled) {
    throw new Error(`read-only navigation must stay enabled: ${JSON.stringify(globalControls)}`);
  }

  // The Goals surface shares the same read-only orchestration boundary. Its
  // inputs and action controls must expose a disabled state, while the top
  // navigation that reaches the surface remains usable.
  await stableClick('.htab[data-sub-target="goals"]');
  await sleep(500);
  const goalsControls = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('#np-content input, #np-content select, #np-content textarea, #np-content button, #np-content [role="button"], #np-content [data-add], #np-content [data-act]')];
    const locked = el => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    return {
      count: controls.length,
      enabled: controls.filter(el => !locked(el)).map(el => el.id || el.dataset.path || el.dataset.act || el.textContent.trim()).slice(0, 8)
    };
  });
  if (!goalsControls.count || goalsControls.enabled.length) {
    throw new Error(`read-only Goals controls must all be disabled: ${JSON.stringify(goalsControls)}`);
  }
  await assertPinned('goals controls');
  await assertBytesUnchanged('goals controls');

  // Family fields remain visible for recovery context, but every mutation is
  // disabled and the guarded command boundary rejects synthetic events.
  await goToWizardStep(page, 'family');
  const familyBefore = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('[data-hh-wizard-screen="family"] [data-wizard-field]')];
    return {
      count: controls.length,
      enabled: controls.filter(element => !element.disabled).map(element => element.dataset.wizardField),
      primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
      filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
      people: document.querySelectorAll('[data-person-owner]').length
    };
  });
  if (!familyBefore.count || familyBefore.enabled.length) {
    throw new Error(`read-only Family fields must all be disabled: ${JSON.stringify(familyBefore)}`);
  }
  await page.evaluate(() => {
    const name = document.querySelector('[data-wizard-field="primaryName"]');
    name.value = 'Changed despite read-only';
    name.dispatchEvent(new Event('change', {
      bubbles: true
    }));
    const filing = document.querySelector('[data-wizard-field="filingStatus"]');
    filing.value = 'single';
    filing.dispatchEvent(new Event('change', {
      bubbles: true
    }));
  });
  await goToWizardStep(page, 'net-worth');
  await goToWizardStep(page, 'family');
  const familyAfter = await page.evaluate(() => ({
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
    people: document.querySelectorAll('[data-person-owner]').length
  }));
  if (JSON.stringify(familyAfter) !== JSON.stringify({
    primaryName: familyBefore.primaryName,
    filingStatus: familyBefore.filingStatus,
    people: familyBefore.people
  })) {
    throw new Error(`read-only Family edit changed immediate state: ${JSON.stringify({
      familyBefore,
      familyAfter
    })}`);
  }
  await assertPinned('Family fields');
  await assertBytesUnchanged('Family fields');

  // Net Worth category navigation remains available, while every mutation
  // stays inert even when a synthetic event targets a disabled control.
  await openNetWorthCategory(page, 'investment');
  const accountBefore = await page.evaluate(() => {
    const remove = [...document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]')];
    const picks = [...document.querySelectorAll('[data-hh-action="net-worth-pick-type"]')];
    return {
      ids: remove.map(button => button.dataset.accountId),
      values: remove.map(button => button.closest('.nw-saved-row')?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''),
      removeCount: remove.length,
      removeEnabled: remove.filter(element => !element.disabled).length,
      pickCount: picks.length,
      pickEnabled: picks.filter(element => !element.disabled).length,
      draftCount: document.querySelectorAll('[data-net-worth-draft]').length
    };
  });
  if (!accountBefore.ids.length || !accountBefore.removeCount || accountBefore.removeEnabled || !accountBefore.pickCount || accountBefore.pickEnabled || accountBefore.draftCount) {
    throw new Error(`read-only Net Worth controls are not disabled: ${JSON.stringify(accountBefore)}`);
  }
  await page.evaluate(() => {
    document.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]')?.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    }));
    document.querySelector('[data-hh-action="net-worth-pick-type"]')?.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    }));
  });
  await goToWizardStep(page, 'family');
  await openNetWorthCategory(page, 'investment');
  const accountAfter = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]')].map(button => button.dataset.accountId),
    values: [...document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]')].map(button => button.closest('.nw-saved-row')?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''),
    draftCount: document.querySelectorAll('[data-net-worth-draft]').length
  }));
  if (JSON.stringify(accountAfter.ids) !== JSON.stringify(accountBefore.ids) || JSON.stringify(accountAfter.values) !== JSON.stringify(accountBefore.values) || accountAfter.draftCount) {
    throw new Error(`read-only Net Worth edit changed immediate state: ${JSON.stringify({
      accountBefore,
      accountAfter
    })}`);
  }
  await assertPinned('Net Worth add/remove');
  await assertBytesUnchanged('Net Worth add/remove');

  // Tax fields and completion are guarded mutations. View controls may remain
  // navigable, while source-override and remove-item actions must be disabled.
  await goToWizardStep(page, 'tax');
  const taxBefore = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('[data-tax-field]')];
    const mutations = [...document.querySelectorAll('[data-hh-action="override-income-group"],' + ' [data-hh-action="revert-income-group"],' + ' [data-hh-action="remove-tax-item"]')];
    return {
      fieldCount: fields.length,
      enabledFields: fields.filter(element => !element.disabled).map(element => element.dataset.taxField),
      taxYear: document.querySelector('[data-tax-field="taxYear"]')?.value || '',
      mutationCount: mutations.length,
      enabledMutations: mutations.filter(element => !element.disabled).map(element => element.dataset.hhAction)
    };
  });
  if (!taxBefore.fieldCount || taxBefore.enabledFields.length || taxBefore.enabledMutations.length) {
    throw new Error(`read-only Tax controls are not disabled: ${JSON.stringify(taxBefore)}`);
  }
  await page.evaluate(() => {
    const taxYear = document.querySelector('[data-tax-field="taxYear"]');
    taxYear.value = taxYear.value === '2026' ? '2025' : '2026';
    taxYear.dispatchEvent(new Event('change', {
      bubbles: true
    }));
    document.querySelector('[data-hh-action="override-income-group"], [data-hh-action="revert-income-group"]')?.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    }));
  });
  await goToWizardStep(page, 'family');
  await goToWizardStep(page, 'tax');
  const taxAfter = await page.evaluate(() => ({
    taxYear: document.querySelector('[data-tax-field="taxYear"]')?.value || ''
  }));
  if (taxAfter.taxYear !== taxBefore.taxYear) {
    throw new Error(`read-only Tax edit changed immediate state: ${JSON.stringify({
      taxBefore,
      taxAfter
    })}`);
  }
  await assertPinned('Tax fields and completion');
  await assertBytesUnchanged('Tax fields and completion');

  // New Household is a mutation and must remain inert.
  const optionCountBefore = await page.$$eval('#hh-switch option', els => els.length);
  await page.evaluate(() => document.querySelector('#hh-new')?.dispatchEvent(new MouseEvent('click', {
    bubbles: true
  })));
  const optionCountAfter = await page.$$eval('#hh-switch option', els => els.length);
  if (optionCountAfter !== optionCountBefore) throw new Error('read-only New Household changed the in-memory household list');
  await assertPinned('new household');
  await assertBytesUnchanged('new household');

  // Scenarios: every mutation control is disabled; forced events cannot add,
  // open rename/delete UI, or alter a lever or scenario bytes.
  await stableClick('button[data-page="scenarios"]');
  await sleep(900);
  await stableClick('#scn-seg-compare');
  await sleep(300);
  const scenarioBefore = await page.evaluate(() => ({
    names: [...document.querySelectorAll('#scn-view .scol__name')].map(el => el.textContent.trim()),
    addDisabled: document.querySelector('#scn-add')?.disabled,
    solvePresent: !!document.querySelector('#scn-solve, #solve-panel'),
    menuCount: document.querySelectorAll('#scn-view .scol__menu').length,
    menuDisabled: [...document.querySelectorAll('#scn-view .scol__menu')].every(el => el.disabled),
    stepCount: document.querySelectorAll('#scn-view .cmp-step-btn').length,
    stepsDisabled: [...document.querySelectorAll('#scn-view .cmp-step-btn')].every(el => el.disabled),
    inputCount: document.querySelectorAll('#scn-view .cmp-lev-in, #scn-view .cmp-goal-in').length,
    inputsDisabled: [...document.querySelectorAll('#scn-view .cmp-lev-in, #scn-view .cmp-goal-in')].every(el => el.disabled),
    firstLever: document.querySelector('#scn-view .cmp-lev-in')?.value || ''
  }));
  if (!scenarioBefore.names.length || !scenarioBefore.addDisabled || scenarioBefore.solvePresent || !scenarioBefore.menuCount || !scenarioBefore.menuDisabled || !scenarioBefore.stepCount || !scenarioBefore.stepsDisabled || !scenarioBefore.inputCount || !scenarioBefore.inputsDisabled) {
    throw new Error(`read-only scenario mutation controls are not disabled: ${JSON.stringify(scenarioBefore)}`);
  }
  await page.evaluate(() => {
    document.querySelector('#scn-add')?.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    }));
    document.querySelector('#scn-view .scol__menu')?.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    }));
    document.querySelector('#scn-view .cmp-step-btn')?.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    }));
    document.querySelectorAll('#scn-reset, [data-scn-reset], [data-action="reset-scenarios"]').forEach(el => el.dispatchEvent(new MouseEvent('click', {
      bubbles: true
    })));
    const input = document.querySelector('#scn-view .cmp-lev-in');
    if (input) {
      input.value = '999999';
      input.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }
  });
  await sleep(400);
  // The direct value assignment above can change a disabled DOM input even
  // when the application correctly rejects the event. Re-render from model
  // state before asserting that no in-memory scenario value changed.
  await stableClick('#scn-seg-focus');
  await sleep(200);
  await stableClick('#scn-seg-compare');
  await sleep(300);
  const scenarioAfter = await page.evaluate(() => ({
    names: [...document.querySelectorAll('#scn-view .scol__name')].map(el => el.textContent.trim()),
    menu: !!document.querySelector('#scn-view .scol__pop, #scn-view .scol__rename'),
    firstLever: document.querySelector('#scn-view .cmp-lev-in')?.value || '',
    enabledReset: [...document.querySelectorAll('#scn-reset, [data-scn-reset], [data-action="reset-scenarios"]')].some(el => !el.disabled)
  }));
  if (JSON.stringify(scenarioAfter.names) !== JSON.stringify(scenarioBefore.names) || scenarioAfter.menu || scenarioAfter.enabledReset) {
    throw new Error(`read-only scenario add/delete/rename/reset changed immediate state: ${JSON.stringify({
      scenarioBefore,
      scenarioAfter
    })}`);
  }
  if (scenarioAfter.firstLever !== scenarioBefore.firstLever) {
    throw new Error(`read-only scenario lever changed immediate UI state (${scenarioBefore.firstLever} -> ${scenarioAfter.firstLever})`);
  }
  await assertPinned('scenario mutations');
  await assertBytesUnchanged('scenario mutations');

  // Switching is navigation in read-only mode. It must expose current shipped
  // templates and saved custom records while durable bytes remain untouched.
  await goToWizardStep(page, 'family');
  const switchState = await page.evaluate(() => ({
    disabled: document.querySelector('#hh-switch')?.disabled,
    values: [...document.querySelectorAll('#hh-switch option')].map(el => el.value)
  }));
  if (switchState.disabled || !switchState.values.includes('now-household') || !switchState.values.includes('future-household') || !switchState.values.includes('joe-household') || !switchState.values.includes('other') || switchState.values.includes('demo')) {
    throw new Error(`read-only household switch is unavailable: ${JSON.stringify(switchState)}`);
  }
  const beforeNow = await page.$eval('[data-hh-wizard-root]', element => Number(element.dataset.renderRevision));
  await page.evaluate(() => {
    const sel = document.querySelector('#hh-switch');
    sel.value = 'now-household';
    sel.dispatchEvent(new Event('change', {
      bubbles: true
    }));
  });
  await waitForWizard(page, {
    afterRevision: beforeNow,
    householdId: 'now-household'
  });
  const nowState = await page.evaluate(() => ({
    selected: document.querySelector('#hh-switch')?.value || '',
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || ''
  }));
  if (nowState.selected !== 'now-household' || nowState.primaryName !== 'Aboysname') {
    throw new Error(`read-only Now navigation did not render current facts: ${JSON.stringify(nowState)}`);
  }
  await assertPinned('switch to Now');
  await assertBytesUnchanged('switch to Now');
  const beforeOther = await page.$eval('[data-hh-wizard-root]', element => Number(element.dataset.renderRevision));
  await page.select('#hh-switch', 'other');
  await waitForWizard(page, {
    afterRevision: beforeOther,
    householdId: 'other'
  });
  const otherState = await page.evaluate(() => ({
    selected: document.querySelector('#hh-switch')?.value || '',
    rail: document.querySelector('#hh-rail-name')?.textContent.trim() || ''
  }));
  if (otherState.selected !== 'other' || !/Read Only Other/.test(otherState.rail)) {
    throw new Error(`read-only switch did not navigate the transient household: ${JSON.stringify(otherState)}`);
  }
  await assertPinned('switch to other');
  await assertBytesUnchanged('switch to other');
  await goToWizardStep(page, 'family');
  const otherFamilyBefore = await page.evaluate(() => ({
    filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
    filingDisabled: Boolean(document.querySelector('[data-wizard-field="filingStatus"]')?.disabled),
    people: document.querySelectorAll('[data-person-owner]').length
  }));
  if (otherFamilyBefore.filingStatus !== 'single' || !otherFamilyBefore.filingDisabled || otherFamilyBefore.people !== 1) {
    throw new Error(`read-only single household Family state is wrong: ${JSON.stringify(otherFamilyBefore)}`);
  }
  await page.evaluate(() => {
    const filing = document.querySelector('[data-wizard-field="filingStatus"]');
    filing.value = 'marriedFilingJointly';
    filing.dispatchEvent(new Event('change', {
      bubbles: true
    }));
  });
  await goToWizardStep(page, 'net-worth');
  await goToWizardStep(page, 'family');
  const otherFamilyAfter = await page.evaluate(() => ({
    filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
    people: document.querySelectorAll('[data-person-owner]').length
  }));
  if (otherFamilyAfter.filingStatus !== 'single' || otherFamilyAfter.people !== 1) {
    throw new Error(`read-only filing-status edit added a co-client: ${JSON.stringify(otherFamilyAfter)}`);
  }
  await assertPinned('co-client filing status');
  await assertBytesUnchanged('co-client filing status');
  const beforeFuture = await page.$eval('[data-hh-wizard-root]', element => Number(element.dataset.renderRevision));
  await page.evaluate(() => {
    const sel = document.querySelector('#hh-switch');
    sel.value = 'future-household';
    sel.dispatchEvent(new Event('change', {
      bubbles: true
    }));
  });
  await waitForWizard(page, {
    afterRevision: beforeFuture,
    householdId: 'future-household'
  });
  await assertPinned('switch to Future');
  await assertBytesUnchanged('switch to Future');
  await stableReload({
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  await assertPinned('read-only reload');
  await assertBytesUnchanged('read-only reload');
  await page.removeScriptToEvaluateOnNewDocument(readOnlyStorageHook.identifier);
}

// Wizard browser contract: actions.
import { WIZARD_STEP_IDS, ROOT_SELECTOR } from './selectors.mjs';
import { requireCondition, countMatches, requireUnique } from './assertions.mjs';
export async function wizardState(page) {
  return page.evaluate(rootSelector => {
    const root = document.querySelector(rootSelector);
    const screens = [...document.querySelectorAll('[data-hh-wizard-screen]')];
    const visibleScreens = screens.filter(screen => {
      const style = getComputedStyle(screen);
      const rect = screen.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    const currentNav = document.querySelector('[data-hh-wizard-nav][aria-current="step"]');
    return {
      ready: root?.dataset.wizardReady || '',
      busy: root?.getAttribute('aria-busy') || '',
      step: root?.dataset.wizardStep || '',
      revision: Number(root?.dataset.renderRevision || -1),
      householdId: root?.dataset.householdId || '',
      screenCount: screens.length,
      visibleScreenCount: visibleScreens.length,
      visibleScreen: visibleScreens[0]?.dataset.hhWizardScreen || '',
      currentNav: currentNav?.dataset.hhWizardNav || '',
      activePage: document.querySelector('.page.on')?.dataset.page || ''
    };
  }, ROOT_SELECTOR);
}
export async function waitForWizard(page, {
  step = null,
  afterRevision = -1,
  householdId = null,
  timeout = 15000
} = {}) {
  try {
    await page.waitForFunction(({
      rootSelector,
      expectedStep,
      minimumRevision,
      expectedHousehold
    }) => {
      const root = document.querySelector(rootSelector);
      if (!root || root.dataset.wizardReady !== 'true' || root.getAttribute('aria-busy') !== 'false') {
        return false;
      }
      const revision = Number(root.dataset.renderRevision || -1);
      if (revision <= minimumRevision) return false;
      if (expectedStep && root.dataset.wizardStep !== expectedStep) return false;
      if (expectedHousehold && root.dataset.householdId !== expectedHousehold) return false;
      const screens = [...document.querySelectorAll('[data-hh-wizard-screen]')];
      const visible = screens.filter(screen => {
        const style = getComputedStyle(screen);
        const rect = screen.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      const currentNav = document.querySelector('[data-hh-wizard-nav][aria-current="step"]');
      return screens.length === 1 && visible.length === 1 && visible[0].dataset.hhWizardScreen === root.dataset.wizardStep && currentNav?.dataset.hhWizardNav === root.dataset.wizardStep;
    }, {
      timeout
    }, {
      rootSelector: ROOT_SELECTOR,
      expectedStep: step,
      minimumRevision: afterRevision,
      expectedHousehold: householdId
    });
  } catch (error) {
    let observed;
    try {
      observed = await wizardState(page);
    } catch (stateError) {
      observed = {
        stateReadError: stateError.message
      };
    }
    throw new Error(`Wizard readiness timeout. Expected ${JSON.stringify({
      step,
      afterRevision,
      householdId,
      timeout
    })}; observed ${JSON.stringify(observed)}. ${error.message}`, { cause: error });
  }
  return wizardState(page);
}
export async function waitForUnselectedWizard(page, {
  timeout = 15000
} = {}) {
  try {
    await page.waitForFunction(rootSelector => {
      const root = document.querySelector(rootSelector);
      const view = document.querySelector('#hh-view');
      const footer = document.querySelector('#hh-wiz-footer');
      const selector = document.querySelector('#hh-switch');
      const menu = document.querySelector('#hh-menu-pop');
      return root?.dataset.wizardReady === 'true' && root.getAttribute('aria-busy') === 'false' && root.dataset.householdId === '' && root.dataset.wizardStep === '' && selector?.value === '' && menu?.hidden === false && document.querySelector('.hh-progress')?.hidden === true && document.querySelector('.hh-stepper')?.hidden === true && footer?.hidden === true && !view?.querySelector('[data-hh-wizard-screen]') && !(footer?.textContent || '').trim();
    }, {
      timeout
    }, ROOT_SELECTOR);
  } catch (error) {
    const observed = await page.evaluate(() => ({
      root: document.querySelector('[data-hh-wizard-root]')?.dataset || null,
      busy: document.querySelector('[data-hh-wizard-root]')?.getAttribute('aria-busy'),
      selected: document.querySelector('#hh-switch')?.value,
      menuHidden: document.querySelector('#hh-menu-pop')?.hidden,
      progressHidden: document.querySelector('.hh-progress')?.hidden,
      stepperHidden: document.querySelector('.hh-stepper')?.hidden,
      footerHidden: document.querySelector('#hh-wiz-footer')?.hidden,
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length
    })).catch(stateError => ({
      stateReadError: stateError.message
    }));
    throw new Error(`Unselected wizard readiness timeout; observed ${JSON.stringify(observed)}. ${error.message}`, { cause: error });
  }
  return wizardState(page);
}
export async function openWizard(page) {
  const active = await page.evaluate(() => document.querySelector('.page.on')?.dataset.page || '');
  const before = await wizardState(page);
  if (active !== 'household') {
    await requireUnique(page, '.htab[data-page="household"]', 'Household tab');
    await page.click('.htab[data-page="household"]');
    if (!before.householdId) return waitForUnselectedWizard(page);
    return waitForWizard(page, {
      afterRevision: before.revision
    });
  }
  if (!before.householdId) return waitForUnselectedWizard(page);
  return waitForWizard(page, {
    step: before.step || null,
    afterRevision: -1
  });
}
export async function goToWizardStep(page, step) {
  requireCondition(WIZARD_STEP_IDS.includes(step), `Unsupported wizard step "${step}"`);
  await openWizard(page);
  let before = await wizardState(page);
  if (before.step === step) return before;
  if (before.step === 'net-worth') {
    if (await countMatches(page, '[data-net-worth-overlay]')) {
      await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
      before = await wizardState(page);
    }
  }
  const selector = `[data-hh-wizard-nav="${step}"]`;
  await requireUnique(page, selector, `wizard navigation ${step}`);
  await page.click(selector);
  return waitForWizard(page, {
    step,
    afterRevision: before.revision
  });
}
export async function setWizardValue(page, selector, value, {
  expectRevision = true,
  eventType = 'change'
} = {}) {
  await requireUnique(page, selector);
  const before = await wizardState(page);
  await page.evaluate(({
    fieldSelector,
    nextValue,
    inputEvent
  }) => {
    const control = document.querySelector(fieldSelector);
    control.value = String(nextValue);
    control.dispatchEvent(new Event(inputEvent, {
      bubbles: true
    }));
  }, {
    fieldSelector: selector,
    nextValue: value,
    inputEvent: eventType
  });
  if (expectRevision) {
    return waitForWizard(page, {
      step: before.step,
      afterRevision: before.revision
    });
  }
  const after = await wizardState(page);
  requireCondition(after.revision === before.revision && after.step === before.step, `${selector} unexpectedly changed wizard state`);
  return after;
}
export async function clickWizardAction(page, selector, {
  expectRevision = true,
  expectedStep = null
} = {}) {
  await requireUnique(page, selector);
  const before = await wizardState(page);
  try {
    await page.click(selector);
  } catch (error) {
    throw new Error(`Unable to click wizard action ${selector}: ${error.message}`, { cause: error });
  }
  if (expectRevision) {
    return waitForWizard(page, {
      step: expectedStep || before.step,
      afterRevision: before.revision
    });
  }
  const after = await wizardState(page);
  requireCondition(after.revision === before.revision && after.step === (expectedStep || before.step), `${selector} unexpectedly changed wizard state`);
  return after;
}
export async function openNetWorthCategory(page, categoryId) {
  await goToWizardStep(page, 'net-worth');
  const openCategory = await page.evaluate(() => document.querySelector('[data-net-worth-category-id]')?.dataset.netWorthCategoryId || '');
  if (openCategory === categoryId) return wizardState(page);
  if (openCategory) {
    await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  }
  await clickWizardAction(page, `[data-hh-action="net-worth-open-category"][data-category-id="${categoryId}"]`);
  await requireUnique(page, `[data-net-worth-category-id="${categoryId}"]`, `Net Worth ${categoryId} panel`);
  return wizardState(page);
}
export async function selectNetWorthAllocation(page, presetId) {
  const selector = `[data-allocation-option-id="${presetId}"]`;
  await requireUnique(page, selector, `asset allocation ${presetId}`);
  const before = await wizardState(page);
  await page.click(selector);
  const selected = await page.$eval(`${selector} input[data-net-worth-draft="allocationPresetId"]`, input => input.checked);
  const after = await wizardState(page);
  requireCondition(selected && after.revision === before.revision && after.step === before.step, `Asset allocation ${presetId} did not remain an in-form selection`);
}
export async function reloadWizard(page) {
  const priorHouseholdId = await page.$eval('#hh-switch', selector => selector.value).catch(() => null);
  await page.reload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  const startup = await waitForWizard(page, {
    householdId: 'joe-household'
  });
  if (priorHouseholdId) {
    const available = await page.$$eval('#hh-switch option', (options, householdId) => options.some(option => option.value === householdId), priorHouseholdId);
    if (available) {
      return selectHouseholdVisible(page, priorHouseholdId);
    }
  }
  return startup;
}
export async function selectHouseholdVisible(page, householdId) {
  const before = await wizardState(page);
  if (before.householdId === householdId) return before;
  const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
  if (menuHidden) {
    await clickWizardAction(page, '#hh-menu-btn', {
      expectRevision: false
    });
  }
  await requireUnique(page, '#hh-menu-pop:not([hidden]) #hh-switch', 'visible household switcher');
  const optionCount = await page.$$eval('#hh-switch option', (options, expectedId) => options.filter(option => option.value === expectedId).length, householdId);
  requireCondition(optionCount === 1, `Household ${householdId} must be selectable exactly once; found ${optionCount}`);
  const selected = await page.select('#hh-switch', householdId);
  requireCondition(selected.length === 1 && selected[0] === householdId, `Visible household switch did not select ${householdId}: ${JSON.stringify(selected)}`);
  return waitForWizard(page, {
    householdId,
    afterRevision: before.revision
  });
}

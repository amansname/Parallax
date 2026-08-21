import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const WIZARD_STEP_IDS = Object.freeze([
  'family',
  'net-worth',
  'tax',
  'summary',
]);

const ROOT_SELECTOR = '[data-hh-wizard-root]';
const SCREEN_SELECTOR = '[data-hh-wizard-screen]';
const APP_ORIGIN_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//;

function requireCondition(condition, message){
  if(!condition) throw new Error(message);
}

async function countMatches(page, selector){
  return page.evaluate(
    value => document.querySelectorAll(value).length,
    selector,
  );
}

async function requireUnique(page, selector, label = selector){
  const count = await countMatches(page, selector);
  requireCondition(count === 1, `${label} must resolve exactly once; found ${count}`);
}

async function wizardState(page){
  return page.evaluate(rootSelector => {
    const root = document.querySelector(rootSelector);
    const screens = [...document.querySelectorAll('[data-hh-wizard-screen]')];
    const visibleScreens = screens.filter(screen => {
      const style = getComputedStyle(screen);
      const rect = screen.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    });
    const currentNav = document.querySelector(
      '[data-hh-wizard-nav][aria-current="step"]',
    );
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
      activePage: document.querySelector('.page.on')?.dataset.page || '',
    };
  }, ROOT_SELECTOR);
}

export async function waitForWizard(
  page,
  {
    step = null,
    afterRevision = -1,
    householdId = null,
    timeout = 15000,
  } = {},
){
  try{
    await page.waitForFunction(
      ({ rootSelector, expectedStep, minimumRevision, expectedHousehold }) => {
        const root = document.querySelector(rootSelector);
        if(!root
            || root.dataset.wizardReady !== 'true'
            || root.getAttribute('aria-busy') !== 'false'){
          return false;
        }
        const revision = Number(root.dataset.renderRevision || -1);
        if(revision <= minimumRevision) return false;
        if(expectedStep && root.dataset.wizardStep !== expectedStep) return false;
        if(expectedHousehold && root.dataset.householdId !== expectedHousehold) return false;
        const screens = [...document.querySelectorAll('[data-hh-wizard-screen]')];
        const visible = screens.filter(screen => {
          const style = getComputedStyle(screen);
          const rect = screen.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        });
        const currentNav = document.querySelector(
          '[data-hh-wizard-nav][aria-current="step"]',
        );
        return screens.length === 1
          && visible.length === 1
          && visible[0].dataset.hhWizardScreen === root.dataset.wizardStep
          && currentNav?.dataset.hhWizardNav === root.dataset.wizardStep;
      },
      { timeout },
      {
        rootSelector: ROOT_SELECTOR,
        expectedStep: step,
        minimumRevision: afterRevision,
        expectedHousehold: householdId,
      },
    );
  }catch(error){
    let observed = null;
    try{
      observed = await wizardState(page);
    }catch(stateError){
      observed = { stateReadError: stateError.message };
    }
    throw new Error(
      `Wizard readiness timeout. Expected ${JSON.stringify({
        step,
        afterRevision,
        householdId,
        timeout,
      })}; observed ${JSON.stringify(observed)}. ${error.message}`,
    );
  }
  return wizardState(page);
}

export async function openWizard(page){
  const active = await page.evaluate(() =>
    document.querySelector('.page.on')?.dataset.page || '');
  const before = await wizardState(page);
  if(active !== 'household'){
    await requireUnique(page, '.htab[data-page="household"]', 'Household tab');
    await page.click('.htab[data-page="household"]');
    return waitForWizard(page, { afterRevision: before.revision });
  }
  return waitForWizard(page, {
    step: before.step || null,
    afterRevision: -1,
  });
}

export async function goToWizardStep(page, step){
  requireCondition(
    WIZARD_STEP_IDS.includes(step),
    `Unsupported wizard step "${step}"`,
  );
  await openWizard(page);
  let before = await wizardState(page);
  if(before.step === step) return before;
  if(before.step === 'net-worth'){
    if(await countMatches(page, '[data-net-worth-overlay]')){
      await clickWizardAction(
        page,
        '[data-net-worth-overlay] .nw-panel-close',
      );
      before = await wizardState(page);
    }
  }
  const selector = `[data-hh-wizard-nav="${step}"]`;
  await requireUnique(page, selector, `wizard navigation ${step}`);
  await page.click(selector);
  return waitForWizard(page, { step, afterRevision: before.revision });
}

async function setWizardValue(
  page,
  selector,
  value,
  {
    expectRevision = true,
    eventType = 'change',
  } = {},
){
  await requireUnique(page, selector);
  const before = await wizardState(page);
  await page.evaluate(({ fieldSelector, nextValue, inputEvent }) => {
    const control = document.querySelector(fieldSelector);
    control.value = String(nextValue);
    control.dispatchEvent(new Event(inputEvent, { bubbles: true }));
  }, {
    fieldSelector: selector,
    nextValue: value,
    inputEvent: eventType,
  });
  if(expectRevision){
    return waitForWizard(page, {
      step: before.step,
      afterRevision: before.revision,
    });
  }
  const after = await wizardState(page);
  requireCondition(
    after.revision === before.revision && after.step === before.step,
    `${selector} unexpectedly changed wizard state`,
  );
  return after;
}

async function clickWizardAction(
  page,
  selector,
  {
    expectRevision = true,
    expectedStep = null,
  } = {},
){
  await requireUnique(page, selector);
  const before = await wizardState(page);
  try{
    await page.click(selector);
  }catch(error){
    throw new Error(`Unable to click wizard action ${selector}: ${error.message}`);
  }
  if(expectRevision){
    return waitForWizard(page, {
      step: expectedStep || before.step,
      afterRevision: before.revision,
    });
  }
  const after = await wizardState(page);
  requireCondition(
    after.revision === before.revision
      && after.step === (expectedStep || before.step),
    `${selector} unexpectedly changed wizard state`,
  );
  return after;
}

export async function openNetWorthCategory(page, categoryId){
  await goToWizardStep(page, 'net-worth');
  const openCategory = await page.evaluate(() =>
    document.querySelector('[data-net-worth-category-id]')
      ?.dataset.netWorthCategoryId || '');
  if(openCategory === categoryId) return wizardState(page);
  if(openCategory){
    await clickWizardAction(
      page,
      '[data-net-worth-overlay] .nw-panel-close',
    );
  }
  await clickWizardAction(
    page,
    `[data-hh-action="net-worth-open-category"][data-category-id="${categoryId}"]`,
  );
  await requireUnique(
    page,
    `[data-net-worth-category-id="${categoryId}"]`,
    `Net Worth ${categoryId} panel`,
  );
  return wizardState(page);
}

async function snapshotStorage(page){
  return page.evaluate(() => {
    const snapshot = {};
    for(let index = 0; index < localStorage.length; index += 1){
      const key = localStorage.key(index);
      snapshot[key] = localStorage.getItem(key);
    }
    return snapshot;
  });
}

async function restoreStorage(page, snapshot){
  await page.evaluate(entries => {
    localStorage.clear();
    for(const [key, value] of Object.entries(entries)){
      localStorage.setItem(key, value);
    }
  }, snapshot);
}

function stableStorageSnapshot(snapshot){
  const runtimeIds = new Set([
    'demo',
    'default-pre-retirement-solo',
    'default-pre-retirement-couple',
  ]);
  const ownerStorage = Object.fromEntries(Object.entries(snapshot || {}).flatMap(([key, value]) => {
    if(key === 'parallax.activeHouseholdId') return [];
    if(key.startsWith('parallax.scenarios.')){
      const householdId = key.slice('parallax.scenarios.'.length, -'.v1'.length);
      if(runtimeIds.has(householdId)) return [];
    }
    if(key !== 'parallax.households.v1') return [[key, value]];
    const database = JSON.parse(value || 'null');
    const savedHouseholds = Object.fromEntries(
      Object.entries(database || {}).filter(([householdId]) => !runtimeIds.has(householdId)),
    );
    return [[key, JSON.stringify(savedHouseholds)]];
  }));
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(ownerStorage).sort(([left], [right]) =>
        left.localeCompare(right)),
    ),
  );
}

async function reloadWizard(page){
  const priorHouseholdId = await page.$eval(
    '#hh-switch',
    selector => selector.value,
  ).catch(() => null);
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await waitForWizard(page, { householdId: 'demo' });
  if(priorHouseholdId && priorHouseholdId !== 'demo'){
    const available = await page.$$eval(
      '#hh-switch option',
      (options, householdId) => options.some(option => option.value === householdId),
      priorHouseholdId,
    );
    if(available){
      return selectHouseholdVisible(page, priorHouseholdId);
    }
  }
  return waitForWizard(page, { householdId: 'demo' });
}

async function selectHouseholdVisible(page, householdId){
  const before = await wizardState(page);
  if(before.householdId === householdId) return before;
  const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
  if(menuHidden){
    await clickWizardAction(page, '#hh-menu-btn', { expectRevision: false });
  }
  await requireUnique(
    page,
    '#hh-menu-pop:not([hidden]) #hh-switch',
    'visible household switcher',
  );
  const optionCount = await page.$$eval(
    '#hh-switch option',
    (options, expectedId) => options.filter(option => option.value === expectedId).length,
    householdId,
  );
  requireCondition(
    optionCount === 1,
    `Household ${householdId} must be selectable exactly once; found ${optionCount}`,
  );
  const selected = await page.select('#hh-switch', householdId);
  requireCondition(
    selected.length === 1 && selected[0] === householdId,
    `Visible household switch did not select ${householdId}: ${JSON.stringify(selected)}`,
  );
  return waitForWizard(page, {
    householdId,
    afterRevision: before.revision,
  });
}

async function settleWizardCapture(page){
  await waitForWizard(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if(!document.querySelector('#wizard-capture-freeze')){
      const style = document.createElement('style');
      style.id = 'wizard-capture-freeze';
      style.textContent = `
        [data-hh-wizard-root],
        [data-hh-wizard-root] *,
        [data-hh-wizard-root] *::before,
        [data-hh-wizard-root] *::after {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
      `;
      document.head.append(style);
    }
  });
  await page.waitForFunction(
    () => !document.fonts || document.fonts.status === 'loaded',
    { timeout: 8000 },
  );
  await page.evaluate(async () => {
    if(document.fonts?.ready) await document.fonts.ready;
    await new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function enableFullPageWizardCapture(page){
  await page.evaluate(() => {
    let style = document.querySelector('#wizard-fullpage-capture');
    if(!style){
      style = document.createElement('style');
      style.id = 'wizard-fullpage-capture';
      document.head.append(style);
    }
    style.textContent = `
      html,
      body {
        height: auto !important;
        min-height: 100% !important;
        overflow: visible !important;
      }
      .wrap {
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
      .page[data-page="household"].on {
        flex: none !important;
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-stage {
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-wizard {
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-wiz-workspace {
        flex: none !important;
        height: auto !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-content {
        min-height: 0 !important;
      }
    `;
  });
  await settleWizardCapture(page);
}

function pngDimensions(path){
  const bytes = readFileSync(path);
  requireCondition(
    bytes.length >= 24
      && bytes.toString('ascii', 1, 4) === 'PNG',
    `${path} is not a readable PNG`,
  );
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function captureFullWizardArtifact(page, path){
  await enableFullPageWizardCapture(page);
  const metrics = await page.evaluate(() => {
    const workspace = document.querySelector('.hh-wiz-workspace');
    const footer = document.querySelector('[data-hh-wizard-footer]');
    const footerRect = footer?.getBoundingClientRect();
    return {
      documentHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ),
      workspaceClientHeight: workspace?.clientHeight ?? null,
      workspaceScrollHeight: workspace?.scrollHeight ?? null,
      workspaceOverflow: workspace ? getComputedStyle(workspace).overflowY : null,
      footerBottom: footerRect?.bottom ?? null,
    };
  });
  requireCondition(
    metrics.workspaceOverflow === 'visible'
      && metrics.workspaceScrollHeight <= metrics.workspaceClientHeight + 1
      && metrics.footerBottom <= metrics.documentHeight + 1,
    `Wizard full-page capture is clipped: ${JSON.stringify(metrics)}`,
  );
  await page.screenshot({ path, fullPage: true });
  const image = pngDimensions(path);
  requireCondition(
    image.height >= metrics.documentHeight - 1,
    `Wizard PNG height ${image.height} misses document height ${metrics.documentHeight}`,
  );
  return { image, metrics };
}

function diagnosticText(entry){
  if(entry instanceof Error) return entry.message;
  return String(entry || '');
}

function ignoredExternalFontFailure(text, url = ''){
  return /fonts\.(?:googleapis|gstatic)\.com/.test(`${text} ${url}`);
}

export function attachBrowserDiagnostics(page){
  const failures = [];
  const onPageError = error => failures.push(`PAGE: ${diagnosticText(error)}`);
  const onConsole = message => {
    if(!['error', 'warning', 'warn'].includes(message.type())) return;
    const text = message.text();
    const url = message.location()?.url || '';
    if(ignoredExternalFontFailure(text, url)) return;
    failures.push(`CONSOLE ${message.type()}: ${text}${url ? ` @ ${url}` : ''}`);
  };
  const onRequestFailed = request => {
    const url = request.url();
    const text = request.failure()?.errorText || 'request failed';
    if(ignoredExternalFontFailure(text, url)) return;
    if(APP_ORIGIN_PATTERN.test(url)){
      failures.push(`REQUEST: ${text} @ ${url}`);
    }
  };
  const onResponse = response => {
    const url = response.url();
    if(APP_ORIGIN_PATTERN.test(url) && response.status() >= 400){
      failures.push(`HTTP ${response.status()}: ${url}`);
    }
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  return {
    failures,
    assertClean(){
      requireCondition(
        failures.length === 0,
        `Wizard browser diagnostics failed:\n${failures.join('\n')}`,
      );
    },
    dispose(){
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

async function prepareContractFixture(page){
  const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
  if(menuHidden){
    await clickWizardAction(page, '#hh-menu-btn', { expectRevision: false });
  }
  await requireUnique(page, '#hh-menu-pop:not([hidden]) #hh-new', 'visible new household action');
  await clickWizardAction(page, '#hh-new');
  await page.waitForFunction(() => {
    const selected = document.querySelector('#hh-switch')?.value;
    return selected && selected !== 'demo'
      && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
  }, { timeout: 10000 });
  await page.evaluate(() => {
    const dbKey = 'parallax.households.v1';
    const activeKey = 'parallax.activeHouseholdId';
    const db = JSON.parse(localStorage.getItem(dbKey) || 'null');
    const active = localStorage.getItem(activeKey);
    const plan = db?.[active];
    if(!plan) throw new Error('Active household fixture is unavailable');
    plan.meta.primaryName = 'Verifier Client';
    plan.meta.spouseName = '';
    plan.meta.filingStatus = 'single';
    plan.household.spouse = null;
    plan.household.primary.retirementAge = 70;
    plan.income.socialSecurity.spouse = null;
    plan.portfolio.extraAccounts = [];
    plan.properties = [];
    plan.income.other = [
      {
        id: 'verify_wage_one',
        typeId: 'wages',
        owner: 'client',
        label: 'Salary one',
        amount: 50000,
        startAge: 0,
        endAge: 999,
        realGrowth: 0,
        taxablePct: 1,
      },
      {
        id: 'verify_wage_two',
        typeId: 'wages',
        owner: 'client',
        label: 'Salary two',
        amount: 25000,
        startAge: 0,
        endAge: 999,
        realGrowth: 0,
        taxablePct: 1,
      },
    ];
    if(plan.incomeTax && typeof plan.incomeTax === 'object'){
      delete plan.incomeTax.current1040;
      plan.incomeTax.deductionMode = 'auto';
    }
    localStorage.setItem(dbKey, JSON.stringify(db));
  });
  await reloadWizard(page);
}

async function verifyRuntimeTemplateDurableCopy(page){
  await openWizard(page);
  await selectHouseholdVisible(page, 'demo');
  await goToWizardStep(page, 'family');
  await requireUnique(
    page,
    '[data-wizard-field="primaryName"]',
    'Demo legal-name field',
  );
  const sourceBefore = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return JSON.stringify(db?.demo || null);
  });
  requireCondition(
    sourceBefore && sourceBefore !== 'null',
    'Demo runtime source was unavailable before the edit',
  );

  const editedName = 'Runtime save verifier';
  await setWizardValue(
    page,
    '[data-wizard-field="primaryName"]',
    editedName,
  );
  const copied = await page.evaluate(({ expectedName, expectedSource }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const record = db?.[active];
    return {
      active,
      rootHouseholdId: document.querySelector('[data-hh-wizard-root]')
        ?.dataset.householdId || '',
      selectedHouseholdId: document.querySelector('#hh-switch')?.value || '',
      selectedHouseholdName: document.querySelector('#hh-switch')
        ?.selectedOptions?.[0]?.textContent.trim() || '',
      railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
      status: document.querySelector('#status')?.textContent.trim() || '',
      visibleName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
      sourceUnchanged: JSON.stringify(db?.demo || null) === expectedSource,
      sourceVisibleName: db?.demo?.meta?.primaryName || '',
      recordName: record?.meta?.name || '',
      runtimeSourceHouseholdId: record?.meta?.runtimeSourceHouseholdId || '',
      isDemo: record?.meta?.isDemo,
      isSelectableDefault: record?.meta?.isSelectableDefault,
      savedName: record?.meta?.primaryName || '',
      customCount: Object.values(db || {}).filter(item =>
        item?.meta?.runtimeSourceHouseholdId === 'demo'
        && item?.meta?.primaryName === expectedName).length,
    };
  }, { expectedName: editedName, expectedSource: sourceBefore });
  requireCondition(
    copied.active
      && copied.active !== 'demo'
      && copied.rootHouseholdId === copied.active
      && copied.selectedHouseholdId === copied.active
      && copied.selectedHouseholdName === 'Demo Household copy'
      && copied.railName === 'Demo Household copy'
      && [
        'Saved as Demo Household copy \u00b7 open Scenarios',
        'Plan updated \u00b7 using available inputs',
      ].includes(copied.status)
      && copied.visibleName === editedName
      && copied.sourceUnchanged
      && copied.sourceVisibleName !== editedName
      && copied.recordName === 'Demo Household copy'
      && copied.runtimeSourceHouseholdId === 'demo'
      && copied.isDemo === false
      && copied.isSelectableDefault === false
      && copied.savedName === editedName
      && copied.customCount === 1,
    `Runtime edit was not saved as one durable copy: ${JSON.stringify(copied)}`,
  );

  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await waitForWizard(page, { householdId: 'demo' });
  const rebooted = await page.evaluate(({ customId, expectedName, expectedSource }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return {
      sourceUnchanged: JSON.stringify(db?.demo || null) === expectedSource,
      demoVisibleName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
      customOptionCount: [...document.querySelectorAll('#hh-switch option')]
        .filter(option => option.value === customId).length,
      savedName: db?.[customId]?.meta?.primaryName || '',
      runtimeSourceHouseholdId: db?.[customId]?.meta?.runtimeSourceHouseholdId || '',
    };
  }, {
    customId: copied.active,
    expectedName: editedName,
    expectedSource: sourceBefore,
  });
  requireCondition(
    rebooted.sourceUnchanged
      && rebooted.demoVisibleName !== editedName
      && rebooted.customOptionCount === 1
      && rebooted.savedName === editedName
      && rebooted.runtimeSourceHouseholdId === 'demo',
    `Runtime copy did not survive a clean reload: ${JSON.stringify(rebooted)}`,
  );

  await requireUnique(page, '.htab[data-page="scenarios"]', 'Scenarios tab');
  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(() =>
    document.querySelector('.page.on')?.dataset.page === 'scenarios'
      && document.querySelectorAll('#scn-view .scol__name').length > 0,
  { timeout: 10000 });
  const scenarioCountBefore = await countMatches(page, '#scn-view .scol__name');
  await requireUnique(page, '#scn-add', 'Add scenario action');
  await page.click('#scn-add');
  await page.waitForFunction(({ expectedCount, expectedSource }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const savedScenarios = JSON.parse(
      localStorage.getItem(`parallax.scenarios.${active}.v1`) || 'null',
    );
    return active
      && active !== 'demo'
      && db?.[active]?.meta?.runtimeSourceHouseholdId === 'demo'
      && JSON.stringify(db?.demo || null) === expectedSource
      && Array.isArray(savedScenarios)
      && savedScenarios.length === expectedCount + 1
      && [...document.querySelectorAll('#hh-switch option')]
        .filter(option => option.value === active).length === 1;
  }, { timeout: 10000 }, {
    expectedCount: scenarioCountBefore,
    expectedSource: sourceBefore,
  });
  const scenarioCopy = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const savedScenarios = JSON.parse(
      localStorage.getItem(`parallax.scenarios.${active}.v1`) || 'null',
    );
    return {
      active,
      householdBytes: JSON.stringify(db?.[active] || null),
      scenarioCount: savedScenarios?.length ?? null,
    };
  });
  requireCondition(
    scenarioCopy.active
      && scenarioCopy.householdBytes !== 'null'
      && scenarioCopy.scenarioCount === scenarioCountBefore + 1,
    `Scenario-only runtime copy was not durable: ${JSON.stringify(scenarioCopy)}`,
  );

  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await waitForWizard(page, { householdId: 'demo' });
  await selectHouseholdVisible(page, scenarioCopy.active);
  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(expectedCount =>
    document.querySelector('.page.on')?.dataset.page === 'scenarios'
      && document.querySelectorAll('#scn-view .scol__name').length === expectedCount,
  { timeout: 10000 }, scenarioCountBefore + 1);
  await page.click('.htab[data-page="household"]');
  await waitForWizard(page, { householdId: scenarioCopy.active });
  await selectHouseholdVisible(page, copied.active);
  await goToWizardStep(page, 'family');
  const restoredName = await page.$eval(
    '[data-wizard-field="primaryName"]',
    input => input.value,
  );
  requireCondition(
    restoredName === editedName,
    `Durable runtime copy reloaded with the wrong name: "${restoredName}"`,
  );
}

async function assertFourStepStructure(page){
  const structure = await page.evaluate(() => {
    const root = document.querySelector('[data-hh-wizard-root]');
    const nav = [...document.querySelectorAll('[data-hh-wizard-nav]')];
    const ids = nav.map(item => item.dataset.hhWizardNav);
    const panels = [...document.querySelectorAll('[data-hh-wizard-screen]')];
    const hookCounts = ids.map(id => ({
      id,
      nav: document.querySelectorAll(`[data-hh-wizard-nav="${id}"]`).length,
      panel: document.querySelectorAll(`[data-hh-wizard-screen="${id}"]`).length,
    }));
    const logo = document.querySelector('.brand-logo');
    return {
      ready: root?.dataset.wizardReady,
      busy: root?.getAttribute('aria-busy'),
      ids,
      labels: nav.map(item => item.querySelector('strong')?.textContent.trim() || ''),
      panels: panels.map(item => item.dataset.hhWizardScreen),
      hookCounts,
      logo: {
        src: logo?.getAttribute('src') || '',
        complete: logo?.complete === true,
        naturalWidth: logo?.naturalWidth || 0,
      },
      artifactId: new URL(location.href).searchParams.get('v') || '',
    };
  });
  requireCondition(
    JSON.stringify(structure.ids) === JSON.stringify(WIZARD_STEP_IDS),
    `Wizard steps drifted: ${JSON.stringify(structure.ids)}`,
  );
  requireCondition(
    JSON.stringify(structure.labels)
      === JSON.stringify(['Family', 'Net Worth', 'Tax', 'Summary']),
    `Wizard labels drifted: ${JSON.stringify(structure.labels)}`,
  );
  requireCondition(
    structure.hookCounts.every(item => item.nav === 1),
    `Wizard navigation hooks are not unique: ${JSON.stringify(structure.hookCounts)}`,
  );
  requireCondition(
    structure.panels.length === 1
      && WIZARD_STEP_IDS.includes(structure.panels[0]),
    `Wizard must render one semantic screen: ${JSON.stringify(structure.panels)}`,
  );
  requireCondition(
    /^[a-f0-9]{64}$/.test(structure.artifactId)
      && structure.logo.src === `assets/parallax-logo.png?v=${structure.artifactId}`
      && structure.logo.complete
      && structure.logo.naturalWidth > 0,
    `Canonical logo did not load: ${JSON.stringify(structure.logo)}`,
  );
}

async function verifyFamilyPropagation(page){
  await goToWizardStep(page, 'family');
  await setWizardValue(
    page,
    '[data-wizard-field="client.birthDate"]',
    '1960-01-01',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="filingStatus"]',
    'marriedFilingJointly',
  );
  const family = await page.evaluate(() => ({
    people: document.querySelectorAll('[data-person-owner]').length,
    spouse: document.querySelectorAll('[data-person-owner="spouse"]').length,
  }));
  requireCondition(
    family.people === 2 && family.spouse === 1,
    `MFJ did not render the co-client: ${JSON.stringify(family)}`,
  );
  await setWizardValue(
    page,
    '[data-wizard-field="spouse.birthDate"]',
    '1961-01-01',
  );
  for(const nextStatus of ['single', 'headOfHousehold']){
    await setWizardValue(
      page,
      '[data-wizard-field="filingStatus"]',
      nextStatus,
      { expectRevision: false },
    );
    const rejected = await page.evaluate(() => ({
      status: document.querySelector('[data-wizard-field="filingStatus"]')
        ?.value || '',
      code: document.querySelector('[data-hh-wizard-root]')
        ?.dataset.validationCode || '',
      people: document.querySelectorAll('[data-person-owner]').length,
    }));
    requireCondition(
      rejected.status === 'marriedFilingJointly'
        && rejected.code === 'CO_CLIENT_REMOVAL_REQUIRED'
        && rejected.people === 2,
      `Direct co-client filing transition did not fail closed: ${JSON.stringify(rejected)}`,
    );
  }

  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-account-type-id="roth_ira"]',
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="owner"]',
    'spouse',
    { expectRevision: false },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="value"]',
    '1000',
    { expectRevision: false, eventType: 'input' },
  );
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const spouseAccountId = await page.$eval(
    '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
    button => button.dataset.accountId,
  );
  await clickWizardAction(
    page,
    '[data-net-worth-overlay] .nw-panel-close',
  );
  await page.evaluate(() => {
    window.__coClientConfirmCalls = 0;
    window.confirm = () => {
      window.__coClientConfirmCalls += 1;
      return true;
    };
  });
  await goToWizardStep(page, 'family');
  await clickWizardAction(page, '[data-hh-action="remove-spouse"]', {
    expectRevision: false,
  });
  const accountBlocked = await page.evaluate(() => ({
    code: document.querySelector('[data-hh-wizard-root]')
      ?.dataset.validationCode || '',
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length,
  }));
  requireCondition(
    accountBlocked.code === 'CO_CLIENT_ACCOUNTS_REQUIRE_REASSIGNMENT'
      && accountBlocked.confirms === 0
      && accountBlocked.people === 2,
    `Co-client account guard did not precede confirmation: ${JSON.stringify(accountBlocked)}`,
  );

  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(
    page,
    `[data-hh-action="net-worth-remove-entry"][data-entry-source="account"][data-account-id="${spouseAccountId}"]`,
  );
  await clickWizardAction(
    page,
    '[data-net-worth-overlay] .nw-panel-close',
  );
  await goToWizardStep(page, 'family');
  await page.evaluate(() => {
    window.__coClientConfirmCalls = 0;
    window.confirm = () => {
      window.__coClientConfirmCalls += 1;
      return false;
    };
  });
  await clickWizardAction(page, '[data-hh-action="remove-spouse"]', {
    expectRevision: false,
  });
  const cancelled = await page.evaluate(() => ({
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length,
    status: document.querySelector('[data-wizard-field="filingStatus"]')
      ?.value || '',
  }));
  requireCondition(
    cancelled.confirms === 1
      && cancelled.people === 2
      && cancelled.status === 'marriedFilingJointly',
    `Cancelled co-client removal changed the household: ${JSON.stringify(cancelled)}`,
  );

  await page.evaluate(() => {
    window.__coClientConfirmCalls = 0;
    window.confirm = () => {
      window.__coClientConfirmCalls += 1;
      return true;
    };
  });
  await clickWizardAction(page, '[data-hh-action="remove-spouse"]');
  const removed = await page.evaluate(() => ({
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length,
    status: document.querySelector('[data-wizard-field="filingStatus"]')
      ?.value || '',
    removeAction: document.querySelectorAll(
      '[data-hh-action="remove-spouse"]',
    ).length,
  }));
  requireCondition(
    removed.confirms === 1
      && removed.people === 1
      && removed.status === 'single'
      && removed.removeAction === 0,
    `Confirmed co-client removal was not atomic: ${JSON.stringify(removed)}`,
  );
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    return saved?.meta?.filingStatus === 'single'
      && saved?.household?.spouse == null;
  }, { timeout: 10000 });
  await reloadWizard(page);
  await goToWizardStep(page, 'family');
  const persistedRemoval = await page.evaluate(() => ({
    people: document.querySelectorAll('[data-person-owner]').length,
    status: document.querySelector('[data-wizard-field="filingStatus"]')
      ?.value || '',
  }));
  requireCondition(
    persistedRemoval.people === 1 && persistedRemoval.status === 'single',
    `Co-client removal did not survive reload: ${JSON.stringify(persistedRemoval)}`,
  );
  await openNetWorthCategory(page, 'bank');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-account-type-id="checking"]',
  );
  const singleOwnerState = await page.evaluate(() => ({
    spouseOptions: document.querySelectorAll(
      '[data-net-worth-draft="owner"] option[value="spouse"]',
    ).length,
    owner: document.querySelector('[data-net-worth-draft="owner"]')?.value || '',
    saveDisabled: document.querySelector(
      '[data-hh-action="net-worth-save-entry"]',
    )?.disabled === true,
  }));
  requireCondition(
    singleOwnerState.spouseOptions === 0
      && singleOwnerState.owner === ''
      && singleOwnerState.saveDisabled,
    `Single-household account ownership is unsafe: ${JSON.stringify(singleOwnerState)}`,
  );
  await clickWizardAction(page, '[data-hh-action="net-worth-cancel-draft"]');
  await clickWizardAction(
    page,
    '[data-net-worth-overlay] .nw-panel-close',
  );
  await goToWizardStep(page, 'family');
  await setWizardValue(
    page,
    '[data-wizard-field="filingStatus"]',
    'headOfHousehold',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="filingStatus"]',
    'marriedFilingJointly',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="spouse.birthDate"]',
    '1961-01-01',
  );
  await setWizardValue(page, '[data-wizard-field="client.retirementAge"]', '68');
  await setWizardValue(page, '[data-wizard-field="spouse.retirementAge"]', '70');
  await setWizardValue(page, '[data-wizard-field="client.socialSecurityAge"]', '67');
  await setWizardValue(page, '[data-wizard-field="spouse.socialSecurityAge"]', '69');
  await setWizardValue(page, '[data-wizard-field="client.socialSecurityBenefit"]', '32000');
  await setWizardValue(page, '[data-wizard-field="spouse.socialSecurityBenefit"]', '22000');
  await setWizardValue(page, '[data-wizard-field="client.planEndAge"]', '94');
  await setWizardValue(page, '[data-wizard-field="spouse.planEndAge"]', '101');
  await goToWizardStep(page, 'tax');
  const filing = await page.evaluate(() =>
    document.querySelector('.hh-tax-static strong')?.textContent.trim() || '');
  requireCondition(
    filing === 'Married filing jointly',
    `Family filing status did not reach Tax: "${filing}"`,
  );
}

async function addNetWorthShellEntry(page, {
  categoryId,
  type,
  name,
  value,
  expectedValue,
  custom = false,
  openMore = false,
  tax = '',
}){
  await openNetWorthCategory(page, categoryId);
  if(openMore){
    await clickWizardAction(
      page,
      '[data-hh-action="net-worth-toggle-more"]',
    );
  }
  if(custom){
    await clickWizardAction(
      page,
      `[data-hh-action="net-worth-pick-custom"][data-category-id="${categoryId}"]`,
    );
    await setWizardValue(
      page,
      '[data-net-worth-draft="type"]',
      type,
      { expectRevision: false, eventType: 'input' },
    );
  }else{
    await clickWizardAction(
      page,
      `[data-hh-action="net-worth-pick-type"][data-category-id="${categoryId}"][data-type-label="${type}"]`,
    );
  }
  await setWizardValue(
    page,
    '[data-net-worth-draft="name"]',
    name,
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="owner"]',
    'client',
    { expectRevision: false },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="value"]',
    value,
    { expectRevision: false, eventType: 'input' },
  );
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const matches = await page.evaluate(expectedName =>
    [...document.querySelectorAll('.nw-saved-row')].flatMap(row => {
      const savedName = row.querySelector('.nw-saved-name')?.textContent.trim() || '';
      if(savedName !== expectedName) return [];
      const remove = row.querySelector(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="shell"]',
      );
      return [{
        id: remove?.dataset.shellId || '',
        name: savedName,
        meta: row.querySelector('.nw-saved-meta')?.textContent.trim() || '',
        value: row.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
      }];
    }), name);
  requireCondition(
    matches.length === 1
      && matches[0].id
      && matches[0].value === expectedValue
      && matches[0].meta.includes(type)
      && matches[0].meta.includes('Client')
      && matches[0].meta.includes('Net worth only')
      && matches[0].meta.includes('not projected')
      && (!tax || matches[0].meta.includes(tax)),
    `Net Worth shell entry did not save exact visible truth: ${JSON.stringify(matches)}`,
  );
  return matches[0].id;
}

async function verifyNetWorthFlow(page){
  await openNetWorthCategory(page, 'bank');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-account-type-id="checking"]',
  );
  const accountDraft = await page.evaluate(() => ({
    name: document.querySelectorAll('[data-net-worth-draft="name"]').length,
    owner: document.querySelectorAll('[data-net-worth-draft="owner"]').length,
    value: document.querySelectorAll('[data-net-worth-draft="value"]').length,
    saveDisabled: document.querySelector(
      '[data-hh-action="net-worth-save-entry"]',
    )?.disabled === true,
    ownerRequired: document.querySelector(
      '[data-hh-action="net-worth-save-entry"]',
    )?.dataset.netWorthOwnerRequired || '',
  }));
  requireCondition(
    accountDraft.name === 1
      && accountDraft.owner === 1
      && accountDraft.value === 1
      && accountDraft.saveDisabled
      && accountDraft.ownerRequired === 'true',
    `Net Worth canonical account draft is unsafe: ${JSON.stringify(accountDraft)}`,
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="name"]',
    'Verifier checking',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="owner"]',
    'client',
    { expectRevision: false },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="value"]',
    '250000.75',
    { expectRevision: false, eventType: 'input' },
  );
  const formattedAccount = await page.evaluate(() => ({
    value: document.querySelector('[data-net-worth-draft="value"]')?.value || '',
    saveDisabled: document.querySelector(
      '[data-hh-action="net-worth-save-entry"]',
    )?.disabled === true,
  }));
  requireCondition(
    formattedAccount.value === '$250,000.75' && !formattedAccount.saveDisabled,
    `Net Worth account draft did not become savable: ${JSON.stringify(formattedAccount)}`,
  );
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const account = await page.evaluate(() => {
    const remove = document.querySelector(
      '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
    );
    const row = remove?.closest('.nw-saved-row');
    return {
      id: remove?.dataset.accountId || '',
      count: document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
      ).length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    account.count === 1
      && account.id
      && account.name === 'Verifier checking'
      && account.meta.includes('Checking')
      && account.meta.includes('Client')
      && account.value === '$250,001',
    `Net Worth account did not save canonical truth: ${JSON.stringify(account)}`,
  );
  await page.waitForFunction(expectedId => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active]?.portfolio?.extraAccounts
      ?.find(item => item.id === expectedId);
    return saved?.balance === 250001;
  }, { timeout: 10000 }, account.id);
  await reloadWizard(page);
  await openNetWorthCategory(page, 'bank');
  const persistedAccountValue = await page.$eval(
    `[data-hh-action="net-worth-remove-entry"][data-entry-source="account"][data-account-id="${account.id}"]`,
    button => button.closest('.nw-saved-row')
      ?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
  );
  requireCondition(
    persistedAccountValue === '$250,001',
    `Canonical account value changed after reload: "${persistedAccountValue}"`,
  );

  await openNetWorthCategory(page, 'property');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-type-label="Second Home"]',
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="name"]',
    'Verifier lake house',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="owner"]',
    'joint',
    { expectRevision: false },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="value"]',
    '500000.25',
    { expectRevision: false, eventType: 'input' },
  );
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const property = await page.evaluate(() => {
    const remove = document.querySelector(
      '[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]',
    );
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]',
      ).length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    property.count === 1
      && property.name === 'Verifier lake house'
      && property.meta === 'Second Home \u00b7 Joint'
      && property.value === '$500,000',
    `Property display metadata did not save canonical truth: ${JSON.stringify(property)}`,
  );

  await openNetWorthCategory(page, 'mortgage');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-type-label="Second Home"]',
  );
  const autoLink = await page.evaluate(() => ({
    value: document.querySelector('[data-net-worth-draft="link"]')?.value || '',
    label: document.querySelector('[data-net-worth-draft="link"]')
      ?.selectedOptions?.[0]?.textContent.trim() || '',
    available: document.querySelector(
      '[data-hh-action="net-worth-save-entry"]',
    )?.dataset.netWorthResolvedLinkAvailable || '',
  }));
  requireCondition(
    autoLink.value === '0'
      && autoLink.label === 'Verifier lake house'
      && autoLink.available === 'true',
    `Saved property was not mortgage-linkable by name: ${JSON.stringify(autoLink)}`,
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="name"]',
    'Verifier lender',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="owner"]',
    'joint',
    { expectRevision: false },
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="value"]',
    '120000.75',
    { expectRevision: false, eventType: 'input' },
  );
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const mortgage = await page.evaluate(() => {
    const remove = document.querySelector(
      '[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]',
    );
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]',
      ).length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    mortgage.count === 1
      && mortgage.name === 'Verifier lender'
      && mortgage.meta === 'Second Home \u00b7 Joint \u00b7 Verifier lake house'
      && mortgage.value === '$120,001',
    `Mortgage did not preserve its exact metadata/link: ${JSON.stringify(mortgage)}`,
  );

  const shellSpecs = [
    { categoryId: 'investment', type: 'Trust', name: 'Verifier trust', value: '100000', expectedValue: '$100,000', openMore: true, tax: 'Taxable' },
    { categoryId: 'insurance', type: 'Whole Life', name: 'Verifier insurance', value: '50000', expectedValue: '$50,000' },
    { categoryId: 'card', type: 'Revolving', name: 'Verifier card', value: '5000', expectedValue: '$5,000' },
    { categoryId: 'loan', type: 'Auto', name: 'Verifier loan', value: '20000', expectedValue: '$20,000' },
    { categoryId: 'bank', type: 'Custom bank record', name: 'Verifier custom bank', value: '3000', expectedValue: '$3,000', custom: true, openMore: true },
  ];
  for(const spec of shellSpecs){
    spec.id = await addNetWorthShellEntry(page, spec);
  }

  await page.waitForFunction(expected => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const plan = db?.[active];
    const shell = plan?.netWorth?.shellEntries || [];
    const property = db?.[active]?.properties?.[0];
    return expected.every(item => shell.some(entry =>
      entry.id === item.id
      && entry.categoryId === item.categoryId
      && entry.name === item.name
      && entry.type === item.type
      && entry.owner === 'client'
      && entry.value === Number(item.value)
      && entry.projectionTreatment === 'net-worth-only'))
      && property?.name === 'Verifier lake house'
      && property?.value === 500000
      && property?.netWorthMeta?.type === 'Second Home'
      && property?.netWorthMeta?.owner === 'joint'
      && property?.mortgage?.balance === 120001
      && property?.mortgage?.netWorthMeta?.present === true
      && property?.mortgage?.netWorthMeta?.name === 'Verifier lender'
      && property?.mortgage?.netWorthMeta?.type === 'Second Home'
      && property?.mortgage?.netWorthMeta?.owner === 'joint';
  }, { timeout: 10000 }, shellSpecs);

  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  const entryTotals = await page.evaluate(() => {
    const readOne = selector => {
      const nodes = [...document.querySelectorAll(selector)];
      return { count: nodes.length, text: nodes[0]?.textContent.trim() || '' };
    };
    const category = id => readOne(
      `[data-hh-action="net-worth-open-category"][data-category-id="${id}"] .nw-tile-copy > span`,
    );
    return {
      railCount: document.querySelectorAll('.nw-rail').length,
      railTotal: readOne('.nw-rail > strong'),
      continueActions: document.querySelectorAll(
        '.nw-rail-actions [data-hh-action="step-next"]',
      ).length,
      backActions: document.querySelectorAll(
        '.nw-rail-actions [data-hh-action="step-back"]',
      ).length,
      categories: Object.fromEntries(
        ['bank', 'investment', 'property', 'insurance', 'card', 'mortgage', 'loan']
          .map(id => [id, category(id)]),
      ),
    };
  });
  requireCondition(
    entryTotals.railCount === 1
      && entryTotals.railTotal.count === 1
      && entryTotals.railTotal.text === '$758,000'
      && entryTotals.continueActions === 1
      && entryTotals.backActions === 1
      && JSON.stringify(entryTotals.categories) === JSON.stringify({
        bank: { count: 1, text: '$253,001' },
        investment: { count: 1, text: '$100,000' },
        property: { count: 1, text: '$500,000' },
        insurance: { count: 1, text: '$50,000' },
        card: { count: 1, text: '$5,000' },
        mortgage: { count: 1, text: '$120,001' },
        loan: { count: 1, text: '$20,000' },
      }),
    `Net Worth entry totals did not reconcile exactly: ${JSON.stringify(entryTotals)}`,
  );

  await reloadWizard(page);
  for(const spec of shellSpecs){
    await openNetWorthCategory(page, spec.categoryId);
    const persistedShell = await page.evaluate(expected =>
      [...document.querySelectorAll('.nw-saved-row')].flatMap(row => {
        const button = row.querySelector(
          '[data-hh-action="net-worth-remove-entry"][data-entry-source="shell"]',
        );
        if(button?.dataset.shellId !== expected.id) return [];
        return [{
          name: row.querySelector('.nw-saved-name')?.textContent.trim() || '',
          meta: row.querySelector('.nw-saved-meta')?.textContent.trim() || '',
          value: row.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
        }];
      }), spec);
    requireCondition(
      persistedShell.length === 1
        && persistedShell[0].name === spec.name
        && persistedShell[0].value === spec.expectedValue
        && persistedShell[0].meta.includes(spec.type)
        && persistedShell[0].meta.includes('Net worth only')
        && persistedShell[0].meta.includes('not projected'),
      `Net Worth shell record changed after reload: ${JSON.stringify({ spec, persistedShell })}`,
    );
  }

  await openNetWorthCategory(page, 'property');
  const persistedProperty = await page.evaluate(() => {
    const remove = document.querySelector(
      '[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]',
    );
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]',
      ).length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    persistedProperty.count === 1
      && persistedProperty.name === 'Verifier lake house'
      && persistedProperty.meta === 'Second Home \u00b7 Joint'
      && persistedProperty.value === '$500,000',
    `Property metadata changed after reload: ${JSON.stringify(persistedProperty)}`,
  );

  await openNetWorthCategory(page, 'mortgage');
  const persistedMortgage = await page.evaluate(() => {
    const remove = document.querySelector(
      '[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]',
    );
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]',
      ).length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    persistedMortgage.count === 1
      && persistedMortgage.name === 'Verifier lender'
      && persistedMortgage.meta === 'Second Home \u00b7 Joint \u00b7 Verifier lake house'
      && persistedMortgage.value === '$120,001',
    `Mortgage metadata changed after reload: ${JSON.stringify(persistedMortgage)}`,
  );

  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  const reloadedEntry = await page.evaluate(() => {
    const rail = document.querySelector('.nw-rail');
    return {
      railCount: document.querySelectorAll('.nw-rail').length,
      total: rail?.querySelector(':scope > strong')?.textContent.trim() || '',
      continueActions: rail?.querySelectorAll('[data-hh-action="step-next"]').length || 0,
      backActions: rail?.querySelectorAll('[data-hh-action="step-back"]').length || 0,
    };
  });
  requireCondition(
    reloadedEntry.railCount === 1
      && reloadedEntry.total === '$758,000'
      && reloadedEntry.continueActions === 1
      && reloadedEntry.backActions === 1,
    `Net Worth rail did not reconcile after reload: ${JSON.stringify(reloadedEntry)}`,
  );
}

async function verifyPlanningSourceAndTaxFlow(page){
  await goToWizardStep(page, 'tax');
  const initialWages = await page.evaluate(() => {
    const client = document.querySelector('[data-tax-field="income.wages.client"]');
    const spouse = document.querySelector('[data-tax-field="income.wages.spouse"]');
    return {
      client: client?.value || '',
      spouse: spouse?.value || '',
      clientDisabled: client?.disabled === true,
      spouseDisabled: spouse?.disabled === true,
      sourceButtons: document.querySelectorAll(
        '[data-income-group="wages"]',
      ).length,
    };
  });
  requireCondition(
    initialWages.client === '75,000'
      && initialWages.spouse === ''
      && !initialWages.clientDisabled
      && !initialWages.spouseDisabled
      && initialWages.sourceButtons === 0,
    `Member wage inputs were not independent: ${JSON.stringify(initialWages)}`,
  );

  const irmaaInputs = await page.evaluate(() => {
    const section = document.querySelector(
      '[data-tax-input-section="irmaa-lookback"]',
    );
    const rows = [...document.querySelectorAll('[data-irmaa-tax-year]')];
    return {
      sectionCount: document.querySelectorAll(
        '[data-tax-input-section="irmaa-lookback"]',
      ).length,
      years: rows.map(row => row.dataset.irmaaTaxYear),
      magiFields: rows.map(row => row.querySelector(
        '[data-tax-field$=".magi"]',
      )?.dataset.taxField || ''),
      filingFields: rows.filter(row => row.querySelector(
        '[data-tax-field$=".filingStatus"]',
      )).length,
      filingFieldNames: rows.map(row => row.querySelector(
        '[data-tax-field$=".filingStatus"]',
      )?.dataset.taxField || ''),
      viewToggleCount: document.querySelectorAll('[data-hh-action="set-tax-view"]').length,
      view: document.querySelector('[data-hh-wizard-screen="tax"]')?.dataset.taxView || '',
      summaryBoxes: document.querySelectorAll(
        '[data-hh-wizard-screen="tax"] [data-tax-summary-box]',
      ).length,
      frameGeometry: [
        ...document.querySelectorAll('.hh-tax-profile > *, .hh-irmaa-lookback-row'),
      ].map(element => {
        const style = getComputedStyle(element);
        return {
          left: style.borderLeftWidth,
          right: style.borderRightWidth,
          radius: style.borderRadius,
        };
      }),
      controlWidths: [
        document.querySelector('[data-tax-field="taxYear"]'),
        document.querySelector('[data-tax-field="deductionMode"]'),
        ...rows.map(row => row.querySelector('[data-tax-field$=".magi"]')),
      ].map(element => Math.round(element?.getBoundingClientRect().width || 0)),
      outputCopy: /Current tier|Next tier|To next tier|Premium year/i.test(
        section?.textContent || '',
      ),
    };
  });
  requireCondition(
    irmaaInputs.sectionCount === 1
      && JSON.stringify(irmaaInputs.years) === JSON.stringify(['2024', '2025'])
      && JSON.stringify(irmaaInputs.magiFields) === JSON.stringify([
        'irmaa.lookback.2024.magi',
        'irmaa.lookback.2025.magi',
      ])
      && irmaaInputs.filingFields === 0
      && JSON.stringify(irmaaInputs.filingFieldNames) === JSON.stringify(['', ''])
      && irmaaInputs.viewToggleCount === 0
      && irmaaInputs.view === 'detailed'
      && irmaaInputs.summaryBoxes === 5
      && irmaaInputs.frameGeometry.every(frame => frame.left === '0px'
        && frame.right === '0px'
        && frame.radius === '0px')
      && irmaaInputs.controlWidths.length === 4
      && irmaaInputs.controlWidths[0] >= 60 && irmaaInputs.controlWidths[0] <= 140
      && irmaaInputs.controlWidths[1] >= 140 && irmaaInputs.controlWidths[1] <= 240
      && irmaaInputs.controlWidths.slice(2).every(width => width >= 40 && width <= 140)
      && Math.abs(irmaaInputs.controlWidths[2] - irmaaInputs.controlWidths[3]) <= 1
      && !irmaaInputs.outputCopy,
    `Tax IRMAA lookback is not input-only: ${JSON.stringify(irmaaInputs)}`,
  );
  await setWizardValue(
    page,
    '[data-tax-field="irmaa.lookback.2024.magi"]',
    '218000',
  );
  const persistedIrmaaInput = await page.$eval(
    '[data-tax-field="irmaa.lookback.2024.magi"]',
    control => control.value,
  );
  requireCondition(
    persistedIrmaaInput === '218,000',
    `IRMAA lookback MAGI did not survive the production edit path: "${persistedIrmaaInput}"`,
  );
  await reloadWizard(page);
  await goToWizardStep(page, 'tax');
  const reloadedIrmaaInput = await page.$eval(
    '[data-tax-field="irmaa.lookback.2024.magi"]',
    control => control.value,
  );
  requireCondition(
    reloadedIrmaaInput === '218,000',
    `IRMAA lookback MAGI did not survive reload: "${reloadedIrmaaInput}"`,
  );

  await goToWizardStep(page, 'summary');
  const derivedSummary = await page.evaluate(() => {
    const table = document.querySelector('table[data-summary-irmaa]');
    const rect = table?.getBoundingClientRect();
    const headers = [...(table?.querySelectorAll('thead th') || [])]
      .map(cell => cell.textContent.trim());
    const rows = [...(table?.querySelectorAll('tbody tr') || [])]
      .map(row => [...row.querySelectorAll('td')]
        .map(cell => cell.textContent.trim()));
    return {
      removedMetricCount: document.querySelectorAll(
        '[data-summary-metric="income"], [data-summary-metric="federal-tax"]',
      ).length,
      tableCount: document.querySelectorAll('table[data-summary-irmaa]').length,
      headers,
      rows,
      width: rect?.width || 0,
      directScreenChild: table?.parentElement
        ?.matches('[data-hh-wizard-screen="summary"]') === true,
      captionCount: table?.querySelectorAll('caption').length || 0,
    };
  });
  requireCondition(
    derivedSummary.removedMetricCount === 0,
    `Summary restored removed income or federal-tax headlines: ${JSON.stringify(derivedSummary)}`,
  );
  requireCondition(
    derivedSummary.tableCount === 1
      && JSON.stringify(derivedSummary.headers) === JSON.stringify(['Item', 'Value'])
      && JSON.stringify(derivedSummary.rows.map(row => row[0])) === JSON.stringify([
        'MAGI',
        'Current tier',
        'To next tier',
        'Premium year',
      ])
      && /^\$[\d,]+$/.test(derivedSummary.rows[0]?.[1] || '')
      && /^\d+$/.test(derivedSummary.rows[1]?.[1] || '')
      && /^(\$[\d,]+|—)$/.test(derivedSummary.rows[2]?.[1] || '')
      && derivedSummary.rows[3]?.[1] === '2028'
      && derivedSummary.width >= 480
      && derivedSummary.width <= 560
      && derivedSummary.directScreenChild
      && derivedSummary.captionCount === 1,
    `Summary IRMAA table drifted from the compact Item/Value contract: ${JSON.stringify(derivedSummary)}`,
  );
  const summaryContinueSelector = '#hh-wiz-footer [data-hh-action="step-next"]';

  await goToWizardStep(page, 'tax');
  const continueSelector = '#hh-wiz-footer [data-hh-action="step-next"]';
  const beforeContinue = await wizardState(page);
  await page.click(continueSelector);
  await waitForWizard(page, {
    step: 'summary',
    afterRevision: beforeContinue.revision,
  });

  const taxUi = await page.evaluate(() => ({
    confirmationCount: document.querySelectorAll('[data-tax-confirmation]').length,
    readiness: document.querySelector('[data-tax-readiness]')
      ?.dataset.taxReadiness || '',
  }));
  requireCondition(
    taxUi.confirmationCount === 0,
    `Tax confirmation checkbox should be removed: ${JSON.stringify(taxUi)}`,
  );

  await goToWizardStep(page, 'tax');
  await setWizardValue(page, '[data-tax-field="income.wages.client"]', '81000');
  await setWizardValue(page, '[data-tax-field="income.wages.spouse"]', '39000');

  const unifiedTax = await page.evaluate(() => ({
    view: document.querySelector('[data-hh-wizard-screen="tax"]')
      ?.dataset.taxView || '',
    clientWages: document.querySelector('[data-tax-field="income.wages.client"]')?.value || '',
    spouseWages: document.querySelector('[data-tax-field="income.wages.spouse"]')?.value || '',
    toggleCount: document.querySelectorAll('[data-hh-action="set-tax-view"]').length,
    socialSecuritySource: document.querySelectorAll('[data-tax-field="socialSecurity.mode"]').length,
  }));
  requireCondition(
    unifiedTax.view === 'detailed'
      && unifiedTax.clientWages === '81,000'
      && unifiedTax.spouseWages === '39,000'
      && unifiedTax.toggleCount === 0
      && unifiedTax.socialSecuritySource === 1,
    `Unified Tax view lost state: ${JSON.stringify(unifiedTax)}`,
  );

  await setWizardValue(
    page,
    '[data-tax-field="deductionMode"]',
    'itemized-details',
  );
  const itemizedCopy = await page.evaluate(() =>
    document.querySelector('.hh-itemized-section')?.textContent
      .replace(/\s+/g, ' ').trim() || '');
  requireCondition(
    /raw eligible amount before the 7\.5% AGI floor/i.test(itemizedCopy)
      && /raw eligible amount before the federal SALT limit/i.test(itemizedCopy)
      && /deductible amount after any category-specific limits/i.test(itemizedCopy),
    `Itemized input semantics are unclear: "${itemizedCopy}"`,
  );
  await setWizardValue(
    page,
    '[data-tax-field="deductionMode"]',
    'standard',
  );

  const readiness = await page.evaluate(() => ({
    readiness: document.querySelector('[data-tax-readiness]')
      ?.dataset.taxReadiness || '',
    confirmationCount: document.querySelectorAll('[data-tax-confirmation]').length,
  }));
  requireCondition(
    readiness.readiness === 'ready' && readiness.confirmationCount === 0,
    `Tax readiness did not derive an estimate: ${JSON.stringify(readiness)}`,
  );

  await goToWizardStep(page, 'summary');
  const afterSummary = await page.evaluate(() => ({
    removedMetricCount: document.querySelectorAll(
      '[data-summary-metric="income"], [data-summary-metric="federal-tax"]',
    ).length,
  }));
  requireCondition(
    afterSummary.removedMetricCount === 0,
    `Summary restored removed income or federal-tax headlines: ${JSON.stringify(afterSummary)}`,
  );
  await requireUnique(
    page,
    summaryContinueSelector,
    'completed Summary Continue to Scenarios action',
  );
  await page.click(summaryContinueSelector);
  await page.waitForFunction(
    () => document.querySelector('.page.on')?.dataset.page === 'scenarios',
    { timeout: 8000 },
  );
  const planningPage = await page.evaluate(() =>
    document.querySelector('.page.on')?.dataset.page || '');
  requireCondition(
    planningPage === 'scenarios',
    `Completed Summary did not enter Scenarios: "${planningPage}"`,
  );
}

async function waitForAutoSave(page){
  const saveCount = await page.$$eval('#save-btn', elements => elements.length);
  requireCondition(saveCount === 0, 'Manual Save control still rendered');
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    const rows = (saved?.income?.other || [])
      .filter(row => row?.typeId === 'wages' || row?.typeId === 'bonus')
      .map(row => ({ owner: row.owner, amount: row.amount }));
    return JSON.stringify(rows) === JSON.stringify([
      { owner: 'client', amount: 81000 },
      { owner: 'spouse', amount: 39000 },
    ]);
  }, { timeout: 10000 });
}

async function verifyAutoSaveReloadAndMemberWages(page){
  await waitForAutoSave(page);
  await reloadWizard(page);
  await goToWizardStep(page, 'tax');
  const savedWages = await page.evaluate(() => {
    const client = document.querySelector('[data-tax-field="income.wages.client"]');
    const spouse = document.querySelector('[data-tax-field="income.wages.spouse"]');
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    const rows = (saved?.income?.other || [])
      .filter(row => row?.typeId === 'wages' || row?.typeId === 'bonus')
      .map(row => ({ owner: row.owner, amount: row.amount }));
    return {
      client: client?.value || '',
      spouse: spouse?.value || '',
      clientDisabled: client?.disabled === true,
      spouseDisabled: spouse?.disabled === true,
      sourceButtons: document.querySelectorAll('[data-income-group="wages"]').length,
      rows,
      peopleFacts: {
        client: {
          retirementAge: saved?.household?.primary?.retirementAge,
          socialSecurityAge: saved?.income?.socialSecurity?.primary?.claimAge,
          socialSecurityBenefit: saved?.income?.socialSecurity?.primary?.pia,
          planEndAge: saved?.household?.primary?.planEndAge,
        },
        spouse: {
          retirementAge: saved?.household?.spouse?.retirementAge,
          socialSecurityAge: saved?.income?.socialSecurity?.spouse?.claimAge,
          socialSecurityBenefit: saved?.income?.socialSecurity?.spouse?.pia,
          planEndAge: saved?.household?.spouse?.planEndAge,
        },
      },
      storedAggregate: Object.prototype.hasOwnProperty.call(
        saved?.incomeTax?.current1040?.income || {},
        'wages',
      ),
    };
  });
  requireCondition(
    savedWages.client === '81,000'
      && savedWages.spouse === '39,000'
      && !savedWages.clientDisabled
      && !savedWages.spouseDisabled
      && savedWages.sourceButtons === 0,
    `Auto-save/reload lost member wages: ${JSON.stringify(savedWages)}`,
  );
  requireCondition(
    JSON.stringify(savedWages.rows) === JSON.stringify([
      { owner: 'client', amount: 81000 },
      { owner: 'spouse', amount: 39000 },
    ])
      && JSON.stringify(savedWages.peopleFacts) === JSON.stringify({
        client: {
          retirementAge: 68,
          socialSecurityAge: 67,
          socialSecurityBenefit: 32000,
          planEndAge: 94,
        },
        spouse: {
          retirementAge: 70,
          socialSecurityAge: 69,
          socialSecurityBenefit: 22000,
          planEndAge: 101,
        },
      })
      && savedWages.storedAggregate === false,
    `Auto-saved wages did not use the member-owned contract: ${JSON.stringify(savedWages)}`,
  );
}

async function verifyDuplicateRepair(page){
  await page.evaluate(() => {
    const dbKey = 'parallax.households.v1';
    const activeKey = 'parallax.activeHouseholdId';
    const db = JSON.parse(localStorage.getItem(dbKey) || 'null');
    const active = localStorage.getItem(activeKey);
    const plan = db?.[active];
    if(!plan) throw new Error('Active household is unavailable for repair fixture');
    const wage = {
      typeId: 'wages',
      owner: 'client',
      label: 'Wages or salary',
      amount: 90000,
      startAge: plan.household.primary.currentAge,
      endAge: plan.household.primary.retirementAge - 1,
      realGrowth: 0,
      taxablePct: 1,
    };
    delete plan.meta.householdRecordSchemaVersion;
    delete plan.meta.legacyRepairArchive;
    plan.income.other = [
      structuredClone(wage),
      structuredClone(wage),
    ];
    localStorage.setItem(dbKey, JSON.stringify(db));
  });
  await reloadWizard(page);
  const repaired = await page.evaluate(() => {
    const dbKey = 'parallax.households.v1';
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const raw = localStorage.getItem(dbKey);
    const plan = JSON.parse(raw || 'null')?.[active];
    return {
      raw,
      rows: plan?.income?.other || [],
      archive: plan?.meta?.legacyRepairArchive || [],
      version: plan?.meta?.householdRecordSchemaVersion,
    };
  });
  requireCondition(
    repaired.rows.length === 1
      && typeof repaired.rows[0]?.id === 'string'
      && repaired.archive.length === 1
      && repaired.archive[0]?.code === 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED'
      && repaired.version === 2,
    `Legacy duplicate repair was not narrow/recoverable: ${JSON.stringify(repaired)}`,
  );
  await reloadWizard(page);
  const secondRaw = await page.evaluate(() =>
    localStorage.getItem('parallax.households.v1'));
  requireCondition(
    secondRaw === repaired.raw,
    'Legacy duplicate repair was not byte-stable on the second reload',
  );
}

async function assertViewport(page, viewport, step, outDir, filename){
  await goToWizardStep(page, step);
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
  });
  await settleWizardCapture(page);
  const metrics = await page.evaluate(() => {
    const root = document.querySelector('[data-hh-wizard-root]');
    const screen = document.querySelector('[data-hh-wizard-screen]');
    const sidebar = document.querySelector('.hh-sidebar');
    const footer = document.querySelector('[data-hh-wizard-footer]');
    const netWorthNavigation = [...document.querySelectorAll(
      '.nw-rail-actions',
    )];
    const nav = document.querySelector(
      '[data-hh-wizard-nav][aria-current="step"]',
    );
    const header = document.querySelector('.app-header');
    const headerParts = [
      header,
      header?.querySelector('.hdr__logo'),
      header?.querySelector('.hdr__tabs'),
      header?.querySelector('.hdr__right'),
    ].filter(Boolean);
    const rect = root?.getBoundingClientRect();
    const screenRect = screen?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    const headerContentBottom = Math.max(
      0,
      ...headerParts.map(element => element.getBoundingClientRect().bottom),
    );
    const rendered = (element, elementRect) => {
      if(!element || !elementRect) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && elementRect.width > 0
        && elementRect.height > 0;
    };
    return {
      documentOverflow: document.documentElement.scrollWidth
        - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      rootLeft: rect?.left ?? null,
      rootRight: rect?.right ?? null,
      rootTop: rect?.top ?? null,
      headerContentBottom,
      viewportWidth: document.documentElement.clientWidth,
      sidebarVisible: rendered(sidebar, sidebarRect),
      footerVisible: rendered(footer, footerRect),
      netWorthNavigationVisible: netWorthNavigation.some(element =>
        rendered(element, element.getBoundingClientRect())),
      screenVisible: rendered(screen, screenRect),
      step: root?.dataset.wizardStep || '',
      screen: screen?.dataset.hhWizardScreen || '',
      nav: nav?.dataset.hhWizardNav || '',
    };
  });
  requireCondition(
    metrics.documentOverflow <= 1
      && metrics.bodyOverflow <= 1
      && metrics.rootLeft >= -1
      && metrics.rootRight <= metrics.viewportWidth + 1
      && metrics.rootTop >= metrics.headerContentBottom - 1
      && metrics.sidebarVisible
      && (step === 'net-worth'
        ? metrics.netWorthNavigationVisible
        : metrics.footerVisible)
      && metrics.screenVisible
      && metrics.step === step
      && metrics.screen === step
      && metrics.nav === step,
    `Wizard ${step} fails ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`,
  );
  if(outDir){
    await page.screenshot({
      path: join(outDir, filename),
      fullPage: true,
    });
  }
}

export async function captureWizardScreens(
  page,
  {
    outDir,
    prefix = 'wizard',
  },
){
  requireCondition(outDir, 'captureWizardScreens requires outDir');
  mkdirSync(outDir, { recursive: true });
  await openWizard(page);
  const artifacts = [];
  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
  });
  for(const step of WIZARD_STEP_IDS){
    await goToWizardStep(page, step);
    await settleWizardCapture(page);
    const path = join(outDir, `${prefix}-${step}.png`);
    await captureFullWizardArtifact(page, path);
    artifacts.push({
      label: `${step} · desktop`,
      path,
      step,
      viewport: 'desktop',
    });
    if(step === 'net-worth'){
      await openNetWorthCategory(page, 'bank');
      await settleWizardCapture(page);
      const panelPath = join(outDir, `${prefix}-${step}-bank-panel.png`);
      await captureFullWizardArtifact(page, panelPath);
      artifacts.push({
        label: 'net worth bank panel',
        path: panelPath,
        step,
        viewport: 'desktop',
      });
      await clickWizardAction(
        page,
        '[data-net-worth-overlay] .nw-panel-close',
      );
    }
  }
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
  });
  for(const step of WIZARD_STEP_IDS){
    await goToWizardStep(page, step);
    await settleWizardCapture(page);
    const path = join(outDir, `${prefix}-${step}-mobile.png`);
    await captureFullWizardArtifact(page, path);
    artifacts.push({
      label: `${step} · mobile`,
      path,
      step,
      viewport: 'mobile',
    });
  }
  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
  });
  return artifacts;
}

export async function runWizardBrowserContract(
  page,
  {
    outDir = null,
    restoreStorageAfter = true,
  } = {},
){
  if(outDir) mkdirSync(outDir, { recursive: true });
  const diagnostics = attachBrowserDiagnostics(page);
  let originalStorage = null;
  const originalViewport = page.viewport();
  let failure = null;
  try{
    await openWizard(page);
    originalStorage = await snapshotStorage(page);
    await verifyRuntimeTemplateDurableCopy(page);
    await prepareContractFixture(page);
    await assertFourStepStructure(page);
    await verifyFamilyPropagation(page);
    await verifyNetWorthFlow(page);
    await verifyPlanningSourceAndTaxFlow(page);
    await verifyAutoSaveReloadAndMemberWages(page);
    await verifyDuplicateRepair(page);

    const viewports = [
      { label: 'desktop', width: 1440, height: 900 },
      { label: 'narrow', width: 1180, height: 850 },
      { label: 'mobile', width: 390, height: 844 },
    ];
    for(const viewport of viewports){
      for(const step of WIZARD_STEP_IDS){
        await assertViewport(
          page,
          viewport,
          step,
          outDir,
          `wizard-${step}-${viewport.label}.png`,
        );
      }
    }
  }catch(error){
    failure = error;
  } finally {
    try{
      if(restoreStorageAfter && originalStorage){
        await restoreStorage(page, originalStorage);
        if(originalViewport) await page.setViewport(originalViewport);
        await reloadWizard(page);
        const restoredStorage = await snapshotStorage(page);
        requireCondition(
          stableStorageSnapshot(restoredStorage)
            === stableStorageSnapshot(originalStorage),
          'Wizard contract did not restore the original localStorage snapshot',
        );
      }
      diagnostics.assertClean();
    }catch(error){
      failure = failure
        ? new AggregateError(
            [failure, error],
            'Wizard contract and restoration diagnostics both failed',
          )
        : error;
    }
    diagnostics.dispose();
  }
  if(failure) throw failure;
}

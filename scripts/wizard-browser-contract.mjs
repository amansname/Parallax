import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETURN_DATA } from '../engine.js';
import {
  ASSET_KEYS,
  ASSET_META,
  snapshotPresetAllocation,
} from '../src/household/investmentAllocation.js';

export const WIZARD_STEP_IDS = Object.freeze([
  'family',
  'net-worth',
  'tax',
  'summary',
]);

const ROOT_SELECTOR = '[data-hh-wizard-root]';
const SCREEN_SELECTOR = '[data-hh-wizard-screen]';
const APP_ORIGIN_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//;
const STALE_COPY_MIGRATION_RECORDS = Object.freeze([
  { id: 'hh_browser_stale_new', label: 'New Household' },
  { id: 'hh_browser_stale_demo', label: 'Demo Household copy' },
  { id: 'hh_browser_stale_couple', label: 'Pre-Retirement Couple copy' },
]);
const MIGRATION_SURVIVOR = Object.freeze({
  id: 'hh_browser_migration_survivor',
  label: 'Advisor Migration Survivor',
});

function requireCondition(condition, message){
  if(!condition) throw new Error(message);
}

function independentlyResolve1973PresetReturn(presetId){
  const source = RETURN_DATA.find(row => row.y === 1973);
  requireCondition(source, '1973 return row is unavailable');
  const requested = snapshotPresetAllocation(presetId).weights;
  const sleeves = [
    ASSET_KEYS.filter(key => ASSET_META[key].bucket === 'growth'),
    ASSET_KEYS.filter(key => ASSET_META[key].bucket !== 'growth'),
  ];
  let rate = 0;
  for(const keys of sleeves){
    const targetWeight = keys.reduce((sum, key) => sum + requested[key], 0);
    const available = keys.filter(key => source[key] !== null && source[key] !== undefined);
    const availableWeight = available.reduce((sum, key) => sum + requested[key], 0);
    requireCondition(
      targetWeight === 0 || availableWeight > 0,
      `${presetId} has no independently available 1973 sleeve`,
    );
    if(targetWeight === 0) continue;
    for(const key of available){
      rate += targetWeight * (requested[key] / availableWeight) * source[key];
    }
  }
  return { rate, cashRate: source.cash };
}

function visibleReturnText(rate){
  const sign = rate < 0 ? '−' : '+';
  return `${sign}${(Math.abs(rate) * 100).toFixed(1)}%`;
}

function exactStorageSnapshot(snapshot){
  return JSON.stringify(Object.fromEntries(
    Object.entries(snapshot || {}).sort(([left], [right]) => left.localeCompare(right)),
  ));
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

export async function waitForUnselectedWizard(page, { timeout = 15000 } = {}){
  try{
    await page.waitForFunction(rootSelector => {
      const root = document.querySelector(rootSelector);
      const view = document.querySelector('#hh-view');
      const footer = document.querySelector('#hh-wiz-footer');
      const selector = document.querySelector('#hh-switch');
      const menu = document.querySelector('#hh-menu-pop');
      return root?.dataset.wizardReady === 'true'
        && root.getAttribute('aria-busy') === 'false'
        && root.dataset.householdId === ''
        && root.dataset.wizardStep === ''
        && selector?.value === ''
        && menu?.hidden === false
        && document.querySelector('.hh-progress')?.hidden === true
        && document.querySelector('.hh-stepper')?.hidden === true
        && footer?.hidden === true
        && !view?.querySelector('[data-hh-wizard-screen]')
        && !(footer?.textContent || '').trim();
    }, { timeout }, ROOT_SELECTOR);
  }catch(error){
    const observed = await page.evaluate(() => ({
      root: document.querySelector('[data-hh-wizard-root]')?.dataset || null,
      busy: document.querySelector('[data-hh-wizard-root]')?.getAttribute('aria-busy'),
      selected: document.querySelector('#hh-switch')?.value,
      menuHidden: document.querySelector('#hh-menu-pop')?.hidden,
      progressHidden: document.querySelector('.hh-progress')?.hidden,
      stepperHidden: document.querySelector('.hh-stepper')?.hidden,
      footerHidden: document.querySelector('#hh-wiz-footer')?.hidden,
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
    })).catch(stateError => ({ stateReadError: stateError.message }));
    throw new Error(
      `Unselected wizard readiness timeout; observed ${JSON.stringify(observed)}. ${error.message}`,
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
    if(!before.householdId) return waitForUnselectedWizard(page);
    return waitForWizard(page, { afterRevision: before.revision });
  }
  if(!before.householdId) return waitForUnselectedWizard(page);
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

async function selectNetWorthAllocation(page, presetId){
  const selector = `[data-allocation-option-id="${presetId}"]`;
  await requireUnique(page, selector, `asset allocation ${presetId}`);
  const before = await wizardState(page);
  await page.click(selector);
  const selected = await page.$eval(
    `${selector} input[data-net-worth-draft="allocationPresetId"]`,
    input => input.checked,
  );
  const after = await wizardState(page);
  requireCondition(
    selected
      && after.revision === before.revision
      && after.step === before.step,
    `Asset allocation ${presetId} did not remain an in-form selection`,
  );
}

async function historicalCashFlowSnapshot(page, {
  pathId = 'historical-1973',
  previousEndingBalance = null,
} = {}){
  const netWorthOverlay = await page.$('[data-net-worth-overlay]');
  if(netWorthOverlay){
    await clickWizardAction(
      page,
      '[data-net-worth-overlay] .nw-panel-close',
    );
  }
  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(() => (
    document.querySelector('.page.on')?.dataset.page === 'scenarios'
      && (document.querySelectorAll('#scn-view .scol__name').length > 0
        || Boolean(document.querySelector('#scn-view .cf')))
      && document.querySelector('#run-btn')?.disabled === false
      && /Plan updated|Partial run/i.test(
        document.querySelector('#status')?.textContent || '',
      )
  ), { timeout: 15000 });
  const cashActive = await page.$eval(
    '#scn-cash-toggle',
    button => button.getAttribute('aria-checked') === 'true',
  );
  if(!cashActive) await page.click('#scn-cash-toggle');
  await page.waitForFunction(() => Boolean(
    document.querySelector('#scn-view .cf')
      && document.querySelector('#cashflow-path-mode'),
  ), { timeout: 15000 });
  await page.select('#cashflow-path-mode', pathId);
  await page.waitForFunction(({ expectedPathId, priorEnding }) => {
    const cashFlow = document.querySelector(
      `#scn-view .cf[data-cash-path-id="${expectedPathId}"]`,
    );
    const row = cashFlow?.querySelector('.cf-row[data-source-year="1973"]');
    if(!row) return false;
    return priorEnding == null || row.dataset.endingBalance !== priorEnding;
  }, { timeout: 15000 }, {
    expectedPathId: pathId,
    priorEnding: previousEndingBalance,
  });
  return page.evaluate(expectedPathId => {
    const cashFlow = document.querySelector(
      `#scn-view .cf[data-cash-path-id="${expectedPathId}"]`,
    );
    const row = cashFlow?.querySelector('.cf-row[data-source-year="1973"]');
    return {
      pathId: cashFlow?.dataset.cashPathId || '',
      kind: cashFlow?.dataset.cashPathKind || '',
      sourceYear: row?.dataset.sourceYear || '',
      startBalance: row?.dataset.startBalance || '',
      endingBalance: row?.dataset.endingBalance || '',
      returnText: row?.querySelector('.cf-cell--ret')?.textContent.trim() || '',
    };
  }, pathId);
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

async function seedStaleCopyMigrationFixture(page){
  return page.evaluate(({ staleRecords, survivor }) => {
    const databaseKey = 'parallax.households.v1';
    const database = JSON.parse(localStorage.getItem(databaseKey) || 'null');
    const source = database?.['now-household'];
    if(!source) throw new Error('Now Household is unavailable for stale-copy migration setup');
    const createCustomRecord = ({ id, label }) => {
      const record = JSON.parse(JSON.stringify(source));
      record.meta.householdId = id;
      record.meta.name = label;
      record.meta.primaryName = `${label} Client`;
      record.meta.isSelectableDefault = false;
      record.meta.isDemo = false;
      delete record.meta.runtimeSourceHouseholdId;
      return record;
    };
    database[survivor.id] = createCustomRecord(survivor);
    for(const staleRecord of staleRecords){
      database[staleRecord.id] = createCustomRecord(staleRecord);
    }
    const staleRecordBytes = Object.fromEntries(staleRecords.map(({ id }) => [
      id,
      JSON.stringify(database[id]),
    ]));
    localStorage.setItem(databaseKey, JSON.stringify(database));
    localStorage.setItem('parallax.activeHouseholdId', staleRecords[0].id);
    return staleRecordBytes;
  }, {
    staleRecords: STALE_COPY_MIGRATION_RECORDS,
    survivor: MIGRATION_SURVIVOR,
  });
}

function stableStorageSnapshot(snapshot){
  const runtimeRecordIds = new Set([
    'demo',
    'default-pre-retirement-solo',
    'default-pre-retirement-couple',
    'now-household',
    'future-household',
  ]);
  const runtimeScenarioIds = new Set(['now-household', 'future-household']);
  const ownerStorage = Object.fromEntries(Object.entries(snapshot || {}).flatMap(([key, value]) => {
    if(key === 'parallax.activeHouseholdId') return [];
    if(key.startsWith('parallax.scenarios.')){
      const householdId = key.slice('parallax.scenarios.'.length, -'.v1'.length);
      if(runtimeScenarioIds.has(householdId)) return [];
    }
    if(key !== 'parallax.households.v1') return [[key, value]];
    const database = JSON.parse(value || 'null');
    const savedHouseholds = Object.fromEntries(
      Object.entries(database || {}).filter(([householdId]) => !runtimeRecordIds.has(householdId)),
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
  await waitForUnselectedWizard(page);
  if(priorHouseholdId){
    const available = await page.$$eval(
      '#hh-switch option',
      (options, householdId) => options.some(option => option.value === householdId),
      priorHouseholdId,
    );
    if(available){
      return selectHouseholdVisible(page, priorHouseholdId);
    }
  }
  return waitForUnselectedWizard(page);
}

export async function selectHouseholdVisible(page, householdId){
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

async function verifyBlankStartupAndNowSelection(page, expectedNameOnlyBytes){
  await openWizard(page);
  const startup = await page.evaluate(staleRecordIds => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const options = [...document.querySelectorAll('#hh-switch option')].map(option => ({
      value: option.value,
      label: option.textContent.trim(),
      disabled: option.disabled,
    }));
    const customIds = Object.keys(db || {}).filter(id => ![
      'now-household',
      'future-household',
      'demo',
      'default-pre-retirement-solo',
      'default-pre-retirement-couple',
    ].includes(id));
    return {
      active: localStorage.getItem('parallax.activeHouseholdId'),
      dbIds: Object.keys(db || {}),
      options,
      customIds,
      staleRecordBytes: Object.fromEntries(staleRecordIds.map(id => [
        id,
        JSON.stringify(db?.[id] ?? null),
      ])),
      selected: document.querySelector('#hh-switch')?.value || '',
      railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
      menuHidden: document.querySelector('#hh-menu-pop')?.hidden,
      menuButtonHidden: document.querySelector('#hh-menu-btn')?.hidden,
      progressHidden: document.querySelector('.hh-progress')?.hidden,
      stepperHidden: document.querySelector('.hh-stepper')?.hidden,
      footerHidden: document.querySelector('#hh-wiz-footer')?.hidden,
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
      enabledFields: document.querySelectorAll(
        '#hh-view input:not(:disabled), #hh-view select:not(:disabled), #hh-view textarea:not(:disabled)',
      ).length,
      nowScenarioBytes: localStorage.getItem('parallax.scenarios.now-household.v1'),
      futureScenarioBytes: localStorage.getItem('parallax.scenarios.future-household.v1'),
      plannerHouseholdId: document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId || '',
      plannerResultCode: document.querySelector('[data-taw-root]')?.dataset.tawResultCode || '',
      plannerEnabledControls: document.querySelectorAll('.taw-range:not(:disabled)').length,
      plannerFederalTax: document.querySelector('[data-taw-federal-tax]')?.textContent.trim() || '',
    };
  }, STALE_COPY_MIGRATION_RECORDS.map(({ id }) => id));
  const expectedBuiltIns = [
    { value: 'now-household', label: 'Now Household' },
    { value: 'future-household', label: 'Future Household' },
  ];
  const visibleBuiltIns = startup.options
    .filter(option => ['now-household', 'future-household'].includes(option.value))
    .map(({ value, label }) => ({ value, label }));
  const optionIds = startup.options.slice(1).map(option => option.value);
  const nameOnlyRecordsSurvived = STALE_COPY_MIGRATION_RECORDS.every(record => (
    startup.dbIds.includes(record.id)
      && startup.staleRecordBytes[record.id] === expectedNameOnlyBytes[record.id]
      && startup.options.filter(option => (
        option.value === record.id && option.label === record.label
      )).length === 1
  ));
  const survivorOption = startup.options.find(option => option.value === MIGRATION_SURVIVOR.id);
  requireCondition(
    startup.active === null
      && startup.selected === ''
      && startup.railName === ''
      && startup.options[0]?.value === ''
      && startup.options[0]?.disabled === true
      && JSON.stringify(visibleBuiltIns) === JSON.stringify(expectedBuiltIns)
      && JSON.stringify(optionIds) === JSON.stringify(startup.dbIds)
      && startup.customIds.every(id => optionIds.includes(id))
      && survivorOption?.label === MIGRATION_SURVIVOR.label
      && startup.dbIds.includes(MIGRATION_SURVIVOR.id)
      && nameOnlyRecordsSurvived
      && !optionIds.some(id => [
        'demo',
        'default-pre-retirement-solo',
        'default-pre-retirement-couple',
      ].includes(id))
      && startup.menuHidden === false
      && startup.menuButtonHidden === true
      && startup.progressHidden === true
      && startup.stepperHidden === true
      && startup.footerHidden === true
      && startup.screenCount === 0
      && startup.enabledFields === 0
      && startup.nowScenarioBytes === null
      && startup.futureScenarioBytes === null
      && startup.plannerHouseholdId === ''
      && startup.plannerResultCode === ''
      && startup.plannerEnabledControls === 0
      && startup.plannerFederalTax === '\u2014',
    `Blank startup/selector contract failed: ${JSON.stringify(startup)}`,
  );

  await selectHouseholdVisible(page, 'now-household');
  await goToWizardStep(page, 'family');
  const family = await page.evaluate(() => ({
    householdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
    selected: document.querySelector('#hh-switch')?.value || '',
    railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    spouseName: document.querySelector('[data-wizard-field="spouseName"]')?.value || '',
  }));
  requireCondition(
    family.householdId === 'now-household'
      && family.selected === 'now-household'
      && family.railName === 'Now Household'
      && family.primaryName === 'Aboysname'
      && family.spouseName === 'Agirlsname',
    `Now selection did not hydrate approved Family facts: ${JSON.stringify(family)}`,
  );

  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(() => {
    const riskControl = document.querySelector(
      '#scn-view .cmp-step-btn[data-lever-key="risk"]',
    );
    return document.querySelector('.page.on')?.dataset.page === 'scenarios'
      && document.querySelector('#scn-seg-compare')?.classList.contains('is-active')
      && document.querySelectorAll('#scn-view .scol__name').length > 0
      && riskControl?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')
      && document.querySelector('#scn-view .cmp-lev-in[data-key="savings"]');
  }, { timeout: 15000 });
  const nowLevers = await page.evaluate(() => {
    const riskControl = document.querySelector(
      '#scn-view .cmp-step-btn[data-lever-key="risk"]',
    );
    return {
      baseline: document.querySelector('#scn-view .scol__name')?.textContent.trim() || '',
      allocation: riskControl?.closest('.cmp-lev-row')
        ?.querySelector('.cmp-lev-val')?.textContent.trim() || '',
      savings: Number.parseFloat(
        document.querySelector('#scn-view .cmp-lev-in[data-key="savings"]')?.value.replaceAll(',', '') || '',
      ),
    };
  });
  requireCondition(
    nowLevers.baseline === 'Baseline'
      && nowLevers.allocation === '90 / 10'
      && nowLevers.savings === 46000,
    `Now Scenarios defaults are wrong: ${JSON.stringify(nowLevers)}`,
  );
  const scenarioKeys = await page.evaluate(() => Object.keys(localStorage)
    .filter(key => key === 'parallax.scenarios.now-household.v1'));
  requireCondition(
    scenarioKeys.length === 0,
    `Now runtime scenarios entered persistent storage: ${JSON.stringify(scenarioKeys)}`,
  );
  await page.click('.htab[data-page="household"]');
  await waitForWizard(page, { householdId: 'now-household' });
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
    return selected
      && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
  }, { timeout: 10000 });
  await page.evaluate(() => {
    const dbKey = 'parallax.households.v1';
    const activeKey = 'parallax.activeHouseholdId';
    const db = JSON.parse(localStorage.getItem(dbKey) || 'null');
    const active = localStorage.getItem(activeKey);
    const plan = db?.[active];
    if(!plan) throw new Error('Active household fixture is unavailable');
    plan.meta.name = 'Verifier Household';
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

async function verifyRuntimeTemplateSessionIsolation(page){
  const runtimeIds = ['now-household', 'future-household'];
  await openWizard(page);
  const baseline = await page.evaluate(ids => {
    const dbBytes = localStorage.getItem('parallax.households.v1');
    const db = JSON.parse(dbBytes || 'null');
    return {
      dbBytes,
      dbIds: Object.keys(db || {}).sort(),
      fixtureBytes: Object.fromEntries(ids.map(id => [id, JSON.stringify(db?.[id] || null)])),
      scenarioBytes: JSON.stringify(
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith('parallax.scenarios.'))
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      optionIds: [...document.querySelectorAll('#hh-switch option')]
        .map(option => option.value),
    };
  }, runtimeIds);
  requireCondition(
    baseline.dbBytes
      && runtimeIds.every(id => baseline.fixtureBytes[id] !== 'null'),
    `Runtime fixtures were unavailable: ${JSON.stringify(baseline)}`,
  );

  const persistentState = () => page.evaluate(ids => {
    const dbBytes = localStorage.getItem('parallax.households.v1');
    const db = JSON.parse(dbBytes || 'null');
    return {
      dbBytes,
      dbIds: Object.keys(db || {}).sort(),
      fixtureBytes: Object.fromEntries(ids.map(id => [id, JSON.stringify(db?.[id] || null)])),
      scenarioBytes: JSON.stringify(
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith('parallax.scenarios.'))
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      optionIds: [...document.querySelectorAll('#hh-switch option')]
        .map(option => option.value),
      derivedIds: Object.entries(db || {})
        .filter(([, household]) => ids.includes(household?.meta?.runtimeSourceHouseholdId))
        .map(([id]) => id)
        .sort(),
      active: localStorage.getItem('parallax.activeHouseholdId'),
      runtimeScenarioKeys: ids.filter(id => (
        localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null
      )),
    };
  }, runtimeIds);
  const requireUnchangedPersistence = async label => {
    const state = await persistentState();
    requireCondition(
      state.dbBytes === baseline.dbBytes
        && JSON.stringify(state.dbIds) === JSON.stringify(baseline.dbIds)
        && JSON.stringify(state.fixtureBytes) === JSON.stringify(baseline.fixtureBytes)
        && state.scenarioBytes === baseline.scenarioBytes
        && JSON.stringify(state.optionIds) === JSON.stringify(baseline.optionIds)
        && state.derivedIds.length === 0
        && state.active === null
        && state.runtimeScenarioKeys.length === 0,
      `${label} changed persistent runtime state: ${JSON.stringify(state)}`,
    );
  };

  for(const [index, householdId] of runtimeIds.entries()){
    const otherHouseholdId = runtimeIds[(index + 1) % runtimeIds.length];
    const originalName = JSON.parse(baseline.fixtureBytes[householdId]).meta.primaryName;
    const editedName = `Temporary ${householdId} edit`;
    let runtimeAllocationCheck = null;
    await selectHouseholdVisible(page, householdId);
    await page.waitForFunction(
      () => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''),
      { timeout: 30000 },
    );
    await goToWizardStep(page, 'family');
    await setWizardValue(page, '[data-wizard-field="primaryName"]', editedName);
    await page.waitForFunction(({ expectedId, expectedName, expectedStatus }) => (
      document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === expectedId
        && document.querySelector('#hh-switch')?.value === expectedId
        && document.querySelector('[data-wizard-field="primaryName"]')?.value === expectedName
        && document.querySelector('#status')?.textContent.trim() === expectedStatus
        && localStorage.getItem('parallax.activeHouseholdId') === null
    ), { timeout: 10000 }, {
      expectedId: householdId,
      expectedName: editedName,
      expectedStatus: 'Demo changes are temporary \u00b7 use New Household to save a plan',
    });
    await requireUnchangedPersistence(`${householdId} Family edit`);

    if(index === 0){
      await openNetWorthCategory(page, 'investment');
      const accountId = await page.$eval(
        '[data-hh-action="net-worth-edit-entry"][data-entry-category-id="investment"]',
        button => button.dataset.accountId,
      );
      await clickWizardAction(
        page,
        `[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`,
      );
      const originalPresetId = await page.evaluate(() =>
        document.querySelector('[data-asset-allocation-selector] input:checked')?.value || '');
      const fixtureAccount = JSON.parse(baseline.fixtureBytes[householdId])
        .portfolio.extraAccounts.find(account => account.id === accountId);
      const expectedOriginalPresetId = fixtureAccount?.investmentAllocation?.source === 'preset'
        ? fixtureAccount.investmentAllocation.presetId
        : '';
      requireCondition(
        originalPresetId === expectedOriginalPresetId,
        `Demo allocation selector misstated saved allocation provenance: ${JSON.stringify({
          accountId,
          source: fixtureAccount?.investmentAllocation?.source || '',
          expected: expectedOriginalPresetId,
          actual: originalPresetId,
        })}`,
      );
      const temporaryPresetId = originalPresetId === 'all-equity'
        ? 'defensive'
        : 'all-equity';
      await selectNetWorthAllocation(page, temporaryPresetId);
      await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
      const visiblePresetId = await page.$eval(
        `[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`,
        button => button.dataset.entryAllocationPresetId || '',
      );
      requireCondition(
        visiblePresetId === temporaryPresetId,
        `Demo allocation edit was not visible in-session: ${visiblePresetId}`,
      );
      await requireUnchangedPersistence(`${householdId} allocation edit`);
      await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
      runtimeAllocationCheck = { accountId, originalPresetId };
    }

    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(() => (
      document.querySelector('.page.on')?.dataset.page === 'scenarios'
        && document.querySelectorAll('#scn-view .scol__name').length > 0
    ), { timeout: 10000 });
    const defaultScenarioCount = await countMatches(page, '#scn-view .scol__name');
    await requireUnique(page, '#scn-add', 'Add scenario action');
    await page.click('#scn-add');
    await page.waitForFunction(expectedCount => (
      document.querySelectorAll('#scn-view .scol__name').length === expectedCount
    ), { timeout: 30000 }, defaultScenarioCount + 1);
    await requireUnchangedPersistence(`${householdId} scenario edit`);

    await page.click('.htab[data-page="household"]');
    await waitForWizard(page, { householdId });
    await selectHouseholdVisible(page, otherHouseholdId);
    await selectHouseholdVisible(page, householdId);
    await goToWizardStep(page, 'family');
    const restoredName = await page.$eval(
      '[data-wizard-field="primaryName"]',
      input => input.value,
    );
    requireCondition(
      restoredName === originalName,
      `${householdId} did not restore its shipped Family state after reselection`,
    );
    if(runtimeAllocationCheck){
      await openNetWorthCategory(page, 'investment');
      await clickWizardAction(
        page,
        `[data-hh-action="net-worth-edit-entry"][data-account-id="${runtimeAllocationCheck.accountId}"]`,
      );
      const restoredPresetId = await page.evaluate(() =>
        document.querySelector('[data-asset-allocation-selector] input:checked')?.value || '');
      requireCondition(
        restoredPresetId === runtimeAllocationCheck.originalPresetId,
        `Demo allocation did not reset after household switch: ${JSON.stringify({
          expected: runtimeAllocationCheck.originalPresetId,
          actual: restoredPresetId,
        })}`,
      );
      await clickWizardAction(page, '[data-hh-action="net-worth-cancel-draft"]');
      await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
    }
    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(expectedCount => (
      document.querySelector('.page.on')?.dataset.page === 'scenarios'
        && document.querySelectorAll('#scn-view .scol__name').length === expectedCount
    ), { timeout: 10000 }, defaultScenarioCount);
    await requireUnchangedPersistence(`${householdId} reselection`);
    await page.click('.htab[data-page="household"]');
    await waitForWizard(page, { householdId });
  }

  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await waitForUnselectedWizard(page);
  await requireUnchangedPersistence('runtime reload');
  for(const householdId of runtimeIds){
    await selectHouseholdVisible(page, householdId);
    await goToWizardStep(page, 'family');
    const visibleName = await page.$eval(
      '[data-wizard-field="primaryName"]',
      input => input.value,
    );
    requireCondition(
      visibleName === JSON.parse(baseline.fixtureBytes[householdId]).meta.primaryName,
      `${householdId} did not restore its shipped Family state after reload`,
    );
    await requireUnchangedPersistence(`${householdId} explicit selection after reload`);
  }

  const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
  if(menuHidden){
    await clickWizardAction(page, '#hh-menu-btn', { expectRevision: false });
  }
  await requireUnique(page, '#hh-menu-pop:not([hidden]) #hh-new', 'visible new household action');
  await clickWizardAction(page, '#hh-new');
  await page.waitForFunction(() => {
    const id = document.querySelector('#hh-switch')?.value || '';
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return /^hh_[a-z0-9]+$/i.test(id)
      && localStorage.getItem('parallax.activeHouseholdId') === id
      && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === id
      && Boolean(db?.[id]);
  }, { timeout: 10000 });
  const customId = await page.$eval('#hh-switch', selector => selector.value);
  const expectedCustomIds = [...baseline.dbIds, customId].sort();

  for(const editedName of ['Lifecycle custom first edit', 'Lifecycle custom final edit']){
    await goToWizardStep(page, 'family');
    await setWizardValue(page, '[data-wizard-field="primaryName"]', editedName);
    await page.waitForFunction(({ expectedId, expectedName, expectedIds }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return localStorage.getItem('parallax.activeHouseholdId') === expectedId
        && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === expectedId
        && document.querySelector('#hh-switch')?.value === expectedId
        && db?.[expectedId]?.meta?.primaryName === expectedName
        && JSON.stringify(Object.keys(db || {}).sort()) === JSON.stringify(expectedIds)
        && !Object.values(db || {}).some(household => (
          ['now-household', 'future-household'].includes(
            household?.meta?.runtimeSourceHouseholdId,
          )
        ));
    }, { timeout: 10000 }, {
      expectedId: customId,
      expectedName: editedName,
      expectedIds: expectedCustomIds,
    });
  }

  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(() => (
    document.querySelector('.page.on')?.dataset.page === 'scenarios'
      && document.querySelectorAll('#scn-view .scol__name').length > 0
  ), { timeout: 10000 });
  const customScenarioCount = await countMatches(page, '#scn-view .scol__name');
  await page.click('#scn-add');
  await page.waitForFunction(({ expectedId, expectedCount }) => {
    const saved = JSON.parse(
      localStorage.getItem(`parallax.scenarios.${expectedId}.v1`) || 'null',
    );
    return localStorage.getItem('parallax.activeHouseholdId') === expectedId
      && document.querySelectorAll('#scn-view .scol__name').length === expectedCount
      && Array.isArray(saved)
      && saved.length === expectedCount;
  }, { timeout: 30000 }, {
    expectedId: customId,
    expectedCount: customScenarioCount + 1,
  });
  const savedCustom = await page.evaluate(id => ({
    householdBytes: JSON.stringify(
      JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id] || null,
    ),
    scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`),
  }), customId);

  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await waitForUnselectedWizard(page);
  await selectHouseholdVisible(page, customId);
  await goToWizardStep(page, 'family');
  const restoredCustom = await page.evaluate(({ id, expectedHousehold, expectedScenario }) => ({
    active: localStorage.getItem('parallax.activeHouseholdId'),
    selected: document.querySelector('#hh-switch')?.value || '',
    rootId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
    visibleName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    householdUnchanged: JSON.stringify(
      JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id] || null,
    ) === expectedHousehold,
    scenarioUnchanged: localStorage.getItem(`parallax.scenarios.${id}.v1`) === expectedScenario,
    matchingOptions: [...document.querySelectorAll('#hh-switch option')]
      .filter(option => option.value === id).length,
  }), {
    id: customId,
    expectedHousehold: savedCustom.householdBytes,
    expectedScenario: savedCustom.scenarioBytes,
  });
  requireCondition(
    restoredCustom.active === customId
      && restoredCustom.selected === customId
      && restoredCustom.rootId === customId
      && restoredCustom.visibleName === 'Lifecycle custom final edit'
      && restoredCustom.householdUnchanged
      && restoredCustom.scenarioUnchanged
      && restoredCustom.matchingOptions === 1,
    `Custom household did not persist under one identity: ${JSON.stringify(restoredCustom)}`,
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

async function verifyAssetAllocationHistoricalFlow(page){
  const storageBefore = await snapshotStorage(page);
  const viewportBefore = page.viewport();
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-account-type-id="rollover_ira"]',
  );
  const defaultSelector = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('[data-asset-allocation-selector] .nw-allocation-option span')]
      .map(element => element.textContent.trim()),
    selected: document.querySelector(
      '[data-asset-allocation-selector] input:checked',
    )?.value || '',
  }));
  requireCondition(
    JSON.stringify(defaultSelector.labels) === JSON.stringify([
      'Defensive',
      'Conservative',
      'Balanced',
      'Growth',
      'Aggressive',
      'All Equity',
    ]) && defaultSelector.selected === 'balanced',
    `New investment account did not visibly default to Balanced: ${JSON.stringify(defaultSelector)}`,
  );
  await setWizardValue(
    page,
    '[data-net-worth-draft="name"]',
    'Verifier allocation account',
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
    '1000000',
    { expectRevision: false, eventType: 'input' },
  );
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const accountId = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.nw-saved-row')].find(candidate =>
      candidate.querySelector('.nw-saved-name')?.textContent.trim()
        === 'Verifier allocation account');
    return row?.querySelector('[data-hh-action="net-worth-edit-entry"]')
      ?.dataset.accountId || '';
  });
  requireCondition(accountId, 'Saved allocation account is unavailable for verification');
  await page.waitForFunction(expectedId => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const account = database?.[active]?.portfolio?.extraAccounts
      ?.find(candidate => candidate.id === expectedId);
    return account?.investmentAllocation?.source === 'preset'
      && account.investmentAllocation.presetId === 'balanced';
  }, { timeout: 10000 }, accountId);

  const fixtureBalances = await page.evaluate(expectedId => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const plan = database?.[active];
    const accounts = plan?.portfolio?.extraAccounts || [];
    const allocationAccount = accounts.find(account => account.id === expectedId);
    const cashAccounts = accounts.filter(account => (
      account.investmentAllocation?.source === 'cash-only'
    ));
    return {
      allocationBalance: allocationAccount?.balance ?? null,
      allocationSource: allocationAccount?.investmentAllocation?.source || '',
      allocationPresetId: allocationAccount?.investmentAllocation?.presetId || '',
      allocationWeights: allocationAccount?.investmentAllocation?.weights || null,
      cashBalance: cashAccounts.reduce((sum, account) => sum + account.balance, 0),
      cashAccountCount: cashAccounts.length,
      projectionAccountCount: accounts.length,
      baseBalances: Object.fromEntries(
        Object.entries(plan?.portfolio?.accounts || {}).map(([bucket, account]) => (
          [bucket, account?.balance ?? null]
        )),
      ),
    };
  }, accountId);
  requireCondition(
    fixtureBalances.allocationBalance === 1000000
      && fixtureBalances.allocationSource === 'preset'
      && fixtureBalances.allocationPresetId === 'balanced'
      && JSON.stringify(fixtureBalances.allocationWeights)
        === JSON.stringify(snapshotPresetAllocation('balanced').weights)
      && fixtureBalances.cashBalance === 250001
      && fixtureBalances.cashAccountCount === 1
      && fixtureBalances.projectionAccountCount === 2
      && Object.values(fixtureBalances.baseBalances).every(balance => balance === 0),
    `Allocation Historical fixture balances drifted: ${JSON.stringify(fixtureBalances)}`,
  );

  const balanced = await historicalCashFlowSnapshot(page);
  const balanced1973 = independentlyResolve1973PresetReturn('balanced');
  const openingBalance = fixtureBalances.allocationBalance + fixtureBalances.cashBalance;
  const expectedBalancedRate = (
    (fixtureBalances.allocationBalance * balanced1973.rate)
      + (fixtureBalances.cashBalance * balanced1973.cashRate)
  ) / openingBalance;
  requireCondition(
    Number(balanced.startBalance) === openingBalance
      && balanced.returnText === visibleReturnText(expectedBalancedRate),
    `Balanced 1973 Cash Flow did not match canonical saved weights: ${JSON.stringify({
      balanced,
      expectedStartBalance: openingBalance,
      expectedReturnText: visibleReturnText(expectedBalancedRate),
      expectedReturnRate: expectedBalancedRate,
    })}`,
  );
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(
    page,
    `[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`,
  );
  const reopenedBalanced = await page.$eval(
    '[data-asset-allocation-selector] input:checked',
    input => input.value,
  );
  requireCondition(
    reopenedBalanced === 'balanced',
    `Saved Balanced allocation did not reopen as selected: ${reopenedBalanced}`,
  );
  await selectNetWorthAllocation(page, 'growth');
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  await page.waitForFunction(expectedId => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const account = database?.[active]?.portfolio?.extraAccounts
      ?.find(candidate => candidate.id === expectedId);
    return account?.investmentAllocation?.source === 'preset'
      && account.investmentAllocation.presetId === 'growth';
  }, { timeout: 10000 }, accountId);
  const savedGrowthWeights = await page.evaluate(expectedId => {
    const database = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return database?.[active]?.portfolio?.extraAccounts
      ?.find(candidate => candidate.id === expectedId)?.investmentAllocation?.weights || null;
  }, accountId);
  requireCondition(
    JSON.stringify(savedGrowthWeights)
      === JSON.stringify(snapshotPresetAllocation('growth').weights),
    `Saved Growth allocation weights are not canonical: ${JSON.stringify(savedGrowthWeights)}`,
  );
  const growth = await historicalCashFlowSnapshot(page, {
    previousEndingBalance: balanced.endingBalance,
  });
  const growth1973 = independentlyResolve1973PresetReturn('growth');
  const expectedGrowthRate = (
    (fixtureBalances.allocationBalance * growth1973.rate)
      + (fixtureBalances.cashBalance * growth1973.cashRate)
  ) / openingBalance;
  const expectedEndingDelta = fixtureBalances.allocationBalance
    * (growth1973.rate - balanced1973.rate);
  const actualEndingDelta = Number(growth.endingBalance) - Number(balanced.endingBalance);
  requireCondition(
    balanced.pathId === 'historical-1973'
      && growth.pathId === 'historical-1973'
      && balanced.kind === 'historical'
      && growth.kind === 'historical'
      && balanced.sourceYear === '1973'
      && growth.sourceYear === '1973'
      && balanced.startBalance === growth.startBalance
      && growth.returnText === visibleReturnText(expectedGrowthRate)
      && Math.abs(actualEndingDelta - expectedEndingDelta) <= 0.02,
    `Saved allocation did not produce the canonical deterministic Historical Cash Flow: ${JSON.stringify({
      balanced,
      growth,
      expectedGrowthReturnText: visibleReturnText(expectedGrowthRate),
      expectedGrowthRate,
      expectedEndingDelta,
      actualEndingDelta,
    })}`,
  );

  await reloadWizard(page);
  await openNetWorthCategory(page, 'investment');
  await clickWizardAction(
    page,
    `[data-hh-action="net-worth-edit-entry"][data-account-id="${accountId}"]`,
  );
  const persisted = await page.evaluate(() => ({
    selected: document.querySelector(
      '[data-asset-allocation-selector] input:checked',
    )?.value || '',
    selectedCount: document.querySelectorAll(
      '[data-asset-allocation-selector] input:checked',
    ).length,
  }));
  requireCondition(
    persisted.selected === 'growth' && persisted.selectedCount === 1,
    `Growth allocation did not survive reload: ${JSON.stringify(persisted)}`,
  );

  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
  });
  const mobileSelector = await page.evaluate(() => {
    const options = document.querySelector('.nw-allocation-options');
    const labels = [...(options?.querySelectorAll('.nw-allocation-option') || [])];
    const first = labels[0];
    const last = labels.at(-1);
    const firstInput = first?.querySelector('input');
    const lastInput = last?.querySelector('input');
    const intersectsHorizontally = (element, container) => {
      const elementRect = element?.getBoundingClientRect();
      const containerRect = container?.getBoundingClientRect();
      return Boolean(elementRect && containerRect
        && elementRect.right > containerRect.left
        && elementRect.left < containerRect.right);
    };
    if(options) options.scrollLeft = 0;
    const firstReachable = intersectsHorizontally(first, options);
    firstInput?.focus();
    const firstFocusable = document.activeElement === firstInput;
    if(options) options.scrollLeft = options.scrollWidth;
    const lastReachable = intersectsHorizontally(last, options);
    lastInput?.focus();
    const lastFocusable = document.activeElement === lastInput;
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      selectorScrollWidth: options?.scrollWidth || 0,
      selectorClientWidth: options?.clientWidth || 0,
      selectorOverflowX: options ? getComputedStyle(options).overflowX : '',
      firstReachable,
      lastReachable,
      firstFocusable,
      lastFocusable,
      firstDisabled: firstInput?.disabled === true,
      lastDisabled: lastInput?.disabled === true,
    };
  });
  requireCondition(
    mobileSelector.documentScrollWidth <= mobileSelector.documentClientWidth + 1
      && mobileSelector.selectorScrollWidth > mobileSelector.selectorClientWidth
      && ['auto', 'scroll'].includes(mobileSelector.selectorOverflowX)
      && mobileSelector.firstReachable
      && mobileSelector.lastReachable
      && mobileSelector.firstFocusable
      && mobileSelector.lastFocusable
      && !mobileSelector.firstDisabled
      && !mobileSelector.lastDisabled,
    `Mobile allocation selector containment failed: ${JSON.stringify(mobileSelector)}`,
  );
  if(viewportBefore) await page.setViewport(viewportBefore);
  await clickWizardAction(page, '[data-hh-action="net-worth-cancel-draft"]');
  const reloadedGrowth = await historicalCashFlowSnapshot(page);
  requireCondition(
    JSON.stringify(reloadedGrowth) === JSON.stringify(growth),
    `Reloaded persisted Growth allocation changed Historical Cash Flow: ${JSON.stringify({
      beforeReload: growth,
      afterReload: reloadedGrowth,
    })}`,
  );

  await restoreStorage(page, storageBefore);
  await reloadWizard(page);
  const storageAfter = await snapshotStorage(page);
  requireCondition(
    exactStorageSnapshot(storageAfter) === exactStorageSnapshot(storageBefore),
    'Allocation Historical proof did not restore its exact function-local storage snapshot',
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
      && irmaaInputs.controlWidths[0] >= 288 && irmaaInputs.controlWidths[0] <= 290
      && irmaaInputs.controlWidths[1] >= 288 && irmaaInputs.controlWidths[1] <= 290
      && irmaaInputs.controlWidths.slice(2).every(width => width >= 127 && width <= 129)
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

  const beforeBlankItemizedContinue = await wizardState(page);
  await page.click(continueSelector);
  await waitForWizard(page, {
    step: 'summary',
    afterRevision: beforeBlankItemizedContinue.revision,
  });
  const blankItemized = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const deductions = db?.[active]?.incomeTax?.current1040?.deductions;
    return {
      method: deductions?.method,
      source: deductions?.source,
      medical: deductions?.itemized?.medicalExpensesPaid,
      salt: deductions?.itemized?.salt?.eligibleTaxesPaid,
      saltMagi: deductions?.itemized?.salt?.magi?.amount,
      mortgage: deductions?.itemized?.mortgageInterestDeductible,
      charitable: deductions?.itemized?.charitableContributionsDeductible,
      other: deductions?.itemized?.otherItemizedDeductions,
    };
  });
  requireCondition(
    blankItemized.method === 'itemized'
      && blankItemized.source === 'calculated'
      && blankItemized.medical === 0
      && blankItemized.salt === 0
      && blankItemized.saltMagi === 0
      && blankItemized.mortgage === 0
      && blankItemized.charitable === 0
      && blankItemized.other === 0,
    `Blank itemized amounts did not continue as zero: ${JSON.stringify(blankItemized)}`,
  );

  await goToWizardStep(page, 'tax');
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
    'completed Summary Continue to Goals action',
  );
  await page.click(summaryContinueSelector);
  await page.waitForFunction(
    () => document.querySelector('.page.on')?.dataset.page === 'net-worth'
      && document.querySelector('.htab.is-active')?.dataset.subTarget === 'goals',
    { timeout: 8000 },
  );
  const planningPage = await page.evaluate(() => ({
    page: document.querySelector('.page.on')?.dataset.page || '',
    subTarget: document.querySelector('.htab.is-active')?.dataset.subTarget || '',
  }));
  requireCondition(
    planningPage.page === 'net-worth' && planningPage.subTarget === 'goals',
    `Completed Summary did not enter Goals: ${JSON.stringify(planningPage)}`,
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
  let originalHouseholdId = null;
  const originalViewport = page.viewport();
  let failure = null;
  try{
    await openWizard(page);
    originalStorage = await snapshotStorage(page);
    originalHouseholdId = await page.$eval(
      '#hh-switch',
      selector => selector.value || null,
    );
    const expectedNameOnlyBytes = await seedStaleCopyMigrationFixture(page);
    await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await verifyBlankStartupAndNowSelection(page, expectedNameOnlyBytes);
    await verifyRuntimeTemplateSessionIsolation(page);
    await prepareContractFixture(page);
    await assertFourStepStructure(page);
    await verifyFamilyPropagation(page);
    await verifyNetWorthFlow(page);
    await verifyPlanningSourceAndTaxFlow(page);
    await verifyAssetAllocationHistoricalFlow(page);
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
        await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
        await waitForUnselectedWizard(page);
        if(originalHouseholdId){
          const available = await page.$$eval(
            '#hh-switch option',
            (options, householdId) => options.some(option => option.value === householdId),
            originalHouseholdId,
          );
          if(available) await selectHouseholdVisible(page, originalHouseholdId);
        }
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

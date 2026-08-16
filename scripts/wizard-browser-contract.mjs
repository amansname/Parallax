import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const WIZARD_STEP_IDS = Object.freeze([
  'family',
  'net-worth',
  'income',
  'goals',
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
    timeout = 8000,
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

async function setWizardChecked(page, selector, checked){
  await requireUnique(page, selector);
  const before = await wizardState(page);
  await page.evaluate(({ fieldSelector, nextChecked }) => {
    const control = document.querySelector(fieldSelector);
    control.checked = nextChecked;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }, {
    fieldSelector: selector,
    nextChecked: checked,
  });
  return waitForWizard(page, {
    step: before.step,
    afterRevision: before.revision,
  });
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
      await page.select('#hh-switch', priorHouseholdId);
      return waitForWizard(page, { householdId: priorHouseholdId });
    }
  }
  return waitForWizard(page, { householdId: 'demo' });
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
  await clickWizardAction(page, '#hh-menu-btn', { expectRevision: false });
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

async function assertSixStepStructure(page){
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
    };
  });
  requireCondition(
    JSON.stringify(structure.ids) === JSON.stringify(WIZARD_STEP_IDS),
    `Wizard steps drifted: ${JSON.stringify(structure.ids)}`,
  );
  requireCondition(
    JSON.stringify(structure.labels)
      === JSON.stringify(['Family', 'Net Worth', 'Income', 'Goals', 'Tax', 'Summary']),
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
    structure.logo.src === 'assets/parallax-logo.png'
      && structure.logo.complete
      && structure.logo.naturalWidth > 0,
    `Canonical logo did not load: ${JSON.stringify(structure.logo)}`,
  );
}

async function verifyFamilyPropagation(page){
  await goToWizardStep(page, 'family');
  const initialBoundary = await page.evaluate(() => ({
    people: document.querySelectorAll('[data-person-owner]').length,
    addSpouse: document.querySelectorAll('[data-hh-action="add-spouse"]').length,
    filing: document.querySelectorAll(
      '[data-hh-wizard-screen="family"] [data-wizard-field="filingStatus"]',
    ).length,
    state: document.querySelectorAll(
      '[data-hh-wizard-screen="family"] [data-wizard-field="state"]',
    ).length,
    socialSecurity: [...document.querySelectorAll(
      '[data-hh-wizard-screen="family"] [data-wizard-field]',
    )].filter(control => /socialSecurity/i.test(control.dataset.wizardField || '')).length,
  }));
  requireCondition(
    initialBoundary.people === 1
      && initialBoundary.addSpouse === 1
      && initialBoundary.filing === 0
      && initialBoundary.state === 0
      && initialBoundary.socialSecurity === 0,
    `Family source boundary drifted: ${JSON.stringify(initialBoundary)}`,
  );
  await setWizardValue(
    page,
    '[data-wizard-field="client.birthDate"]',
    '1960-01-01',
  );
  await setWizardValue(page, '[data-wizard-field="client.retirementAge"]', '68');
  await setWizardValue(page, '[data-wizard-field="client.planEndAge"]', '102');
  await clickWizardAction(page, '[data-hh-action="add-spouse"]');
  const family = await page.evaluate(() => ({
    people: document.querySelectorAll('[data-person-owner]').length,
    spouse: document.querySelectorAll('[data-person-owner="spouse"]').length,
    filing: document.querySelectorAll(
      '[data-hh-wizard-screen="family"] [data-wizard-field="filingStatus"]',
    ).length,
  }));
  requireCondition(
    family.people === 2 && family.spouse === 1 && family.filing === 0,
    `Family did not add the co-client without taking Tax ownership: ${JSON.stringify(family)}`,
  );
  await setWizardValue(page, '[data-wizard-field="spouseName"]', 'Verifier Co-client');
  await setWizardValue(
    page,
    '[data-wizard-field="spouse.birthDate"]',
    '1961-01-01',
  );
  await setWizardValue(page, '[data-wizard-field="spouse.retirementAge"]', '70');
  await setWizardValue(page, '[data-wizard-field="spouse.planEndAge"]', '101');

  const spouseTransition = await page.evaluate(() => ({
    removeActions: document.querySelectorAll(
      '[data-person-owner="spouse"] [data-hh-action="remove-spouse"]',
    ).length,
    removeLabel: document.querySelector(
      '[data-person-owner="spouse"] [data-hh-action="remove-spouse"]',
    )?.getAttribute('aria-label') || '',
  }));
  requireCondition(
    spouseTransition.removeActions === 1
      && spouseTransition.removeLabel === 'Remove co-client',
    `Family did not expose one guided co-client removal: ${JSON.stringify(spouseTransition)}`,
  );

  await goToWizardStep(page, 'tax');
  const marriedTaxFiling = await page.evaluate(() => {
    const control = document.querySelector(
      '[data-wizard-scope="tax-profile"][data-wizard-field="filingStatus"]',
    );
    return {
      value: control?.value || '',
      options: [...(control?.options || [])].map(option => option.value),
    };
  });
  requireCondition(
    marriedTaxFiling.value === 'marriedFilingJointly'
      && JSON.stringify(marriedTaxFiling.options)
        === JSON.stringify(['marriedFilingJointly']),
    `Tax did not keep the co-client filing transition guarded: ${JSON.stringify(marriedTaxFiling)}`,
  );

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

  await goToWizardStep(page, 'income');
  await setWizardValue(
    page,
    '[data-income-row-id="verify_wage_two"][data-wizard-field="source.owner"]',
    'spouse',
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
  const incomeBlocked = await page.evaluate(() => ({
    code: document.querySelector('[data-hh-wizard-root]')
      ?.dataset.validationCode || '',
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length,
  }));
  requireCondition(
    incomeBlocked.code === 'CO_CLIENT_INCOME_REQUIRES_REASSIGNMENT'
      && incomeBlocked.confirms === 0
      && incomeBlocked.people === 2,
    `Co-client income guard did not precede confirmation: ${JSON.stringify(incomeBlocked)}`,
  );
  await goToWizardStep(page, 'income');
  await setWizardValue(
    page,
    '[data-income-row-id="verify_wage_two"][data-wizard-field="source.owner"]',
    'client',
  );

  await setWizardValue(
    page,
    '[data-wizard-field="savings.split.byOwner.client"]',
    '55',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="savings.split.byOwner.spouse"]',
    '45',
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
  const contributionBlocked = await page.evaluate(() => ({
    code: document.querySelector('[data-hh-wizard-root]')
      ?.dataset.validationCode || '',
    confirms: window.__coClientConfirmCalls,
    people: document.querySelectorAll('[data-person-owner]').length,
  }));
  requireCondition(
    contributionBlocked.code === 'CO_CLIENT_CONTRIBUTIONS_REQUIRE_REASSIGNMENT'
      && contributionBlocked.confirms === 0
      && contributionBlocked.people === 2,
    `Co-client contribution guard did not precede confirmation: ${JSON.stringify(contributionBlocked)}`,
  );
  await goToWizardStep(page, 'income');
  await setWizardValue(
    page,
    '[data-wizard-field="savings.split.byOwner.client"]',
    '100',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="savings.split.byOwner.spouse"]',
    '0',
  );
  await goToWizardStep(page, 'tax');
  await setWizardValue(page, '[data-tax-field="income.wages.client"]', '81000');
  await setWizardValue(page, '[data-tax-field="income.wages.spouse"]', '39000');

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
  const cancelled = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return {
      confirms: window.__coClientConfirmCalls,
      people: document.querySelectorAll('[data-person-owner]').length,
      status: db?.[active]?.meta?.filingStatus || '',
    };
  });
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
  const removed = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    return {
      confirms: window.__coClientConfirmCalls,
      people: document.querySelectorAll('[data-person-owner]').length,
      status: saved?.meta?.filingStatus || '',
      spouse: saved?.household?.spouse ?? null,
      spouseAccounts: (saved?.portfolio?.extraAccounts || [])
        .filter(account => account?.owner === 'spouse').length,
      spouseIncome: (saved?.income?.other || [])
        .filter(source => source?.owner === 'spouse').length,
      socialSecuritySpouse: saved?.income?.socialSecurity?.spouse ?? null,
      contributionOwners: saved?.savings?.split?.byOwner ?? null,
      currentWages: saved?.incomeTax?.current1040?.wagesByOwner ?? null,
      aggregateWages: saved?.incomeTax?.current1040?.income?.wages ?? null,
      incomeSourcesComplete: saved?.incomeTax?.current1040?.incomeSourcesComplete,
      currentTaxpayerSpouse: saved?.incomeTax?.current1040?.taxpayers?.spouse ?? null,
      removeAction: document.querySelectorAll(
        '[data-hh-action="remove-spouse"]',
      ).length,
      addAction: document.querySelectorAll(
        '[data-hh-action="add-spouse"]',
      ).length,
    };
  });
  requireCondition(
    removed.confirms === 1
      && removed.people === 1
      && removed.status === 'single'
      && removed.spouse === null
      && removed.spouseAccounts === 0
      && removed.spouseIncome === 0
      && removed.socialSecuritySpouse === null
      && JSON.stringify(removed.contributionOwners) === JSON.stringify({ client: 1 })
      && JSON.stringify(removed.currentWages) === JSON.stringify({ client: 81000 })
      && removed.aggregateWages === 81000
      && removed.incomeSourcesComplete === false
      && removed.currentTaxpayerSpouse === null
      && removed.removeAction === 0
      && removed.addAction === 1,
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
    addAction: document.querySelectorAll('[data-hh-action="add-spouse"]').length,
  }));
  requireCondition(
    persistedRemoval.people === 1 && persistedRemoval.addAction === 1,
    `Co-client removal did not survive reload: ${JSON.stringify(persistedRemoval)}`,
  );

  await goToWizardStep(page, 'tax');
  const singleTaxFiling = await page.evaluate(() => {
    const control = document.querySelector(
      '[data-wizard-scope="tax-profile"][data-wizard-field="filingStatus"]',
    );
    return {
      value: control?.value || '',
      options: [...(control?.options || [])].map(option => option.value),
      clientWages: document.querySelector(
        '[data-tax-field="income.wages.client"]',
      )?.value || '',
      spouseWageFields: document.querySelectorAll(
        '[data-tax-field="income.wages.spouse"]',
      ).length,
    };
  });
  requireCondition(
    singleTaxFiling.value === 'single'
      && JSON.stringify(singleTaxFiling.options)
        === JSON.stringify(['single', 'headOfHousehold'])
      && singleTaxFiling.clientWages === '81000'
      && singleTaxFiling.spouseWageFields === 0,
    `Tax did not expose the post-removal filing choices: ${JSON.stringify(singleTaxFiling)}`,
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

  await goToWizardStep(page, 'income');
  const singleIncomeOwners = await page.evaluate(() => ({
    spouseOptions: document.querySelectorAll(
      '.hh-income-source-owner option[value="spouse"]',
    ).length,
    jointOptions: document.querySelectorAll(
      '.hh-income-source-owner option[value="joint"]',
    ).length,
    owners: [...document.querySelectorAll(
      '.hh-income-source-owner select',
    )].map(control => control.value),
  }));
  requireCondition(
    singleIncomeOwners.spouseOptions === 0
      && singleIncomeOwners.jointOptions === 0
      && singleIncomeOwners.owners.length === 2
      && singleIncomeOwners.owners.every(owner => owner === 'client'),
    `Single-household Income ownership is unsafe: ${JSON.stringify(singleIncomeOwners)}`,
  );

  await goToWizardStep(page, 'family');
  await clickWizardAction(page, '[data-hh-action="add-spouse"]');
  await setWizardValue(page, '[data-wizard-field="spouseName"]', 'Verifier Co-client');
  await setWizardValue(
    page,
    '[data-wizard-field="spouse.birthDate"]',
    '1961-01-01',
  );
  await setWizardValue(page, '[data-wizard-field="spouse.retirementAge"]', '70');
  await setWizardValue(page, '[data-wizard-field="spouse.planEndAge"]', '101');
  await goToWizardStep(page, 'tax');
  const restoredFiling = await page.$eval(
    '[data-wizard-scope="tax-profile"][data-wizard-field="filingStatus"]',
    control => control.value,
  );
  requireCondition(
    restoredFiling === 'marriedFilingJointly',
    `Re-adding the co-client did not restore the guided Tax filing transition: "${restoredFiling}"`,
  );

  await goToWizardStep(page, 'family');
  await setWizardChecked(page, '[data-family-children-toggle]', true);
  await clickWizardAction(page, '[data-hh-action="add-child"]');
  await setWizardValue(page, '[data-wizard-field="children.0.name"]', 'Avery');
  await setWizardValue(page, '[data-wizard-field="children.0.birthYear"]', '2012');
  await setWizardChecked(page, '[data-family-children-toggle]', false);
  requireCondition(
    await countMatches(page, '[data-family-children-block]') === 0,
    'Collapsed Children block remained visible',
  );
  await setWizardChecked(page, '[data-family-children-toggle]', true);
  const child = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-child-row]').length,
    name: document.querySelector('[data-wizard-field="children.0.name"]')?.value || '',
    birthYear: document.querySelector('[data-wizard-field="children.0.birthYear"]')?.value || '',
  }));
  requireCondition(
    child.rows === 1 && child.name === 'Avery' && child.birthYear === '2012',
    `Children rows did not retain their canonical values: ${JSON.stringify(child)}`,
  );

  await goToWizardStep(page, 'tax');
  const taxProfile = await page.evaluate(() => ({
    filing: document.querySelector(
      '[data-wizard-scope="tax-profile"][data-wizard-field="filingStatus"]',
    )?.value || '',
    state: document.querySelector(
      '[data-wizard-scope="tax-profile"][data-wizard-field="state"]',
    )?.value || '',
  }));
  requireCondition(
    taxProfile.filing === 'marriedFilingJointly' && taxProfile.state === 'VA',
    `Tax did not own the filing and residence controls: ${JSON.stringify(taxProfile)}`,
  );
  await setWizardValue(
    page,
    '[data-wizard-scope="tax-profile"][data-wizard-field="state"]',
    'NY',
  );
  const saved = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const plan = db?.[active];
    return {
      filingStatus: plan?.meta?.filingStatus,
      state: plan?.meta?.state,
      clientBirthDate: plan?.taxProfiles?.client?.birthDate?.value,
      spouseBirthDate: plan?.taxProfiles?.spouse?.birthDate?.value,
      primaryRetirementAge: plan?.household?.primary?.retirementAge,
      spouseRetirementAge: plan?.household?.spouse?.retirementAge,
      children: plan?.household?.children,
    };
  });
  requireCondition(
    saved.filingStatus === 'marriedFilingJointly'
      && saved.state === 'NY'
      && saved.clientBirthDate === '1960-01-01'
      && saved.spouseBirthDate === '1961-01-01'
      && saved.primaryRetirementAge === 68
      && saved.spouseRetirementAge === 70
      && JSON.stringify(saved.children) === JSON.stringify([
        { name: 'Avery', birthYear: 2012 },
      ]),
    `Family and Tax facts did not reach their canonical owners: ${JSON.stringify(saved)}`,
  );
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
    '[data-hh-action="net-worth-pick-type"][data-type-label="Primary Residence"]',
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
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    property.count === 1 && property.name === '—' && property.value === '$500,000',
    `Unnamed property did not save canonical truth: ${JSON.stringify(property)}`,
  );

  await openNetWorthCategory(page, 'mortgage');
  await clickWizardAction(
    page,
    '[data-hh-action="net-worth-pick-type"][data-type-label="Primary Residence"]',
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
      && autoLink.label === 'Property 1'
      && autoLink.available === 'true',
    `Unnamed property was not mortgage-linkable: ${JSON.stringify(autoLink)}`,
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
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    mortgage.count === 1
      && mortgage.meta.includes('Property 1')
      && mortgage.value === '$120,001',
    `Mortgage did not preserve its canonical property link: ${JSON.stringify(mortgage)}`,
  );
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const property = db?.[active]?.properties?.[0];
    return property?.value === 500000 && property?.mortgage?.balance === 120001;
  }, { timeout: 10000 });
  await reloadWizard(page);
  await openNetWorthCategory(page, 'mortgage');
  const persistedMortgage = await page.evaluate(() => {
    const remove = document.querySelector(
      '[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]',
    );
    const row = remove?.closest('.nw-saved-row');
    return {
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || '',
    };
  });
  requireCondition(
    persistedMortgage.meta.includes('Property 1')
      && persistedMortgage.value === '$120,001',
    `Mortgage link/value changed after reload: ${JSON.stringify(persistedMortgage)}`,
  );

  await openNetWorthCategory(page, 'bank');
  await clickWizardAction(
    page,
    `[data-hh-action="net-worth-remove-entry"][data-entry-source="account"][data-account-id="${account.id}"]`,
  );
  requireCondition(
    await countMatches(
      page,
      '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
    ) === 0,
    'Net Worth account removal did not target the stable account ID',
  );
  await clickWizardAction(
    page,
    '[data-net-worth-overlay] .nw-panel-close',
  );
}

async function verifyIncomeAndGoalsFlow(page){
  const before = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const plan = db?.[active];
    return {
      current1040: JSON.stringify(plan?.incomeTax?.current1040 ?? null),
      income: JSON.stringify(plan?.income ?? null),
    };
  });

  await goToWizardStep(page, 'income');
  const initial = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-income-source-row]')].map(row => ({
      id: row.dataset.incomeSourceRow,
      amount: row.querySelector('[data-wizard-field="source.amount"]')?.value || '',
    })),
    typeOptions: [...(document.querySelector(
      '[data-income-source-row] [data-wizard-field="source.typeId"]',
    )?.options || [])].map(option => option.value),
    taxablePctFields: document.querySelectorAll(
      '[data-income-source-row] [data-wizard-field="source.taxablePct"]',
    ).length,
    qualifiedPctFields: document.querySelectorAll(
      '[data-income-source-row] [data-wizard-field="source.qualifiedPct"]',
    ).length,
    fullTaxTreatments: [...document.querySelectorAll(
      '[data-income-source-row] [data-income-tax-treatment="fully-taxable"] strong',
    )].map(element => element.textContent.trim()),
    socialSecurity: document.querySelectorAll(
      '[data-hh-wizard-screen="income"] [data-wizard-field^="socialSecurity."]',
    ).length,
    currentTaxFields: document.querySelectorAll(
      '[data-hh-wizard-screen="income"] [data-tax-field]',
    ).length,
  }));
  requireCondition(
    JSON.stringify(initial.rows) === JSON.stringify([
      { id: 'verify_wage_one', amount: '50,000' },
      { id: 'verify_wage_two', amount: '25,000' },
    ])
      && JSON.stringify(initial.typeOptions) === JSON.stringify([
        'wages', 'bonus', 'self_employment', 'annuity', 'rental',
        'interest', 'dividends', 'deferred_comp', 'other',
      ])
      && initial.taxablePctFields === 0
      && initial.qualifiedPctFields === 0
      && initial.fullTaxTreatments.length === 2
      && initial.fullTaxTreatments.every(value => value === '100% taxable')
      && initial.socialSecurity === 4
      && initial.currentTaxFields === 0,
    `Income did not expose the existing planning record cleanly: ${JSON.stringify(initial)}`,
  );

  await setWizardValue(
    page,
    '[data-wizard-field="socialSecurity.primary.pia"]',
    '32000',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="socialSecurity.primary.claimAge"]',
    '67',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="socialSecurity.spouse.pia"]',
    '22000',
  );
  await setWizardValue(
    page,
    '[data-wizard-field="socialSecurity.spouse.claimAge"]',
    '69',
  );
  await setWizardValue(
    page,
    '[data-income-row-id="verify_wage_one"][data-wizard-field="source.amount"]',
    '52000',
  );
  await setWizardValue(
    page,
    '[data-income-row-id="verify_wage_two"][data-wizard-field="source.owner"]',
    'spouse',
  );
  await setWizardValue(
    page,
    '[data-income-row-id="verify_wage_two"][data-wizard-field="source.amount"]',
    '26000',
  );
  await clickWizardAction(page, '[data-hh-action="add-income-source"]');
  const rentalId = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-income-source-row]')];
    return rows.find(row => !['verify_wage_one', 'verify_wage_two']
      .includes(row.dataset.incomeSourceRow))?.dataset.incomeSourceRow || '';
  });
  requireCondition(Boolean(rentalId), 'Add income did not create one stable row ID');
  const rentalField = field => `[data-income-row-id="${rentalId}"][data-wizard-field="source.${field}"]`;
  await setWizardValue(page, rentalField('typeId'), 'rental');
  await setWizardValue(page, rentalField('label'), 'Rental income');
  await setWizardValue(page, rentalField('owner'), 'joint');
  await setWizardValue(page, rentalField('amount'), '12000');
  await setWizardValue(page, rentalField('startAge'), '67');
  await setWizardValue(page, rentalField('endAge'), '90');
  await setWizardValue(page, rentalField('realGrowth'), '1');
  const rentalTaxTreatment = await page.evaluate(rowId => ({
    taxablePctFields: document.querySelectorAll(
      `[data-income-row-id="${rowId}"][data-wizard-field="source.taxablePct"]`,
    ).length,
    qualifiedPctFields: document.querySelectorAll(
      `[data-income-row-id="${rowId}"][data-wizard-field="source.qualifiedPct"]`,
    ).length,
    readout: document.querySelector(
      `[data-income-source-row="${rowId}"] [data-income-tax-treatment="fully-taxable"] strong`,
    )?.textContent.trim() || '',
  }), rentalId);
  requireCondition(
    rentalTaxTreatment.taxablePctFields === 0
      && rentalTaxTreatment.qualifiedPctFields === 0
      && rentalTaxTreatment.readout === '100% taxable',
    `Rental income exposed an inapplicable tax override: ${JSON.stringify(rentalTaxTreatment)}`,
  );
  await setWizardValue(page, '[data-wizard-field="pension.base"]', '24000');
  await setWizardValue(page, '[data-wizard-field="pension.startAge"]', '65');
  await setWizardValue(page, '[data-wizard-field="pension.colaPct"]', '2');
  await setWizardValue(page, '[data-wizard-field="savings.annual"]', '15000');
  await setWizardValue(page, '[data-wizard-field="savings.split.traditional"]', '60');
  await setWizardValue(page, '[data-wizard-field="savings.split.roth"]', '20');
  await setWizardValue(page, '[data-wizard-field="savings.split.taxable"]', '20');
  await setWizardValue(page, '[data-wizard-field="savings.split.byOwner.client"]', '55');
  await setWizardValue(page, '[data-wizard-field="savings.split.byOwner.spouse"]', '45');

  const incomeResult = await page.evaluate(expectedRentalId => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const plan = db?.[active];
    return {
      current1040: JSON.stringify(plan?.incomeTax?.current1040 ?? null),
      rows: (plan?.income?.other || []).map(row => ({
        id: row.id,
        typeId: row.typeId,
        owner: row.owner,
        amount: row.amount,
        startAge: row.startAge,
        endAge: row.endAge,
        taxablePct: row.taxablePct,
      })),
      rentalId: expectedRentalId,
      socialSecurity: plan?.income?.socialSecurity,
      pension: plan?.income?.pension,
      savings: plan?.savings,
    };
  }, rentalId);
  requireCondition(
    incomeResult.current1040 === before.current1040,
    'Income edits changed current-year Form 1040 bytes',
  );
  requireCondition(
    JSON.stringify(incomeResult.rows) === JSON.stringify([
      {
        id: 'verify_wage_one', typeId: 'wages', owner: 'client', amount: 52000,
        startAge: 0, endAge: 999, taxablePct: 1,
      },
      {
        id: 'verify_wage_two', typeId: 'wages', owner: 'spouse', amount: 26000,
        startAge: 0, endAge: 999, taxablePct: 1,
      },
      {
        id: rentalId, typeId: 'rental', owner: 'joint', amount: 12000,
        startAge: 67, endAge: 90, taxablePct: 1,
      },
    ])
      && incomeResult.socialSecurity?.primary?.pia === 32000
      && incomeResult.socialSecurity?.primary?.claimAge === 67
      && incomeResult.socialSecurity?.spouse?.pia === 22000
      && incomeResult.socialSecurity?.spouse?.claimAge === 69
      && incomeResult.pension?.base === 24000
      && incomeResult.pension?.startAge === 65
      && incomeResult.pension?.colaPct === 2
      && incomeResult.savings?.annual === 15000
      && incomeResult.savings?.split?.traditional === 0.6
      && incomeResult.savings?.split?.roth === 0.2
      && incomeResult.savings?.split?.taxable === 0.2
      && incomeResult.savings?.split?.byOwner?.client === 0.55
      && incomeResult.savings?.split?.byOwner?.spouse === 0.45,
    `Income edits did not reach the canonical planning record: ${JSON.stringify(incomeResult)}`,
  );

  await reloadWizard(page);
  await goToWizardStep(page, 'income');
  const reloadedIncome = await page.evaluate(expectedRentalId => ({
    primaryPia: document.querySelector(
      '[data-wizard-field="socialSecurity.primary.pia"]',
    )?.value || '',
    spousePia: document.querySelector(
      '[data-wizard-field="socialSecurity.spouse.pia"]',
    )?.value || '',
    rentalAmount: document.querySelector(
      `[data-income-row-id="${expectedRentalId}"][data-wizard-field="source.amount"]`,
    )?.value || '',
  }), rentalId);
  requireCondition(
    reloadedIncome.primaryPia === '32,000'
      && reloadedIncome.spousePia === '22,000'
      && reloadedIncome.rentalAmount === '12,000',
    `Visible Income values did not survive reload: ${JSON.stringify(reloadedIncome)}`,
  );

  await goToWizardStep(page, 'goals');
  const goalBefore = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const goal = db?.[active]?.goals?.[0];
    return { id: goal?.id || '', amount: goal?.amount };
  });
  requireCondition(Boolean(goalBefore.id), 'Goals step has no canonical goal to edit');
  const intakeGoalChip = `[data-hh-wizard-screen="goals"] [data-goal-chip="${goalBefore.id}"]`;
  await requireUnique(page, intakeGoalChip, 'canonical Intake goal chip');
  await page.click(intakeGoalChip);
  await clickWizardAction(
    page,
    `[data-hh-wizard-screen="goals"] [data-goal-rail="${goalBefore.id}"] [data-action="amount-plus"]`,
    { expectRevision: false },
  );
  const goalAfter = await page.evaluate(goalId => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const goals = db?.[active]?.goals || [];
    const matches = goals.filter(goal => goal?.id === goalId);
    return {
      matches: matches.length,
      amount: matches[0]?.amount,
      totalGoals: goals.length,
    };
  }, goalBefore.id);
  requireCondition(
    goalAfter.matches === 1
      && goalAfter.totalGoals > 0
      && Number(goalAfter.amount) > Number(goalBefore.amount),
    `Goals edit did not mutate the one canonical goal: ${JSON.stringify({ goalBefore, goalAfter })}`,
  );

  await goToWizardStep(page, 'summary');
  const summary = await page.evaluate(({ incomeId, goalId }) => ({
    incomeRows: document.querySelectorAll(
      `[data-summary-income-source="${incomeId}"]`,
    ).length,
    goalRows: document.querySelectorAll(`[data-summary-goal="${goalId}"]`).length,
    pensionRows: document.querySelectorAll('[data-summary-pension]').length,
    annualSavingsRows: document.querySelectorAll(
      '[data-summary-savings="annual"]',
    ).length,
    savingsMixRows: document.querySelectorAll(
      '[data-summary-savings="mix"]',
    ).length,
    incomeText: document.querySelector('[data-summary-source="income"]')?.textContent || '',
    goalText: document.querySelector(`[data-summary-goal="${goalId}"]`)?.textContent || '',
  }), { incomeId: rentalId, goalId: goalBefore.id });
  requireCondition(
    summary.incomeRows === 1
      && summary.goalRows === 1
      && summary.pensionRows === 1
      && summary.annualSavingsRows === 1
      && summary.savingsMixRows === 1
      && /Rental income/.test(summary.incomeText)
      && /Client Social Security/.test(summary.incomeText)
      && /Pension[\s\S]*\$24,000 at 65/.test(summary.incomeText)
      && /Annual savings[\s\S]*\$15,000/.test(summary.incomeText)
      && /60% traditional · 20% Roth · 20% taxable/.test(summary.incomeText)
      && /\$/.test(summary.goalText)
      && /retirement/.test(summary.goalText),
    `Summary did not consume the canonical Income and Goals rows once: ${JSON.stringify(summary)}`,
  );
}

async function verifyPlanningSourceAndTaxFlow(page){
  const planningIncomeBeforeTax = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return JSON.stringify(db?.[active]?.income ?? null);
  });
  await goToWizardStep(page, 'tax');
  // The earlier co-client-removal flow intentionally leaves the surviving
  // client's current-return wage in Tax. Income now holds a different planning
  // wage, so the two visible values prove that neither authority is borrowing
  // the other's record.
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
    initialWages.client === '81000'
      && initialWages.spouse === ''
      && !initialWages.clientDisabled
      && !initialWages.spouseDisabled
      && initialWages.sourceButtons === 0,
    `Tax did not preserve its separate current-return wage facts: ${JSON.stringify(initialWages)}`,
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
      filingFields: rows.map(row => row.querySelector(
        '[data-tax-field$=".filingStatus"]',
      )?.dataset.taxField || ''),
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
      && JSON.stringify(irmaaInputs.filingFields) === JSON.stringify([
        'irmaa.lookback.2024.filingStatus',
        'irmaa.lookback.2025.filingStatus',
      ])
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
    persistedIrmaaInput === '218000',
    `IRMAA lookback MAGI did not survive the production edit path: "${persistedIrmaaInput}"`,
  );
  await reloadWizard(page);
  await goToWizardStep(page, 'tax');
  const reloadedIrmaaInput = await page.$eval(
    '[data-tax-field="irmaa.lookback.2024.magi"]',
    control => control.value,
  );
  requireCondition(
    reloadedIrmaaInput === '218000',
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
      income: document.querySelector('[data-summary-metric="income"]')
        ?.dataset.summaryIncomeStatus || '',
      tax: document.querySelector('[data-summary-metric="federal-tax"]')
        ?.dataset.summaryTaxStatus || '',
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
    derivedSummary.income === 'ready' && derivedSummary.tax === 'ready',
    `Derived Tax summary did not calculate: ${JSON.stringify(derivedSummary)}`,
  );
  requireCondition(
    derivedSummary.tableCount === 1
      && JSON.stringify(derivedSummary.headers) === JSON.stringify(['Item', 'Value'])
      && JSON.stringify(derivedSummary.rows.map(row => row[0])) === JSON.stringify([
        'Program',
        'MAGI',
        'Current tier',
        'Next tier',
        'To next tier',
        'Premium year',
      ])
      && derivedSummary.rows[0]?.[1] === 'IRMAA'
      && /^\$[\d,]+$/.test(derivedSummary.rows[1]?.[1] || '')
      && /^\d+$/.test(derivedSummary.rows[2]?.[1] || '')
      && /^(\d+|—)$/.test(derivedSummary.rows[3]?.[1] || '')
      && /^(\$[\d,]+|—)$/.test(derivedSummary.rows[4]?.[1] || '')
      && derivedSummary.rows[5]?.[1] === '2028'
      && derivedSummary.width >= 190
      && derivedSummary.width <= 300
      && derivedSummary.directScreenChild
      && derivedSummary.captionCount === 0,
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
  const sourceSeparation = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const plan = db?.[active];
    return {
      planningIncome: JSON.stringify(plan?.income ?? null),
      wagesByOwner: plan?.incomeTax?.current1040?.wagesByOwner,
      aggregateWages: plan?.incomeTax?.current1040?.income?.wages,
    };
  });
  requireCondition(
    sourceSeparation.planningIncome === planningIncomeBeforeTax
      && sourceSeparation.wagesByOwner?.client === 81000
      && sourceSeparation.wagesByOwner?.spouse === 39000
      && sourceSeparation.aggregateWages === 120000,
    `Tax current-year wages crossed into planning income: ${JSON.stringify(sourceSeparation)}`,
  );

  await clickWizardAction(
    page,
    '[data-hh-action="set-tax-view"][data-tax-view="detailed"]',
  );
  const detailed = await page.evaluate(() => ({
    view: document.querySelector('[data-hh-wizard-screen="tax"]')
      ?.dataset.taxView || '',
    clientWages: document.querySelector('[data-tax-field="income.wages.client"]')?.value || '',
    spouseWages: document.querySelector('[data-tax-field="income.wages.spouse"]')?.value || '',
    pressed: document.querySelector(
      '[data-hh-action="set-tax-view"][data-tax-view="detailed"]',
    )?.getAttribute('aria-pressed') || '',
  }));
  requireCondition(
    detailed.view === 'detailed'
      && detailed.clientWages === '81000'
      && detailed.spouseWages === '39000'
      && detailed.pressed === 'true',
    `Detailed Tax view lost state: ${JSON.stringify(detailed)}`,
  );
  await clickWizardAction(
    page,
    '[data-hh-action="set-tax-view"][data-tax-view="simplified"]',
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
    income: document.querySelector('[data-summary-metric="income"]')
      ?.dataset.summaryIncomeStatus || '',
    tax: document.querySelector('[data-summary-metric="federal-tax"]')
      ?.dataset.summaryTaxStatus || '',
    scope: document.querySelector('[data-summary-metric="federal-tax"]')
      ?.dataset.summaryTaxScope || '',
  }));
  requireCondition(
    afterSummary.income === 'ready'
      && afterSummary.tax === 'ready'
      && afterSummary.scope === 'FULL_1040',
    `Completed Tax facts did not reach Summary: ${JSON.stringify(afterSummary)}`,
  );
  await requireUnique(
    page,
    summaryContinueSelector,
    'completed Summary Enter planning action',
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
  await requireUnique(page, '[data-goals-toggle]', 'Scenarios goals toggle');
  await page.waitForFunction(() => {
    const toggle = document.querySelector('[data-goals-toggle]');
    if(!toggle) return false;
    if(toggle.getAttribute('aria-expanded') !== 'true'){
      toggle.click();
      return false;
    }
    return Boolean(document.querySelector(
      '.cmp-goal-in[data-goal-idx="0"][data-goal-field="amount"]',
    ));
  }, { polling: 100, timeout: 8000 });
  const scenarioGoal = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const goal = db?.[active]?.goals?.[0];
    const values = [...document.querySelectorAll(
      '.cmp-goal-in[data-goal-idx="0"][data-goal-field="amount"]',
    )].map(input => Number(String(input.value).replace(/[^0-9.-]/g, '')));
    return { amount: goal?.amount, values };
  });
  requireCondition(
    scenarioGoal.values.length > 0
      && scenarioGoal.values.every(value => value === scenarioGoal.amount),
    `Scenarios did not consume the canonical Goals amount once per plan: ${JSON.stringify(scenarioGoal)}`,
  );
}

async function waitForCanonicalIntakeSave(page){
  const saveCount = await page.$$eval('#save-btn', elements => elements.length);
  requireCondition(saveCount === 0, 'Manual Save control still rendered');
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    const rows = (saved?.income?.other || []).map(row => ({
      typeId: row.typeId,
      owner: row.owner,
      amount: row.amount,
    }));
    return JSON.stringify(rows) === JSON.stringify([
      { typeId: 'wages', owner: 'client', amount: 52000 },
      { typeId: 'wages', owner: 'spouse', amount: 26000 },
      { typeId: 'rental', owner: 'joint', amount: 12000 },
    ])
      && saved?.incomeTax?.current1040?.wagesByOwner?.client === 81000
      && saved?.incomeTax?.current1040?.wagesByOwner?.spouse === 39000
      && saved?.incomeTax?.current1040?.income?.wages === 120000;
  }, { timeout: 10000 });
}

async function verifyCanonicalIntakeReload(page){
  await waitForCanonicalIntakeSave(page);
  await reloadWizard(page);
  await goToWizardStep(page, 'income');
  const savedIntake = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    const rows = (saved?.income?.other || []).map(row => ({
      typeId: row.typeId,
      owner: row.owner,
      amount: row.amount,
    }));
    const rental = (saved?.income?.other || []).find(row => row?.typeId === 'rental');
    return {
      primaryPia: document.querySelector(
        '[data-wizard-field="socialSecurity.primary.pia"]',
      )?.value || '',
      spousePia: document.querySelector(
        '[data-wizard-field="socialSecurity.spouse.pia"]',
      )?.value || '',
      rentalAmount: rental?.id
        ? document.querySelector(
          `[data-income-row-id="${rental.id}"][data-wizard-field="source.amount"]`,
        )?.value || ''
        : '',
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
      currentWages: saved?.incomeTax?.current1040?.wagesByOwner,
      aggregateWages: saved?.incomeTax?.current1040?.income?.wages,
      savingsAnnual: saved?.savings?.annual,
      pensionBase: saved?.income?.pension?.base,
      goals: saved?.goals?.length || 0,
    };
  });
  requireCondition(
    savedIntake.primaryPia === '32,000'
      && savedIntake.spousePia === '22,000'
      && savedIntake.rentalAmount === '12,000',
    `Reload lost visible Income values: ${JSON.stringify(savedIntake)}`,
  );
  requireCondition(
    JSON.stringify(savedIntake.rows) === JSON.stringify([
      { typeId: 'wages', owner: 'client', amount: 52000 },
      { typeId: 'wages', owner: 'spouse', amount: 26000 },
      { typeId: 'rental', owner: 'joint', amount: 12000 },
    ])
      && JSON.stringify(savedIntake.peopleFacts) === JSON.stringify({
        client: {
          retirementAge: 68,
          socialSecurityAge: 67,
          socialSecurityBenefit: 32000,
          planEndAge: 102,
        },
        spouse: {
          retirementAge: 70,
          socialSecurityAge: 69,
          socialSecurityBenefit: 22000,
          planEndAge: 101,
        },
      })
      && savedIntake.currentWages?.client === 81000
      && savedIntake.currentWages?.spouse === 39000
      && savedIntake.aggregateWages === 120000
      && savedIntake.savingsAnnual === 15000
      && savedIntake.pensionBase === 24000
      && savedIntake.goals > 0,
    `Reload crossed or dropped canonical Intake sources: ${JSON.stringify(savedIntake)}`,
  );

  await goToWizardStep(page, 'tax');
  const currentTaxWages = await page.evaluate(() => ({
    client: document.querySelector('[data-tax-field="income.wages.client"]')?.value || '',
    spouse: document.querySelector('[data-tax-field="income.wages.spouse"]')?.value || '',
    planningFields: document.querySelectorAll(
      '[data-hh-wizard-screen="tax"] [data-wizard-scope="income"]',
    ).length,
  }));
  requireCondition(
    currentTaxWages.client === '81000'
      && currentTaxWages.spouse === '39000'
      && currentTaxWages.planningFields === 0,
    `Tax reload did not remain current-return-only: ${JSON.stringify(currentTaxWages)}`,
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
      && repaired.version === 1,
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
      '.nw-rail-actions, .nw-mobile-footer, .nw-summary-footer',
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
    const familyControls = [...document.querySelectorAll(
      '[data-hh-field="client.status"],'
      + '[data-hh-field="client.retirementAge"],'
      + '[data-hh-field="client.planEndAge"],'
      + '[data-hh-field="spouse.status"],'
      + '[data-hh-field="spouse.retirementAge"],'
      + '[data-hh-field="spouse.planEndAge"]',
    )];
    const goalsHorizon = document.querySelector('.hh-goals-horizon');
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
      familyControlsWithinViewport: familyControls.every(control => {
        const controlRect = control.getBoundingClientRect();
        return controlRect.left >= -1
          && controlRect.right <= document.documentElement.clientWidth + 1;
      }),
      goalsHorizonAccessible: !goalsHorizon
        || goalsHorizon.scrollWidth <= goalsHorizon.clientWidth + 1
        || ['auto', 'scroll'].includes(getComputedStyle(goalsHorizon).overflowX),
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
      && metrics.familyControlsWithinViewport
      && metrics.goalsHorizonAccessible
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
    if(step === 'tax'){
      await clickWizardAction(
        page,
        '[data-hh-action="set-tax-view"][data-tax-view="detailed"]',
      );
      await settleWizardCapture(page);
      const detailedPath = join(outDir, `${prefix}-${step}-detailed.png`);
      await captureFullWizardArtifact(page, detailedPath);
      artifacts.push({
        label: 'tax · detailed',
        path: detailedPath,
        step,
        viewport: 'desktop',
      });
      await clickWizardAction(
        page,
        '[data-hh-action="set-tax-view"][data-tax-view="simplified"]',
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
    await prepareContractFixture(page);
    await assertSixStepStructure(page);
    await verifyFamilyPropagation(page);
    await verifyNetWorthFlow(page);
    await verifyIncomeAndGoalsFlow(page);
    await verifyPlanningSourceAndTaxFlow(page);
    await verifyCanonicalIntakeReload(page);
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
            `Wizard contract failed: ${failure.message}. Restoration diagnostics failed: ${error.message}`,
          )
        : error;
    }
    diagnostics.dispose();
  }
  if(failure) throw failure;
}

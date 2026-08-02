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
  const before = await wizardState(page);
  if(before.step === step) return before;
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
  await page.click(selector);
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
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(snapshot || {}).sort(([left], [right]) =>
        left.localeCompare(right)),
    ),
  );
}

async function reloadWizard(page){
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  return waitForWizard(page);
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
    structure.logo.src === 'assets/parallax-logo.png'
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

  await goToWizardStep(page, 'net-worth');
  await clickWizardAction(page, '[data-hh-action="add-account"]');
  await setWizardValue(
    page,
    '[data-account-draft="displayName"]',
    'Co-client Roth',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-account-draft="typeId"]',
    'roth_ira',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-account-draft="owner"]',
    'spouse',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-account-draft="balance"]',
    '1000',
    { expectRevision: false, eventType: 'input' },
  );
  await clickWizardAction(page, '[data-hh-action="save-account"]');
  const spouseAccountId = await page.$eval(
    '.hh-account-row',
    row => row.dataset.accountId,
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

  await goToWizardStep(page, 'net-worth');
  await clickWizardAction(
    page,
    `[data-hh-action="remove-account"][data-account-id="${spouseAccountId}"]`,
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
  await saveAndWait(page);
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
  await goToWizardStep(page, 'tax');
  const filing = await page.evaluate(() =>
    document.querySelector('.hh-tax-static strong')?.textContent.trim() || '');
  requireCondition(
    filing === 'Married filing jointly',
    `Family filing status did not reach Tax: "${filing}"`,
  );
}

async function verifyAccountFlow(page){
  await goToWizardStep(page, 'net-worth');
  await clickWizardAction(page, '[data-hh-action="add-account"]', {
    expectRevision: true,
  });
  await setWizardValue(
    page,
    '[data-account-draft="displayName"]',
    'Verifier brokerage',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-account-draft="typeId"]',
    'brokerage_taxable',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-account-draft="owner"]',
    'client',
    { expectRevision: false, eventType: 'input' },
  );
  await setWizardValue(
    page,
    '[data-account-draft="balance"]',
    '250000',
    { expectRevision: false, eventType: 'input' },
  );
  await clickWizardAction(page, '[data-hh-action="save-account"]');
  const account = await page.evaluate(() => {
    const row = document.querySelector('.hh-account-row');
    return {
      id: row?.dataset.accountId || '',
      treatment: row?.querySelector('[data-derived-treatment]')?.textContent.trim() || '',
      balance: row?.querySelector('[data-account-field="balance"]')?.value || '',
      count: document.querySelectorAll('.hh-account-row').length,
    };
  });
  requireCondition(
    account.count === 1
      && account.id
      && account.treatment === 'Taxable'
      && account.balance === '250000',
    `Account add/derived treatment failed: ${JSON.stringify(account)}`,
  );
  await setWizardValue(
    page,
    `[data-account-id="${account.id}"][data-account-field="typeId"]`,
    'traditional_ira',
  );
  const changedTreatment = await page.evaluate(id =>
    document.querySelector(`[data-derived-treatment="${id}"]`)
      ?.textContent.trim() || '', account.id);
  requireCondition(
    changedTreatment === 'Tax-deferred',
    `Account type did not derive treatment: "${changedTreatment}"`,
  );
  await clickWizardAction(
    page,
    `[data-hh-action="remove-account"][data-account-id="${account.id}"]`,
  );
  requireCondition(
    await countMatches(page, '.hh-account-row') === 0,
    'Account removal did not target the stable account ID',
  );
}

async function verifyPlanningSourceAndTaxFlow(page){
  await goToWizardStep(page, 'tax');
  const initialSource = await page.evaluate(() => {
    const row = document.querySelector('[data-income-source-group="wages"]');
    const input = row?.querySelector('[data-tax-field="income.wages"]');
    return {
      text: row?.textContent || '',
      value: input?.value || '',
      disabled: input?.disabled === true,
      overrideButtons: row?.querySelectorAll(
        '[data-hh-action="override-income-group"]',
      ).length || 0,
    };
  });
  requireCondition(
    initialSource.disabled
      && initialSource.value === '75000'
      && initialSource.overrideButtons === 1
      && /From planning income/.test(initialSource.text),
    `Planning-income source was not authoritative: ${JSON.stringify(initialSource)}`,
  );

  await goToWizardStep(page, 'summary');
  const derivedSummary = await page.evaluate(() => ({
    income: document.querySelector('[data-summary-metric="income"]')
      ?.dataset.summaryIncomeStatus || '',
    tax: document.querySelector('[data-summary-metric="federal-tax"]')
      ?.dataset.summaryTaxStatus || '',
  }));
  requireCondition(
    derivedSummary.income === 'ready' && derivedSummary.tax === 'ready',
    `Derived Tax summary did not calculate: ${JSON.stringify(derivedSummary)}`,
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

  await clickWizardAction(
    page,
    '[data-hh-action="override-income-group"][data-income-group="wages"]',
  );
  await setWizardValue(page, '[data-tax-field="income.wages"]', '81000');
  const override = await page.evaluate(() => {
    const row = document.querySelector('[data-income-source-group="wages"]');
    const input = row?.querySelector('[data-tax-field="income.wages"]');
    return {
      text: row?.textContent || '',
      value: input?.value || '',
      disabled: input?.disabled === true,
    };
  });
  requireCondition(
    !override.disabled
      && override.value === '81000'
      && /Current-year amount/.test(override.text),
    `Current-year override was not explicit: ${JSON.stringify(override)}`,
  );

  await clickWizardAction(
    page,
    '[data-hh-action="set-tax-view"][data-tax-view="detailed"]',
  );
  const detailed = await page.evaluate(() => ({
    view: document.querySelector('[data-hh-wizard-screen="tax"]')
      ?.dataset.taxView || '',
    wages: document.querySelector('[data-tax-field="income.wages"]')?.value || '',
    pressed: document.querySelector(
      '[data-hh-action="set-tax-view"][data-tax-view="detailed"]',
    )?.getAttribute('aria-pressed') || '',
  }));
  requireCondition(
    detailed.view === 'detailed'
      && detailed.wages === '81000'
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
}

async function saveAndWait(page){
  await requireUnique(page, '#save-btn', 'Save button');
  const disabled = await page.$eval('#save-btn', button => button.disabled);
  requireCondition(!disabled, 'Save was not armed after wizard edits');
  await page.click('#save-btn');
  await page.waitForFunction(() => {
    const button = document.querySelector('#save-btn');
    return button?.disabled === true && /^Saved/.test(button.textContent.trim());
  }, { timeout: 8000 });
}

async function verifySaveReloadAndOverride(page){
  await saveAndWait(page);
  await reloadWizard(page);
  await goToWizardStep(page, 'tax');
  const savedOverride = await page.evaluate(() => {
    const row = document.querySelector('[data-income-source-group="wages"]');
    return {
      value: row?.querySelector('[data-tax-field="income.wages"]')?.value || '',
      disabled: row?.querySelector('[data-tax-field="income.wages"]')
        ?.disabled === true,
      revert: row?.querySelectorAll(
        '[data-hh-action="revert-income-group"]',
      ).length || 0,
    };
  });
  requireCondition(
    savedOverride.value === '81000'
      && !savedOverride.disabled
      && savedOverride.revert === 1,
    `Save/reload lost Tax override: ${JSON.stringify(savedOverride)}`,
  );

  await clickWizardAction(
    page,
    '[data-hh-action="revert-income-group"][data-income-group="wages"]',
  );
  const reverted = await page.evaluate(() => {
    const row = document.querySelector('[data-income-source-group="wages"]');
    return {
      value: row?.querySelector('[data-tax-field="income.wages"]')?.value || '',
      disabled: row?.querySelector('[data-tax-field="income.wages"]')
        ?.disabled === true,
    };
  });
  requireCondition(
    reverted.value === '75000' && reverted.disabled,
    `Planning-income revert failed: ${JSON.stringify(reverted)}`,
  );
  await saveAndWait(page);
  await reloadWizard(page);
  await goToWizardStep(page, 'tax');
  const persistedRevert = await page.evaluate(() => {
    const row = document.querySelector('[data-income-source-group="wages"]');
    return {
      value: row?.querySelector('[data-tax-field="income.wages"]')?.value || '',
      disabled: row?.querySelector('[data-tax-field="income.wages"]')
        ?.disabled === true,
      override: row?.querySelectorAll(
        '[data-hh-action="override-income-group"]',
      ).length || 0,
    };
  });
  requireCondition(
    persistedRevert.value === '75000'
      && persistedRevert.disabled
      && persistedRevert.override === 1,
    `Save/reload lost planning-income revert: ${JSON.stringify(persistedRevert)}`,
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
    const footer = document.querySelector('[data-hh-wizard-footer]');
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
      footerVisible: rendered(footer, footerRect),
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
      && metrics.footerVisible
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
      await clickWizardAction(page, '[data-hh-action="add-account"]');
      await settleWizardCapture(page);
      const addAccountPath = join(outDir, `${prefix}-${step}-add-account.png`);
      await captureFullWizardArtifact(page, addAccountPath);
      artifacts.push({
        label: 'net worth · add account',
        path: addAccountPath,
        step,
        viewport: 'desktop',
      });
      await clickWizardAction(page, '[data-hh-action="cancel-account"]');
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
    await assertFourStepStructure(page);
    await verifyFamilyPropagation(page);
    await verifyAccountFlow(page);
    await verifyPlanningSourceAndTaxFlow(page);
    await verifySaveReloadAndOverride(page);
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

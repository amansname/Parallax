// Wizard browser contract: startup.
import { requireCondition, requireUnique } from './assertions.mjs';
import { waitForWizard, openWizard, goToWizardStep, clickWizardAction, reloadWizard, selectHouseholdVisible } from './actions.mjs';
const STALE_COPY_MIGRATION_RECORDS = Object.freeze([{
  id: 'hh_browser_stale_new',
  label: 'New Household'
}, {
  id: 'hh_browser_stale_demo',
  label: 'Demo Household copy'
}, {
  id: 'hh_browser_stale_couple',
  label: 'Pre-Retirement Couple copy'
}]);
const MIGRATION_SURVIVOR = Object.freeze({
  id: 'hh_browser_migration_survivor',
  label: 'Advisor Migration Survivor'
});
export async function seedStaleCopyMigrationFixture(page) {
  return page.evaluate(({
    staleRecords,
    survivor
  }) => {
    const databaseKey = 'parallax.households.v1';
    const database = JSON.parse(localStorage.getItem(databaseKey) || 'null');
    const source = database?.['now-household'];
    if (!source) throw new Error('Now Household is unavailable for stale-copy migration setup');
    const createCustomRecord = ({
      id,
      label
    }) => {
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
    for (const staleRecord of staleRecords) {
      database[staleRecord.id] = createCustomRecord(staleRecord);
    }
    const staleRecordBytes = Object.fromEntries(staleRecords.map(({
      id
    }) => [id, JSON.stringify(database[id])]));
    localStorage.setItem(databaseKey, JSON.stringify(database));
    localStorage.setItem('parallax.activeHouseholdId', staleRecords[0].id);
    return staleRecordBytes;
  }, {
    staleRecords: STALE_COPY_MIGRATION_RECORDS,
    survivor: MIGRATION_SURVIVOR
  });
}
export async function verifyBlankStartupAndNowSelection(page, expectedNameOnlyBytes) {
  await openWizard(page);
  const startup = await page.evaluate(staleRecordIds => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const options = [...document.querySelectorAll('#hh-switch option')].map(option => ({
      value: option.value,
      label: option.textContent.trim(),
      disabled: option.disabled
    }));
    const customIds = Object.keys(db || {}).filter(id => !['now-household', 'future-household', 'demo', 'default-pre-retirement-solo', 'default-pre-retirement-couple'].includes(id));
    return {
      active: localStorage.getItem('parallax.activeHouseholdId'),
      dbIds: Object.keys(db || {}),
      options,
      customIds,
      staleRecordBytes: Object.fromEntries(staleRecordIds.map(id => [id, JSON.stringify(db?.[id] ?? null)])),
      selected: document.querySelector('#hh-switch')?.value || '',
      railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
      menuHidden: document.querySelector('#hh-menu-pop')?.hidden,
      menuButtonHidden: document.querySelector('#hh-menu-btn')?.hidden,
      progressHidden: document.querySelector('.hh-progress')?.hidden,
      stepperHidden: document.querySelector('.hh-stepper')?.hidden,
      footerHidden: document.querySelector('#hh-wiz-footer')?.hidden,
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
      enabledFields: document.querySelectorAll('#hh-view input:not(:disabled), #hh-view select:not(:disabled), #hh-view textarea:not(:disabled)').length,
      nowScenarioBytes: localStorage.getItem('parallax.scenarios.now-household.v1'),
      futureScenarioBytes: localStorage.getItem('parallax.scenarios.future-household.v1'),
      plannerHouseholdId: document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId || '',
      plannerResultCode: document.querySelector('[data-taw-root]')?.dataset.tawResultCode || '',
      plannerEnabledControls: document.querySelectorAll('.taw-range:not(:disabled)').length,
      plannerFederalTax: document.querySelector('[data-taw-federal-tax]')?.textContent.trim() || ''
    };
  }, STALE_COPY_MIGRATION_RECORDS.map(({
    id
  }) => id));
  const expectedBuiltIns = [{
    value: 'now-household',
    label: 'Now Household'
  }, {
    value: 'future-household',
    label: 'Future Household'
  }];
  const visibleBuiltIns = startup.options.filter(option => ['now-household', 'future-household'].includes(option.value)).map(({
    value,
    label
  }) => ({
    value,
    label
  }));
  const optionIds = startup.options.slice(1).map(option => option.value);
  const nameOnlyRecordsSurvived = STALE_COPY_MIGRATION_RECORDS.every(record => startup.dbIds.includes(record.id) && startup.staleRecordBytes[record.id] === expectedNameOnlyBytes[record.id] && startup.options.filter(option => option.value === record.id && option.label === record.label).length === 1);
  const survivorOption = startup.options.find(option => option.value === MIGRATION_SURVIVOR.id);
  requireCondition(startup.active === null && startup.selected === '' && startup.railName === '' && startup.options[0]?.value === '' && startup.options[0]?.disabled === true && JSON.stringify(visibleBuiltIns) === JSON.stringify(expectedBuiltIns) && JSON.stringify(optionIds) === JSON.stringify(startup.dbIds) && startup.customIds.every(id => optionIds.includes(id)) && survivorOption?.label === MIGRATION_SURVIVOR.label && startup.dbIds.includes(MIGRATION_SURVIVOR.id) && nameOnlyRecordsSurvived && !optionIds.some(id => ['demo', 'default-pre-retirement-solo', 'default-pre-retirement-couple'].includes(id)) && startup.menuHidden === false && startup.menuButtonHidden === true && startup.progressHidden === true && startup.stepperHidden === true && startup.footerHidden === true && startup.screenCount === 0 && startup.enabledFields === 0 && startup.nowScenarioBytes === null && startup.futureScenarioBytes === null && startup.plannerHouseholdId === '' && startup.plannerResultCode === '' && startup.plannerEnabledControls === 0 && startup.plannerFederalTax === '\u2014', `Blank startup/selector contract failed: ${JSON.stringify(startup)}`);
  await selectHouseholdVisible(page, 'now-household');
  await goToWizardStep(page, 'family');
  const family = await page.evaluate(() => ({
    householdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
    selected: document.querySelector('#hh-switch')?.value || '',
    railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    spouseName: document.querySelector('[data-wizard-field="spouseName"]')?.value || ''
  }));
  requireCondition(family.householdId === 'now-household' && family.selected === 'now-household' && family.railName === 'Now Household' && family.primaryName === 'Aboysname' && family.spouseName === 'Agirlsname', `Now selection did not hydrate approved Family facts: ${JSON.stringify(family)}`);
  await page.click('.htab[data-page="scenarios"]');
  await page.waitForFunction(() => {
    const allocationControl = document.querySelector('#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]');
    return document.querySelector('.page.on')?.dataset.page === 'scenarios' && document.querySelector('#scn-seg-compare')?.classList.contains('is-active') && document.querySelectorAll('#scn-view .scol__name').length > 0 && allocationControl?.selectedOptions?.[0] && document.querySelector('#scn-view .cmp-lev-in[data-key="savings"]');
  }, {
    timeout: 15000
  });
  const nowLevers = await page.evaluate(() => {
    const allocationControl = document.querySelector('#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]');
    return {
      baseline: document.querySelector('#scn-view .scol__name')?.textContent.trim() || '',
      allocation: allocationControl?.selectedOptions?.[0]?.textContent.trim() || '',
      savings: Number.parseFloat(document.querySelector('#scn-view .cmp-lev-in[data-key="savings"]')?.value.replaceAll(',', '') || '')
    };
  });
  requireCondition(nowLevers.baseline === 'Baseline' && nowLevers.allocation === 'Current mix' && nowLevers.savings === 46000, `Now Scenarios defaults are wrong: ${JSON.stringify(nowLevers)}`);
  const scenarioKeys = await page.evaluate(() => Object.keys(localStorage).filter(key => key === 'parallax.scenarios.now-household.v1'));
  requireCondition(scenarioKeys.length === 0, `Now runtime scenarios entered persistent storage: ${JSON.stringify(scenarioKeys)}`);
  await page.click('.htab[data-page="household"]');
  await waitForWizard(page, {
    householdId: 'now-household'
  });
}
export async function prepareContractFixture(page) {
  const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
  if (menuHidden) {
    await clickWizardAction(page, '#hh-menu-btn', {
      expectRevision: false
    });
  }
  await requireUnique(page, '#hh-menu-pop:not([hidden]) #hh-new', 'visible new household action');
  await clickWizardAction(page, '#hh-new');
  await page.waitForFunction(() => {
    const selected = document.querySelector('#hh-switch')?.value;
    return selected && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
  }, {
    timeout: 10000
  });
  await page.evaluate(() => {
    const dbKey = 'parallax.households.v1';
    const activeKey = 'parallax.activeHouseholdId';
    const db = JSON.parse(localStorage.getItem(dbKey) || 'null');
    const active = localStorage.getItem(activeKey);
    const plan = db?.[active];
    if (!plan) throw new Error('Active household fixture is unavailable');
    plan.meta.name = 'Verifier Household';
    plan.meta.primaryName = 'Verifier Client';
    plan.meta.spouseName = '';
    plan.meta.filingStatus = 'single';
    plan.household.spouse = null;
    plan.household.primary.retirementAge = 70;
    plan.income.socialSecurity.spouse = null;
    plan.portfolio.extraAccounts = [];
    plan.properties = [];
    plan.income.other = [{
      id: 'verify_wage_one',
      typeId: 'wages',
      owner: 'client',
      label: 'Salary one',
      amount: 50000,
      startAge: 0,
      endAge: 999,
      realGrowth: 0,
      taxablePct: 1
    }, {
      id: 'verify_wage_two',
      typeId: 'wages',
      owner: 'client',
      label: 'Salary two',
      amount: 25000,
      startAge: 0,
      endAge: 999,
      realGrowth: 0,
      taxablePct: 1
    }];
    if (plan.incomeTax && typeof plan.incomeTax === 'object') {
      delete plan.incomeTax.current1040;
      plan.incomeTax.deductionMode = 'auto';
    }
    localStorage.setItem(dbKey, JSON.stringify(db));
  });
  await reloadWizard(page);
}

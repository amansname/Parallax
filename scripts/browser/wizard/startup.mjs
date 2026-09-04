// Wizard browser contract: startup.
import { requireCondition, requireUnique } from './assertions.mjs';
import { waitForWizard, openWizard, goToWizardStep, clickWizardAction, reloadWizard, selectHouseholdVisible, openNetWorthCategory } from './actions.mjs';
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
async function selectJoeFinanceAmount(page, owner, mode, typeId) {
  const selectedOwner = await page.$eval(
    `[data-finances-person-owner="${owner}"]`,
    button => button.getAttribute('aria-pressed'),
  );
  if(selectedOwner !== 'true'){
    await clickWizardAction(page, `[data-finances-person-owner="${owner}"]`);
  }
  const selectedMode = await page.$eval(
    `[data-hh-action="set-finance-mode"][data-finance-mode="${mode}"]`,
    button => button.getAttribute('aria-pressed'),
  );
  if(selectedMode !== 'true'){
    await clickWizardAction(
      page,
      `[data-hh-action="set-finance-mode"][data-finance-mode="${mode}"]`,
    );
  }
  await clickWizardAction(
    page,
    `[data-hh-action="select-finance-source"][data-finance-type-id="${typeId}"]`,
  );
  return page.evaluate(() => ({
    owner: document.querySelector('[data-finance-entry-panel]')?.dataset.financeOwner || '',
    mode: document.querySelector('[data-hh-action="set-finance-mode"][aria-pressed="true"]')
      ?.dataset.financeMode || '',
    source: document.querySelector('[data-finance-source-select] span')?.textContent.trim() || '',
    amount: document.querySelector('[data-finance-amount]')?.value || '',
  }));
}
async function verifyJoePlanSurfaces(page) {
  await goToWizardStep(page, 'net-worth');
  const netWorth = await page.evaluate(() => ({
    total: document.querySelector('.nw-rail[aria-label="Net worth total"] strong')
      ?.textContent.trim() || '',
    categories: Object.fromEntries(
      [...document.querySelectorAll('[data-hh-action="net-worth-open-category"]')]
        .map(button => [
          button.dataset.categoryId,
          button.querySelector('.nw-tile-copy span')?.textContent.trim() || '',
        ]),
    ),
  }));
  requireCondition(
    netWorth.total === '$4,013,000'
      && netWorth.categories.investment === '$3,413,000'
      && netWorth.categories.property === '$1,000,000'
      && netWorth.categories.mortgage === '$400,000',
    `Joe Net Worth totals did not match the approved fixture: ${JSON.stringify(netWorth)}`,
  );
  await openNetWorthCategory(page, 'investment');
  const accounts = await page.evaluate(() => (
    [...document.querySelectorAll('.nw-edit-entry[data-entry-source="account"]')]
      .map(button => ({
        id: button.dataset.accountId,
        name: button.dataset.entryName,
        owner: button.dataset.entryOwner,
        balance: Number(button.dataset.entryValue),
        allocation: button.dataset.entryAllocationPresetId,
      }))
  ));
  requireCondition(
    JSON.stringify(accounts) === JSON.stringify([
      { id: 'joe-client-401k', name: 'Joe 401(k)', owner: 'client', balance: 1_300_000, allocation: 'growth' },
      { id: 'joe-client-roth-ira', name: 'Joe Roth IRA', owner: 'client', balance: 350_000, allocation: 'all-equity' },
      { id: 'joe-joint-brokerage', name: 'Joint Brokerage', owner: 'joint', balance: 675_000, allocation: 'balanced' },
      { id: 'joe-spouse-401k', name: 'Jane 401(k)', owner: 'spouse', balance: 700_000, allocation: 'growth' },
      { id: 'joe-spouse-roth-ira', name: 'Jane Roth IRA', owner: 'spouse', balance: 122_000, allocation: 'all-equity' },
      { id: 'joe-spouse-tod-brokerage', name: 'Jane TOD Brokerage', owner: 'spouse', balance: 266_000, allocation: 'balanced' },
    ]),
    `Joe investment accounts did not match the approved fixture: ${JSON.stringify(accounts)}`,
  );
  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');

  await goToWizardStep(page, 'tax');
  const tax = await page.evaluate(() => ({
    taxYear: document.querySelector('[data-tax-field="taxYear"]')?.value || '',
    filingStatus: document.querySelector('.hh-tax-static strong')?.textContent.trim() || '',
    deductionMode: document.querySelector('[data-tax-field="deductionMode"]')?.value || '',
    clientWages: document.querySelector('[data-tax-field="income.wages.client"]')?.value || '',
    spouseWages: document.querySelector('[data-tax-field="income.wages.spouse"]')?.value || '',
  }));
  requireCondition(
    JSON.stringify(tax) === JSON.stringify({
      taxYear: '2026',
      filingStatus: 'Married filing jointly',
      deductionMode: 'standard',
      clientWages: '210,000',
      spouseWages: '210,000',
    }),
    `Joe current-year Tax facts did not match the approved fixture: ${JSON.stringify(tax)}`,
  );

  await page.click('.htab[data-sub-target="goals"]');
  await page.waitForFunction(() => (
    document.querySelectorAll('.gh-lane').length === 5
      && document.querySelector('.gh-add-toggle')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('.gh-add-rail')
  ), { timeout: 10000 });
  const goals = await page.evaluate(() => ({
    chooser: [...document.querySelectorAll('[data-add-category]')]
      .map(button => button.dataset.addCategory),
    editorRails: document.querySelectorAll('[data-goal-rail]').length,
    lanes: [...document.querySelectorAll('.gh-chip')].map(button => ({
      name: button.querySelector('.gh-chip__name')?.textContent.trim() || '',
      amount: button.querySelector('.gh-chip__amount')?.textContent.trim() || '',
      timing: button.title.replace(/ · drag to move$/, ''),
    })),
  }));
  requireCondition(
    JSON.stringify(goals) === JSON.stringify({
      chooser: ['travel', 'home', 'vehicle', 'education', 'family', 'giving', 'health', 'custom'],
      editorRails: 0,
      lanes: [
        { name: 'Essentials', amount: '$13k / mo', timing: 'Every year, ages 64–95' },
        { name: 'Healthcare', amount: '$11k / yr', timing: 'Every year, ages 64–95' },
        { name: 'Travel', amount: '$20k / yr', timing: 'Every year, ages 64–78' },
        { name: 'Kitchen', amount: '$50k', timing: 'At age 61' },
        { name: 'Pool', amount: '$100k', timing: 'At age 65' },
      ],
    }),
    `Joe Goals Horizon did not match the approved fixture: ${JSON.stringify(goals)}`,
  );
  await page.click('.htab[data-page="household"]');
  await waitForWizard(page, { householdId: 'joe-household' });
}
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
export async function verifyJoeStartupAndNowSelection(page, expectedNameOnlyBytes) {
  await openWizard(page);
  const startup = await page.evaluate(staleRecordIds => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const options = [...document.querySelectorAll('#hh-switch option')].map(option => ({
      value: option.value,
      label: option.textContent.trim(),
      disabled: option.disabled
    }));
    const customIds = Object.keys(db || {}).filter(id => !['now-household', 'future-household', 'joe-household', 'demo', 'default-pre-retirement-solo', 'default-pre-retirement-couple'].includes(id));
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
      joeScenarioBytes: localStorage.getItem('parallax.scenarios.joe-household.v1'),
      primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
      spouseName: document.querySelector('[data-wizard-field="spouseName"]')?.value || '',
      clientRetirementAge: document.querySelector('[data-wizard-field="client.retirementAge"]')?.value || '',
      spouseRetirementAge: document.querySelector('[data-wizard-field="spouse.retirementAge"]')?.value || '',
      clientClaimAge: document.querySelector('[data-wizard-field="client.socialSecurityAge"]')?.value || '',
      spouseClaimAge: document.querySelector('[data-wizard-field="spouse.socialSecurityAge"]')?.value || '',
      filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
      financeExpanded: document.querySelector('[data-hh-action="toggle-finances-rail"]')
        ?.getAttribute('aria-expanded') || '',
      financeOwner: document.querySelector('[data-finance-entry-panel]')
        ?.dataset.financeOwner || '',
      financeMode: document.querySelector('[data-hh-action="set-finance-mode"][aria-pressed="true"]')
        ?.dataset.financeMode || '',
      financeSource: document.querySelector('[data-finance-source-select] span')
        ?.textContent.trim() || '',
      financeAmountCount: document.querySelectorAll('[data-finance-amount]').length,
      financeSummary: document.querySelector('[data-finances-summary] strong')?.textContent.trim() || '',
      benefitFields: document.querySelectorAll('[data-wizard-field$=".socialSecurityBenefit"]').length
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
  }, {
    value: 'joe-household',
    label: 'Joe Household'
  }];
  const visibleBuiltIns = startup.options.filter(option => ['now-household', 'future-household', 'joe-household'].includes(option.value)).map(({
    value,
    label
  }) => ({
    value,
    label
  }));
  const optionIds = startup.options.slice(1).map(option => option.value);
  const nameOnlyRecordsSurvived = STALE_COPY_MIGRATION_RECORDS.every(record => startup.dbIds.includes(record.id) && startup.staleRecordBytes[record.id] === expectedNameOnlyBytes[record.id] && startup.options.filter(option => option.value === record.id && option.label === record.label).length === 1);
  const survivorOption = startup.options.find(option => option.value === MIGRATION_SURVIVOR.id);
  requireCondition(startup.active === null && startup.selected === 'joe-household' && startup.railName === 'Joe Household' && startup.options[0]?.value === '' && startup.options[0]?.disabled === true && JSON.stringify(visibleBuiltIns) === JSON.stringify(expectedBuiltIns) && JSON.stringify(optionIds) === JSON.stringify(startup.dbIds) && startup.customIds.every(id => optionIds.includes(id)) && survivorOption?.label === MIGRATION_SURVIVOR.label && startup.dbIds.includes(MIGRATION_SURVIVOR.id) && nameOnlyRecordsSurvived && !optionIds.some(id => ['demo', 'default-pre-retirement-solo', 'default-pre-retirement-couple'].includes(id)) && startup.menuHidden === true && startup.menuButtonHidden === false && startup.progressHidden === false && startup.stepperHidden === false && startup.footerHidden === false && startup.screenCount === 1 && startup.enabledFields > 0 && startup.nowScenarioBytes === null && startup.futureScenarioBytes === null && startup.joeScenarioBytes === null && startup.primaryName === 'Joe' && startup.spouseName === 'Jane' && startup.clientRetirementAge === '64' && startup.spouseRetirementAge === '64' && startup.clientClaimAge === '67' && startup.spouseClaimAge === '67' && startup.filingStatus === 'marriedFilingJointly' && startup.financeExpanded === 'true' && startup.financeOwner === 'client' && startup.financeMode === 'savings' && startup.financeSource === 'Select savings type' && startup.financeAmountCount === 0 && startup.financeSummary === '$60,000/yr' && startup.benefitFields === 0, `Joe startup/selector contract failed: ${JSON.stringify(startup)}`);
  const financeRail = await page.evaluate(() => ({
    expanded: document.querySelector('[data-hh-action="toggle-finances-rail"]')
      ?.getAttribute('aria-expanded') || '',
    people: [...document.querySelectorAll('[data-finances-person-owner]')].map(button => ({
      owner: button.dataset.financesPersonOwner,
      name: button.querySelector('.hh-finances-person-name')?.textContent.trim() || '',
      detail: button.querySelector('small')?.textContent.trim() || '',
      pressed: button.getAttribute('aria-pressed'),
    })),
    owner: document.querySelector('[data-finance-entry-panel]')?.dataset.financeOwner || '',
    mode: document.querySelector('[data-hh-action="set-finance-mode"][aria-pressed="true"]')
      ?.dataset.financeMode || '',
    source: document.querySelector('[data-finance-source-select] span')?.textContent.trim() || '',
    sources: [...document.querySelectorAll('[data-hh-action="select-finance-source"]')]
      .map(button => button.textContent.trim()),
    amounts: document.querySelectorAll('[data-finance-amount]').length,
    summary: document.querySelector('[data-finances-summary] strong')?.textContent.trim() || '',
  }));
  requireCondition(
    financeRail.expanded === 'true'
      && JSON.stringify(financeRail.people) === JSON.stringify([
        { owner: 'client', name: 'Joe', detail: 'Primary · Age 60', pressed: 'true' },
        { owner: 'spouse', name: 'Jane', detail: 'Spouse · Age 60', pressed: 'false' },
      ])
      && financeRail.owner === 'client'
      && financeRail.mode === 'savings'
      && financeRail.source === 'Select savings type'
      && JSON.stringify(financeRail.sources) === JSON.stringify([
        '401(k) deferral',
        'Roth 401(k) deferral',
        'Traditional IRA',
        'Roth IRA',
        'HSA',
        'Taxable brokerage',
        'Cash savings',
      ])
      && financeRail.amounts === 0
      && financeRail.summary === '$60,000/yr',
    `Joe Savings and Income rail did not show the approved household: ${JSON.stringify(financeRail)}`,
  );
  const clientSavings = await selectJoeFinanceAmount(page, 'client', 'savings', '401k');
  const clientSocialSecurity = await selectJoeFinanceAmount(
    page,
    'client',
    'income',
    'social_security',
  );
  const spouseSavings = await selectJoeFinanceAmount(page, 'spouse', 'savings', '401k');
  const spouseSocialSecurity = await selectJoeFinanceAmount(
    page,
    'spouse',
    'income',
    'social_security',
  );
  requireCondition(
    JSON.stringify(clientSavings) === JSON.stringify({
      owner: 'client', mode: 'savings', source: '401(k) deferral', amount: '30,000',
    })
      && JSON.stringify(clientSocialSecurity) === JSON.stringify({
        owner: 'client', mode: 'income', source: 'Social Security', amount: '50,000',
      })
      && JSON.stringify(spouseSavings) === JSON.stringify({
        owner: 'spouse', mode: 'savings', source: '401(k) deferral', amount: '30,000',
      })
      && JSON.stringify(spouseSocialSecurity) === JSON.stringify({
        owner: 'spouse', mode: 'income', source: 'Social Security', amount: '50,000',
      }),
    `Joe finance entries did not match the approved fixture: ${JSON.stringify({
      clientSavings,
      clientSocialSecurity,
      spouseSavings,
      spouseSocialSecurity,
    })}`,
  );
  await verifyJoePlanSurfaces(page);
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
    const savings = Number.parseFloat(
      document.querySelector('#scn-view .cmp-lev-in[data-key="savings"]')
        ?.value.replaceAll(',', '') || '',
    );
    return document.querySelector('.page.on')?.dataset.page === 'scenarios'
      && document.querySelector('#scn-seg-compare')?.classList.contains('is-active')
      && document.querySelectorAll('#scn-view .scol__name').length > 0
      && allocationControl?.selectedOptions?.[0]
      && savings === 46000;
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

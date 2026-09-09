import assert from 'node:assert/strict';
import { join } from 'node:path';
import { waitForWizard, selectHouseholdVisible } from './wizard/actions.mjs';

const primary = '[data-hh-field="client.legalName"]';
const spouse = '[data-hh-field="spouse.legalName"]';
const toggle = '[data-hh-action="toggle-finances-rail"]';
const person = owner => `[data-finances-person-owner="${owner}"]`;
const sources = {
  savings: [['401k', '401(k) deferral'], ['roth_401k', 'Roth 401(k) deferral'], ['traditional_ira', 'Traditional IRA'], ['roth_ira', 'Roth IRA'], ['hsa', 'HSA'], ['brokerage_taxable', 'Taxable brokerage'], ['savings', 'Cash savings']],
  income: [['social_security', 'Social Security'], ['pension', 'Pension'], ['wages', 'Wages or salary'], ['self_employment', 'Self-employment'], ['rental', 'Rental net income'], ['annuity', 'Annuity'], ['interest', 'Interest'], ['dividends', 'Dividends'], ['deferred_comp', 'Deferred compensation'], ['other', 'Other income']],
};

async function requireSources(page, owner, mode){
  await requirePersonRelations(page, owner);
  const state = await page.evaluate(() => {
    const heading = document.querySelector('[data-finance-source-select]');
    return {
      heading: { tag: heading.tagName, text: heading.textContent.trim(), role: heading.getAttribute('role'), tabIndex: heading.tabIndex,
        border: getComputedStyle(heading).borderTopWidth, fontSize: getComputedStyle(heading).fontSize, chevrons: heading.querySelectorAll('svg').length },
      modes: [...document.querySelectorAll('[data-finance-mode]')].map(button => [button.dataset.financeMode, button.textContent.trim(), button.getAttribute('aria-pressed')]),
      sources: [...document.querySelectorAll('[data-finance-type-id]')].map(button => [button.dataset.financeTypeId, button.textContent.trim(), button.getAttribute('aria-pressed')]),
      amounts: document.querySelectorAll('[data-finance-amount]').length,
      saves: document.querySelectorAll('[data-hh-action="commit-finance-entry"]').length,
      replacements: document.querySelectorAll('[data-savings-replacement]').length,
    };
  });
  assert.deepEqual(state, {
    heading: { tag: 'P', text: mode === 'savings' ? 'Select savings type' : 'Select income source', role: null, tabIndex: -1, border: '0px', fontSize: '14px', chevrons: 0 },
    modes: [['savings', 'Savings', String(mode === 'savings')], ['income', 'Income', String(mode === 'income')]],
    sources: sources[mode].map(([id, label]) => [id, label, 'false']), amounts: 0, saves: 0, replacements: 0,
  });
}

async function replaceText(page, selector, value){
  await page.click(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
}

async function requireInput(page, selector, value){
  assert.deepEqual(await page.$eval(selector, element => ({
    value: element.value, focused: document.activeElement === element,
  })), { value, focused: true });
}

async function requirePersonRelations(page, selected){
  const state = await page.evaluate(() => [...document.querySelectorAll('[data-finances-person-owner]')].map(button => ({
    owner: button.dataset.financesPersonOwner,
    expanded: button.getAttribute('aria-expanded'),
    pressed: button.getAttribute('aria-pressed'),
    controls: button.getAttribute('aria-controls'),
    targetCount: [...document.querySelectorAll('[id]')].filter(node => node.id === button.getAttribute('aria-controls')).length,
    visiblePanel: document.querySelector('[data-finance-entry-panel]')?.dataset.financeOwner || null,
  })));
  assert.deepEqual(state.map(row => row.owner), ['client', 'spouse']);
  for(const row of state){
    assert.equal(row.expanded, String(row.owner === selected));
    assert.equal(row.pressed, String(row.owner === selected));
    assert.equal(row.targetCount, 1);
    assert.equal(row.visiblePanel, selected);
  }
}

async function requireReachableForm(page){
  const state = await page.evaluate(() => {
    const input = document.querySelector('[data-hh-field="client.legalName"]');
    const rect = input.getBoundingClientRect();
    const menu = document.querySelector('#hh-menu-btn');
    const menuRect = menu.getBoundingClientRect();
    return {
      expanded: document.querySelector('[data-hh-action="toggle-finances-rail"]').getAttribute('aria-expanded'),
      hit: document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2) === input,
      menuHit: menu.contains(document.elementFromPoint(menuRect.x + menuRect.width / 2, menuRect.y + menuRect.height / 2)),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controlHeight: document.querySelector('[data-hh-action="toggle-finances-rail"]').getBoundingClientRect().height,
      panels: document.querySelectorAll('[data-finance-entry-panel]').length,
      people: document.querySelectorAll('[data-finances-person-owner]').length,
    };
  });
  assert.equal(state.expanded, 'false');
  assert.equal(state.hit, true);
  assert.equal(state.menuHit, true);
  assert.ok(state.overflow <= 1);
  assert.equal(state.controlHeight, 40);
  assert.equal(state.panels, 0);
  assert.equal(state.people, 0);
}

export async function verifyFamilyEditing({ browser, url, screenshotDir }){
  const context = await browser.createBrowserContext();
  const errors = [];
  try{
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'joe-household', step: 'family' });
    await requireSources(page, 'client', 'savings');

    // Do not use page.type(selector) or setWizardValue: either would hide a lost first focus.
    await page.click(primary);
    await page.keyboard.press('End');
    await page.keyboard.type(' First');
    await requireInput(page, primary, 'Joe First');
    await page.click(spouse);
    await page.keyboard.press('End');
    await page.keyboard.type(' Next');
    await requireInput(page, spouse, 'Jane Next');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-birth-date-group="spouse"] [data-birth-date-display]')), true);
    // A complete date commits during typing. The control and caret must survive that save.
    await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');
    await page.keyboard.type('03151960');
    const date = await page.evaluate(() => ({ active: document.activeElement?.matches('[data-birth-date-display]'), value: document.activeElement?.value, caret: document.activeElement?.selectionStart }));
    assert.equal(date.active, true);assert.equal(date.value, '03 / 15 / 1960');assert.equal(date.caret, date.value.length);
    await page.click(person('spouse'));
    await requirePersonRelations(page, 'spouse');
    await page.click(primary);await page.keyboard.press('Home');await page.keyboard.type('Reopened ');
    await requireInput(page, primary, 'Reopened Joe First');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-birth-date-group="client"] [data-birth-date-display]')), true);

    // Explicitly create a saved household through the production control.
    await page.click('#hh-menu-btn');await page.click('#hh-new');
    await page.waitForFunction(() => /^hh_/i.test(document.querySelector('#hh-switch')?.value || '') && document.querySelector('[data-hh-wizard-root]')?.dataset.wizardReady === 'true');
    const id = await page.$eval('#hh-switch', element => element.value);
    await page.select('[data-wizard-field="filingStatus"]', 'marriedFilingJointly');
    await page.waitForSelector(spouse);
    await replaceText(page, primary, 'Editing Client');
    await replaceText(page, spouse, 'Editing Spouse');
    // Saving by blur must also leave a subsequent rail-button click intact.
    await page.click(person('spouse'));
    await requirePersonRelations(page, 'spouse');
    await page.waitForFunction(() => document.activeElement?.matches('[data-hh-action="select-finance-source"]'));
    for(const owner of ['spouse', 'client']){
      if(owner === 'client') await page.click(person(owner));
      await requireSources(page, owner, 'savings');
      await page.click('[data-hh-action="set-finance-mode"][data-finance-mode="income"]');
      await requireSources(page, owner, 'income');
    }
    // Select and numeric commits use the same partial update as names and DOB.
    await page.click('[data-hh-field="client.status"]');
    await page.keyboard.press('End');await page.keyboard.press('Enter');
    await requireInput(page, '[data-hh-field="client.status"]', 'retired');
    await page.keyboard.press('Tab');
    await requireInput(page, '[data-hh-field="client.retirementAge"]', '65');
    await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');
    await page.keyboard.type('66');await page.keyboard.press('Tab');
    await requireInput(page, '[data-hh-field="client.socialSecurityAge"]', '67');
    await page.click(person('spouse'));
    await requireSources(page, 'spouse', 'savings');
    await page.waitForFunction(() => document.activeElement?.matches('[data-hh-action="select-finance-source"]'));
    await page.waitForFunction(householdId => {
      const saved = JSON.parse(localStorage.getItem('parallax.households.v1'))[householdId];
      return saved?.meta.primaryName === 'Editing Client' && saved?.meta.spouseName === 'Editing Spouse'
        && saved.household.primary.employmentStatus === 'retired' && saved.household.primary.retirementAge === 66;
    }, {}, id);
    const before = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b))));
    await page.keyboard.press('Escape');
    await requirePersonRelations(page, null);
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-finances-person-owner="spouse"]')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-hh-action="toggle-finances-rail"]')), true);
    assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)))), before);
    await page.click(toggle);await page.click(person('client'));
    await requirePersonRelations(page, 'client');
    await page.screenshot({ path: join(screenshotDir, 'family-editing-desktop.png') });
    await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'joe-household' });
    await selectHouseholdVisible(page, id);
    assert.equal(await page.$eval(primary, element => element.value), 'Editing Client');
    assert.equal(await page.$eval(spouse, element => element.value), 'Editing Spouse');
    assert.equal(await page.$eval('[data-hh-field="client.status"]', element => element.value), 'retired');
    assert.equal(await page.$eval('[data-hh-field="client.retirementAge"]', element => element.value), '66');
    await page.setViewport({ width: 1023, height: 900, deviceScaleFactor: 1 });
    await page.waitForFunction(() => document.querySelector('[data-hh-action="toggle-finances-rail"]')?.getAttribute('aria-expanded') === 'false');
    await requireReachableForm(page);

    const narrow = await context.newPage();
    narrow.on('pageerror', error => errors.push(error.message));
    await narrow.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await narrow.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(narrow, { householdId: 'joe-household', step: 'family' });
    await requireReachableForm(narrow);
    await narrow.screenshot({ path: join(screenshotDir, 'family-editing-390.png') });
    await selectHouseholdVisible(narrow, id);
    await requireReachableForm(narrow);
    await narrow.setViewport({ width: 760, height: 900, deviceScaleFactor: 1 });
    await requireReachableForm(narrow);
    await narrow.screenshot({ path: join(screenshotDir, 'family-editing-760.png') });
    await narrow.click(toggle);await narrow.click(person('client'));
    await requirePersonRelations(narrow, 'client');
    await narrow.waitForFunction(() => document.activeElement?.matches('[data-hh-action="select-finance-source"][data-finance-type-id="401k"]'));
    await narrow.keyboard.press('Tab');
    assert.equal(await narrow.evaluate(() => document.activeElement?.matches('[data-hh-action="select-finance-source"]')), true);
    await narrow.keyboard.press('Enter');
    await narrow.waitForFunction(() => document.activeElement?.matches('[data-finance-amount]'));
    await narrow.keyboard.press('Escape');await narrow.keyboard.press('Escape');
    await requireReachableForm(narrow);
    assert.equal(await narrow.evaluate(() => document.activeElement?.matches('[data-hh-action="toggle-finances-rail"]')), true);
    assert.deepEqual(errors, []);
  }finally{
    await context.close();
  }
}

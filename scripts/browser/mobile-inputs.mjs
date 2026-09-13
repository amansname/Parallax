import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { waitForWizard, waitForPlanCalculation, selectHouseholdVisible, clickPlanningTab } from './wizard/actions.mjs';

async function typeInto(page, selector, value, blur = true){
  await page.click(selector);
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(value));
  if(blur) await page.keyboard.press('Tab');
}

async function saved(page){
  return page.evaluate(() => {
    const id = localStorage.getItem('parallax.activeHouseholdId');
    return { id, plan: JSON.parse(localStorage.getItem('parallax.households.v1'))[id] };
  });
}

async function setStorageFailure(page, enabled){
  await page.evaluate(fail => {
    if(!fail){ Storage.prototype.setItem = globalThis.__mobileInputsSetItem; delete globalThis.__mobileInputsSetItem; return; }
    globalThis.__mobileInputsSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value){
      if(key === 'parallax.households.v1') throw new DOMException('Mobile input test storage full', 'QuotaExceededError');
      return globalThis.__mobileInputsSetItem.call(this, key, value);
    };
  }, enabled);
}

async function taxGroup(page, key){
  const selector = `[data-mobile-tax-group="${key}"]`;
  if(!await page.$eval(selector, node => node.open)) await page.click(`${selector} > summary`);
}

async function verifyPendingSavePresentation(page, kind, screenshotDir){
  for(const width of [390, 900, 1280, 390]){
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.$eval('[data-household-retry-save]', node => node.scrollIntoView({ block: 'center' }));
    const presentation = await page.$eval('[data-household-retry-save]', button => {
      const notice = document.getElementById(button.getAttribute('aria-describedby'));
      const box = button.getBoundingClientRect();
      const noticeBox = notice.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(button);
      const textBox = range.getBoundingClientRect();
      return {
        name: button.getAttribute('aria-label'), message: notice.textContent,
        noticeVisible: notice.getClientRects().length > 0 && noticeBox.bottom > 0 && noticeBox.top < innerHeight,
        textFits: textBox.left >= box.left && textBox.right <= box.right && textBox.top >= box.top && textBox.bottom <= box.bottom,
      };
    });
    assert.equal(presentation.name, 'Retry Save');
    assert.match(presentation.message, /Could not save to this browser/);
    assert.equal(presentation.noticeVisible, true);
    assert.equal(presentation.textFits, true);
    if(screenshotDir && width === 390) await page.screenshot({ path: join(screenshotDir, `mobile-inputs-${kind}-save-failure.png`), fullPage: true });
  }
}

async function taxInventory(page){
  return page.$$eval('[data-tax-field]', nodes => nodes.map(node => node.dataset.taxField).sort());
}

async function verifyTaxGestures(page){
  const income = '[data-mobile-tax-group="income"]';
  await typeInto(page, '[data-tax-field="income.taxableInterest"]', 800, false);
  await page.click(`${income} > summary`);
  await page.waitForFunction(() => document.querySelector('[data-mobile-tax-group="income"]')?.open === true);
  const baseOrder = ['income.wages.client', 'income.taxExemptInterest', 'income.ordinaryDividends', 'income.iraDistributions',
    'income.rothConversion', 'income.pensionAmount', 'scheduleD.netLongTermGainOrLoss', 'income.otherIncome'];
  const order = () => page.$$eval(`${income} [data-tax-field]`, nodes => nodes.map(node => node.dataset.taxField));
  assert.deepEqual(await order(), baseOrder);
  for(const [gross, amount, next, companion] of [
    ['income.iraDistributions', 20000, 'income.rothConversion', 'income.taxableIra'],
    ['income.pensionAmount', 15000, 'scheduleD.netLongTermGainOrLoss', 'income.taxablePensions'],
  ]){
    const selector = `[data-tax-field="${next}"]`;
    await page.$eval(selector, node => { globalThis.__mobileTaxNext = node; });
    await typeInto(page, `[data-tax-field="${gross}"]`, amount, false);
    await page.click(selector); // One real tap; no synthetic blur or second click.
    await page.waitForSelector(`[data-tax-field="${companion}"]`);
    assert.equal(await page.evaluate(() => document.activeElement === globalThis.__mobileTaxNext && globalThis.__mobileTaxNext.isConnected), true);
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.keyboard.type('10'); await page.keyboard.press('Tab');
    assert.equal(await page.$eval(selector, node => node.value), '10');
    const expected = [...baseOrder]; expected.splice(expected.indexOf(gross) + 1, 0, companion);
    assert.deepEqual(await order(), expected);
    await typeInto(page, selector, 0);
    await typeInto(page, `[data-tax-field="${gross}"]`, 0);
    await page.waitForFunction(key => !document.querySelector(`[data-tax-field="${key}"]`), {}, companion);
    assert.deepEqual(await order(), baseOrder);
  }
  // A raw invalid signed amount must survive an unrelated conditional update,
  // retain its accessible label, and clear normally when the user corrects it.
  const gain = '[data-tax-field="scheduleD.netLongTermGainOrLoss"]';
  await typeInto(page, gain, '--1');
  await page.click('[data-mobile-tax-choice="itemized"]');
  await page.waitForSelector('[data-tax-field="deductions.itemized.medicalExpensesPaid"]');
  await page.waitForFunction(() => document.activeElement?.dataset.mobileTaxChoice === 'itemized');
  assert.equal(await page.$eval(gain, node => node.value), '--1');
  assert.equal(await page.$eval(gain, node => Boolean(document.getElementById(node.getAttribute('aria-labelledby'))?.textContent.trim())), true);
  await page.click('[data-mobile-tax-choice="itemized-total"]');
  await page.waitForSelector('[data-tax-field="deductions.line12e"]');
  await page.waitForFunction(() => document.activeElement?.dataset.mobileTaxChoice === 'itemized-total');
  await typeInto(page, '[data-tax-field="deductions.line12e"]', 23000);
  assert.equal((await saved(page)).plan.incomeTax.current1040.deductions.line12e, 23000);
  assert.equal((await saved(page)).plan.incomeTax.current1040.deductions.source, 'supplied-line12e');
  const beforeResize = await saved(page);
  await page.click('[data-mobile-tax-choice="itemized"]');
  assert.equal(await page.$eval('[data-tax-field="deductionMode"]', node => node.value), 'itemized-total');
  for(const width of [1280, 390]){
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    await page.waitForFunction(mobile => mobile
      ? document.activeElement?.dataset.mobileTaxChoice === 'itemized'
      : document.activeElement?.dataset.taxField === 'deductionMode', {}, width === 390);
    assert.deepEqual(await saved(page), beforeResize);
    assert.equal(await page.$$eval('[data-tax-field="deductionMode"]', nodes => nodes.length), 1);
  }
  await page.click('[data-mobile-tax-choice="itemized-details"]');
  await page.waitForSelector('[data-tax-field="deductions.itemized.medicalExpensesPaid"]');
  await typeInto(page, gain, 0);
  await page.click('[data-mobile-tax-choice="standard"]');
  await page.waitForFunction(() => !document.querySelector('.hh-itemized-section'));
  assert.equal((await saved(page)).plan.incomeTax.current1040.deductions.method, 'standard');
  console.log('Mobile inputs: Tax single taps, conditional order, raw errors and label continuity passed');
}

// A durable funded household entered through production controls. Pure-engine
// probes supplement, rather than substitute for, the visible result assertions.
export async function verifyMobileInputs({ browser, url, screenshotDir }){
  const context = await browser.createBrowserContext();
  const fixture = JSON.parse(await readFile(new URL('../../test/fixtures/withdrawal-planner-visible-entry.v1.json', import.meta.url), 'utf8'));
  const errors = [];
  let page;
  const proof = {};
  try{
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if(message.type() === 'error' && /Household screen could not refresh/.test(message.text())) errors.push(message.text());
    });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const artifactId = response.headers()['x-parallax-artifact-id'];
    assert.match(artifactId, /^[a-f0-9]{64}$/);
    proof.artifactId = artifactId;
    await waitForWizard(page);
    assert.equal(await page.$eval('#hh-wiz-footer [data-hh-action="step-next"]', node => node.getClientRects().length > 0), true);
    await waitForPlanCalculation(page);
    await page.click('#hh-menu-btn'); await page.click('#hh-new');
    await page.waitForFunction(() => /^hh_/.test(document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || ''));
    await typeInto(page, '[data-wizard-field="primaryName"]', 'Mobile input verification');
    await typeInto(page, '[data-birth-date-group="client"] [data-birth-date-display]', '01151962');
    await typeInto(page, '[data-wizard-field="client.retirementAge"]', 66);
    await typeInto(page, '[data-wizard-field="client.planEndAge"]', 96);
    await typeInto(page, '[data-wizard-field="client.socialSecurityAge"]', 67);
    const householdId = (await saved(page)).id;
    proof.householdId = householdId;
    const familyOrder = await page.$$eval('[data-person-owner="client"] .hh-person-fields > *', nodes => nodes.map(node => node.querySelector('[data-wizard-field]')?.dataset.wizardField || node.querySelector('output')?.dataset.hhAge));
    assert.deepEqual(familyOrder, ['primaryName', 'client.birthDate', 'client', 'client.retirementAge', 'client.planEndAge', 'client.status', 'client.socialSecurityAge']);
    await page.click('[data-hh-action="toggle-finances-rail"]');
    await page.click('[data-finances-person-owner="client"]');
    await page.click('[data-hh-action="set-finance-mode"][data-finance-mode="income"]');
    await page.click('[data-finance-type-id="social_security"]');
    await typeInto(page, '[data-finance-amount]', '2500.08', false);
    await page.keyboard.press('Backspace');
    assert.equal(await page.$eval('[data-finance-amount]', node => node.value), '2,500.0');
    const beforeFailedFinance = await saved(page);
    await setStorageFailure(page, true);
    await page.click('[data-hh-action="commit-finance-entry"]');
    await page.waitForFunction(() => document.querySelector('[data-hh-action="commit-finance-entry"]')?.textContent === 'Retry Save');
    assert.deepEqual(await saved(page), beforeFailedFinance);
    assert.equal(await page.$eval('[data-finance-amount]', node => node.disabled), true);
    await verifyPendingSavePresentation(page, 'finance', screenshotDir);
    await page.click('[data-hh-action="commit-finance-entry"]');
    assert.deepEqual(await saved(page), beforeFailedFinance);
    await setStorageFailure(page, false);
    await page.click('[data-hh-action="commit-finance-entry"]');
    assert.equal((await saved(page)).plan.income.socialSecurity.primary.pia, 30000);
    await page.click('[data-finances-person-owner="client"]');
    await page.click('[data-hh-action="set-finance-mode"][data-finance-mode="income"]');
    await page.click('[data-finance-type-id="social_security"]');
    await typeInto(page, '[data-finance-amount]', 3000);
    assert.equal(await page.$eval('[data-finance-amount]', node => node.dataset.financeUnit), 'month');
    await page.click('[data-hh-action="commit-finance-entry"]');
    assert.equal((await saved(page)).plan.income.socialSecurity.primary.pia, 36000);
    // Repeated partial rail updates and resizes must never revive old controls.
    await page.click('[data-finances-person-owner="client"]');
    await page.click('[data-hh-action="set-finance-mode"][data-finance-mode="income"]');
    await page.click('[data-finance-type-id="social_security"]');
    await page.click('[data-finances-rail] .hh-finances-rail-head > span');
    const beforeResize = await saved(page);
    for(const width of [1280, 900, 390, 1280, 390]){
      await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
      await page.waitForFunction(expected => document.querySelector('[data-finance-amount]')?.dataset.financeUnit === expected, {}, width === 390 ? 'month' : 'year');
      assert.equal(await page.$$eval('[data-finances-rail]', nodes => nodes.length), 1);
      assert.equal(await page.$$eval('[data-finance-amount]', nodes => nodes.length), 1);
      assert.equal(await page.$eval('[data-finance-amount]', node => node.value), width === 390 ? '3,000' : '36,000');
    }
    assert.deepEqual(await saved(page), beforeResize);
    await page.click('[data-hh-action="toggle-finances-rail"]');
    console.log('Mobile inputs: Family save and responsive control identity passed');

    await page.click('[data-hh-wizard-nav="net-worth"]');
    await page.click('[data-category-id="investment"]');
    for(const account of fixture.accounts){
      await page.click(`[data-hh-action="net-worth-pick-type"][data-account-type-id="${account.typeId}"]`);
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.nw-panel h2')), true);
      await typeInto(page, '[data-net-worth-draft="name"]', account.institution);
      await page.select('[data-net-worth-draft="owner"]', account.owner);
      await typeInto(page, '[data-net-worth-draft="value"]', account.balance);
      assert.equal(await page.$eval('.nw-panel', node => getComputedStyle(node).position), 'static');
      assert.deepEqual(await page.$$eval('.nw-allocation-option span', nodes => nodes.map(node => node.textContent)),
        ['Defensive', 'Conservative', 'Balanced', 'Growth', 'Aggressive', 'All Equity']);
      assert.equal(await page.$$eval('.nw-allocation-option span', nodes => nodes.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44 && node.scrollWidth <= node.clientWidth;
      })), true);
      if(account === fixture.accounts[0]){
        const beforeAccountResize = await saved(page);
        const amountControl = await page.$('[data-net-worth-draft="value"]');
        await amountControl.click();
        const rawAmount = await amountControl.evaluate(node => {
          node.setSelectionRange(1, 3);
          return node.value;
        });
        for(const width of [900, 707, 390]){
          await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
          await page.waitForFunction(expected => Boolean(document.querySelector('.nw-mobile-account-fields')) === expected, {}, width <= 760);
          assert.deepEqual(await amountControl.evaluate(node => ({ focused: document.activeElement === node, value: node.value, start: node.selectionStart, end: node.selectionEnd })),
            { focused: true, value: rawAmount, start: 1, end: 3 });
          assert.deepEqual(await saved(page), beforeAccountResize);
        }
        await amountControl.dispose();
        const beforeFailedAccount = await saved(page);
        await setStorageFailure(page, true);
        await page.click('[data-hh-action="net-worth-save-entry"]');
        await page.waitForFunction(() => document.querySelector('[data-hh-action="net-worth-save-entry"]')?.textContent === 'Retry Save');
        assert.deepEqual(await saved(page), beforeFailedAccount);
        assert.equal(await page.$$eval('[data-net-worth-draft]', nodes => nodes.every(node => node.disabled)), true);
        assert.equal(await page.$eval('[data-hh-wizard-nav="tax"]', node => node.disabled), true);
        assert.equal(await page.$eval('.app-header', node => node.inert), true);
        await verifyPendingSavePresentation(page, 'account', screenshotDir);
        await page.click('[data-hh-action="net-worth-save-entry"]');
        assert.deepEqual(await saved(page), beforeFailedAccount);
        await setStorageFailure(page, false);
      }
      await page.click('[data-hh-action="net-worth-save-entry"]');
      await waitForWizard(page, { step: 'net-worth', householdId });
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.nw-panel h2')), true);
    }
    const accounts = (await saved(page)).plan.portfolio.extraAccounts;
    assert.deepEqual(accounts.map(account => [account.typeId, account.owner, account.balance]), fixture.accounts.map(account => [account.typeId, account.owner, account.balance]));
    await page.click('button[data-hh-action="net-worth-close-panel"]');

    await page.click('[data-hh-wizard-nav="tax"]');
    await waitForWizard(page, { step: 'tax', householdId });
    const originalInventory = await taxInventory(page);
    assert.deepEqual(originalInventory, ['taxYear', 'income.taxableInterest', 'income.qualifiedDividends',
      'income.wages.client', 'income.taxExemptInterest', 'income.ordinaryDividends', 'income.iraDistributions',
      'income.rothConversion', 'income.pensionAmount', 'scheduleD.netLongTermGainOrLoss', 'income.otherIncome',
      'income.socialSecurityBenefits', 'socialSecurity.mode', 'deductionMode',
      'irmaa.lookback.2024.magi', 'irmaa.lookback.2025.magi'].sort());
    assert.equal(new Set(originalInventory).size, originalInventory.length);
    await verifyTaxGestures(page);
    await taxGroup(page, 'income');
    await typeInto(page, '[data-tax-field="income.wages.client"]', 65000);
    assert.equal(await page.$eval('[data-mobile-tax-group="income"]', node => node.open), true);
    await typeInto(page, '[data-tax-field="income.taxableInterest"]', 800);
    await typeInto(page, '[data-tax-field="income.ordinaryDividends"]', 1200);
    await typeInto(page, '[data-tax-field="income.qualifiedDividends"]', 0);
    for(const width of [1280, 390]){
      await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
      await page.waitForFunction(expected => Boolean(document.querySelector('.hh-mobile-tax')) === expected, {}, width === 390);
      assert.deepEqual(await taxInventory(page), originalInventory);
    }
    await page.click('[data-hh-action="step-next"]');
    await waitForWizard(page, { step: 'summary', householdId });
    const taxProof = await page.evaluate(async version => {
      const id = localStorage.getItem('parallax.activeHouseholdId');
      const plan = JSON.parse(localStorage.getItem('parallax.households.v1'))[id];
      const moduleUrl = new URL('./src/household/buildWizardIncomeTaxSummary.js', location.href); moduleUrl.searchParams.set('v', version);
      const { buildCurrentAnnualFederalTaxBaseline } = await import(moduleUrl.href);
      const baseline = buildCurrentAnnualFederalTaxBaseline(plan);
      return { status: baseline.status, issues: baseline.issues, federalTax: baseline.summary.federalTaxLiability, confirmed: plan.incomeTax.current1040.incomeSourcesComplete, socialSecurity: plan.income.socialSecurity.primary.pia };
    }, artifactId);
    assert.deepEqual(taxProof, { status: 'ready', issues: [], federalTax: 5910, confirmed: true, socialSecurity: 36000 });
    proof.tax = taxProof;
    await page.screenshot({ path: join(screenshotDir, 'mobile-inputs-summary.png'), fullPage: true });
    console.log('Mobile inputs: real account saves and $5,910 federal tax oracle passed');

    await clickPlanningTab(page, 'net-worth');
    assert.deepEqual(await page.$$eval('[data-mobile-goals="list"] .gh-starter', nodes => nodes.map(node => node.dataset.category)), ['travel', 'home', 'vehicle', 'education', 'family', 'giving', 'health', 'custom']);
    const inlineAmount = '[data-gm-inline="system:essentials"]';
    const previousAmount = await page.$eval(inlineAmount, node => node.value);
    const longRawAmount = 'invalid amount '.repeat(12);
    await typeInto(page, inlineAmount, longRawAmount, false);
    assert.equal(await page.$eval(inlineAmount, node => node.value), longRawAmount);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await typeInto(page, inlineAmount, previousAmount, false);
    await page.click('[data-gm-action="open"][data-goal-id="system:essentials"]');
    const untouched = await saved(page);
    await typeInto(page, '[data-gm-field="amount"]', 9999, false);
    await page.$eval('[data-gm-field="amount"]', node => { globalThis.__mobileGoalAmount = node; node.setSelectionRange(1, 3); });
    for(const width of [1280, 844, 390]){
      await page.setViewport({ width, height: width === 844 ? 390 : 844, deviceScaleFactor: 1 });
      assert.deepEqual(await page.evaluate(() => ({ same: document.activeElement === globalThis.__mobileGoalAmount,
        value: globalThis.__mobileGoalAmount.value, selection: [globalThis.__mobileGoalAmount.selectionStart, globalThis.__mobileGoalAmount.selectionEnd] })),
      { same: true, value: '9999', selection: [1, 3] });
      assert.equal(await page.$eval('.app-header', node => node.getClientRects().length === 0), true);
    }
    await page.click('.gm-footer [data-gm-action="cancel"]');
    assert.deepEqual(await saved(page), untouched, 'Cancel changed canonical goals');
    await page.click('[data-gm-action="open"][data-goal-id="system:essentials"]');
    await page.click('[data-frequency="annual"]');
    await typeInto(page, '[data-gm-field="amount"]', fixture.goals.essentialsAnnual);
    await page.click('[data-gm-action="save"]');
    await page.click('[data-gm-action="new"][data-category="travel"]');
    await typeInto(page, '[data-gm-field="amount"]', 24000);
    await page.click('[data-frequency="monthly"]');
    assert.equal(await page.$eval('[data-gm-field="amount"]', node => node.value), '2,000');
    await typeInto(page, '[data-gm-field="amount"]', '');
    await page.click('[data-gm-action="category"][data-category="vehicle"]');
    assert.equal(await page.$eval('[data-gm-field="amount"]', node => node.value), '');
    assert.equal(await page.$eval('[data-gm-field="amount"]', node => node.getAttribute('aria-invalid')), 'true');
    await typeInto(page, '[data-gm-field="amount"]', 2500);
    const beforeFailedGoalSave = await saved(page);
    await setStorageFailure(page, true);
    await page.click('[data-gm-action="save"]');
    await page.waitForFunction(() => document.querySelector('.gm-editor .gm-error')?.textContent.includes('Could not save'));
    assert.deepEqual(await saved(page), beforeFailedGoalSave);
    await page.click('.gm-footer [data-gm-action="cancel"]');
    assert.equal(await page.$$eval('.gm-editor', nodes => nodes.length), 1);
    await setStorageFailure(page, false);
    await page.click('[data-gm-action="save"]');
    await page.waitForSelector('[data-mobile-goals="list"]');
    const goals = (await saved(page)).plan.goals;
    assert.equal(goals.filter(goal => goal.name === 'Travel').length, 1, 'A failed Save retry duplicated the new goal');
    const travel = goals.find(goal => goal.name === 'Travel');
    assert.equal(travel.amount, 30000); assert.equal(travel.per, 'mo');
    assert.equal(travel.cat, 'travel');
    assert.equal(travel.startAge, 66); assert.equal(travel.endAge, 75);
    assert.equal(goals.find(goal => goal.id === 'system:essentials').amount, 38000);
    for(const action of ['amount', 'delete', 'undo']){
      const beforeFailure = await saved(page);
      await setStorageFailure(page, true);
      if(action === 'amount') await typeInto(page, '[data-gm-inline="system:essentials"]', 40000);
      else if(action === 'delete'){
        await page.click(`[data-gm-action="open"][data-goal-id="${travel.id}"]`);
        await page.click('[data-gm-action="delete"]');
      }else await page.click('[data-gm-action="undo"]');
      await page.waitForSelector('[data-gm-action="retry-save"]');
      assert.deepEqual(await saved(page), beforeFailure);
      assert.equal(await page.$eval('.app-header', node => node.inert), true);
      assert.equal(await page.$$eval('[data-mobile-goals="list"] input', nodes => nodes.every(node => node.disabled)), true);
      assert.equal(await page.$$eval('.gm-undo', nodes => nodes.length), 0);
      await page.click('[data-gm-action="retry-save"]');
      assert.deepEqual(await saved(page), beforeFailure);
      await setStorageFailure(page, false);
      await page.click('[data-gm-action="retry-save"]');
      await page.waitForFunction(() => !document.querySelector('[data-save-pending]'));
      const afterRetry = (await saved(page)).plan.goals;
      assert.equal(afterRetry.filter(goal => goal.id === travel.id).length, action === 'delete' ? 0 : 1);
      if(action === 'amount'){
        assert.equal(afterRetry.find(goal => goal.id === 'system:essentials').amount, 40000);
        await typeInto(page, '[data-gm-inline="system:essentials"]', 38000);
      }
    }
    assert.deepEqual((await saved(page)).plan.goals, goals, 'List failure recovery changed the final Goals facts');
    await page.screenshot({ path: join(screenshotDir, 'mobile-inputs-goals.png'), fullPage: true });

    await clickPlanningTab(page, 'scenarios');
    await page.waitForFunction(async version => {
      const moduleUrl = new URL('./src/state.js', location.href); moduleUrl.searchParams.set('v', version);
      const { uiState } = await import(moduleUrl.href);
      return document.querySelector('#run-btn')?.disabled === false && uiState.plansDirty === false;
    }, { timeout: 30000 }, artifactId);
    proof.projection = await page.evaluate(async version => {
      const path = name => { const u = new URL(name, location.href); u.searchParams.set('v', version); return u.href; };
      const [engine, state] = await Promise.all([import(path('./engine.js')), import(path('./src/state.js'))]);
      const historical = engine.runHistoricalPath(engine.defaultPlan, 1995, 'taxable-first');
      return {
        rows: historical.rows.filter(row => [65, 66, 67, 75, 76].includes(row.age)).map(row => ({ age: row.age, socialSecurity: row.socialSecurity, goals: row.goals })),
        results: state.scenarios.map(s => ({ probability: s.res?.successRate, error: s.runError || null })),
        displayed: [...document.querySelectorAll('.scol__prob')].map(node => node.textContent.trim()),
      };
    }, artifactId);
    assert.deepEqual(proof.projection.rows.map(row => row.goals), [0, 30000, 30000, 30000, 0]);
    assert.deepEqual(proof.projection.rows.slice(0, 3).map(row => row.socialSecurity), [0, 0, 36000]);
    assert.equal(proof.projection.results.length, 3);
    for(const [index, result] of proof.projection.results.entries()){
      assert.equal(result.error, null); assert.ok(Number.isFinite(result.probability));
      assert.equal(proof.projection.displayed[index], `${result.probability.toFixed(1)}%`);
    }
    await clickPlanningTab(page, 'tax-buckets');
    await page.waitForSelector('[data-taw-root][aria-busy="false"]');
    await page.waitForFunction(() => document.querySelector('[data-taw-federal-tax]')?.textContent.trim() === '$5,910');
    assert.equal(await page.$eval('[data-taw-col="ord"] .taw-col-edge span', node => node.textContent.trim()), '$5,910');
    proof.visibleFederalTax = await page.$eval('[data-taw-federal-tax]', node => node.textContent.trim());

    const beforeReload = await saved(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForWizard(page, { householdId: 'joe-household' });
    await selectHouseholdVisible(page, householdId);
    assert.deepEqual(await saved(page), beforeReload);
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await clickPlanningTab(page, 'net-worth');
    await page.waitForSelector('.gh-track');
    assert.equal(await page.$$eval('.gm-page', nodes => nodes.length), 0);
    assert.deepEqual(await saved(page), beforeReload);
    assert.deepEqual(errors, []);
    await writeFile(join(screenshotDir, 'mobile-inputs-financial-proof.json'), JSON.stringify(proof, null, 2));
    console.log('Mobile inputs: saved Goals, engine outputs, visible tax and desktop/reload parity passed');
  }catch(error){
    if(page){
      await page.screenshot({ path: join(screenshotDir, 'mobile-inputs-failure.png'), fullPage: true }).catch(() => {});
      proof.visibleText = await page.evaluate(() => document.body.innerText).catch(() => 'Browser unavailable');
    }
    await writeFile(join(screenshotDir, 'mobile-inputs-failure.json'), JSON.stringify({ ...proof, error: error.stack, pageErrors: errors }, null, 2));
    throw error;
  }finally{ await context.close(); }
}

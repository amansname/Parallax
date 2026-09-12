import assert from 'node:assert/strict';
import { join } from 'node:path';
import { goToWizardStep, selectHouseholdVisible, waitForPlanCalculation, waitForWizard } from './wizard/actions.mjs';

const SOURCE_IDS = ['401k', 'roth_401k', 'traditional_ira', 'roth_ira', 'hsa', 'brokerage_taxable', 'savings'];
const amountSelector = '[data-finance-amount]';
const action = name => `[data-hh-action="${name}"]`;

async function readSaved(page, id){
  return page.evaluate(householdId => ({
    household: JSON.stringify(JSON.parse(localStorage.getItem('parallax.households.v1'))[householdId]),
    scenarios: localStorage.getItem(`parallax.scenarios.${householdId}.v1`),
  }), id);
}

async function enterAmount(page, value){
  await page.waitForSelector(amountSelector, { visible: true });
  await page.click(amountSelector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.type(amountSelector, String(value));
  await page.keyboard.press('Enter');
}

async function openEntry(page){
  if(!await page.$('[data-finance-entry-panel]')){
    await page.click('[data-finances-person-owner="client"]');
  }
  await page.click(`${action('select-finance-source')}[data-finance-type-id="401k"]`);
  await page.waitForSelector(amountSelector, { visible: true });
}

async function assertReview(page){
  await page.waitForFunction(() => document.activeElement?.matches('[data-savings-replacement-heading]'));
  const inventory = await page.evaluate(() => ({
    sources: [...document.querySelectorAll('[data-finance-type-id]')].map(el => el.dataset.financeTypeId),
    visibleSources: [...document.querySelectorAll('[data-finance-type-id]')]
      .filter(el => el.getBoundingClientRect().height > 0).map(el => el.dataset.financeTypeId),
    headings: [...document.querySelectorAll('[data-savings-replacement] h3')].map(el => el.textContent),
    buttons: [...document.querySelectorAll('[data-savings-replacement] button')].map(el => el.textContent),
    amounts: document.querySelectorAll('[data-finance-amount]').length,
    saveButtons: document.querySelectorAll('[data-hh-action="commit-finance-entry"]').length,
    summary: document.querySelector('[data-finances-summary] strong')?.textContent,
    description: document.querySelector('#hh-savings-replacement-description')?.textContent.replaceAll(/\s+/g, ' ').trim(),
  }));
  assert.deepEqual(inventory.sources, SOURCE_IDS);
  assert.deepEqual(inventory.visibleSources, []);
  assert.deepEqual(inventory.headings, ['Replace existing savings?']);
  assert.deepEqual(inventory.buttons, ['Keep current savings', 'Replace savings']);
  assert.equal(inventory.amounts, 0);
  assert.equal(inventory.saveButtons, 0);
  assert.equal(inventory.summary, '$30,000/yr');
  assert.equal(inventory.description, 'Your plan currently uses $30,000 a year. Saving this entry will replace that total with $500 a year for Savings Client · 401(k) deferral.');
}

async function assertScenarioSavings(page, expected){
  await page.click('.htab[data-page="scenarios"]');
  await waitForPlanCalculation(page);
  const result = await page.evaluate(() => ({
    savings: [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')]
      .map(el => Number(el.value.replaceAll(',', ''))),
    medians: [...document.querySelectorAll('#scn-view .scol__median b')].map(el => el.textContent.trim()),
    issues: document.querySelectorAll('#scn-view .scn-issue').length,
  }));
  assert.deepEqual(result.savings, expected);
  assert.equal(result.issues, 0);
  assert.equal(result.medians.length, expected.length);
  assert.ok(result.medians.every(value => /\d/.test(value)));
  await page.click('.htab[data-page="household"]');
  await waitForWizard(page, { step: 'family' });
  return result.medians;
}

export async function verifySavingsReplacement({ page, stableReload, screenshotDir }){
  const id = 'hh_savings_replacement';
  const priorSavings = { annual: 30_000, split: { taxable: 0, traditional: 1, roth: 0 } };
  await page.evaluate(({ householdId, savings }) => {
    const key = 'parallax.households.v1';
    const database = JSON.parse(localStorage.getItem(key));
    const record = structuredClone(database['now-household']);
    record.meta.householdId = householdId;
    record.meta.name = 'Savings Review Household';
    record.meta.primaryName = 'Savings Client';
    record.meta.spouseName = 'Savings Spouse';
    record.meta.isSelectableDefault = false;
    record.meta.isDemo = false;
    delete record.meta.runtimeSourceHouseholdId;
    record.savings = savings;
    database[householdId] = record;
    localStorage.setItem(key, JSON.stringify(database));
    localStorage.setItem(`parallax.scenarios.${householdId}.v1`, JSON.stringify([
      { name: 'Baseline', base: true, lev: { savings: 30_000 } },
      { name: 'More savings', base: false, lev: { savings: 35_000 } },
    ]));
  }, { householdId: id, savings: priorSavings });
  await stableReload({ waitUntil: 'domcontentloaded' });
  await waitForWizard(page, { householdId: 'joe-household' });
  await selectHouseholdVisible(page, id);
  await goToWizardStep(page, 'family');
  const beforeMedians = await assertScenarioSavings(page, [30_000, 35_000]);
  const before = await readSaved(page, id);
  await openEntry(page);
  await enterAmount(page, 0);
  await page.waitForFunction(() => document.querySelectorAll('[data-finance-entry-panel]').length === 0);
  assert.deepEqual(await readSaved(page, id), before, 'zero must not save household or scenarios');
  assert.equal(await page.$('[data-finance-save-status]'), null);

  await openEntry(page);
  await enterAmount(page, 500);
  await assertReview(page);
  assert.deepEqual(await readSaved(page, id), before, 'review must not save');
  const viewport = page.viewport();
  let previousWidth = viewport.width;
  for(const [width, height] of [[1920, 1080], [1279, 900], [760, 900]]){
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    if(width <= 1023 && previousWidth > 1023){
      // Entering the overlay layout closes transient finance state. Reopen
      // explicitly to verify the same confirmation controls at this width.
      await page.waitForFunction(() => document.querySelector('[data-hh-action="toggle-finances-rail"]')?.getAttribute('aria-expanded') === 'false');
      assert.deepEqual(await readSaved(page, id), before, 'responsive closure must not save');
      await page.click(action('toggle-finances-rail'));
      await openEntry(page);
      await enterAmount(page, 500);
      await assertReview(page);
    }
    previousWidth = width;
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('[data-savings-replacement]');
      const rect = panel.getBoundingClientRect();
      return {
        bodySize: getComputedStyle(panel.querySelector('p')).fontSize,
        buttonHeights: [...panel.querySelectorAll('button')].map(el => el.getBoundingClientRect().height),
        contained: [...panel.querySelectorAll('button, p')].every(el => {
          const child = el.getBoundingClientRect();
          return child.left >= rect.left && child.right <= rect.right;
        }),
        clickable: [...panel.querySelectorAll('button')].every(el => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      };
    });
    assert.equal(geometry.bodySize, '14px');
    // The approved mobile slice raises touch targets; desktop stays 40px.
    const expectedButtonHeight = width <= 760 || (width <= 1023 && height <= 500) ? 44 : 40;
    assert.deepEqual(geometry.buttonHeights, [expectedButtonHeight, expectedButtonHeight]);
    assert.equal(geometry.contained, true);
    assert.equal(geometry.clickable, true, `confirmation controls must be reachable at ${width}x${height}`);
    if(screenshotDir) await page.screenshot({ path: join(screenshotDir, `savings-review-${width}.png`) });
  }
  await page.setViewport(viewport);
  await page.click(action('cancel-savings-replacement'));
  await page.waitForFunction(() => document.activeElement?.matches('[data-finance-amount]'));
  assert.equal(await page.$eval(amountSelector, el => el.value), '500');
  assert.deepEqual(await readSaved(page, id), before, 'cancel must preserve household and scenario bytes');
  await page.keyboard.press('Enter');
  await assertReview(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.matches('[data-finance-amount]'));
  assert.deepEqual(await readSaved(page, id), before, 'Escape must preserve household and scenario bytes');
  await page.keyboard.press('Enter');
  await assertReview(page);
  await page.click(action('confirm-savings-replacement'));
  await waitForPlanCalculation(page);
  await page.waitForFunction(() => document.querySelector('[data-finances-summary] strong')?.textContent === '$500/yr');
  const accepted = await readSaved(page, id);
  const saved = JSON.parse(accepted.household);
  assert.equal(saved.savings.annual, 500);
  assert.deepEqual(saved.meta.legacyRepairArchive.at(-1).priorSavings, priorSavings);
  assert.deepEqual(saved.savings.entries.map(({ owner, typeId, amount, bucket }) => ({ owner, typeId, amount, bucket })),
    [{ owner: 'client', typeId: '401k', amount: 500, bucket: 'traditional' }]);
  assert.deepEqual(JSON.parse(accepted.scenarios).map(s => s.lev.savings), [500, 5500]);
  const afterMedians = await assertScenarioSavings(page, [500, 5500]);
  assert.notDeepEqual(afterMedians, beforeMedians, 'changed savings must reach calculated scenario outcomes');
  await page.click('[data-savings-history] summary');
  assert.equal(await page.$$eval('[data-savings-history-entry]', rows => rows.length), 1);
  assert.match(await page.$eval('[data-savings-history]', el => el.textContent), /\$30,000 to \$500/);

  await stableReload({ waitUntil: 'domcontentloaded' });
  await waitForWizard(page, { householdId: 'joe-household' });
  await selectHouseholdVisible(page, id);
  assert.equal((await readSaved(page, id)).household, accepted.household);
  await assertScenarioSavings(page, [500, 5500]);
  await openEntry(page);
  await enterAmount(page, 1000);
  await waitForPlanCalculation(page);
  assert.equal(await page.$('[data-savings-replacement]'), null);
  const edited = JSON.parse((await readSaved(page, id)).household);
  assert.equal(edited.savings.annual, 1000);
  assert.equal(edited.meta.legacyRepairArchive.length, 1);
  await assertScenarioSavings(page, [1000, 6000]);
}

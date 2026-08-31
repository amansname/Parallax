// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { goToWizardStep } from '../wizard-browser-contract.mjs';
import { waitForWizard } from '../wizard-browser-contract.mjs';
export async function verifySavedWages({
  page,
  plannerDiagnosticState,
  stableClick,
  waitForPlannerState,
  WITHDRAWAL_PLANNER_FIXTURE
}) {
  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 1
  });
  const blankPlanner = await plannerDiagnosticState();
  await stableClick('.htab[data-page="tax-buckets"]');
  await waitForPlannerState({
    afterRevision: blankPlanner.renderRevision,
    wages: '$0',
    ordinaryTax: '\u2014',
    federalTax: '\u2014',
    resultCode: 'WITHDRAWAL_CURRENT_TAX_BASELINE_UNAVAILABLE',
    incomeSourcesComplete: false
  });
  await goToWizardStep(page, 'family');
  const familyRevision = await page.$eval('[data-hh-wizard-root]', root => Number(root.dataset.renderRevision || -1));
  const [birthYear, birthMonth, birthDay] = WITHDRAWAL_PLANNER_FIXTURE.family.birthDate.split('-');
  const birthDateSelector = '[data-birth-date-group="client"] [data-birth-date-display]';
  await stableClick(birthDateSelector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(`${birthMonth} / ${birthDay} / ${birthYear}`);
  await page.keyboard.press('Tab');
  await waitForWizard(page, {
    step: 'family',
    afterRevision: familyRevision
  });
  await goToWizardStep(page, 'tax');
  const wageSelector = '[data-hh-wizard-screen="tax"] [data-tax-field="income.wages.client"]';
  const beforeEdit = await page.evaluate(selector => {
    const fields = [...document.querySelectorAll(selector)];
    const root = document.querySelector('[data-hh-wizard-root]');
    return {
      count: fields.length,
      value: fields[0]?.value ?? null,
      disabled: fields[0]?.disabled ?? null,
      revision: Number(root?.dataset.renderRevision || -1)
    };
  }, wageSelector);
  if (beforeEdit.count !== 1 || beforeEdit.value !== '' || beforeEdit.disabled !== false) {
    throw new Error(`blank Tax wizard Client wages input is not editable: ${JSON.stringify(beforeEdit)}`);
  }
  await stableClick(wageSelector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  for (const [index, digit] of [...'50000'].entries()) {
    await page.keyboard.press(digit);
    await page.waitForFunction((selector, digitCount) => {
      const value = document.querySelector(selector)?.value ?? '';
      return value.replace(/\D/g, '').length === digitCount;
    }, {
      timeout: 5000
    }, wageSelector, index + 1);
  }
  // Moving focus through Chromium exercises the production input, change, and
  // blur path instead of assigning a value or dispatching a synthetic event.
  await page.keyboard.press('Tab');
  await waitForWizard(page, {
    step: 'tax',
    afterRevision: beforeEdit.revision
  });
  const committedWages = await page.$eval(wageSelector, input => input.value);
  if (committedWages !== '50,000') {
    throw new Error(`Tax wizard did not commit Wages through change/blur: ${JSON.stringify({
      committedWages
    })}`);
  }
  const beforePlanner = await plannerDiagnosticState();
  await stableClick('.htab[data-page="tax-buckets"]');
  await waitForPlannerState({
    afterRevision: beforePlanner.renderRevision,
    wages: '$50,000',
    ordinaryTax: '$3,820',
    federalTax: '$3,820',
    resultCode: null,
    incomeSourcesComplete: false
  });
  const planner = await page.evaluate(() => ({
    wages: document.querySelector('[data-taw-fact-wages]')?.textContent.trim() ?? null,
    wageTag: document.querySelector('[data-taw-fact-wages]')?.tagName ?? null,
    legacyWageInputs: document.querySelectorAll('[data-taw-wages], input[data-taw-fact-wages]').length,
    incomeTax: document.querySelector('[data-taw-col="ord"] .taw-col-edge span')?.textContent.trim() ?? null
  }));
  if (planner.wages !== '$50,000' || planner.wageTag !== 'SPAN' || planner.legacyWageInputs !== 0 || planner.incomeTax !== '$3,820') {
    throw new Error(`Tax wizard Wages did not reach Withdrawal Planner: ${JSON.stringify(planner)}`);
  }
}

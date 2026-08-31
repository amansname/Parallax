// Wizard browser contract: tax.
import { requireCondition, requireUnique } from './assertions.mjs';
import { wizardState, waitForWizard, goToWizardStep, setWizardValue, reloadWizard } from './actions.mjs';
export async function verifyPlanningSourceAndTaxFlow(page) {
  await goToWizardStep(page, 'tax');
  const initialWages = await page.evaluate(() => {
    const client = document.querySelector('[data-tax-field="income.wages.client"]');
    const spouse = document.querySelector('[data-tax-field="income.wages.spouse"]');
    return {
      client: client?.value || '',
      spouse: spouse?.value || '',
      clientDisabled: client?.disabled === true,
      spouseDisabled: spouse?.disabled === true,
      sourceButtons: document.querySelectorAll('[data-income-group="wages"]').length
    };
  });
  requireCondition(initialWages.client === '75,000' && initialWages.spouse === '' && !initialWages.clientDisabled && !initialWages.spouseDisabled && initialWages.sourceButtons === 0, `Member wage inputs were not independent: ${JSON.stringify(initialWages)}`);
  const irmaaInputs = await page.evaluate(() => {
    const section = document.querySelector('[data-tax-input-section="irmaa-lookback"]');
    const rows = [...document.querySelectorAll('[data-irmaa-tax-year]')];
    return {
      sectionCount: document.querySelectorAll('[data-tax-input-section="irmaa-lookback"]').length,
      years: rows.map(row => row.dataset.irmaaTaxYear),
      magiFields: rows.map(row => row.querySelector('[data-tax-field$=".magi"]')?.dataset.taxField || ''),
      filingFields: rows.filter(row => row.querySelector('[data-tax-field$=".filingStatus"]')).length,
      filingFieldNames: rows.map(row => row.querySelector('[data-tax-field$=".filingStatus"]')?.dataset.taxField || ''),
      viewToggleCount: document.querySelectorAll('[data-hh-action="set-tax-view"]').length,
      view: document.querySelector('[data-hh-wizard-screen="tax"]')?.dataset.taxView || '',
      summaryBoxes: document.querySelectorAll('[data-hh-wizard-screen="tax"] [data-tax-summary-box]').length,
      frameGeometry: [...document.querySelectorAll('.hh-tax-profile > *, .hh-irmaa-lookback-row')].map(element => {
        const style = getComputedStyle(element);
        return {
          left: style.borderLeftWidth,
          right: style.borderRightWidth,
          radius: style.borderRadius
        };
      }),
      controlWidths: [document.querySelector('[data-tax-field="taxYear"]'), document.querySelector('[data-tax-field="deductionMode"]'), ...rows.map(row => row.querySelector('[data-tax-field$=".magi"]'))].map(element => Math.round(element?.getBoundingClientRect().width || 0)),
      outputCopy: /Current tier|Next tier|To next tier|Premium year/i.test(section?.textContent || '')
    };
  });
  requireCondition(irmaaInputs.sectionCount === 1 && JSON.stringify(irmaaInputs.years) === JSON.stringify(['2024', '2025']) && JSON.stringify(irmaaInputs.magiFields) === JSON.stringify(['irmaa.lookback.2024.magi', 'irmaa.lookback.2025.magi']) && irmaaInputs.filingFields === 0 && JSON.stringify(irmaaInputs.filingFieldNames) === JSON.stringify(['', '']) && irmaaInputs.viewToggleCount === 0 && irmaaInputs.view === 'detailed' && irmaaInputs.summaryBoxes === 5 && irmaaInputs.frameGeometry.every(frame => frame.left === '0px' && frame.right === '0px' && frame.radius === '0px') && irmaaInputs.controlWidths.length === 4 && irmaaInputs.controlWidths[0] >= 288 && irmaaInputs.controlWidths[0] <= 290 && irmaaInputs.controlWidths[1] >= 288 && irmaaInputs.controlWidths[1] <= 290 && irmaaInputs.controlWidths.slice(2).every(width => width >= 127 && width <= 129) && Math.abs(irmaaInputs.controlWidths[2] - irmaaInputs.controlWidths[3]) <= 1 && !irmaaInputs.outputCopy, `Tax IRMAA lookback is not input-only: ${JSON.stringify(irmaaInputs)}`);
  await setWizardValue(page, '[data-tax-field="irmaa.lookback.2024.magi"]', '218000');
  const persistedIrmaaInput = await page.$eval('[data-tax-field="irmaa.lookback.2024.magi"]', control => control.value);
  requireCondition(persistedIrmaaInput === '218,000', `IRMAA lookback MAGI did not survive the production edit path: "${persistedIrmaaInput}"`);
  await reloadWizard(page);
  await goToWizardStep(page, 'tax');
  const reloadedIrmaaInput = await page.$eval('[data-tax-field="irmaa.lookback.2024.magi"]', control => control.value);
  requireCondition(reloadedIrmaaInput === '218,000', `IRMAA lookback MAGI did not survive reload: "${reloadedIrmaaInput}"`);
  await goToWizardStep(page, 'summary');
  const derivedSummary = await page.evaluate(() => {
    const table = document.querySelector('table[data-summary-irmaa]');
    const rect = table?.getBoundingClientRect();
    const headers = [...(table?.querySelectorAll('thead th') || [])].map(cell => cell.textContent.trim());
    const rows = [...(table?.querySelectorAll('tbody tr') || [])].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim()));
    return {
      removedMetricCount: document.querySelectorAll('[data-summary-metric="income"], [data-summary-metric="federal-tax"]').length,
      tableCount: document.querySelectorAll('table[data-summary-irmaa]').length,
      headers,
      rows,
      width: rect?.width || 0,
      directScreenChild: table?.parentElement?.matches('[data-hh-wizard-screen="summary"]') === true,
      captionCount: table?.querySelectorAll('caption').length || 0
    };
  });
  requireCondition(derivedSummary.removedMetricCount === 0, `Summary restored removed income or federal-tax headlines: ${JSON.stringify(derivedSummary)}`);
  requireCondition(derivedSummary.tableCount === 1 && JSON.stringify(derivedSummary.headers) === JSON.stringify(['Item', 'Value']) && JSON.stringify(derivedSummary.rows.map(row => row[0])) === JSON.stringify(['MAGI', 'Current tier', 'To next tier', 'Premium year']) && /^\$[\d,]+$/.test(derivedSummary.rows[0]?.[1] || '') && /^\d+$/.test(derivedSummary.rows[1]?.[1] || '') && /^(\$[\d,]+|—)$/.test(derivedSummary.rows[2]?.[1] || '') && derivedSummary.rows[3]?.[1] === '2028' && derivedSummary.width >= 480 && derivedSummary.width <= 560 && derivedSummary.directScreenChild && derivedSummary.captionCount === 1, `Summary IRMAA table drifted from the compact Item/Value contract: ${JSON.stringify(derivedSummary)}`);
  const summaryContinueSelector = '#hh-wiz-footer [data-hh-action="step-next"]';
  await goToWizardStep(page, 'tax');
  const continueSelector = '#hh-wiz-footer [data-hh-action="step-next"]';
  const beforeContinue = await wizardState(page);
  await page.click(continueSelector);
  await waitForWizard(page, {
    step: 'summary',
    afterRevision: beforeContinue.revision
  });
  const taxUi = await page.evaluate(() => ({
    confirmationCount: document.querySelectorAll('[data-tax-confirmation]').length,
    readiness: document.querySelector('[data-tax-readiness]')?.dataset.taxReadiness || ''
  }));
  requireCondition(taxUi.confirmationCount === 0, `Tax confirmation checkbox should be removed: ${JSON.stringify(taxUi)}`);
  await goToWizardStep(page, 'tax');
  await setWizardValue(page, '[data-tax-field="income.wages.client"]', '81000');
  await setWizardValue(page, '[data-tax-field="income.wages.spouse"]', '39000');
  const unifiedTax = await page.evaluate(() => ({
    view: document.querySelector('[data-hh-wizard-screen="tax"]')?.dataset.taxView || '',
    clientWages: document.querySelector('[data-tax-field="income.wages.client"]')?.value || '',
    spouseWages: document.querySelector('[data-tax-field="income.wages.spouse"]')?.value || '',
    toggleCount: document.querySelectorAll('[data-hh-action="set-tax-view"]').length,
    socialSecuritySource: document.querySelectorAll('[data-tax-field="socialSecurity.mode"]').length
  }));
  requireCondition(unifiedTax.view === 'detailed' && unifiedTax.clientWages === '81,000' && unifiedTax.spouseWages === '39,000' && unifiedTax.toggleCount === 0 && unifiedTax.socialSecuritySource === 1, `Unified Tax view lost state: ${JSON.stringify(unifiedTax)}`);
  await setWizardValue(page, '[data-tax-field="deductionMode"]', 'itemized-details');
  const itemizedCopy = await page.evaluate(() => document.querySelector('.hh-itemized-section')?.textContent.replace(/\s+/g, ' ').trim() || '');
  requireCondition(/raw eligible amount before the 7\.5% AGI floor/i.test(itemizedCopy) && /raw eligible amount before the federal SALT limit/i.test(itemizedCopy) && /deductible amount after any category-specific limits/i.test(itemizedCopy), `Itemized input semantics are unclear: "${itemizedCopy}"`);
  const beforeBlankItemizedContinue = await wizardState(page);
  await page.click(continueSelector);
  await waitForWizard(page, {
    step: 'summary',
    afterRevision: beforeBlankItemizedContinue.revision
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
      other: deductions?.itemized?.otherItemizedDeductions
    };
  });
  requireCondition(blankItemized.method === 'itemized' && blankItemized.source === 'calculated' && blankItemized.medical === 0 && blankItemized.salt === 0 && blankItemized.saltMagi === 0 && blankItemized.mortgage === 0 && blankItemized.charitable === 0 && blankItemized.other === 0, `Blank itemized amounts did not continue as zero: ${JSON.stringify(blankItemized)}`);
  await goToWizardStep(page, 'tax');
  await setWizardValue(page, '[data-tax-field="deductionMode"]', 'standard');
  const readiness = await page.evaluate(() => ({
    readiness: document.querySelector('[data-tax-readiness]')?.dataset.taxReadiness || '',
    confirmationCount: document.querySelectorAll('[data-tax-confirmation]').length
  }));
  requireCondition(readiness.readiness === 'ready' && readiness.confirmationCount === 0, `Tax readiness did not derive an estimate: ${JSON.stringify(readiness)}`);
  await goToWizardStep(page, 'summary');
  const afterSummary = await page.evaluate(() => ({
    removedMetricCount: document.querySelectorAll('[data-summary-metric="income"], [data-summary-metric="federal-tax"]').length
  }));
  requireCondition(afterSummary.removedMetricCount === 0, `Summary restored removed income or federal-tax headlines: ${JSON.stringify(afterSummary)}`);
  await requireUnique(page, summaryContinueSelector, 'completed Summary Continue to Goals action');
  await page.click(summaryContinueSelector);
  await page.waitForFunction(() => document.querySelector('.page.on')?.dataset.page === 'net-worth' && document.querySelector('.htab.is-active')?.dataset.subTarget === 'goals', {
    timeout: 8000
  });
  const planningPage = await page.evaluate(() => ({
    page: document.querySelector('.page.on')?.dataset.page || '',
    subTarget: document.querySelector('.htab.is-active')?.dataset.subTarget || ''
  }));
  requireCondition(planningPage.page === 'net-worth' && planningPage.subTarget === 'goals', `Completed Summary did not enter Goals: ${JSON.stringify(planningPage)}`);
}

import { waitForUnselectedWizard } from '../../wizard-browser-contract.mjs';
import { selectHouseholdVisible } from '../../wizard-browser-contract.mjs';
export async function prepareCashFlowFixture({
  page,
  withdrawalPlannerFixtureHouseholdId,
  stableReload,
  stableClick,
  errs,
  setCashFlow,
  waitCashRows
}) {
  await page.evaluate(householdId => {
    const key = 'parallax.households.v1';
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    const household = db[householdId];
    if (!household) return;
    household.meta.primaryName = 'Test Client';
    household.meta.spouseName = 'Test Co-Client';
    household.meta.filingStatus = 'marriedFilingJointly';
    household.household.primary = {
      currentAge: 64,
      retirementAge: 66,
      planEndAge: 96,
      birthYear: 1962
    };
    household.household.spouse = {
      currentAge: 63,
      retirementAge: 65,
      planEndAge: 95,
      birthYear: 1963
    };
    household.portfolio.accounts = {
      taxable: {
        balance: 0,
        basisPct: 1
      },
      traditional: {
        balance: 0
      },
      roth: {
        balance: 0
      }
    };
    household.portfolio.extraAccounts = [{
      type: 'Traditional IRA',
      bucket: 'traditional',
      owner: 'client',
      balance: 1600000
    }, {
      type: 'Brokerage (taxable)',
      bucket: 'taxable',
      owner: 'spouse',
      balance: 800000
    }, {
      type: 'Roth IRA',
      bucket: 'roth',
      owner: 'spouse',
      balance: 400000
    }];
    delete household.meta.accountSchemaVersion;
    delete household.meta.householdRecordSchemaVersion;
    localStorage.setItem(key, JSON.stringify(db));
    localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
  }, withdrawalPlannerFixtureHouseholdId);
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForUnselectedWizard(page);
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  try {
    await page.waitForFunction(() => {
      const buttons = document.querySelectorAll('#run-btn');
      const status = document.querySelector('#status')?.textContent.trim() || '';
      return buttons.length === 1 && !buttons[0].disabled && !/Running/i.test(status) && /Plan updated|Partial run/i.test(status);
    }, {
      timeout: 30000
    });
  } catch (error) {
    const observed = await page.evaluate(() => ({
      runButtonCount: document.querySelectorAll('#run-btn').length,
      runButtonDisabled: document.querySelector('#run-btn')?.disabled ?? null,
      status: document.querySelector('#status')?.textContent.trim() ?? null
    }));
    throw new Error(`Cash Flow Run baseline did not settle: ${JSON.stringify({
      observed,
      consoleErrors: errs
    })}; ${error.message || error}`);
  }
  await page.$eval('#run-btn', button => {
    const status = document.querySelector('#status');
    const baselineStatus = status?.textContent.trim() || '';
    if (button.disabled || /Running/i.test(baselineStatus)) {
      throw new Error(`Run action baseline is not settled: ${JSON.stringify({
        baselineStatus,
        buttonDisabled: button.disabled
      })}`);
    }
    const tracker = {
      baselineStatus,
      observed: [],
      sawRunning: false,
      sawDisabled: false,
      observer: null
    };
    const record = () => {
      const value = status?.textContent.trim() || '';
      if (tracker.observed.at(-1) !== value) tracker.observed.push(value);
      if (/Running/i.test(value)) tracker.sawRunning = true;
      if (button.disabled) tracker.sawDisabled = true;
    };
    tracker.observer = new MutationObserver(record);
    if (status) {
      tracker.observer.observe(status, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }
    tracker.observer.observe(button, {
      attributes: true,
      attributeFilter: ['disabled']
    });
    globalThis.__parallaxVerifyCashFlowRunTracker = tracker;
    button.click();
    record();
    tracker.postClickStatus = status?.textContent.trim() || '';
    tracker.postClickDisabled = button.disabled;
    if (tracker.postClickStatus !== 'Running…' || tracker.postClickDisabled !== true) {
      tracker.observer.disconnect();
      delete globalThis.__parallaxVerifyCashFlowRunTracker;
      throw new Error(`Run action did not synchronously enter Running: ${JSON.stringify({
        baselineStatus,
        postClickStatus: tracker.postClickStatus,
        postClickDisabled: tracker.postClickDisabled
      })}`);
    }
  });
  let cashFlowRunError = null;
  try {
    await page.waitForFunction(() => {
      const tracker = globalThis.__parallaxVerifyCashFlowRunTracker;
      const status = document.querySelector('#status')?.textContent.trim() || '';
      const button = document.querySelector('#run-btn');
      return tracker?.sawRunning === true && tracker.sawDisabled === true && button && !button.disabled && /Plan updated|Partial run/i.test(status);
    }, {
      timeout: 30000
    });
  } catch (error) {
    cashFlowRunError = error;
  }
  const cashFlowRunDiagnostic = await page.evaluate(() => {
    const tracker = globalThis.__parallaxVerifyCashFlowRunTracker;
    tracker?.observer?.disconnect();
    const diagnostic = {
      baselineStatus: tracker?.baselineStatus ?? null,
      postClickStatus: tracker?.postClickStatus ?? null,
      postClickDisabled: tracker?.postClickDisabled ?? null,
      sawRunning: tracker?.sawRunning === true,
      sawDisabled: tracker?.sawDisabled === true,
      observedStatuses: tracker?.observed ?? [],
      finalStatus: document.querySelector('#status')?.textContent.trim() ?? null,
      runButtonCount: document.querySelectorAll('#run-btn').length,
      runButtonDisabled: document.querySelector('#run-btn')?.disabled ?? null
    };
    delete globalThis.__parallaxVerifyCashFlowRunTracker;
    return diagnostic;
  });
  if (cashFlowRunError) {
    throw new Error(`Cash Flow Run did not reach its observable completion state: ${JSON.stringify({
      observed: cashFlowRunDiagnostic,
      consoleErrors: errs
    })}; ${cashFlowRunError.message || cashFlowRunError}`);
  }
  await page.click('button[data-page="scenarios"]');
  await setCashFlow(page, true);
  await waitCashRows(page, 10);
}

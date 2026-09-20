import { waitForWizard } from '../../wizard-browser-contract.mjs';
import { selectHouseholdVisible } from '../../wizard-browser-contract.mjs';
export async function prepareCashFlowFixture({
  page,
  withdrawalPlannerFixtureHouseholdId,
  cashFlowBaseline,
  stableReload,
  stableClick,
  errs,
  setCashFlow,
  waitCashRows
}) {
  if (!cashFlowBaseline?.household?.primary || !cashFlowBaseline.household.spouse) {
    throw new Error('Cash Flow requires its captured two-person entry baseline');
  }
  const expectedPeople = {
    primary: { currentAge: 64, retirementAge: 66, planEndAge: 96, birthYear: 1962 },
    spouse: { currentAge: 63, retirementAge: 64, planEndAge: 95, birthYear: 1963 }
  };
  await page.evaluate(({ householdId, baseline, people }) => {
    const key = 'parallax.households.v1';
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    if (!db[householdId]) throw new Error(`Cash Flow fixture household is missing: ${householdId}`);
    const household = structuredClone(baseline);
    db[householdId] = household;
    household.meta.primaryName = 'Test Client';
    household.meta.spouseName = 'Test Co-Client';
    household.meta.filingStatus = 'marriedFilingJointly';
    household.household.primary = people.primary;
    household.household.spouse = people.spouse;
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
    // Clean fixture: one spouse retires a year before the client.
    household.savings = {
      annual: 40000,
      split: { traditional: 0.5, roth: 0.5, taxable: 0 },
      entries: [
        { id: 'cf-client-saving', owner: 'client', typeId: 'traditional_ira', bucket: 'traditional', amount: 20000 },
        { id: 'cf-spouse-saving', owner: 'spouse', typeId: 'roth_ira', bucket: 'roth', amount: 20000 },
      ],
    };
    // One retirement-income year makes the existing saved-household campaign
    // exercise F01 surplus crediting as well as its withdrawal years.
    household.income.other.push({
      id: 'cf-retirement-surplus', owner: 'client', label: 'Retirement income',
      amount: 500000, startAge: 66, endAge: 66, realGrowth: 0, taxablePct: 1,
    });
    delete household.meta.accountSchemaVersion;
    delete household.meta.householdRecordSchemaVersion;
    localStorage.setItem(key, JSON.stringify(db));
    localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
  }, { householdId: withdrawalPlannerFixtureHouseholdId, baseline: cashFlowBaseline, people: expectedPeople });
  await stableReload({
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
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
    })}; ${error.message || error}`, { cause: error });
  }
  // This settled fixture has no changed inputs. Run must complete from its
  // accepted results immediately; the handler still traverses Running within
  // the same task. Record attribute transitions instead of demanding a delay.
  await page.$eval('#run-btn', button => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {});
    observer.observe(root, { attributes: true, attributeFilter: ['data-scenario-run-state'], attributeOldValue: true });
    button.click();
    const states = observer.takeRecords().map(record => record.oldValue);
    observer.disconnect();
    const state = root.dataset.scenarioRunState;
    const status = document.querySelector('#status')?.textContent.trim() || '';
    if (!states.includes('running') || state !== 'complete' || button.disabled || !/^Plan updated/.test(status)) {
      throw new Error('Unchanged Run did not synchronously complete from current results: ' + JSON.stringify({ states, state, status, disabled: button.disabled }));
    }
  });
  await page.click('button[data-page="scenarios"]');
  await setCashFlow(page, true);
  await waitCashRows(page, 10);
  return expectedPeople;
}

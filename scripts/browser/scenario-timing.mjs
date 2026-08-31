// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { goToWizardStep } from '../wizard-browser-contract.mjs';
import { waitForUnselectedWizard } from '../wizard-browser-contract.mjs';
import { selectHouseholdVisible } from '../wizard-browser-contract.mjs';
export async function verifyRetirementRelativeGoals({
  page,
  stableClick,
  withdrawalPlannerFixtureHouseholdId,
  WITHDRAWAL_PLANNER_FIXTURE
}) {
  const contract = await page.evaluate(() => {
    const retirementAges = {};
    document.querySelectorAll('#scn-view .cmp-step-btn[data-lever-key="retireAge"][data-dir="1"][data-scn-id]').forEach(button => {
      const text = button.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent || '';
      retirementAges[button.dataset.scnId] = Number(text.match(/\d+/)?.[0]);
    });
    const scenarioCount = Object.keys(retirementAges).length;
    const rows = [...document.querySelectorAll('#scn-view .goal-detail__name')].filter(element => ['Essentials', 'Healthcare'].includes(element.textContent.trim())).map(nameElement => {
      const gutter = nameElement.closest('.goal-detail');
      const cells = [];
      let cell = gutter?.nextElementSibling;
      while (cell?.classList.contains('cell--goal-detail') && cells.length < scenarioCount) {
        const input = cell.querySelector('[data-goal-field="startAge"]');
        cells.push({
          scnId: input?.dataset.scnId ?? null,
          goalIdx: input?.dataset.goalIdx ?? null,
          value: input?.value ?? null,
          overridden: cell.classList.contains('is-overridden')
        });
        cell = cell.nextElementSibling;
      }
      return {
        name: nameElement.textContent.trim(),
        baseMeta: gutter?.querySelector('.goal-detail__meta')?.textContent.trim() ?? null,
        cells
      };
    });
    const inputsContainUndefined = [...document.querySelectorAll('#scn-view input')].some(input => input.value === 'undefined');
    return {
      retirementAges,
      rows,
      containsUndefined: document.querySelector('#scn-view')?.textContent.includes('undefined') || inputsContainUndefined
    };
  });
  const scenarioCount = Object.keys(contract.retirementAges).length;
  if (contract.containsUndefined || scenarioCount < 2 || contract.rows.length !== 2) {
    const diagnostic = await page.evaluate(() => {
      const active = localStorage.getItem('parallax.activeHouseholdId');
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return {
        active,
        household: db?.[active]?.household ?? null,
        leverNames: [...document.querySelectorAll('#scn-view .lever__name')].map(element => element.textContent.trim()),
        stepButtons: [...document.querySelectorAll('#scn-view .cmp-step-btn')].map(button => ({
          key: button.dataset.leverKey ?? null,
          scenarioId: button.dataset.scnId ?? null,
          dir: button.dataset.dir ?? null
        }))
      };
    });
    throw new Error(`retirement-relative goal contract is incomplete: ${JSON.stringify({
      contract,
      diagnostic
    })}`);
  }
  contract.rows.forEach(row => {
    if (row.cells.length !== scenarioCount || !row.baseMeta?.includes(`age ${row.cells[0].value}`) || row.cells.some(cell => Number(cell.value) !== contract.retirementAges[cell.scnId])) {
      throw new Error(`retirement-relative goal ages are unresolved: ${JSON.stringify(contract)}`);
    }
  });
  const targetRow = contract.rows.find(row => row.name === 'Healthcare') || contract.rows[0];
  const target = targetRow.cells.find((cell, index) => index > 0 && !cell.overridden);
  if (!target) throw new Error(`retirement-relative edit target is missing: ${JSON.stringify(contract)}`);
  const originalAge = Number(target.value);
  const editedAge = originalAge + 1;
  const selector = `#scn-view .cmp-goal-in[data-scn-id="${target.scnId}"][data-goal-idx="${target.goalIdx}"][data-goal-field="startAge"]`;
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(editedAge));
  await page.keyboard.press('Tab');
  try {
    await page.waitForFunction(({
      selector,
      editedAge
    }) => {
      const input = document.querySelector(selector);
      return input?.value === String(editedAge) && input.closest('.cell--goal-detail')?.classList.contains('is-overridden');
    }, {
      timeout: 15000
    }, {
      selector,
      editedAge
    });
  } catch (error) {
    const observed = await page.evaluate(({
      selector,
      scenarioId
    }) => {
      const input = document.querySelector(selector);
      const active = localStorage.getItem('parallax.activeHouseholdId');
      return {
        active,
        rootHouseholdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
        status: document.querySelector('#status')?.textContent.trim() || '',
        activePage: document.querySelector('.page.on')?.dataset.page || '',
        value: input?.value ?? null,
        focused: document.activeElement === input,
        overridden: input?.closest('.cell--goal-detail')?.classList.contains('is-overridden') || false,
        editedMarkerCount: input?.closest('.cell--goal-detail')?.querySelectorAll('.cmp-goal-edited').length ?? null,
        scenarioStorage: localStorage.getItem(`parallax.scenarios.${active}.v1`),
        targetScenarioId: scenarioId
      };
    }, {
      selector,
      scenarioId: target.scnId
    });
    throw new Error(`retirement-relative goal edit did not commit: ${JSON.stringify(observed)}; ${error.message}`);
  }
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(originalAge));
  await page.keyboard.press('Tab');
  await page.waitForFunction(({
    selector,
    originalAge
  }) => {
    const input = document.querySelector(selector);
    const cell = input?.closest('.cell--goal-detail');
    return input?.value === String(originalAge) && !cell?.classList.contains('is-overridden') && !cell?.querySelector('.cmp-goal-edited');
  }, {
    timeout: 10000
  }, {
    selector,
    originalAge
  });
  await stableClick('.htab[data-page="household"]');
  await waitForWizard(page, {
    householdId: withdrawalPlannerFixtureHouseholdId
  });
  await goToWizardStep(page, 'family');
  const restoreRetirementRevision = await page.$eval('[data-hh-wizard-root]', root => Number(root.dataset.renderRevision || -1));
  await stableClick('[data-wizard-field="client.retirementAge"]');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(WITHDRAWAL_PLANNER_FIXTURE.family.retirementAge));
  await page.keyboard.press('Tab');
  await waitForWizard(page, {
    step: 'family',
    afterRevision: restoreRetirementRevision
  });
  const cleanupRevision = await page.$eval('[data-hh-wizard-root]', root => Number(root.dataset.renderRevision || -1));
  page.once('dialog', dialog => dialog.accept());
  await stableClick('[data-hh-action="remove-spouse"]');
  await waitForWizard(page, {
    step: 'family',
    afterRevision: cleanupRevision
  });
  const restoredSingle = await page.evaluate(() => ({
    filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value ?? null,
    spouseCards: document.querySelectorAll('[data-person-owner="spouse"]').length
  }));
  if (restoredSingle.filingStatus !== 'single' || restoredSingle.spouseCards !== 0) {
    throw new Error(`dual-client retirement fixture did not restore: ${JSON.stringify(restoredSingle)}`);
  }
}
export async function verifyPlanningAgeLimits({
  page,
  withdrawalPlannerFixtureHouseholdId,
  stableReload,
  stableClick
}) {
  await page.evaluate(householdId => {
    const key = 'parallax.households.v1';
    const db = JSON.parse(localStorage.getItem(key) || '{}');
    const household = db[householdId];
    if (!household) return;
    household.meta.filingStatus = 'marriedFilingJointly';
    household.household.primary = {
      currentAge: 64,
      retirementAge: 66,
      planEndAge: 80,
      birthYear: 1962
    };
    household.household.spouse = {
      currentAge: 60,
      retirementAge: 65,
      planEndAge: 100,
      birthYear: 1966
    };
    household.income.socialSecurity.spouse = {
      pia: null,
      claimAge: 67
    };
    household.portfolio.accounts = {
      taxable: {
        ...household.portfolio.accounts.taxable,
        balance: 50000000,
        basisPct: 1
      },
      traditional: {
        ...household.portfolio.accounts.traditional,
        balance: 0
      },
      roth: {
        ...household.portfolio.accounts.roth,
        balance: 0
      }
    };
    household.portfolio.extraAccounts = [];
    localStorage.setItem(key, JSON.stringify(db));
    localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
    localStorage.removeItem('parallax.cashFlowPath.v1');
  }, withdrawalPlannerFixtureHouseholdId);
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForUnselectedWizard(page);
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  await page.click('.htab[data-sub-target="goals"]');
  await page.waitForSelector('.gh-page', {
    visible: true,
    timeout: 8000
  });
  const horizon = await page.evaluate(() => ({
    terminalTick: [...document.querySelectorAll('.gh-tick')].at(-1)?.textContent.trim() || '',
    axisMax: document.querySelector('.gh-lanes')?.getAttribute('data-axis-max') || ''
  }));
  if (horizon.terminalTick !== '100' || horizon.axisMax !== '101') {
    throw new Error(`entered planning age did not cap the Goals horizon: ${JSON.stringify(horizon)}`);
  }
  await page.$eval('#run-btn', button => button.click());
  await page.waitForFunction(() => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  });
  await page.click('button[data-page="scenarios"]');
  await page.waitForSelector('#scn-view', {
    visible: true,
    timeout: 8000
  });
  await page.click('#scn-seg-focus');
  await page.waitForFunction(() => !!document.querySelector('#scn-view .focus .viability__text'), {
    timeout: 8000
  });
  const viability = await page.$eval('#scn-view .focus .viability__text', element => element.textContent.trim());
  if (viability !== 'Funds last to age 100') {
    throw new Error(`entered planning age did not cap the Focus result: "${viability}"`);
  }
}
export async function verifyRetiredAgeLever({
  stableEvaluate,
  stableClick,
  page
}) {
  const leverNames = () => stableEvaluate('read scenario lever names', () => [...document.querySelectorAll('#scn-view .lever__name')].map(e => e.textContent.trim()));

  // Pre-retirement fixture (Client 1 64/retire 66, Client 2 63/retire 65):
  // both per-person retirement ages are active Scenarios levers.
  await stableClick('button[data-page="scenarios"]');
  await stableClick('#scn-seg-compare');
  await page.waitForSelector('#scn-view .lever__name', {
    timeout: 10000
  });
  const beforeNames = await leverNames();
  const expectedRetirementLevers = ['Client 1 Retirement', 'Client 2 Retirement'];
  const missingRetirementLevers = expectedRetirementLevers.filter(name => !beforeNames.includes(name));
  if (missingRetirementLevers.length) throw new Error(`Per-person retirement levers should be present while pre-retirement: ${JSON.stringify({
    missingRetirementLevers,
    beforeNames
  })}`);

  // Make BOTH principals already retired (retire age below current age).
  const setFamilyField = async (field, value) => {
    const beforeRevision = await page.$eval('[data-hh-wizard-root]', element => Number(element.dataset.renderRevision));
    await stableEvaluate(`set Family field ${field}`, ({
      field,
      value
    }) => {
      const control = document.querySelector(`[data-hh-wizard-screen="family"] [data-hh-field="${field}"]`);
      if (!control) throw new Error(`missing Family field: ${field}`);
      control.value = value;
      control.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }, {
      field,
      value
    });
    await waitForWizard(page, {
      step: 'family',
      afterRevision: beforeRevision
    });
  };
  await goToWizardStep(page, 'family');
  await setFamilyField('client.retirementAge', '60');
  await setFamilyField('spouse.retirementAge', '60');

  // Now both retirement-age levers must DROP OUT of the Scenarios levers (they
  // are no longer decisions to pull), while the other levers remain.
  await stableClick('button[data-page="scenarios"]');
  await stableClick('#scn-seg-compare');
  try {
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('#scn-view .lever__name')].map(element => element.textContent.trim());
      return names.includes('Allocation') && !names.includes('Client 1 Retirement') && !names.includes('Client 2 Retirement');
    }, {
      timeout: 10000
    });
  } catch (error) {
    const observed = await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      const active = localStorage.getItem('parallax.activeHouseholdId');
      const household = db?.[active]?.household || {};
      return {
        names: [...document.querySelectorAll('#scn-view .lever__name')].map(element => element.textContent.trim()),
        primary: household.primary ? {
          currentAge: household.primary.currentAge,
          retirementAge: household.primary.retirementAge
        } : null,
        spouse: household.spouse ? {
          currentAge: household.spouse.currentAge,
          retirementAge: household.spouse.retirementAge
        } : null
      };
    });
    throw new Error(`Retired-household lever state did not settle: ${JSON.stringify(observed)}. ${error.message}`);
  }
  const afterNames = await leverNames();
  const remainingRetirementLevers = expectedRetirementLevers.filter(name => afterNames.includes(name));
  if (remainingRetirementLevers.length) throw new Error(`Per-person retirement levers must disappear once already retired: ${JSON.stringify({
    remainingRetirementLevers,
    afterNames
  })}`);
  if (!afterNames.includes('Allocation')) throw new Error(`other levers (Allocation) must remain when retired: ${JSON.stringify(afterNames)}`);

  // Restore the edited fields explicitly; saved data is never reset implicitly.
  await goToWizardStep(page, 'family');
  await setFamilyField('client.retirementAge', '66');
  await setFamilyField('spouse.retirementAge', '65');
}

// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForUnselectedWizard } from '../wizard-browser-contract.mjs';
import { selectHouseholdVisible } from '../wizard-browser-contract.mjs';
import { join } from 'node:path';
import { resetSeed } from '../../engine.js';
import { resolveInputs } from '../../engine.js';
import { generateReturnPath } from '../../engine.js';
import { runSimulation } from '../../engine.js';
import { runMonteCarloWithFederalFunding } from '../../src/planning/tax/runMonteCarloWithFederalFunding.js';
export async function verifyFundingAcrossGoals({
  page,
  withdrawalPlannerFixtureHouseholdId,
  stableReload,
  stableClick,
  setCashFlow,
  OUT
}) {
  const goalName = 'Funding truth goal';
  await page.evaluate(({
    householdId,
    goalName
  }) => {
    const storageKey = 'parallax.households.v1';
    const db = JSON.parse(localStorage.getItem(storageKey) || '{}');
    const plan = db[householdId];
    if (!plan) throw new Error('saved household is unavailable for the funding-truth fixture');
    const currentYear = new Date().getFullYear();
    plan.meta = {
      ...(plan.meta || {}),
      primaryName: 'Funding Truth Fixture',
      spouseName: '',
      filingStatus: 'single',
      spendingSchemaVersion: 1
    };
    plan.household = {
      primary: {
        currentAge: 64,
        retirementAge: 67,
        planEndAge: 67,
        birthYear: currentYear - 64
      },
      spouse: null,
      children: []
    };
    plan.portfolio = {
      ...(plan.portfolio || {}),
      riskProfile: 3,
      withdrawalStrategy: 'taxable-first',
      accounts: {
        taxable: {
          ...plan.portfolio.accounts.taxable,
          balance: 50000,
          basisPct: 1
        },
        traditional: {
          ...plan.portfolio.accounts.traditional,
          balance: 0
        },
        roth: {
          ...plan.portfolio.accounts.roth,
          balance: 0
        }
      },
      extraAccounts: []
    };
    plan.savings = {
      ...(plan.savings || {}),
      annual: 10000
    };
    plan.income = {
      socialSecurity: {
        primary: {
          pia: 0,
          claimAge: 70
        },
        spouse: null
      },
      pension: {
        benefitByAge: {},
        base: 0,
        startAge: 99,
        colaPct: 0
      },
      other: []
    };
    plan.expenses = {
      living: 0,
      housing: 0,
      debt: 0,
      healthcare: 0,
      healthcareRealGrowth: 0,
      extra: []
    };
    plan.liabilities = [];
    plan.properties = [];
    plan.goals = [{
      id: 'verify_funding_truth_goal',
      name: goalName,
      cat: 'education',
      area: 'education',
      amount: 10000,
      per: 'yr',
      startAge: 64,
      endAge: 65,
      realGrowth: 0,
      fundFromPortfolioBeforeRetirement: false
    }];
    plan.ltc = {
      amount: 0,
      onsetAge: 99
    };
    plan.taxes = {
      ordinary: 0,
      capitalGains: 0
    };
    plan.simulation = {
      ...(plan.simulation || {}),
      iterations: 40
    };
    db[householdId] = plan;
    localStorage.setItem(storageKey, JSON.stringify(db));
    localStorage.setItem('parallax.activeHouseholdId', householdId);
    localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
    localStorage.removeItem('parallax.pathReplay.v1');
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    goalName
  });
  await stableReload({
    waitUntil: 'networkidle0'
  });
  await waitForUnselectedWizard(page);
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  const openFundingGoal = async ({
    keyboard = false
  } = {}) => {
    await stableClick('.htab[data-page="household"]');
    await stableClick('.htab[data-sub-target="goals"]');
    await page.waitForFunction(({
      id,
      name
    }) => {
      const chips = [...document.querySelectorAll(`[data-goal-chip="${id}"]`)];
      const names = [...document.querySelectorAll('.gh-chip__name')].filter(element => element.textContent.trim() === name);
      return chips.length === 1 && names.length === 1;
    }, {
      timeout: 8000
    }, {
      id: 'verify_funding_truth_goal',
      name: goalName
    });
    if (keyboard) {
      await page.focus('[data-goal-chip="verify_funding_truth_goal"]');
      await page.keyboard.press('Enter');
    } else {
      await stableClick('[data-goal-chip="verify_funding_truth_goal"]');
    }
    await page.waitForFunction(() => document.querySelectorAll('.gh-rail').length === 1 && document.querySelectorAll('.gh-rail [data-action="fund-portfolio"]').length === 1, {
      timeout: 8000
    });
  };
  const runAndReadBaselineProbability = async () => {
    await page.waitForSelector('#run-btn:not([disabled])', {
      timeout: 10000
    });
    await page.$eval('#run-btn', button => button.click());
    await page.waitForFunction(() => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
      timeout: 30000
    });
    await stableClick('button[data-page="scenarios"]');
    await stableClick('#scn-seg-compare');
    await page.waitForFunction(() => {
      const baselines = [...document.querySelectorAll('#scn-view .scol')].filter(column => column.querySelector('.scol__name')?.textContent.trim() === 'Baseline');
      return baselines.length === 1 && baselines[0].querySelectorAll('.scol__prob').length === 1 && /\d/.test(baselines[0].querySelector('.scol__prob').textContent || '');
    }, {
      timeout: 15000
    });
    return page.evaluate(() => {
      const baselines = [...document.querySelectorAll('#scn-view .scol')].filter(column => column.querySelector('.scol__name')?.textContent.trim() === 'Baseline');
      if (baselines.length !== 1 || baselines[0].querySelectorAll('.scol__prob').length !== 1) {
        throw new Error(`expected one Baseline probability, found ${baselines.length}`);
      }
      return Number.parseFloat(baselines[0].querySelector('.scol__prob').textContent || '');
    });
  };
  await openFundingGoal({
    keyboard: true
  });
  const initialFundingChoice = await page.evaluate(() => ({
    groups: document.querySelectorAll('.gh-funding-seg[role="group"][aria-label="Before retirement funding source"]').length,
    amountInputs: document.querySelectorAll('.gh-amount-input').length,
    amount: document.querySelector('.gh-amount-input')?.value || '',
    outsideSelected: document.querySelector('[data-action="fund-outside"]')?.classList.contains('is-selected') || false,
    portfolioSelected: document.querySelector('[data-action="fund-portfolio"]')?.classList.contains('is-selected') || false,
    outsidePressed: document.querySelector('[data-action="fund-outside"]')?.getAttribute('aria-pressed'),
    portfolioPressed: document.querySelector('[data-action="fund-portfolio"]')?.getAttribute('aria-pressed')
  }));
  if (initialFundingChoice.groups !== 1 || initialFundingChoice.amountInputs !== 1 || initialFundingChoice.amount !== '10,000' || !initialFundingChoice.outsideSelected || initialFundingChoice.portfolioSelected || initialFundingChoice.outsidePressed !== 'true' || initialFundingChoice.portfolioPressed !== 'false') {
    throw new Error(`pre-retirement funding choice is not explicit: ${JSON.stringify(initialFundingChoice)}`);
  }
  await stableClick('[data-action="fund-portfolio"]');
  await page.waitForFunction(({
    householdId,
    goalName
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    const goal = db[householdId]?.goals?.find(item => item.name === goalName);
    return goal?.fundFromPortfolioBeforeRetirement === true && document.querySelectorAll('[data-action="fund-portfolio"]').length === 1 && document.querySelector('[data-action="fund-portfolio"]')?.classList.contains('is-selected') && document.querySelector('[data-action="fund-portfolio"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-action="fund-outside"]')?.getAttribute('aria-pressed') === 'false';
  }, {
    timeout: 8000
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    goalName
  });
  await stableClick('[data-action="done"]');
  const beforeCadenceProbability = await runAndReadBaselineProbability();
  if (beforeCadenceProbability !== 100) {
    throw new Error(`funded $10,000 goal should be 100%, got ${beforeCadenceProbability}`);
  }
  await openFundingGoal();
  await stableClick('[data-action="per-month"]');
  await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '833', {
    timeout: 8000
  });
  const monthlyState = await page.evaluate(({
    householdId,
    goalName
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    const goal = db[householdId]?.goals?.find(item => item.name === goalName);
    return {
      amount: goal?.amount,
      per: goal?.per
    };
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    goalName
  });
  if (monthlyState.amount !== 10000 || monthlyState.per !== 'mo') {
    throw new Error(`monthly display changed canonical annual funding: ${JSON.stringify(monthlyState)}`);
  }
  await stableClick('[data-action="per-year"]');
  await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '10,000', {
    timeout: 8000
  });
  const annualState = await page.evaluate(({
    householdId,
    goalName
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    const goal = db[householdId]?.goals?.find(item => item.name === goalName);
    return {
      amount: goal?.amount,
      per: goal?.per
    };
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    goalName
  });
  if (annualState.amount !== 10000 || annualState.per !== 'yr') {
    throw new Error(`annual round-trip changed canonical funding: ${JSON.stringify(annualState)}`);
  }
  await stableClick('[data-action="done"]');
  const afterCadenceProbability = await runAndReadBaselineProbability();
  if (afterCadenceProbability !== beforeCadenceProbability) {
    throw new Error(`cadence-only edit changed probability (${beforeCadenceProbability} to ${afterCadenceProbability})`);
  }
  await openFundingGoal();
  const amountInput = await page.$('.gh-amount-input');
  await amountInput.click({
    clickCount: 3
  });
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type('100000');
  await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '100,000', {
    timeout: 8000
  });
  // Re-selecting the visible annual cadence commits the typed plan value.
  await stableClick('[data-action="per-year"]');
  await page.waitForFunction(({
    householdId,
    goalName
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    return db[householdId]?.goals?.find(item => item.name === goalName)?.amount === 100000;
  }, {
    timeout: 8000
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    goalName
  });
  await stableClick('[data-action="done"]');
  const underfundedProbability = await runAndReadBaselineProbability();
  if (underfundedProbability !== 0) {
    throw new Error(`underfunded pre-retirement goal still reports ${underfundedProbability}% instead of 0%`);
  }
  const compareFunding = await page.evaluate(name => {
    const names = [...document.querySelectorAll('#scn-view .goal-detail__name')].filter(element => element.textContent.trim() === name);
    const columns = document.querySelectorAll('#scn-view .scol').length;
    const disclosures = [...document.querySelectorAll('#scn-view .goal-detail__meta')].filter(element => /portfolio funded before retirement/i.test(element.textContent || ''));
    return {
      goalNames: names.length,
      columns,
      disclosures: disclosures.length
    };
  }, goalName);
  if (compareFunding.goalNames !== 1 || compareFunding.columns !== 3 || compareFunding.disclosures !== compareFunding.columns + 1) {
    throw new Error(`Compare does not disclose goal funding truth exactly once per plan: ${JSON.stringify(compareFunding)}`);
  }
  await stableClick('#scn-seg-focus');
  await page.waitForSelector('#scn-view .focus', {
    visible: true,
    timeout: 8000
  });
  const focusFunding = await page.evaluate(name => {
    const rows = [...document.querySelectorAll('#scn-view .goal-row')].filter(row => row.querySelector('.goal-row__name')?.textContent.trim() === name);
    const row = rows[0];
    return {
      rows: rows.length,
      metas: row?.querySelectorAll('.goal-row__meta').length || 0,
      states: row?.querySelectorAll('.goal-state').length || 0,
      meta: row?.querySelector('.goal-row__meta')?.textContent || '',
      state: row?.querySelector('.goal-state')?.textContent.trim() || '',
      inertSwitches: document.querySelectorAll('#scn-view .goal-toggle,[role="switch"].goal-toggle').length
    };
  }, goalName);
  if (focusFunding.rows !== 1 || focusFunding.metas !== 1 || focusFunding.states !== 1 || !/portfolio funded before retirement/i.test(focusFunding.meta) || focusFunding.state !== 'Active' || focusFunding.inertSwitches !== 0) {
    throw new Error(`Focus does not disclose read-only goal funding truth: ${JSON.stringify(focusFunding)}`);
  }
  await setCashFlow(page, true);
  await page.evaluate(() => {
    const toggle = document.querySelector('#scn-view .cf-ret-toggle');
    if (toggle?.classList.contains('is-on')) toggle.click();
  });
  await page.waitForFunction(() => document.querySelectorAll('#scn-view .cf').length === 1 && document.querySelectorAll('#scn-view .cf-row[data-age="64"]').length === 1, {
    timeout: 8000
  });
  const cashFlowTruth = await page.evaluate(() => {
    const rows = document.querySelectorAll('#scn-view .cf-row[data-age="64"]');
    const row = rows[0];
    const parseMoney = value => {
      const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
      if (!match) return Number.NaN;
      const multiplier = {
        K: 1e3,
        M: 1e6,
        B: 1e9
      }[match[2]?.toUpperCase()] || 1;
      return Number(match[1]) * multiplier;
    };
    const goalCells = row?.querySelectorAll('.cf-row__goals-wrap > .cf-cell') || [];
    const drawCells = row?.querySelectorAll('.cf-cell--draw') || [];
    const endingCells = row?.querySelectorAll('.cf-cell--ending > span:first-child') || [];
    const shortfallCells = row?.querySelectorAll('.cf-row__shortfall') || [];
    const probabilityCells = document.querySelectorAll('#scn-view .cf-summary__id .cf-stat__value--probability');
    return {
      rows: rows.length,
      probabilityCells: probabilityCells.length,
      goalCells: goalCells.length,
      drawCells: drawCells.length,
      endingCells: endingCells.length,
      shortfallCells: shortfallCells.length,
      goal: parseMoney(goalCells[0]?.textContent),
      draw: parseMoney(drawCells[0]?.textContent),
      ending: endingCells[0]?.textContent.trim() || '',
      shortfall: shortfallCells[0]?.textContent.trim() || '',
      shortfallVisible: parseMoney(shortfallCells[0]?.textContent),
      shortfallAmount: Number(row?.dataset.fundingShortfall || 0)
    };
  });
  if (cashFlowTruth.rows !== 1 || cashFlowTruth.probabilityCells !== 0 || cashFlowTruth.goalCells !== 1 || cashFlowTruth.drawCells !== 1 || cashFlowTruth.endingCells !== 1 || cashFlowTruth.shortfallCells !== 1 || cashFlowTruth.goal !== 100000 || !(cashFlowTruth.draw > 0) || cashFlowTruth.ending !== '$0' || !/^Short \$/i.test(cashFlowTruth.shortfall) || !(cashFlowTruth.shortfallAmount > 0) || Math.abs(cashFlowTruth.shortfallVisible - cashFlowTruth.shortfallAmount) > 500 || Math.abs(cashFlowTruth.goal - cashFlowTruth.draw - cashFlowTruth.shortfallVisible) > 1) {
    throw new Error(`Cash Flow hid the underfunded required cash flow: ${JSON.stringify(cashFlowTruth)}`);
  }
  await page.screenshot({
    path: join(OUT, '04a-funding-truth.png'),
    fullPage: true
  });
  await setCashFlow(page, false);
}
export async function verifyTaxFundedProbability({
  page,
  withdrawalPlannerFixtureHouseholdId,
  stableReload,
  stableClick,
  setCashFlow,
  waitCashRows
}) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const controlledPlan = await page.evaluate(householdId => {
    const storageKey = 'parallax.households.v1';
    const db = JSON.parse(localStorage.getItem(storageKey) || '{}');
    const plan = db[householdId];
    if (!plan) throw new Error('saved household is unavailable for the probability fixture');
    const currentYear = new Date().getFullYear();
    plan.meta = {
      ...(plan.meta || {}),
      primaryName: 'Probability Fixture',
      spouseName: '',
      filingStatus: 'single'
    };
    plan.household = {
      primary: {
        currentAge: 65,
        retirementAge: 65,
        planEndAge: 65,
        birthYear: currentYear - 65
      },
      spouse: null,
      children: []
    };
    plan.portfolio = {
      ...(plan.portfolio || {}),
      riskProfile: 3,
      withdrawalStrategy: 'taxable-first',
      accounts: {
        taxable: {
          ...plan.portfolio.accounts.taxable,
          balance: 0,
          basisPct: 1
        },
        traditional: {
          ...plan.portfolio.accounts.traditional,
          balance: 400000
        },
        roth: {
          ...plan.portfolio.accounts.roth,
          balance: 0
        }
      },
      extraAccounts: []
    };
    plan.savings = {
      ...(plan.savings || {}),
      annual: 0
    };
    plan.income = {
      socialSecurity: {
        primary: {
          pia: 0,
          claimAge: 67
        },
        spouse: null
      },
      pension: {
        benefitByAge: {},
        base: 0,
        startAge: 65,
        colaPct: 0
      },
      other: []
    };
    plan.expenses = {
      living: 0,
      housing: 0,
      debt: 0,
      healthcare: 0,
      healthcareRealGrowth: 0,
      extra: []
    };
    plan.liabilities = [];
    plan.properties = [];
    plan.goals = [{
      id: 'system:essentials',
      system: 'essentials',
      name: 'Essentials',
      amount: 300000,
      startsAtRetirement: true,
      endAge: 999,
      realGrowth: 0,
      flexesWithSpending: true
    }];
    plan.ltc = {
      amount: 0,
      onsetAge: 85
    };
    plan.taxes = {
      ordinary: 22,
      capitalGains: 15
    };
    plan.simulation = {
      ...(plan.simulation || {}),
      iterations: 40
    };
    db[householdId] = plan;
    localStorage.setItem(storageKey, JSON.stringify(db));
    localStorage.setItem('parallax.activeHouseholdId', householdId);
    localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
    localStorage.removeItem('parallax.pathReplay.v1');
    return plan;
  }, withdrawalPlannerFixtureHouseholdId);
  resetSeed(20260609);
  const horizonYears = resolveInputs(controlledPlan, {}).horizonYears;
  const returnPaths = Array.from({
    length: 40
  }, () => generateReturnPath(horizonYears));
  const shortcut = runSimulation(controlledPlan, {}, returnPaths);
  const funded = runMonteCarloWithFederalFunding(shortcut, controlledPlan, {}, {
    filingStatus: 'single',
    baseTaxYear: new Date().getFullYear(),
    scenarioId: 'verify_t9_probability'
  });
  if (shortcut.successRate === funded.federalSuccessRate) throw new Error(`probability fixture did not diverge (${shortcut.successRate})`);
  await stableReload({
    waitUntil: 'networkidle0'
  });
  await waitForUnselectedWizard(page);
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  await sleep(1200);
  await page.waitForSelector('#run-btn:not([disabled])', {
    timeout: 10000
  });
  await page.$eval('#run-btn', button => button.click());
  await page.waitForFunction(() => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  });
  await page.click('button[data-page="scenarios"]');
  await sleep(600);
  await page.click('#scn-seg-compare');
  await sleep(400);
  const expected = Number(funded.federalSuccessRate.toFixed(1));
  const oldShortcut = Number(shortcut.successRate.toFixed(1));
  const compareProb = await page.evaluate(() => {
    const baseline = [...document.querySelectorAll('#scn-view .scol')].find(column => /Baseline/i.test(column.querySelector('.scol__name')?.textContent || ''));
    return Number.parseFloat(baseline?.querySelector('.scol__prob')?.textContent || '');
  });
  if (compareProb !== expected) throw new Error(`Compare probability ${compareProb} does not match tax-funded ${expected}`);
  if (compareProb === oldShortcut) throw new Error(`Compare still shows shortcut-only probability ${oldShortcut}`);
  await page.click('#scn-seg-focus');
  await sleep(400);
  const focus = await page.evaluate(() => ({
    hero: Number.parseFloat(document.querySelector('#scn-view .hero__numeral')?.textContent || ''),
    rail: Number.parseFloat([...document.querySelectorAll('#scn-view .rail-card')].find(card => /Baseline/i.test(card.textContent || ''))?.querySelector('.rail-card__prob')?.textContent || '')
  }));
  if (focus.hero !== expected || focus.rail !== expected) throw new Error(`Focus probabilities do not match tax-funded ${expected}: ${JSON.stringify(focus)}`);
  await setCashFlow(page, true);
  await waitCashRows(page, 1);
  const cashFlowProbability = await page.evaluate(() => ({
    cell: !!document.querySelector('#scn-view .cf-summary__id .cf-stat__value--probability'),
    copy: /Probability of success/i.test(document.querySelector('#scn-view .cf-summary')?.textContent || '')
  }));
  if (cashFlowProbability.cell || cashFlowProbability.copy) throw new Error(`Cash Flow still presents plan-level probability: ${JSON.stringify(cashFlowProbability)}`);
  await setCashFlow(page, false);
  await sleep(300);
}

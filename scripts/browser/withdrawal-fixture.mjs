// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { goToWizardStep } from '../wizard-browser-contract.mjs';
import { openNetWorthCategory } from '../wizard-browser-contract.mjs';
import { waitForUnselectedWizard } from '../wizard-browser-contract.mjs';
export async function enterWithdrawalFixture({
  stableClick,
  page,
  WITHDRAWAL_PLANNER_FIXTURE,
  stableReload
}) {
  let withdrawalPlannerFixtureHouseholdId;
  await stableClick('.htab[data-page="household"]');
  const savedRuntimeEdit = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const record = db?.[active];
    const wages = (record?.income?.other || []).filter(row => row?.typeId === 'wages' && row?.owner === 'client');
    return {
      active,
      rootHouseholdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
      runtimeSourceHouseholdId: record?.meta?.runtimeSourceHouseholdId || '',
      wages,
      optionCount: [...document.querySelectorAll('#hh-switch option')].filter(option => option.value === active).length
    };
  });
  if (!savedRuntimeEdit.active || savedRuntimeEdit.rootHouseholdId !== savedRuntimeEdit.active || savedRuntimeEdit.runtimeSourceHouseholdId || savedRuntimeEdit.wages.length !== 1 || savedRuntimeEdit.wages[0]?.amount !== 50000 || savedRuntimeEdit.optionCount !== 1) {
    throw new Error(`Blank custom wages did not persist as one durable household: ${JSON.stringify(savedRuntimeEdit)}`);
  }
  await waitForWizard(page, {
    householdId: savedRuntimeEdit.active
  });
  await goToWizardStep(page, 'family');
  await stableClick('#hh-menu-btn');
  const priorHouseholdId = await page.$eval('#hh-switch', selector => selector.value);
  await stableClick('#hh-new');
  await page.waitForFunction(previousId => {
    const selected = document.querySelector('#hh-switch')?.value;
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return selected && selected !== previousId && active === selected && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
  }, {
    timeout: 10000
  }, priorHouseholdId);
  withdrawalPlannerFixtureHouseholdId = await page.evaluate(() => localStorage.getItem('parallax.activeHouseholdId'));
  const fixture = {
    ...WITHDRAWAL_PLANNER_FIXTURE,
    householdId: withdrawalPlannerFixtureHouseholdId
  };
  const currentRevision = () => page.$eval('[data-hh-wizard-root]', root => Number(root.dataset.renderRevision || -1));
  const typeAndBlur = async (selector, value, {
    waitForRender = true
  } = {}) => {
    const before = await currentRevision();
    await stableClick(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(value));
    await page.keyboard.press('Tab');
    if (waitForRender) {
      await waitForWizard(page, {
        afterRevision: before
      });
    }
  };
  const assertFixtureTaxAutosave = async stage => {
    const persisted = await page.evaluate(householdId => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      const current = db?.[householdId]?.incomeTax?.current1040;
      const activeHouseholdId = localStorage.getItem('parallax.activeHouseholdId');
      const activeCurrent = db?.[activeHouseholdId]?.incomeTax?.current1040;
      return {
        requestedHouseholdId: householdId,
        activeHouseholdId,
        incomeSourcesComplete: current?.incomeSourcesComplete === true,
        activeIncomeSourcesComplete: activeCurrent?.incomeSourcesComplete === true
      };
    }, fixture.householdId);
    if (persisted.activeHouseholdId !== persisted.requestedHouseholdId || persisted.incomeSourcesComplete || persisted.activeIncomeSourcesComplete) {
      throw new Error(`Funded fixture Tax autosave drifted ${stage}: ${JSON.stringify(persisted)}`);
    }
  };
  await goToWizardStep(page, 'family');
  await typeAndBlur('[data-wizard-field="primaryName"]', fixture.family.primaryName);
  await page.waitForFunction(() => {
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return active && [...document.querySelectorAll('#hh-switch option')].some(option => option.value === active);
  }, {
    timeout: 10000
  });
  const durableFixtureHousehold = await page.evaluate(() => {
    const active = localStorage.getItem('parallax.activeHouseholdId');
    return {
      active,
      optionCount: [...document.querySelectorAll('#hh-switch option')].filter(option => option.value === active).length
    };
  });
  if (!durableFixtureHousehold.active || durableFixtureHousehold.optionCount !== 1) {
    throw new Error(`Funded fixture did not resolve to one durable household: ${JSON.stringify(durableFixtureHousehold)}`);
  }
  withdrawalPlannerFixtureHouseholdId = durableFixtureHousehold.active;
  fixture.householdId = durableFixtureHousehold.active;
  await page.select('#hh-switch', durableFixtureHousehold.active);
  await waitForWizard(page, {
    householdId: durableFixtureHousehold.active
  });
  const [birthYear, birthMonth, birthDay] = fixture.family.birthDate.split('-');
  await typeAndBlur('[data-birth-date-group="client"] [data-birth-date-display]', `${birthMonth} / ${birthDay} / ${birthYear}`);
  await typeAndBlur('[data-wizard-field="client.retirementAge"]', fixture.family.retirementAge);
  await typeAndBlur('[data-wizard-field="client.planEndAge"]', fixture.family.planEndAge);
  await goToWizardStep(page, 'tax');
  await typeAndBlur('[data-hh-wizard-screen="tax"] [data-tax-field="income.wages.client"]', fixture.tax.wages);
  await assertFixtureTaxAutosave('after visible Tax entry');
  await openNetWorthCategory(page, 'investment');
  for (const account of fixture.accounts) {
    let before = await currentRevision();
    await stableClick(`[data-hh-action="net-worth-pick-type"][data-account-type-id="${account.typeId}"]`);
    await waitForWizard(page, {
      step: 'net-worth',
      afterRevision: before
    });
    await typeAndBlur('[data-net-worth-draft="name"]', account.institution, {
      waitForRender: false
    });
    await stableClick('[data-net-worth-draft="owner"]');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await typeAndBlur('[data-net-worth-draft="value"]', account.balance, {
      waitForRender: false
    });
    before = await currentRevision();
    await stableClick('[data-hh-action="net-worth-save-entry"]');
    await waitForWizard(page, {
      step: 'net-worth',
      afterRevision: before
    });
  }
  await assertFixtureTaxAutosave('after account entry');
  await stableClick('[data-net-worth-overlay] [data-hh-action="net-worth-close-panel"]');
  await stableClick('.htab[data-sub-target="goals"]');
  await page.waitForSelector('.gh-page', {
    visible: true,
    timeout: 8000
  });
  await stableClick('[data-goal-chip="system:essentials"]');
  await stableClick('.gh-amount-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(fixture.goals.essentialsAnnual));
  await page.keyboard.press('Tab');
  await page.waitForFunction(expected => document.querySelector('.gh-amount-input')?.value === expected.toLocaleString('en-US'), {
    timeout: 8000
  }, fixture.goals.essentialsAnnual);
  await assertFixtureTaxAutosave('after Goals edit');
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForUnselectedWizard(page);
  await page.select('#hh-switch', fixture.householdId);
  await waitForWizard(page, {
    householdId: fixture.householdId
  });
  await assertFixtureTaxAutosave('after reload');
  return withdrawalPlannerFixtureHouseholdId;
}

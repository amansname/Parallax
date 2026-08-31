import { selectHouseholdVisible } from '../../wizard-browser-contract.mjs';
export async function restoreWithdrawalFixture({
  stableClick,
  page,
  withdrawalPlannerFixtureHouseholdId
}) {
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  await page.waitForFunction(householdId => {
    const status = document.querySelector('#status')?.textContent || '';
    const runButton = document.querySelector('#run-btn');
    return localStorage.getItem('parallax.activeHouseholdId') === householdId && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === householdId && document.querySelector('#hh-switch')?.value === householdId && runButton && !runButton.disabled && /Plan updated|Partial run/i.test(status);
  }, {
    timeout: 30000
  }, withdrawalPlannerFixtureHouseholdId);
  const restoredWithdrawalPlannerFixture = await page.evaluate(householdId => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    const household = db[householdId]?.household || {};
    return {
      activeHouseholdId: localStorage.getItem('parallax.activeHouseholdId'),
      rootHouseholdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
      selectedHouseholdId: document.querySelector('#hh-switch')?.value || '',
      primary: household.primary ? {
        currentAge: household.primary.currentAge,
        retirementAge: household.primary.retirementAge
      } : null,
      spouse: household.spouse ? {
        currentAge: household.spouse.currentAge,
        retirementAge: household.spouse.retirementAge
      } : null
    };
  }, withdrawalPlannerFixtureHouseholdId);
  if (restoredWithdrawalPlannerFixture.activeHouseholdId !== withdrawalPlannerFixtureHouseholdId || restoredWithdrawalPlannerFixture.rootHouseholdId !== withdrawalPlannerFixtureHouseholdId || restoredWithdrawalPlannerFixture.selectedHouseholdId !== withdrawalPlannerFixtureHouseholdId || restoredWithdrawalPlannerFixture.primary?.currentAge !== 64 || restoredWithdrawalPlannerFixture.primary?.retirementAge !== 66 || restoredWithdrawalPlannerFixture.spouse?.currentAge !== 63 || restoredWithdrawalPlannerFixture.spouse?.retirementAge !== 65) {
    throw new Error(`Withdrawal Planner fixture was not restored after Historical reload: ${JSON.stringify(restoredWithdrawalPlannerFixture)}`);
  }
}

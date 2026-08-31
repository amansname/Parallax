import { prepareCashFlowFixture } from './fixture.mjs';
import { verifyTypicalCashFlow } from './typical.mjs';
import { verifyCashFlowScenarioSelection } from './scenario-selection.mjs';
import { verifyHistoricalCashFlow } from './historical-campaign.mjs';
import { verifyCashFlowDisclosures } from './disclosures.mjs';
import { restoreWithdrawalFixture } from './restore-fixture.mjs';
// Existing browser assertions; run by scripts/verify.mjs in campaign order.

export async function verifyCashFlow({
  page,
  withdrawalPlannerFixtureHouseholdId,
  stableReload,
  stableClick,
  errs,
  setCashFlow,
  waitCashRows,
  SKIP_SEQUENCING,
  waitForCashFlowPath,
  OUT,
  cashFlowSessionSnapshot
}) {
  // Re-anchor the saved plan + scenario levers after earlier household edits.
  await prepareCashFlowFixture({
    page,
    withdrawalPlannerFixtureHouseholdId,
    stableReload,
    stableClick,
    errs,
    setCashFlow,
    waitCashRows
  });
  const {
    m,
    retirementStartAge
  } = await verifyTypicalCashFlow({
    page,
    SKIP_SEQUENCING
  });

  // The scenario selector switches which plan's cash flow is shown, and each plan's
  // cash flow reflects ITS OWN retire age. The scenario initializer seeds Baseline at the
  // household retire age (66 here, asserted just above) and Scenario B at
  // +2 years (68), so selecting Scenario B must move the first
  // retirement-spending row from 66 to 68.
  const {
    typicalRowsByPlanYear
  } = await verifyCashFlowScenarioSelection({
    page,
    m,
    retirementStartAge
  });
  if (!SKIP_SEQUENCING) {
    await verifyHistoricalCashFlow({
      page,
      waitForCashFlowPath,
      typicalRowsByPlanYear,
      OUT,
      cashFlowSessionSnapshot,
      withdrawalPlannerFixtureHouseholdId,
      stableClick,
      setCashFlow,
      stableReload
    });
  }

  // Exercise warning and attach-failure states directly through the production
  // Cash Flow renderer. This avoids changing real scenario or Household state.
  await verifyCashFlowDisclosures({
    page,
    OUT
  });
  await restoreWithdrawalFixture({
    stableClick,
    page,
    withdrawalPlannerFixtureHouseholdId
  });
}

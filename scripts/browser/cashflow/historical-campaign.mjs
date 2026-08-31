import { verifyHistoricalSelector } from './historical-selector.mjs';
import { verifyHistoricalPeriods } from './historical-periods.mjs';
import { verifyHistoricalGoalEdits } from './historical-goal-edits.mjs';
import { verifyGrossRmdDisplay } from './rmd-display.mjs';
import { verifyUnderfundedMatrix } from './underfunded-matrix.mjs';
import { verifyHistoricalReload } from './historical-reload.mjs';
export async function verifyHistoricalCashFlow({
  page,
  waitForCashFlowPath,
  typicalRowsByPlanYear,
  OUT,
  cashFlowSessionSnapshot,
  withdrawalPlannerFixtureHouseholdId,
  stableClick,
  setCashFlow,
  stableReload
}) {
  const {
    pathReplayBefore
  } = await verifyHistoricalSelector({
    page
  });
  let reloadExpected = null;
  const {
    observedHistoricalOutcomes
  } = await verifyHistoricalPeriods({
    page,
    waitForCashFlowPath,
    pathReplayBefore,
    typicalRowsByPlanYear,
    OUT
  });
  await verifyHistoricalGoalEdits({
    page,
    cashFlowSessionSnapshot,
    withdrawalPlannerFixtureHouseholdId,
    stableClick,
    setCashFlow,
    waitForCashFlowPath,
    pathReplayBefore
  });
  await verifyGrossRmdDisplay({
    page
  });

  // This funded browser household correctly survives both live Historical paths above.
  // Exercise the underfunded matrix through the same production controller,
  // renderer and stylesheet without mutating the persisted household.
  await verifyUnderfundedMatrix({
    page,
    observedHistoricalOutcomes
  });

  // Historical-only financial bytes must survive a genuinely new session.
  // Use the shipped retirement-now household so those rows have no Typical
  // accumulation handoff; Typical-dependent comparison fields may change,
  // while the Historical ledger itself must remain exact.
  await verifyHistoricalReload({
    stableClick,
    page,
    setCashFlow,
    waitForCashFlowPath,
    cashFlowSessionSnapshot,
    reloadExpected,
    stableReload,
    pathReplayBefore
  });
}

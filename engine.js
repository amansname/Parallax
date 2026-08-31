/* Projection Engine public interface.
 * Implementation lives in src/projection/engine/. UI and planning consumers
 * continue to import this file. Preserve public exports, shared plan identity,
 * seeded return streams, and the contracts in test/engine/.
 */
import { runSinglePath } from './src/projection/engine/singlePath.js';

import { analyzeResults, pathDigest, ASSESSMENT_RULES, assessPlan } from './src/projection/engine/analyzeResults.js';

import { resetSeed, generateReturnPath, runSimulation, runHistoricalPath } from './src/projection/engine/simulation.js';

import { LONGRUN_INFLATION, RETURN_DATA, EQUITY_MIX, DEFENSIVE_MIX, buildAssetWeights, RISK_PROFILES, computeAssetStats, ASSET_STATS } from './src/projection/engine/marketAssumptions.js';

import { plan } from './src/projection/engine/defaultPlan.js';

import { ssAdjust, annualMortgagePayment, resolveInputs } from './src/projection/engine/resolveInputs.js';

import { resolveWithdrawalPlannerAccountState, approveWithdrawalPlannerLeverChange, buildWithdrawalPlannerCashContract } from './src/projection/engine/withdrawalPlanner.js';

import { PROJECTION_EXECUTION_LIMITS } from './src/projection/engine/execution.js';

import { resolveHouseholdTimeline, householdStateAtYear, householdIncomeAtYear } from './src/projection/engine/householdTimeline.js';

import {
  ASSET_KEYS,
  ASSET_META,
} from './src/household/investmentAllocation.js';

import { RETURN_SERIES_PROVENANCE, weightedAssetReturn } from './src/projection/portfolioReturns.js';

export {
  RETURN_DATA, ASSET_META, ASSET_KEYS, EQUITY_MIX, DEFENSIVE_MIX,
  RETURN_SERIES_PROVENANCE,
  RISK_PROFILES, ASSET_STATS, LONGRUN_INFLATION, PROJECTION_EXECUTION_LIMITS,
  buildAssetWeights, computeAssetStats, generateReturnPath, resetSeed, weightedAssetReturn,
  ssAdjust,
  runSimulation, resolveInputs, resolveHouseholdTimeline, householdStateAtYear,
  householdIncomeAtYear, resolveWithdrawalPlannerAccountState,
  approveWithdrawalPlannerLeverChange, buildWithdrawalPlannerCashContract,
  runSinglePath, analyzeResults, runHistoricalPath,
  annualMortgagePayment,
  pathDigest, assessPlan, ASSESSMENT_RULES,
  plan as defaultPlan
};

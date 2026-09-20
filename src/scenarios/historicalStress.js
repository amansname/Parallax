import { resolveInputs } from '../../engine.js';
import { buildRetirementEntryPlan, deriveRetirementEntryAccounts } from './buildRetirementEntryPlan.js';

const HISTORICAL_WITHDRAWAL_STRATEGIES = new Set(['taxable-first', 'proportional', 'traditional-first']);
export const normalizeHistoricalStrategy = strategy => HISTORICAL_WITHDRAWAL_STRATEGIES.has(strategy) ? strategy : 'taxable-first';

// Build a "retire-now" clone from the funded p50 path's projected bucket mix
// and taxable basis, scaled to the engine envelope's median entry balance.
// Every real market then runs from this one shared, tax-coherent starting point.
export function retireNowClone(p, ov, curAge, retAge, accumYears, analysis) {
  // Pending or stale scenarios must never start a second synchronous simulation.
  if (!analysis || analysis.projectionStatus === 'unavailable') {
    throw new Error('Run this plan before preparing its historical paths.');
  }
  const result = analysis;
  const resolved = resolveInputs(p, ov);
  const entryAccounts = deriveRetirementEntryAccounts(result, accumYears, resolved.accounts, resolved.projectionAccounts);
  return buildRetirementEntryPlan(p, {
    entryAccounts,
    currentAge: curAge,
    retirementAge: retAge
  });
}

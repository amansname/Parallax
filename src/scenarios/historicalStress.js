import { runSimulation, resolveInputs, RISK_PROFILES, defaultPlan as plan } from '../../engine.js';
import { runHistoricalPathWithFederalTax } from '../planning/tax/runHistoricalPathWithFederalTax.js';
import { buildRetirementEntryPlan, deriveRetirementEntryAccounts } from './buildRetirementEntryPlan.js';
import { sharedPaths } from '../state.js';

/* ── Historical Stress (Focus rail) ───────────────────────────────────────
   Five canonical sequence-of-returns eras (design handoff → Focus → Historical
   Stress). Each scenario is sequenced through an era the SAME way the
   Sequencing tab does it: stand the household at its retirement age with the
   median projected balance (retireNowClone), then replay the real historical
   series from that start year (the engine WRAPS past 2025 so recent eras still
   get a full retirement horizon). `y` is the real start year fed to the engine;
   `year` is the display label — the late-70s high-inflation shock is shown as
   the decade "1970s" but sequenced from a concrete 1977 start. */
export const STRESS_ERAS = [{
  y: 1966,
  year: '1966',
  name: 'Stagflation'
}, {
  y: 1973,
  year: '1973',
  name: 'Oil shock'
}, {
  y: 2000,
  year: '2000',
  name: 'Dot-com'
}, {
  y: 2008,
  year: '2008',
  name: 'Global Financial Crisis'
}, {
  y: 1977,
  year: '1970s',
  name: 'High inflation'
}];
const HISTORICAL_WITHDRAWAL_STRATEGIES = new Set(['taxable-first', 'proportional', 'traditional-first']);
export const normalizeHistoricalStrategy = strategy => HISTORICAL_WITHDRAWAL_STRATEGIES.has(strategy) ? strategy : 'taxable-first';

// Pass vs Marginal for ONE historical sequence — fully engine-derived (Engine
// Truth: the card never invents an outcome). Pass = the plan funded the entire
// horizon (never depleted) AND cleared the sequence-risk window with non-negative
// real growth across the first retirement decade, where sequence risk lives.
// A depletion or a negative first decade reads as Marginal; the design has no
// "Fail" tier, so Marginal is the most severe state the card shows.
function eraPasses(h) {
  if (!h || h.failed) return false;
  if (h.first10Supports === false) return false;
  return true;
}

// Sequence one scenario (plan clone + overrides) through every era. Reuses the
// scenario's freshly-computed envelope so the retirement entry balance matches
// the Scenarios / Sequencing tabs exactly (one shared-path truth, not a re-roll).
export function computeHistoricalStress(s, p, ov) {
  const curAge = plan.household.primary.currentAge;
  const retAge = resolveInputs(p, ov).retirementAge;
  const accumYears = Math.max(0, retAge - curAge);
  const rp = retireNowClone(p, ov, curAge, retAge, accumYears, s.res);
  // Guard: ensure rp has a valid risk profile so resolveInputs doesn't throw on
  // RISK_PROFILES[undefined].eq. A stale localStorage save can carry an invalid
  // risk lever; fall back to the base plan's profile (or Moderate = 3).
  if (!RISK_PROFILES[rp.portfolio.riskProfile]) {
    rp.portfolio.riskProfile = p.portfolio.riskProfile in RISK_PROFILES ? p.portfolio.riskProfile : 3;
  }
  const strat = normalizeHistoricalStrategy(p.portfolio.withdrawalStrategy);
  const ov2 = {
    ...ov,
    retireDelay: 0
  }; // retirement age is baked into the clone
  // Wrap each era individually: a single failing era must not blank the whole card.
  // null entries are filtered out; if any eras succeed the card renders those rows.
  const results = STRESS_ERAS.map(e => {
    try {
      const h = runHistoricalPathWithFederalTax(rp, e.y, strat, undefined, ov2, {
        baseTaxYear: Number.isInteger(rp.meta?.planningAsOfYear) ? rp.meta.planningAsOfYear : new Date().getFullYear(),
        filingStatus: rp.meta?.filingStatus,
        scenarioId: `historical_stress_${s.name}_${e.y}`
      });
      return {
        year: e.year,
        name: e.name,
        pass: eraPasses(h)
      };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  return results;
}

// Build a "retire-now" clone from the funded p50 path's projected bucket mix
// and taxable basis, scaled to the engine envelope's median entry balance.
// Every real market then runs from this one shared, tax-coherent starting point.
export function retireNowClone(p, ov, curAge, retAge, accumYears, analysis) {
  // Reuse the chosen scenario's computed result so Sequencing never re-rolls
  // its market entry state. Fall back only before that scenario has run.
  const result = analysis || runSimulation(p, ov, sharedPaths);
  const resolved = resolveInputs(p, ov);
  const entryAccounts = deriveRetirementEntryAccounts(result, accumYears, resolved.accounts, resolved.projectionAccounts);
  return buildRetirementEntryPlan(p, {
    entryAccounts,
    currentAge: curAge,
    retirementAge: retAge
  });
}

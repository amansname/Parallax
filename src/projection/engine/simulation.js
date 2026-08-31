// Projection Engine implementation; public consumers import engine.js.
import { RETURN_DATA } from './marketAssumptions.js';
import { resolveInputs } from './resolveInputs.js';
import { validateProjectionHorizon, validateReturnPaths } from './execution.js';
import { createProjectionReturnCache } from '../portfolioReturns.js';
import { runSinglePath } from './singlePath.js';
import { analyzeResults } from './analyzeResults.js';

// Seeded RNG (mulberry32). The bootstrap draws are deterministic so identical
// inputs reproduce an identical success % — no sampling drift on page refresh.
// Distribution is unchanged; this only fixes *which* draws come out. Call
// resetSeed() before generating a bundle to reproduce it; pass a fresh seed
// (e.g. Date.now()) only if you deliberately want a new random bundle.
const DEFAULT_SEED = 0x9e3779b9;

let _rngState = DEFAULT_SEED >>> 0;

export function resetSeed(seed = DEFAULT_SEED){ _rngState = seed >>> 0; }

function rand(){
  _rngState = (_rngState + 0x6D2B79F5) >>> 0;
  let t = _rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function generateReturnPath(horizonYears){
  validateProjectionHorizon(horizonYears, 'return path horizon');
  const path = [];
  const minBlock = 3, maxBlock = 5;
  while(path.length < horizonYears){
    const blockLen = minBlock + Math.floor(rand() * (maxBlock - minBlock + 1));
    const maxStart = RETURN_DATA.length - blockLen;
    const startIdx = Math.floor(rand() * (maxStart + 1));
    for(let i = 0; i < blockLen && path.length < horizonYears; i++){
      path.push(RETURN_DATA[startIdx + i]);
    }
  }
  return path;
}

function attachSelectedAccountDiagnostics(analysis, inputs, options){
  const detailedByIndex = new Map();
  function materialize(compact){
    const index = compact.simIndex;
    let detailed = detailedByIndex.get(index);
    if(!detailed){
      detailed = runSinglePath(inputs, compact.returnPath, {
        ...options,
        includeAccountDiagnostics: true,
      });
      detailed.simIndex = index;
      detailed.returnPath = compact.returnPath;
      detailedByIndex.set(index, detailed);
      analysis.sims[index] = detailed;
    }
    return detailed;
  }
  for(const [pathKey, compact] of Object.entries(analysis.paths)){
    analysis.paths[pathKey] = materialize(compact);
  }
  // Cash Flow compares alternatives on Baseline's selected market path, which
  // need not be one of the alternative's own percentile selections.
  for(const index of options.accountDiagnosticsSimIndices ?? []){
    materialize(analysis.sims[index]);
  }
  return analysis;
}

export function runSimulation(plan, overrides = {}, returnPaths = null, options = {}){
  const inputs = resolveInputs(plan, overrides);
  if(inputs.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  if(returnPaths !== null) validateReturnPaths(returnPaths, inputs.horizonYears);
  const sims = [];
  const projectionReturnCache = options.projectionReturnCache
    ?? createProjectionReturnCache();
  const runOptions = {
    ...options,
    projectionReturnCache,
  };
  // Monte Carlo selection needs compact numeric rows for every trial, but the
  // account-allocation detail is consumed only by the representative paths.
  // Never materialize internal per-account detail, then re-run the at-most-five
  // selected paths with it.
  // When a return-path bundle is supplied it is authoritative: iterate over
  // exactly those paths so identical inputs + identical paths are reproducible.
  // (Silently generating random fill paths for missing indices broke that.)
  const iterations = returnPaths !== null ? returnPaths.length : inputs.iterations;
  if(options.accountDiagnosticsSimIndices !== undefined
      && (!Array.isArray(options.accountDiagnosticsSimIndices)
        || options.accountDiagnosticsSimIndices.some(index => !Number.isInteger(index) || index < 0 || index >= iterations))){
    throw new RangeError('accountDiagnosticsSimIndices must contain valid simulation indices');
  }
  for(let s = 0; s < iterations; s++){
    const returnPath = returnPaths
      ? returnPaths[s]
      : generateReturnPath(inputs.horizonYears);
    let sim;
    try{
      sim = runSinglePath(inputs, returnPath, {
        ...runOptions,
        includeAccountDiagnostics: false,
      });
    }catch(error){
      // A genuinely unresolvable RMD fails CLOSED — it must not escape as an
      // uncontrolled exception (which discards every scenario and leaves the UI
      // with a bare dash), and it must not be treated as zero and quietly
      // produce an authoritative-looking percentage. Callers get a structured
      // result carrying the reason and the rows computed before the stop.
      if(error?.code === 'HOUSEHOLD_RMD_UNAVAILABLE'){
        return {
          projectionStatus: 'unavailable',
          issue: error.rmdIssue || error.code,
          issueAge: error.age ?? null,
          rowsThroughIssue: error.rows || [],
          successRate: null,
        };
      }
      throw error;
    }
    sim.simIndex = s;  // anchor for path-coherent cross-strategy comparison
    sim.returnPath = returnPath;  // preserve coherent path for summary resilience / elasticity diagnostics
    sims.push(sim);
  }
  return attachSelectedAccountDiagnostics(
    analyzeResults(sims, inputs),
    inputs,
    runOptions,
  );
}

export function runHistoricalPath(plan, startYear, strategy, transform, overrides, options = {}){
  // `overrides` flows through the SAME resolveInputs lever mapping the Monte
  // Carlo path uses (retireDelay, ssDelayYears, spendBump, lumpSum, savingsBump,
  // pensionStartAge, …) so a chosen scenario is sequenced faithfully, not just
  // its allocation. Defaults to {} → behavior identical to the original.
  const rawInputs = resolveInputs(plan, overrides || {});
  if(rawInputs.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  // Override strategy for this run
  rawInputs.withdrawalStrategy = strategy;

  // Build the path from startYear forward. When we reach the end of the real
  // record (2025) we WRAP back to its start rather than truncate — the same
  // cyclic treatment the block-bootstrap Monte Carlo uses, so a recent
  // retirement year (2000, 2008) still gets a FULL real-return horizon instead
  // of a stub that ends mid-retirement. Every return remains a real historical
  // year; only the calendar contiguity breaks at the wrap (invisible on an
  // age-based axis). The first decade — where sequence risk lives — is always
  // pre-wrap and fully real.
  const startIdx = RETURN_DATA.findIndex(r => r.y === startYear);
  if(startIdx < 0) return null;
  const path = [];
  for(let i = 0; i < rawInputs.horizonYears; i++){
    const row = RETURN_DATA[(startIdx + i) % RETURN_DATA.length];
    path.push(row);
  }
  if(path.length === 0) return null;

  // Optional ORDER transform (e.g. reverse): reorders the SAME real return
  // rows before the single-path runner walks them. The returns are unchanged —
  // only their sequence is. Used by the Sequencing tab to isolate order. When
  // omitted, behavior is byte-identical to the original forward run.
  const ordered = typeof transform === 'function' ? transform(path.slice()) : path;

  // Adjust horizon to actual data available
  const inputs = { ...rawInputs, horizonYears: ordered.length };
  const result = runSinglePath(inputs, ordered, options);
  result.actualYears  = ordered.length;
  result.requestedYrs = rawInputs.horizonYears;
  result.startYear    = startYear;
  result.endYear      = startYear + ordered.length - 1;
  return result;
}

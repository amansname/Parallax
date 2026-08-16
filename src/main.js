import { runSimulation, resolveInputs, generateReturnPath, resetSeed, LONGRUN_INFLATION, pathDigest, RISK_PROFILES, defaultPlan as plan } from '../engine.js';
import { runFederalFundingSimulation } from './planning/tax/runMonteCarloWithFederalFunding.js';
import { runHistoricalPathWithFederalTax } from './planning/tax/runHistoricalPathWithFederalTax.js';
import { buildReadyCurrent1040Intake } from './planning/tax/buildCurrent1040Intake.js';
import { fmtM, fmtMoney } from '../ui/formatters.js';
import { storyChart, seqChartSvg } from '../ui/charts.js?v=2';
import { escHtml } from '../ui/dom.js';
import { CHART_LAYOUT } from '../ui/chartLayout.js';
import {
  SHIPPED_DEFAULT_HOUSEHOLD_IDS,
  createBlankHousehold,
  createDemoHousehold,
  createSelectableDefaultHouseholds,
} from '../ui/householdFactories.js';
import { resolveTypeFromLabel } from './household/accountTypes.js';
import { createAccount } from './household/createAccount.js';
import { createIncomeSource } from './household/incomeTaxModel.js';
import { bindHouseholdEditor } from './household/commit.js';
import { createHouseholdWizardController } from './household/wizard.js';
import { createHouseholdWizardCommitBoundary } from './household/wizardEdits.js';
import { invalidateWizardTaxCompletion } from './household/wizardIntake.js';
import {
  ACTIVE_KEY,
  HHDB_KEY,
  applyPreparedReadOnlyFallback,
  commitPreparedHouseholdStore,
  getBlockedMessage,
  getReadOnlyMessage,
  prepareHouseholdRecordForSave,
  prepareHouseholdStore,
  readHouseholdStore,
} from './household/persistence.js';
import { createGoalsHorizonController } from '../ui/goalsHorizon.js';
import {
  goalHasFutureWorkingYears,
  resolveEffectiveGoal,
  resolveScenarioHouseholdRetirementAge,
  resolveGoalSpan,
} from './goals/horizonModel.js';
import { createTaxBucketsController } from '../ui/taxBuckets.js';
import { pathModeLabel, drawSeqChart, renderPrints, syncPathControls, updatePathReplayMode } from '../ui/sequencing.js';
import { buildPathRows, buildCashSummary, renderCashflow } from '../ui/cashflow.js';
import { toneForProb, toneGlow, wdColor, ring, num as scenarioNum, renderCompare, renderFocus } from '../ui/scenarios.js';
import { solvePanelHTML, goalParamsHtml, comboPillValue } from '../ui/solver.js';
import {
  buildRetirementEntryPlan,
  deriveRetirementEntryAccounts,
} from './scenarios/buildRetirementEntryPlan.js';
import { investableTotal, hhAgeFromYear } from '../ui/household.js';
import {
  scenarios, sharedPaths, plansDirty, baseSnapshot,
  solverResults, solverSearching, comboResults, comboOpen, comboSearching, solverFormOpen, solving,
  pathReplay, uiState, scenariosUiState as state,
} from './state.js';
/* ╔══════════════════════════════════════════════════════════════╗
   ║  PARALLAX V2 — UI WIRING (calls the engine above)             ║
   ╚══════════════════════════════════════════════════════════════╝ */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
/* ── Household model: pure factories + multi-household persistence ──────────
   The app boots with one current-build blank Demo Household slot. The advisor
   can explicitly select a shipped template or saved household; browser state
   never chooses the startup record.

   `plan` is the engine's default plan object (imported live). It cannot be
   reassigned (const import binding), so hydratePlan() mutates it in place —
   preserving the object identity the engine reads internally. */

// Pristine engine default, captured BEFORE any mutation. Both factories clone
// this so they start from the exact engine schema (forward-compatible: new
// engine fields flow through automatically).
const PRISTINE_PLAN = JSON.parse(JSON.stringify(plan));
const newHouseholdId = () => 'hh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const RUNTIME_HOUSEHOLD_IDS = new Set(['demo', ...SHIPPED_DEFAULT_HOUSEHOLD_IDS]);
const isRuntimeHousehold = id => RUNTIME_HOUSEHOLD_IDS.has(id);

/* Replace the live engine plan's contents with a household record. Mutates the
   imported `plan` in place (it can't be reassigned) so the engine — which reads
   the same object reference internally — sees the hydrated household. */
function hydratePlan(src){
  const clone = JSON.parse(JSON.stringify(src));
  Object.keys(plan).forEach(k => { delete plan[k]; });
  Object.assign(plan, clone);
}

/* ── Household persistence: records-by-id + an active pointer ────────────────
   MVP/DEMO PERSISTENCE ONLY (localStorage — single-browser, unencrypted). A
   real backend seam replaces these later. Households are stored by id under
   HHDB_KEY; ACTIVE_KEY names the one currently loaded. Scenarios are scoped
   per household (scenKey) so demo and custom scenario sets never collide. */
let householdsDb = {};
let activeHouseholdId = null;
let accountMigrationState = { blocked: false, readOnly: false, message: null, issuesByHousehold: {} };
let recoveryStatusPinned = false;

const householdStorage = {
  getItem(key){ return localStorage.getItem(key); },
  setItem(key, value){ localStorage.setItem(key, value); },
};

function isHouseholdStorageReadOnly(){
  return accountMigrationState.readOnly === true;
}

function isHouseholdStorageBlocked(){
  return accountMigrationState.blocked === true;
}

function canRunEngine(){
  return !isHouseholdStorageBlocked();
}

function syncRecoveryStatus(message){
  recoveryStatusPinned = true;
  accountMigrationState.message = message;
  const el = $('#status');
  if(el && message != null) el.textContent = message;
  syncHeaderCluster();
}

function guardPlanMutation(){
  if(isHouseholdStorageBlocked()){
    syncRecoveryStatus(accountMigrationState.message || getBlockedMessage());
    renderBlockedRecoverySurfaces();
    return false;
  }
  if(isHouseholdStorageReadOnly()){
    syncRecoveryStatus(accountMigrationState.message || getReadOnlyMessage());
    syncRecoveryControls();
    return false;
  }
  return true;
}

function recoveryPanelHtml(){
  const message = accountMigrationState.message || getBlockedMessage();
  return `<div class="scn-empty" role="status">${escHtml(message)}</div>`;
}

function renderBlockedRecoverySurfaces(){
  if(!isHouseholdStorageBlocked()) return;
  const html = recoveryPanelHtml();
  ['#hh-view','#np-content','#scn-view','#seq-prints'].forEach(sel => { const el=$(sel); if(el) el.innerHTML=html; });
  ['#hh-wiz-footer','#solve-panel','#seq-chips'].forEach(sel => { const el=$(sel); if(el) el.innerHTML=''; });
  const svg=$('#seq-svg'); if(svg) svg.innerHTML='';
  const seqSel=$('#seq-select'); if(seqSel){ seqSel.innerHTML=''; seqSel.disabled=true; }
  const seqSub=$('#seq-sub'); if(seqSub) seqSub.textContent='Household storage recovery required';
  const scnSub=$('#scn-subtitle'); if(scnSub) scnSub.textContent='Household storage recovery required';
  const rail=$('#hh-rail-name'); if(rail) rail.textContent='Household unavailable';
  syncRecoveryControls();
}

function syncRecoveryControls(){
  const locked = isHouseholdStorageBlocked() || isHouseholdStorageReadOnly();
  if(!locked) return;
  const selectors = [
    '#hh-new','#scn-solve','#hh-view input','#hh-view select','#hh-view textarea','#hh-view .row-x','#hh-view [data-add]',
    '#hh-view [data-hh-action="add-account"]','#hh-view [data-hh-action="save-account"]','#hh-view [data-hh-action="remove-account"]',
    '#hh-view [data-hh-action="net-worth-toggle-more"]','#hh-view [data-hh-action="net-worth-pick-type"]','#hh-view [data-hh-action="net-worth-pick-custom"]',
    '#hh-view [data-hh-action="net-worth-clear-type"]','#hh-view [data-hh-action="net-worth-save-entry"]','#hh-view [data-hh-action="net-worth-remove-entry"]',
    '#hh-view [data-hh-action="override-income-group"]','#hh-view [data-hh-action="revert-income-group"]','#hh-view [data-hh-action="remove-tax-item"]',
    '#hh-view [data-hh-action="add-spouse"]','#hh-view [data-hh-action="remove-spouse"]','#hh-view [data-hh-action="save-account"]',
    '#hh-view [data-hh-action="open-account-form"]','#hh-view [data-hh-action="open-add"]','#hh-view [data-hh-action="commit-add"]','#hh-view [data-hh-action="add-home"]','#hh-view [data-hh-action="add-mortgage"]',
    '#hh-view [data-hh-action="add-pension-age"]','#np-content input','#np-content select','#np-content textarea','#np-content button',
    '#np-content .row-x','#np-content [data-add]','#np-content [data-act]','#scn-add','#scn-view [data-lever-key]','#scn-view .cmp-lev-in',
    '#scn-view .cmp-goal-in','#scn-view .scol__menu','#solve-panel .solve-load','#solve-panel .cc-load'
  ];
  if(isHouseholdStorageBlocked()) selectors.push('#run-btn','#hh-menu-btn','#hh-load-demo','#hh-switch','#path-mode','#seq-select','#seq-chips button');
  if(isHouseholdStorageReadOnly() && !householdsDb.demo) selectors.push('#hh-load-demo');
  document.querySelectorAll(selectors.join(',')).forEach(el => {
    if('disabled' in el) el.disabled=true;
    el.setAttribute('aria-disabled','true');
  });
}

function persistHouseholdsDb(){
  if(!guardPlanMutation()) return false;
  try{ localStorage.setItem(HHDB_KEY, JSON.stringify(householdsDb)); return true; }catch(e){ return false; }
}
function persistActiveId(){
  if(!guardPlanMutation()) return false;
  try{
    localStorage.setItem(ACTIVE_KEY, activeHouseholdId);
    return true;
  }catch(e){
    return false;
  }
}
function saveActiveHousehold(){
  if(!guardPlanMutation()) return false;
  // Demo and shipped defaults are immutable templates from the current build.
  // Edits remain usable in-session but never become origin-specific startup data.
  if(isRuntimeHousehold(activeHouseholdId)) return true;
  if(activeHouseholdId && plan && plan.meta){
    try{
      householdsDb[activeHouseholdId] = prepareHouseholdRecordForSave(
        plan,
        activeHouseholdId,
      );
    }catch(error){
      console.error('Household save validation failed:', error);
      return false;
    }
    return persistHouseholdsDb() && persistActiveId();
  }
  return false;
}
function canChangeActiveHousehold(){
  if(!saveFailed) return true;
  syncHeaderStatus('Automatic save failed; reload after storage is available');
  return false;
}
function bootstrapHouseholds(){
  accountMigrationState = { blocked: false, readOnly: false, message: null, issuesByHousehold: {} };
  recoveryStatusPinned = false;
  const read = readHouseholdStore(householdStorage);
  let prepared = prepareHouseholdStore(read, {
    createDemoHousehold,
    createBlankHousehold,
    createSelectableDefaultHouseholds,
    pristinePlan: PRISTINE_PLAN,
    currentYear: () => new Date().getFullYear(),
  });

  if(!prepared.ok){
    accountMigrationState = {
      blocked: true,
      readOnly: false,
      message: prepared.message || getBlockedMessage(),
      issuesByHousehold: {},
    };
    householdsDb = {};
    activeHouseholdId = null;
    syncRecoveryStatus(accountMigrationState.message);
    return;
  }

  const commit = commitPreparedHouseholdStore(householdStorage, prepared);
  if(!commit.ok){
    if(commit.readOnly){
      prepared = applyPreparedReadOnlyFallback(prepared);
      accountMigrationState = {
        blocked: false,
        readOnly: true,
        message: getReadOnlyMessage(),
        issuesByHousehold: prepared.issuesByHousehold || {},
      };
    } else {
      accountMigrationState = {
        blocked: true,
        readOnly: false,
        message: getBlockedMessage(),
        issuesByHousehold: {},
      };
      syncRecoveryStatus(accountMigrationState.message);
      return;
    }
  } else {
    accountMigrationState.issuesByHousehold = prepared.issuesByHousehold || {};
  }

  householdsDb = prepared.db;
  activeHouseholdId = prepared.activeHouseholdId;
  if(prepared.hydrate){
    hydratePlan(householdsDb[activeHouseholdId]);
  }
  if(accountMigrationState.readOnly){
    syncRecoveryStatus(getReadOnlyMessage());
  }
}

// Scenario accent palette (SCEN_PALETTE / colorFor / BASE_ACCENT / scenAccent)
// was removed with the old band + cash-flow grid renderers that consumed it. The
// redesign keys scenario tone off engine success probability (toneForProb in the
// ScenariosUI view layer), not a fixed identity palette.
const MAX_SCENARIOS=5;
/* The three scenario columns. Each holds lever values + its last engine result.
   lever values are the ACTUAL planning values (age, $, etc.), not slider ticks. */
const RISK_LABELS={1:'30 / 70',2:'45 / 55',3:'60 / 40',4:'75 / 25',5:'90 / 10'};
// Essentials is a pre-loaded goal now, not a plan.expenses field. One reader so
// the Scenarios lever, the Summary metric and the wizard cannot drift apart.
function essentialsGoalAmount(p){
  const goal = (Array.isArray(p?.goals) ? p.goals : []).find(g => g?.system === 'essentials');
  return Number(goal?.amount) || 0;
}
function healthcareGoalAmount(p){
  const goal = (Array.isArray(p?.goals) ? p.goals : []).find(g => g?.system === 'healthcare');
  return Number(goal?.amount) || 0;
}

function defaultLevers(){
  const L={
    retireAge:  plan.household.primary.retirementAge,
    ssAge:      plan.income.socialSecurity.primary.claimAge,
    spend:      essentialsGoalAmount(plan),
    eventAmt:   0, eventAge: 70,
    risk:       plan.portfolio.riskProfile,
    savings:    plan.savings.annual,
    // pensionAge tracks retirement by DEFAULT (most people switch on a pension
    // when they retire — no reason to take taxable fixed income while still
    // earning). pensionAuto stays true until the advisor grabs the pension
    // slider, which frees it to hold any quoted age independently.
    pensionAuto: true,
    pensionAge: (plan.income.pension && plan.income.pension.startAge) || 65,
    // Earmarked-asset sale. Off sentinel = currentAge−1 (renders "Keep"); any
    // value ≥ currentAge is a sale age. Targets the first property.
    sellAge: plan.household.primary.currentAge - 1
  };
  syncPension(L);
  return L;
}
// If pension is still auto-linked, snap its claim age to the retirement age,
// clamped into the household's quoted pension range. No-op once the advisor has
// taken manual control of the pension lever (pensionAuto=false).
function syncPension(L){
  if(!L.pensionAuto) return;
  const a=pensionAges();
  const lo = a.length ? a[0] : 62, hi = a.length ? a[a.length-1] : 65;
  L.pensionAge = Math.max(lo, Math.min(hi, L.retireAge));
}
// ── Scenario persistence (browser localStorage) ──────────────────────────
// Scenarios are SCOPED PER HOUSEHOLD (parallax.scenarios.<householdId>.v1) so a
// custom household's scenarios never collide with the demo's. We save only the
// durable parts (name/base/lev) — never res (recomputed on Run). Wrapped in
// try/catch so a corrupt/blocked store never breaks the app.
const SCEN_PREFIX='parallax.scenarios.';
const scenKey=id=>SCEN_PREFIX + (id || activeHouseholdId || 'demo') + '.v1';
function saveScenarios(){
  if(!guardPlanMutation()) return false;
  if(isRuntimeHousehold(activeHouseholdId)) return true;
  try{
    const slim=scenarios.map(s=>({name:s.name, base:!!s.base, lev:s.lev}));
    localStorage.setItem(scenKey(), JSON.stringify(slim));
    return true;
  }catch(e){ return false; }
}
function loadScenarios(id){
  if(isRuntimeHousehold(id || activeHouseholdId)) return null;
  try{
    const raw=localStorage.getItem(scenKey(id));
    if(!raw) return null;
    const arr=JSON.parse(raw);
    if(!Array.isArray(arr) || !arr.length || !arr[0].base) return null;  // sanity
    // Backfill any lever keys added since the save (forward-compat) so old saves
    // don't break when defaultLevers() grows new fields.
    const proto=defaultLevers();
    const hasProperty = !!(plan.properties && plan.properties.length);
    return arr.map(s=>{
      const lev={...proto, ...s.lev};
      let name=String(s.name||'Scenario');
      if(!hasProperty){
        lev.sellAge = proto.sellAge;
        if(/sell\s*home|allocation\s*tilt/i.test(name)) name = 'Risk tilt';
      }
      return { name, base:!!s.base, lev, res:null };
    });
  }catch(e){ return null; }
}
// Wipe the ACTIVE household's saved scenarios and return to its first-run set.
function resetScenarios(){
  if(!guardPlanMutation()) return;
  try{ localStorage.removeItem(scenKey()); }catch(e){}
  uiState.scenarios=demoScenarios(); uiState.baseSnapshot=defaultLevers();
  uiState.plansDirty=true; runAll();
}

/* ── Plan persistence (browser localStorage) ──────────────────────────────
   MVP/DEMO PERSISTENCE ONLY. localStorage is a single-browser, unencrypted
   store — fine for prototype/demo work, NOT long-term production persistence
   for client data (no sync, no auth, ~5MB quota, cleared with site data).
   A real backend seam replaces this later.

   Valid edits persist through the household store immediately. Scenario
   names/levers persist through their household-scoped key in the same edit.
   planSaveDirty is retained only while an automatic save needs recovery.
   (Distinct from plansDirty, which means "scenario RESULTS are stale".) */
let planSaveDirty=false;
let saveFailed=false;
function autoSavePlan(){
  planSaveDirty=true;
  const ok=saveActiveHousehold() && saveScenarios();
  saveFailed=!ok;
  planSaveDirty=!ok;
  return ok;
}
function syncPlanEditStatus(message){
  syncHeaderStatus(saveFailed
    ? 'Automatic save failed · storage blocked or full'
    : message);
}
function deriveHeaderClusterState(text){
  const msg = text ?? ($('#status')?.textContent || '');
  if(saveFailed) return 'needs-run';
  if(/Running|Error|Check plan|Save failed|could not run|storage blocked/i.test(msg)) return 'needs-run';
  if(uiState.plansDirty || /Run to update|open Scenarios/i.test(msg)) return 'needs-run';
  if(planSaveDirty || /edited|Adjusted/i.test(msg)) return 'edited';
  return 'saved';
}
function syncHeaderCluster(){
  const el = $('#status');
  const cluster = document.querySelector('.app-header .cluster');
  if(!el) return;
  el.title = el.textContent;
  const state = deriveHeaderClusterState(el.textContent);
  if(cluster) cluster.dataset.state = state;
}
function syncHeaderStatus(message){
  if(recoveryStatusPinned) return;
  const el = $('#status');
  if(!el) return;
  if(message != null) el.textContent = message;
  syncHeaderCluster();
}
function syncHeaderTabs(activeTab){
  $$('.htab').forEach(t => {
    const on = t === activeTab;
    t.classList.toggle('on', on);
    if(on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
}
// Add a new scenario (clones the current baseline's levers so it starts as a
// neutral copy the advisor then adjusts). Capped at MAX_SCENARIOS.
function addScenario(){
  if(!guardPlanMutation()) return;
  if(scenarios.length>=MAX_SCENARIOS) return;
  const baseLev=scenarios.find(s=>s.base)?.lev || defaultLevers();
  const n=scenarios.filter(s=>!s.base).length;
  uiState.addScenario({ name:`Scenario ${String.fromCharCode(66+n)}`, base:false,
                   lev:JSON.parse(JSON.stringify(baseLev)), res:null });
  saveScenarios(); uiState.plansDirty=true; runAll();
}
// Remove a non-baseline scenario by index.
function removeScenario(ci){
  if(!guardPlanMutation()) return;
  if(ci<=0 || ci>=scenarios.length || scenarios[ci].base) return;
  uiState.removeScenarioAt(ci);
  saveScenarios(); uiState.plansDirty=true; runAll();
}

// ── Solver ──────────────────────────────────────────────────────────────
// Run the engine for one trial set of levers and return the success %.
// Reuses sharedPaths (the cached return-path bundle) so every trial sees the
// same markets — apples-to-apples, deterministic with our seeded RNG.
function trySuccess(L){
  if(!canRunEngine() || isHouseholdStorageReadOnly()) return NaN;
  try{
    const p = planForScenario(L);
    const ov = leversToOverrides(L);
    return runSimulation(p, ov, sharedPaths).successRate;
  }catch(_){
    return NaN;
  }
}
// Probability (0–100) of ending with at least `goal` dollars — the legacy score.
function tryLegacyProb(L, goal){
  if(!canRunEngine() || isHouseholdStorageReadOnly()) return NaN;
  try{
    const p = planForScenario(L);
    const ov = leversToOverrides(L);
    const res = runSimulation(p, ov, sharedPaths);
    const n = res.sims.length || 1;
    return 100 * res.sims.filter(s => s.terminalBalance >= goal).length / n;
  }catch(_){
    return NaN;
  }
}
// Solve ONE lever: holding all others at `baseLev`, find the value of `key`
// closest to its baseline that achieves >= targetPct. Returns { value,
// reachedPct, capped }. capped=true means even the lever's most-aggressive
// extreme can't reach the target — we return that extreme + the % it hit.
//
// Two strategies by range size:
//  • SMALL range (≤12 steps, e.g. Allocation's 5 risk levels, SS age's 9): scan
//    EVERY value. Allocation is NOT monotonic — more equity lifts expected
//    return but adds volatility drag, so success can rise then fall. Bisection
//    (which assumes monotonicity) would silently return a wrong level. An
//    exhaustive scan is correct for any shape and cheap at this count.
//  • LARGE range (spending, savings): bisect. These ARE monotonic in success
//    and have hundreds of steps, so a full scan would be needlessly slow.
// `score(L)` returns the metric to clear (0–100); defaults to plan success %,
// but legacy goals pass a "% chance of leaving ≥ $X" scorer. Everything else
// (closest-to-baseline, scan vs bisection, capped handling) is unchanged.
function solveLeverFor(baseLev, key, targetPct, score = trySuccess, band = null){
  const cfg = LEVCFG.find(c=>c.key===key);
  if(!cfg) return null;
  const r = band || levRange(cfg);
  const lo = r.min, hi = r.max, step = r.step;
  if(lo === hi) return { value: lo, reachedPct: score({...baseLev,[key]:lo}), capped:false };
  const pctAt = v => score({...baseLev, [key]: v});
  const nSteps = Math.round((hi - lo) / step);

  if(nSteps <= 12){
    // Exhaustive scan. Pick the value closest to the lever's current (baseline)
    // setting that meets target; if none meet, return the best-achievable value
    // (capped). Direction-agnostic — works for non-monotonic levers.
    const baseV = baseLev[key];
    let passVal = null, passPct = -1, bestVal = lo, bestPct = -Infinity;
    for(let i = 0; i <= nSteps; i++){
      const v = lo + i * step;
      const pct = pctAt(v);
      if(!Number.isFinite(pct)) continue;
      if(pct > bestPct){ bestPct = pct; bestVal = v; }
      if(pct >= targetPct &&
         (passVal === null || Math.abs(v - baseV) < Math.abs(passVal - baseV))){
        passVal = v; passPct = pct;
      }
    }
    if(!Number.isFinite(bestPct)) return null;
    return passVal !== null
      ? { value: passVal, reachedPct: passPct, capped: false }
      : { value: bestVal, reachedPct: bestPct, capped: true };
  }

  // Large monotonic range → bisection (detect direction from the endpoints).
  const pctLo = pctAt(lo), pctHi = pctAt(hi);
  if(!Number.isFinite(pctLo) || !Number.isFinite(pctHi)) return null;
  const increases = pctHi >= pctLo;                  // success rises with higher value?
  const best      = Math.max(pctLo, pctHi);
  const bestVal   = (pctHi >= pctLo) ? hi : lo;
  if(best < targetPct){ return { value: bestVal, reachedPct: best, capped: true }; }
  // Bisect for the value closest to baseline that meets target. We track the
  // smallest "passing" value on the side of monotonicity.
  let a = lo, b = hi;
  for(let i = 0; i < 9; i++){
    const mid = Math.max(lo, Math.min(hi, Math.round(((a+b)/2) / step) * step));
    if(mid === a || mid === b) break;
    const pct = pctAt(mid);
    if(!Number.isFinite(pct)) return null;
    const meets = pct >= targetPct;
    // For positive direction (success rises with value): we want SMALLEST value
    // that meets. For inverse: we want LARGEST value that meets.
    if(increases){ if(meets) b = mid; else a = mid; }
    else         { if(meets) a = mid; else b = mid; }
  }
  const value = increases ? b : a;
  const reachedPct = pctAt(value);
  return Number.isFinite(reachedPct)
    ? { value, reachedPct, capped: false }
    : null;
}
// ── Solver (selectable goal · solo per-lever answers) ───────────────────────
// The advisor picks a GOAL the client actually wants (retire early, afford a big
// purchase, gift to family, leave a legacy, or just hit a confidence bar), then
// for every controllable lever we show what it ALONE would need to be to reach
// that goal — holding all else at today's plan. Neutral: no weighting, no
// bundling. The advisor reads each contribution and surmises any blend.
// Combo solver state. The fold-down is opened on demand (the search is heavy),
// so comboResults stays null until the advisor opens it for a given solve; it's
// cleared whenever the underlying solo solve changes.

// Levers that get a solo answer. Some goals PIN one (excluded from the list).
// Allocation/risk is intentionally OUT — "take more risk to hit a goal" isn't a
// clean planning recommendation (parked in the idea bank). SS stays, though it's
// a weak % mover for high-spend households (its value is lifetime dollars).
const SOLVE_KEYS = ['retireAge','spend','savings','ssAge','pensionAge'];

// ── Combo solver tuning (all adjustable — refine with use) ──────────────────
// "Least disruptive" blends the three active product rules:
//   1. minimize the BIGGEST single lever stretch (each move normalized to its
//      own realistic band), so no one lever carries the whole load;
//   2. weight spending CUTS heavier — protect lifestyle, so combos lean to
//      save-more / claim-SS-later before they cut spend;
//   3. break ties by the smallest TOTAL move.
const COMBO_SPEND_CUT_W = 1.6;                 // penalty multiplier on a spend cut
const COMBO_A_FRACTIONS = [0.3, 0.55, 0.8];    // PARTIAL pushes of lever A (never the full solo move) so B genuinely shares the load
const COMBO_MAX_CARDS   = 3;                    // cards shown
const COMBO_MAX_LEVERS  = 3;                    // candidate levers searched (caps cost)
// Short labels for the combo pills (the lever names are too long for a pill).
const COMBO_SHORT = { retireAge:'Retire', ssAge:'SS at', spend:'Spend', savings:'Save', pensionAge:'Pension' };

// Realistic search band per lever (relative to baseline) so a solo answer can't
// suggest something absurd ($73k/yr savings off a $30k base). Not limiting: if a
// lever can't reach the goal within its band it truthfully reports "best hits X%".
function solveBand(key, baseLev){
  const cfg = LEVCFG.find(c=>c.key===key);
  const r   = levRange(cfg);
  const cur = plan.household.primary.currentAge;
  let min = r.min, max = r.max;
  if(key==='spend'){        min = Math.round(baseLev.spend*0.70/100)*100; max = Math.round(baseLev.spend*1.30/100)*100; }
  else if(key==='savings'){ min = 0; max = Math.max(baseLev.savings*2, baseLev.savings+25000); }
  else if(key==='retireAge'){ min = Math.max(cur+1, baseLev.retireAge-5); max = baseLev.retireAge+5; }
  // ssAge (62–70) and pensionAge (quoted range) are already tight — leave full.
  return { min: Math.max(r.min, min), max: Math.min(r.max, max), step: r.step };
}

// Goal registry. Each goal: how it reads, the param fields it needs, which lever
// (if any) it pins, and (legacy) a custom scorer. `bar` = label for the % box.
const GOALS = {
  confidence: { label:'Reach a confidence level',          bar:'confidence', params:[] },
  retire:     { label:'Retire by an age',                  bar:'confidence', params:['age'],          pin:'retireAge' },
  purchase:   { label:'Afford a big one-time goal',        bar:'confidence', params:['amount','age'] },
  gift:       { label:'Gift / fund education yearly',      bar:'confidence', params:['amount','toAge'] },
  legacy:     { label:'Leave a legacy',                    bar:'chance',     params:['amount'] },
};

// One solved lever → a clean "was → needs to be (delta)" descriptor.


// The goal-dependent parameter fields + the % bar, rendered together so the
// whole strip swaps when the goal dropdown changes.


function renderSolvePanel(){
  const el = $('#solve-panel');
  if(!el) return;
  if(isHouseholdStorageBlocked()){
    el.innerHTML = '';
    syncRecoveryControls();
    return;
  }
  el.innerHTML = solvePanelHTML({
    solverFormOpen, scenarios, defaultLevers, goals:GOALS,
    currentAge:plan.household.primary.currentAge,
    planEndAge:resolveGoalSpan(plan).planEndAge,
    solverResults, solverSearching, comboOpen, comboSearching, comboResults,
    levCfg:LEVCFG, comboShort:COMBO_SHORT, escHtml,
  });
  syncRecoveryControls();
}

// Solve toward a chosen GOAL. Build soloBase = today's plan + the wish applied,
// pick the scorer (success %, or legacy "% chance of ≥ $X"), then for each
// controllable lever find what it ALONE would need within a realistic band —
// holding all else at soloBase. Neutral: no weighting, no bundling. The advisor
// reads each lever's required move and surmises any blend.
async function runSolve(goalType, params){
  if(!guardPlanMutation()) return;
  if(solving) return;
  uiState.solving = true; uiState.solverFormOpen = false; uiState.solverSearching = true; uiState.solverResults = null;
  renderSolvePanel();

  let preflight = null;
  try{ preflight = resolveInputs(plan, {}); }catch(_){ /* unavailable below */ }
  if(!preflight
      || preflight.simulationAvailable === false){
    uiState.solverSearching = false;
    uiState.solving = false;
    renderSolvePanel();
    return;
  }

  if(!sharedPaths){
    resetSeed();
    const horizon = preflight.horizonYears;
  uiState.sharedPaths = [];
  for(let i=0; i<plan.simulation.iterations; i++) uiState.appendSharedPath(generateReturnPath(horizon));
  }

  const baseLev  = JSON.parse(JSON.stringify(scenarios.find(s=>s.base)?.lev || defaultLevers()));
  const soloBase = JSON.parse(JSON.stringify(baseLev));
  let pinned = null, score = trySuccess;
  if(goalType==='retire'){        soloBase.retireAge = params.age; pinned = 'retireAge'; }
  else if(goalType==='purchase'){ soloBase.eventAmt = params.amount; soloBase.eventAge = params.age; }
  else if(goalType==='gift'){     soloBase.giftAmt = params.amount; soloBase.giftEndAge = params.toAge; }
  else if(goalType==='legacy'){   score = (L)=>tryLegacyProb(L, params.amount); }
  syncPension(soloBase);

  const keys = SOLVE_KEYS.filter(k => k !== pinned);
  const rows = [];
  for(const k of keys){
    await new Promise(r => setTimeout(r, 0));      // yield so the spinner paints
    const band = solveBand(k, soloBase);
    const res  = solveLeverFor(soloBase, k, params.pct, score, band);
    if(res) rows.push({ key:k, value:res.value, reachedPct:res.reachedPct, capped:res.capped });
  }

  // Gift injects a liability with no column/lever to display, so its solos
  // can't be loaded as a scenario faithfully — read-only. Everything else loads.
  uiState.solverResults  = { goalType, params, targetPct: params.pct, soloBase, rows, canLoad: goalType!=='gift' };
  uiState.solverSearching = false;
  uiState.solving = false;
  // A fresh solo solve invalidates any combos computed for the previous one.
  uiState.comboResults = null; uiState.comboOpen = false; uiState.comboSearching = false;
  renderSolvePanel();
}

// ── Combo solver ────────────────────────────────────────────────────────────
// When no SINGLE lever reaches the goal, the advisor opens the fold-down and we
// search PAIRS of the remaining levers (the goal's pinned lever is held fixed).
// For each pair we push lever A partway toward its helpful end, then solve B to
// the gentlest value that still clears the target — tracing the trade-off line.
// Every % is the real engine on the shared market paths (apples-to-apples). We
// then rank the passing combos by the blended "least-disruptive" score and show
// the gentlest one per distinct lever-pair. No new math in the engine — this is
// pure search over engine outputs.

// One combo pill's value text: deltas for the dollar levers (reads like "spend
// $850/mo less"), absolute for the age levers ("SS at 70").

// The anchor pill describing the (held-fixed) goal, shown first on every card.

// Build a combo record from a set of [key,value] moves: pill text + the blended
// disruption score (rule 1 = biggest weighted stretch; rule 3 = total move).
function makeCombo(soloBase, moves, pct, basePct, meta){
  const items = moves.map(([k,v])=>{
    const span = (meta[k].band.max - meta[k].band.min) || 1;
    const norm = Math.abs(v - soloBase[k]) / span;
    const cut  = (k==='spend' && v < soloBase[k]);     // the one move that hurts lifestyle
    return { key:k, val:v, pv:comboPillValue(k, soloBase[k], v), cut,
             wnorm: norm*(cut?COMBO_SPEND_CUT_W:1), norm };
  });
  return {
    items, pct, deltaPts: pct - basePct,
    disruption: Math.max(...items.map(m=>m.wnorm)),    // minimize the biggest stretch
    spread:     items.reduce((s,m)=>s+m.norm,0),       // tie-break: least total move
    pairKey:    moves.map(m=>m[0]).sort().join('+'),
  };
}

async function runComboSolve(){
  if(!guardPlanMutation()) return;
  if(!solverResults || comboSearching) return;
  uiState.comboSearching = true; uiState.comboResults = null; renderSolvePanel();
  await new Promise(r=>setTimeout(r,0));     // let the spinner paint

  let preflight = null;
  try{ preflight = resolveInputs(plan, {}); }catch(_){ /* unavailable below */ }
  if(!preflight
      || preflight.simulationAvailable === false){
    uiState.comboSearching = false;
    renderSolvePanel();
    return;
  }

  // sharedPaths is already built by the solo solve, but guard anyway.
  if(!sharedPaths){
    resetSeed();
    const horizon = preflight.horizonYears;
  uiState.sharedPaths = [];
  for(let i=0;i<plan.simulation.iterations;i++) uiState.appendSharedPath(generateReturnPath(horizon));
  }

  const R = solverResults;
  const target   = R.targetPct;
  const soloBase = JSON.parse(JSON.stringify(R.soloBase));
  const score    = R.goalType==='legacy' ? (L)=>tryLegacyProb(L, R.params.amount) : trySuccess;
  const pinned   = R.goalType==='retire' ? 'retireAge' : null;
  const basePct  = score(soloBase);

  // Candidate levers = solvable set minus the pinned one, pruned to those whose
  // solo move actually helped, then capped to the most-promising few (cost).
  let cand = SOLVE_KEYS.filter(k => k!==pinned);
  const helpful = cand.filter(k=>{
    const row = R.rows.find(r=>r.key===k);
    return row && row.reachedPct > basePct + 0.3;
  });
  if(helpful.length >= 2) cand = helpful;
  if(cand.length > COMBO_MAX_LEVERS){
    cand = cand.slice().sort((a,b)=>
      (R.rows.find(r=>r.key===b)?.reachedPct ?? 0) - (R.rows.find(r=>r.key===a)?.reachedPct ?? 0)
    ).slice(0, COMBO_MAX_LEVERS);
  }

  // Per-candidate band + helpful direction (one pair of evals each).
  const meta = {};
  for(const k of cand){
    await new Promise(r=>setTimeout(r,0));
    const band  = solveBand(k, soloBase);
    const baseV = soloBase[k];
    const pLo = score({...soloBase,[k]:band.min});
    const pHi = score({...soloBase,[k]:band.max});
    meta[k] = { band, baseV, end: (pHi>=pLo) ? band.max : band.min };
  }

  // Sweep A toward its helpful end; at each step solve B to the gentlest value
  // that clears target. Keep combos where BOTH levers actually moved.
  // Ordered pairs: sweeping A→solve-B and B→solve-A trace different points on the
  // same trade-off line, so we try both and keep the gentlest per unordered pair.
  const combos = [];
  for(let i=0;i<cand.length;i++){
    for(let j=0;j<cand.length;j++){
      if(i===j) continue;
      const A=cand[i], B=cand[j], ma=meta[A], mb=meta[B], step=ma.band.step;
      // Restrict B to its HELPFUL half (baseline → helpful end) so a solve can
      // never push B backward to "make room" for A — both levers only ever help.
      const bBand = mb.end >= mb.baseV
        ? { min: mb.baseV, max: mb.band.max, step: mb.band.step }
        : { min: mb.band.min, max: mb.baseV, step: mb.band.step };
      for(const f of COMBO_A_FRACTIONS){
        await new Promise(r=>setTimeout(r,0));
        let aVal = Math.round((ma.baseV + f*(ma.end - ma.baseV))/step)*step;
        aVal = Math.max(ma.band.min, Math.min(ma.band.max, aVal));
        if(aVal === ma.baseV) continue;                         // A didn't move
        if(score({...soloBase,[A]:aVal}) >= target) continue;   // A alone already clears it → not a real pairing
        const res = solveLeverFor({...soloBase,[A]:aVal}, B, target, score, bBand);
        if(!res || res.capped) continue;                        // pair can't reach target
        if(res.value === mb.baseV) continue;                    // B didn't move → solo-A
        combos.push(makeCombo(soloBase, [[A,aVal],[B,res.value]], res.reachedPct, basePct, meta));
      }
    }
  }
  // Gentlest first; keep one (the gentlest) per distinct lever-pair, top N.
  combos.sort((x,y)=> x.disruption - y.disruption || x.spread - y.spread);
  const seen = new Set(), top = [];
  for(const c of combos){
    if(seen.has(c.pairKey)) continue;
    seen.add(c.pairKey); top.push(c);
    if(top.length >= COMBO_MAX_CARDS) break;
  }
  uiState.comboResults = { goalType:R.goalType, params:R.params, target, basePct, soloBase,
                   canLoad: R.canLoad, combos: top };
  uiState.comboSearching = false;
  renderSolvePanel();
}



// Scenarios are NAMED, SAVEABLE objects (the household-centric data root). They
// start identical; the advisor moves levers to show each decision's effect, and
// can rename / add / remove them. Both tabs read this shared set.
// The first-run scenario set tells a story: B delays the plan's retirement
// (drawdown) age 2 years, C goes aggressive (wealth line jumps, success does
// NOT — volatility drag). Deltas are relative to the ACTIVE household's base
// levers so the set is meaningful for any household, not just the demo.
function demoScenarios(){
  const s=[
    {name:'Baseline',   base:true,  lev:defaultLevers(), res:null},
    {name:'Scenario B', base:false, lev:defaultLevers(), res:null},
    {name:'Aggressive', base:false, lev:defaultLevers(), res:null},
  ];
  // Scenario B contrast. Pre-retirement: "retire 2 years later" (the core lever
  // when we're solving for a feasible retirement date). Already retired: that
  // lever is inert, so contrast on allocation instead (de-risk one notch).
  if(hhAlreadyRetired()){
    s[1].lev.risk = Math.max(1, ((plan.portfolio && plan.portfolio.riskProfile) || 3) - 1);
  } else {
    const baseRetire = (plan.household && plan.household.primary && plan.household.primary.retirementAge) || 65;
    s[1].lev.retireAge = baseRetire + 2;
  }
  s[2].lev.risk = 5;
  return s;
}
// Seed/hydrate the blank current-build record BEFORE scenarios seed. Saved
// households remain available, but reload never grants browser state authority
// to choose one on localhost or the deployed origin.
bootstrapHouseholds();
if(isHouseholdStorageBlocked()){
  uiState.scenarios = [];
} else {
  uiState.scenarios = loadScenarios() || demoScenarios();
}
// Solver UI state. solverFormOpen toggles the inline "Solve…" form in the band
// gutter; solving guards against re-entry while a solve is in flight.

/* A household is ALREADY RETIRED when every principal is at or past their own
   retirement age — there is no future retirement transition to plan for. In that
   state retirement age is a satisfied input: it may still show in the banner, but
   it must not drive any lever or engine result (like a one-time goal that has
   already happened). Retirement age stays a LIVE lever whenever anyone is still
   pre-retirement (the household retires when the LAST earner does). */
function hhAlreadyRetired(){
  const pr = plan.household && plan.household.primary;
  if(!pr || pr.currentAge == null || pr.retirementAge == null) return false;
  if(pr.currentAge < pr.retirementAge) return false;      // primary still working
  const sp = plan.household && plan.household.spouse;
  if(sp){
    if(sp.currentAge == null || sp.retirementAge == null) return false;
    if(sp.currentAge < sp.retirementAge) return false;    // co-client still working
  }
  return true;
}

/* Map a scenario's levers -> engine override object. */
function leversToOverrides(L){
  const ov={};
  const baseRetire = plan.household.primary.retirementAge;
  const baseSs     = plan.income.socialSecurity.primary.claimAge;
  // Retirement age is inert once the household is already retired — never emit a
  // retire delay in that case (a positive delay would wrongly re-open accumulation).
  if(!hhAlreadyRetired() && L.retireAge !== baseRetire) ov.retireDelay = L.retireAge - baseRetire;
  if(L.ssAge !== baseSs)         ov.ssDelayYears = L.ssAge - baseSs;
  // Essentials is an absolute dollar figure, so the scenario sets it directly
  // rather than as a percentage swing off the base. A percentage would also
  // drag every other discretionary goal along with it, which is not what an
  // "Essentials" input should mean — and it has no meaning at all from a $0
  // base, which is where every new household starts.
  const scenarioSpend = Number(L.spend);
  if(!Number.isFinite(scenarioSpend) || scenarioSpend < 0){
    throw new TypeError('Scenario spending must be a finite non-negative number');
  }
  ov.livingAnnual = scenarioSpend;
  if(L.eventAmt>0){ ov.lumpSum = L.eventAmt; ov.lumpSumYear = Math.max(0, L.eventAge - plan.household.primary.currentAge); }
  const baseSavings = Number(plan.savings.annual);
  const scenarioSavings = Number(L.savings);
  if(!Number.isFinite(baseSavings) || baseSavings < 0
    || !Number.isFinite(scenarioSavings) || scenarioSavings < 0){
    throw new TypeError('Scenario savings must be a finite non-negative number');
  }
  if(baseSavings > 0 && scenarioSavings !== baseSavings){
    ov.savingsBump = (scenarioSavings - baseSavings) / baseSavings;
  }else if(baseSavings === 0 && scenarioSavings > 0){
    ov.savingsAnnual = scenarioSavings;
    const savedSplit = plan.savings.split;
    const traditionalShare = savedSplit
      ? Number(savedSplit.traditional) || 0
      : 1;
    if(plan.household.spouse && traditionalShare > 0){
      // Generic household savings has no contributor owner. Keep a zero-base
      // couple scenario in taxable savings instead of inventing an IRA owner.
      ov.savingsSplit = { taxable: 1 };
    }
  }
  // Pension: always pass the chosen age as an absolute override so the engine
  // looks up the entered benefit for THAT exact age (or pays 0 if no entry).
  ov.pensionStartAge = L.pensionAge;
  // Earmarked-asset sale — emitted ONLY when an age is chosen (≥ currentAge), so
  // the Baseline (sellAge = off) carries no sale and stays clean.
  if(plan.properties && plan.properties.length && L.sellAge != null && L.sellAge >= plan.household.primary.currentAge){
    ov.assetSale = { asset: 0, age: L.sellAge };
  }
  return ov;
}
/* Risk lever changes the profile -> needs a plan clone, not an override.
   A gift/education goal injects a time-limited recurring outflow (a liability
   with start/end age). colaPct = inflation so it stays real-constant — the
   advisor enters today's dollars. No-op for normal scenarios (no giftAmt). */
function planForScenario(L){
  const p=JSON.parse(JSON.stringify(plan));
  p.portfolio.riskProfile = L.risk;
  // Per-scenario goal overrides (Compare-editable): amount / startAge / endAge keyed
  // by the goal's index in the base inventory. Applied to the CLONE only, so the base
  // plan.goals (Goals-page source of truth) and every other scenario are untouched.
  if(L.goalOv && Array.isArray(p.goals)){
    p.goals = p.goals.map((g,i)=>{
      const ov = L.goalOv[i];
      if(!ov) return g;
      return {
        ...g,
        amount:   (ov.amount   != null) ? ov.amount   : g.amount,
        startAge: (ov.startAge != null) ? ov.startAge : g.startAge,
        endAge:   (ov.endAge   != null) ? ov.endAge   : g.endAge,
      };
    });
  }
  if(L.giftAmt > 0 && L.giftEndAge){
    p.liabilities = (p.liabilities || []).concat([{
      amount: L.giftAmt,
      startAge: plan.household.primary.currentAge,
      endAge: L.giftEndAge,
      colaPct: LONGRUN_INFLATION * 100
    }]);
  }
  return p;
}

/* ── Inputs tab: edit the base plan (household data root) ──────────────────
   `plan` is the single source. Scenarios draw their baseline from it; each
   scenario then carries its own adjustment. Editing a base input re-seeds
   every column from the NEW base while PRESERVING each scenario's delta (its
   decision) — so "draw from base, then adjust" holds automatically. */
if(!plan.income.socialSecurity.spouse && guardPlanMutation()) plan.income.socialSecurity.spouse={pia:0,claimAge:67};

const RISK_NAMES={1:'Conservative',2:'Mod-Cons',3:'Moderate',4:'Mod-Agg',5:'Aggressive'};

/* ── Sub-page registry ─────────────────────────────────────────────
   Four sub-pages live under the Net Worth tab. Balance Sheet uses the
   STATEMENT layout (leader-dot rows under thin accent section heads).
   Inflows / Outflows / Goals use the HYBRID layout (left-gutter identity
   block + two facing columns split by a single vertical hairline).
   Each hybrid page's gutter computes its own running total from the live
   plan values — same place on every page so the eye knows where to land. */
const SUB_PAGES = {
  'cashflow':      { label:'Cash Flow', layout:'hybrid', totLabel:'Annual income' },
  'goals':         { label:'Goals',     layout:'goals',  totLabel:'Annual goal spend' },
  'snapshot':      { label:'Snapshot',  layout:'snapshot' },
};

const STRATEGY_NAMES = {
  'taxable-first':'Taxable first',
  'traditional-first':'Traditional first',
  proportional:'Proportional'
};

/* ── Hybrid columns: each sub-page has a LEFT and a RIGHT column.
   Each item carries name + path + type, and an optional meta() that draws
   from the live plan (e.g. "claim at 67" reads the actual claim age). */
const HYBRID = {
  // Income and expenses live on ONE page (Cash Flow). Income = Fixed (SS, pension)
  // + Variable. Expenses = Essential only — discretionary spending is modeled as
  // Goals, so it isn't duplicated here.
  'cashflow': {
    left:  { head:'Income', groups:[
      { head:'Fixed income', items:[
        {path:'income.socialSecurity.primary.pia', name:'Social Security · Primary', type:'money', meta:()=>`Claim at age ${plan.income.socialSecurity.primary.claimAge}`},
        {path:'income.socialSecurity.spouse.pia',  name:'Social Security · Co-Client',  type:'money', meta:()=>plan.income.socialSecurity.spouse?`Claim at age ${plan.income.socialSecurity.spouse.claimAge}`:''},
      ], dynamic:'pension' },
      { head:'Variable', section:{ arr:'income.other', kind:'income', nameKey:'label', ph:'Source', add:'+ add a variable income source' } },
    ]},
    // Spending is entered on the Goals page. This column used to bind
    // expenses.living / expenses.healthcare directly, which are retired — an
    // editor for fields the engine no longer reads is worse than no editor.
    right: { head:'Expenses', groups:[
      { head:'Essential', note:'Essentials and Healthcare are goals — edit them on the Goals page.', items:[] },
    ]},
  },
};

/* Active sub-page for the net-worth page. The Goals sub-view lives here.
   Household is its own editable data-page="household" console (the 5-step
   wizard: renderWizHousehold/Accounts/Income/Retirement/Blueprint via
   syncHousehold). */
const SUB_KEY = 'parallax.netWorth.sub';
let activeSub = 'goals';
const getPath=(o,p)=>p.split('.').reduce((a,k)=>a&&a[k],o);
const setPath=(o,p,v)=>{const ks=p.split('.');const last=ks.pop();let t=o;for(const k of ks){if(t==null)return;t=t[k];}if(t!=null)t[last]=v;};

// Live comma formatting for money inputs. Reformats on every keystroke and
// preserves the caret's LOGICAL position (after the same number of digits)
// so typing left-to-right feels natural — no caret-jumping-to-end weirdness.
function liveCommas(el){
  const old = el.value;
  const caret = el.selectionStart ?? old.length;
  const digitsBefore = (old.slice(0, caret).match(/\d/g) || []).length;
  const digits = old.replace(/[^0-9]/g, '');
  if(!digits){ el.value = ''; return; }
  const formatted = parseInt(digits, 10).toLocaleString('en-US');
  el.value = formatted;
  let pos = 0, seen = 0;
  while(pos < formatted.length && seen < digitsBefore){
    if(/\d/.test(formatted[pos])) seen++;
    pos++;
  }
  el.setSelectionRange(pos, pos);
}

uiState.baseSnapshot=defaultLevers();   // base lever values; used to preserve deltas

// Re-seed scenarios from the current base, keeping each scenario's adjustment.
// Every plan edit funnels through here, then persists the plan and scenarios.
function reseedScenarios({ markDirty = true } = {}){
  if(!guardPlanMutation()) return;
  const nb=defaultLevers();
  const LINKED=['retireAge','ssAge','spend','savings','pensionAge'];   // base-linked levers
  scenarios.forEach(s=>{
    Object.keys(nb).forEach(k=>{
      if(s.base){ s.lev[k]=nb[k]; return; }   // baseline always mirrors the base
      if(!LINKED.includes(k)) return;         // allocation / one-time event stay as set
      const cfg=LEVCFG.find(c=>c.key===k);
      const priorDelta = s.lev[k]-baseSnapshot[k];
      let v=nb[k]+priorDelta;  // new base + this scenario's delta
      // A scenario with no delta must remain identical to its baseline even
      // when the baseline sits outside an interactive control's range.
      if(cfg && priorDelta!==0){
        const r=levRange(cfg); v=Math.max(r.min,Math.min(r.max,v));
      }
      s.lev[k]=v;
    });
    syncPension(s.lev);   // auto-linked pension follows the (possibly new) retire age
  });
  uiState.baseSnapshot=nb;
  if(markDirty) autoSavePlan();
}

/* ── Derived totals (pure aggregation of typed inputs, NOT engine output) ──
   These read the live plan and feed the gutter on each sub-page. The gutter
   is the same shape on every page — a big number + breakdown rows — so the
   eye lands in the same place. Useful information, not descriptions. */
// Typed investment accounts → tax sleeve. Workplace + IRA plans are pre-tax;
// the bucket is what the engine consumes (extraAccounts fold into the totals).
let acctSel = null;   // type currently armed in the add picker
// Post-edit refresh (mirrors the balance-sheet field commit, minus setPath).
function commitPlanEdit(){
  if(!guardPlanMutation()) return;
  reseedScenarios(); uiState.sharedPaths=null; uiState.plansDirty=true; renderInputs();
  syncPlanEditStatus('Saved automatically · open Scenarios');
}

function remapGoalOverridesForRemoval(index){
  if(!Array.isArray(scenarios)) return [];
  return scenarios.map((scenario,scenarioIndex)=>{
    const current=scenario?.lev?.goalOv;
    if(!current) return { scenarioIndex, override:null };
    const next={};
    let removed=null;
    Object.entries(current).forEach(([key,value])=>{
      const goalIndex=+key;
      if(goalIndex===index){ removed=JSON.parse(JSON.stringify(value)); return; }
      next[goalIndex>index?goalIndex-1:goalIndex]=value;
    });
    if(Object.keys(next).length) scenario.lev.goalOv=next;
    else delete scenario.lev.goalOv;
    return { scenarioIndex, override:removed };
  });
}

function insertGoalAt(index,goal,restoredOverrides=[]){
  if(!Array.isArray(plan.goals)) plan.goals=[];
  const at=Math.max(0,Math.min(index,plan.goals.length));
  plan.goals.splice(at,0,goal);
  if(!Array.isArray(scenarios)) return;
  const restoredByScenario=new Map(restoredOverrides.map(item=>[item.scenarioIndex,item.override]));
  scenarios.forEach((scenario,scenarioIndex)=>{
    if(!scenario?.lev) return;
    const current=scenario.lev.goalOv || {};
    const next={};
    Object.entries(current).forEach(([key,value])=>{
      const goalIndex=+key;
      next[goalIndex>=at?goalIndex+1:goalIndex]=value;
    });
    const restored=restoredByScenario.get(scenarioIndex);
    if(restored) next[at]=restored;
    if(Object.keys(next).length) scenario.lev.goalOv=next;
    else delete scenario.lev.goalOv;
  });
}

function removeGoalAt(index){
  if(!Array.isArray(plan.goals) || !plan.goals[index]) return { goal:null, overrides:[] };
  const [goal]=plan.goals.splice(index,1);
  return { goal, overrides:remapGoalOverridesForRemoval(index) };
}

const goalsHorizon=createGoalsHorizonController({
  getPlan:()=>plan,
  isReadOnly:()=>isHouseholdStorageReadOnly() || isHouseholdStorageBlocked(),
  guardMutation:guardPlanMutation,
  arm:()=>{
    reseedScenarios();
    uiState.sharedPaths=null;
    uiState.plansDirty=true;
    syncPlanEditStatus('Saved automatically · open Scenarios');
  },
  commit:commitPlanEdit,
  insertGoal:insertGoalAt,
  removeGoal:removeGoalAt,
});
const taxBuckets=createTaxBucketsController({
  getPlan:()=>plan,
  isStorageBlocked:isHouseholdStorageBlocked,
  getBlockedMessage,
});
taxBuckets.bind($('#tax-buckets-view'));

/* ═══════════════════════════════════════════════════════════════════════════
   HOUSEHOLD — the editable plan-input console (Demographics / Net Worth / Cash
   Flow), rendered as the Folio/glass document. EVERY core input is editable
   inline at all times: each value slot is a renderField() data-path control, and
   the #hh-view delegated handler writes back to `plan` and reseeds/dirties
   scenarios EXACTLY like the rest of the input layer (setPath → reseedScenarios →
   retired lever renderer → plansDirty=true). Money TRUTH (balances) is typed by the advisor;
   the OWNER of an account is a LABEL placing it in the Client / Spouse pillar or
   the joint holdings — derived displays (net-worth total, per-owner investable,
   ownership %, beam) recompute read-only on every sync, never faked.
   ═══════════════════════════════════════════════════════════════════════════ */
// Ownership is a UI label; data keys stay 'spouse' etc. Visible label is Co-Client.
const householdWizardController = createHouseholdWizardController({
  getPlan: () => plan,
  getHouseholdsDb: () => householdsDb,
  getActiveHouseholdId: () => activeHouseholdId,
  isStorageBlocked: isHouseholdStorageBlocked,
  renderBlockedRecoverySurfaces,
  syncRecoveryControls,
  onSwitchHousehold: switchHousehold,
  onNewHousehold: newHousehold,
  onLoadDemoHousehold: loadDemoHousehold,
});
const hhUiState = householdWizardController.uiState;
const householdWizardCommitBoundary = createHouseholdWizardCommitBoundary({
  getPlan: () => plan,
  replacePlan: next => hydratePlan(next),
  afterCommit(){
    reseedScenarios();
    uiState.sharedPaths = null;
    uiState.plansDirty = true;
    renderInputs();
    syncHousehold();
    syncPlanEditStatus('Saved automatically · open Scenarios');
  },
});
/* Wizard state: Family · Net Worth · Tax · Summary. */


/* ── Household lifecycle helpers ───────────────────────────────────────────
   All of these hydrate the live `plan`, re-scope scenarios to the active
   household, persist, and re-render through the full reseed/dirty/run flow.
     hhLoadRecord(rec, status)  → shared tail: hydrate + scenarios + render.
     loadDemoHousehold() → ensures and loads the persistent blank demo slot.
     newHousehold()    → creates a blank household, makes it active.
     switchHousehold() → loads another saved household by id. */
function hhLoadRecord(status){
  if(isHouseholdStorageBlocked()){ guardPlanMutation(); return; }
  const readOnly = isHouseholdStorageReadOnly();
  planSaveDirty = false; saveFailed = false;
  if(!readOnly) reseedScenarios({ markDirty: false });
  householdWizardController.resetForPlan();
  uiState.plansDirty = true; uiState.sharedPaths = null;
  syncHousehold();
  updateHouseholdControls();
  renderInputs();
  taxBuckets.sync();
  runAll();
  syncRecoveryControls();
  if(status) syncHeaderStatus(status);
}
// Open a fresh current-build blank slot. A prior in-session edit must not turn
// the Demo entry into browser-owned template data.
function loadDemoHousehold(){
  if(isHouseholdStorageBlocked()){ guardPlanMutation(); return; }
  if(isHouseholdStorageReadOnly() && !householdsDb.demo){ syncRecoveryControls(); return; }
  const blank = createDemoHousehold(PRISTINE_PLAN, new Date().getFullYear());
  householdsDb.demo = blank;
  activeHouseholdId = 'demo';
  hydratePlan(blank);
  uiState.scenarios = demoScenarios();
  uiState.baseSnapshot = defaultLevers();
  hhLoadRecord('Loaded Demo Household');
}
// Create and immediately persist a brand-new blank household.
function newHousehold(){
  if(!guardPlanMutation()) return;
  if(!canChangeActiveHousehold()) return;
  saveScenarios();                       // …and persist its scoped scenarios
  const blank = createBlankHousehold(PRISTINE_PLAN, newHouseholdId(), new Date().getFullYear());
  householdsDb[blank.meta.householdId] = blank;
  activeHouseholdId = blank.meta.householdId;
  hydratePlan(blank);
  uiState.scenarios = demoScenarios();
  uiState.baseSnapshot = defaultLevers();
  hhLoadRecord('New household created');
  autoSavePlan();
  syncPlanEditStatus('New household created · saved automatically');
}
// Switching is blocked only when the latest automatic save failed.
function switchHousehold(id){
  if(isHouseholdStorageBlocked()){ guardPlanMutation(); return; }
  if(!householdsDb[id] || id === activeHouseholdId) return;
  if(!canChangeActiveHousehold()){
    householdWizardController.updateHouseholdControls();
    return;
  }
  const readOnly = isHouseholdStorageReadOnly();
  if(!readOnly){
    saveScenarios();                     // persist the outgoing household's scenarios
  }
  activeHouseholdId = id;
  if(!readOnly) persistActiveId();
  hydratePlan(householdsDb[id]);
  uiState.scenarios = loadScenarios(id) || demoScenarios();
  uiState.baseSnapshot = defaultLevers();
  if(!readOnly) saveScenarios();
  hhLoadRecord('Loaded ' + ((plan.meta && plan.meta.name) || 'household'));
}
// Populate the saved-household switcher.
function updateHouseholdControls(){
  householdWizardController.updateHouseholdControls();
}

/* One authoritative Household sync: fill wizard identity, render the active
   STEP into #hh-view + the live "Plan so far" rail, and reflect step state on
   the stepper. Called at boot, on tab show, and after every edit (the #hh-view
   delegate re-renders through here). */
function syncHousehold(){
  householdWizardController.sync();
}
/* Stepper + household-menu chrome = the view switch. Bound once at boot. */
function bindHouseholdRailOnce(){
  householdWizardController.bindRail();
}

// Column subtotals — sums every group in HYBRID[page].left / .right (a column may
// be one or more groups). Dynamic-pension items are included automatically.
function groupSum(g){
  let s = 0;
  (g.items||[]).forEach(it => { s += (getPath(plan, it.path)||0); });
  if(g.dynamic==='pension'){
    const m=(plan.income.pension&&plan.income.pension.benefitByAge)||{};
    const pStart=(plan.income.pension&&plan.income.pension.startAge);   // pays ONE amount
    s += (pStart && m[pStart]) || 0;
  }
  if(g.section){ (getPath(plan, g.section.arr)||[]).forEach(r => { s += (r.amount||0); }); }
  return s;
}
function colSum(page, side){
  const col = HYBRID[page] && HYBRID[page][side];
  if(!col) return 0;
  return (col.groups || [col]).reduce((s,g)=>s+groupSum(g), 0);
}
function hybridTotal(page){ return colSum(page,'left') + colSum(page,'right'); }

// Page-specific gutter HTML. Same shape on every page — title row + big
// number + a breakdown of the parts. No descriptions; the structure IS the
// description. Net Worth shows assets / liabilities / net; the three hybrid
// pages show the left-column total / right-column total / overall.
function renderGutter(pageKey){
  const sp = SUB_PAGES[pageKey];
  if(pageKey === 'balance-sheet'){
    const goalsAnnual = (plan.goals||[])
      .filter(g => g.startAge !== g.endAge)
      .reduce((s,g)=>s+(g.amount||0),0);
    return `<div class="np-gutter">
      <div class="lbl">Household</div>
        <div class="big-num">${fmtMoney(investableTotal(plan))}</div>
      <hr class="gut-rule"/>
      <div class="row"><span>Savings / yr</span><b>${fmtMoney(plan.savings.annual||0)}</b></div>
      <div class="row"><span>Spending / mo</span><b>${fmtMoney(Math.round(essentialsGoalAmount(plan)/12))}</b></div>
      <div class="row"><span>Goals / yr</span><b>${fmtMoney(goalsAnnual)}</b></div>
    </div>`;
  }
  const def = HYBRID[pageKey];
  // Cash Flow: headline = annual income; breakdown = income composition + expenses.
  if(pageKey === 'cashflow'){
    const income   = colSum(pageKey,'left');
    const expenses = colSum(pageKey,'right');
    const groupRows = (def.left.groups||[]).map(g =>
      `<div class="row"><span>${g.head}</span><b>${fmtMoney(groupSum(g))}</b></div>`).join('');
    return `<div class="np-gutter">
      <div class="lbl">${sp.totLabel}</div>
      <div class="big-num">${fmtMoney(income)}</div>
      <div class="big-sub">per year · today's dollars</div>
      <hr class="gut-rule"/>
      ${groupRows}
      <div class="row"><span>Expenses</span><b>${fmtMoney(expenses)}</b></div>
    </div>`;
  }
  const total = hybridTotal(pageKey);
  return `<div class="np-gutter">
    <div class="lbl">${sp.totLabel}</div>
    <div class="big-num">${fmtMoney(total)}</div>
    <div class="big-sub">per year · today's dollars</div>
    <hr class="gut-rule"/>
    <div class="row"><span>${def.left.head}</span><b>${fmtMoney(colSum(pageKey,'left'))}</b></div>
    <div class="row"><span>${def.right.head}</span><b>${fmtMoney(colSum(pageKey,'right'))}</b></div>
  </div>`;
}

/* ── Field renderer — one input element, shared by both layouts ──── */
function renderField(f, klass){
  const v = getPath(plan, f.path);
  if(f.type==='risk'){
    const opts = Object.keys(RISK_NAMES).map(k =>
      `<option value="${k}" ${+k===+v?'selected':''}>${RISK_NAMES[k]} · ${RISK_LABELS[k]}</option>`).join('');
    return `<select data-path="${f.path}" data-type="risk">${opts}</select>`;
  }
  if(f.type==='strategy'){
    const opts = Object.entries(STRATEGY_NAMES).map(([k,label]) =>
      `<option value="${k}" ${k===v?'selected':''}>${label}</option>`).join('');
    return `<select data-path="${f.path}" data-type="strategy">${opts}</select>`;
  }
  if(f.type==='text'){
    return `<input type="text" data-path="${f.path}" data-type="text" value="${escHtml(v||'')}" placeholder="${f.ph||''}">`;
  }
  if(f.type==='date'){
    return `<input type="date" data-path="${f.path}" data-type="text" value="${escHtml(v||'')}">`;
  }
  if(f.type==='money'){
    const dv = (v||0).toLocaleString('en-US');
    return `<span class="pre">$</span><input type="text" inputmode="numeric" data-path="${f.path}" data-type="money" value="${dv}">`;
  }
  if(f.type==='monthlyMoney'){
    const dv = Math.round((v||0)/12).toLocaleString('en-US');
    return `<span class="pre">$</span><input type="text" inputmode="numeric" data-path="${f.path}" data-type="monthlyMoney" value="${dv}">`;
  }
  if(f.type==='pct'){
    const dv = Math.round((v||0)*100);
    return `<input type="number" data-path="${f.path}" data-type="pct" value="${dv}" step="1"><span class="pre">%</span>`;
  }
  if(f.type==='gpct'){
    const dv = Math.round((Number(v)||0)*1000)/10;
    return `<input type="number" data-path="${f.path}" data-type="gpct" value="${dv}" step="0.1" min="-20" max="20"><span class="pre">%</span>`;
  }
  if(f.type==='signedPct'){
    const dv = Math.round((Number(v)||0)*1000)/10;
    return `<input type="number" data-path="${f.path}" data-type="signedPct" value="${dv}" step="0.1" min="-100" max="100"><span class="pre">%</span>`;
  }
  /* pctPoints: user enters whole percentage points (0–100), plan stores as-is.
     Use for fields where the engine itself divides by 100 (e.g. colaPct → engine does colaPct/100).
     Contrast with 'pct': user enters 55, plan stores 0.55, engine reads 0.55 directly. */
  if(f.type==='pctPoints'){
    const dv = (v||0);
    return `<input type="number" data-path="${f.path}" data-type="pctPoints" value="${dv}" step="0.5" min="0">`;
  }
  if(f.type==='num'){
    return `<input type="number" data-path="${f.path}" data-type="num" value="${v}" min="${f.min||0}" step="${f.step||1}">`;
  }
  /* rate: a float percentage (e.g. mortgage 6.25%) stored as-is. The #hh-view
     delegate writes the raw parsed float — unlike 'num' it must NOT round. */
  if(f.type==='rate'){
    return `<input type="number" data-path="${f.path}" data-type="rate" value="${v||0}" min="0" step="0.1">`;
  }
  if(f.type==='ageOrLife'){
    const dv = Number(v) >= 999 ? '' : v;
    return `<input type="number" data-path="${f.path}" data-type="ageOrLife" value="${dv ?? ''}" placeholder="Life" min="0" max="120" data-min="0" data-max="120" step="1">`;
  }
  // age
  const min = f.min != null ? ` min="${f.min}" data-min="${f.min}"` : '';
  const max = f.max != null ? ` max="${f.max}" data-max="${f.max}"` : '';
  return `<input type="number" data-path="${f.path}" data-type="${f.type}" value="${v}" step="1"${min}${max}>`;
}

/* ── Add-row sections ─────────────────────────────────────────────
   Schema-driven editable rows backed by a plan array. The SAME data-path
   binding + change handler that drives every other input writes these, so
   "add a row" is just pushing a default object and re-rendering, and "remove"
   is an array splice. Each kind names its backing array + a factory for a new
   row's defaults. (Goals share one array; recurring vs one-time is decided by
   the window: a one-time goal is a single-year window, startAge===endAge.) */
const ROW_KINDS = {
  income:    { arr:'income.other',   mk:()=>({ ...createIncomeSource(plan, 'wages', 'client'), label:'' }) },
  // 'expense' is retired — a time-bounded expense IS a recurring goal, so
  // goalRec covers it. Keeping it would append rows to an array nothing reads.
  liability: { arr:'liabilities',    mk:()=>({ label:'', amount:0, startAge:65, endAge:75, colaPct:0 }) },
  goalRec:   { arr:'goals',          mk:()=>{ const span=resolveGoalSpan(plan); return { name:'', amount:0, startAge:span.retirementAge, endAge:span.planEndAge }; } },
  goalOnce:  { arr:'goals',          mk:()=>({ name:'',  amount:0, startAge:70, endAge:70 }) },
  property:  { arr:'properties',     mk:()=>({ name:'',  value:0, purchasePrice:0, mortgage:{ balance:0, rate:0, termYears:0 } }) },
  account:   { arr:'portfolio.extraAccounts', mk:()=>createAccount('brokerage_taxable', { owner:'joint', balance:0 }) },
  // Wizard Step 1 children: advisor context, engine-inert (name + birth year).
  child:     { arr:'household.children', mk:()=>({ name:'', birthYear: new Date().getFullYear() - 10 }) },
};
const money = (p,base,k)=>`<span class="er-amt"><span class="pre">$</span><input type="text" inputmode="numeric" data-path="${base}.${k}" data-type="money" value="${(getPath(plan,base+'.'+k)||0).toLocaleString('en-US')}"></span>`;
const num   = (p,base,k,step)=>`<input class="er-num" type="number" step="${step||1}" data-path="${base}.${k}" data-type="num" value="${getPath(plan,base+'.'+k)}">`;
const name  = (p,base,k,ph)=>`<input class="er-name" type="text" data-path="${base}.${k}" data-type="text" value="${escHtml(getPath(plan,base+'.'+k)||'')}" placeholder="${ph}">`;
const rmX   = base=>`<button class="row-x" data-rmpath="${base}" title="Remove this row">×</button>`;

// A flow row (income / expense / liability): name · amount · from–to ages.
function flowRow(arr, i, nameKey, ph){
  const base = `${arr}.${i}`;
  return `<div class="erow">${name(plan,base,nameKey,ph)}${money(plan,base,'amount')}
    <span class="er-ages">age ${num(plan,base,'startAge')}<span class="er-dash">–</span>${num(plan,base,'endAge')}</span>${rmX(base)}</div>`;
}
// An income row = the flow row PLUS a compact second line for the two per-stream
// controls: real growth/yr (signed — negative phases the stream down) and the
// share taxed at the ordinary rate. gpct stores a signed fraction; pct a 0–1 one.
function incomeRow(arr, i){
  const base = `${arr}.${i}`;
  const g = Math.round((getPath(plan, base+'.realGrowth')||0)*100);
  const tRaw = getPath(plan, base+'.taxablePct');
  const t = Math.round((tRaw==null?1:tRaw)*100);
  const main = `<div class="erow">${name(plan,base,'label','Source')}${money(plan,base,'amount')}
    <span class="er-ages">age ${num(plan,base,'startAge')}<span class="er-dash">–</span>${num(plan,base,'endAge')}</span>${rmX(base)}</div>`;
  const extra = `<div class="er-extra">
      <span class="er-xk">grows</span><input class="er-num er-gw" type="number" step="1" data-path="${base}.realGrowth" data-type="gpct" value="${g}"><span class="er-xs">%/yr real</span>
      <span class="er-xsep">·</span>
      <input class="er-num" type="number" step="1" data-path="${base}.taxablePct" data-type="pct" value="${t}"><span class="er-xs">% taxable</span>
    </div>`;
  return `<div class="erow-wrap">${main}${extra}</div>`;
}
// Render every row of a flow kind backed by `arr`, with the trailing "+ add".
function flowSection(arr, nameKey, ph, kind, addLabel){
  const list = getPath(plan, arr) || [];
  const rowFn = (kind==='income') ? (i=>incomeRow(arr,i)) : (i=>flowRow(arr,i,nameKey,ph));
  let h = list.map((_,i)=>rowFn(i)).join('');
  h += `<div class="hp-add" data-add="${kind}">${addLabel}</div>`;
  return h;
}

/* The old Balance-Sheet statement / Map editor and five-step setup wizard were
   retired. The Household page now renders the four-step production intake. */

/* ── Hybrid layout (Inflows / Outflows / Goals) ───────────────────
   200px gutter (title + description + running total) + two facing columns
   split by a single vertical hairline. Each item: name on the left, boxless
   input on the right, meta line below the name in ink-mute. */
function renderHybrid(pageKey){
  const def = HYBRID[pageKey];
  // A "group" = one labelled block (head + fixed items + optional pension +
  // optional editable section/goals). A column is one or more groups stacked, so
  // the combined Cash Flow page can show Fixed income + Variable under Income.
  const renderGroup = g => {
    let h = g.head ? `<h4>${g.head}</h4>` : '';
    const items = (g.items||[]).slice();
    if(g.dynamic==='pension'){
      // ONE summary row — the benefit at the chosen start age. The full
      // benefit-by-age schedule and which age to claim is decided at the
      // Scenario level (the pension slider), not here.
      const pen = plan.income.pension || {};
      const pstart = pen.startAge;
      const ages = Object.keys(pen.benefitByAge||{}).map(Number).sort((a,b)=>a-b);
      const age = (pstart!=null && (pen.benefitByAge||{})[pstart]!=null) ? pstart
                : (ages.length ? ages[0] : null);
      if(age!=null){
        items.push({ path:`income.pension.benefitByAge.${age}`, name:'Pension', type:'money', meta:()=>`Begins at age ${age}` });
      }
    }
    items.forEach(it => {
      const xBtn = it.removable ? `<button class="row-x" title="Remove this row" data-rmpath="${it.path}">×</button>` : '';
      h += `<div class="hp-item"><div class="ti"><span class="nm">${it.name}</span><span class="field">${renderField(it)}${xBtn}</span></div>`;
      const m = it.meta ? it.meta() : '';
      if(m) h += `<div class="meta">${m}</div>`;
      h += `</div>`;
    });
    // Array-backed editable rows: a flow section (variable income) …
    if(g.section){
      const s = g.section;
      h += `<div class="erows">${flowSection(s.arr, s.nameKey, s.ph, s.kind, s.add)}</div>`;
    }
    // … or the goals array, split by window into recurring vs one-time columns.
    if(g.add && !g.section) h += `<div class="hp-add">${g.add}</div>`;
    return h;
  };
  const colHtml = colDef => {
    const groups = colDef.groups || [colDef];   // ungrouped pages: the column IS one group
    return `<div class="hp-col">${groups.map(renderGroup).join('')}</div>`;
  };
  return `<div class="np-page">
    ${renderGutter(pageKey)}
    <div class="hp-body">
      ${colHtml(def.left)}
      <div class="hp-rule"></div>
      ${colHtml(def.right)}
    </div>
  </div>`;
}

/* ── Snapshot (the diagnosis) ──────────────────────────────────────
   Three diagnostic gauges, each a RELATIONSHIP between numbers already
   entered — not engine projections. These are static rules-of-thumb (like a
   balance-sheet ratio): the income floor, the year-one withdrawal rate, and
   the tax-location mix. The engine still owns the real probability (Scenarios);
   this page is the at-a-glance condition of the household TODAY. Neutrality:
   the same gauges read green when the news is good and red when it isn't —
   the tool has no thesis, it just shows what's there. */
function snapshotMetrics(){
  const a = plan.portfolio.accounts;
  const taxable = a.taxable.balance||0, trad = a.traditional.balance||0, roth = a.roth.balance||0;
  const invest = taxable + trad + roth;
  // Guaranteed-for-life income at retirement: both SS benefits + pension at its
  // chosen start age (today's-dollar values straight off the inputs).
  const ssP = plan.income.socialSecurity.primary.pia||0;
  const ssS = (plan.income.socialSecurity.spouse && plan.income.socialSecurity.spouse.pia)||0;
  const pen = plan.income.pension||{};
  const penAmt = (pen.benefitByAge && pen.startAge!=null) ? (pen.benefitByAge[pen.startAge]||0) : 0;
  const guaranteed = ssP + ssS + penAmt;
  // Essentials and Healthcare are the two pre-loaded system goals; everything
  // else on the Goals page is discretionary. Splitting here keeps the
  // "% of essential spending covered by guaranteed income" metric meaningful.
  const essentials = essentialsGoalAmount(plan) + healthcareGoalAmount(plan);
  const goals = (Array.isArray(plan.goals) ? plan.goals : [])
    .filter(g => !g?.system)
    .reduce((s,g)=>s+(g.amount||0),0);
  const totalSpend = essentials + goals;
  const floorPct = essentials>0 ? guaranteed/essentials : 0;
  const fromPortfolioEssential = Math.max(0, essentials - guaranteed);
  const gap = Math.max(0, totalSpend - guaranteed);
  const wr = invest>0 ? gap/invest : 0;
  // Replacement ratio: GUARANTEED retirement income (SS + pension) as a share of
  // gross working income. Portfolio withdrawals are NOT income — they're spending
  // the portfolio funds — so they're deliberately excluded here. (A "sustainable
  // withdrawal amount" would need a solve, and would be framed as exactly that.)
  const workingIncome = plan.income.workingIncome || 0;
  const replacement = workingIncome>0 ? guaranteed/workingIncome : null;
  return { taxable, trad, roth, invest, guaranteed, essentials, goals, totalSpend,
           floorPct, fromPortfolioEssential, gap, wr, workingIncome, replacement };
}
function renderSnapshot(){
  const m = snapshotMetrics();
  const pct = v => (v*100);
  const pct1 = v => (v*100).toFixed(1)+'%';
  const pct0 = v => Math.round(v*100)+'%';

  // 1 · Income floor — floating stats (no bar: bar implied a grade, this is a fact).
  const incomeFloor = `
    <div class="metric">
      <div>
        <div class="m-eye">Income Floor</div>
        <div class="m-hero">${pct0(m.floorPct)}</div>
        <div class="m-sub">of essential spending is covered for life by guaranteed income</div>
      </div>
      <div class="stat-row">
        <div class="stat-item"><div class="stat-lbl">Guaranteed for life</div><div class="stat-val">${fmtMoney(m.guaranteed)}</div></div>
        <div class="stat-item"><div class="stat-lbl">Drawn from portfolio</div><div class="stat-val">${fmtMoney(m.fromPortfolioEssential)}</div></div>
        <div class="stat-item"><div class="stat-lbl">Essential spending</div><div class="stat-val">${fmtMoney(m.essentials)}</div></div>
      </div>
    </div>`;

  // 2 · Withdrawal rate — neutral metric, no grading. Shown for reference and
  // as a starting point for advisor conversation, not a verdict.
  const withdrawal = `
    <div class="metric">
      <div>
        <div class="m-eye">Withdrawal Rate · Year One</div>
        <div class="m-hero">${pct1(m.wr)}</div>
        <div class="m-sub">of the portfolio drawn the first year of retirement</div>
      </div>
      <div class="stat-row">
        <div class="stat-item"><div class="stat-lbl">Portfolio draws / yr</div><div class="stat-val">${fmtMoney(m.gap)}</div></div>
        <div class="stat-item"><div class="stat-lbl">From invested</div><div class="stat-val">${fmtMoney(m.invest)}</div></div>
        <div class="stat-item"><div class="stat-lbl">Total retirement spend</div><div class="stat-val">${fmtMoney(m.totalSpend)}</div></div>
      </div>
    </div>`;

  // 3 · Tax location — segmented proportion bar. Hero = the tax-deferred share
  // (the future-tax exposure). Labels hidden on slivers too thin to hold text.
  const tP = m.invest>0 ? m.taxable/m.invest : 0;
  const dP = m.invest>0 ? m.trad/m.invest : 0;
  const rP = m.invest>0 ? m.roth/m.invest : 0;
  const segLbl = (p) => pct(p)>=8 ? pct0(p) : '';
  const taxLocation = `
    <div class="metric">
      <div>
        <div class="m-eye">Tax Location</div>
        <div class="m-hero">${pct0(dP)}</div>
        <div class="m-sub">sits in tax-deferred accounts — taxed as income when withdrawn</div>
      </div>
      <div>
        <div class="seg">
          <div class="s-tax" style="width:${(tP*100).toFixed(1)}%">${segLbl(tP)}</div>
          <div class="s-def" style="width:${(dP*100).toFixed(1)}%">${segLbl(dP)}</div>
          <div class="s-roth" style="width:${(rP*100).toFixed(1)}%">${segLbl(rP)}</div>
        </div>
        <div class="seg-legend">
          <span class="k"><span class="sw" style="background:var(--accent)"></span>Taxable<b>${fmtMoney(m.taxable)}</b></span>
          <span class="k"><span class="sw" style="background:var(--accent-deep)"></span>Tax-deferred<b>${fmtMoney(m.trad)}</b></span>
          <span class="k"><span class="sw" style="background:var(--accent-secondary)"></span>Tax-free · Roth<b>${fmtMoney(m.roth)}</b></span>
        </div>
      </div>
    </div>`;

  // 4 · Replacement ratio — retirement income as a share of working income.
  // NEUTRAL by design: no safety zones, because a higher ratio isn't worse —
  // it's the upside (live as well or better than today). Reference ticks only:
  // a faint "typical ~75%" heuristic and a solid "100% = working income" line.
  // Scale runs 0–120% so over-100% (spending up in retirement) still shows.
  let replacement;
  if(m.replacement == null){
    replacement = `
      <div class="metric">
        <div>
          <div class="m-eye">Replacement Ratio</div>
          <div class="m-hero">—</div>
          <div class="m-sub">add working income on the Balance Sheet to compare retirement to life today</div>
        </div>
        <div></div>
      </div>`;
  } else {
    // Coverage bar — same language as the income floor. The full track = working
    // income; the filled portion = the share retirement income replaces. No vertical
    // ticks cutting through text. Caps at the track; over-100% (spending more in
    // retirement) shows full + the true % in the hero.
    const fillPct = Math.min(100, m.replacement*100);
    replacement = `
      <div class="metric">
        <div>
          <div class="m-eye">Replacement Ratio</div>
          <div class="m-hero">${pct0(m.replacement)}</div>
          <div class="m-sub">of working income, replaced by guaranteed retirement income</div>
        </div>
        <div>
          <div class="cov"><div class="fill" style="width:${fillPct.toFixed(1)}%">Guaranteed&nbsp;·&nbsp;${fmtMoney(m.guaranteed)}</div></div>
          <div class="cov-legend">
            <span class="k"><span class="sw" style="background:var(--accent)"></span>Guaranteed income<b>${fmtMoney(m.guaranteed)}</b></span>
            <span class="k"><span class="sw" style="background:#e3d9c5"></span>Working income<b>${fmtMoney(m.workingIncome)}</b></span>
          </div>
        </div>
      </div>`;
  }

  return `<div class="snap">${incomeFloor}${withdrawal}${taxLocation}${replacement}</div>`;
}

/* ── Sub-page render + wiring ─────────────────────────────────────
   One renderInputs() drives whichever sub-page is active. Re-renders on
   sub-nav click, on field change, and on row delete — same wiring pattern
   as before so live-commas / scenario re-seeding / plansDirty all still
   work without per-layout duplication. */
function renderInputs(){
  // sub-nav active state
  $$('#np-subnav .stab').forEach(b => b.classList.toggle('on', b.dataset.sub===activeSub));
  if(isHouseholdStorageBlocked()){
    renderBlockedRecoverySurfaces();
    return;
  }
  const layout = SUB_PAGES[activeSub].layout;
  const np = $('#np-content');
  // Snapshot is its own diagnostic page again — embedding it on the Net Worth
  // page made that page too busy to read.
  const html = layout==='snapshot'  ? `<div class="np-snapshot-page">${renderSnapshot()}</div>`
             : layout==='goals'     ? goalsHorizon.render()
             :                        renderHybrid(activeSub);
  np.innerHTML = html;
  if(layout==='goals') goalsHorizon.bind(np);
  syncRecoveryControls();
}
// ── Net Worth input bindings — delegated on the stable #np-content ────────────
// Input listeners are set once here so re-renders via renderInputs() (which
// replaces #np-content children) never accumulate orphaned listeners.

// ── All Net Worth interactions — delegated on the stable #np-content ─────────
$('#np-content').addEventListener('click', e => {
  // (The old Map / Net-Worth toggle was retired with the Household editor.)
  // Row delete (×)
  const rx = e.target.closest('.row-x');
  if(rx){
    if(!guardPlanMutation()) return;
    const path = rx.dataset.rmpath;
    const ks = path.split('.'); const last = ks.pop();
    let t = plan; for(const k of ks){ if(t==null) return; t=t[k]; }
    // Array rows splice (no holes); object keys delete.
    if(Array.isArray(t)) t.splice(+last, 1);
    else if(t!=null) delete t[last];
    if(path === 'income.other' || path.startsWith('income.other.')){
      invalidateWizardTaxCompletion(plan);
    }
    reseedScenarios(); 
  uiState.sharedPaths = null; uiState.plansDirty = true;
    renderInputs();
    syncPlanEditStatus('Saved automatically · open Scenarios');
    return;
  }
  // "+ add …" — push a default row onto the backing array, then re-render.
  const adder = e.target.closest('[data-add]');
  if(adder){
    if(!guardPlanMutation()) return;
    const kind = adder.dataset.add;
    const k = ROW_KINDS[kind];
    if(k){
      const arr = getPath(plan, k.arr);
      if(Array.isArray(arr)) arr.push(k.mk());
      else setPath(plan, k.arr, [k.mk()]);
      if(kind === 'income') invalidateWizardTaxCompletion(plan);
      commitPlanEdit();
    }
    return;
  }
  // Account type chip
  const chip = e.target.closest('.acct-chip');
  if(chip){
    const resolved = resolveTypeFromLabel(chip.dataset.label);
    if(!resolved.known || !resolved.typeId) return;
    acctSel = {
      label: resolved.label,
      bucket: resolved.engineBucket,
      typeId: resolved.typeId,
    };
    $$('#np-content .acct-chip').forEach(c => c.classList.toggle('sel', c === chip));
    const btn = $('#np-content .acct-add');
    if(btn){ btn.disabled = false; btn.textContent = 'Add ' + acctSel.label; }
    return;
  }
  if(e.target.closest('.acct-add')){
    if(!guardPlanMutation()) return;
    if(!acctSel) return;
    const amtEl = $('#np-content .acct-amt');
    const bal = parseFloat(String(amtEl ? amtEl.value : '').replace(/[^0-9.]/g, ''));
    if(!isFinite(bal) || bal <= 0){
      if(amtEl){ amtEl.focus(); amtEl.style.outline='2px solid var(--negative)'; setTimeout(()=>amtEl.style.outline='',1500); }
      return;
    }
    if(!plan.portfolio.extraAccounts) plan.portfolio.extraAccounts = [];
    plan.portfolio.extraAccounts.push(createAccount(acctSel.typeId, {
      owner: 'joint',
      balance: Math.round(bal),
    }));
    acctSel = null;
    commitPlanEdit();
    return;
  }
  const rm = e.target.closest('.acct-x');
  if(rm){
    if(!guardPlanMutation()) return;
    const i = +rm.dataset.acctidx;
    if(plan.portfolio.extraAccounts) plan.portfolio.extraAccounts.splice(i, 1);
    commitPlanEdit();
  }
});
// Live commas on money fields.
$('#np-content').addEventListener('input', e => {
  if(e.target.dataset.type === 'money' || e.target.dataset.type === 'monthlyMoney') liveCommas(e.target);
});
$('#np-content').addEventListener('change', e => {
  // Field edits (data-path bindings)
  const path = e.target.dataset.path, type = e.target.dataset.type;
  if(path){
    if(!guardPlanMutation()){ renderInputs(); return; }
    const raw = e.target.value;
    if(type==='text' || type==='strategy'){            // free-text row labels or select values
      setPath(plan, path, raw);
      if(path.startsWith('income.other.')
          || path.startsWith('income.socialSecurity.')){
        invalidateWizardTaxCompletion(plan);
      }
  reseedScenarios(); uiState.sharedPaths=null; uiState.plansDirty=true; renderInputs();
      syncPlanEditStatus('Saved automatically · open Scenarios');
      return;
    }
    let v;
    if(type==='money' || type==='monthlyMoney') v = parseFloat(String(raw).replace(/[^0-9.]/g,''));
    else if(type==='risk')  v = +raw;
    else                    v = parseFloat(raw);
    // Blanking a goal amount returns the goal to unpriced ($0 is engine-inert).
    if(!isFinite(v)){
      if(type==='money' && String(raw).trim()==='' && /^goals\.\d+\.amount$/.test(path)) v=0;
      else return;
    }
    if(type==='pct')   v = Math.max(0, Math.min(100, v))/100;
    if(type==='gpct')  v = Math.max(-20, Math.min(20, v))/100;   // signed growth %/yr
    if(type==='money'){ v = Math.max(0, Math.round(v)); e.target.value = v.toLocaleString('en-US'); }
    if(type==='monthlyMoney'){
      const monthly = Math.max(0, Math.round(v));
      v = monthly * 12;
      e.target.value = monthly.toLocaleString('en-US');
    }
    if(type==='num') v = Math.max(1, Math.round(v));
    setPath(plan, path, v);
    if(path.startsWith('income.other.')
        || path.startsWith('income.socialSecurity.')){
      invalidateWizardTaxCompletion(plan);
    }
    // A one-time goal edits a single "at age": mirror it into endAge so the
    // engine's window is exactly that year.
    if(e.target.dataset.sync) setPath(plan, e.target.dataset.sync, v);
    reseedScenarios();
    
    uiState.sharedPaths = null;
    uiState.plansDirty = true;
    renderInputs();
    syncPlanEditStatus('Saved automatically · open Scenarios');
    return;
  }
  // Extra-account balance edit
  const bal = e.target.closest('.acct-bal');
  if(!bal) return;
  if(!guardPlanMutation()){ renderInputs(); return; }
  const i = +bal.dataset.acctidx;
  const v = Math.max(0, Math.round(parseFloat(String(bal.value).replace(/[^0-9.]/g, '')) || 0));
  if(plan.portfolio.extraAccounts && plan.portfolio.extraAccounts[i]){
    plan.portfolio.extraAccounts[i].balance = v;
    commitPlanEdit();
  }
});

/* Household field commits and wizard actions are bound in src/household/commit.js. */
bindHouseholdEditor({
  root: document.querySelector('[data-hh-wizard-root]'),
  wizardRoot: document.querySelector('[data-hh-wizard-root]'),
  transientState: hhUiState,
  guardPlanMutation,
  commitWizardEdit: command => householdWizardCommitBoundary.commit(command),
  preflightWizardEdit: command => householdWizardCommitBoundary.preflight(command),
  syncHousehold,
  navigateWizard: direction => householdWizardController.navigate(direction),
  syncHeaderStatus,
  liveCommas,
});

// Pension slider range is PER-HOUSEHOLD: it spans only the ages the advisor has
// actually quoted a benefit for (the keys of benefitByAge). This means the
// slider can never wander onto an age with no number — so it can't silently pay
// $0. Enter a new quote (e.g. age 67) and the slider grows to include it on the
// next render. Falls back to a sane window if nothing is entered yet.
function pensionAges(){
  const m=(plan.income.pension && plan.income.pension.benefitByAge) || {};
  return Object.keys(m).map(Number).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
}
// Effective slider range for a lever. Pension is dynamic; everything else is
// the static min/max declared in LEVCFG.
function levRange(cfg){
  if(cfg.key==='pensionAge'){
    const a=pensionAges();
    if(a.length) return { min:a[0], max:a[a.length-1], step:1 };
    return { min:62, max:65, step:1 };
  }
  // Sale lever: min = currentAge−1 (the "Keep" / off state), max = plan end.
  if(cfg.key==='sellAge'){
    const c=plan.household.primary.currentAge, e=resolveGoalSpan(plan).planEndAge;
    return { min:c-1, max:e, step:1 };
  }
  return { min:cfg.min, max:cfg.max, step:cfg.step };
}

/* ── lever display config (label, formatter, slider range→value & back) ── */
const LEVCFG=[
  {key:'retireAge', name:'Retirement Age', min:55,max:72,step:1, fmt:v=>[v,'']},
  {key:'ssAge',     name:'SS Start Age',   min:62,max:70,step:1, fmt:v=>[v,'']},
  // All dollar levers render full digits with comma grouping — no abbreviations.
  // The advisor wants to see the exact number they're proposing, not a rounded
  // shorthand. Step values stay round so the slider snaps cleanly.
  // Spending is stored ANNUAL (the engine's unit) but shown/edited MONTHLY —
  // clients know their monthly number off-hand. edit:'monthly' wires the box.
  {key:'spend',     name:'Essentials',min:80000,max:360000,step:1200, edit:'monthly', fmt:v=>['$'+Math.round(v/12).toLocaleString('en-US'),'/mo']},
  // One-time event carries BOTH an amount and an age; edit:'event' renders the
  // two type-in boxes (amount + age) alongside the amount slider.
  {key:'eventAmt',  name:'One-Time Event', min:0,max:500000,step:5000, edit:'event', fmt:(v,L)=>['$'+(v||0).toLocaleString('en-US'),'@ '+L.eventAge]},
  {key:'risk',      name:'Allocation',     min:1,max:5,step:1, fmt:v=>[RISK_LABELS[v],'']},
  {key:'savings',   name:'Savings / yr',   min:0,max:200000,step:1000, edit:'money', fmt:v=>['$'+v.toLocaleString('en-US'),'/yr']},
  // Pension snaps between the ages that actually have entered amounts (62, 65).
  // Label shows the dollar value the engine will pay for that age — if no entry
  // exists for that age, it shows "—" (and the engine pays 0).
  // Pension claim age. Range spans the realistic window; the displayed dollar
  // amount comes from whatever the advisor has entered for that exact age.
  // No entry yet → the value spot becomes an inline input (handled in
  // the Scenarios view layer, not here). This is the truth-source contract surfacing
  // naturally as a UI affordance: "we don't have a number for this age, give
  // us one." Not an error — just the next input.
  {key:'pensionAge', name:'Pension',       min:55,max:70,step:1, fmt:v=>{
    const m=(plan.income.pension && plan.income.pension.benefitByAge) || {};
    const amt=m[v]; return (amt && amt>0) ? ['$'+amt.toLocaleString('en-US'),'@ '+v] : ['__needs__', v];
  }},
];
// Earmarked-asset sale lever — only shown when there's a property to sell. A
// discrete stepper: "Keep" (off) → a sale age. Net proceeds (value − mortgage −
// commission − cap-gains) flow into the portfolio via the assetSale override, so
// you can stand a "sell at 72" column next to a "keep" Baseline. (See engine.js.)
if(plan.properties && plan.properties.length && plan.properties[0]){
  LEVCFG.push({
    key:'sellAge', name:'Sell '+(plan.properties[0].name||'asset'),
    min:0, max:120, step:1,                              // real range is dynamic (levRange)
    fmt:v => (v <= plan.household.primary.currentAge-1) ? ['Keep',''] : ['age '+v,'']
  });
}

let running=false;
// Cached market bundle. Generated once, reused across Runs so that hitting Run
// twice with no changes yields the EXACT same numbers (sampling noise was
// causing the % to drift between identical clicks). Invalidated to null
// whenever the plan changes in the Inputs tab.

/* ── run the engine for all three columns (shared nothing; each its own MC) ── */
// ONE seeded bundle of return paths, shared by every surface that compares
// runs (scenario columns, the goals page's per-goal cost runs). Identical
// markets across runs make any difference a pure decision-effect, and the
// fixed seed keeps an unchanged plan at an identical % between Runs.
function ensureSharedPaths(resolvedInputs=null){
  if(!canRunEngine()) return null;
  const horizon = (resolvedInputs || resolveInputs(plan, {})).horizonYears;
  if(!(horizon > 0)) return null;
  const iters = plan.simulation.iterations;
  if(!sharedPaths || sharedPaths.length !== iters || sharedPaths[0].length !== horizon){
    resetSeed(pathReplay.seed);
    uiState.sharedPaths = [];
    for(let i=0;i<iters;i++) uiState.appendSharedPath(generateReturnPath(horizon));
  }
  return sharedPaths;
}
/* ── Historical Stress (Focus rail) ───────────────────────────────────────
   Five canonical sequence-of-returns eras (design handoff → Focus → Historical
   Stress). Each scenario is sequenced through an era the SAME way the
   Sequencing tab does it: stand the household at its retirement age with the
   median projected balance (retireNowClone), then replay the real historical
   series from that start year (the engine WRAPS past 2025 so recent eras still
   get a full retirement horizon). `y` is the real start year fed to the engine;
   `year` is the display label — the late-70s high-inflation shock is shown as
   the decade "1970s" but sequenced from a concrete 1977 start. */
const STRESS_ERAS = [
  { y: 1966, year: '1966',  name: 'Stagflation' },
  { y: 1973, year: '1973',  name: 'Oil shock' },
  { y: 2000, year: '2000',  name: 'Dot-com' },
  { y: 2008, year: '2008',  name: 'Global Financial Crisis' },
  { y: 1977, year: '1970s', name: 'High inflation' },
];
const HISTORICAL_WITHDRAWAL_STRATEGIES = new Set([
  'taxable-first',
  'proportional',
  'traditional-first',
]);
const normalizeHistoricalStrategy = strategy =>
  HISTORICAL_WITHDRAWAL_STRATEGIES.has(strategy) ? strategy : 'taxable-first';
// Pass vs Marginal for ONE historical sequence — fully engine-derived (Engine
// Truth: the card never invents an outcome). Pass = the plan funded the entire
// horizon (never depleted) AND cleared the sequence-risk window with non-negative
// real growth across the first retirement decade, where sequence risk lives.
// A depletion or a negative first decade reads as Marginal; the design has no
// "Fail" tier, so Marginal is the most severe state the card shows.
function eraPasses(h){
  if(!h || h.failed) return false;
  if(h.first10Supports === false) return false;
  return true;
}
// Sequence one scenario (plan clone + overrides) through every era. Reuses the
// scenario's freshly-computed envelope so the retirement entry balance matches
// the Scenarios / Sequencing tabs exactly (one shared-path truth, not a re-roll).
function computeHistoricalStress(s, p, ov){
  const curAge     = plan.household.primary.currentAge;
  const retAge     = resolveInputs(p, ov).retirementAge;
  const accumYears = Math.max(0, retAge - curAge);
  const rp    = retireNowClone(p, ov, curAge, retAge, accumYears, s.res);
  // Guard: ensure rp has a valid risk profile so resolveInputs doesn't throw on
  // RISK_PROFILES[undefined].eq. A stale localStorage save can carry an invalid
  // risk lever; fall back to the base plan's profile (or Moderate = 3).
  if (!RISK_PROFILES[rp.portfolio.riskProfile]) {
    rp.portfolio.riskProfile = (p.portfolio.riskProfile in RISK_PROFILES)
      ? p.portfolio.riskProfile : 3;
  }
  const strat = normalizeHistoricalStrategy(p.portfolio.withdrawalStrategy);
  const ov2   = { ...ov, retireDelay: 0 };   // retirement age is baked into the clone
  // Wrap each era individually: a single failing era must not blank the whole card.
  // null entries are filtered out; if any eras succeed the card renders those rows.
  const results = STRESS_ERAS.map(e => {
    try {
      const h = runHistoricalPathWithFederalTax(
        rp,
        e.y,
        strat,
        undefined,
        ov2,
        {
          baseTaxYear: Number.isInteger(rp.meta?.planningAsOfYear)
            ? rp.meta.planningAsOfYear
            : new Date().getFullYear(),
          filingStatus: rp.meta?.filingStatus,
          scenarioId: `historical_stress_${s.name}_${e.y}`,
          current1040Intake: buildCurrent1040Intake(rp).intake,
        }
      );
      return { year: e.year, name: e.name, pass: eraPasses(h) };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  return results;
}
// Plain-language reasons for the structured issue codes the engine reports.
// The engine knows exactly why it could not finish; flattening that to one
// generic sentence is what made this class of failure undiagnosable.
const PROJECTION_ISSUE_MESSAGES = {
  TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE:
    'Pre-tax money is not assigned to a person — open Net Worth and set the owner on each retirement account',
  TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE:
    'A retirement account outlives its owner and cannot roll to the surviving spouse — check account ownership and plan-end ages',
  TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE:
    'A retirement account type has no supported RMD rule yet',
  EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE:
    'An employer plan needs a retirement date before its RMD can be calculated',
  EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE:
    'Multiple employer plans for one person cannot be aggregated for RMDs — see Net Worth',
  RMD_BIRTH_COHORT_UNAVAILABLE:
    'A birth date is missing, so the RMD starting age cannot be determined — check Family',
  RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE:
    'A prior year-end balance is missing for an RMD calculation',
};

function scenarioProjectionIssueMessage(result){
  const base = PROJECTION_ISSUE_MESSAGES[result?.issue]
    || 'calculation inputs need review';
  return result?.issueAge != null ? `${base} (from age ${result.issueAge})` : base;
}

function scenarioRunFailureMessage(error){
  if(error?.code === 'TAX_POLICY_FUNDING_DID_NOT_CONVERGE'){
    return 'federal tax funding did not settle';
  }
  if(/filing status|filingStatus/i.test(error?.message || '')){
    return 'Household filing status needs review';
  }
  // A typed engine issue still carries its reason even when it arrives as a throw.
  if(error?.rmdIssue || error?.code){
    const mapped = PROJECTION_ISSUE_MESSAGES[error.rmdIssue || error.code];
    if(mapped) return mapped;
  }
  return 'calculation inputs need review';
}
function runAll(){
  if(!canRunEngine()) return;
  if(running) return; running=true;
  const btn=$('#run-btn'); btn.disabled=true; syncHeaderStatus('Running…');
  setTimeout(()=>{
    try{
      // SHARED PATHS: one bundle of return paths, reused across scenarios AND
      // across Runs. Within a Run, every column sees the SAME markets (any
      // difference between columns is the DECISION). Across Runs, the bundle
      // is cached so identical inputs give an identical % — no noise drift.
      const preflight = resolveInputs(plan, {});
      if(preflight.simulationAvailable === false){
        scenarios.forEach(s=>{ s.res=null; s.runError=null; });
        renderSolvePanel(); buildSeqSelect();
        if(window.ScenariosUI) window.ScenariosUI.sync();
        syncHeaderStatus('Plan updated · using available inputs');
        uiState.plansDirty = false;
        btn.disabled=false; running=false; return;
      }
      const horizon = preflight.horizonYears;
      const iters = plan.simulation.iterations;
      // Degenerate plan guard: a non-positive horizon (plan-end age at/below
      // current age) can't be simulated. Surface a clear reason and bail
      // WITHOUT nuking the last good results, so the views don't go blank.
      if(!(horizon > 0)){
        syncHeaderStatus('Check plan: end age must be after current age');
        btn.disabled=false; running=false; return;
      }
      ensureSharedPaths(preflight);
      // Isolate each scenario: one bad column (e.g. an out-of-range saved lever)
      // must not abort the whole Run and blank every other column + the cash
      // flow drawer. Failed scenarios get res=null and are skipped downstream.
      let failed=0;
      const baseTaxYear = Number.isInteger(plan.meta?.planningAsOfYear)
        ? plan.meta.planningAsOfYear
        : new Date().getFullYear();
      scenarios.forEach(s=>{
        try{
          const p=planForScenario(s.lev);
          const ov=leversToOverrides(s.lev);
          const taxOptions = {
            baseTaxYear,
            scenarioId: s.name,
            filingStatus: p.meta?.filingStatus,
            current1040Intake: buildReadyCurrent1040Intake(p),
          };
          // One converged federal run now supplies probability, paths, taxes,
          // withdrawals, and balances together. A failed convergence is a
          // failed scenario; never fall back to a hybrid shortcut display.
          const result = runFederalFundingSimulation(
            p,
            ov,
            sharedPaths,
            taxOptions
          );
          // The engine now fails CLOSED instead of throwing, so the catch below
          // no longer fires for these. Without this branch s.runError would stay
          // null and the column would silently show a bare dash again.
          if(result.projectionStatus === 'unavailable'){
            s.res = result;                 // keep diagnostic rows
            s.runError = scenarioProjectionIssueMessage(result);
            failed++;
            console.error('Scenario unavailable:', s.name, result.issue, 'age', result.issueAge);
            return;
          }
          s.res = result;
          s.runError = null;
          // Historical Stress (Focus rail): engine-derived per-scenario eras.
          // Isolated so a stress hiccup never blanks the scenario's main result.
          try{ s.res.stress = computeHistoricalStress(s, p, ov); }
          catch(stressErr){ s.res.stress = []; console.warn('Historical stress failed:', s.name, stressErr); }
        }catch(err){
          s.res=null;
          s.runError=scenarioRunFailureMessage(err);
          failed++;
          console.error('Scenario failed:', s.name, err);
        }
      });
      renderSolvePanel(); buildSeqSelect();
      if($('.page.on')?.dataset.page === 'sequencing') runSeq();
      if(window.ScenariosUI) window.ScenariosUI.sync();   // one authoritative Scenarios renderer
      const firstFailure = scenarios.find(s => s.runError)?.runError;
      syncHeaderStatus(failed
        ? `Partial run · ${failed} scenario${failed>1?'s':''} could not run${firstFailure ? `: ${firstFailure}` : ''}`
        : 'Plan updated · using available inputs');
      uiState.plansDirty = false;
    }catch(e){ syncHeaderStatus('Error'); console.error(e); }
    btn.disabled=false; running=false;
  },20);
}

// ScenariosUI toolbar to the existing addScenario() and solver (renderSolvePanel)
// seams. Per-scenario rename/remove returns via the new view's menu in a later pass.
// removeScenario() / resetScenarios() remain available for that wiring.
// Solver goal form lives in #solve-panel (full-width). Live commas on $ boxes;
// changing the pin dropdown re-renders its value input (age box vs $ box).
$('#solve-panel').addEventListener('input', e=>{
  if(e.target.classList?.contains('sf-money')) liveCommas(e.target);
});
$('#solve-panel').addEventListener('change', e=>{
  if(e.target.id === 'sf-goal'){
    const baseLev = scenarios.find(s=>s.base)?.lev || defaultLevers();
    const baseSucc = scenarios.find(s=>s.base)?.res?.successRate ?? 85;
    const defPct = Math.min(95, Math.ceil((baseSucc+1)/5)*5);
    const wrap = $('#sf-params');
    if(wrap) wrap.innerHTML = goalParamsHtml(e.target.value, baseLev, defPct, { goals:GOALS, currentAge:plan.household.primary.currentAge, planEndAge:resolveGoalSpan(plan).planEndAge });
  }
});
$('#solve-panel').addEventListener('submit', e=>{
  const f = e.target.closest('#solver-form');
  if(!f) return;
  e.preventDefault();
  if(!guardPlanMutation()) return;
  const pct = parseFloat($('#sf-pct')?.value);
  if(!isFinite(pct) || pct<50 || pct>99) return;
  const goalType = $('#sf-goal')?.value || 'confidence';
  const num = id => parseInt(($(id)?.value||'').replace(/[^0-9]/g,''), 10);
  const params = { pct };
  const {currentAge, planEndAge} = resolveGoalSpan(plan);
  const flashAge = id => { const el=$(id); if(el){ el.style.outline='2px solid var(--negative)'; el.focus(); setTimeout(()=>el.style.outline='',1500); } };
  if(goalType==='retire'){
    params.age = num('#sf-p-age');
    if(!isFinite(params.age)) return;
    if(params.age <= currentAge || params.age > planEndAge){ flashAge('#sf-p-age'); return; }
  } else if(goalType==='purchase'){
    params.amount = num('#sf-p-amount'); params.age = num('#sf-p-age');
    if(!isFinite(params.amount)||!isFinite(params.age)) return;
    if(params.age <= currentAge || params.age > planEndAge){ flashAge('#sf-p-age'); return; }
  } else if(goalType==='gift'){
    params.amount = num('#sf-p-amount'); params.toAge = num('#sf-p-toage');
    if(!isFinite(params.amount)||!isFinite(params.toAge)) return;
    if(params.toAge <= currentAge || params.toAge > planEndAge){ flashAge('#sf-p-toage'); return; }
  } else if(goalType==='legacy'){
    params.amount = num('#sf-p-amount'); if(!isFinite(params.amount)) return;
  }
  runSolve(goalType, params);
});
// Solver panel: Cancel (form), Clear (results), and per-lever "Load" actions.
document.addEventListener('click', e=>{
  if(e.target.closest('#sf-cancel')){
    uiState.solverFormOpen = false; renderSolvePanel(); return;
  }
  if(e.target.closest('#solve-clear-btn')){
    uiState.solverResults = null; uiState.solverSearching = false;
    uiState.comboResults = null; uiState.comboOpen = false; uiState.comboSearching = false;
    renderSolvePanel(); return;
  }
  // Fold-down: open runs the (heavy) combo search once and caches it; toggle off
  // just collapses. The cache is reused on re-open until the solo solve changes.
  if(e.target.closest('#combo-toggle')){
    uiState.comboOpen = !comboOpen;
    if(comboOpen && !comboResults && !comboSearching) runComboSolve();  // renders itself
    else renderSolvePanel();
    return;
  }
  const loadBtn = e.target.closest('.solve-load');
  if(loadBtn && solverResults && solverResults.rows){
    if(!guardPlanMutation()) return;
    if(scenarios.length >= MAX_SCENARIOS) return;
    const idx = +loadBtn.dataset.soloIdx;
    const row = solverResults.rows[idx];
    if(!row) return;
    // Scenario = the pinned soloBase with this one lever set to its solo answer.
    const lev = JSON.parse(JSON.stringify(solverResults.soloBase));
    lev[row.key] = row.value;
    syncPension(lev);
    const cfg = LEVCFG.find(c=>c.key===row.key);
    uiState.addScenario({ name: `${cfg.name} solve`, base:false, lev, res:null });
    uiState.solverResults = null; uiState.solverSearching = false;
    uiState.comboResults = null; uiState.comboOpen = false;
    saveScenarios(); renderSolvePanel(); uiState.plansDirty=true; runAll();
  }
  // Load a COMBO: the held-fixed soloBase with both lever moves applied.
  const cLoadBtn = e.target.closest('.cc-load');
  if(cLoadBtn && comboResults && comboResults.combos){
    if(!guardPlanMutation()) return;
    if(scenarios.length >= MAX_SCENARIOS) return;
    const c = comboResults.combos[+cLoadBtn.dataset.comboIdx];
    if(!c) return;
    const lev = JSON.parse(JSON.stringify(comboResults.soloBase));
    c.items.forEach(m => lev[m.key] = m.val);
    syncPension(lev);
    const nm = comboResults.goalType==='retire' ? `Retire ${comboResults.params.age}`
             : c.items.map(m=>COMBO_SHORT[m.key]).join(' + ');
    uiState.addScenario({ name: nm.slice(0,28), base:false, lev, res:null });
    uiState.solverResults = null; uiState.solverSearching = false;
    uiState.comboResults = null; uiState.comboOpen = false;
    saveScenarios(); renderSolvePanel(); uiState.plansDirty=true; runAll();
  }
});
const GRID='var(--grid)', AXIS_INK='var(--axis)';
function simByIndex(res, idx){
  if(!res || !Array.isArray(res.sims)) return null;
  return res.sims.find(s => s.simIndex === idx) || res.sims[idx] || null;
}
function baselineResult(){
  return (scenarios.find(s=>s.base) || scenarios[0] || {}).res || null;
}




/* ── Path Story ───────────────────────────────────────────────────────────
   The baseline run's selected coherent path, told as a statement. The same
   selected sim the cash-flow drawer replays (selectedPathIndex), digested by
   the engine (pathDigest) — the prose here and the table below are two views
   of one path. Pure formatting of engine fields; no UI math. */
function renderStory(){
  const el = $('#story-panel'); if(!el) return;
  const res = baselineResult();
  if(!res || !Array.isArray(res.sims) || !res.sims.length){ el.innerHTML=''; return; }
  const sim = simByIndex(res, selectedPathIndex(res));
  if(!sim){ el.innerHTML=''; return; }
  const d = pathDigest(sim);
  const pc = v => (v>=0?'+':'−') + Math.abs(v*100).toFixed(1) + '%';
  const endAge = sim.rows.length ? sim.rows[sim.rows.length-1].age : '';
  const endStat = d.failed
    ? `<b>${fmtM(0)}</b><i>depleted at age ${d.depletionAge}</i>`
    : `<b>${fmtM(d.endBalance)}</b><i>ends at age ${endAge}</i>`;
  const picks = [['stressed','Stressed'],['typical','Median'],['favorable','Favorable']]
    .map(([m,l]) => `<button class="${pathReplay.mode===m?'on':''}" data-story-mode="${m}">${l}</button>`).join('');
  const verb = d.first10Supports ? 'cooperate' : 'push back';
  const reads = [
    [pc(d.first10Cagr), 'Market sequence',
     `The first 10 years ${d.first10Supports?'support':'work against'} the plan. ${d.negEarlyYears} of the first ${d.earlyWindowYears} ${d.negEarlyYears===1?'year is':'years are'} negative.`],
    [d.avgWdRate.toFixed(1)+'%', 'Spending pressure',
     `Average withdrawal pressure is ${d.avgWdRate.toFixed(1)}% across ${d.withdrawalYears} withdrawal years${d.peakWdAge!=null?` — the peak year touches ${d.peakWdRate.toFixed(1)}% at age ${d.peakWdAge}`:''}.`],
    [fmtM(d.avgTax)+'/yr', 'Federal tax',
     `${fmtM(d.lifetimeTax)} of modeled federal tax is funded across this path and carried through its withdrawals and balances.`]
  ].map(([b,h,t]) => `<div class="story-read"><b>${b}</b><div><span class="rd-h">${h}</span><span class="rd-b">${t}</span></div></div>`).join('');
  el.innerHTML = `
    <div class="story-sec"><span>Path Story · ${escHtml((scenarios.find(s=>s.base)||scenarios[0]||{}).name||'Base plan')}</span></div>
    <div class="story-pick"><span class="pk-l">Path:</span>${picks}
      <span class="pk-note">selected from ${res.sims.length.toLocaleString('en-US')} simulated paths · not a forecast</span></div>
    <div class="story-head">${(d.realCagr*100).toFixed(1)}% real growth, year over year, along this path.</div>
    <div class="story-sub">Return timing matters most while withdrawals are active — and these first ten years ${verb}.</div>
    <div class="story-stats">
      <div class="story-stat"><b>${fmtM(d.startBalance)}</b><i>starts the plan</i></div>
      <div class="story-stat">${endStat}</div>
      <div class="story-stat"><b>${pc(d.first10Cagr)}</b><i>first decade, real</i></div>
      <div class="story-stat"><b>${d.avgWdRate.toFixed(1)}%</b><i>avg withdrawal · peak ${d.peakWdRate.toFixed(1)}%</i></div>
      <div class="story-stat"><b>${fmtM(d.avgTax)}</b><i>tax per year, avg</i></div>
    </div>
    <hr class="story-rule">
    <div class="story-chart-l">Balance path · ${pathModeLabel().toUpperCase()} · ages ${sim.rows.length?sim.rows[0].age:''}–${endAge}</div>
    <div class="story-chart">${storyChart(sim.rows,{ layout: CHART_LAYOUT.storyPath, fmtM })}</div>
    <div class="story-sec"><span>What shapes this outcome</span></div>
    ${reads}`;
  el.querySelectorAll('[data-story-mode]').forEach(b => b.onclick = () => {
    pathReplay.mode = b.dataset.storyMode;
    savePathReplay(); syncPathControls(); if(window.ScenariosUI) window.ScenariosUI.sync(); renderStory();
  });
}

// REMOVED the original multi-scenario renderCashflow grid (superseded below by
// the cf-mode override, and now by the single ScenariosUI Cash Flow renderer).

/* ── SEQUENCING tab — same returns, different ORDER ──────────────────────────
   The tab's single job: isolate the ORDER of returns. We take one REAL
   historical return stream and run the SAME plan through it forward vs exactly
   reversed (identical returns, opposite sequence). Any difference is pure
   sequence-of-returns risk. Every number on this tab is a direct read of the
   engine's single-path result; the UI computes no balances or metrics. */
// The Sequencing tab holds ONE plan fixed and runs it through several REAL
// retirement markets — never a reversed/counterfactual timeline. The lesson is
// the truth a client actually faces: retire into a brutal market vs a kind one,
// same plan, and watch the spread. A LIBRARY of real markets the advisor can
// toggle on/off as lines (`on` = shown by default). Euphoric bulls (1982/85) are
// deliberately omitted — a 10-20x winner crushes the scale and hides the
// downside, which is the whole point of a sequence-risk view.
// Distinct but DEEP, desaturated editorial tones — each line identifiable, none
// candy-bright. Picked to be maximally distinct from each other on the ground.
const SEQ_YEARS=[
  {y:1929, tag:'Great Depression',  c:'#c6a662', on:false},
  {y:1966, tag:'the lost decade',   c:'#8b94a8', on:true },
  {y:1973, tag:'stagflation',       c:'#cd9a52', on:true },
  {y:1987, tag:'Black Monday',      c:'#b08f4e', on:false},
  {y:1995, tag:'the 90s boom',      c:'#8fa57e', on:true },
  {y:2000, tag:'dot-com crash',     c:'#c0795f', on:true },
  {y:2008, tag:'financial crisis',  c:'#9a8fb0', on:false},
  {y:2009, tag:'the recovery bull', c:'#d8c084', on:false},
];

// REMOVED the cf-mode renderCashflow override — the renderer that showed the
// engine-vs-federal diagnostic tax columns. The single authoritative Cash Flow
// renderer now lives in the ScenariosUI view layer (one renderCashflow), with the
// advisor-facing Tax column mapping the federal sidecar (typical path) or the
// engine row tax — no diagnostic comparison columns.

function buildSeqSelect(){
  if(!canRunEngine()){ renderBlockedRecoverySurfaces(); return; }
  const sel=$('#seq-select'), cur=sel.value;
  sel.innerHTML=scenarios.map(s=>`<option>${escHtml(s.name)}</option>`).join('');
  if(cur && scenarios.some(s=>s.name===cur)) sel.value=cur;
  sel.onchange=runSeq;
  buildSeqChips();
}
// Market chips double as the selector AND the legend: lit = shown as a line.
function buildSeqChips(){
  const box=$('#seq-chips'); if(!box) return;
  box.innerHTML=SEQ_YEARS.map((m,i)=>
    `<button class="seq-chip${m.on?' on':''}" data-i="${i}"><span class="cdot" style="background:${m.c}"></span>${m.y} · ${m.tag}</button>`).join('');
  box.querySelectorAll('.seq-chip').forEach(btn=>btn.onclick=()=>{
    if(!canRunEngine()){ renderBlockedRecoverySurfaces(); return; }
    const m=SEQ_YEARS[+btn.dataset.i];
    if(m.on && SEQ_YEARS.filter(x=>x.on).length<=1) return;   // keep at least one line
    m.on=!m.on; buildSeqChips(); runSeq();
  });
}
// Build a "retire-now" clone from the funded p50 path's projected bucket mix
// and taxable basis, scaled to the engine envelope's median entry balance.
// Every real market then runs from this one shared, tax-coherent starting point.
function retireNowClone(p, ov, curAge, retAge, accumYears, analysis){
  // Reuse the chosen scenario's computed result so Sequencing never re-rolls
  // its market entry state. Fall back only before that scenario has run.
  const result = analysis || runSimulation(p, ov, sharedPaths);
  const resolvedAccounts = resolveInputs(p, ov).accounts;
  const entryAccounts = deriveRetirementEntryAccounts(
    result,
    accumYears,
    resolvedAccounts
  );
  return buildRetirementEntryPlan(p, {
    entryAccounts,
    currentAge: curAge,
    retirementAge: retAge,
  });
}
function runSeq(){
  if(!canRunEngine()){ renderBlockedRecoverySurfaces(); return; }
  const sel=$('#seq-select'); const s=scenarios.find(x=>x.name===sel.value)||scenarios[0];
  if(!s) return;
  // Sequence the chosen scenario FAITHFULLY: allocation via the plan clone, every
  // other lever via the same overrides mapping the Scenarios tab uses.
  const p=planForScenario(s.lev);
  const ov=leversToOverrides(s.lev);
  const strat=normalizeHistoricalStrategy(p.portfolio.withdrawalStrategy);
  const curAge=plan.household.primary.currentAge;
  const retAge=resolveInputs(p, ov).retirementAge;
  const accumYears=Math.max(0, retAge-curAge);
  const rp=retireNowClone(p, ov, curAge, retAge, accumYears, s.res);
  const ov2={...ov, retireDelay:0};                // retirement age is baked into the clone now
  const historicalTaxOptions={
    baseTaxYear:rp.meta?.planningAsOfYear ?? new Date().getFullYear(),
    filingStatus:rp.meta?.filingStatus,
    scenarioId:`sequencing_${s.name}`,
  };
  const runs=SEQ_YEARS.filter(m=>m.on)
                      .map(m=>({m, res:runHistoricalPathWithFederalTax(rp, m.y, strat, undefined, ov2, historicalTaxOptions)}))
                      .filter(r=>r.res && r.res.rows.length);
  if(!runs.length){ $('#seq-svg').innerHTML=''; $('#seq-prints').innerHTML=''; return; }
  drawSeqChart($('#seq-svg'), runs, retAge, seqChartSvg, { grid:GRID, axisInk:AXIS_INK });
  renderPrints($('#seq-prints'), runs, pathDigest);
  $('#seq-sub').textContent='Same plan, real markets';
}

// Path fingerprint — facts read straight off the engine result. One card per real
// market: the first-decade return (the sequence-risk cause), the lowest the
// portfolio fell, and the outcome. No invented composite "score".


/* ── tab switch + boot ── */
$$('.htab').forEach(t=>t.onclick=()=>{
  syncHeaderTabs(t);
  $$('.page').forEach(x=>x.classList.remove('on'));
  if(t.dataset.subTarget){
    activeSub = t.dataset.subTarget;
    if(!isHouseholdStorageReadOnly() && !isHouseholdStorageBlocked()){
      try { localStorage.setItem(SUB_KEY, activeSub); } catch {}
    }
  }
  $(`.page[data-page="${t.dataset.page}"]`).classList.add('on');
  document.body.classList.toggle('scn-active', t.dataset.page==='scenarios');
  // Returning to Scenarios after a base-plan edit re-runs the engine so the
  // columns reflect the new source; otherwise just redraw.
  if(t.dataset.page==='scenarios'){ if(plansDirty && canRunEngine()){ uiState.plansDirty=false; runAll(); } }
  if(t.dataset.page==='sequencing' && canRunEngine()) runSeq();
  if(t.dataset.page==='net-worth') renderInputs();
  if(t.dataset.page==='household') syncHousehold();
  if(t.dataset.page==='tax-buckets') taxBuckets.sync();
  if(isHouseholdStorageBlocked()) renderBlockedRecoverySurfaces();
});
// Net Worth sub-nav: switch the active sub-page, persist, re-render.
$$('#np-subnav .stab').forEach(b => b.onclick = () => {
  activeSub = b.dataset.sub;
  if(!isHouseholdStorageReadOnly() && !isHouseholdStorageBlocked()){
    try { localStorage.setItem(SUB_KEY, activeSub); } catch {}
  }
  renderInputs();
});
$('#run-btn').onclick=() => { if(canRunEngine()) runAll(); else renderBlockedRecoverySurfaces(); };

$('#path-mode').onchange=e=>{
  if(isHouseholdStorageBlocked()){
    syncPathControls();
    renderBlockedRecoverySurfaces();
    return;
  }
  if(isHouseholdStorageReadOnly()) pathReplay.mode=e.target.value;
  else updatePathReplayMode(e.target.value);
  syncPathControls();
  if(window.ScenariosUI) window.ScenariosUI.sync();
};
// Cash Flow is now an explicit view inside the ScenariosUI view layer (the
// Compare/Focus/Cash-Flow renderer at the end of this script). The old
// cf-mode sidebar (cfMode / cfPrimary / cfCompare / renderCfSidebar / setCfMode
// + #cf-mode-btn) was removed with its markup; the toolbar's Cash Flow chip and
// the per-view scenario selector replace it.

/* ===========================================================================
   ScenariosUI — the single Scenarios view layer (Compare / Focus / Cash Flow).
   Presentation only: it formats and selects numbers PRODUCTION already produced
   (scenarios, s.res, s.lev, path replay, s.res.pathFederalTax). It never
   computes a planning/projection/RMD/withdrawal/success-rate/tax number.
   The PROD object is the only coupling to production; it reads module symbols
   directly (this IIFE shares the module scope).
   =========================================================================== */
(function () {
  'use strict';

  function openSolver(){
    if(!guardPlanMutation()) return;
    uiState.solverFormOpen = true;
    renderSolvePanel();
    const p = document.getElementById('solve-panel');
    if(p) p.scrollIntoView({ behavior:'smooth', block:'center' });
  }

  let _selectedId = null;

  const PROD = {
    scenarios:    () => scenarios,
    getSelectedId:() => _selectedId,
    setSelectedId:(id) => { _selectedId = id; },
    addScenario:  () => { addScenario(); },
    solve:        () => openSolver(),
    afterEngineAction: () => {},      // addScenario already runs runAll()→sync; solver opens a form
    isTypicalPath:() => pathReplay.mode === 'typical',
    id:        (s) => String(scenarios.indexOf(s)),
    name:      (s) => s.name,
    prob:      (s) => s.res && s.res.successRate,
    // Why this scenario has no probability. Without exposing it the view has no
    // way to say anything beyond a dash.
    error:     (s) => s.runError || null,
    median:    (s) => { const e = s.res && s.res.envelope; return (e && e.length) ? e[e.length - 1].p50 : null; },
    range:     (s) => {
      const t = s.res && s.res.terminal; if(!t) return null;
      const e = s.res.envelope, p50 = (e && e.length) ? e[e.length - 1].p50 : (t.p50 != null ? t.p50 : null);
      const lo = t.p10, hi = t.p90;
      const medianPct = (lo != null && hi != null && hi > lo && p50 != null)
        ? Math.max(0, Math.min(100, (p50 - lo) / (hi - lo) * 100)) : 50;
      return { lo, hi, medianPct };
    },
    viability: (s) => viabilityString(s),
    isBaseline:(s) => !!s.base,
    levers:    (s) => leversFor(s),
    goals:     (s) => goalsVM(s),
    stress:    (s) => (s.res && s.res.stress) || [],   // populated by computeHistoricalStress in runAll (engine-derived)
    pathRows:  (s) => buildPathRows(s, {
      simByIndex, baselineResult, plan,
      currentYear: new Date().getFullYear(),
    }),
    cashSummary: (s) => buildCashSummary(s, {
      simByIndex, baselineResult, pathDigest,
    }),
    typicalPathFederalTax: (s) => s.res && s.res.typicalPathFederalTax,
    pathFederalTax: (s) => {
      const pathKey = pathReplay.mode === 'favorable' ? 'p90'
        : pathReplay.mode === 'typical' ? 'p50'
        : (pathReplay.mode === 'stressed' || pathReplay.mode === 'sequence-stress') ? 'p10'
        : null;
      return pathKey ? s.res?.pathFederalTax?.[pathKey] : null;
    },
    householdName: () => (plan.meta && (plan.meta.primaryName || plan.meta.household)) || '',
  };

  /* ---- presentation helpers (formatting + color only) --------------------- */

  
  
  function fmtMoney(n) {
    if (n == null || !Number.isFinite(n) || n < 0) return '—';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  
  
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  
  // Cash-flow table WD column: slate under 5%, then coral/rust only — no amber
  // or gold tones (those compete with accent gold elsewhere in the UI).
  
  
  const CHECK = (sw, s) => '<svg width="' + s + '" height="' + s + '" viewBox="0 0 15 15" fill="none"><path d="M3 7.5 L6 10.5 L12 4" stroke="#8fa57e" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  const DOWN_TRI = '<svg width="8" height="8" viewBox="0 0 9 9" fill="#c0795f"><path d="M4.5 8 L0.5 2 L8.5 2 Z"></path></svg>';

  // Age-specific viability string per the design spec:
  //   "Funds last to age X"     — plan survives the median path
  //   "Shortfall risk after age X" — median path depletes before plan end
  // Reads the typical (p50) path from the scenario's already-computed results.
  // Pure presentation: no engine math, no re-simulation.
  function viabilityString(s) {
    if (!s.res) return '';
    const planEnd = resolveGoalSpan(plan).planEndAge;
    // Use the p50 (typical) path index from the scenario's own result set so
    // the viability string is consistent with the rest of the Focus panel.
    const p50Idx = (s.res.paths && s.res.paths.p50 && s.res.paths.p50.simIndex != null)
      ? s.res.paths.p50.simIndex : 0;
    const sim = (Array.isArray(s.res.sims) ? s.res.sims.find(x => x.simIndex === p50Idx) : null)
             || (Array.isArray(s.res.sims) ? s.res.sims[0] : null);
    if (!sim) return '';
    if (sim.failed && sim.depletionAge) {
      return 'Shortfall risk after age ' + sim.depletionAge;
    }
    return 'Funds last to age ' + planEnd;
  }

  /* ---- adapter helpers (production shapes → view-models) ------------------- */
  // Lever keys shown, in a stable order across all scenarios (so Compare aligns).
  function activeLeverKeys() {
    const anyEvent = (scenarios || []).some((s) => s.lev && s.lev.eventAmt > 0);
    // Pension is removed from the Scenarios lever rows (per product ruling). The
    // engine still honors pension data from the plan; it is just not an editable
    // Scenarios lever. The one-time event row only appears when an event is set.
    // Retirement age drops out once the household is already retired — it is no
    // longer a lever we can pull (the retirement decision is behind them).
    const retired = hhAlreadyRetired();
    return LEVCFG.map((c) => c.key).filter((k) =>
      k !== 'pensionAge'
      && (k !== 'eventAmt' || anyEvent)
      && (k !== 'retireAge' || !retired));
  }
  function leverDeltaText(cfg, lev, baseLev) {
    if (!baseLev || lev === baseLev || cfg.key === 'sellAge') return null;
    const d = (lev[cfg.key] || 0) - (baseLev[cfg.key] || 0);
    if (!d) return null;
    const sign = d > 0 ? '+' : '−', a = Math.abs(d);
    if (cfg.key === 'spend')   return sign + '$' + Math.round(a / 12).toLocaleString('en-US') + '/mo';
    if (cfg.key === 'savings' || cfg.key === 'eventAmt') return sign + '$' + a.toLocaleString('en-US');
    if (cfg.key === 'risk')    return sign + a + ' lvl';
    return sign + a + ' yr';
  }
  // Derive the prefilled input string for a dollar lever (no $ or unit).
  function editInputVal(cfg, lev) {
    if (cfg.edit === 'monthly') return Math.round((lev[cfg.key] || 0) / 12).toLocaleString('en-US');
    if (cfg.edit === 'event')   return (lev.eventAmt || 0).toLocaleString('en-US');
    if (cfg.edit === 'money')   return (lev[cfg.key] || 0).toLocaleString('en-US');
    return null;
  }
  function leversFor(s) {
    const base = (scenarios.find((x) => x.base) || {}).lev;
    return activeLeverKeys().map((k) => {
      const cfg = LEVCFG.find((c) => c.key === k); if (!cfg) return null;
      const fv = cfg.fmt(s.lev[k], s.lev), val = fv[0], unit = fv[1];
      const value = (val === '__needs__') ? ('— @ ' + unit) : (val + (unit ? (' ' + unit) : ''));
      return {
        key: k, label: cfg.name, value: value, delta: leverDeltaText(cfg, s.lev, base),
        editType: cfg.edit || null,
        inputVal: editInputVal(cfg, s.lev),
        unitStr: unit || '',
        eventAge: (cfg.edit === 'event') ? (s.lev.eventAge != null ? s.lev.eventAge : '') : null,
      };
    }).filter(Boolean);
  }
  // Effective goal (base value with this scenario's override applied) — the Goals
  // page defines the base inventory; each scenario carries amount/startAge/endAge
  // overrides only. `idx` is the goal's index in the base inventory (the override key).
  const effGoal = resolveEffectiveGoal;
  // Compare goal rows = base goals with a base amount > 0, keeping their original
  // index so overrides and engine goals stay aligned.
  function goalRowsBase() {
    return (Array.isArray(plan.goals) ? plan.goals : [])
      .map((g, i) => ({ g: g, i: i }))
      .filter((r) => (r.g.amount || 0) > 0);
  }
  // Per-scenario goals view-model: effective values + override/baseline-delta info.
  function goalsVM(s) {
    const ovMap = (s && s.lev && s.lev.goalOv) || {};
    const baseScn = scenarios.find((x) => x.base);
    const baseOvMap = (baseScn && baseScn.lev && baseScn.lev.goalOv) || {};
    const planRetirementAge = plan.household.primary.retirementAge;
    const planGoalSpan = resolveGoalSpan(plan);
    const scenarioRetirementAge = Number.isFinite(s?.lev?.retireAge) ? s.lev.retireAge : planRetirementAge;
    const baselineRetirementAge = Number.isFinite(baseScn?.lev?.retireAge) ? baseScn.lev.retireAge : planRetirementAge;
    const scenarioHouseholdRetirementAge = resolveScenarioHouseholdRetirementAge(
      plan,
      scenarioRetirementAge,
    );
    const baselineHouseholdRetirementAge = resolveScenarioHouseholdRetirementAge(
      plan,
      baselineRetirementAge,
    );
    return goalRowsBase().map(({ g, i }) => {
      const e = effGoal(g, ovMap[i], scenarioHouseholdRetirementAge);
      const once = (e.startAge === e.endAge);
      const scenarioGoalSpan = {
        currentAge: planGoalSpan.currentAge,
        retirementAge: scenarioHouseholdRetirementAge,
      };
      const fundingNote = goalHasFutureWorkingYears(e,scenarioGoalSpan)
        ? (g.fundFromPortfolioBeforeRetirement === true
            ? 'portfolio funded before retirement'
            : 'outside portfolio before retirement')
        : '';
      const ov = ovMap[i];
      const overridden = !!(ov && (ov.amount != null || ov.startAge != null || ov.endAge != null));
      // Δ vs the baseline scenario's effective values for this goal.
      const be = effGoal(g, baseOvMap[i], baselineHouseholdRetirementAge);
      const aDelta = (e.amount || 0) - (be.amount || 0);
      const sameAsBase = (e.amount === be.amount && e.startAge === be.startAge && e.endAge === be.endAge);
      return {
        idx: i,
        name: g.name || 'Goal',
        meta: (once ? ('at age ' + e.startAge) : ('age ' + e.startAge + '–' + e.endAge))
          + (fundingNote ? (' · ' + fundingNote) : ''),
        amount: e.amount || 0, startAge: e.startAge, endAge: e.endAge,
        cadence: once ? 'one-time' : '/yr', once: once,
        fundingNote,
        on: (e.amount || 0) > 0, added: false,
        overridden: overridden,
        amountDelta: aDelta, sameAsBase: sameAsBase,
      };
    });
  }
  
  // Cash-flow rows = the selected path's engine rows from CURRENT AGE forward,
  // formatted. Working (accum) years are included so the ledger starts today,
  // not at retirement; they carry an `accum` flag so the renderer can dash the
  // spending/draw columns (the engine assumes salary covers costs while working).
  // r.wdRate is the engine's own per-row withdrawal rate (percent); r.taxes the
  // engine row tax — no UI-side math here.
  
  

  // Lever step: reuses the EXISTING production mutation (LEVCFG/levRange/syncPension)
  // and the existing manual Run flow ("Adjusted · Run to update"). No auto-run.
  function stepFocusLever(ci, key, dir) {
    if(!guardPlanMutation()) return;
    const cfg = LEVCFG.find((c) => c.key === key); if (!cfg) return;
    const sc = scenarios[ci]; if (!sc || !sc.lev) return;
    const r = levRange(cfg), L = sc.lev;
    L[key] = Math.max(r.min, Math.min(r.max, (L[key] != null ? L[key] : r.min) + dir * r.step));
    if (key === 'pensionAge') L.pensionAuto = false;
    if (key === 'retireAge' && L.pensionAuto) syncPension(L);
    saveScenarios();
    syncHeaderStatus('Adjusted · Run to update');
  }
  // Commit a typed value from a .cmp-lev-in input in the Compare view.
  // Mirrors the parse/clamp logic from the scenario lever edit contract.
  function commitCmpInput(inp) {
    if(!guardPlanMutation()){ syncScenariosView(); return; }
    const ci = parseInt(inp.dataset.scnId, 10);
    const sc = scenarios[ci]; if (!sc || !sc.lev) return;
    const L = sc.lev;
    const edit = inp.dataset.edit;
    const raw = parseFloat(String(inp.value).replace(/[^0-9.]/g, ''));
    if (!isFinite(raw) || raw < 0) return;
    if (edit === 'monthly') {
      L.spend = Math.round(raw * 12);
    } else if (edit === 'money') {
      const cfg = LEVCFG.find((c) => c.key === inp.dataset.key);
      const r = cfg ? levRange(cfg) : null;
      const v = Math.round(raw);
      L[inp.dataset.key] = r ? Math.max(r.min, Math.min(r.max, v)) : v;
    } else if (edit === 'eventAmt') {
      L.eventAmt = raw > 0 ? Math.round(raw) : 0;
    } else if (edit === 'eventAge') {
      const lo = plan.household.primary.currentAge, hi = resolveGoalSpan(plan).planEndAge;
      const a = Math.round(raw);
      if (isFinite(a)) L.eventAge = Math.max(lo, Math.min(hi, a));
    }
    saveScenarios();
    syncHeaderStatus('Adjusted · Run to update');
    syncScenariosView();
  }
  // Commit a typed per-scenario GOAL override (amount / startAge / endAge / onceAge).
  // Writes into scenarios[ci].lev.goalOv[idx] — the base plan and other scenarios are
  // never touched. Fields equal to the base value are dropped so overrides stay minimal
  // and "same as Baseline" stays accurate.
  function commitGoalInput(inp) {
    if(!guardPlanMutation()){ syncScenariosView(); return; }
    const ci = parseInt(inp.dataset.scnId, 10);
    const idx = parseInt(inp.dataset.goalIdx, 10);
    const field = inp.dataset.goalField;
    const sc = scenarios[ci]; if (!sc || !sc.lev) return;
    const base = (Array.isArray(plan.goals) ? plan.goals : [])[idx]; if (!base) return;
    const retirementAge = Number.isFinite(sc.lev.retireAge) ? sc.lev.retireAge : plan.household.primary.retirementAge;
    const householdRetirementAge = resolveScenarioHouseholdRetirementAge(plan, retirementAge);
    const resolvedBase = effGoal(base, null, householdRetirementAge);
    const raw = parseFloat(String(inp.value).replace(/[^0-9.]/g, ''));
    if (!isFinite(raw) || raw < 0) return;
    const lo = plan.household.primary.currentAge, hi = resolveGoalSpan(plan).planEndAge;
    if (!sc.lev.goalOv) sc.lev.goalOv = {};
    const ov = sc.lev.goalOv[idx] || (sc.lev.goalOv[idx] = {});
    if (field === 'amount') {
      ov.amount = Math.round(raw);
    } else if (field === 'onceAge') {
      const v = Math.max(lo, Math.min(hi, Math.round(raw)));
      ov.startAge = v; ov.endAge = v;
    } else if (field === 'startAge') {
      let v = Math.max(lo, Math.min(hi, Math.round(raw)));
      const curEnd = (ov.endAge != null) ? ov.endAge : resolvedBase.endAge;
      if (v > curEnd) v = curEnd;
      ov.startAge = v;
    } else if (field === 'endAge') {
      let v = Math.max(lo, Math.min(hi, Math.round(raw)));
      const curStart = (ov.startAge != null) ? ov.startAge : resolvedBase.startAge;
      if (v < curStart) v = curStart;
      ov.endAge = v;
    }
    // Minimize the override: drop any field that matches the base, and drop the
    // whole entry (and map) when nothing differs — keeps deltas/"same as base" honest.
    ['amount', 'startAge', 'endAge'].forEach((f) => { if (ov[f] != null && ov[f] === resolvedBase[f]) delete ov[f]; });
    if (ov.amount == null && ov.startAge == null && ov.endAge == null) delete sc.lev.goalOv[idx];
    if (sc.lev.goalOv && Object.keys(sc.lev.goalOv).length === 0) delete sc.lev.goalOv;
    saveScenarios();
    syncHeaderStatus('Adjusted · Run to update');
    syncScenariosView();
  }

  /* ---- TAX MAPPING (selection over existing production data, not a tax engine) */
  
  

  /* ---- adapter: production scenario → view-model -------------------------- */
  function vmScenario(s) {
    const prob = PROD.prob(s);
    const median = PROD.median(s);
    return {
      id: PROD.id(s), name: PROD.name(s), prob: prob,
      probStr: (prob == null ? '—' : scenarioNum(prob, 1)),
      error: PROD.error(s),
      tone: toneForProb(prob), median: median == null ? '—' : fmtMoney(median),
      isBaseline: PROD.isBaseline(s), levers: PROD.levers(s), goals: PROD.goals(s),
      range: PROD.range(s), viability: PROD.viability(s), stress: PROD.stress(s), raw: s,
    };
  }
  

  /* ---- COMPARE ----------------------------------------------------------- */
  function renderCompareView(scns, baseline) {
    return renderCompare(scns, baseline, {
      plan, goalsExpandedState: state.goalsExpanded, esc, downTri: DOWN_TRI,
    });
  }

  /* ---- FOCUS ------------------------------------------------------------- */
  
  function renderFocusView(scns, baseline, focusedId, showRange) {
    return renderFocus(scns, baseline, focusedId, showRange, {
      esc, fmtMoney, checkIcon: CHECK, stressEraCount: STRESS_ERAS.length,
    });
  }

  /* ---- CASH FLOW --------------------------------------------------------- */
  // Visible columns, exactly and in order. No Engine-tax / Federal-tax columns.
  const CF_COLS = ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'];

  function renderCashflowView(scn, allScns) {
    return renderCashflow(scn, allScns, {
      pathRows: PROD.pathRows,
      cashSummary: PROD.cashSummary,
      cashFromRetirement: state.cashFromRetirement,
      isTypicalPath: PROD.isTypicalPath,
      typicalPathFederalTax: PROD.typicalPathFederalTax,
      pathFederalTax: PROD.pathFederalTax,
      toneGlow, ring, wdColor, num:scenarioNum, esc, fmtMoney, cfCols: CF_COLS,
    });
  }

  // Group rows into bands (presentation only — alternating shade at RMD age).
  

  /* ---- STATE + ONE AUTHORITATIVE SYNC ------------------------------------ */
  const $id = (id) => document.getElementById(id);

  function buildScenarios() {
    const list = (PROD.scenarios() || []).map(vmScenario);
    const baseline = list.find((s) => s.isBaseline) || list[0] || null;
    if (state.focusedId == null || !list.some((s) => s.id === state.focusedId)) {
      state.focusedId = (PROD.getSelectedId() || (list[0] && list[0].id) || null);
    }
    return { list: list, baseline: baseline };
  }

  function syncScenariosView() {
    const view = $id('scn-view');
    if (!view) return;
    if(isHouseholdStorageBlocked()){
      renderBlockedRecoverySurfaces();
      return;
    }
    const built = buildScenarios(), list = built.list, baseline = built.baseline;

    const sub = $id('scn-subtitle');
    if (sub) {
      const hh = PROD.householdName();
      sub.textContent = (hh ? hh + ' · ' : '') + list.length + ' plan' + (list.length === 1 ? '' : 's');
    }

    if(!list.length){
      view.innerHTML = '<div class="scn-empty">Planning projections are unavailable until household storage is restored.</div>';
      syncToolbar();
      syncRecoveryControls();
      return;
    }

    if (state.cashActive) {
      const scn = list.find((s) => s.id === state.focusedId) || baseline || list[0];
      view.innerHTML = scn ? renderCashflowView(scn, list) : '';
      mountPathControls();
    } else if (state.view === 'focus') {
      view.innerHTML = renderFocusView(list, baseline, state.focusedId, state.showRange);
    } else {
      view.innerHTML = renderCompareView(list, baseline);
    }
    syncToolbar();
    bindViewEvents();
    syncRecoveryControls();
  }

  function syncToolbar() {
    const inCash = state.cashActive;
    const segC = $id('scn-seg-compare'), segF = $id('scn-seg-focus'), chip = $id('scn-cash-toggle');
    if (segC) { const on = !inCash && state.view === 'compare'; segC.classList.toggle('is-active', on); segC.setAttribute('aria-selected', on ? 'true' : 'false'); }
    if (segF) { const on = !inCash && state.view === 'focus';   segF.classList.toggle('is-active', on); segF.setAttribute('aria-selected', on ? 'true' : 'false'); }
    if (chip) { chip.classList.toggle('is-on', inCash); chip.setAttribute('aria-checked', inCash ? 'true' : 'false'); }
  }

  // Relocate production's existing path-replay controls into the Cash Flow slot.
  // We move the node — never recreate it — so its bindings/state survive.
  function mountPathControls() {
    const slot = $id('scn-cf-path-controls');
    if (slot && window.scnPathControlsEl) slot.appendChild(window.scnPathControlsEl);
  }

  function bindViewEvents() {
    const view = $id('scn-view'); if (!view) return;
    view.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('click', () => { state.focusedId = el.dataset.pick; PROD.setSelectedId(state.focusedId); syncScenariosView(); });
    });
    view.querySelectorAll('[data-cash-pick]').forEach((el) => {
      el.addEventListener('click', () => { state.focusedId = el.dataset.cashPick; PROD.setSelectedId(state.focusedId); syncScenariosView(); });
    });
    // "Start at retirement" — hide the working (accum) years in the cash-flow ledger.
    const retStart = view.querySelector('[data-cash-retstart]');
    if (retStart) retStart.addEventListener('click', () => { state.cashFromRetirement = !state.cashFromRetirement; syncScenariosView(); });
    // Always-visible +/- buttons in Compare (discrete levers) and Focus (all levers).
    // data-lever-key + data-dir + optional data-scn-id → stepFocusLever.
    view.querySelectorAll('[data-lever-key]').forEach((el) => {
      el.addEventListener('click', () => {
        const ci = (el.dataset.scnId != null && el.dataset.scnId !== '')
          ? parseInt(el.dataset.scnId, 10) : parseInt(state.focusedId, 10);
        stepFocusLever(ci, el.dataset.leverKey, +el.dataset.dir);
        syncScenariosView();
      });
    });
    // Type-in inputs for dollar levers in Compare view.
    view.querySelectorAll('.cmp-lev-in').forEach((inp) => {
      inp.addEventListener('change', () => commitCmpInput(inp));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      if (!inp.classList.contains('cmp-lev-in--age')) {
        inp.addEventListener('input', () => liveCommas(inp));
      }
    });
    // Per-scenario goal override inputs (amount / start / end) in expanded Compare.
    view.querySelectorAll('.cmp-goal-in').forEach((inp) => {
      inp.addEventListener('change', () => commitGoalInput(inp));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      if (!inp.classList.contains('cmp-goal-in--age')) {
        inp.addEventListener('input', () => liveCommas(inp));
      }
    });
    // Goals section expand/collapse toggle (visible, stable chevron control).
    const goalsToggle = view.querySelector('[data-goals-toggle]');
    if (goalsToggle) {
      goalsToggle.addEventListener('click', () => { state.goalsExpanded = !state.goalsExpanded; syncScenariosView(); });
      goalsToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.goalsExpanded = !state.goalsExpanded; syncScenariosView(); }
      });
    }
    // Per-scenario ⋯ menu in Compare heads: Rename (inline input) / Delete.
    // This is the "later pass" wiring promised when the old #scn-band grid was
    // retired — it drives the kept removeScenario() seam and saveScenarios().
    view.querySelectorAll('.scol__menu').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if(!guardPlanMutation()){ syncScenariosView(); return; }
        const head = btn.closest('.scol__head--menu'); if (!head) return;
        const wasOpen = !!head.querySelector('.scol__pop');
        closeScnMenus();
        if (wasOpen) return;                       // second click toggles closed
        const ci = parseInt(btn.dataset.scnId, 10);
        const s = scenarios[ci]; if (!s || s.base) return;
        const pop = document.createElement('div');
        pop.className = 'scol__pop';
        pop.innerHTML =
          '<button class="scol__pop-item" type="button" data-act="rename">Rename</button>' +
          '<button class="scol__pop-item scol__pop-item--danger" type="button" data-act="delete">Delete plan</button>';
        head.appendChild(pop);
        pop.addEventListener('pointerdown', (pe) => pe.stopPropagation());
        pop.querySelector('[data-act="rename"]').addEventListener('click', (pe) => {
          pe.stopPropagation();
          closeScnMenus();
          startScnRename(head, ci);
        });
        pop.querySelector('[data-act="delete"]').addEventListener('click', (pe) => {
          pe.stopPropagation();
          const cur = scenarios[ci]; if (!cur || cur.base) { closeScnMenus(); return; }
          if (!confirm('Delete "' + cur.name + '"? Its levers and per-plan edits are removed.')) { closeScnMenus(); return; }
          closeScnMenus();
          removeScenario(ci);   // splice + saveScenarios + runAll → sync re-renders
        });
      });
    });
  }

  function closeScnMenus() {
    document.querySelectorAll('.scol__pop').forEach((p) => p.remove());
  }

  // Inline rename: the name span becomes an input in place. Enter/blur commit
  // (trimmed, non-empty), Escape cancels; either way the view re-syncs.
  function startScnRename(head, ci) {
    const nameEl = head.querySelector('.scol__name');
    const s = scenarios[ci];
    if (!nameEl || !s) return;
    const inp = document.createElement('input');
    inp.className = 'scol__rename';
    inp.type = 'text';
    inp.maxLength = 40;
    inp.value = s.name;
    inp.setAttribute('aria-label', 'Rename ' + s.name);
    nameEl.replaceWith(inp);
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      if(!guardPlanMutation()){ syncScenariosView(); return; }
      const v = inp.value.trim();
      if (v && v !== s.name) { s.name = v; saveScenarios(); }
      syncScenariosView();
    };
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (e) => {
      // Commit directly (not via blur() — blur is inert in unfocused tabs).
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); done = true; syncScenariosView(); }
    });
    inp.focus();
    inp.select();
  }

  function bindToolbarOnce() {
    const segC = $id('scn-seg-compare'), segF = $id('scn-seg-focus'), chip = $id('scn-cash-toggle');
    if (segC) segC.addEventListener('click', () => { state.cashActive = false; state.view = 'compare'; syncScenariosView(); });
    if (segF) segF.addEventListener('click', () => { state.cashActive = false; state.view = 'focus'; syncScenariosView(); });
    if (chip) chip.addEventListener('click', () => { state.cashActive = !state.cashActive; syncScenariosView(); });
    const add = $id('scn-add'), solve = $id('scn-solve');
    if (add)   add.addEventListener('click',   () => { PROD.addScenario(); PROD.afterEngineAction(); });
    if (solve) solve.addEventListener('click', () => { PROD.solve();       PROD.afterEngineAction(); });
  }

  function init() {
    if (!document.getElementById('scn-view')) return;
    const src = document.querySelector('#scn-path-replay');
    if (src) window.scnPathControlsEl = src;
    bindToolbarOnce();
    // One document-level closer for the ⋯ menus (bound once — init runs once).
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest && (e.target.closest('.scol__pop') || e.target.closest('.scol__menu'))) return;
      closeScnMenus();
    });
    syncScenariosView();
  }

  window.ScenariosUI = { sync: syncScenariosView, renderCompare: renderCompareView, renderFocus: renderFocusView, renderCashflow: renderCashflowView };
  init();
})();

renderSolvePanel();
syncPathControls();
renderInputs();
bindHouseholdRailOnce();   // chapter rail (Demographics / Net Worth / Cash Flow) view switch
if(canRunEngine()){
  reseedScenarios({ markDirty: false });   // align baseline levers with hydrated plan (saved levers can be stale)
  syncHousehold();           // render the editable landing Household page from `plan`
  runAll();   // first iteration runs immediately so the tool opens populated
} else {
  renderBlockedRecoverySurfaces();
}
document.body.classList.toggle('scn-active', document.querySelector('.page.on')?.dataset.page==='scenarios');
syncHeaderCluster();
syncRecoveryControls();

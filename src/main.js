import { runSimulation, resolveInputs, generateReturnPath, resetSeed, LONGRUN_INFLATION, pathDigest, RISK_PROFILES, PROJECTION_EXECUTION_LIMITS, defaultPlan as plan } from '../engine.js';
import { runFederalFundingSimulation } from './planning/tax/runMonteCarloWithFederalFunding.js';
import { runHistoricalPathWithFederalTax } from './planning/tax/runHistoricalPathWithFederalTax.js';
import { seqChartSvg } from '../ui/charts.js';
import { escHtml } from '../ui/dom.js';
import {
  SHIPPED_DEFAULT_HOUSEHOLD_IDS,
  createBlankHousehold,
  createSelectableDefaultHouseholds,
} from '../ui/householdFactories.js';
import { bindHouseholdEditor } from './household/commit.js';
import { createHouseholdWizardController } from './household/wizard.js';
import { createHouseholdWizardCommitBoundary } from './household/wizardEdits.js';
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
import { drawSeqChart, renderPrints, syncPathControls } from '../ui/sequencing.js';
import { buildSimulationRows, renderCashflow } from '../ui/cashflow.js';
import { toneForProb, wdColor, num as scenarioNum, renderCompare, renderFocus } from '../ui/scenarios.js';
import {
  buildRetirementEntryPlan,
  deriveRetirementEntryAccounts,
} from './scenarios/buildRetirementEntryPlan.js';
import { createCashFlowController } from './scenarios/createCashFlowController.js';
import { HISTORICAL_PERIODS } from './scenarios/historicalPeriods.js';
import { installDesignSystemPrimitives } from '../ui/designSystemPrimitives.js';
import {
  scenarios, sharedPaths, plansDirty, baseSnapshot,
  pathReplay, refreshPathSeed, cashFlowPathSelection, saveCashFlowPathSelection,
  uiState, scenariosUiState as state,
} from './state.js';
/* ╔══════════════════════════════════════════════════════════════╗
   ║  PARALLAX V2 — LEGACY COMPOSITION ROOT (UI + ENGINES)       ║
   ╚══════════════════════════════════════════════════════════════╝ */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
installDesignSystemPrimitives();
/* ── Household model: pure factories + multi-household persistence ──────────
   The app boots without an active household. The advisor explicitly selects a
   shipped template or saved household; browser state never chooses the startup
   record.

   `plan` is the engine's default plan object (imported live). It cannot be
   reassigned (const import binding), so hydratePlan() mutates it in place —
   preserving the object identity the engine reads internally. */

// Pristine engine default, captured BEFORE any mutation. Both factories clone
// this so they start from the exact engine schema (forward-compatible: new
// engine fields flow through automatically).
const PRISTINE_PLAN = JSON.parse(JSON.stringify(plan));
const newHouseholdId = () => 'hh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const RUNTIME_HOUSEHOLD_IDS = new Set(SHIPPED_DEFAULT_HOUSEHOLD_IDS);
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
  removeItem(key){ localStorage.removeItem(key); },
};

function isHouseholdStorageReadOnly(){
  return accountMigrationState.readOnly === true;
}

function isHouseholdStorageBlocked(){
  return accountMigrationState.blocked === true;
}

function canRunEngine(){
  return Boolean(activeHouseholdId) && !isHouseholdStorageBlocked();
}

function syncRecoveryStatus(message){
  recoveryStatusPinned = true;
  accountMigrationState.message = message;
  const el = $('#status');
  if(el && message != null) el.textContent = message;
  syncHeaderCluster();
}

function guardHouseholdStorageMutation(){
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

function guardPlanMutation(){
  if(!activeHouseholdId){
    syncHeaderStatus('Select or create a household to begin');
    return false;
  }
  return guardHouseholdStorageMutation();
}

function recoveryPanelHtml(){
  const message = accountMigrationState.message || getBlockedMessage();
  return `<div class="scn-empty" role="status">${escHtml(message)}</div>`;
}

function renderBlockedRecoverySurfaces(){
  if(!isHouseholdStorageBlocked()) return;
  const html = recoveryPanelHtml();
  ['#hh-view','#np-content','#scn-view','#seq-prints'].forEach(sel => { const el=$(sel); if(el) el.innerHTML=html; });
  ['#hh-wiz-footer','#seq-chips'].forEach(sel => { const el=$(sel); if(el) el.innerHTML=''; });
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
    '#hh-new','#hh-view input','#hh-view select','#hh-view textarea','#hh-view .row-x','#hh-view [data-add]',
    '#hh-view [data-hh-action="add-account"]','#hh-view [data-hh-action="save-account"]','#hh-view [data-hh-action="remove-account"]',
    '#hh-view [data-hh-action="net-worth-toggle-more"]','#hh-view [data-hh-action="net-worth-pick-type"]','#hh-view [data-hh-action="net-worth-pick-custom"]',
    '#hh-view [data-hh-action="net-worth-clear-type"]','#hh-view [data-hh-action="net-worth-save-entry"]','#hh-view [data-hh-action="net-worth-remove-entry"]',
    '#hh-view [data-hh-action="override-income-group"]','#hh-view [data-hh-action="revert-income-group"]','#hh-view [data-hh-action="remove-tax-item"]',
    '#hh-view [data-hh-action="add-spouse"]','#hh-view [data-hh-action="remove-spouse"]','#hh-view [data-hh-action="save-account"]',
    '#hh-view [data-hh-action="open-account-form"]','#hh-view [data-hh-action="open-add"]','#hh-view [data-hh-action="commit-add"]','#hh-view [data-hh-action="add-home"]','#hh-view [data-hh-action="add-mortgage"]',
    '#hh-view [data-hh-action="add-pension-age"]','#np-content input','#np-content select','#np-content textarea','#np-content button',
    '#np-content .row-x','#np-content [data-add]','#np-content [data-act]','#scn-add','#scn-view [data-lever-key]','#scn-view .cmp-lev-in',
    '#scn-view .cmp-goal-in','#scn-view .scol__menu'
  ];
  if(isHouseholdStorageBlocked()) selectors.push('#run-btn','#hh-menu-btn','#hh-switch','#cashflow-path-mode','#seq-select','#seq-chips button');
  document.querySelectorAll(selectors.join(',')).forEach(el => {
    if('disabled' in el) el.disabled=true;
    el.setAttribute('aria-disabled','true');
  });
}

function persistHouseholdsDb(){
  if(!guardHouseholdStorageMutation()) return false;
  try{ localStorage.setItem(HHDB_KEY, JSON.stringify(householdsDb)); return true; }catch(e){ return false; }
}
function persistActiveId(){
  if(!guardHouseholdStorageMutation()) return false;
  try{
    if(isRuntimeHousehold(activeHouseholdId)){
      localStorage.removeItem(ACTIVE_KEY);
      return true;
    }
    localStorage.setItem(ACTIVE_KEY, activeHouseholdId);
    return true;
  }catch(e){
    return false;
  }
}
function saveActiveHousehold(){
  if(!guardHouseholdStorageMutation()) return false;
  // Runtime records are immutable templates. A real edit must first create a
  // durable household copy through guardPlanMutation().
  if(isRuntimeHousehold(activeHouseholdId)) return false;
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
  const unselected = createBlankHousehold(PRISTINE_PLAN, '', new Date().getFullYear());
  unselected.meta.name = '';
  hydratePlan(unselected);
  const read = readHouseholdStore(householdStorage);
  let prepared = prepareHouseholdStore(read, {
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
  if(commit.readOnly){
    prepared = applyPreparedReadOnlyFallback(prepared);
    accountMigrationState = {
      blocked: false,
      readOnly: true,
      message: prepared.message || getReadOnlyMessage(),
      issuesByHousehold: prepared.issuesByHousehold || {},
    };
  } else if(!commit.ok){
    accountMigrationState = {
      blocked: true,
      readOnly: false,
      message: getBlockedMessage(),
      issuesByHousehold: {},
    };
    syncRecoveryStatus(accountMigrationState.message);
    return;
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
// custom household's scenarios never collide with another household. We save only the
// durable parts (name/base/lev) — never res (recomputed on Run). Wrapped in
// try/catch so a corrupt/blocked store never breaks the app.
const SCEN_PREFIX='parallax.scenarios.';
const scenKey=id=>SCEN_PREFIX + (id || activeHouseholdId) + '.v1';
function saveScenarios(){
  if(!guardHouseholdStorageMutation()) return false;
  if(!activeHouseholdId) return false;
  if(isRuntimeHousehold(activeHouseholdId)) return false;
  try{
    const slim=scenarios.map(s=>({name:s.name, base:!!s.base, lev:s.lev}));
    localStorage.setItem(scenKey(), JSON.stringify(slim));
    return true;
  }catch(e){ return false; }
}
function loadScenarios(id){
  if(!(id || activeHouseholdId)) return null;
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
  if(!isRuntimeHousehold(activeHouseholdId)){
    try{ localStorage.removeItem(scenKey()); }catch(e){}
  }
  uiState.scenarios=defaultScenarios(); uiState.baseSnapshot=defaultLevers();
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
  if(isRuntimeHousehold(activeHouseholdId)){
    planSaveDirty=false;
    saveFailed=false;
    return true;
  }
  planSaveDirty=true;
  const ok=saveActiveHousehold() && saveScenarios();
  saveFailed=!ok;
  planSaveDirty=!ok;
  return ok;
}
function syncPlanEditStatus(message){
  if(saveFailed){
    syncHeaderStatus('Automatic save failed · storage blocked or full');
    return;
  }
  if(isRuntimeHousehold(activeHouseholdId)){
    syncHeaderStatus('Demo changes are temporary · use New Household to save a plan');
    return;
  }
  syncHeaderStatus(message);
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
    t.classList.toggle('is-active', on);
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

// Scenarios are NAMED, SAVEABLE objects (the household-centric data root). They
// start identical; the advisor moves levers to show each decision's effect, and
// can rename / add / remove them. Both tabs read this shared set.
// The first-run scenario set tells a story: B delays the plan's retirement
// (drawdown) age 2 years, C goes aggressive (wealth line jumps, success does
// NOT — volatility drag). Deltas are relative to the ACTIVE household's base
// levers so the set is meaningful for any household, not just the demo.
function defaultScenarios(){
  const s=[
    {name:'Baseline',   base:true,  lev:defaultLevers(), res:null},
    {name:'Scenario B', base:false, lev:defaultLevers(), res:null},
    {name:'Aggressive', base:false, lev:defaultLevers(), res:null},
  ];
  // Scenario B contrast. Pre-retirement: "retire 2 years later" (the core lever
  // when testing a feasible retirement date). Already retired: that
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
if(isHouseholdStorageBlocked() || !activeHouseholdId){
  uiState.scenarios = [];
} else {
  uiState.scenarios = loadScenarios() || defaultScenarios();
}
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
  if(markDirty ? !guardPlanMutation() : !guardHouseholdStorageMutation()) return;
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
// Post-edit refresh for the live Goals Horizon.
function commitPlanEdit(){
  if(!guardPlanMutation()) return;
  reseedScenarios(); uiState.plansDirty=true; renderInputs();
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
    uiState.plansDirty=true;
    syncPlanEditStatus('Saved automatically · open Scenarios');
  },
  commit:commitPlanEdit,
  insertGoal:insertGoalAt,
  removeGoal:removeGoalAt,
});
const taxBuckets=createTaxBucketsController({
  getPlan:()=>activeHouseholdId ? plan : null,
  isStorageBlocked:isHouseholdStorageBlocked,
  getBlockedMessage,
});
taxBuckets.bind($('#tax-buckets-view'));

/* Household editing is owned by the production intake wizard. */
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
});
const hhUiState = householdWizardController.uiState;
const householdWizardCommitBoundary = createHouseholdWizardCommitBoundary({
  getPlan: () => plan,
  replacePlan: next => hydratePlan(next),
  afterCommit(){
    reseedScenarios();
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
     newHousehold()    → creates a blank household, makes it active.
     switchHousehold() → loads another saved household by id. */
function hhLoadRecord(status){
  if(isHouseholdStorageBlocked()){ guardPlanMutation(); return; }
  const readOnly = isHouseholdStorageReadOnly();
  planSaveDirty = false; saveFailed = false;
  if(!readOnly) reseedScenarios({ markDirty: false });
  householdWizardController.resetForPlan();
  refreshPathSeed();
  uiState.plansDirty = true; uiState.sharedPaths = null;
  syncHousehold();
  updateHouseholdControls();
  renderInputs();
  taxBuckets.sync();
  runAll();
  syncRecoveryControls();
  if(status) syncHeaderStatus(status);
}
// Create and immediately persist a brand-new blank household.
function newHousehold(){
  if(!guardHouseholdStorageMutation()) return;
  if(!canChangeActiveHousehold()) return;
  saveScenarios();                       // …and persist its scoped scenarios
  const blank = createBlankHousehold(PRISTINE_PLAN, newHouseholdId(), new Date().getFullYear());
  householdsDb[blank.meta.householdId] = blank;
  activeHouseholdId = blank.meta.householdId;
  hydratePlan(blank);
  uiState.scenarios = defaultScenarios();
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
  uiState.scenarios = loadScenarios(id) || defaultScenarios();
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

function renderInputs(){
  if(isHouseholdStorageBlocked()){
    renderBlockedRecoverySurfaces();
    return;
  }
  const np = $('#np-content');
  np.innerHTML = goalsHorizon.render();
  goalsHorizon.bind(np);
  syncRecoveryControls();
}
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
const scenarioInputsByResult = new WeakMap();
// One household-session market bundle. It is generated after household load
// and survives every ordinary edit and Scenario run so comparisons use the
// exact same markets. Only loading a household clears it.

/* ── run the engine for all three columns (shared nothing; each its own MC) ── */
// ONE seeded bundle of return paths, shared by every surface that compares
// runs (scenario columns, the goals page's per-goal cost runs). Identical
// markets across runs make any difference a pure decision-effect, and the
// session seed keeps edits and Scenario choices directly comparable.
function ensureSharedPaths(resolvedInputs=null){
  if(!canRunEngine()) return null;
  const horizon = (resolvedInputs || resolveInputs(plan, {})).horizonYears;
  if(!(horizon > 0)) return null;
  const iters = plan.simulation.iterations;
  const sessionHorizon = PROJECTION_EXECUTION_LIMITS.maxHorizonYears;
  if(!sharedPaths){
    resetSeed(pathReplay.seed);
    uiState.sharedPaths = [];
    for(let i=0;i<iters;i++) uiState.appendSharedPath(generateReturnPath(sessionHorizon));
  }
  if(
    sharedPaths.length !== iters
    || sharedPaths.some(path => !Array.isArray(path) || path.length < sessionHorizon)
  ){
    const error = new Error('household-session market bundle dimensions changed');
    error.code = 'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID';
    throw error;
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
  PROJECTION_HORIZON_OUT_OF_RANGE:
    'Plan length is outside the supported projection range',
  PROJECTION_ITERATIONS_OUT_OF_RANGE:
    'Simulation count is outside the supported projection range',
  PROJECTION_RETURN_PATH_DIMENSIONS_INVALID:
    'Market path data does not cover the supported projection range',
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
        buildSeqSelect();
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
          scenarioInputsByResult.set(result, Object.freeze({
            plan: p,
            overrides: Object.freeze({ ...ov }),
          }));
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
      buildSeqSelect();
      if($('.page.on')?.dataset.page === 'sequencing') runSeq();
      if(window.ScenariosUI) window.ScenariosUI.sync();   // one authoritative Scenarios renderer
      const firstFailure = scenarios.find(s => s.runError)?.runError;
      syncHeaderStatus(failed
        ? `Partial run · ${failed} scenario${failed>1?'s':''} could not run${firstFailure ? `: ${firstFailure}` : ''}`
        : 'Plan updated · using available inputs');
      uiState.plansDirty = false;
    }catch(e){
      syncHeaderStatus(`Check plan: ${scenarioRunFailureMessage(e)}`);
      console.error(e);
    }
    btn.disabled=false; running=false;
  },20);
}

const GRID='var(--grid)', AXIS_INK='rgba(127,119,114,.72)';

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
const SEQ_YEARS = HISTORICAL_PERIODS.map(period => ({
  y: period.startYear,
  tag: period.name,
  c: period.tone,
  on: period.sequencingDefault,
}));

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
$('#run-btn').onclick=() => {
  if(canRunEngine()) runAll();
  else if(isHouseholdStorageBlocked()) renderBlockedRecoverySurfaces();
  else syncHeaderStatus('Select or create a household to run a plan');
};

const cashFlowController = createCashFlowController({
  getScenarios: () => scenarios,
  scenarioInputsByResult,
  selection: cashFlowPathSelection,
  saveSelection: saveCashFlowPathSelection,
  buildRows: buildSimulationRows,
});
const syncCashFlowPathControls = (scenario = null) => {
  cashFlowController.syncSelect($('#cashflow-path-mode'), scenario);
};

syncCashFlowPathControls();
$('#cashflow-path-mode').onchange=e=>{
  if(isHouseholdStorageBlocked()){
    syncCashFlowPathControls();
    renderBlockedRecoverySurfaces();
    return;
  }
  cashFlowController.setPathId(e.target.value, {
    persist: !isHouseholdStorageReadOnly(),
  });
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

  let _selectedId = null;

  const PROD = {
    scenarios:    () => scenarios,
    getSelectedId:() => _selectedId,
    setSelectedId:(id) => { _selectedId = id; },
    addScenario:  () => { addScenario(); },
    afterEngineAction: () => {},
    isTypicalPath:() => cashFlowController.isTypical(),
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
    cashFlowResult: (s) => cashFlowController.resultForScenario(s),
    typicalPathFederalTax: (s) => s.res && s.res.typicalPathFederalTax,
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
  
  

  function saveAndRunScenarioEdit() {
    saveScenarios();
    uiState.plansDirty = true;
    runAll();
  }

  // Lever step: reuses the EXISTING production mutation (LEVCFG/levRange/syncPension)
  // and immediately refreshes the saved scenario results.
  function stepFocusLever(ci, key, dir) {
    if(!guardPlanMutation()) return;
    const cfg = LEVCFG.find((c) => c.key === key); if (!cfg) return;
    const sc = scenarios[ci]; if (!sc || !sc.lev) return;
    const r = levRange(cfg), L = sc.lev;
    L[key] = Math.max(r.min, Math.min(r.max, (L[key] != null ? L[key] : r.min) + dir * r.step));
    if (key === 'pensionAge') L.pensionAuto = false;
    if (key === 'retireAge' && L.pensionAuto) syncPension(L);
    saveAndRunScenarioEdit();
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
    saveAndRunScenarioEdit();
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
      ov.endAge = Number(resolvedBase.endAge) >= 999 && v === hi ? resolvedBase.endAge : v;
    }
    // Minimize the override: drop any field that matches the base, and drop the
    // whole entry (and map) when nothing differs — keeps deltas/"same as base" honest.
    ['amount', 'startAge', 'endAge'].forEach((f) => { if (ov[f] != null && ov[f] === resolvedBase[f]) delete ov[f]; });
    if (ov.amount == null && ov.startAge == null && ov.endAge == null) delete sc.lev.goalOv[idx];
    if (sc.lev.goalOv && Object.keys(sc.lev.goalOv).length === 0) delete sc.lev.goalOv;
    saveAndRunScenarioEdit();
  }

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
      plan, planEndAge: resolveGoalSpan(plan).planEndAge,
      goalsExpandedState: state.goalsExpanded, esc, downTri: DOWN_TRI,
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
      cashFlowResult: PROD.cashFlowResult,
      cashFromRetirement: state.cashFromRetirement,
      isTypicalPath: PROD.isTypicalPath,
      typicalPathFederalTax: PROD.typicalPathFederalTax,
      pathFederalTax: () => null,
      wdColor, num:scenarioNum, esc, fmtMoney, cfCols: CF_COLS,
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
      mountPathControls(scn.raw);
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
    if (segC) { const on = !inCash && state.view === 'compare'; segC.classList.toggle('is-active', on); segC.classList.toggle('is-selected', on); segC.setAttribute('aria-selected', on ? 'true' : 'false'); }
    if (segF) { const on = !inCash && state.view === 'focus';   segF.classList.toggle('is-active', on); segF.classList.toggle('is-selected', on); segF.setAttribute('aria-selected', on ? 'true' : 'false'); }
    if (chip) { chip.classList.toggle('is-on', inCash); chip.classList.toggle('is-selected', inCash); chip.setAttribute('aria-checked', inCash ? 'true' : 'false'); }
  }

  // Relocate Cash Flow's independent path selector into the active view slot.
  // We move the node — never recreate it — so its bindings/state survive.
  function mountPathControls(scenario) {
    const slot = $id('scn-cf-path-controls');
    if (slot && window.scnCashPathControlsEl) slot.appendChild(window.scnCashPathControlsEl);
    syncCashFlowPathControls(scenario);
  }

  function bindViewEvents() {
    const view = $id('scn-view'); if (!view) return;
    view.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('click', () => { state.focusedId = el.dataset.pick; PROD.setSelectedId(state.focusedId); syncScenariosView(); });
    });
    const cashSelect = view.querySelector('[data-cash-select]');
    if (cashSelect) cashSelect.addEventListener('change', () => {
      state.focusedId = cashSelect.value;
      PROD.setSelectedId(state.focusedId);
      syncScenariosView();
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
      inp.addEventListener('blur', () => commitCmpInput(inp));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
      if (!inp.classList.contains('cmp-lev-in--age')) {
        inp.addEventListener('input', () => liveCommas(inp));
      }
    });
    // Per-scenario goal override inputs (amount / start / end) in expanded Compare.
    view.querySelectorAll('.cmp-goal-in').forEach((inp) => {
      inp.addEventListener('blur', () => commitGoalInput(inp));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
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
    const add = $id('scn-add');
    if (add)   add.addEventListener('click',   () => { PROD.addScenario(); PROD.afterEngineAction(); });
  }

  function init() {
    if (!document.getElementById('scn-view')) return;
    const src = document.querySelector('#scn-cash-path');
    if (src) window.scnCashPathControlsEl = src;
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

syncPathControls();
renderInputs();
bindHouseholdRailOnce();   // chapter rail (Demographics / Net Worth / Cash Flow) view switch
if(isHouseholdStorageBlocked()){
  renderBlockedRecoverySurfaces();
} else {
  syncHousehold();
}
if(canRunEngine()){
  refreshPathSeed();
  reseedScenarios({ markDirty: false });   // align baseline levers with hydrated plan (saved levers can be stale)
  runAll();   // first iteration runs immediately so the tool opens populated
}
document.body.classList.toggle('scn-active', document.querySelector('.page.on')?.dataset.page==='scenarios');
syncHeaderCluster();
syncRecoveryControls();

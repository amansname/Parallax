import { installScenariosView } from '../ui/scenariosController.js';
import { defaultLevers, syncPension, defaultScenarios, leversToOverrides, planForScenario, levRange, leverConfigs } from './scenarios/scenarioConfiguration.js';
import { normalizeHistoricalStrategy, computeHistoricalStress, retireNowClone } from './scenarios/historicalStress.js';
import { scenarioProjectionIssueMessage, scenarioRunFailureMessage } from './scenarios/projectionMessages.js';
import { insertGoalAt, removeGoalAt } from './goals/scenarioGoalOverrides.js';
import { liveCommas } from '../ui/moneyInput.js';
import { resolveInputs, generateReturnPath, resetSeed, pathDigest, PROJECTION_EXECUTION_LIMITS, defaultPlan as plan } from '../engine.js';
import { runFederalFundingSimulation } from './planning/tax/runMonteCarloWithFederalFunding.js';
import { runHistoricalPathWithFederalTax } from './planning/tax/runHistoricalPathWithFederalTax.js';
import { seqChartSvg } from '../ui/charts.js';
import { escHtml } from '../ui/dom.js';
import {
  DEFAULT_STARTUP_HOUSEHOLD_ID,
  SHIPPED_DEFAULT_HOUSEHOLD_IDS,
  createBlankHousehold,
  createSelectableDefaultHouseholds,
  getDefaultStartupHousehold,
} from '../ui/householdFactories.js';
import { bindHouseholdEditor } from './household/commit.js';
import {
  DELETE_HOUSEHOLD_FAILURE,
  deleteStoredHousehold,
} from './household/deleteHousehold.js';
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

import { createTaxBucketsController } from '../ui/taxBuckets.js';
import { drawSeqChart, renderPrints, syncPathControls } from '../ui/sequencing.js';
import { buildSimulationRows } from '../ui/cashflow.js';

import { createCashFlowController } from './scenarios/createCashFlowController.js';
import { HISTORICAL_PERIODS } from './scenarios/historicalPeriods.js';

import {
  baselineSnapshotForScenarios,
  withoutRemovedScenarioLevers,
} from './scenarios/scenarioLevers.js';
import { installDesignSystemPrimitives } from '../ui/designSystemPrimitives.js';
import { scenarios, sharedPaths, plansDirty, baseSnapshot, pathReplay, refreshPathSeed, cashFlowPathSelection, saveCashFlowPathSelection, uiState } from './state.js';
/* ╔══════════════════════════════════════════════════════════════╗
   ║  PARALLAX V2 — LEGACY COMPOSITION ROOT (UI + ENGINES)       ║
   ╚══════════════════════════════════════════════════════════════╝ */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
installDesignSystemPrimitives();
/* ── Household model: pure factories + multi-household persistence ──────────
   The app boots into the shipped Joe template. Saved households remain
   available for explicit selection, while browser state never chooses the
   startup record.

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
    '#hh-new','#hh-delete','#hh-view input','#hh-view select','#hh-view textarea','#hh-view .row-x','#hh-view [data-add]',
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
  activeHouseholdId = DEFAULT_STARTUP_HOUSEHOLD_ID;
  hydratePlan(getDefaultStartupHousehold(householdsDb));
  if(accountMigrationState.readOnly){
    syncRecoveryStatus(getReadOnlyMessage());
  }
}

// Scenario accent palette (SCEN_PALETTE / colorFor / BASE_ACCENT / scenAccent)
// was removed with the old band + cash-flow grid renderers that consumed it. The
// redesign keys scenario tone off engine success probability (toneForProb in the
// ScenariosUI view layer), not a fixed identity palette.
const MAX_SCENARIOS=5;

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
    const slim=scenarios.map(s=>({
      name:s.name,
      base:!!s.base,
      lev:withoutRemovedScenarioLevers(s.lev),
    }));
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
    return arr.map(s=>{
      const lev={...proto, ...withoutRemovedScenarioLevers(s.lev)};
      return { name:String(s.name||'Scenario'), base:!!s.base, lev, res:null };
    });
  }catch(e){ return null; }
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

// Seed/hydrate the shipped startup record BEFORE scenarios seed. Saved
// households remain available, but reload never grants browser state authority
// to choose one on localhost or the deployed origin.
bootstrapHouseholds();
if(isHouseholdStorageBlocked() || !activeHouseholdId){
  uiState.scenarios = [];
} else {
  uiState.scenarios = loadScenarios() || defaultScenarios();
}

uiState.baseSnapshot=baselineSnapshotForScenarios(defaultLevers(), scenarios);

// Re-seed scenarios from the current base, keeping each scenario's adjustment.
// Every plan edit funnels through here, then persists the plan and scenarios.
function reseedScenarios({ markDirty = true } = {}){
  if(markDirty ? !guardPlanMutation() : !guardHouseholdStorageMutation()) return;
  const nb=defaultLevers();
  const LINKED=['retireAge','spouseRetireAge','ssAge','spouseSsAge','spend','savings','pensionAge'];
  scenarios.forEach(s=>{
    Object.keys(nb).forEach(k=>{
      if(s.base){ s.lev[k]=nb[k]; return; }   // baseline always mirrors the base
      if(!LINKED.includes(k)) return;         // allocation / one-time event stay as set
      const cfg=leverConfigs().find(c=>c.key===k);
      const priorValue = Number(s.lev[k]);
      const priorBase = Number(baseSnapshot[k]);
      const priorDelta = Number.isFinite(priorValue) && Number.isFinite(priorBase)
        ? priorValue-priorBase
        : 0;
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
  canDeleteHousehold: id => Boolean(id && householdsDb[id] && !isRuntimeHousehold(id)),
  onSwitchHousehold: switchHousehold,
  onNewHousehold: newHousehold,
  onDeleteHousehold: deleteHousehold,
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
function deleteHousehold(id){
  if(!guardHouseholdStorageMutation()) return;
  if(!id || id !== activeHouseholdId || !householdsDb[id] || isRuntimeHousehold(id)) return;
  const name = householdsDb[id]?.meta?.name || householdsDb[id]?.meta?.primaryName || 'this household';
  if(!confirm(`Delete "${name}"? This permanently removes the household and its saved scenarios from this browser.`)) return;

  const result = deleteStoredHousehold({
    storage: householdStorage,
    householdId: id,
    protectedHouseholdIds: SHIPPED_DEFAULT_HOUSEHOLD_IDS,
    databaseKey: HHDB_KEY,
    activeHouseholdKey: ACTIVE_KEY,
    scenarioKey: scenKey(id),
  });
  if(!result.ok){
    if(result.reason === DELETE_HOUSEHOLD_FAILURE.ROLLBACK_FAILED){
      accountMigrationState = {
        ...accountMigrationState,
        blocked: true,
        readOnly: false,
        message: 'Household could not be deleted and related data could not be restored · reload before continuing',
      };
      syncRecoveryStatus(accountMigrationState.message);
      renderBlockedRecoverySurfaces();
    } else if(result.reason === DELETE_HOUSEHOLD_FAILURE.READ_FAILED){
      syncHeaderStatus('Household could not be deleted because saved data could not be read');
    } else {
      syncHeaderStatus('Household could not be deleted · saved data was restored');
    }
    return;
  }

  householdsDb = result.database;
  activeHouseholdId = null;
  const unselected = createBlankHousehold(PRISTINE_PLAN, '', new Date().getFullYear());
  unselected.meta.name = '';
  hydratePlan(unselected);
  uiState.scenarios = [];
  uiState.baseSnapshot = defaultLevers();
  planSaveDirty = false;
  saveFailed = false;
  hhLoadRecord('Household deleted');
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
  uiState.baseSnapshot = baselineSnapshotForScenarios(defaultLevers(), uiState.scenarios);
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
          const sharedTypicalIndex = scenarios.find(candidate => candidate.base)?.res?.paths?.p50?.simIndex;
          const taxOptions = {
            baseTaxYear,
            scenarioId: s.name,
            filingStatus: p.meta?.filingStatus,
            accountDiagnosticsSimIndices: !s.base && Number.isInteger(sharedTypicalIndex) ? [sharedTypicalIndex] : [],
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
  const ov2={...ov, retireDelay:0, initialShock:0}; // age and initial shock are already in the entry state
  const historicalTaxOptions={
    baseTaxYear:rp.meta?.planningAsOfYear ?? new Date().getFullYear(),
    filingStatus:rp.meta?.filingStatus,
    scenarioId:`sequencing_${s.name}`,
  };
  const runs=SEQ_YEARS.filter(m=>m.on)
                      .map(m=>({m, res:runHistoricalPathWithFederalTax(rp, m.y, strat, undefined, ov2, historicalTaxOptions)}))
                      .filter(r=>r.res && r.res.rows.length);
  if(!runs.length){ $('#seq-svg').innerHTML=''; $('#seq-prints').innerHTML=''; return; }
  drawSeqChart($('#seq-svg'), runs, rp.household.primary.currentAge, seqChartSvg, { grid:GRID, axisInk:AXIS_INK });
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
   through explicit dependencies; imported state retains live bindings.
   =========================================================================== */
installScenariosView({ addScenario, cashFlowController, saveScenarios, runAll, guardPlanMutation, isHouseholdStorageBlocked, renderBlockedRecoverySurfaces, syncRecoveryControls, syncCashFlowPathControls, removeScenario });

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

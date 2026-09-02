// Installs the existing Compare, Focus, and Cash Flow view layer once.
import { scenarios, uiState, scenariosUiState as state } from '../src/state.js';
import { defaultPlan as plan } from '../engine.js';
import { resolveGoalSpan, resolveEffectiveGoal, resolveScenarioHouseholdRetirementAge, goalHasFutureWorkingYears } from '../src/goals/horizonModel.js';
import { leverConfigs, levRange, syncPension } from '../src/scenarios/scenarioConfiguration.js';
import { num as scenarioNum, toneForProb, renderCompare, renderFocus, wdColor } from './scenarios.js';
import { STRESS_ERAS } from '../src/scenarios/historicalStress.js';
import { renderCashflow } from './cashflow.js';
import { liveCommas } from './moneyInput.js';
export function installScenariosView(dependencies) {
  'use strict';

  const {
    addScenario,
    cashFlowController,
    saveScenarios,
    runAll,
    guardPlanMutation,
    isHouseholdStorageBlocked,
    renderBlockedRecoverySurfaces,
    syncRecoveryControls,
    syncCashFlowPathControls,
    removeScenario
  } = dependencies;
  let _selectedId = null;
  const PROD = {
    scenarios: () => scenarios,
    getSelectedId: () => _selectedId,
    setSelectedId: id => {
      _selectedId = id;
    },
    addScenario: () => {
      addScenario();
    },
    afterEngineAction: () => {},
    isTypicalPath: () => cashFlowController.isTypical(),
    id: s => String(scenarios.indexOf(s)),
    name: s => s.name,
    prob: s => s.res && s.res.successRate,
    // Why this scenario has no probability. Without exposing it the view has no
    // way to say anything beyond a dash.
    error: s => s.runError || null,
    median: s => {
      const e = s.res && s.res.envelope;
      return e && e.length ? e[e.length - 1].p50 : null;
    },
    range: s => {
      const t = s.res && s.res.terminal;
      if (!t) return null;
      const e = s.res.envelope,
        p50 = e && e.length ? e[e.length - 1].p50 : t.p50 != null ? t.p50 : null;
      const lo = t.p10,
        hi = t.p90;
      const medianPct = lo != null && hi != null && hi > lo && p50 != null ? Math.max(0, Math.min(100, (p50 - lo) / (hi - lo) * 100)) : 50;
      return {
        lo,
        hi,
        medianPct
      };
    },
    viability: s => viabilityString(s),
    isBaseline: s => !!s.base,
    levers: s => leversFor(s),
    goals: s => goalsVM(s),
    stress: s => s.res && s.res.stress || [],
    // populated by computeHistoricalStress in runAll (engine-derived)
    cashFlowResult: s => cashFlowController.resultForScenario(s),
    typicalPathFederalTax: s => s.res && s.res.typicalPathFederalTax,
    householdName: () => plan.meta && (plan.meta.primaryName || plan.meta.household) || ''
  };

  /* ---- presentation helpers (formatting + color only) --------------------- */

  function fmtMoney(n) {
    if (n == null || !Number.isFinite(n) || n < 0) return '—';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    const p50Idx = s.res.paths && s.res.paths.p50 && s.res.paths.p50.simIndex != null ? s.res.paths.p50.simIndex : 0;
    const sim = (Array.isArray(s.res.sims) ? s.res.sims.find(x => x.simIndex === p50Idx) : null) || (Array.isArray(s.res.sims) ? s.res.sims[0] : null);
    if (!sim) return '';
    if (sim.failed && sim.depletionAge) {
      return 'Shortfall risk after age ' + sim.depletionAge;
    }
    return 'Funds last to age ' + planEnd;
  }

  /* ---- adapter helpers (production shapes → view-models) ------------------- */
  // Lever keys shown, in a stable order across all scenarios (so Compare aligns).
  function activeLeverKeys() {
    const anyEvent = (scenarios || []).some(s => s.lev && s.lev.eventAmt > 0);
    // Pension is removed from the Scenarios lever rows (per product ruling). The
    // engine still honors pension data from the plan; it is just not an editable
    // Scenarios lever. The one-time event row only appears when an event is set.
    // Each person's retirement input drops out once that person's retirement
    // decision is already behind them. The other spouse can remain editable.
    const client = plan.household.primary;
    const spouse = plan.household.spouse;
    return leverConfigs().map(c => c.key).filter(k => k !== 'pensionAge' && (k !== 'eventAmt' || anyEvent) && (k !== 'retireAge' || client.currentAge < client.retirementAge) && (k !== 'spouseRetireAge' || spouse && spouse.currentAge < spouse.retirementAge));
  }
  function leverDeltaText(cfg, lev, baseLev) {
    if (!baseLev || lev === baseLev) return null;
    if (cfg.control === 'select') return lev[cfg.key] === baseLev[cfg.key] ? null : 'Changed';
    const d = (lev[cfg.key] || 0) - (baseLev[cfg.key] || 0);
    if (!d) return null;
    const sign = d > 0 ? '+' : '−',
      a = Math.abs(d);
    if (cfg.key === 'spend') return sign + '$' + Math.round(a / 12).toLocaleString('en-US') + '/mo';
    if (cfg.key === 'savings' || cfg.key === 'eventAmt') return sign + '$' + a.toLocaleString('en-US');
    return sign + a + ' yr';
  }
  // Derive the prefilled input string for a dollar lever (no $ or unit).
  function editInputVal(cfg, lev) {
    if (cfg.edit === 'monthly') return Math.round((lev[cfg.key] || 0) / 12).toLocaleString('en-US');
    if (cfg.edit === 'event') return (lev.eventAmt || 0).toLocaleString('en-US');
    if (cfg.edit === 'money') return (lev[cfg.key] || 0).toLocaleString('en-US');
    return null;
  }
  function leversFor(s) {
    const base = (scenarios.find(x => x.base) || {}).lev;
    return activeLeverKeys().map(k => {
      const cfg = leverConfigs().find(c => c.key === k);
      if (!cfg) return null;
      const fv = cfg.fmt(s.lev[k], s.lev),
        val = fv[0],
        unit = fv[1];
      const value = val === '__needs__' ? '— @ ' + unit : val + (unit ? ' ' + unit : '');
      return {
        key: k,
        label: cfg.name,
        value: value,
        delta: leverDeltaText(cfg, s.lev, base),
        controlType: cfg.control || null,
        selectedValue: cfg.control === 'select' ? s.lev[k] : null,
        options: cfg.control === 'select' ? cfg.options : null,
        editType: cfg.edit || null,
        inputVal: editInputVal(cfg, s.lev),
        unitStr: unit || '',
        eventAge: cfg.edit === 'event' ? s.lev.eventAge != null ? s.lev.eventAge : '' : null
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
    return (Array.isArray(plan.goals) ? plan.goals : []).map((g, i) => ({
      g: g,
      i: i
    })).filter(r => (r.g.amount || 0) > 0);
  }
  // Per-scenario goals view-model: effective values + override/baseline-delta info.
  function goalsVM(s) {
    const ovMap = s && s.lev && s.lev.goalOv || {};
    const baseScn = scenarios.find(x => x.base);
    const baseOvMap = baseScn && baseScn.lev && baseScn.lev.goalOv || {};
    const planRetirementAge = plan.household.primary.retirementAge;
    const planSpouseRetirementAge = plan.household.spouse?.retirementAge;
    const planGoalSpan = resolveGoalSpan(plan);
    const scenarioRetirementAge = Number.isFinite(s?.lev?.retireAge) ? s.lev.retireAge : planRetirementAge;
    const baselineRetirementAge = Number.isFinite(baseScn?.lev?.retireAge) ? baseScn.lev.retireAge : planRetirementAge;
    const scenarioSpouseRetirementAge = Number.isFinite(s?.lev?.spouseRetireAge) ? s.lev.spouseRetireAge : planSpouseRetirementAge;
    const baselineSpouseRetirementAge = Number.isFinite(baseScn?.lev?.spouseRetireAge) ? baseScn.lev.spouseRetireAge : planSpouseRetirementAge;
    const scenarioHouseholdRetirementAge = resolveScenarioHouseholdRetirementAge(plan, scenarioRetirementAge, scenarioSpouseRetirementAge);
    const baselineHouseholdRetirementAge = resolveScenarioHouseholdRetirementAge(plan, baselineRetirementAge, baselineSpouseRetirementAge);
    return goalRowsBase().map(({
      g,
      i
    }) => {
      const e = effGoal(g, ovMap[i], scenarioHouseholdRetirementAge);
      const once = e.startAge === e.endAge;
      const scenarioGoalSpan = {
        currentAge: planGoalSpan.currentAge,
        retirementAge: scenarioHouseholdRetirementAge
      };
      const fundingNote = goalHasFutureWorkingYears(e, scenarioGoalSpan) ? g.fundFromPortfolioBeforeRetirement === true ? 'portfolio funded before retirement' : 'outside portfolio before retirement' : '';
      const ov = ovMap[i];
      const overridden = !!(ov && (ov.amount != null || ov.startAge != null || ov.endAge != null));
      // Δ vs the baseline scenario's effective values for this goal.
      const be = effGoal(g, baseOvMap[i], baselineHouseholdRetirementAge);
      const aDelta = (e.amount || 0) - (be.amount || 0);
      const sameAsBase = e.amount === be.amount && e.startAge === be.startAge && e.endAge === be.endAge;
      return {
        idx: i,
        name: g.name || 'Goal',
        meta: (once ? 'at age ' + e.startAge : 'age ' + e.startAge + '–' + e.endAge) + (fundingNote ? ' · ' + fundingNote : ''),
        amount: e.amount || 0,
        startAge: e.startAge,
        endAge: e.endAge,
        cadence: once ? 'one-time' : '/yr',
        once: once,
        fundingNote,
        on: (e.amount || 0) > 0,
        added: false,
        overridden: overridden,
        amountDelta: aDelta,
        sameAsBase: sameAsBase
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

  // Lever step: reuses the existing production mutation and immediately
  // refreshes the saved scenario results.
  function stepFocusLever(ci, key, dir) {
    if (!guardPlanMutation()) return;
    const cfg = leverConfigs().find(c => c.key === key);
    if (!cfg || cfg.control) return;
    const sc = scenarios[ci];
    if (!sc || !sc.lev) return;
    const r = levRange(cfg),
      L = sc.lev;
    L[key] = Math.max(r.min, Math.min(r.max, (L[key] != null ? L[key] : r.min) + dir * r.step));
    if (key === 'pensionAge') L.pensionAuto = false;
    if (key === 'retireAge' && L.pensionAuto) syncPension(L);
    saveAndRunScenarioEdit();
  }
  // Commit a typed value from a .cmp-lev-in input in the Compare view.
  // Mirrors the parse/clamp logic from the scenario lever edit contract.
  function commitCmpInput(inp) {
    if (!guardPlanMutation()) {
      syncScenariosView();
      return;
    }
    const ci = parseInt(inp.dataset.scnId, 10);
    const sc = scenarios[ci];
    if (!sc || !sc.lev) return;
    const L = sc.lev;
    const edit = inp.dataset.edit;
    const raw = parseFloat(String(inp.value).replace(/[^0-9.]/g, ''));
    if (!isFinite(raw) || raw < 0) return;
    if (edit === 'monthly') {
      L.spend = Math.round(raw * 12);
    } else if (edit === 'money') {
      const cfg = leverConfigs().find(c => c.key === inp.dataset.key);
      const r = cfg ? levRange(cfg) : null;
      const v = Math.round(raw);
      L[inp.dataset.key] = r ? Math.max(r.min, Math.min(r.max, v)) : v;
    } else if (edit === 'eventAmt') {
      L.eventAmt = raw > 0 ? Math.round(raw) : 0;
    } else if (edit === 'eventAge') {
      const lo = plan.household.primary.currentAge,
        hi = resolveGoalSpan(plan).planEndAge;
      const a = Math.round(raw);
      if (isFinite(a)) L.eventAge = Math.max(lo, Math.min(hi, a));
    }
    saveAndRunScenarioEdit();
  }
  function commitScenarioSelect(select) {
    if (!guardPlanMutation()) {
      syncScenariosView();
      return;
    }
    const ci = select.dataset.scnId != null && select.dataset.scnId !== '' ? parseInt(select.dataset.scnId, 10) : parseInt(state.focusedId, 10);
    const cfg = leverConfigs().find(candidate => candidate.key === select.dataset.leverKey && candidate.control === 'select');
    const sc = scenarios[ci];
    if (!cfg || !sc?.lev || !cfg.options.some(option => option.value === select.value)) {
      syncScenariosView();
      return;
    }
    sc.lev[cfg.key] = select.value;
    saveAndRunScenarioEdit();
  }
  // Commit a typed per-scenario GOAL override (amount / startAge / endAge / onceAge).
  // Writes into scenarios[ci].lev.goalOv[idx] — the base plan and other scenarios are
  // never touched. Fields equal to the base value are dropped so overrides stay minimal
  // and "same as Baseline" stays accurate.
  function commitGoalInput(inp) {
    if (!guardPlanMutation()) {
      syncScenariosView();
      return;
    }
    const ci = parseInt(inp.dataset.scnId, 10);
    const idx = parseInt(inp.dataset.goalIdx, 10);
    const field = inp.dataset.goalField;
    const sc = scenarios[ci];
    if (!sc || !sc.lev) return;
    const base = (Array.isArray(plan.goals) ? plan.goals : [])[idx];
    if (!base) return;
    const retirementAge = Number.isFinite(sc.lev.retireAge) ? sc.lev.retireAge : plan.household.primary.retirementAge;
    const spouseRetirementAge = Number.isFinite(sc.lev.spouseRetireAge) ? sc.lev.spouseRetireAge : plan.household.spouse?.retirementAge;
    const householdRetirementAge = resolveScenarioHouseholdRetirementAge(plan, retirementAge, spouseRetirementAge);
    const resolvedBase = effGoal(base, null, householdRetirementAge);
    const raw = parseFloat(String(inp.value).replace(/[^0-9.]/g, ''));
    if (!isFinite(raw) || raw < 0) return;
    const lo = plan.household.primary.currentAge,
      hi = resolveGoalSpan(plan).planEndAge;
    if (!sc.lev.goalOv) sc.lev.goalOv = {};
    const ov = sc.lev.goalOv[idx] || (sc.lev.goalOv[idx] = {});
    if (field === 'amount') {
      ov.amount = Math.round(raw);
    } else if (field === 'onceAge') {
      const v = Math.max(lo, Math.min(hi, Math.round(raw)));
      ov.startAge = v;
      ov.endAge = v;
    } else if (field === 'startAge') {
      let v = Math.max(lo, Math.min(hi, Math.round(raw)));
      const curEnd = ov.endAge != null ? ov.endAge : resolvedBase.endAge;
      if (v > curEnd) v = curEnd;
      ov.startAge = v;
    } else if (field === 'endAge') {
      let v = Math.max(lo, Math.min(hi, Math.round(raw)));
      const curStart = ov.startAge != null ? ov.startAge : resolvedBase.startAge;
      if (v < curStart) v = curStart;
      ov.endAge = Number(resolvedBase.endAge) >= 999 && v === hi ? resolvedBase.endAge : v;
    }
    // Minimize the override: drop any field that matches the base, and drop the
    // whole entry (and map) when nothing differs — keeps deltas/"same as base" honest.
    ['amount', 'startAge', 'endAge'].forEach(f => {
      if (ov[f] != null && ov[f] === resolvedBase[f]) delete ov[f];
    });
    if (ov.amount == null && ov.startAge == null && ov.endAge == null) delete sc.lev.goalOv[idx];
    if (sc.lev.goalOv && Object.keys(sc.lev.goalOv).length === 0) delete sc.lev.goalOv;
    saveAndRunScenarioEdit();
  }

  /* ---- adapter: production scenario → view-model -------------------------- */
  function vmScenario(s) {
    const prob = PROD.prob(s);
    const median = PROD.median(s);
    return {
      id: PROD.id(s),
      name: PROD.name(s),
      prob: prob,
      probStr: prob == null ? '—' : scenarioNum(prob, 1),
      error: PROD.error(s),
      tone: toneForProb(prob),
      median: median == null ? '—' : fmtMoney(median),
      isBaseline: PROD.isBaseline(s),
      levers: PROD.levers(s),
      goals: PROD.goals(s),
      range: PROD.range(s),
      viability: PROD.viability(s),
      stress: PROD.stress(s),
      raw: s
    };
  }

  /* ---- COMPARE ----------------------------------------------------------- */
  function renderCompareView(scns, baseline) {
    return renderCompare(scns, baseline, {
      plan,
      planEndAge: resolveGoalSpan(plan).planEndAge,
      goalsExpandedState: state.goalsExpanded,
      esc,
      downTri: DOWN_TRI
    });
  }

  /* ---- FOCUS ------------------------------------------------------------- */

  function renderFocusView(scns, baseline, focusedId, showRange) {
    return renderFocus(scns, baseline, focusedId, showRange, {
      esc,
      fmtMoney,
      checkIcon: CHECK,
      stressEraCount: STRESS_ERAS.length
    });
  }

  /* ---- CASH FLOW --------------------------------------------------------- */
  // Visible columns, exactly and in order. No Engine-tax / Federal-tax columns.
  const CF_COLS = ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending'];
  function renderCashflowView(scn, allScns) {
    return renderCashflow(scn, allScns, {
      cashFlowResult: PROD.cashFlowResult,
      cashFromRetirement: state.cashFromRetirement,
      isTypicalPath: PROD.isTypicalPath,
      typicalPathFederalTax: PROD.typicalPathFederalTax,
      pathFederalTax: () => null,
      wdColor,
      num: scenarioNum,
      esc,
      fmtMoney,
      cfCols: CF_COLS
    });
  }

  // Group rows into bands (presentation only — alternating shade at RMD age).

  /* ---- STATE + ONE AUTHORITATIVE SYNC ------------------------------------ */
  const $id = id => document.getElementById(id);
  function buildScenarios() {
    const list = (PROD.scenarios() || []).map(vmScenario);
    const baseline = list.find(s => s.isBaseline) || list[0] || null;
    if (state.focusedId == null || !list.some(s => s.id === state.focusedId)) {
      state.focusedId = PROD.getSelectedId() || list[0] && list[0].id || null;
    }
    return {
      list: list,
      baseline: baseline
    };
  }
  function syncScenariosView() {
    const view = $id('scn-view');
    if (!view) return;
    if (isHouseholdStorageBlocked()) {
      renderBlockedRecoverySurfaces();
      return;
    }
    const built = buildScenarios(),
      list = built.list,
      baseline = built.baseline;
    const sub = $id('scn-subtitle');
    if (sub) {
      const hh = PROD.householdName();
      sub.textContent = (hh ? hh + ' · ' : '') + list.length + ' plan' + (list.length === 1 ? '' : 's');
    }
    if (!list.length) {
      view.innerHTML = '<div class="scn-empty">Planning projections are unavailable until household storage is restored.</div>';
      syncToolbar();
      syncRecoveryControls();
      return;
    }
    if (state.cashActive) {
      const scn = list.find(s => s.id === state.focusedId) || baseline || list[0];
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
    const segC = $id('scn-seg-compare'),
      segF = $id('scn-seg-focus'),
      chip = $id('scn-cash-toggle');
    if (segC) {
      const on = !inCash && state.view === 'compare';
      segC.classList.toggle('is-active', on);
      segC.classList.toggle('is-selected', on);
      segC.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (segF) {
      const on = !inCash && state.view === 'focus';
      segF.classList.toggle('is-active', on);
      segF.classList.toggle('is-selected', on);
      segF.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (chip) {
      chip.classList.toggle('is-on', inCash);
      chip.classList.toggle('is-selected', inCash);
      chip.setAttribute('aria-checked', inCash ? 'true' : 'false');
    }
  }

  // Relocate Cash Flow's independent path selector into the active view slot.
  // We move the node — never recreate it — so its bindings/state survive.
  function mountPathControls(scenario) {
    const slot = $id('scn-cf-path-controls');
    if (slot && window.scnCashPathControlsEl) slot.appendChild(window.scnCashPathControlsEl);
    syncCashFlowPathControls(scenario);
  }
  function bindViewEvents() {
    const view = $id('scn-view');
    if (!view) return;
    view.querySelectorAll('[data-pick]').forEach(el => {
      el.addEventListener('click', () => {
        state.focusedId = el.dataset.pick;
        PROD.setSelectedId(state.focusedId);
        syncScenariosView();
      });
    });
    const cashSelect = view.querySelector('[data-cash-select]');
    if (cashSelect) cashSelect.addEventListener('change', () => {
      state.focusedId = cashSelect.value;
      PROD.setSelectedId(state.focusedId);
      syncScenariosView();
    });
    // "Start at retirement" — hide the working (accum) years in the cash-flow ledger.
    const retStart = view.querySelector('[data-cash-retstart]');
    if (retStart) retStart.addEventListener('click', () => {
      state.cashFromRetirement = !state.cashFromRetirement;
      syncScenariosView();
    });
    // Always-visible +/- buttons in Compare (discrete levers) and Focus (all levers).
    // data-lever-key + data-dir + optional data-scn-id → stepFocusLever.
    view.querySelectorAll('button[data-lever-key][data-dir]').forEach(el => {
      el.addEventListener('click', () => {
        const ci = el.dataset.scnId != null && el.dataset.scnId !== '' ? parseInt(el.dataset.scnId, 10) : parseInt(state.focusedId, 10);
        stepFocusLever(ci, el.dataset.leverKey, +el.dataset.dir);
        syncScenariosView();
      });
    });
    view.querySelectorAll('select[data-lever-key]').forEach(select => {
      select.addEventListener('change', () => commitScenarioSelect(select));
    });
    // Type-in inputs for dollar levers in Compare view.
    view.querySelectorAll('.cmp-lev-in').forEach(inp => {
      inp.addEventListener('blur', () => commitCmpInput(inp));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.blur();
        }
      });
      if (!inp.classList.contains('cmp-lev-in--age')) {
        inp.addEventListener('input', () => liveCommas(inp));
      }
    });
    // Per-scenario goal override inputs (amount / start / end) in expanded Compare.
    view.querySelectorAll('.cmp-goal-in').forEach(inp => {
      inp.addEventListener('blur', () => commitGoalInput(inp));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.blur();
        }
      });
      if (!inp.classList.contains('cmp-goal-in--age')) {
        inp.addEventListener('input', () => liveCommas(inp));
      }
    });
    // Goals section expand/collapse toggle (visible, stable chevron control).
    const goalsToggle = view.querySelector('[data-goals-toggle]');
    if (goalsToggle) {
      goalsToggle.addEventListener('click', () => {
        state.goalsExpanded = !state.goalsExpanded;
        syncScenariosView();
      });
      goalsToggle.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.goalsExpanded = !state.goalsExpanded;
          syncScenariosView();
        }
      });
    }
    // Per-scenario ⋯ menu in Compare heads: Rename (inline input) / Delete.
    // This is the "later pass" wiring promised when the old #scn-band grid was
    // retired — it drives the kept removeScenario() seam and saveScenarios().
    view.querySelectorAll('.scol__menu').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!guardPlanMutation()) {
          syncScenariosView();
          return;
        }
        const head = btn.closest('.scol__head--menu');
        if (!head) return;
        const wasOpen = !!head.querySelector('.scol__pop');
        closeScnMenus();
        if (wasOpen) return; // second click toggles closed
        const ci = parseInt(btn.dataset.scnId, 10);
        const s = scenarios[ci];
        if (!s || s.base) return;
        const pop = document.createElement('div');
        pop.className = 'scol__pop';
        pop.innerHTML = '<button class="scol__pop-item" type="button" data-act="rename">Rename</button>' + '<button class="scol__pop-item scol__pop-item--danger" type="button" data-act="delete">Delete plan</button>';
        head.appendChild(pop);
        pop.addEventListener('pointerdown', pe => pe.stopPropagation());
        pop.querySelector('[data-act="rename"]').addEventListener('click', pe => {
          pe.stopPropagation();
          closeScnMenus();
          startScnRename(head, ci);
        });
        pop.querySelector('[data-act="delete"]').addEventListener('click', pe => {
          pe.stopPropagation();
          const cur = scenarios[ci];
          if (!cur || cur.base) {
            closeScnMenus();
            return;
          }
          if (!confirm('Delete "' + cur.name + '"? Its levers and per-plan edits are removed.')) {
            closeScnMenus();
            return;
          }
          closeScnMenus();
          removeScenario(ci); // splice + saveScenarios + runAll → sync re-renders
        });
      });
    });
  }
  function closeScnMenus() {
    document.querySelectorAll('.scol__pop').forEach(p => p.remove());
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
      if (done) return;
      done = true;
      if (!guardPlanMutation()) {
        syncScenariosView();
        return;
      }
      const v = inp.value.trim();
      if (v && v !== s.name) {
        s.name = v;
        saveScenarios();
      }
      syncScenariosView();
    };
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      // Commit directly (not via blur() — blur is inert in unfocused tabs).
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        syncScenariosView();
      }
    });
    inp.focus();
    inp.select();
  }
  function bindToolbarOnce() {
    const segC = $id('scn-seg-compare'),
      segF = $id('scn-seg-focus'),
      chip = $id('scn-cash-toggle');
    if (segC) segC.addEventListener('click', () => {
      state.cashActive = false;
      state.view = 'compare';
      syncScenariosView();
    });
    if (segF) segF.addEventListener('click', () => {
      state.cashActive = false;
      state.view = 'focus';
      syncScenariosView();
    });
    if (chip) chip.addEventListener('click', () => {
      state.cashActive = !state.cashActive;
      syncScenariosView();
    });
    const add = $id('scn-add');
    if (add) add.addEventListener('click', () => {
      PROD.addScenario();
      PROD.afterEngineAction();
    });
  }
  function init() {
    if (!document.getElementById('scn-view')) return;
    const src = document.querySelector('#scn-cash-path');
    if (src) window.scnCashPathControlsEl = src;
    bindToolbarOnce();
    // One document-level closer for the ⋯ menus (bound once — init runs once).
    document.addEventListener('pointerdown', e => {
      if (e.target.closest && (e.target.closest('.scol__pop') || e.target.closest('.scol__menu'))) return;
      closeScnMenus();
    });
    syncScenariosView();
  }
  window.ScenariosUI = {
    sync: syncScenariosView,
    renderCompare: renderCompareView,
    renderFocus: renderFocusView,
    renderCashflow: renderCashflowView
  };
  init();
}

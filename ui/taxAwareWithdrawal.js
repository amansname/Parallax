import {
  applyAttribution,
  applyHoverColumns,
  applyIncomeFacts,
  applyResultView,
  applyToolbarState,
  cacheWithdrawalRefs,
  mountWithdrawalPlannerShell,
  paintLeverSync,
  updateSliderCaps,
} from './taxAwareWithdrawalDom.js';

export { renderTaxAwareWithdrawalView } from './taxAwareWithdrawalDom.js';

const ATTRIBUTION_DEBOUNCE_MS = 180;
const LEVER_KEYS = ['rothConversion', 'rothWithdrawal', 'qcd', 'deferredWithdrawal', 'taxableWithdrawal'];

const adapterPromise = import('../src/planning/taxBuckets/taxEngineAdapter.js');

function defaultLevers() {
  return {
    taxableWithdrawal: 0,
    deferredWithdrawal: 0,
    rothConversion: 0,
    rothWithdrawal: 0,
    qcd: 0,
  };
}

function defaultFacts(plan) {
  return {
    filingStatus: plan?.meta?.filingStatus ?? null,
    livedWithSpouse: false,
    socialSecurityBenefits: 0,
    wages: 0,
    otherIncome: 0,
  };
}

export function createTaxAwareWithdrawalController(deps) {
  if (typeof deps?.getPlan !== 'function') throw new TypeError('getPlan is required');

  let host = null;
  let refs = null;
  let adapter = null;
  let attTimer = null;
  let recomputeToken = 0;
  let shellReady = false;

  let taxYear = 2026;
  let levers = defaultLevers();
  let facts = defaultFacts(null);
  let caps = { taxable: null, traditional: null, roth: null };
  let result = null;
  let attribution = null;
  let hoverMark = null;

  async function getAdapter() {
    if (adapter) return adapter;
    adapter = await adapterPromise;
    return adapter;
  }

  function scheduleAttribution() {
    clearTimeout(attTimer);
    attTimer = setTimeout(async () => {
      const ad = await getAdapter();
      const plan = deps.getPlan();
      if (!ad || !plan || !facts.filingStatus || !refs) return;
      let next = null;
      try {
        next = await ad.attributeSleeves({
          plan,
          taxYear,
          facts: { ...facts },
          levers: { ...levers },
        });
      } catch (e) {
        next = { error: String(e.message || e) };
      }
      attribution = next;
      applyAttribution(refs, attribution, attribution);
    }, ATTRIBUTION_DEBOUNCE_MS);
  }

  async function recompute() {
    const token = ++recomputeToken;
    const ad = await getAdapter();
    const plan = deps.getPlan();
    if (!refs) return;
    if (!ad || !plan || !facts.filingStatus) {
      result = null;
      applyResultView(refs, { result, facts, taxYear, hoverMark });
      return;
    }
    let next = null;
    try {
      next = await ad.evaluateYear({
        plan,
        taxYear,
        facts: { ...facts },
        levers: { ...levers },
      });
    } catch (e) {
      next = { error: String(e.message || e) };
    }
    if (token !== recomputeToken) return;
    result = next;
    applyResultView(refs, { result, facts, taxYear, hoverMark });
    scheduleAttribution();
  }

  async function refreshCapsAndIncome() {
    const ad = await getAdapter();
    const plan = deps.getPlan();
    if (!plan || !refs) return;
    if (ad) {
      try { caps = await ad.sleeveBalances(plan); } catch (e) { /* keep prior caps */ }
    }
    updateSliderCaps(refs, caps);
    const preservedWages = facts.wages;
    const preservedFs = facts.filingStatus ?? plan.meta?.filingStatus ?? null;
    const preservedMfs = facts.livedWithSpouse;
    let inc = { socialSecurityBenefits: 0, otherIncome: 0, filingStatus: preservedFs };
    if (ad) {
      try { inc = await ad.householdIncome(plan, taxYear); } catch (e) { /* keep defaults */ }
    }
    facts = {
      filingStatus: preservedFs ?? inc.filingStatus,
      livedWithSpouse: preservedMfs,
      socialSecurityBenefits: inc.socialSecurityBenefits ?? 0,
      otherIncome: inc.otherIncome ?? 0,
      wages: preservedWages,
    };
    applyIncomeFacts(refs, facts);
    applyToolbarState(refs, { taxYear, facts });
    await recompute();
  }

  function ensureShell() {
    if (shellReady && refs) return;
    mountWithdrawalPlannerShell(host, { caps });
    refs = cacheWithdrawalRefs(host);
    updateSliderCaps(refs, caps);
    shellReady = true;
  }

  function setLever(key, raw) {
    const v = Number(raw);
    levers[key] = Number.isFinite(v) ? Math.max(0, v) : 0;
    paintLeverSync(refs, key, levers[key]);
    recompute();
  }

  function onInput(event) {
    const t = event.target;
    if (!(t instanceof HTMLElement) || !refs) return;
    const lever = t.getAttribute('data-taw-lever');
    if (lever && t instanceof HTMLInputElement) {
      setLever(lever, t.value);
      return;
    }
    if (t.matches('[data-taw-wages]') && t instanceof HTMLInputElement) {
      const stripped = String(t.value).replace(/[^0-9.]/g, '');
      facts = { ...facts, wages: Math.max(0, Number(stripped) || 0) };
      t.value = `$${facts.wages.toLocaleString('en-US')}`;
      applyIncomeFacts(refs, facts);
      recompute();
    }
  }

  function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn || !host?.contains(btn) || !refs) return;
    const fs = btn.getAttribute('data-taw-fs');
    if (fs) {
      facts = { ...facts, filingStatus: fs };
      applyToolbarState(refs, { taxYear, facts });
      refreshCapsAndIncome();
      return;
    }
    const year = btn.getAttribute('data-taw-year');
    if (year) {
      taxYear = Number(year);
      applyToolbarState(refs, { taxYear, facts });
      refreshCapsAndIncome();
      return;
    }
    const mfs = btn.getAttribute('data-taw-mfs');
    if (mfs) {
      facts = { ...facts, livedWithSpouse: mfs === 'together' };
      applyToolbarState(refs, { taxYear, facts });
      recompute();
    }
  }

  function onMarkEnter(event) {
    const mark = event.target.closest('[data-taw-mark]');
    if (!mark || !host?.contains(mark) || mark.hidden) return;
    const key = mark.getAttribute('data-taw-mark');
    if (!key) return;
    hoverMark = key;
    applyHoverColumns(refs, result, hoverMark);
  }

  function onMarkLeave(event) {
    const mark = event.target.closest('[data-taw-mark]');
    if (!mark || !host?.contains(mark)) return;
    const key = mark.getAttribute('data-taw-mark');
    if (hoverMark === key) {
      hoverMark = null;
      applyHoverColumns(refs, result, hoverMark);
    }
  }

  let listenersHost = null;

  function bindListeners(element) {
    if (listenersHost === element) return;
    listenersHost = element;
    element.addEventListener('input', onInput);
    element.addEventListener('click', onClick);
    element.addEventListener('mouseover', onMarkEnter);
    element.addEventListener('mouseout', onMarkLeave);
  }

  function bind(element) {
    if (!element) throw new TypeError('Tax-Aware Withdrawal mount is required');
    host = element;
    shellReady = false;
    refs = null;
    const plan = deps.getPlan();
    facts = defaultFacts(plan);
    taxYear = 2026;
    levers = defaultLevers();
    attribution = null;
    result = null;
    hoverMark = null;
    bindListeners(host);
    ensureShell();
    applyToolbarState(refs, { taxYear, facts });
    if (refs.attNote) {
      refs.attNote.textContent = 'Tax caused: order-independent Shapley split of line 24 across the three withdrawal sleeves.';
    }
    LEVER_KEYS.forEach(key => paintLeverSync(refs, key, levers[key]));
    refreshCapsAndIncome();
  }

  function sync() {
    if (!host) return;
    refreshCapsAndIncome();
  }

  return Object.freeze({ bind, sync });
}

import {
  applyAttribution,
  applyHoverColumns,
  applyIncomeFacts,
  applyResultView,
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
    livedWithSpouse: null,
    socialSecurityBenefits: 0,
    wages: 0,
    otherIncome: 0,
  };
}

export function createTaxAwareWithdrawalController(deps) {
  if (typeof deps?.getPlan !== 'function') throw new TypeError('getPlan is required');

  let host = null;
  let refs = null;
  let adapter = deps?.adapter ?? null;
  let attTimer = null;
  let recomputeToken = 0;
  let refreshToken = 0;
  let leverToken = 0;
  let leverQueue = Promise.resolve();
  let attributionToken = 0;
  let shellReady = false;

  let taxYear = 2026;
  let levers = defaultLevers();
  let facts = defaultFacts(null);
  let accountState = null;
  let activeHouseholdId = null;
  let activePlan = null;
  let result = null;
  let attribution = null;
  let hoverMark = null;

  async function getAdapter() {
    if (adapter) return adapter;
    try {
      adapter = await adapterPromise;
    } catch {
      adapter = null;
    }
    return adapter;
  }

  function invalidateComputedView({ clearCaps = false } = {}) {
    recomputeToken++;
    attributionToken++;
    clearTimeout(attTimer);
    attTimer = null;
    result = null;
    attribution = null;
    hoverMark = null;
    if (!refs) return;
    if (clearCaps) {
      accountState = null;
      updateSliderCaps(refs, null);
    }
    applyResultView(refs, { result: null, facts, taxYear, hoverMark: null });
    applyAttribution(refs, null, null);
  }

  function scheduleAttribution() {
    clearTimeout(attTimer);
    const token = ++attributionToken;
    const viewRefs = refs;
    const plan = deps.getPlan();
    const selectedTaxYear = taxYear;
    const factSnapshot = { ...facts };
    const leverSnapshot = { ...levers };
    if (!plan || !factSnapshot.filingStatus || !viewRefs) return;
    attTimer = setTimeout(async () => {
      attTimer = null;
      const ad = await getAdapter();
      if (
        token !== attributionToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
        || !ad
      ) return;
      let next = null;
      try {
        next = await ad.attributeSleeves({
          plan,
          taxYear: selectedTaxYear,
          facts: factSnapshot,
          levers: leverSnapshot,
        });
      } catch (e) {
        next = { error: String(e.message || e) };
      }
      if (
        token !== attributionToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
      ) return;
      attribution = next;
      applyAttribution(viewRefs, attribution, attribution);
    }, ATTRIBUTION_DEBOUNCE_MS);
  }

  async function recompute() {
    invalidateComputedView();
    const token = recomputeToken;
    const viewRefs = refs;
    const plan = deps.getPlan();
    const selectedTaxYear = taxYear;
    const factSnapshot = { ...facts };
    const leverSnapshot = { ...levers };
    const ad = await getAdapter();
    if (
      token !== recomputeToken
      || refs !== viewRefs
      || plan !== deps.getPlan()
      || !ad
      || !plan
      || !factSnapshot.filingStatus
    ) return;
    let next = null;
    try {
      next = await ad.evaluateYear({
        plan,
        taxYear: selectedTaxYear,
        facts: factSnapshot,
        levers: leverSnapshot,
      });
    } catch (e) {
      next = { error: String(e.message || e) };
    }
    if (
      token !== recomputeToken
      || refs !== viewRefs
      || plan !== deps.getPlan()
    ) return;
    result = next;
    applyResultView(viewRefs, {
      result,
      facts: factSnapshot,
      taxYear: selectedTaxYear,
      hoverMark,
    });
    scheduleAttribution();
  }

  async function refreshCapsAndIncome({ clearCaps = false } = {}) {
    const token = ++refreshToken;
    leverToken++;
    let releaseRefresh;
    leverQueue = new Promise(resolve => { releaseRefresh = resolve; });
    try {
      invalidateComputedView({ clearCaps });
      const viewRefs = refs;
      const plan = deps.getPlan();
      const selectedTaxYear = taxYear;
      const leverSnapshot = { ...levers };
      LEVER_KEYS.forEach(key => paintLeverSync(viewRefs, key, levers[key]));
      const ad = await getAdapter();
      if (
        token !== refreshToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
        || !plan
      ) return;
      let inc = {
        available: false,
        filingStatus: null,
        socialSecurityBenefits: null,
        otherIncome: null,
        wages: null,
      };
      if (ad) {
        try { inc = await ad.householdIncome(plan, selectedTaxYear); } catch (e) { /* keep defaults */ }
      }
      if (
        token !== refreshToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
      ) return;
      const nextFacts = {
        ...inc,
        filingStatus: inc.filingStatus ?? plan.meta?.filingStatus ?? null,
        livedWithSpouse: typeof inc.livedWithSpouse === 'boolean'
          ? inc.livedWithSpouse
          : null,
        socialSecurityBenefits: Number.isFinite(inc.socialSecurityBenefits)
          ? inc.socialSecurityBenefits
          : null,
        otherIncome: Number.isFinite(inc.otherIncome) ? inc.otherIncome : null,
        wages: Number.isFinite(inc.wages) ? inc.wages : null,
      };
      let nextAccountState = null;
      if (ad) {
        try {
          nextAccountState = await ad.withdrawalAccountState(
            plan,
            leverSnapshot,
            nextFacts
          );
        } catch (e) {
          nextAccountState = null;
        }
      }
      if (
        token !== refreshToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
      ) return;
      if (
        nextAccountState?.valid === false
        && Object.values(leverSnapshot).some(value => value > 0)
      ) {
        levers = defaultLevers();
        try {
          nextAccountState = await ad.withdrawalAccountState(plan, levers, nextFacts);
        } catch (e) {
          nextAccountState = null;
        }
        if (
          token !== refreshToken
          || refs !== viewRefs
          || plan !== deps.getPlan()
        ) return;
        LEVER_KEYS.forEach(key => paintLeverSync(viewRefs, key, levers[key]));
      }
      if (nextAccountState?.valid && nextAccountState.levers) {
        levers = { ...nextAccountState.levers };
        LEVER_KEYS.forEach(key => paintLeverSync(viewRefs, key, levers[key]));
      }
      accountState = nextAccountState;
      updateSliderCaps(viewRefs, accountState);
      facts = nextFacts;
      applyIncomeFacts(viewRefs, facts);
      await recompute();
    } finally {
      releaseRefresh();
    }
  }

  function ensureShell() {
    if (shellReady && refs) return;
    mountWithdrawalPlannerShell(host, { caps: accountState });
    refs = cacheWithdrawalRefs(host);
    updateSliderCaps(refs, accountState);
    shellReady = true;
  }

  function setLever(key, raw) {
    const token = leverToken;
    const requestedValue = Number(raw);
    const value = Number.isFinite(requestedValue)
      ? Math.max(0, requestedValue)
      : 0;
    const plan = deps.getPlan();
    const viewRefs = refs;
    paintLeverSync(viewRefs, key, value);
    const work = leverQueue.then(async () => {
      let ad = null;
      try {
        ad = await getAdapter();
      } catch (e) {
        ad = null;
      }
      if (
        token !== leverToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
        || !ad
        || !plan
        || !viewRefs
      ) return;
      let approval = null;
      try {
        approval = await ad.approveWithdrawalPlannerLeverChange(
          plan,
          { ...levers },
          key,
          value,
          { ...facts }
        );
      } catch (e) {
        approval = null;
      }
      if (
        token !== leverToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
      ) return;
      if (approval?.state && approval?.levers) {
        levers = { ...approval.levers };
        accountState = approval.state;
      } else {
        try {
          accountState = await ad.withdrawalAccountState(plan, levers, facts);
        } catch (e) {
          accountState = null;
        }
      }
      if (
        token !== leverToken
        || refs !== viewRefs
        || plan !== deps.getPlan()
      ) return;
      LEVER_KEYS.forEach(leverKey => paintLeverSync(viewRefs, leverKey, levers[leverKey]));
      updateSliderCaps(viewRefs, accountState);
      recompute();
    });
    leverQueue = work.catch(() => {});
    return leverQueue;
  }

  function onInput(event) {
    const t = event.target;
    if (!(t instanceof HTMLElement) || !refs) return;
    const lever = t.getAttribute('data-taw-lever');
    if (lever && t instanceof HTMLInputElement) {
      setLever(lever, t.value);
      return;
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
    element.addEventListener('mouseover', onMarkEnter);
    element.addEventListener('mouseout', onMarkLeave);
  }

  function bind(element) {
    if (!element) throw new TypeError('Tax-Aware Withdrawal mount is required');
    host = element;
    shellReady = false;
    refs = null;
    const plan = deps.getPlan();
    refreshToken++;
    leverToken++;
    leverQueue = Promise.resolve();
    recomputeToken++;
    attributionToken++;
    clearTimeout(attTimer);
    attTimer = null;
    activeHouseholdId = plan?.meta?.householdId ?? null;
    activePlan = plan;
    facts = defaultFacts(plan);
    taxYear = Number.isInteger(plan?.incomeTax?.current1040?.taxYear)
      ? plan.incomeTax.current1040.taxYear
      : (Number.isInteger(plan?.meta?.planningAsOfYear)
        ? plan.meta.planningAsOfYear
        : 2026);
    levers = defaultLevers();
    accountState = null;
    attribution = null;
    result = null;
    hoverMark = null;
    bindListeners(host);
    ensureShell();
    LEVER_KEYS.forEach(key => paintLeverSync(refs, key, levers[key]));
    refreshCapsAndIncome({ clearCaps: true });
  }

  function sync() {
    if (!host) return;
    const plan = deps.getPlan();
    const nextTaxYear = Number.isInteger(plan?.incomeTax?.current1040?.taxYear)
      ? plan.incomeTax.current1040.taxYear
      : (Number.isInteger(plan?.meta?.planningAsOfYear)
        ? plan.meta.planningAsOfYear
        : 2026);
    const nextHouseholdId = plan?.meta?.householdId ?? null;
    const householdChanged = nextHouseholdId !== null
      ? nextHouseholdId !== activeHouseholdId
      : plan !== activePlan;
    if (householdChanged) {
      refreshToken++;
      leverToken++;
      leverQueue = Promise.resolve();
      recomputeToken++;
      activeHouseholdId = nextHouseholdId;
      activePlan = plan;
      taxYear = nextTaxYear;
      levers = defaultLevers();
      facts = defaultFacts(plan);
      accountState = null;
      attribution = null;
      result = null;
      hoverMark = null;
      invalidateComputedView({ clearCaps: true });
      LEVER_KEYS.forEach(key => paintLeverSync(refs, key, levers[key]));
      applyAttribution(refs, null, null);
    } else {
      activePlan = plan;
      taxYear = nextTaxYear;
    }
    refreshCapsAndIncome({ clearCaps: householdChanged });
  }

  return Object.freeze({ bind, sync });
}

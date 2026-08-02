import { escHtml } from './dom.js';
import {
  buildThresholdColumns,
  formatWithdrawalMoney,
} from './taxAwareWithdrawalColumns.js';
import {
  createWithdrawalPlannerUiState,
  patchWithdrawalPlannerUiState,
} from '../src/planning/taxBuckets/withdrawalPlannerUiState.js';

const SLIDER_MAX = 500000;
const ATTRIBUTION_DEBOUNCE_MS = 180;

const FS_OPTIONS = Object.freeze([
  { id: 'single', label: 'Single', value: 'single' },
  { id: 'mfj', label: 'MFJ', value: 'marriedFilingJointly' },
  { id: 'hoh', label: 'HoH', value: 'headOfHousehold' },
  { id: 'mfs', label: 'MFS', value: 'marriedFilingSeparately' },
]);

function capFor(balance) {
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance <= 0) return 0;
  return Math.min(balance, SLIDER_MAX);
}

function attOf(attribution, bucket) {
  if (!attribution || attribution.error || !attribution.byBucket) return '—';
  const v = attribution.byBucket[bucket];
  return typeof v === 'number' && Number.isFinite(v) ? formatWithdrawalMoney(v) : '—';
}

function attributionNote(attribution) {
  if (!attribution) {
    return 'Tax caused: order-independent Shapley split of line 24 across the three withdrawal sleeves.';
  }
  if (attribution.error) return `Attribution unavailable: ${attribution.error}`;
  if (!attribution.byBucket) return 'Tax caused: order-independent Shapley split of line 24 across the three withdrawal sleeves.';
  return `Tax caused = exact three-bucket Shapley split of Form 1040 line 24 (${formatWithdrawalMoney(attribution.incrementalTax)} incremental). Conversion and QCD held fixed in every coalition.`;
}

function renderColumn(col) {
  const marks = col.marks.map(mk => `
    <div class="taw-mark" data-taw-mark="${escHtml(mk.key)}" style="bottom:${mk.hit}">
      <div class="taw-mark-tick taw-mark-tick--l" style="width:${mk.tickW};background:${mk.bg}"></div>
      <div class="taw-mark-tick taw-mark-tick--r" style="width:${mk.tickW};background:${mk.bg}"></div>
      <span class="taw-mark-chip" style="color:${mk.chipInk};opacity:${mk.chipOpacity}">${escHtml(mk.label)}</span>
    </div>`).join('');
  return `
    <div class="taw-col" data-taw-col="${escHtml(col.id)}">
      <div class="taw-col-name">${escHtml(col.name)}</div>
      <div class="taw-col-rate" style="color:${col.tone}">${escHtml(col.current)}</div>
      <div class="taw-col-bar">
        <div class="taw-col-base" style="height:${col.base};background:${col.baseBg}"></div>
        <div class="taw-col-fill" style="bottom:${col.base};height:${col.fill};background:${col.fillBg}"></div>
        <div class="taw-col-gap" style="bottom:${col.top};height:${col.gap}"></div>
        ${marks}
        <div class="taw-col-edge" style="bottom:${col.top};background:${col.edge}">
          <span>${escHtml(col.value)}</span>
        </div>
      </div>
      <div class="taw-col-foot">
        <span class="taw-col-foot-label">${escHtml(col.footLabel)}</span>
        <span class="taw-col-foot-val">${escHtml(col.foot)}</span>
      </div>
    </div>`;
}

function renderSegmented(options, activeValue, dataAttr) {
  return `<span class="taw-seg" role="group">${options.map(opt => {
    const on = opt.value === activeValue;
    return `<button type="button" class="taw-seg-btn${on ? ' is-on' : ''}" data-${dataAttr}="${escHtml(opt.value)}">${escHtml(opt.label)}</button>`;
  }).join('')}</span>`;
}

function renderSliderRow({ label, leverKey, value, cap, taxCaused }) {
  const caused = taxCaused
    ? `<div class="taw-tax-caused"><span>Tax caused</span><span>${escHtml(taxCaused)}</span></div>`
    : '';
  return `
    <div class="taw-slider-block">
      <div class="taw-slider-head">
        <span class="taw-slider-label">${escHtml(label)}</span>
        <span class="taw-slider-val">${escHtml(formatWithdrawalMoney(value))}</span>
      </div>
      <input type="range" class="taw-range" min="0" max="${cap}" step="500"
        value="${value}" data-taw-lever="${escHtml(leverKey)}" aria-label="${escHtml(label)}">
      ${caused}
    </div>`;
}

export function renderTaxAwareWithdrawalView(state) {
  const F = state.facts;
  const L = state.levers;
  const caps = state.caps || {};
  const columns = buildThresholdColumns({ result: state.result, hoverMark: state.hoverMark });
  const lawVersion = state.result?.lawVersion ? String(state.result.lawVersion) : '—';
  const baselineTotal = (F.socialSecurityBenefits || 0) + (F.wages || 0) + (F.otherIncome || 0);
  const wagesText = `$${(F.wages || 0).toLocaleString('en-US')}`;
  const mfs = F.filingStatus === 'marriedFilingSeparately';
  const att = state.attribution;

  const capTaxable = capFor(caps.taxable);
  const capTrad = capFor(caps.traditional);
  const capRoth = capFor(caps.roth);

  const yearSeg = renderSegmented([
    { label: '2025', value: 2025 },
    { label: '2026', value: 2026 },
  ], state.taxYear, 'taw-year');

  const fsSeg = renderSegmented(FS_OPTIONS, F.filingStatus, 'taw-fs');

  const mfsSeg = mfs ? renderSegmented([
    { label: 'Lived apart', value: 'apart' },
    { label: 'Lived together', value: 'together' },
  ], F.livedWithSpouse ? 'together' : 'apart', 'taw-mfs') : '';

  return `
    <div class="taw-root" data-taw-root>
      <div class="taw-toolbar">
        <div class="taw-toolbar-controls">
          ${fsSeg}
          ${mfsSeg}
          ${yearSeg}
        </div>
        <div class="taw-law" aria-label="Tax law version">${escHtml(lawVersion)}</div>
      </div>
      <div class="taw-grid">
        <div class="taw-left">
          <div class="taw-card taw-card--inputs">
            <div class="taw-income-wash">
              <div class="taw-income-head">
                <span>Fixed income sources</span>
                <span>${escHtml(formatWithdrawalMoney(baselineTotal))}</span>
              </div>
              <div class="taw-income-row"><span>Social Security</span><span>${escHtml(formatWithdrawalMoney(F.socialSecurityBenefits))}</span></div>
              <div class="taw-income-row">
                <span>Wages</span>
                <input class="taw-wages" type="text" inputmode="numeric" value="${escHtml(wagesText)}" data-taw-wages aria-label="Wages">
              </div>
              <div class="taw-income-row"><span>Other income</span><span>${escHtml(formatWithdrawalMoney(F.otherIncome))}</span></div>
            </div>
            <div class="taw-divider"></div>
            <div class="taw-sliders">
              ${renderSliderRow({ label: 'Roth conversion', leverKey: 'rothConversion', value: L.rothConversion, cap: capTrad })}
              ${renderSliderRow({ label: 'Roth IRA', leverKey: 'rothWithdrawal', value: L.rothWithdrawal, cap: capRoth, taxCaused: attOf(att, 'roth') })}
              ${renderSliderRow({ label: 'Qualified Charitable Donations', leverKey: 'qcd', value: L.qcd, cap: capTrad })}
              ${renderSliderRow({ label: 'IRA', leverKey: 'deferredWithdrawal', value: L.deferredWithdrawal, cap: capTrad, taxCaused: attOf(att, 'traditional') })}
              ${renderSliderRow({ label: 'Brokerage account', leverKey: 'taxableWithdrawal', value: L.taxableWithdrawal, cap: capTaxable, taxCaused: attOf(att, 'taxable') })}
            </div>
            <p class="taw-att-note">${escHtml(attributionNote(att))}</p>
          </div>
        </div>
        <div class="taw-card taw-card--thresholds">
          <div class="taw-thresholds-head">
            <span>Thresholds</span>
          </div>
          <div class="taw-cols">${columns.map(renderColumn).join('')}</div>
        </div>
      </div>
    </div>`;
}

export function createTaxAwareWithdrawalController(deps) {
  if (typeof deps?.getPlan !== 'function') throw new TypeError('getPlan is required');

  let root = null;
  let ui = createWithdrawalPlannerUiState(null);
  let adapter = null;
  let attTimer = null;
  let recomputeToken = 0;
  let stateInitialized = false;

  function bindListeners(element) {
    if (root === element) return;
    root = element;
    element.addEventListener('input', onInput);
    element.addEventListener('click', onClick);
    element.addEventListener('mouseover', onMarkEnter);
    element.addEventListener('mouseout', onMarkLeave);
  }

  async function ensureAdapter() {
    if (adapter) return adapter;
    try {
      adapter = await import('../src/planning/taxBuckets/taxEngineAdapter.js');
      ui = patchWithdrawalPlannerUiState(ui, { adapterReady: true, adapterError: null });
    } catch (e) {
      ui = patchWithdrawalPlannerUiState(ui, { adapterReady: false, adapterError: String(e.message || e) });
      adapter = null;
    }
    return adapter;
  }

  function paint() {
    if (!root) return;
    root.innerHTML = renderTaxAwareWithdrawalView(ui);
  }

  function scheduleAttribution() {
    clearTimeout(attTimer);
    attTimer = setTimeout(async () => {
      const ad = await ensureAdapter();
      const plan = deps.getPlan();
      if (!ad || !plan || !ui.facts.filingStatus) return;
      let attribution = null;
      try {
        attribution = await ad.attributeSleeves({
          plan,
          taxYear: ui.taxYear,
          facts: { ...ui.facts },
          levers: { ...ui.levers },
        });
      } catch (e) {
        attribution = { error: String(e.message || e) };
      }
      ui = patchWithdrawalPlannerUiState(ui, { attribution });
      paint();
    }, ATTRIBUTION_DEBOUNCE_MS);
  }

  async function recompute() {
    const token = ++recomputeToken;
    const ad = await ensureAdapter();
    const plan = deps.getPlan();
    if (!ad || !plan || !ui.facts.filingStatus) {
      ui = patchWithdrawalPlannerUiState(ui, { result: null });
      paint();
      return;
    }
    let result = null;
    try {
      result = await ad.evaluateYear({
        plan,
        taxYear: ui.taxYear,
        facts: { ...ui.facts },
        levers: { ...ui.levers },
      });
    } catch (e) {
      result = { error: String(e.message || e) };
    }
    if (token !== recomputeToken) return;
    ui = patchWithdrawalPlannerUiState(ui, { result });
    paint();
    scheduleAttribution();
  }

  async function refreshCapsAndIncome() {
    const ad = await ensureAdapter();
    const plan = deps.getPlan();
    if (!plan) {
      ui = patchWithdrawalPlannerUiState(ui, { caps: { taxable: null, traditional: null, roth: null } });
      await recompute();
      return;
    }
    let caps = { taxable: null, traditional: null, roth: null };
    if (ad) {
      try { caps = await ad.sleeveBalances(plan); } catch (e) { /* keep null caps */ }
    }
    const preservedWages = ui.facts.wages;
    const preservedFs = ui.facts.filingStatus ?? plan.meta?.filingStatus ?? null;
    const preservedMfs = ui.facts.livedWithSpouse;
    let inc = { socialSecurityBenefits: 0, otherIncome: 0, filingStatus: preservedFs };
    if (ad) {
      try {
        const fromPlan = await ad.householdIncome(plan, ui.taxYear);
        inc = fromPlan;
      } catch (e) { /* use defaults */ }
    }
    ui = patchWithdrawalPlannerUiState(ui, {
      caps,
      facts: {
        filingStatus: preservedFs ?? inc.filingStatus,
        livedWithSpouse: preservedMfs,
        socialSecurityBenefits: inc.socialSecurityBenefits ?? 0,
        otherIncome: inc.otherIncome ?? 0,
        wages: preservedWages,
      },
    });
    await recompute();
  }

  function setLever(key, raw) {
    const v = Number(raw);
    const next = Number.isFinite(v) ? Math.max(0, v) : 0;
    ui = patchWithdrawalPlannerUiState(ui, { levers: { [key]: next } });
    paint();
    recompute();
  }

  function onInput(event) {
    const t = event.target;
    if (!(t instanceof HTMLElement)) return;
    const lever = t.getAttribute('data-taw-lever');
    if (lever && t instanceof HTMLInputElement) {
      setLever(lever, t.value);
      return;
    }
    if (t.matches('[data-taw-wages]') && t instanceof HTMLInputElement) {
      const stripped = String(t.value).replace(/[^0-9.]/g, '');
      const wages = Math.max(0, Number(stripped) || 0);
      ui = patchWithdrawalPlannerUiState(ui, { facts: { wages } });
      t.value = `$${wages.toLocaleString('en-US')}`;
      recompute();
      return;
    }
  }

  function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn || !root?.contains(btn)) return;
    const fs = btn.getAttribute('data-taw-fs');
    if (fs) {
      ui = patchWithdrawalPlannerUiState(ui, { facts: { filingStatus: fs } });
      paint();
      refreshCapsAndIncome();
      return;
    }
    const year = btn.getAttribute('data-taw-year');
    if (year) {
      ui = patchWithdrawalPlannerUiState(ui, { taxYear: Number(year) });
      paint();
      refreshCapsAndIncome();
      return;
    }
    const mfs = btn.getAttribute('data-taw-mfs');
    if (mfs) {
      ui = patchWithdrawalPlannerUiState(ui, { facts: { livedWithSpouse: mfs === 'together' } });
      paint();
      recompute();
    }
  }

  function onMarkEnter(event) {
    const mark = event.target.closest('[data-taw-mark]');
    if (!mark || !root?.contains(mark)) return;
    const key = mark.getAttribute('data-taw-mark');
    if (!key) return;
    ui = patchWithdrawalPlannerUiState(ui, { hoverMark: key });
    paint();
  }

  function onMarkLeave(event) {
    const mark = event.target.closest('[data-taw-mark]');
    if (!mark || !root?.contains(mark)) return;
    const key = mark.getAttribute('data-taw-mark');
    if (ui.hoverMark === key) {
      ui = patchWithdrawalPlannerUiState(ui, { hoverMark: null });
      paint();
    }
  }

  function bind(element) {
    if (!element) throw new TypeError('Tax-Aware Withdrawal mount is required');
    bindListeners(element);
    if (!stateInitialized) {
      const plan = deps.getPlan();
      ui = patchWithdrawalPlannerUiState(createWithdrawalPlannerUiState(plan?.meta?.filingStatus ?? null), {
        facts: {
          filingStatus: plan?.meta?.filingStatus ?? null,
        },
      });
      stateInitialized = true;
      paint();
      refreshCapsAndIncome();
      return;
    }
    paint();
  }

  function sync() {
    if (!root) return;
    refreshCapsAndIncome();
  }

  return Object.freeze({ bind, sync });
}

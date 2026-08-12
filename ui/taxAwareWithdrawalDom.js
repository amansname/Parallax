import { escHtml } from './dom.js';
import {
  buildThresholdColumns,
  formatWithdrawalMoney,
  formatWithdrawalPct,
} from './taxAwareWithdrawalColumns.js';

const MAX_MARKS = 10;
const COLUMN_IDS = ['ord', 'ltcg', 'irmaa', 'ss'];
const COLUMN_NAMES = {
  ord: 'Income Tax',
  ltcg: 'Long-term gains',
  irmaa: 'Medicare IRMAA',
  ss: 'Social Security',
};

const SLIDER_DEFS = [
  { key: 'rothConversion', label: 'Roth conversion', caused: false },
  { key: 'rothWithdrawal', label: 'Roth IRA', caused: 'roth' },
  { key: 'qcd', label: 'Qualified Charitable Donations', caused: false },
  { key: 'deferredWithdrawal', label: 'IRA', caused: 'traditional' },
  { key: 'realizedGain', label: 'Realized gain', caused: 'taxable' },
];

function markSlotHtml(colId, index) {
  return `
    <div class="taw-mark" data-taw-mark="" data-taw-col-id="${colId}" data-taw-mark-idx="${index}" hidden>
      <div class="taw-mark-tick taw-mark-tick--l"></div>
      <div class="taw-mark-tick taw-mark-tick--r"></div>
      <span class="taw-mark-chip"></span>
    </div>`;
}

function columnShell(id, name) {
  const marks = Array.from({ length: MAX_MARKS }, (_, i) => markSlotHtml(id, i)).join('');
  return `
    <div class="taw-col" data-taw-col="${id}">
      <div class="taw-col-name">${escHtml(name)}</div>
      <div class="taw-col-rate"></div>
      <div class="taw-col-bar">
        <div class="taw-col-base"></div>
        <div class="taw-col-fill"></div>
        <div class="taw-col-gap"></div>
        ${marks}
        <div class="taw-col-edge"><span></span></div>
      </div>
      <div class="taw-col-foot">
        <span class="taw-col-foot-label"></span>
        <span class="taw-col-foot-val"></span>
      </div>
    </div>`;
}

/** One-time DOM shell; subsequent updates use cached refs only. */
export function mountWithdrawalPlannerShell(root, { caps }) {
  const limits = caps?.limits;
  const capByKey = limits ? {
    rothConversion: capFor(limits.rothConversion?.max),
    rothWithdrawal: capFor(limits.rothWithdrawal?.max),
    qcd: capFor(limits.qcd?.max),
    deferredWithdrawal: capFor(limits.deferredWithdrawal?.max),
    realizedGain: capFor(limits.realizedGain?.max),
  } : {
    rothConversion: capFor(caps?.traditional),
    rothWithdrawal: capFor(caps?.roth),
    qcd: capFor(caps?.traditional),
    deferredWithdrawal: capFor(caps?.traditional),
    realizedGain: capFor(caps?.taxable),
  };

  const slidersHtml = SLIDER_DEFS.map(({ key, label, caused }) => {
    const cap = capByKey[key];
    const causedHtml = caused
      ? `<span class="taw-tax-caused" data-taw-caused="${caused}">Tax caused <span data-taw-caused-val>\u2014</span></span>`
      : '';
    return `
      <div class="taw-slider-block" data-taw-slider="${key}">
        <div class="taw-slider-head">
          <span class="taw-slider-label">${escHtml(label)}</span>
          <span class="taw-slider-meta">
            ${causedHtml}
            <span class="taw-slider-val" data-taw-slider-val="${key}">$0</span>
          </span>
        </div>
        <input type="range" class="taw-range" min="0" max="${cap}" step="500" value="0"
          data-taw-lever="${key}" aria-label="${escHtml(label)}">
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="taw-root" data-taw-root aria-busy="true"
      data-taw-render-revision="0" data-taw-household-id="">
      <div class="taw-grid">
        <div class="taw-left">
          <div class="taw-card--inputs">
            <div class="taw-income-list">
              <div class="taw-income-heading">Fixed income sources</div>
              <div class="taw-income-row"><span>Social Security</span><span data-taw-fact-ss>$0</span></div>
              <div class="taw-income-row">
                <span>Wages</span>
                <span data-taw-fact-wages>$0</span>
              </div>
              <div class="taw-income-row"><span>Other income</span><span data-taw-fact-other>$0</span></div>
              <div class="taw-income-total">
                <span>Total</span>
                <span data-taw-baseline-total>$0</span>
              </div>
            </div>
            <div class="taw-divider"></div>
            <div class="taw-sliders">${slidersHtml}</div>
            <div class="taw-rate-summary">
              <div><span>Effective rate</span><span data-taw-effective-rate>\u2014</span></div>
              <div><span>Marginal rate</span><span data-taw-marginal-rate>\u2014</span></div>
            </div>
          </div>
        </div>
        <div class="taw-card taw-card--thresholds">
          <div class="taw-thresholds-head">
            <span>Thresholds</span>
            <span class="taw-federal-tax">Federal tax <span data-taw-federal-tax>\u2014</span></span>
          </div>
          <div class="taw-cols">${COLUMN_IDS.map(id => columnShell(id, COLUMN_NAMES[id])).join('')}</div>
        </div>
      </div>
    </div>`;

  return cacheWithdrawalRefs(root);
}

function capFor(balance) {
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance <= 0) return 0;
  return Math.min(balance, 500_000);
}

export function cacheWithdrawalRefs(root) {
  const sliders = {};
  SLIDER_DEFS.forEach(({ key }) => {
    sliders[key] = {
      input: root.querySelector(`[data-taw-lever="${key}"]`),
      val: root.querySelector(`[data-taw-slider-val="${key}"]`),
    };
  });
  const columns = {};
  COLUMN_IDS.forEach(id => {
    const col = root.querySelector(`[data-taw-col="${id}"]`);
    const marks = [...col.querySelectorAll('.taw-mark')];
    columns[id] = {
      root: col,
      rate: col.querySelector('.taw-col-rate'),
      footLabel: col.querySelector('.taw-col-foot-label'),
      footVal: col.querySelector('.taw-col-foot-val'),
      base: col.querySelector('.taw-col-base'),
      fill: col.querySelector('.taw-col-fill'),
      gap: col.querySelector('.taw-col-gap'),
      edge: col.querySelector('.taw-col-edge'),
      edgeVal: col.querySelector('.taw-col-edge span'),
      marks,
    };
  });
  return {
    root,
    tawRoot: root.querySelector('[data-taw-root]'),
    baselineTotal: root.querySelector('[data-taw-baseline-total]'),
    factSs: root.querySelector('[data-taw-fact-ss]'),
    factOther: root.querySelector('[data-taw-fact-other]'),
    factWages: root.querySelector('[data-taw-fact-wages]'),
    federalTax: root.querySelector('[data-taw-federal-tax]'),
    effectiveRate: root.querySelector('[data-taw-effective-rate]'),
    marginalRate: root.querySelector('[data-taw-marginal-rate]'),
    taxCaused: {
      roth: root.querySelector('[data-taw-caused="roth"] [data-taw-caused-val]'),
      traditional: root.querySelector('[data-taw-caused="traditional"] [data-taw-caused-val]'),
      taxable: root.querySelector('[data-taw-caused="taxable"] [data-taw-caused-val]'),
    },
    sliders,
    columns,
  };
}

export function updateSliderCaps(refs, caps) {
  const limits = caps?.limits;
  const capByKey = limits ? {
    rothConversion: capFor(limits.rothConversion?.max),
    rothWithdrawal: capFor(limits.rothWithdrawal?.max),
    qcd: capFor(limits.qcd?.max),
    deferredWithdrawal: capFor(limits.deferredWithdrawal?.max),
    realizedGain: capFor(limits.realizedGain?.max),
  } : {
    rothConversion: capFor(caps?.traditional),
    rothWithdrawal: capFor(caps?.roth),
    qcd: capFor(caps?.traditional),
    deferredWithdrawal: capFor(caps?.traditional),
    realizedGain: capFor(caps?.taxable),
  };
  SLIDER_DEFS.forEach(({ key }) => {
    const max = capByKey[key];
    const min = limits && Number.isFinite(limits[key]?.min)
      ? Math.max(0, limits[key].min)
      : 0;
    const input = refs.sliders[key]?.input;
    if (input) {
      input.min = String(min);
      input.max = String(Math.max(min, max));
      input.disabled = Math.max(min, max) <= min;
    }
  });
}

export function paintLeverSync(refs, key, value) {
  const slot = refs.sliders[key];
  if (!slot?.input || !slot?.val) return;
  slot.input.value = String(value);
  slot.val.textContent = formatWithdrawalMoney(value);
}

function applyColumnRefs(colRefs, col) {
  if (!colRefs || !col) return;
  colRefs.rate.textContent = col.current;
  colRefs.rate.style.color = col.tone || '';
  colRefs.footLabel.textContent = col.footLabel;
  colRefs.footVal.textContent = col.foot;
  colRefs.base.style.height = col.base;
  colRefs.base.style.background = col.baseBg || '';
  colRefs.fill.style.bottom = col.base;
  colRefs.fill.style.height = col.fill;
  colRefs.fill.style.background = col.fillBg || '';
  colRefs.gap.style.bottom = col.top;
  colRefs.gap.style.height = col.gap;
  colRefs.edge.style.bottom = col.top;
  colRefs.edge.style.background = col.edge || '';
  colRefs.edgeVal.textContent = col.value;
  colRefs.marks.forEach((markEl, i) => {
    const mk = col.marks?.[i];
    if (!mk) {
      markEl.hidden = true;
      markEl.dataset.tawMark = '';
      return;
    }
    markEl.hidden = false;
    markEl.dataset.tawMark = mk.key;
    markEl.style.bottom = mk.hit;
    const tickL = markEl.querySelector('.taw-mark-tick--l');
    const tickR = markEl.querySelector('.taw-mark-tick--r');
    const chip = markEl.querySelector('.taw-mark-chip');
    tickL.style.width = mk.tickW;
    tickL.style.background = mk.bg;
    tickR.style.width = mk.tickW;
    tickR.style.background = mk.bg;
    chip.textContent = mk.label;
    chip.style.color = mk.chipInk;
    chip.style.opacity = String(mk.chipOpacity);
  });
}

export function applyThresholdColumns(refs, columns) {
  columns.forEach(col => {
    applyColumnRefs(refs.columns[col.id], col);
  });
}

export function applyHoverColumns(refs, result, hoverMark) {
  if (!result) return;
  const columns = buildThresholdColumns({ result, hoverMark });
  applyThresholdColumns(refs, columns);
}

function attOf(attribution, bucket) {
  if (!attribution || attribution.error || !attribution.byBucket) return null;
  const v = attribution.byBucket[bucket];
  return typeof v === 'number' && Number.isFinite(v) ? formatWithdrawalMoney(v) : null;
}

export function applyAttribution(refs, attribution, previous) {
  const att = attribution ?? previous;
  const setCaused = (el, bucket) => {
    if (!el) return;
    const next = attOf(att, bucket);
    el.textContent = next ?? '\u2014';
  };
  setCaused(refs.taxCaused.roth, 'roth');
  setCaused(refs.taxCaused.traditional, 'traditional');
  setCaused(refs.taxCaused.taxable, 'taxable');
  if (refs.attNote) refs.attNote.textContent = '';
}

export function applyIncomeFacts(refs, facts) {
  const otherIncome = facts.grossOtherIncome ?? facts.otherIncome;
  const baselineParts = [facts.socialSecurityBenefits, facts.wages, otherIncome];
  const baseline = baselineParts.every(value => (
    typeof value === 'number' && Number.isFinite(value)
  )) ? baselineParts.reduce((sum, value) => sum + value, 0) : null;
  refs.baselineTotal.textContent = formatWithdrawalMoney(baseline);
  refs.factSs.textContent = formatWithdrawalMoney(facts.socialSecurityBenefits);
  refs.factOther.textContent = formatWithdrawalMoney(otherIncome);
  refs.factWages.textContent = formatWithdrawalMoney(facts.wages);
}

export function applyResultView(refs, { result, facts, hoverMark }) {
  applyIncomeFacts(refs, facts);
  refs.federalTax.textContent = formatWithdrawalMoney(result?.totals?.federalTax);
  refs.effectiveRate.textContent = formatWithdrawalPct(result?.totals?.effectiveRate);
  refs.marginalRate.textContent = formatWithdrawalPct(
    result?.totals?.marginalRate ?? result?.ordinary?.rate
  );
  const columns = buildThresholdColumns({ result, hoverMark });
  applyThresholdColumns(refs, columns);
}

/** @deprecated Full re-render — tests only. */
export function renderTaxAwareWithdrawalView(state) {
  const tmp = document.createElement('div');
  mountWithdrawalPlannerShell(tmp, { caps: state.caps || {} });
  const refs = cacheWithdrawalRefs(tmp);
  applyResultView(refs, {
    result: state.result,
    facts: state.facts,
    taxYear: state.taxYear,
    hoverMark: state.hoverMark,
  });
  applyAttribution(refs, state.attribution, state.attribution);
  SLIDER_DEFS.forEach(({ key }) => paintLeverSync(refs, key, state.levers[key] || 0));
  return tmp.innerHTML;
}

import { selectedPathIndex } from './sequencing.js';



export function cfWdColor(wd, shortfall) {
    if (shortfall) return 'var(--neg)';
    if (wd < 5) return 'var(--body)';
    if (wd < 7) return 'var(--neg-soft)';
    return 'var(--neg)';
  }

export function goalTagFor(plan, r, age) {
    if (!(r.goals > 0)) return null;
    const g = (Array.isArray(plan.goals) ? plan.goals : [])
      .find((x) => (x.amount || 0) > 0 && x.startAge === x.endAge && x.startAge === age);
    return g ? g.name : null;
  }

export function buildPathRows(s, {
    simByIndex, baselineResult, plan, currentYear,
  }) {
    if (!s.res) return [];
    const sim = simByIndex(s.res, selectedPathIndex(baselineResult()));
    return buildSimulationRows(sim, { plan, currentYear });
  }

export function buildSimulationRows(sim, { plan, currentYear }) {
    if (!sim || !Array.isArray(sim.rows)) return [];
    const curAge = plan.household.primary.currentAge;
    const baseYear = currentYear;
    return sim.rows.map((r) => {
      const age = (r.age != null) ? r.age : curAge;
      return {
        year: baseYear + (age - curAge),
        age: age,
        sourceYear: r.source,
        accum: r.phase === 'accum',
        ret: (r.source != null && r.returnRate != null) ? r.returnRate : null,   // engine's applied return; null on failed filler rows
        income: (r.socialSecurity || 0) + (r.pension || 0) + (r.otherIncome || 0),
        rmd: r.rmd || 0,
        essential: r.expenses || 0,
        goals: r.goals || 0,
        tax: r.taxes || 0,
        draw: r.withdrawal || 0,
        wdRate: (r.wdRate != null) ? r.wdRate : 0,
        ending: r.balance || 0,
        fundingShortfall: Number.isFinite(r.fundingShortfall) ? r.fundingShortfall : 0,
        shortfall: Number.isFinite(r.fundingShortfall) && r.fundingShortfall > 0.01,
        startPort: r.startBalance || 0,
        goalTag: goalTagFor(plan, r, age),
      };
    });
  }

export function buildCashSummary(s, {
    simByIndex, baselineResult, pathDigest,
  }) {
    if (!s.res) return {};
    const sim = simByIndex(s.res, selectedPathIndex(baselineResult()));
    if (!sim) return {};
    let d = {};
    try { d = (typeof pathDigest === 'function') ? pathDigest(sim) : {}; } catch (e) { d = {}; }
    return { peakWdRate: d.peakWdRate, peakWdAge: d.peakWdAge };
  }

export function taxSidecarFor(scn, { isTypicalPath, typicalPathFederalTax, pathFederalTax }) {
    if (scn?.res?.federalFunding?.semantics?.convergence === 'per-year-to-one-cent') {
      return {
        byAge: new Map(),
        byYear: new Map(),
        scope: 'MODELED_FEDERAL_LINE_24',
        path: 'converged-engine-row',
        totals: null,
        warnings: [],
      };
    }
    const raw = typeof pathFederalTax === 'function'
      ? pathFederalTax(scn)
      : (isTypicalPath() ? typicalPathFederalTax(scn) : (scn.res && scn.res.pathFederalTax));
    if (!raw) return null;
    const byAge = new Map(), byYear = new Map();
    const list = Array.isArray(raw) ? raw : (raw.years || raw.rows || []);
    list.forEach((e) => {
      if (e == null) return;
      const t = (e.federalTaxLiability != null) ? e.federalTaxLiability
              : (e.tax != null) ? e.tax : (e.federalTax != null ? e.federalTax : e.value);
      if (e.age != null)  byAge.set(e.age, t);
      if (e.year != null) byYear.set(e.year, t);
    });
    return {
      byAge: byAge,
      byYear: byYear,
      scope: Array.isArray(raw) ? null : (raw.scope ?? null),
      path: Array.isArray(raw) ? null : (raw.path ?? null),
      totals: Array.isArray(raw) ? null : (raw.totals ?? null),
      warnings: Array.isArray(raw) ? [] : (Array.isArray(raw.warnings) ? raw.warnings : []),
    };
  }

export function taxComparisonFor(sidecar) {
    const totals = sidecar?.totals;
    if (!totals) return null;
    const federalTotal = totals.federalTaxLiability;
    const enginePathTotal = totals.enginePathTax;
    const delta = totals.deltaVsEnginePath;
    if (![federalTotal, enginePathTotal, delta].every(Number.isFinite)) return null;
    return { federalTotal, enginePathTotal, delta };
  }

export function taxColumnMeta(sidecar) {
    if (!sidecar) {
      return {
        label: 'Tax',
        source: 'engine',
        scope: null,
        title: 'Engine row tax estimate',
      };
    }
    if (sidecar.scope === 'INCOME_TAX_ONLY') {
      return {
        label: 'Tax',
        source: 'federal-sidecar',
        scope: sidecar.scope,
        title: 'Federal sidecar · income tax only',
      };
    }
    if (sidecar.scope === 'MODELED_FEDERAL_LINE_24') {
      return {
        label: 'Tax',
        source: 'federal-converged-row',
        scope: sidecar.scope,
        title: 'Modeled federal Form 1040 line 24 · retirement rows funded and converged; working years reporting-only',
      };
    }
    return {
      label: 'Tax',
      source: 'federal-sidecar',
      scope: sidecar.scope,
      title: sidecar.scope === 'FULL_1040'
        ? 'Federal sidecar · full Form 1040 scope'
        : 'Federal sidecar',
    };
  }

export function resolveRowTax(row, sidecar) {
    if (sidecar) {
      if (row.age != null && sidecar.byAge.has(row.age))   return sidecar.byAge.get(row.age);
      if (row.year != null && sidecar.byYear.has(row.year)) return sidecar.byYear.get(row.year);
    }
    return row.tax;                       // engine row tax (always present)
  }

export function fmtParenMoney(n, fmtMoney) {
    const m = fmtMoney(n);
    return m === '—' ? m : '(' + m + ')';
  }

export function formatCashFlowHeaderMoney(value, { signed = false } = {}) {
    if (!Number.isFinite(value)) return '—';
    const absolute = Math.abs(value);
    const prefix = value < 0 ? '\u2212' : (signed && value > 0 ? '+' : '');
    let amount;
    if (absolute >= 1_000_000) {
      amount = (absolute / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    } else if (absolute >= 1_000) {
      amount = Math.min(999, Math.round(absolute / 1_000)) + 'K';
    } else {
      amount = Math.round(absolute).toLocaleString('en-US');
    }
    return prefix + '$' + amount;
  }

function formatCashFlowHeaderPercent(value, { delta = false } = {}) {
    if (!Number.isFinite(value)) return '—';
    const absolute = Math.abs(value).toFixed(1);
    if (!delta) return absolute + '%';
    const prefix = value < 0 ? '\u2212' : (value > 0 ? '+' : '');
    return prefix + absolute + ' pts';
  }

export function federalWarningMessage(warning) {
    if (typeof warning === 'string') return warning;
    if (warning && typeof warning.message === 'string') return warning.message;
    if (warning && typeof warning.code === 'string') return warning.code;
    return 'Federal tax calculation warning';
  }

export function groupPhases(rows) {
    if (!rows.length) return [];
    const RMD_START_AGE = 73;
    return [
      { rows: rows.filter((r) => r.age < RMD_START_AGE) },
      { rows: rows.filter((r) => r.age >= RMD_START_AGE) },
    ].filter((p) => p.rows.length);
  }

export function renderCashflow(scn, allScns, {
    cashFlowResult, pathRows, cashSummary, cashFromRetirement, isTypicalPath, typicalPathFederalTax, pathFederalTax,
    wdColor, num, esc, fmtMoney, cfCols,
  }) {
    const selected = typeof cashFlowResult === 'function'
      ? cashFlowResult(scn.raw)
      : null;
    const allRows = selected?.rows ?? pathRows(scn.raw);
    // "Start at retirement" hides the working (accum) years. Retirement rows
    // begin only once BOTH spouses have retired (engine rule), so this starts
    // the ledger at the second retirement.
    const rows = cashFromRetirement ? allRows.filter((r) => !r.accum) : allRows;
    const hasWorking = allRows.some((r) => r.accum);
    const summary = selected?.summary ?? cashSummary(scn.raw);
    const typicalPath = selected ? selected.kind === 'typical' : isTypicalPath();
    const sidecar = selected?.taxScope === 'MODELED_FEDERAL_LINE_24'
      ? {
          byAge: new Map(),
          byYear: new Map(),
          scope: 'MODELED_FEDERAL_LINE_24',
          path: 'converged-engine-row',
          totals: null,
          warnings: [],
        }
      : taxSidecarFor(scn.raw, { isTypicalPath, typicalPathFederalTax, pathFederalTax });
    const taxColumn = taxColumnMeta(sidecar);
    const federalAttachFailed = typicalPath && !!scn.raw.res && !sidecar;
    const taxDisclosureState = federalAttachFailed
      ? 'engine-fallback'
      : taxColumn.source === 'federal-converged-row'
        ? 'federal-converged-row'
        : 'federal-sidecar';

    const scenarioOptions = allScns.map((s) => (
      '<option value="' + esc(s.id) + '"' + (s.id === scn.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'
    )).join('');
    const scenarioPicker = (
      '<label class="cf-scenario-picker" style="--tone:' + esc(scn.tone) + ';">' +
        '<span class="cf-scenario-picker__dot" aria-hidden="true"></span>' +
        '<select data-cash-select aria-label="Cash Flow scenario">' + scenarioOptions + '</select>' +
      '</label>'
    );

    const retStartAge = rows.find((r) => !r.accum)?.age ?? null;
    const RMD_START_AGE = 73;
    const rmdStartAge = rows.find((r) => r.age >= RMD_START_AGE)?.age ?? null;

    const headerMetrics = selected?.headerMetrics ?? null;
    const typicalSummaryStrip = headerMetrics?.kind === 'typical' ? (
      '<div class="cf-summary cf-summary--typical" data-cash-header-kind="typical" data-outcome="' + esc(headerMetrics.outcome) + '" style="--tone:' + scn.tone + ';">' +
        '<div class="cf-summary__stats">' +
          '<div class="cf-stat" data-cash-header-metric="funded-through">' +
            '<div class="cf-stat__label">Funded through</div>' +
            '<div class="cf-stat__value cf-stat__value--funded">Age ' + esc(headerMetrics.fundedThroughAge) + '</div>' +
            '<div class="cf-stat__support">' + esc(headerMetrics.fundedThroughSupport) + '</div>' +
          '</div>' +
          '<div class="cf-stat" data-cash-header-metric="ending-position">' +
            '<div class="cf-stat__label">Ending position</div>' +
            '<div class="cf-stat__value">' + formatCashFlowHeaderMoney(headerMetrics.endingPosition) + '</div>' +
            '<div class="cf-stat__support">Median path</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    ) : '';

    const historicalUnderfunded = headerMetrics?.outcome === 'underfunded';
    const comparisonValue = (metric, key) => {
      const value = metric[key];
      if(value === null || value === undefined){
        return key === 'delta' ? '—' : '';
      }
      if(metric.format === 'money'){
        return formatCashFlowHeaderMoney(value, { signed: key === 'delta' });
      }
      if(metric.format === 'percent'){
        return formatCashFlowHeaderPercent(value, { delta: key === 'delta' });
      }
      return esc(value);
    };
    const comparisonTone = (metric, key) => {
      if(key === 'thisPath' && historicalUnderfunded
          && ['early-withdrawal-pressure', 'first-underfunded-age'].includes(metric.id)){
        return ' cf-comparison__value--negative';
      }
      if(key !== 'delta' || !Number.isFinite(metric.delta)) return '';
      if(metric.id === 'early-withdrawal-pressure'){
        return metric.delta > 0
          ? ' cf-comparison__value--negative'
          : metric.delta < 0 ? ' cf-comparison__value--positive' : '';
      }
      if(['ending-portfolio', 'portfolio-at-underfunding'].includes(metric.id)){
        return metric.delta > 0
          ? ' cf-comparison__value--positive'
          : metric.delta < 0 ? ' cf-comparison__value--negative' : '';
      }
      return '';
    };
    const historicalMetrics = (headerMetrics?.rows ?? []).map(metric => (
      '<div class="cf-comparison__row" role="row" data-historical-metric="' + esc(metric.id) + '"' +
        ' data-this-path="' + esc(metric.thisPath ?? '') + '"' +
        ' data-typical-path="' + esc(metric.typicalPath ?? '') + '"' +
        ' data-delta="' + esc(metric.delta ?? '') + '"' +
        (Number.isInteger(metric.planYear) ? ' data-plan-year="' + metric.planYear + '"' : '') + '>' +
        '<div class="cf-comparison__label" role="rowheader">' + esc(metric.label) + '</div>' +
        '<div class="cf-comparison__value cf-comparison__value--this' + comparisonTone(metric, 'thisPath') + '" role="cell">' + comparisonValue(metric, 'thisPath') + '</div>' +
        '<div class="cf-comparison__value" role="cell">' + comparisonValue(metric, 'typicalPath') + '</div>' +
        '<div class="cf-comparison__value' + comparisonTone(metric, 'delta') + '" role="cell">' + comparisonValue(metric, 'delta') + '</div>' +
      '</div>'
    )).join('');
    const historicalSummaryStrip = (
      '<div class="cf-summary cf-summary--historical" data-cash-header-kind="historical"' +
        ' data-outcome="' + esc(headerMetrics?.outcome ?? '') + '">' +
        '<div class="cf-comparison" role="table" aria-label="Historical path comparison">' +
          '<div class="cf-comparison__head" role="row">' +
            '<span role="columnheader" aria-label="Metric"></span>' +
            '<span role="columnheader">This path</span>' +
            '<span role="columnheader">Typical path</span>' +
            '<span role="columnheader">Delta</span>' +
          '</div>' +
          historicalMetrics +
        '</div>' +
      '</div>'
    );
    const hasHistoricalSummary = selected?.kind === 'historical'
      && !selected.error
      && headerMetrics?.kind === 'historical'
      && ['underfunded', 'survives'].includes(headerMetrics.outcome)
      && headerMetrics.rows?.length === (historicalUnderfunded ? 3 : 2);
    const summaryStrip = selected?.kind === 'historical'
      ? (hasHistoricalSummary ? historicalSummaryStrip : '')
      : (!selected?.error ? typicalSummaryStrip : '');

    const taxDisclosureContent = federalAttachFailed
      ? '<div class="cf-tax-fallback" data-tax-fallback role="status">Federal tax detail isn\'t available for this run. The Tax column uses engine estimates.</div>'
      : (sidecar?.warnings?.length
          ? '<div class="cf-tax-warnings" data-tax-warnings role="status" aria-label="Federal tax warnings">' +
              '<div class="cf-tax-warnings__label">Federal tax warnings</div>' +
              '<ul>' + sidecar.warnings.map((warning) => '<li>' + esc(federalWarningMessage(warning)) + '</li>').join('') + '</ul>' +
            '</div>'
          : '');
    const taxDisclosure = (typicalPath || sidecar) && scn.raw.res && taxDisclosureContent
      ? '<div class="cf-tax-disclosure" data-tax-disclosure data-tax-state="' + taxDisclosureState + '">' +
          taxDisclosureContent +
        '</div>'
      : '';

    const rowHtml = (r) => {
      const tax = resolveRowTax(r, sidecar);
      const isFirstUnderfunded = selected?.kind === 'historical'
        && historicalUnderfunded
        && r.age === summary.firstUnderfundedAge;
      const ending = isFirstUnderfunded
        ? 'Underfunded'
        : (r.ending === 0 ? '$0' : fmtMoney(r.ending));
      const shortfallNote = selected?.kind !== 'historical' && r.fundingShortfall > 0.01
        ? '<span class="cf-row__shortfall">Short ' + fmtMoney(r.fundingShortfall) + '</span>'
        : '';
      const returnClass = r.ret == null ? 'cf-cell--zero' : (r.ret < 0 ? 'cf-down' : (r.ret > 0 ? 'cf-up' : ''));
      const withdrawalColor = cfWdColor(r.wdRate, r.shortfall);
      const withdrawalClass = !r.accum && r.startPort > 0
        ? (withdrawalColor === 'var(--neg)'
            ? 'cf-wd-hi'
            : (withdrawalColor === 'var(--neg-soft)' ? 'cf-wd-mid' : 'cf-wd-lo'))
        : 'cf-cell--zero';
      const isRetStart = retStartAge != null && !r.accum && r.age === retStartAge;
      const isRmdStart = rmdStartAge != null && r.age === rmdStartAge;
      const yearMark = isRetStart
        ? '<span class="cf-row__mark-dot cf-row__mark-dot--ret"></span>'
        : (isRmdStart ? '<span class="cf-row__mark-dot cf-row__mark-dot--rmd"></span>' : '');
      return (
        '<div class="cf-row cf-grid" data-age="' + esc(r.age) + '" data-phase="' + (r.accum ? 'accum' : 'retirement') + '" data-source-year="' + esc(r.sourceYear ?? '') + '" data-start-balance="' + r.startPort + '" data-ending-balance="' + r.ending + '" data-wd-rate="' + r.wdRate + '" data-funding-shortfall="' + r.fundingShortfall + '">' +
          '<span class="cf-row__year">' +
            '<span class="cf-row__mark" aria-hidden="true">' + yearMark + '</span>' +
            esc(r.year) +
          '</span>' +
          '<span class="cf-cell cf-cell--age">' + esc(r.age) + '</span>' +
          '<span class="cf-cell ' + (r.income > 0 ? '' : 'cf-cell--zero') + '">' + (r.income > 0 ? fmtMoney(r.income) : '—') + '</span>' +
          '<span class="cf-cell">' + (r.rmd > 0 ? fmtMoney(r.rmd) : '') + '</span>' +
          '<span class="cf-cell ' + (r.essential > 0 ? 'cf-cell--essential' : 'cf-cell--zero') + '">' + fmtMoney(r.essential) + '</span>' +
          '<div class="cf-row__goals-wrap">' +
            '<span class="cf-cell ' + (r.goals > 0 ? '' : 'cf-cell--zero') + '">' + (r.goals > 0 ? fmtMoney(r.goals) : '—') + '</span>' +
            (r.goalTag ? '<span class="px-chip px-chip--edited cf-row__goaltag">' + esc(r.goalTag) + '</span>' : '') +
          '</div>' +
          '<span class="cf-cell ' + (tax > 0 ? 'cf-cell--tax' : 'cf-cell--zero') + '">' + fmtMoney(tax) + '</span>' +
          '<span class="cf-cell ' + (r.draw > 0 ? 'cf-cell--draw' : 'cf-cell--zero') + '">' + fmtParenMoney(r.draw, fmtMoney) + '</span>' +
          '<span class="cf-cell cf-cell--ret ' + returnClass + '">' + (r.ret == null ? '—' : (r.ret < 0 ? '−' : '+') + num(Math.abs(r.ret) * 100, 1) + '%') + '</span>' +
          '<span class="cf-cell cf-cell--wd ' + withdrawalClass + '">' + (!r.accum && r.startPort > 0 ? num(r.wdRate, 1) + '%' : '—') + '</span>' +
          '<span class="cf-cell cf-cell--ending' + (r.shortfall ? ' cf-down' : '') + '"><span>' + ending + '</span>' + shortfallNote + '</span>' +
        '</div>'
      );
    };

    const phases = groupPhases(rows).map((p, idx) => (
      '<div class="cf-band ' + (idx % 2 === 1 ? 'is-shaded' : '') + '">' + p.rows.map(rowHtml).join('') + '</div>'
    )).join('');

    const headCells = cfCols.map((h, i) => {
      const isTax = h === 'Tax';
      const label = isTax ? taxColumn.label : h;
      const taxAttrs = isTax
        ? ' data-tax-source="' + esc(taxColumn.source) + '"' +
          (taxColumn.scope ? ' data-tax-scope="' + esc(taxColumn.scope) + '"' : '') +
          ' title="' + esc(taxColumn.title) + '"'
        : '';
      return '<span class="cf-th ' + (i >= 2 ? 'cf-th--r' : '') + '"' + taxAttrs + '>' + esc(label) + '</span>';
    }).join('');
    const emptyMessage = selected?.error
      ? selected.error
      : 'No cash-flow data yet. Press Run — or check the plan inputs if the status bar shows a warning.';
    const empty = rows.length ? '' : '<div class="cf-band"><div style="padding:26px 18px;color:var(--muted);">' + esc(emptyMessage) + '</div></div>';

    const simulationIndexAttribute = Number.isInteger(selected?.simIndex)
      ? ' data-sim-index="' + selected.simIndex + '"'
      : '';

    return (
      '<div class="cf" data-cash-path-id="' + esc(selected?.pathId ?? (typicalPath ? 'typical' : '')) + '" data-cash-path-kind="' + esc(selected?.kind ?? (typicalPath ? 'typical' : '')) + '"' + simulationIndexAttribute + '>' +
        '<div class="cf__head">' +
          scenarioPicker +
          (hasWorking
            ? '<button class="cf-ret-toggle ' + (cashFromRetirement ? 'is-on' : '') + '" type="button" data-cash-retstart aria-pressed="' + (cashFromRetirement ? 'true' : 'false') + '">Start at retirement</button>'
            : '') +
          '<div class="cf__path-controls" id="scn-cf-path-controls"></div>' +
        '</div>' +
        '<div class="cf-panel">' +
          summaryStrip +
          taxDisclosure +
          '<div class="cf-table">' +
            '<div class="cf-table__head cf-grid">' + headCells + '</div>' +
            (empty || phases) +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }


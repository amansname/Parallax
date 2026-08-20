import { selectedPathIndex } from './sequencing.js';



export function cfWdColor(wd, shortfall) {
    if (shortfall) return 'var(--down-deep)';
    if (wd < 5) return 'var(--text-3)';
    if (wd < 7) return 'var(--down)';
    return 'var(--down-deep)';
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

export function fmtSignedMoney(n, fmtMoney) {
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '$0';
    return (n < 0 ? '−' : '+') + fmtMoney(Math.abs(n));
  }

export function federalScopeLabel(scope) {
    if (scope === 'INCOME_TAX_ONLY') return 'income tax only';
    if (scope === 'FULL_1040') return 'full Form 1040';
    if (scope === 'MODELED_FEDERAL_LINE_24') return 'modeled Form 1040 line 24; retirement rows funded and converged, working years reporting-only';
    return 'scope not specified';
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
    toneGlow, ring, wdColor, num, esc, fmtMoney, cfCols,
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
    const taxComparison = taxComparisonFor(sidecar);
    const federalAttachFailed = typicalPath && !!scn.raw.res && !sidecar;
    const taxDisclosureState = federalAttachFailed
      ? 'engine-fallback'
      : taxColumn.source === 'federal-converged-row'
        ? 'federal-converged-row'
        : 'federal-sidecar';

    const pills = allScns.map((s) => (
      '<button class="cf-pill ' + (s.id === scn.id ? 'is-active' : '') + '" type="button" data-cash-pick="' + esc(s.id) + '" aria-pressed="' + (s.id === scn.id ? 'true' : 'false') + '" style="--tone:' + s.tone + ';">' +
        '<span class="cf-pill__dot"></span>' + esc(s.name) +
      '</button>'
    )).join('');

    const retStartAge = rows.find((r) => !r.accum)?.age ?? null;
    const RMD_START_AGE = 73;
    const rmdStartAge = rows.find((r) => r.age >= RMD_START_AGE)?.age ?? null;

    const taxComparisonHtml = taxComparison ? (
      '<div class="cf-tax-compare" data-tax-compare style="display:contents;"' +
        (sidecar?.path ? ' data-tax-path="' + esc(sidecar.path) + '"' : '') +
        ' data-federal-total="' + taxComparison.federalTotal + '"' +
        ' data-engine-path-total="' + taxComparison.enginePathTotal + '"' +
        ' data-delta="' + taxComparison.delta + '">' +
        '<div class="cf-stat"><div class="cf-stat__label">Federal Total</div><div class="cf-stat__value">' + (taxComparison.federalTotal === 0 ? '$0' : fmtMoney(taxComparison.federalTotal)) + '</div></div>' +
        '<div class="cf-stat"><div class="cf-stat__label">Engine Path</div><div class="cf-stat__value">' + (taxComparison.enginePathTotal === 0 ? '$0' : fmtMoney(taxComparison.enginePathTotal)) + '</div></div>' +
        '<div class="cf-stat"><div class="cf-stat__label">Delta</div><div class="cf-stat__value">' + fmtSignedMoney(taxComparison.delta, fmtMoney) + '</div></div>' +
      '</div>'
    ) : '';

    const typicalSummaryStrip = (
      '<div class="cf-summary" style="--tone:' + scn.tone + ';--tone-glow:' + toneGlow(scn.tone) + ';">' +
        '<div class="cf-summary__id">' +
          ring(40, 17, 2.5, scn.tone, scn.prob, '<span class="numeral" style="font-size:14px;">' + scn.probStr + '<span class="pct" style="font-size:10px;">%</span></span>') +
          '<div class="cf-summary__sub">Probability of success</div>' +
        '</div>' +
        '<div class="cf-summary__stats">' +
          '<div class="cf-stat"><div class="cf-stat__label">Median Ending</div><div class="cf-stat__value">' + scn.median + '</div></div>' +
          '<div class="cf-stat"><div class="cf-stat__label">Peak Withdrawal</div>' +
            '<div class="cf-stat__peak"><span class="cf-stat__value" style="color:' + wdColor(summary.peakWdRate, false) + ';">' + (summary.peakWdRate ? num(summary.peakWdRate, 1) + '%' : '—') + '</span><span class="cf-stat__peak-age">' + (summary.peakWdAge ? 'age ' + summary.peakWdAge : '') + '</span></div>' +
          '</div>' +
          taxComparisonHtml +
        '</div>' +
      '</div>'
    );

    const historicalUnderfunded = summary.outcome === 'underfunded';
    const historicalPlanFunding = historicalUnderfunded
      ? (
          '<div class="cf-stat" data-plan-funding>' +
            '<div class="cf-stat__label">Plan funding</div>' +
            '<div class="cf-stat__value">Underfunded at age ' + esc(summary.firstUnderfundedAge ?? '—') + '</div>' +
            '<div class="cf-stat__detail">First underfunded year ' + esc(summary.firstUnderfundedYear ?? '—') +
              (summary.fundedThroughAge != null
                ? ' · funded through age ' + esc(summary.fundedThroughAge)
                : '') +
            '</div>' +
          '</div>'
        )
      : (
          '<div class="cf-stat" data-plan-funding>' +
            '<div class="cf-stat__label">Plan funding</div>' +
            '<div class="cf-stat__value">Funded through plan end</div>' +
            '<div class="cf-stat__detail">Through age ' + esc(summary.fundedThroughAge ?? '—') +
              (summary.fundedThroughYear != null ? ' · ' + esc(summary.fundedThroughYear) : '') +
            '</div>' +
          '</div>' +
          '<div class="cf-stat" data-ending-position>' +
            '<div class="cf-stat__label">Ending position</div>' +
            '<div class="cf-stat__value">' + (summary.endingBalance == null ? '—' : fmtMoney(summary.endingBalance)) + '</div>' +
            '<div class="cf-stat__detail">At age ' + esc(summary.endingAge ?? '—') +
              (summary.endingYear != null ? ' · ' + esc(summary.endingYear) : '') +
            '</div>' +
          '</div>' +
          '<div class="cf-stat" data-peak-withdrawal>' +
            '<div class="cf-stat__label">Peak withdrawal</div>' +
            '<div class="cf-stat__peak"><span class="cf-stat__value" style="color:' + wdColor(summary.peakWdRate, false) + ';">' +
              (summary.peakWdRate ? num(summary.peakWdRate, 1) + '%' : '—') +
              '</span><span class="cf-stat__peak-age">' +
                (summary.peakWdAge != null
                  ? 'age ' + esc(summary.peakWdAge) + (summary.peakWdYear != null ? ' · ' + esc(summary.peakWdYear) : '')
                  : '') +
              '</span></div>' +
          '</div>'
        );
    const historicalSummaryStrip = (
      '<div class="cf-summary cf-summary--historical"' +
        ' data-outcome="' + esc(summary.outcome ?? '') + '"' +
        ' data-first-underfunded-age="' + (summary.firstUnderfundedAge ?? '') + '"' +
        ' data-first-underfunded-year="' + (summary.firstUnderfundedYear ?? '') + '"' +
        ' data-funded-through-age="' + (summary.fundedThroughAge ?? '') + '"' +
        ' data-funded-through-year="' + (summary.fundedThroughYear ?? '') + '"' +
        ' data-ending-balance="' + (summary.endingBalance ?? '') + '"' +
        ' data-ending-age="' + (summary.endingAge ?? '') + '"' +
        ' data-ending-year="' + (summary.endingYear ?? '') + '"' +
        ' data-peak-wd-rate="' + (summary.peakWdRate ?? '') + '"' +
        ' data-peak-wd-age="' + (summary.peakWdAge ?? '') + '"' +
        ' data-peak-wd-year="' + (summary.peakWdYear ?? '') + '">' +
        '<div class="cf-summary__stats">' +
          historicalPlanFunding +
        '</div>' +
      '</div>'
    );
    const hasHistoricalSummary = selected?.kind === 'historical'
      && !selected.error
      && ['underfunded', 'survives'].includes(summary.outcome);
    const summaryStrip = selected?.kind === 'historical'
      ? (hasHistoricalSummary ? historicalSummaryStrip : '')
      : typicalSummaryStrip;

    const taxDisclosure = (typicalPath || sidecar) && scn.raw.res ? (
      '<div class="cf-tax-disclosure" data-tax-disclosure data-tax-state="' + taxDisclosureState + '">' +
        (federalAttachFailed
          ? '<div class="cf-tax-fallback" data-tax-fallback role="status">Federal tax detail isn\'t available for this run. The Tax column uses engine estimates.</div>'
          : '<div class="cf-tax-scope" data-tax-scope-disclosure>Federal tax scope: ' + esc(federalScopeLabel(sidecar.scope)) + '.</div>' +
            (sidecar.warnings.length
              ? '<div class="cf-tax-warnings" data-tax-warnings role="status" aria-label="Federal tax warnings">' +
                  '<div class="cf-tax-warnings__label">Federal tax warnings</div>' +
                  '<ul>' + sidecar.warnings.map((warning) => '<li>' + esc(federalWarningMessage(warning)) + '</li>').join('') + '</ul>' +
                '</div>'
              : '')) +
      '</div>'
    ) : '';

    const rowHtml = (r) => {
      const tax = resolveRowTax(r, sidecar);
      const isFirstUnderfunded = selected?.kind === 'historical'
        && historicalUnderfunded
        && r.age === summary.firstUnderfundedAge;
      const ending = isFirstUnderfunded
        ? 'Underfunded'
        : (r.ending === 0 ? '$0' : fmtMoney(r.ending));
      const endColor = r.shortfall ? 'var(--down-deep)' : 'var(--text-2)';
      const shortfallNote = selected?.kind !== 'historical' && r.fundingShortfall > 0.01
        ? '<span class="cf-row__shortfall">Short ' + fmtMoney(r.fundingShortfall) + '</span>'
        : '';
      const goalsColor = r.goals > 0 ? (r.goalTag ? '#d8c084' : '#c6a662') : 'var(--text-mute)';
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
          '<span class="cf-cell" style="color:' + (r.income > 0 ? 'var(--text-2b)' : 'var(--text-mute)') + ';">' + (r.income > 0 ? fmtMoney(r.income) : '—') + '</span>' +
          '<span class="cf-cell" style="color:var(--text-2b);">' + (r.rmd > 0 ? fmtMoney(r.rmd) : '') + '</span>' +
          '<span class="cf-cell ' + (r.essential > 0 ? 'cf-cell--essential' : 'cf-cell--zero') + '">' + fmtMoney(r.essential) + '</span>' +
          '<div class="cf-row__goals-wrap">' +
            '<span class="cf-cell" style="color:' + goalsColor + ';">' + (r.goals > 0 ? fmtMoney(r.goals) : '—') + '</span>' +
            (r.goalTag ? '<span class="cf-row__goaltag">' + esc(r.goalTag) + '</span>' : '') +
          '</div>' +
          '<span class="cf-cell ' + (tax > 0 ? 'cf-cell--tax' : 'cf-cell--zero') + '">' + fmtMoney(tax) + '</span>' +
          '<span class="cf-cell ' + (r.draw > 0 ? 'cf-cell--draw' : 'cf-cell--zero') + '">' + fmtParenMoney(r.draw, fmtMoney) + '</span>' +
          '<span class="cf-cell cf-cell--ret" style="color:' + (r.ret == null ? 'var(--text-mute)' : (r.ret < 0 ? 'var(--down)' : 'var(--tone-green)')) + ';">' + (r.ret == null ? '—' : (r.ret < 0 ? '−' : '+') + num(Math.abs(r.ret) * 100, 1) + '%') + '</span>' +
          '<span class="cf-cell cf-cell--wd" style="color:' + (!r.accum && r.startPort > 0 ? cfWdColor(r.wdRate, r.shortfall) : 'var(--text-mute)') + ';">' + (!r.accum && r.startPort > 0 ? num(r.wdRate, 1) + '%' : '—') + '</span>' +
          '<span class="cf-cell cf-cell--ending" style="color:' + endColor + ';"><span>' + ending + '</span>' + shortfallNote + '</span>' +
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
    const empty = rows.length ? '' : '<div class="cf-band"><div style="padding:26px 18px;color:var(--text-5);">' + esc(emptyMessage) + '</div></div>';

    return (
      '<div class="cf" data-cash-path-id="' + esc(selected?.pathId ?? (typicalPath ? 'typical' : '')) + '" data-cash-path-kind="' + esc(selected?.kind ?? (typicalPath ? 'typical' : '')) + '">' +
        '<div class="cf__head">' +
          '<div class="cf__pills">' + pills + '</div>' +
          '<div class="cf__path-controls" id="scn-cf-path-controls"></div>' +
          (hasWorking
            ? '<button class="cf-ret-toggle ' + (cashFromRetirement ? 'is-on' : '') + '" type="button" data-cash-retstart aria-pressed="' + (cashFromRetirement ? 'true' : 'false') + '">Start at retirement</button>'
            : '') +
        '</div>' +
        summaryStrip +
        taxDisclosure +
        '<div class="cf-table">' +
          '<div class="cf-table__head cf-grid">' + headCells + '</div>' +
          (empty || phases) +
        '</div>' +
      '</div>'
    );
  }


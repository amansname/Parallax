const TONE = { green: 'var(--pos)', amber: 'var(--acc)', rust: 'var(--neg)' };

export function toneForProb(prob) {
    if (prob == null) return TONE.green;
    if (prob >= 85) return TONE.green;
    if (prob >= 70) return TONE.amber;
    return TONE.rust;
  }

export function wdColor(wd, shortfall) {
    if (shortfall) return 'var(--neg)';
    if (wd < 3) return 'var(--pos)';
    if (wd < 4.5) return 'var(--acc)';
    if (wd < 6) return 'var(--neg-soft)';
    return 'var(--neg)';
  }

export function ring(size, r, sw, tone, pct, inner) {
    const circ = (2 * Math.PI * r);
    const off = (circ * (1 - (pct || 0) / 100)).toFixed(1);
    return (
      '<div class="ring" style="width:' + size + 'px;height:' + size + 'px;--tone:' + tone + ';">' +
        '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
          '<circle class="ring__track" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" stroke-width="' + sw + '"></circle>' +
          '<circle class="ring__arc" cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" stroke-width="' + sw + '" ' +
            'stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + off + '"></circle>' +
        '</svg>' +
        (inner ? '<div class="ring__label">' + inner + '</div>' : '') +
      '</div>'
    );
  }

export function num(n, d) { return (n == null) ? '—' : Number(n).toFixed(d == null ? 1 : d); }

// A scenario with no probability must say WHY. A bare dash is what made this
// class of failure take a day to diagnose — the engine knew the reason the
// whole time and nothing carried it to the screen.
export function scenarioIssue(s, variant, esc) {
  if (!s || !s.error || s.prob != null) return '';
  return '<div class="scn-issue scn-issue--' + (variant || 'col') + '" role="status">'
    + '<span class="scn-issue__mark" aria-hidden="true">!</span>'
    + '<span class="scn-issue__text">' + esc(s.error) + '</span>'
    + '</div>';
}

export function deltaVsBaseline(scn, baseline) {
    if (!baseline || scn.id === baseline.id || scn.prob == null || baseline.prob == null) return null;
    return (scn.prob - baseline.prob);   // presentation subtraction, not a re-simulation
  }

function formatProbabilityDelta(delta, negativeMarker = '−') {
  if (delta == null) return '';
  const marker = delta > 0 ? '+' : (delta < 0 ? negativeMarker : '');
  return marker + Math.abs(delta).toFixed(1) + ' pts';
}

function leverOptions(lever, esc){
  return (Array.isArray(lever.options) ? lever.options : []).map(option => (
    '<option value="' + esc(option.value) + '"'
      + (option.value === lever.selectedValue ? ' selected' : '') + '>'
      + esc(option.label) + '</option>'
  )).join('');
}

export function renderCompare(scns, baseline, { plan, planEndAge, goalsExpandedState, esc, downTri }) {
    const displayGoalEndAge = value => (
      Number(value) >= 999 && Number.isFinite(planEndAge) ? planEndAge : value
    );
    const heads = scns.map((s, i) => {
      const d = deltaVsBaseline(s, baseline);
      const tag = s.isBaseline
        ? '<div class="scol__tag"><span class="tag-ref">Reference</span></div>'
        : (d != null
            ? '<div class="scol__tag"><span class="tag-delta">' + formatProbabilityDelta(d, downTri) + '</span></div>'
            : '');
      return (
        '<div class="scol">' +
          '<div class="scol__head ' + (i ? 'scol__head--menu' : '') + '" style="--tone:' + s.tone + ';">' +
            '<div class="scol__head"><span class="scol__dot"></span><span class="scol__name">' + esc(s.name) + '</span></div>' +
            (i ? '<button class="scol__menu" type="button" data-scn-id="' + esc(s.id) + '" aria-label="Options for ' + esc(s.name) + '" aria-haspopup="true">⋯</button>' : '') +
          '</div>' +
          '<div class="scol__metric" style="--tone:' + s.tone + ';">' +
            ring(40, 17, 2.5, s.tone, s.prob, '') +
            '<div>' +
              '<div class="scol__prob">' + s.probStr + '<span class="pct">%</span></div>' +
              '<div class="scol__median">Median <b>' + s.median + '</b></div>' +
            '</div>' +
          '</div>' + scenarioIssue(s, 'col', esc) + tag +
        '</div>'
      );
    }).join('');

    // Compare cells: always-visible, stable edit controls in EVERY column including
    // Baseline. No hidden overlays, no click-to-reveal, no pop-out steppers. Dollar
    // levers get a direct type-in input; discrete levers (ages, allocation) get
    // always-visible −/value/+ buttons. The baseline simply carries no delta chip
    // (it is the reference) but is fully editable like the others.
    const baseLevers = (baseline ? baseline.levers : scns[0].levers);
    const leverRows = baseLevers.map((bl, li) => {
      const cells = scns.map((s) => {
        const lev = s.levers[li] || {};
        const value = esc(lev.value);
        const delta = lev.delta ? '<span class="cell__delta">' + esc(lev.delta) + '</span>' : '';

        // No lever key for this row → plain read-only value.
        if (!lev.key) {
          return '<div class="cell cell--lev"><div class="cell__val"><span class="cell__num">' + value + '</span></div></div>';
        }

        // Allocation model: one in-place selector uses less horizontal space
        // than the old minus/value/plus control and exposes canonical labels.
        if (lev.controlType === 'select') {
          return (
            '<div class="cell cell--lev cell--lev-select">' +
              '<div class="cmp-lev-row">' +
                '<select class="cmp-lev-select" data-scn-id="' + esc(s.id) + '" data-lever-key="' + esc(lev.key) + '" aria-label="' + esc(lev.label + ' for ' + s.name) + '">' +
                  leverOptions(lev, esc) +
                '</select>' +
                (delta ? delta : '') +
              '</div>' +
            '</div>'
          );
        }

        // Dollar lever: always-visible type-in input
        if (lev.editType) {
          let inputHtml;
          if (lev.editType === 'event') {
            inputHtml =
              '$<input class="cmp-lev-in" type="text" inputmode="numeric" data-edit="eventAmt" data-key="eventAmt" data-scn-id="' + esc(s.id) + '" value="' + esc(lev.inputVal) + '">' +
              '<span class="cmp-unit"> @ age </span>' +
              '<input class="cmp-lev-in cmp-lev-in--age" type="text" inputmode="numeric" data-edit="eventAge" data-key="eventAge" data-scn-id="' + esc(s.id) + '" value="' + esc(String(lev.eventAge != null ? lev.eventAge : '')) + '">';
          } else {
            const unitSpan = lev.unitStr ? '<span class="cmp-unit">' + esc(lev.unitStr) + '</span>' : '';
            inputHtml = '$<input class="cmp-lev-in" type="text" inputmode="numeric" data-edit="' + esc(lev.editType) + '" data-key="' + esc(lev.key) + '" data-scn-id="' + esc(s.id) + '" value="' + esc(lev.inputVal) + '">' + unitSpan;
          }
          return (
            '<div class="cell cell--lev cell--lev-edit">' +
              '<div class="cmp-lev-row">' + inputHtml + '</div>' +
              (delta ? '<div class="cmp-delta-row">' + delta + '</div>' : '') +
            '</div>'
          );
        }

        // Discrete lever: always-visible − / value / + controls
        const decBtn = '<button class="cmp-step-btn" type="button" data-scn-id="' + esc(s.id) + '" data-lever-key="' + esc(lev.key) + '" data-dir="-1" aria-label="Decrease ' + esc(lev.label) + '">−</button>';
        const incBtn = '<button class="cmp-step-btn" type="button" data-scn-id="' + esc(s.id) + '" data-lever-key="' + esc(lev.key) + '" data-dir="1" aria-label="Increase ' + esc(lev.label) + '">+</button>';
        return (
          '<div class="cell cell--lev cell--lev-step">' +
            '<div class="cmp-lev-row">' + decBtn + '<span class="cmp-lev-val">' + value + '</span>' + incBtn + (delta ? delta : '') + '</div>' +
          '</div>'
        );
      }).join('');
      return '<div class="lever"><span class="lever__name">' + esc(bl.label) + '</span></div>' + cells;
    }).join('<div class="compare__rule" style="margin:0;"></div>');

    const baseGoals = (baseline ? baseline.goals : scns[0].goals);
    // Per-column summary (collapsed state). "active" = goals funded (effective
    // amount > 0). Non-baseline columns that differ from the baseline scenario's
    // effective goals are flagged "edited"; identical ones read "same as Baseline".
    const goalCells = scns.map((s) => {
      const active = s.goals.filter((g) => g.on).length;
      if (s.isBaseline) {
        return '<div class="cell--goal"><span class="goal-pill" style="--tone:var(--pos);"><span class="goal-pill__dot"></span>' + active + ' active</span></div>';
      }
      const changed = s.goals.some((g) => !g.sameAsBase);
      if (!changed) {
        return '<div class="cell--goal"><span class="goal-note">' + active + ' active · same as Baseline</span></div>';
      }
      return '<div class="cell--goal"><span class="goal-pill" style="--tone:var(--acc);"><span class="goal-pill__dot"></span>' + active + ' active · edited</span></div>';
    }).join('');

    // Goals section: collapsible. The header row carries a visible chevron toggle
    // (stable, discoverable — not a hover/pop-out). Collapsed shows the per-column
    // summary; expanded reveals one editable row per goal — every column (Baseline
    // included) can type amount / start age / end age. Edits are per-scenario
    // overrides only (never mutate the base plan or other scenarios).
    const hasGoals = baseGoals.length > 0;
    const goalsExpanded = !!goalsExpandedState && hasGoals;
    const goalsChevron = '<svg class="goals-chev" width="13" height="13" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 L6 7.5 L9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
    const goalsHeadCell = hasGoals
      ? '<div class="cell--goal lever goals-head" data-goals-toggle role="button" tabindex="0" aria-expanded="' + (goalsExpanded ? 'true' : 'false') + '"><span class="lever__name">Goals</span>' + goalsChevron + '<span class="lever__hint" style="margin:0 0 0 4px;">· edit per plan</span></div>'
      : '<div class="cell--goal lever"><span class="lever__name">Goals</span></div>';
    const goalDetailRows = goalsExpanded ? baseGoals.map((bg, gi) => {
      const baseWin = bg.once
        ? ('at age ' + bg.startAge)
        : ('age ' + bg.startAge + '–' + displayGoalEndAge(bg.endAge));
      const baseFunding = bg.fundingNote ? (' · ' + bg.fundingNote) : '';
      const gut = '<div class="lever goal-detail"><span class="goal-detail__name">' + esc(bg.name) + '</span><span class="goal-detail__meta">base: ' + esc(baseWin + baseFunding) + '</span></div>';
      const cells = scns.map((s) => {
        const g = s.goals[gi];
        if (!g) return '<div class="cell cell--goal-detail"></div>';
        const amtIn = '$<input class="cmp-goal-in" type="text" inputmode="numeric" data-scn-id="' + esc(s.id) + '" data-goal-idx="' + g.idx + '" data-goal-field="amount" value="' + esc((g.amount || 0).toLocaleString('en-US')) + '">';
        let ageIn;
        if (g.once) {
          ageIn = '<span class="cmp-unit">one-time · age </span>' +
            '<input class="cmp-goal-in cmp-goal-in--age" type="text" inputmode="numeric" data-scn-id="' + esc(s.id) + '" data-goal-idx="' + g.idx + '" data-goal-field="onceAge" value="' + esc(String(g.startAge)) + '">';
        } else {
          ageIn = '<span class="cmp-unit">/yr · age </span>' +
            '<input class="cmp-goal-in cmp-goal-in--age" type="text" inputmode="numeric" data-scn-id="' + esc(s.id) + '" data-goal-idx="' + g.idx + '" data-goal-field="startAge" value="' + esc(String(g.startAge)) + '">' +
            '<span class="cmp-unit">–</span>' +
            '<input class="cmp-goal-in cmp-goal-in--age" type="text" inputmode="numeric" data-scn-id="' + esc(s.id) + '" data-goal-idx="' + g.idx + '" data-goal-field="endAge" value="' + esc(String(displayGoalEndAge(g.endAge))) + '">';
        }
        const editedDot = g.overridden ? '<span class="cmp-goal-edited" title="Edited in this plan" aria-label="Edited in this plan"></span>' : '';
        const deltaChip = (!s.isBaseline && g.amountDelta) ? '<span class="cell__delta">' + (g.amountDelta > 0 ? '+' : '−') + '$' + Math.abs(g.amountDelta).toLocaleString('en-US') + '</span>' : '';
        const fundingNote = g.fundingNote ? '<div class="goal-detail__meta">' + esc(g.fundingNote) + '</div>' : '';
        return (
          '<div class="cell cell--goal-detail' + (g.overridden ? ' is-overridden' : '') + '">' +
            '<div class="cmp-goal-row">' + editedDot + amtIn + ageIn + '</div>' +
            fundingNote +
            (deltaChip ? '<div class="cmp-delta-row">' + deltaChip + '</div>' : '') +
          '</div>'
        );
      }).join('');
      return gut + cells;
    }).join('') : '';

    return (
      '<div class="compare">' +
        '<div class="compare__grid" style="grid-template-columns:280px repeat(' + scns.length + ',minmax(0,1fr));">' +
          '<div class="lever lever--head"><div class="lever__name">Plan Levers</div><div class="lever__hint">columns show Δ vs Baseline</div></div>' +
          heads +
          '<div class="compare__rule" style="margin:4px 0 6px;"></div>' +
          leverRows +
          '<div class="compare__rule" style="margin:8px 0 0;"></div>' +
          goalsHeadCell +
          goalCells +
          goalDetailRows +
        '</div>' +
      '</div>'
    );
  }

export function stressVerdict(stress) {
    const passed = stress.filter((r) => r.pass).length, total = stress.length;
    const all = total > 0 && passed === total;
    return { text: total === 0 ? '' : (all ? 'Survives all ' + total + ' eras' : 'Survives ' + passed + ' of ' + total + ' eras'),
      color: all ? 'var(--pos)' : 'var(--acc)' };
  }

export function renderFocus(scns, baseline, focusedId, showRange, {
    esc, fmtMoney, checkIcon, stressEraCount,
  }) {
    const f = scns.find((s) => s.id === focusedId) || scns[0];
    const v = stressVerdict(f.stress);
    const heroRing = ring(152, 67, 3.5, f.tone, f.prob, '<span class="hero__numeral">' + f.probStr + '<span class="pct">%</span></span>')
      + scenarioIssue(f, 'hero', esc);

    const assum = f.levers.map((l) => {
      const control = l.controlType === 'select'
        ? '<div class="assum__stepper assum__stepper--select">' +
            '<select class="assum__select" data-lever-key="' + esc(l.key) + '" aria-label="' + esc(l.label) + '">' +
              leverOptions(l, esc) +
            '</select>' +
            (l.delta ? '<span class="assum__delta">' + esc(l.delta) + '</span>' : '') +
          '</div>'
        : '<div class="assum__stepper">' +
            '<button class="stepper-btn" type="button" data-lever-key="' + esc(l.key) + '" data-dir="-1" aria-label="Decrease ' + esc(l.label) + '">−</button>' +
            '<span class="assum__value">' + esc(l.value) + '</span>' +
            '<button class="stepper-btn" type="button" data-lever-key="' + esc(l.key) + '" data-dir="1" aria-label="Increase ' + esc(l.label) + '">+</button>' +
            (l.delta ? '<span class="assum__delta">' + esc(l.delta) + '</span>' : '') +
          '</div>';
      return '<div><div class="assum__label">' + esc(l.label) + '</div>' + control + '</div>';
    }).join('');

    const activeGoals = f.goals.filter((g) => g.on).length;
    const offGoals = f.goals.filter((g) => !g.on).length;
    const goals = f.goals.map((g) => {
      const amt = (typeof g.amount === 'number') ? fmtMoney(g.amount) : esc(g.amount);
      const sub = (g.cadence && g.cadence !== 'disabled') ? esc(g.cadence) : '';
      return (
        '<div class="goal-row ' + (g.on ? 'is-on' : 'is-off') + '">' +
          '<div class="goal-row__left">' +
            '<span class="goal-state goal-state--' + (g.on ? 'on' : 'off') + '">' + (g.on ? 'Active' : 'Off') + '</span>' +
            '<div class="goal-row__body"><div><div class="goal-row__name">' + esc(g.name) + '</div><div class="goal-row__meta">' + esc(g.meta) + '</div></div></div>' +
          '</div>' +
          '<div class="goal-row__amt"><b>' + amt + '</b><div class="goal-row__sub">' + sub + '</div></div>' +
        '</div>'
      );
    }).join('');

    const cards = scns.map((s) => {
      const active = s.id === focusedId;
      const d = deltaVsBaseline(s, baseline);
      const tag = active
        ? '<span class="rail-card__tag rail-card__tag--focus">In focus</span>'
        : (s.isBaseline ? '<span class="rail-card__tag">Reference</span>'
            : '<span class="rail-card__tag rail-card__tag--delta">' + formatProbabilityDelta(d) + '</span>');
      return (
        '<button class="rail-card ' + (active ? 'is-active' : '') + '" type="button" data-pick="' + esc(s.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '" style="--tone:' + s.tone + ';">' +
          '<div class="rail-card__head"><div class="rail-card__title"><span class="rail-card__dot"></span><span class="rail-card__name">' + esc(s.name) + '</span></div>' + tag + '</div>' +
          '<div class="rail-card__metric">' + ring(40, 16, 2.5, s.tone, s.prob, '') +
            '<div style="flex:1;"><div class="rail-card__prob">' + s.probStr + '<span class="pct">%</span></div></div>' +
            '<div style="text-align:right;"><div class="rail-card__median-l">Median</div><div class="rail-card__median">' + s.median + '</div></div>' +
          '</div>' + scenarioIssue(s, 'rail', esc) +
        '</button>'
      );
    }).join('');

    const stressRows = f.stress.map((st) => (
      '<div class="stress-rail__row">' +
        '<span class="stress-rail__icon ' + (st.pass ? 'stress-rail__icon--pass' : 'stress-rail__icon--marginal') + '">' + (st.pass ? checkIcon(1.9, 11) : '!') + '</span>' +
        '<div class="stress-rail__body"><span class="stress-rail__year">' + esc(st.year) + '</span><span class="stress-rail__name">' + esc(st.name) + '</span></div>' +
        '<span class="stress-rail__result" style="color:' + (st.pass ? 'var(--pos)' : 'var(--acc)') + ';">' + (st.pass ? 'Pass' : 'Marginal') + '</span>' +
      '</div>'
    )).join('');
    // Render the Historical Stress card from engine-derived per-scenario eras.
    // Gate: all 5 eras must be present. If computeHistoricalStress produced fewer
    // than STRESS_ERAS.length results (even after the riskProfile guard), surface a
    // diagnostic row instead of a silent partial card — never fabricate outcomes.
    let stressBlock = '';
    if (f.stress.length === stressEraCount) {
      stressBlock = (
        '<div class="stress-rail">' +
          '<div class="stress-rail__head"><span class="eyebrow" style="letter-spacing:0.16em;">Historical Stress</span><span class="stress-rail__verdict" style="color:' + v.color + ';">' + v.text + '</span></div>' +
          stressRows +
        '</div>'
      );
    } else if (f.stress.length > 0) {
      // Partial: some eras failed after the riskProfile guard — report, don't show incomplete card.
      console.warn('Historical Stress incomplete: got ' + f.stress.length + ' of ' + stressEraCount + ' eras for scenario "' + f.name + '". Check browser console for per-era errors.');
      stressBlock = (
        '<div class="stress-rail">' +
          '<div class="stress-rail__head"><span class="eyebrow" style="letter-spacing:0.16em;">Historical Stress</span></div>' +
          '<div class="stress-rail__row" style="color:var(--acc);font-size:11px;padding:8px 0;">Stress data incomplete (' + f.stress.length + '/' + stressEraCount + ' eras) — re-run the plan to resolve.</div>' +
        '</div>'
      );
    }

    const rangeBlock = (showRange && f.range) ? (
      '<div class="range">' +
        '<div class="range__head"><span class="range__label">Likely range · 10th–90th pct</span><span class="range__bounds">' + fmtMoney(f.range.lo) + ' – ' + fmtMoney(f.range.hi) + '</span></div>' +
        '<div class="range__bar"><div class="range__marker" style="left:' + (f.range.medianPct != null ? f.range.medianPct : 50) + '%;"></div></div>' +
      '</div>'
    ) : '';

    return (
      '<div class="focus">' +
        '<div class="focus__panel glass-panel" style="--tone:' + f.tone + ';">' +
          '<div class="focus__head">' +
            '<div class="focus__title"><span class="focus__dot"></span><span class="focus__name">' + esc(f.name) + '</span><span class="badge-editing">Editing</span></div>' +
          '</div>' +
          '<div class="hero">' +
            '<div class="hero__ringwrap"><span class="hero__ringlabel">Probability of Success</span>' + heroRing + '</div>' +
            '<div class="hero__right">' +
              '<div class="kicker">Median Ending Value</div>' +
              '<div class="hero__median">' + f.median + '</div>' + rangeBlock +
              '<div class="divider" style="margin:18px 0;"></div>' +
              '<div class="viability"><span class="viability__dot"></span><span class="viability__text">' + esc(f.viability || '') + '</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="divider" style="margin:24px 0 20px;"></div>' +
          '<div class="eyebrow" style="margin-bottom:18px;">Core Assumptions</div>' +
          '<div class="assum-grid">' + assum + '</div>' +
          '<div class="divider" style="margin:24px 0 18px;"></div>' +
          '<div class="goals__head"><div class="goals__title"><span class="eyebrow">Goals</span><span class="goals__count">' + activeGoals + ' active · ' + offGoals + ' off</span></div></div>' +
          goals +
        '</div>' +
        '<div class="focus__rail">' +
          '<div class="rail__head"><span class="rail__head-label">Scenarios</span><span class="rail__head-hint">tap to focus</span></div>' +
          cards + stressBlock +
        '</div>' +
      '</div>'
    );
  }


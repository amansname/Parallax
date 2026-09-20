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


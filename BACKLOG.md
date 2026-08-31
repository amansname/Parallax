# Backlog — "need to adds"

A dead-simple parking lot for future iterations. Drop a one-line bullet whenever
something comes up mid-flow; don't stop to design it. No status columns, no
process — just capture it so it isn't lost. Move an item into a real task/PR when
you're ready to build it. Newest at the top of each section.

Format: `- [YYYY-MM-DD] short description (why / context)`

## Ideas / features
- [2026-07-12] Reconsider Sequencing Playback only when its advisor purpose and
  place in the core planning flow are clear. The active panel, renderer, styling,
  and browser contract were deliberately removed before the visual-consistency PR;
  the complete prior implementation remains recoverable from Git commit `4a293b7`.
- [2026-07-07] Survivor / early-death modeling — a death-age event that, from that
  year on, cuts household expenses by a set % (survivor spends ~70–80%), drops the
  smaller of the two Social Security benefits, and flips filing status MFJ → Single,
  while the horizon stays at the survivor's plan-end age. Today plan-end age only
  shortens the horizon; it does NOT model a death (and misleadingly improves success).

## Per-spouse modeling (planned — keep the path easy)
- [2026-07-07] Per-spouse retirement ages as independent scenario levers. Input +
  engine already store/use each person's own retirement age; what's still single is
  the Scenarios `retireAge` lever (shifts both via `retireDelay`). Split it into two
  levers so each spouse can retire at a different age within a scenario. Do NOT add
  rules that assume one household retirement age.
- [2026-07-07] Per-spouse savings. Today savings is ONE household stream
  (`plan.savings.annual`, $30k/yr) that stops when the LAST spouse retires. Move to
  per-person contributions where each portion stops at that person's own retirement
  age. Keep the current single-stream comment in createDemoHousehold from hardening
  into an invariant.

## Tech debt / structure
- [2026-07-10] Thin `src/main.js` — extract to `src/household/*` and `src/scenarios/*`
  per `docs/ARCHITECTURE.md`. First target: `persistence.js` (household DB). Do alongside
  feature work, not as a standalone sprint.
- [2026-07-10] Tax engine completion — see `docs/ARCHITECTURE.md` workstreams and
  `docs/TAX-HANDOFF-2026-06-22.md` (T0–T6).
- [2026-07-10] Asset-class bucketing — `engine.js` + `src/household/resolvePortfolioAccounts.js`; the former `ui/household.js` renderer is retired.

## Flexibility / "don't trap the input"
- [2026-07-07] Spending lever range is a fixed $80k–$360k window (LEVCFG `spend`).
  Low-spend households (e.g. a $48k/yr retiree) get clamped, so a "−10%" scenario
  can't be expressed. Make the spend lever range flex to the household like the
  retirement-age fix did.
- [2026-07-07] SS claim-age lever when a benefit is already claimed — likely moot
  for already-retired households (same class as the retirement-age-inert fix). Decide
  whether to make it inert too.

## Demo data (optional polish)
- [2026-07-07] Demo currently has $0 working income while pre-retirement (64/63) with
  $30k/yr savings. Consider adding realistic pre-retirement earnings for the two
  years before they retire, if we want the accumulation phase to look real.

## Done (for reference; prune when stale)
- [2026-07-10] UI modularization (Phases 0–8). `index.html` → 255 lines markup;
  `src/main.js` boot/orchestration; `src/state.js`; `ui/*` view modules (dom,
  chartLayout, goalPalette, householdFactories, household, goals, sequencing,
  cashflow, scenarios, solver). `buildLevers` and retired `#scn-levers` code
  removed. `verify.mjs` scans html + modules. 156 tests + verify pass.
- [2026-07-07] Goals Horizon dead code removed from index.html (PR #67). Goals Ledger
  (`renderGoalsPage`, `initGoalsPage`) is the live view; icon/color constants kept.
- [2026-07-07] Retirement age goes inert once the household is already retired
  (hidden from Scenarios levers, no engine effect). Shipped + tested.
- [2026-07-07] Multi-household persistence + demo/blank factories, per-household
  scoped scenarios, New/Switch/Reset-Demo controls. Shipped + tested.

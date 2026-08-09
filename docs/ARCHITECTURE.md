# Parallax Architecture

**Authority:** `PRINCIPLES.md` wins on product doctrine. This file wins on **repo layout and where code goes**.

**Goal:** No new monoliths. `index.html` and `src/main.js` stay thin; truth lives in focused modules.

---

## Site shape (static ES modules, no bundler)

```
index.html          markup + CSS links + <script type="module" src="src/main.js">
src/main.js         boot + runAll + listeners (SHRINK — target ~200–400 lines)
src/state.js        mutable UI state + localStorage side effects (no render, no DOM)
ui/*.js             views: HTML/SVG generation, display helpers (no financial math)
src/planning/       glue between engine and tax (adapters, attach, multi-year)
src/tax/            federal Form 1040 math only (never imports engine.js)
engine.js           simulation truth only (wealth, paths, withdrawals, buckets)
styles/*.css        presentation per surface
scripts/verify.mjs  tests + browser smoke; scans index.html + src/**/*.js + ui/**/*.js
```

**Product spine (tabs):** Household → Goals → Scenarios → Tax Buckets → Sequencing (Cash Flow lives inside Scenarios).

---

## Layer rules (non-negotiable)

| Layer | Owns | Must NOT |
|-------|------|----------|
| `engine.js` | Simulation numbers, success rate, bucket balances when built | Federal tax rules, DOM, localStorage |
| `src/tax/` | Federal 1040 rules, composers, intake | `engine.js` import, DOM |
| `src/planning/tax/` | Reshape engine rows → tax input; attach summaries to analysis | Tax rule math, UI HTML |
| `src/state.js` | scenarios, replay, solver flags, ScenariosUI state | Render functions, DOM |
| `ui/*` | Render HTML/SVG; pure formatters/charts | Engine math, tax math, mutation gateways |
| `src/main.js` | Boot, tab wiring, `runAll`, call into modules | New feature logic (extract instead) |
| `index.html` | Structure, IDs, `data-page`, mount points | JavaScript (except the single main.js script tag) |

---

## Where new work goes (decision tree)

```
New work?
├─ Changes projected wealth / success rate / buckets?  → engine.js + engine.test.js
├─ Changes federal tax on a return?                    → src/tax/federal/rules/<rule>.js + test
├─ Connects engine rows to tax?                        → src/tax/adapters/ or src/planning/tax/
├─ Changes what the advisor sees?                      → ui/<surface>.js (+ styles/*.css)
├─ UI flags / scenarios / replay state?              → src/state.js
├─ Household DB / wizard / commit cascade?             → src/household/* (preferred) or extract from main.js
├─ Scenario levers / reseed / sharedPaths?           → src/scenarios/* (preferred)
└─ HTML skeleton / new mount IDs?                    → index.html (rare)
```

---

## Anti-monolith rules

1. **Never add app logic to `index.html`.** One script tag only.
2. **If a feature adds ~50+ lines to `src/main.js`, extract a module in the same PR.**
3. **One tax rule = one file** in `src/tax/federal/rules/` + colocated test + `rulesLedger.js` entry.
4. **One screen = one `ui/<surface>.js`** (+ scoped CSS). Do not create `ui/misc.js` dumping grounds.
5. **Move, don't copy.** Import existing `ui/formatters.js`, `ui/charts.js`, `ui/dom.js` — no duplicates.
6. **No new `package.json` dependencies** unless explicitly agreed.
7. **`engine.js` may stay large** — it is the single simulation truth module, test-guarded. That is not the same problem as a UI monolith.

---

## Target structure (grow into this; no big-bang rewrite)

```
src/
  main.js                 # thin entry (shrink over time)
  state.js
  household/              # extract from main.js when touched
    persistence.js        # load/save households, hydrate
    wizard.js             # renderWiz*, hhField, syncHousehold
    commit.js             # hhCommit, commitPlanEdit
  scenarios/              # extract from main.js when touched
    levers.js             # LEVCFG, leversToOverrides, planForScenario
    engine-bridge.js      # reseedScenarios, ensureSharedPaths, runAll helpers
ui/
  config/                 # static tables (LEVCFG, goal palettes) when extracted
  household.js, goals.js, scenarios.js, solver.js, cashflow.js, sequencing.js, ...
```

Extract **when you touch an area**, not as a standalone refactor sprint.

---

## Verification

| Change | Run |
|--------|-----|
| `engine.js` | `npm test` |
| `src/tax/*` | `npm test` |
| `ui/*`, `src/main.js`, `index.html` markup | `npm test` + `node scripts/verify.mjs` |
| Governance, workflow, templates, or CI | `npm run governance:check` + full required CI before merge |
| Other docs only | `npm run governance:check` when linked from governing docs; otherwise link and command checks by impact |

`verify.mjs`: HTML structure checks scan `index.html` only; JS symbol checks scan `index.html` + `src/**/*.js` + `ui/**/*.js`.

---

## Active workstreams (priority)

1. **Land UI modularization** — merge PR for `refactor/ui-modularization` branch.
2. **Tax** — T0 inventory → adapter (T1) → NIIT (T2) → spine 17–23 (T3) → benchmark (T4) → UI (T5). See `docs/TAX-HANDOFF-2026-06-22.md`.
3. **Thin `main.js`** — alongside features: `src/household/persistence.js` first (low risk).
4. **Asset bucketing** — `engine.js` + tests, then `ui/household.js` inputs, then scenarios/CF display. Start after tax adapter (T1) is stable.

**Deferred decision:** Replace engine `row.taxes` with federal tax vs keep parallel compare — decide after tax benchmark (T4), not before.

---

## Handoff block (paste at start of new AI sessions)

```
PARALLAX ARCHITECTURE — read docs/ARCHITECTURE.md and PRINCIPLES.md.

Repo: static ES modules, no bundler. index.html = markup only. src/main.js = thin boot (do not grow). Truth: engine.js (sim), src/tax/ (federal). Views: ui/*. State: src/state.js.

Rules: no math in UI, no tax in engine, no DOM in tax, one module per rule/view, extract from main.js if >50 lines, npm test (+ verify.mjs for UI).
```

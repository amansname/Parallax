# Parallax Architecture

**Authority:** `PRINCIPLES.md` wins on product doctrine. This file wins on **repo layout and where code goes**.

**Goal:** No new monoliths. `index.html` stays thin. `src/main.js` is a legacy composition root that remains larger than the target architecture; do not grow it, and extract touched logic into focused modules.

---

## Site shape (static ES modules, no bundler)

```
index.html          markup + CSS links + <script type="module" src="src/main.js">
src/main.js         legacy composition root: boot + runAll + listeners (SHRINK when touched)
src/state.js        mutable UI state + localStorage side effects (no render, no DOM)
ui/*.js             views: HTML/SVG generation, display helpers (no financial math)
src/household/      Household Facts with provenance/readiness, schemas, persistence, migrations
src/planning/       orchestration between Projection Engine and Tax Engine; no substitute math
src/tax/            Tax Engine: federal Form 1040 math (never imports engine.js)
engine.js           Projection Engine public entry and logical authority
styles/*.css        presentation per surface
scripts/verify.mjs  tests + browser smoke; scans index.html + src/**/*.js + ui/**/*.js
```

**Product spine (tabs):** Household → Goals → Scenarios → Withdrawal Planner → Sequencing (Cash Flow lives inside Scenarios).

Parallax has two authoritative calculation engines. The **Projection Engine**
owns projection, simulation, wealth-path, withdrawal, RMD, inflation,
goal-funding, and portfolio-bucket calculations. The **Tax Engine** owns federal
tax calculations. Planning modules connect and orchestrate the two without
creating substitute math. Household Facts carry provenance and readiness;
contractually ready facts are verified engine inputs, assumptions remain
explicit, and unresolved required facts fail closed. UI modules collect the
facts and present traceable results.

The Projection Engine is one logical and public authority. `engine.js` remains
its public entry point; focused internal modularization is allowed when public
behavior and result parity are preserved.

---

## Layer rules (non-negotiable)

| Layer | Owns | Must NOT |
|-------|------|----------|
| `engine.js` | Projection Engine public contract: simulation, success rate, wealth paths, withdrawals, RMD, inflation, goal funding, bucket balances | Federal tax rules, DOM, localStorage |
| `src/tax/` | Tax Engine: federal 1040 rules, composers, intake | `engine.js` import, DOM |
| `src/planning/tax/` | Orchestrate Projection Engine rows → Tax Engine inputs; attach tax results to analysis | Projection or tax rule math, UI HTML |
| `src/household/` | Household Facts with provenance/readiness, schemas, persistence, migrations, wizard contracts | Projection or tax calculations, UI presentation |
| `src/state.js` | scenarios, replay, solver flags, ScenariosUI state | Render functions, DOM |
| `ui/*` | Render HTML/SVG; pure formatters/charts | Engine math, tax math, mutation gateways |
| `src/main.js` | Legacy composition root: boot, tab wiring, `runAll`, calls into modules | New feature logic or further growth (extract instead) |
| `index.html` | Structure, IDs, `data-page`, mount points | JavaScript (except the single main.js script tag) |

---

## Where new work goes (decision tree)

```
New work?
├─ Changes projected wealth / success rate / buckets?  → Projection Engine public contract + tests
├─ Changes federal tax on a return?                    → Tax Engine rule + test
├─ Connects Projection Engine rows to Tax Engine?      → src/planning/tax/
├─ Normalizes Tax Engine-owned input shapes only?      → src/tax/adapters/
├─ Changes what the advisor sees?                      → ui/<surface>.js (+ styles/*.css)
├─ UI flags / scenarios / replay state?              → src/state.js
├─ Household Facts / DB / wizard / commit cascade?     → src/household/* (preferred) or extract from main.js
├─ Scenario levers / reseed / sharedPaths?           → src/scenarios/* (preferred)
└─ HTML skeleton / new mount IDs?                    → index.html (rare)
```

---

## Anti-monolith rules

1. **Never add app logic to `index.html`.** One script tag only.
2. **Do not add feature logic to `src/main.js`.** Extract touched feature logic into the owning module in the same PR.
3. **One tax rule = one file** in `src/tax/federal/rules/` + colocated test + `rulesLedger.js` entry.
4. **One screen = one `ui/<surface>.js`** (+ scoped CSS). Do not create `ui/misc.js` dumping grounds.
5. **Move, don't copy.** Import existing `ui/formatters.js`, `ui/charts.js`, `ui/dom.js` — no duplicates.
6. **No new `package.json` dependencies** unless explicitly agreed.
7. **The Projection Engine may be modularized safely** — `engine.js` remains its logical public authority, and internal extraction must preserve behavior and result parity.

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

## Current architectural direction

1. **Shrink legacy `main.js` when touched** — move feature logic and orchestration into the owning focused module.
2. **Preserve the two-engine boundary** — the Tax Engine owns federal tax rules; the Projection Engine may consume and fund authoritative Tax Engine results without implementing federal tax rule math.
3. **Preserve public Projection Engine parity** — internal extraction is safe only when the public behavior and result contract remains unchanged.

---

## Handoff block (paste at start of new AI sessions)

```
PARALLAX ARCHITECTURE — read docs/ARCHITECTURE.md and PRINCIPLES.md.

Repo: static ES modules, no bundler. index.html = markup only. src/main.js = legacy composition root (do not grow; extract when touched). Projection Engine: engine.js public contract. Tax Engine: src/tax/. Planning orchestrates both without substitute math. Household Facts: src/household/. Views: ui/*. State: src/state.js.

Rules: no math in UI, no federal tax rule math in the Projection Engine, no DOM in tax, one module per rule/view, no feature-logic growth in main.js, npm test (+ verify.mjs for UI). The Projection Engine may consume and fund authoritative Tax Engine results.
```

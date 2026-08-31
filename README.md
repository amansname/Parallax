# Parallax

Parallax is an advisor-led retirement decision simulator. Two authoritative
calculation engines show how client choices behave across simulated and real
historical market paths and under federal tax rules.

`PRINCIPLES.md` is the active doctrine. If anything in this repo — including
this file — conflicts with it, `PRINCIPLES.md` wins.

## Product Spine

Five primary surfaces, nothing else unless it exposes calculation-engine truth
or helps an advisor explain a client decision:

- Household: collect Household Facts with explicit provenance/readiness about
  people, assets, income, liabilities, tax inputs, and assumptions. Ready facts
  become verified engine inputs; assumptions remain explicit.
- Goals: define the spending and timing the plan must fund.
- Scenarios: compare planning choices on the same market paths, so differences
  come from the decision, not simulation noise. Cash Flow lives inside
  Scenarios as the year-by-year ledger behind the selected result.
- Withdrawal Planner: evaluate current federal-tax effects through the Tax
  Engine using the selected household's verified facts.
- Sequencing: run the same plan through real markets such as 1966, 1973, 2000,
  and 2008.

## Repository Layout

- `engine.js` — the public entry point and logical authority for the Projection
  Engine: simulation, wealth paths, withdrawals, RMDs, goal funding, and
  portfolio buckets.
- `src/tax/` — the Tax Engine authority for federal tax calculations.
- `src/planning/` — adapters and orchestration between the Projection Engine,
  Tax Engine, and views; it owns no substitute financial math.
- `src/household/` — Household Facts with provenance/readiness, schemas,
  persistence, migrations, and wizard contracts.
- Projection Engine internals may be modularized safely, but `engine.js`
  remains the logical public authority and public behavior/result parity must
  be preserved. Do not change either engine's math without explicit agreement
  and tests.
- `test/engine/` — Node contract suites guarding the engine, included in
  `npm test` and the required CI unit job. See [test/README.md](test/README.md)
  for test discovery and organization.
- `index.html` — app markup and styles. Loads `src/main.js` as the sole ES module
  entry; must be served over HTTP (as `scripts/verify.mjs` and GitHub Pages do),
  not opened via `file://`.
- `src/main.js` — the legacy composition root for UI boot, `runAll`, and event
  wiring. It remains larger than the target architecture; do not grow it, and
  extract touched feature logic into focused modules.
- `src/state.js` — mutable UI state (scenarios, replay, solver flags).
- `ui/*.js` — view modules (household, goals, scenarios, cashflow, sequencing, etc.).
- `scripts/verify.mjs` — visual verification: runs the full `npm test` suite, serves
  the exact committed site artifact, drives headless Chromium through it, and writes
  screenshots to `verify-out/`. Requires Chrome (or `npx puppeteer browsers install chrome`).
- `assets/` — the logo.
- `PRINCIPLES.md` — doctrine.
- `docs/ARCHITECTURE.md` — **where code goes; anti-monolith rules; all agents read this.**
- `docs/CODEX_WORKFLOW.md` — required engineering, regression, evidence, and merge lifecycle.
- `docs/CODE_REVIEW.md` — independent review procedure against `main`.

## Commands

```bash
npm ci                    # install dev dependencies (puppeteer)
npm run governance:check  # validate governing docs, PR/CI contracts, links, and persisted fixtures
npm test                  # engine tests
npm run verify            # full browser verification + screenshots
npm run preview           # canonical manual preview at http://127.0.0.1:8825/
npm run site:build        # immutable site artifact from the clean HEAD commit
npm run site:verify       # verify every artifact byte and its commit attestation
```

## Shipping

GitHub Pages deploys the immutable commit artifact only after the complete
`Parallax quality` workflow succeeds on `main`, then compares every live byte to
the artifact manifest. Required CI exposes separate Governance safeguards, Unit
tests, and Full browser verification checks. See
[`docs/DEPLOYMENT-INTEGRITY.md`](docs/DEPLOYMENT-INTEGRITY.md).

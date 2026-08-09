# Parallax

Parallax is an advisor-led retirement decision simulator. One protected engine
shows how client choices behave across simulated and real historical market
paths.

`PRINCIPLES.md` is the active doctrine. If anything in this repo — including
this file — conflicts with it, `PRINCIPLES.md` wins.

## Product Spine

Four surfaces, nothing else unless it exposes engine truth or helps an advisor
explain a client decision:

- Household / Plan inputs: household, assets, income, expenses, goals,
  liabilities, assumptions.
- Scenarios: compare planning choices on the same market paths, so differences
  come from the decision, not simulation noise.
- Sequencing: run the same plan through real markets such as 1966, 1973, 2000,
  and 2008.
- Cash-flow detail: the year-by-year ledger that proves where the result came
  from.

## Repository Layout

- `engine.js` — the financial engine. The only source of financial truth.
  Do not change engine math without explicit agreement and tests.
- `engine.test.js` — Node test suite guarding the engine. Runs in CI on every
  push (`.github/workflows/test.yml`).
- `index.html` — app markup and styles. Loads `src/main.js` as the sole ES module
  entry; must be served over HTTP (as `scripts/verify.mjs` and GitHub Pages do),
  not opened via `file://`.
- `src/main.js` — UI boot, orchestration (`runAll`), and wiring to `engine.js`.
- `src/state.js` — mutable UI state (scenarios, replay, solver flags).
- `ui/*.js` — view modules (household, goals, scenarios, cashflow, sequencing, etc.).
- `scripts/verify.mjs` — visual verification: runs the full `npm test` suite, serves
  the repo, drives headless Chromium through `index.html`, and writes
  screenshots to `verify-out/`. Requires Chrome (or `npx puppeteer browsers install chrome`).
- `assets/` — the logo.
- `PRINCIPLES.md` — doctrine.
- `docs/ARCHITECTURE.md` — **where code goes; anti-monolith rules; all agents read this.**
- `docs/CODEX_WORKFLOW.md` — required engineering, regression, evidence, and merge lifecycle.
- `docs/CODE_REVIEW.md` — independent review procedure against `main`.

## Commands

```bash
npm ci                    # install dev dependencies (puppeteer)
npm run governance:check # validate governing docs, PR/CI contracts, links, and persisted fixtures
npm test                  # engine tests
npm run verify            # full browser verification + screenshots
npm run preview           # canonical manual preview at http://127.0.0.1:8825/
```

## Shipping

GitHub Pages serves `main` from the repository root; `index.html` is the live
entry file. Required CI exposes separate Governance safeguards, Unit tests, and
Full browser verification checks. Follow `docs/CODEX_WORKFLOW.md`; a deployment
is availability evidence and does not prove behavior.

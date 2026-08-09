# Parallax repository instructions

These instructions govern every contributor and coding agent. Read
[PRINCIPLES.md](PRINCIPLES.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
and [docs/EXECUTION-PROTOCOL.md](docs/EXECUTION-PROTOCOL.md) before changing
the repository. Follow the full lifecycle in
[docs/CODEX_WORKFLOW.md](docs/CODEX_WORKFLOW.md) and the independent-review
procedure in [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md).

## Repository map and boundaries

Parallax is a static ES-module application with no build step or backend.

| Path | Authority |
|---|---|
| `index.html` | Markup and mount points only. It loads only `src/main.js`. |
| `src/main.js` | Thin boot, `runAll`, and event wiring. Extract feature logic if a change would add about 50 lines. |
| `src/state.js` | Mutable UI state and persistence effects; no rendering. |
| `ui/*.js` | Display and DOM modules; no financial calculations. |
| `engine.js` | Sole source of truth for simulation, wealth, paths, withdrawals, and bucket math. |
| `src/tax/` | Federal tax truth; never imports `engine.js`. |
| `src/planning/` | Adapters and orchestration between engine, tax, and views; no substitute tax math. |
| `src/household/` | Household schemas, persistence, migrations, and wizard contracts. |
| `src/scenarios/` | Scenario inputs and scenario-to-engine orchestration. |
| `scripts/verify.mjs` | Required full live-browser compatibility gate at the canonical origin. |

`engine.js` is the sole financial source of truth. UI code must not invent or
duplicate tax, RMD, withdrawal, inflation, goal, or cash-flow calculations.
Do not add JavaScript to `index.html`, grow a new monolith, or add a dependency
without explicit agreement.

## Commands

Run commands from the repository root.

```text
npm ci                         install the locked development dependencies
npm test                       full unit suite
npm run verify                 full browser verifier and screenshots
npm run governance:check       repository-governance and static checks
npm run preview                manual preview at http://127.0.0.1:8825/
```

There is no build, lint, or formatter command. Do not claim one ran. The app
must be served over HTTP. Port 8825 is the only local origin: if it is occupied,
identify and stop the stale Parallax preview instead of selecting another port.

## Working rules

- Begin read-only. Before editing, record the repository root, worktree,
  branch, base and current commit SHAs, remotes, and dirty paths. Preserve user
  work. Use one feature or fix per branch, isolated worktree, and pull request.
- Reproduce every reported symptom through its actual visible-input and saved-
  state path before editing. Record the exact command, fixture kind (clean or
  persisted/legacy), and observed failure.
- Create an acceptance-matrix row for every reported symptom. A regression
  test must fail on the base commit for the reported reason and pass on the
  branch. A test-only change improves coverage; it is not a product fix.
- Implement the smallest production change that reaches the responsible code
  path. Scope expansion requires an explanation and material expansion requires
  user approval.
- Never weaken an assertion, delete or sanitize the triggering state, add a
  timing sleep, suppress an exit code, or change an expectation merely to make
  a check green. An expectation or fixture change needs a documented product-
  contract reason.
- Browser defects require live-browser assertions of the user-visible outcome.
  Control values, labels, element existence, slider maxima, and screenshots do
  not prove that dependent financial outputs changed.
- Persisted-state and migration regressions load anonymized state exactly as
  saved. A migration test must not delete or reseed the state under test. Keep
  clean-state and legacy-state fixtures separate.
- Report unavailable results, missing facts, errors, and reason codes directly.
  Do not accept blank columns, generic dashes, invented zeros, swallowed errors,
  or stale fallbacks as evidence of correctness.
- Use deterministic readiness signals and live DOM or a standards-based parser.
  The bounded legacy exceptions in `scripts/verify.mjs` remain governed by
  `docs/EXECUTION-PROTOCOL.md` section 8 and may not be expanded.

## Risk and required evidence

Financial engine, federal tax, RMD, withdrawal, persistence, migration, Goals,
Scenarios, and Cash Flow changes are high risk. They require focused tests,
applicable cross-surface invariants, `npm test`, `npm run verify`, and an
independent review against `main`. Persistence and migration work also requires
both clean-state and exact legacy-state evidence. Docs, templates, and CI-only
changes require `npm run governance:check`, `git diff --check`, link/command
validation, and the full required CI suite before merge.

Protected product contracts include the Withdrawal Planner's smaller-of-engine-
limit-and-$500,000 display ceiling and scenario-relative resolution of a
`startsAtRetirement: true` goal's start age. Their complete preservation and
test requirements live in `docs/CODEX_WORKFLOW.md`.

## Definition of done and PR evidence

Work is done only when every acceptance row is complete; the base failure and
branch result are recorded; targeted and full required checks succeed; the full
diff is reviewed against `main`; no production behavior outside scope changed;
and a separate reviewer completed `docs/CODE_REVIEW.md`. A deployment is only
availability evidence, never behavioral proof.

Every PR must include base and branch SHAs, exact reproduction, root cause,
production files changed, fail-before/pass-after evidence, exact commands and
actual results, fixture provenance, financial invariants, known failures, proof
gaps, scope exclusions, rollback notes, and independent-review status. Do not
use “fixed,” “complete,” “passing,” or “merge-ready” while any required check or
acceptance row is unresolved. State limitations and unverified behavior plainly.

## Code Review Rules

- Review against `main` and the original reported symptoms, acceptance matrix,
  and PR claims—not only the latest commit or conversation.
- Confirm the production change reaches the responsible engine/controller/view
  path and that suspicious untouched paths were examined.
- For financial UI work, verify applicable cross-surface invariants and visible
  financial outcomes using exact persisted-state conditions.
- Reject swallowed errors, generic unavailable states without actionable reason,
  fixture sanitization, shared faulty dependencies presented as independent
  evidence, test-only “fixes,” and deployment presented as correctness.
- Perform the first review read-only, report severity plus file/line evidence,
  and require re-review after fixes. The authoring session cannot self-certify;
  use a separate `/review` against `main` or `@codex review`.

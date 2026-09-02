# Parallax repository instructions

These instructions govern every contributor and coding agent. Read
[PRINCIPLES.md](PRINCIPLES.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
and [docs/EXECUTION-PROTOCOL.md](docs/EXECUTION-PROTOCOL.md) before changing
the repository. Follow the full lifecycle in
[docs/CODEX_WORKFLOW.md](docs/CODEX_WORKFLOW.md) and the independent-review
procedure in [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md).

For every Parallax task, start the workflow on the first response and show its
compact Scope receipt. Do not wait for the user to invoke it or select a tier.

## Repository map and boundaries

Parallax is a static ES-module application with no build step or backend.

| Path | Authority |
|---|---|
| `index.html` | Markup and mount points only. It loads only `src/main.js`. |
| `src/main.js` | Legacy composition root for boot, `runAll`, and event wiring. It remains larger than the target architecture: do not grow it, and extract touched feature logic. |
| `src/state.js` | Mutable UI state and persistence effects; no rendering. |
| `ui/*.js` | Display and DOM modules; no financial calculations. |
| `engine.js` | Public entry point and logical authority for the Projection Engine: simulation, wealth paths, withdrawals, and bucket math. |
| `src/projection/engine/` | Internal Projection Engine implementation. Preserve the public `engine.js` interface and result parity. |
| `src/tax/` | Tax Engine authority for federal tax calculations; never imports `engine.js`. |
| `src/planning/` | Adapters and orchestration between the Projection Engine, Tax Engine, and views; no substitute financial math. |
| `src/household/` | Household Facts with provenance/readiness, schemas, persistence, migrations, and wizard contracts. |
| `src/scenarios/` | Scenario inputs and scenario-to-engine orchestration. |
| `scripts/verify.mjs` | Required full live-browser compatibility gate at the canonical origin. |

Parallax has two authoritative calculation engines. The Projection Engine owns
projection, simulation, wealth-path, withdrawal, RMD, inflation, goal-funding,
and bucket calculations. The Tax Engine owns federal tax calculations.
`src/planning/` connects and orchestrates those engines without creating
substitute math. Household Facts carry provenance and readiness. Contractually
ready facts are verified inputs to the engines; assumptions remain explicit,
and unresolved required facts fail closed. UI code collects those facts and
presents traceable results without inventing or duplicating calculations.

The Projection Engine remains one logical and public authority even when its
implementation is safely split into focused internal modules. Such
modularization must preserve behavior and result parity at the public boundary.
Do not add JavaScript to `index.html`, grow a new monolith, or add a dependency
without explicit agreement.

## Commands

Run commands from the repository root.

```text
npm ci                         install the locked development dependencies
npm test                       full unit suite
npm run test:inventory          discovered test files and execution categories
npm run lint                    report JavaScript errors and unused variables
npm run lint:changed            enforce ESLint on JavaScript changed from origin/main
npm run verify                 full browser verifier and screenshots
npm run governance:check       repository-governance and static checks
npm run preview                manual preview at http://127.0.0.1:8825/
npm run site:build             immutable site artifact from the clean HEAD commit
npm run site:verify            verify the artifact manifest and commit receipt
```

Full-repository lint remains report-only; pull requests enforce ESLint on every
changed JavaScript file. See `docs/LINTING.md`. There is no formatter command.
The app must be served over HTTP. Port
8825 is the only local origin: if it is occupied, identify and stop the stale
Parallax preview instead of selecting another port. Preview and browser
verification must serve the immutable artifact from the exact candidate commit;
they must never serve mutable worktree files.

## Working rules

- Begin read-only. Before editing, record the repository root, worktree,
  branch, base and current commit SHAs, remotes, and dirty paths. Preserve user
  work. Use one feature or fix per branch, isolated worktree, and pull request.
- Delivery PRs and their commits use `parallax-pr-author-amans[bot]`; request
  `amansname` as the human reviewer before calling the draft ready.
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
- Visible UI changes require an exact allowed inventory plus explicit absences.
  When configuration becomes state-dependent or an old conditional can become
  reachable, test complete ordered outputs for every affected state; a subset
  or presence-only assertion is insufficient.
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

Use the automatic Tier 1 Fast, Tier 2 Standard, and Tier 3 Protected routing in
`docs/CODEX_WORKFLOW.md`. The highest-risk trigger in a proposed PR controls the
whole PR unless genuinely independent work is split. Risk scales additional
local and gatekeeper evidence; it never bypasses required GitHub checks,
review, conversation resolution, exact-ref verification, or mergeability.

Projection Engine, Tax Engine, RMD, withdrawal, allocation, persistence-shape,
migration, financial-result, security, CI/deployment, repository-governance,
and cross-authority changes are Tier 3. Goals, Scenarios, Cash Flow, household,
or UI work is Tier 2 only when protected calculations, saved-data contracts,
migrations, and financial policy remain unchanged. Tier 3 requires focused
tests, applicable cross-surface invariants, `npm run lint:changed`, `npm test`,
`npm run verify`, and an independent review against `main`. Persistence and
migration work also requires clean-state and exact legacy-state evidence. Tier 1 docs, non-governance
templates, copy, and
strictly non-behavioral changes require `npm run governance:check`,
`git diff --check`, applicable focused/rendered proof, and the full required CI
suite before merge.

Protected product contracts include the Withdrawal Planner's smaller-of-engine-
limit-and-$500,000 display ceiling and scenario-relative resolution of a
`startsAtRetirement: true` goal's start age. Their complete preservation and
test requirements live in `docs/CODEX_WORKFLOW.md`.

## Definition of done and PR evidence

Work is done only when every acceptance row is complete; applicable base or
starting-state evidence and the candidate result are recorded; targeted and
full required checks succeed; the full diff is reviewed against `main`; no
production behavior outside scope changed; and a separate reviewer completed
`docs/CODE_REVIEW.md`. Use the lifecycle-plus-hold model and two owner decision
points in `docs/CODEX_WORKFLOW.md`. A changed candidate SHA invalidates prior
acceptance and merge authorization. A deployment is only availability evidence,
never behavioral proof. Shipping additionally requires the candidate-to-merge-
commit-to-artifact identity chain and live-byte receipt in
`docs/DEPLOYMENT-INTEGRITY.md`.

Every PR must include its classification, base and candidate SHAs, scope,
acceptance evidence, implementation authority, exact commands and results,
required CI status, known failures, proof gaps, rollback notes, and independent-
review status. Defects additionally require exact reproduction, root cause, and
fail-before/pass-after proof. Tier 3 adds the applicable financial, tax,
persistence, migration, compatibility, security, or deployment evidence. Do not
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

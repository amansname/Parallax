# Repository cleanup

This records the cleanup order approved on August 31, 2026 after reviewing
CodeScene, SonarQube, Knip, Stryker, and the local ESLint baseline. The reports
analyzed commit `95aed5462a1b36c8446daaf60d4624460ba9f9aa`; recheck findings
against each implementation baseline. This document does not authorize
publication or replace the repository's verification and review requirements.

## Order and acceptance ledger

| Request | Status | Acceptance evidence |
|---|---|---|
| 1. Retire verified legacy code with obsolete tests | First local checkpoint verified | No active entry-point path reaches the removed modules; replacement tests and existing account assertions remain. Unit, governance, and full browser verification passed at `e33d596`. |
| 2. Reliable test discovery and smaller verification/test modules | Verified locally at `2496cda` | All 147 original engine cases and ten helper declarations preserve their ASTs. The 35-step browser campaign passed, including the merged Goals fix; 321 throw assertions and 842 callbacks remain. |
| 3. Smaller engine responsibilities | Local extraction implemented; browser verification pending | All 84 declarations and the public export list are preserved. Each extraction matches 365 fixed-input results/failure responses and passes all 909 unit tests. |
| 4. Smaller startup and household action dispatch | Pending | Preserve orchestration order, saved-state behavior, and visible results. |
| 5. Smaller duplication, stale exports, and outdated documentation | Pending | Remove only verified redundancy; preserve distinct boundary cases and calculation semantics. |

There is no target for reducing the number of tests or files. Meaningful
coverage, clear ownership, and unchanged behavior determine what stays.

## First legacy-retirement bundle

| Removed file | Reason and retained authority |
|---|---|
| `ui/household.js` | Old blueprint/rail renderer family. Its only importer was an account test using a one-line `investableTotal` wrapper. Current wizard rendering lives in `ui/householdWizard*.js`; account totals remain in `src/household/resolvePortfolioAccounts.js`. |
| `ui/householdIncomeTax.js` | Old renderer imported only by its disconnected test. The current wizard routes Tax to `ui/householdWizardTax.js`. |
| `ui/householdIncomeTax.test.js` | Five tests for that retired renderer, absent from the unit command and failing against obsolete controls/vocabularies. They are retired with their subject, not reconnected or weakened to pass. |
| `ui/householdSpendingGoals.js` | No callers. Current Goals behavior is implemented by `ui/goalsHorizon.js` and its model/controller. |
| `src/planning/taxBuckets/withdrawalPlannerUiState.js` | No callers of either state helper. The live Withdrawal Planner controller maintains its own ephemeral state in `ui/taxAwareWithdrawal.js`. |

All removed bytes remain recoverable from the baseline commit. No migration,
stored household shape, active renderer, financial calculation, or public
engine/tax export was changed.

The account test still asserts the exact total balance, engine and Tax Buckets
balances, excluded/pending balances, account IDs, and issue codes. Only the
assertion that called the retired wrapper was removed. The artifact allowlist
test now uses the existing wizard module as its representative UI path, with
the same expected result.

Retained replacement coverage includes:

- `ui/householdWizard.test.js`: four-step wizard, current Tax fields and order,
  canonical portfolio total, and Summary behavior.
- `src/household/wizardIncomeTaxSummary.test.js`: tax-readiness and saved-fact
  handling without inventing missing income.
- `ui/goalsHorizon.test.js`: retirement-linked goals and current controller
  behavior.
- `ui/taxAwareWithdrawalColumns.test.js`: engine-derived limits, zero capacity,
  rendered columns, and unavailable-result handling.
- `src/household/resolvePortfolioAccounts.test.js`: canonical account folding,
  classification, ownership-related inputs, allocation, and malformed balances.
- Existing browser verifier and wizard contracts: unchanged and still required
  for delivery after the candidate is committed.

The removed tests described a superseded interface; the current tests do not
promise to recreate every old control. Existing scheduled test files and
commands remain unchanged. The separate manual screenshot utility
`scripts/capture-wizard.mjs` remains; lack of a package-script caller alone is
not a valid reason to delete it. Broader tax-detail and legacy orchestration
groups remain for separate contract and caller review.

The local ESLint setup remains a separate tooling branch. Its pinned executable
and configuration can inspect this bundle without adding dependencies or
changing CI. Lint findings do not authorize automatic fixes or test deletion.

## Test-discovery and engine-test checkpoint

The implementation baseline is now `5a56edc`, including the merged Goals fix,
with the first retirement patch carried forward at `f9a138b`. The baseline has
906 passing unit tests (24 pretests and 882 main tests).

`npm test` now discovers tests automatically. Explicit pretest and governance
commands retain their existing order and scope. Three regression checks prove
new-file discovery, rejection of stale/overlapping exclusions, and propagation
of a newly added failing test's nonzero exit. The resulting suite has 909
passing tests; no former scheduled case was dropped.

The former 4,222-line `engine.test.js` is divided into 14 contract suites under
`test/engine/`. Three shared fixture factories live in `fixtures.js`; seven
single-suite helpers remain with their tests. All 147 test bodies, ten helper
declarations, and their financial expectations are structurally identical;
only two relative dynamic-import paths needed relocation. Explanatory comments
are retained. Production JavaScript, persisted fixtures, and the merged Goals
fix are unchanged by this checkpoint. See `test/README.md` for usage.

## Browser-verifier extraction checkpoint

The verifier entry point now owns setup and campaign order; feature assertions
live under `scripts/browser/`. The wizard coordinator retains its public
exports and exact storage-restoration procedure. Cash Flow is divided by
fixture setup, Typical view, scenario selection, historical snapshots,
presentation, metrics, goal edits, underfunding, and reload/restoration.

Syntax-tree comparison preserves all 35 ordered campaign labels, all 321 throw
statements, all 842 non-step function callbacks, and all 48 wizard declarations.
The created Withdrawal Planner household ID is returned explicitly to the
campaign instead of being assigned through a cross-module global. Cash Flow
phases return only the observations needed by later phases. Browser-relative
dynamic imports remain unchanged; only Node module imports are relocated.

No assertions, saved fixtures, waiting conditions, timeouts, or financial
expectations are weakened. No production module or merged Goals-fix file is
changed. Governance checks pass. Full browser verification must run against
the committed extraction before this local checkpoint is considered verified.

## Engine boundaries

The engine was extracted in separate timeline/execution, ownership/RMD,
input/Withdrawal Planner, and simulation/funding checkpoints. `engine.js`
remains the public interface; implementation modules live in
`src/projection/engine/`. No caller was redirected to a substitute engine.
The shared default-plan object and private random stream remain singletons.

All 84 original declarations and the public export declaration match the
pre-extraction syntax trees. A separate fixed-input probe matches 365 baseline
responses, including complete output hashes for ordinary, historical, federal,
owner-account, withdrawal, timeline, and unavailable-state cases. Every local
checkpoint also passes all 909 scheduled unit tests.

An intermediate probe run exposed a filename collision in its own scratch
outputs. The input fixture was recovered from the untouched original engine
checkout and verified against the preserved original result hashes before the
candidate was compared again. No product or expected-result change was used to
resolve that probe failure.

The large algorithms retain their existing internals. This establishes coherent
module boundaries and a small public entry point; it is not a claim that every
function's cognitive complexity is resolved or that cloud scan scores improved.

The browser extraction passed the full campaign at `2496cda`; the engine
extraction passed it at `40d9b1c`, including the merged Goals presentation fix.
These are separate immutable local checkpoints, not published or live changes.

## Startup and household action boundaries

Scenario configuration, historical orchestration, projection messages, and
scenario goal overrides now live in their owning `src/` modules. The existing
Compare/Focus/Cash Flow view installer lives in `ui/scenariosController.js`.
It runs at the same point in startup, receives stable service dependencies, and
imports mutable shared state through live module bindings. The pristine plan
snapshot, household hydration, persistence, migrations, and boot order remain
in the composition root. `src/main.js` is reduced to 942 lines; its 90 original
top-level declarations are preserved across the new locations.

The household editor retains one guarded commit/error boundary. Its five input
callbacks and all 21 click-action bodies are unchanged, with actions grouped
into navigation, net-worth views, net-worth mutations, family, and tax modules.
Disabled controls and unknown actions still do nothing. No validation or saved
data contract is changed. The source comparison preserves the view installer
body apart from explicit dependency binding.

All 909 unit tests and 63 governance checks pass locally. Full browser
verification is required on this committed checkpoint. Existing lint findings
are recorded rather than suppressed; their cleanup is a separate final pass.

## Final bounded cleanup

The startup checkpoint is `40d40b4`. Its browser campaign was interrupted when
another local task replaced the process on port 8825; that run is not a pass.
The final candidate must run the complete campaign, covering both this
checkpoint and the following smaller changes.

- Removed 13 unexported functions: ten obsolete aggregate-account helpers,
  the disconnected scenario-reset function, and two unused static-source
  scanner helpers. Scope-aware reference checks found no callers outside each
  removed group. Current account-ledger and RMD paths remain unchanged.
- Removed the unused transitional taxable-gain alias, retaining the canonical
  function. Simplified the audited identical tax-expression branches without
  changing their result. Removed three unused named imports.
- Associated the existing Sequencing `Plan` text with its selector. The visible
  text, class, control, and layout are unchanged; the browser contract now
  requires exactly one associated label. The immutable pre-fix artifact showed
  a visible selector with zero associated labels.
- Added two return-validation cases for non-object rows and inherited asset
  observations. All former test assertions remain. A disposable-copy Stryker
  run on the same 43 mutations caught 38, up from 30; five remain (four error
  strings and one redundant type guard). This is a targeted pilot, not a
  whole-repository score.
- Integrated the separately approved ESLint setup, keeping all 30 previously
  locked dependencies unchanged. It adds 71 development dependency packages
  and remains report-only, with no CI, editor, or scheduler changes. Ten browser
  error wrappers now retain their original exception as `cause`; their messages
  and failure behavior are unchanged.
- Updated current architecture paths and corrected comments that named retired
  helpers. Historical design handoffs remain marked historical rather than
  being rewritten as current architecture.

The final local unit run passes 911 tests (24 pretests plus 887 discovered
tests), and all 63 governance checks pass. The fixed-input engine probe still
matches all 365 original responses. ESLint reports 19 errors and 34 warnings;
its nonzero exit is retained. Remaining findings include existing empty
best-effort storage catches, overwritten initial values, intentional control-
character matching, and unused bindings. These need individual decisions, not
a bulk autofix or weaker rules.

With the same explicit test-entry scope, Knip reports one deliberately retained
manual capture utility, no duplicate exports, and no dependency findings.
Export warnings remain for individually reviewable APIs. Browser-relative
imports yield more file-level warnings after extraction because formerly
shared files are now separate; they are not silently suppressed.

Local commits do not authorize publication. No push, PR, merge, deployment,
Sonar settings change, or cloud rescan is part of this bundle. Independent
review and required CI remain delivery requirements. Some internal engine
algorithms and the Scenarios view installer are still large; lowering their
complexity further is follow-up work, not an outcome claimed by this extraction.

# Repository cleanup

This records the cleanup order approved on August 31, 2026 after reviewing
CodeScene, SonarQube, Knip, Stryker, and the local ESLint baseline. The reports
analyzed commit `95aed5462a1b36c8446daaf60d4624460ba9f9aa`; recheck findings
against each implementation baseline. This document does not authorize
publication or replace the repository's verification and review requirements.

## Order and acceptance ledger

| Request | Status | Acceptance evidence |
|---|---|---|
| 1. Retire verified legacy code with obsolete tests | First bundle implemented; delivery verification pending | No active entry-point path reaches the removed modules; replacement tests and existing account assertions remain. |
| 2. Reliable test discovery and smaller verification/test modules | Pending | Every intended test is discovered; preserve assertions, fixtures, transitions, and failure signals during extraction. |
| 3. Smaller engine responsibilities | Pending | Preserve the public engine interface and deterministic result parity across account, timeline, and simulation boundaries. |
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

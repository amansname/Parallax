# Parker historical account handoff repair

This document records the pre-freeze implementation checkpoint. The owner has
subsequently authorized exact-commit browser testing and bot-authored draft PR
delivery. Commit-bound browser/command receipts and current delivery status
belong in the PR evidence; the earlier results below are not a claim that those
later gates have already passed.

## Browser-discovered correction before publication

The first frozen candidate was `2e67dea51043bd7d2eeefb695a852dac2df8605c`.
It passed 873 unit tests plus 24 tax pretests and the full browser verifier.
Native-browser acceptance also covered all nine historical periods and Typical,
all six allocation overrides, the already-retired boundary, Net Worth allocation
propagation, and Sequencing reconciliation. It then exposed a second defect in
the working-household alternate-plan case: Typical selected Baseline's p50
market index while historical accumulation selected the alternate's own p50.
Changing path therefore changed the already-displayed working years.

The correction carries the same selected simulation from the controller into
the historical builder/cache. The engine retains detailed account snapshots for
that one additionally selected market index; all other internal trials stay
compact. The production federal runner forwards this explicit selection.
Probability, envelope, asset-return, tax, and withdrawal formulas are unchanged.

A deterministic 31-path test (seed 42, current-mix Baseline versus Defensive with
later retirement) reproduces differing p50 identities and failed before this
correction with different accumulation balances/returns. It now requires exact
Typical-prefix equality and matching retirement opening balances/basis for all
nine historical periods. The engine compact-trial test also checks numerical
parity, only-requested diagnostic expansion, and invalid-index rejection.
This concrete failure invalidates the first candidate's completion evidence;
the final PR receipt must name and verify the corrected commit.

## Scope and identity

- Date: 2026-08-30.
- Lifecycle: In build. Hold: Verification.
- Authorized endpoint: local implementation and focused verification only.
- Tier 3: allocation, projection account state, taxable basis, and the shared
  Cash Flow / Sequencing retirement boundary are protected contracts.
- Worktree: `C:\Dev\Parallax\.worktrees\parker-historical-allocation-20260830`.
- Branch: `codex/parker-historical-allocation-20260830`.
- Starting commit: `85e49866c360c294da138d3577d237bdd0e7c955` (current main when isolated).
- Starting worktree was clean. Changes remain uncommitted and unstaged; the
  starting commit is not an immutable identity for the modified candidate.
- The original dirty main checkout is preserved. PR #244 is explicitly out
  of scope. No commit, push, PR mutation, permission change, or deployment.
- Authorities read: AGENTS.md, CODEX_WORKFLOW.md, EXECUTION-PROTOCOL.md,
  CODE_REVIEW.md, ARCHITECTURE.md, and PRINCIPLES.md.

## Reproduction and root cause

The user reported that switching away from Baseline, then switching historical
paths, displayed: "This path is unavailable because its retirement handoff
could not be verified." Typical could work between the failing selections.

The live tab used `app.html?v=e03be5bfaeb45fc5c545db82f1f1969b96fc1762be42740df2da29d83037d389`.
The browser error was:

```text
portfolio.accounts.taxable.investmentAllocation must preserve reviewed legacy provenance
```

Observed selections: Baseline / Depression and Spend Less / Depression worked;
Aggressive / Typical worked; Aggressive / Depression and Aggressive / 1995
failed. The original Aggressive / 1995 selection was restored. No saved
household input or storage was edited during diagnosis.

Scenario presets overwrote the allocation facts on the scenario clone. The
historical builder then collapsed typed taxable/Roth accounts into legacy
sleeves. Resolving that reconstructed plan rejected the overwritten legacy
allocation provenance. Typical reused the computed analysis and did not enter
this reconstruction. The shared handoff also reconstructed account state from
bucket totals, losing the account identities and their individual allocations.

## Acceptance ledger

"Fixed locally" below means implemented and supported by focused automated
evidence, not delivered or browser-confirmed on the modified candidate.

| Original symptom or contract | State | Evidence |
| --- | --- | --- |
| Alternate scenario: historical -> Typical -> historical becomes unavailable | Fixed locally | Controller regression covers Baseline, Spend Less, Aggressive, 1929 and 1995 using production federal-funded analyses |
| Net Worth account allocations remain authoritative unless Scenario overrides them | Fixed locally | Current mix plus six presets across nine historical periods for working and retired fixtures: 126 combinations; per-account weights and return dollars checked |
| Modeled accounts, balances, ownership, and taxable basis survive retirement entry | Fixed locally | Exact per-ID engine snapshots; reconciliation, zero-opening contribution, and spouse Traditional rollover regressions |
| Saved account allocation/basis facts must not be overwritten by calculated state | Fixed locally | Unchanged-source assertions, nonserializable state, saved-allocation/reporting validation, cash-only and identity rejection tests |
| Already-retired households start at today's age/year, not their past retirement date | Fixed locally | Working/retired matrix asserts first retirement age and calendar year |
| Initial shock must not be applied twice at historical entry | Fixed locally | Working and retired opening-balance regressions |
| Shared Sequencing entry must retain account identity | Fixed locally | Shared builder and median-envelope unit tests; Sequencing call site updated; rendered proof deferred |
| Exact Parker candidate behavior and delivery | Deferred | Fixture reproduces observed shape; it is not an export of the user's household. Candidate browser proof, full required gates, independent review, and delivery remain outstanding |
| PR #244 | Separately scoped | Explicit user exclusion; untouched |

The repair keeps calculation state in a plan-keyed WeakMap and does not add a
saved-data schema. It replaces the aggregate-only
`src/household/transientCalculatedTaxableBasis.js` helper with per-account
`transientProjectionAccountState.js`. The removed helper is recoverable from
the base commit. No tax-rate, asset-return, or withdrawal-order formula changed.
Unsupported account/tax rules were not expanded.

## Verification receipt

Failure-first: the initial three new regression tests failed before production
edits, including the same allocation-provenance error observed in the browser.

Focused related files: 56 passed, 0 failed:

```text
node --test src/scenarios/historicalAccountContinuity.test.js src/scenarios/buildRetirementEntryPlan.test.js src/scenarios/buildHistoricalCashFlowResult.test.js src/scenarios/scenarioPlanInputs.test.js src/scenarios/createCashFlowController.test.js src/projection/accountLedger.test.js src/household/resolvePortfolioAccounts.test.js src/household/resolveTaxableStartingBasis.test.js
```

The new regression fixture was then upgraded to the app's production
`runFederalFundingSimulation` route, with six tests passing again:

```text
node --test src/scenarios/historicalAccountContinuity.test.js
```

Selected engine checks passed (3 tests in the first command, 2 in the second;
the compact-path test is intentionally shared, not five unique tests):

```text
node --test --test-name-pattern="diagnostics|compact|selected paths|forced gross-spent RMDs|traditional savings" engine.test.js
node --test --test-name-pattern="default Monte Carlo is identical|Monte Carlo keeps internal trials compact" engine.test.js
```

`node scripts/validate-governance.mjs` passed (static validation: 8 Markdown
files, 3 workflows, 3 persisted fixtures). This is not the complete
`npm run governance:check` command. `git diff --check` passed.

The new regression is included in package.json's normal test list, but no
`npm test`, full browser verifier, or CI campaign was run for this local scope.
Focused checks do not waive Tier 3 delivery requirements. Candidate browser
proof requires an authorized clean, committed artifact; no mutable-checkout
browser proof is claimed. No independent review has run.

## Changed files

- Runtime: `engine.js`, `src/main.js`, `src/projection/accountLedger.js`,
  `src/household/resolvePortfolioAccounts.js`,
  `src/household/resolveTaxableStartingBasis.js`,
  `src/household/transientProjectionAccountState.js` (new),
  `src/scenarios/scenarioPlanInputs.js`,
  `src/scenarios/buildRetirementEntryPlan.js`, and
  `src/scenarios/buildHistoricalCashFlowResult.js`.
- Removed replacement target: `src/household/transientCalculatedTaxableBasis.js`.
- Tests/config: `engine.test.js`, `package.json`,
  `src/scenarios/scenarioPlanInputs.test.js`,
  `src/scenarios/buildRetirementEntryPlan.test.js`, and
  `src/scenarios/historicalAccountContinuity.test.js` (new).
- Evidence: this document.

Recovery: the isolated worktree contains all local edits. Compare against the
starting commit before any authorized rollback; do not alter the dirty main
checkout or discard this work without target-specific authorization.

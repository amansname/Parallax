# Signed scenario delta and RMD display checkpoint

This records the pre-freeze implementation evidence. The owner subsequently
authorized staging these five scoped files, creating a local verification
commit, and running exact-commit browser checks. Push and PR publication remain
unauthorized. Later commit-bound results belong in the task's verification
receipt; the pre-freeze results below are not a claim that those gates passed.

## Scope and identity

- Lifecycle: In build. Hold: Verification.
- Authorized endpoint: local fixes and checks; no staging, new commit, push, PR,
  merge to main, deployment, or unrelated cleanup.
- Tier 3: this task traces engine-owned RMD output and canonical saved data.
  The new production changes are presentation-only, not RMD or persistence math.
- Repository: `C:\Dev\Parallax`.
- Worktree: `C:\Dev\Parallax\.worktrees\scenario-delta-rmd-persistence-20260830`.
- Branch: `codex/scenario-delta-rmd-persistence-20260830`.
- Original base: `85e49866c360c294da138d3577d237bdd0e7c955`.
- Resumed base/HEAD: `c298118a2889d049f21f3fad0b2f5fd3464a7ed9`, PR 246's
  merge commit. Its tree matches the supplied PR head
  `98e6fd74b19407a13f155dc67491645b08bb5d40` exactly.
- The owner explicitly authorized the fast-forward of this task branch. The two
  pre-existing signed-delta files retained identical SHA-256 hashes across it.
- Current authority: AGENTS.md, PRINCIPLES.md, ARCHITECTURE.md,
  EXECUTION-PROTOCOL.md, CODEX_WORKFLOW.md, and CODE_REVIEW.md.
- Excluded: rail metrics/max drawdown, broader defect discovery, engine/tax
  formulas, saved-data schema/migration, and unrelated worktrees.

## Acceptance ledger

Deferred below means local implementation is present but candidate browser
verification and independent review remain unperformed, not that the defect was
dropped from scope.

| Original request or symptom | Disposition | Base evidence | Local change and regression | Remaining proof |
| --- | --- | --- | --- | --- |
| Positive signed scenario deltas shown as losses | Deferred: implemented locally | On c298118, Baseline 70 versus Better 80 renders a loss marker; exact positive-tag regression fails | Shared sign formatter in Compare and Focus; positive, negative, equal, and unavailable probabilities tested | Visible candidate Compare/Focus outcomes and full verifier |
| RMD/demo-household persistence path | Delivered: bounded investigation; no persistence change | Future selection, historical/Typical switching, reload/reselection preserve database bytes; canonical saved Future-derived fixture preserves exact rows through two reloads | Existing persistence/factory paths retained; new preservation test uses production validation and store preparation/commit | No claim about an unavailable export of the user's saved Parker household |
| Future RMD marker appears at 73 while amounts begin at 75 | Deferred: implemented locally | Immutable c298118 browser: blank RMD at 73/74, positive amount at 75, marker at 73; two new unit regressions fail | Marker and phase grouping share the first positive engine-required RMD row; complete age-group expectations include no-RMD and earlier-spouse cases | Visible candidate marker, phase shading, and unchanged inventory |
| Screenshot: retirement handoff could not be verified | Delivered by PR 246; revalidated on base | Future Baseline, Scenario B, Aggressive each render 1973, Typical, 1995: 31 rows, first age 65/year 2026; reload/reselection also succeeds with no captured errors | No duplicate correction; PR 246 continuity/controller regressions retained and rerun | Exact private Parker state is not represented as browser-tested |

## Responsible paths and invariants

Signed deltas are already computed correctly by `deltaVsBaseline`. Compare
previously always prepended its down marker and Focus always prepended a minus
to the absolute difference. The local formatter chooses the marker from the
signed difference, leaves equality unsigned, and leaves unavailable values empty.
It does not recalculate probability or change styling.

`buildSimulationRows` already displays `engineRow.rmdRequired`, not the forced
top-up `engineRow.rmd`. `groupPhases` and the year marker independently assumed
age 73. They now share a lookup of the first displayed row whose required RMD
is positive. No DOB, tax rule, or RMD formula was added to the view.

RMD-state inventory: empty rows have no bands; no required RMD has one unmarked
band; requirements already present in the first visible row have one band;
otherwise bands split immediately before the first positive required RMD. Later
zero requirements do not revert the phase. Working years and older-spouse RMDs
use the same engine-row contract. The existing retirement-dot priority when
retirement and RMD start share a row is unchanged.

Unchanged ordered Cash Flow columns: Year, Age, Income, RMD, Essential, Goals,
Tax, Draw, Return, WD Rate, Ending. No controls, labels, typography, CSS,
financial amounts, or header/rail metrics are added or changed. Candidate DOM
inventory and computed-style proof remain a delivery gate.

The persistence path deliberately recreates shipped runtime templates at boot
and leaves the active selection blank. A separate current-schema saved fixture,
derived from Future but given its own non-runtime ID, passed canonical save
validation, two store prepare/commit reloads, exact database-byte preservation,
and exact projected-row equality. This is preservation evidence, not a newly
fixed persistence defect or a claim about the user's private saved data.

## Verification

Commands run from the task worktree using Node 24.16.0:

```text
node --test ui/scenarios.test.js ui/cashflow.test.js src/scenarios/historicalAccountContinuity.test.js src/scenarios/buildHistoricalCashFlowResult.test.js src/scenarios/createCashFlowController.test.js ui/householdFactories.test.js src/household/persistence.test.js
npm run governance:check
npm test
npm run verify
git diff --check
```

- Focused suite: exit 0, 69 passed, 0 failed.
- Governance: exit 0, 57 tests plus static validation.
- Full suite: exit 0, 24 tax pretests and 878 tests, 0 failed.
- Full browser verifier: exit 1 at the designed clean-candidate precondition:
  `Parallax candidate artifact requires a clean worktree. Freeze the candidate
  commit first.` No guard was bypassed and no modified-source browser pass is
  claimed. A local commit is not currently authorized.
- `git diff --check`: exit 0.
- Base regression replay: final tests executed with only the two production
  modules replaced in memory by their c298118 Git blobs. Exit 1, 15 passed and
  exactly 3 failed: signed direction and both RMD-grouping assertions. The
  canonical persistence preservation test also passes on the base. This proves
  regression sensitivity without restoring or overwriting any working files.

Base-only browser evidence used a fresh temporary Puppeteer/Chrome profile and
the existing canonical origin `http://127.0.0.1:8825/`. Served metadata and
Cash Flow module bytes matched an artifact built from exact c298118:

```text
Source tree: 85e91f4434453c9ae52ce090fa0128da91b8b39c
Artifact ID: ec4a7ee41bf2a6ffdb129d78a378b816005b40838c50386702a65d7e62e82ccf
```

The probe used visible household, scenario, and path selectors and observable
wizard/run/path readiness, not fixed sleeps. It recorded 9 successful
scenario/path combinations and reload/reselection, unchanged database bytes,
the incorrect age-73 marker, and no page/console errors. Sandbox Chrome startup
timed out; the probe succeeded outside the sandbox. The existing preview was
not stopped or replaced. Temporary browser instances were closed.

Local ignored replay artifacts are retained under `.parallax-artifact/` so the
full verifier's generated-output refresh does not remove them:
`scenario-delta-rmd-base-probe.mjs` and
`scenario-delta-rmd-base-regressions.mjs`. Run them with Node from the worktree
root; the browser probe requires the exact base artifact on the canonical
origin. They are diagnostic receipts, not checked-in candidate verification.

## Changed files and handoff

- `ui/scenarios.js`, `ui/scenarios.test.js`: signed formatting and regression.
- `ui/cashflow.js`, `ui/cashflow.test.js`: RMD phase/marker lookup, engine-fixture
  regression, boundary cases, and saved-state preservation coverage.
- This checkpoint document.

Changes remain unstaged and uncommitted. No independent review or candidate
browser verification has run; this is not Draft-ready or Merge-ready. The
existing root checkout and unrelated worktrees were not modified. No new commit,
push, PR, deployment, reset, restore, stash, or cleanup was performed. The only
Git integration was the explicitly approved task-branch fast-forward. The
preserved worktree diff against c298118 is the recovery record.

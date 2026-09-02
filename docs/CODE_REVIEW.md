# Parallax code-review procedure

Parallax review is evidence-based and independent. It does not replace tests,
CI, branch protection, or the acceptance matrix in
[CODEX_WORKFLOW.md](CODEX_WORKFLOW.md).

## Independence and review target

- Review the complete branch against current `main`, not only the latest commit,
  latest conversation, or files the author highlights.
- The authoring session cannot self-certify. Before a PR is considered
  merge-ready, request a separate `/review` against `main` or post
  `@codex review` on the pull request.
- Confirm the PR is authored by `parallax-pr-author-amans[bot]` and the human
  owner is the requested or completed reviewer, never the PR author.
- The initial review is read-only. Do not edit, commit, or resolve findings in
  the review pass. Apply authorized fixes afterward, then request re-review.
- Deployment availability is not behavioral correctness evidence.

## Required inputs

The reviewer must read:

1. the original issue or user report and every reported symptom;
2. the PR description and exact scope exclusions;
3. every acceptance-ledger row and disposition;
4. the base and branch SHAs;
5. fail-before/pass-after evidence and exact commands;
6. clean, persisted-current, and persisted-legacy fixture provenance; and
7. the exact visible UI inventory and explicit absences when rendered output
   changes; and
8. relevant `AGENTS.md`, architecture, product, workflow, and execution rules.

If an input is missing, report the evidence gap; do not infer it is satisfied.

## Review sequence

### 1. Reproduce the claim boundary

Map each original request and reported symptom to an acceptance-ledger row and
an explicit disposition. Reject a new finding or adjacent fix that silently
replaces unresolved assigned work. A test-only change cannot be accepted as a
product fix. A screenshot supplements but never replaces an assertion of
output or state.

### 2. Trace the responsible path

Follow visible input → persisted state → engine/tax/controller → rendered output.
Confirm the production diff touches the path capable of causing the symptom.
Inspect important untouched files when their absence is suspicious, including
shared adapters, controllers, persistence boundaries, renderers, and engine
inputs.

When static configuration becomes state-dependent, or a change can make an old
conditional reachable, enumerate the full output in every affected state and
inspect the provenance of newly reachable branches. Reject subset-only tests
that prove requested controls are present without proving unexpected controls
are absent.

### 3. Inspect financial and failure semantics

Check every applicable cross-surface invariant in `CODEX_WORKFLOW.md`. Confirm
`engine.js` remains simulation truth, `src/tax/` remains federal-tax truth, and
UI code adds no substitute math. Look specifically for:

- swallowed exceptions or empty catches;
- generic dashes, blanks, or “Unavailable” without an actionable reason;
- invented zeroes, stale fallbacks, and retained prior values;
- missing or suppressed reason codes and missing-field details;
- spouse facts collapsed across owners where tax or RMD law keeps them separate;
- two “independent” comparisons that share the same faulty dependency.

### 4. Inspect persistence and migrations

Confirm the regression loads anonymized household and scenario bytes exactly as
saved. A migration test must not clear, delete, reseed, sanitize, or repair the
trigger before the app receives it. Require separate clean and legacy fixtures,
explicit schema/scenario version migration, source-byte preservation on failure,
and an idempotent reload assertion.

### 5. Inspect tests and fixtures

Confirm the test failed on the base SHA for the reported reason and passed on the
branch SHA after a production change. Browser reports need browser-level visible
financial-outcome assertions. Control values, labels, element existence, slider
maxima, and screenshots alone are insufficient. Expected-value or fixture
changes need a documented product-contract reason.

For visible UI changes, compare the exact ordered DOM inventory and explicit
absences, then inspect governed-view screenshots and computed typography,
spacing, and containment against the named canonical component or tokens.

Check fixtures and logs for names, addresses, email addresses, phone numbers,
Social Security numbers, employer names, account numbers, secrets, or other
identifying data. Sanitization must remove identity without removing the
reported state condition.

### 6. Inspect verification and delivery claims

Compare exact command outputs with required CI. No required failure may be
hidden, suppressed, or labeled irrelevant to claim completion. GitHub Pages or
another deployment proves reachability only. Confirm the PR checkbox and status
language match the evidence. The readiness receipt must name all five required
jobs and the actual independent-review result; reject stale `pending` or `draft`
claims when Merge-ready is requested. A failed, blocked, or findings-remaining
review is not a completed positive review.

## Findings format

Report actionable findings first, ordered by severity:

- `P0` — immediate financial/data/security harm or unrecoverable corruption;
- `P1` — likely incorrect financial result, data loss, or false completion claim;
- `P2` — meaningful behavior, test, fixture, migration, or maintainability gap;
- `P3` — localized improvement that does not block the stated behavior.

Each finding must include severity, concise title, file and line evidence, the
failing scenario, user/financial impact, and the evidence needed to resolve it.
Keep line ranges tight. Do not hide a substantive finding in a general summary.

If no findings are found, say so explicitly and list remaining testing
limitations, unverified surfaces, unavailable environments, and any required
checks not independently rerun. “No findings” is not a guarantee of correctness.

## Re-review and decision

After fixes, re-review the full branch against `main`, not only the fix commit.
Verify each prior finding, acceptance row, command result, and known limitation.
Only an independent reviewer may record the review requirement as satisfied;
required CI and repository settings remain separate merge conditions.

# Parallax engineering workflow

This document is the canonical lifecycle for feature and defect work. It
implements the repository's operating law together with
[the execution protocol](EXECUTION-PROTOCOL.md). Product doctrine remains in
[PRINCIPLES.md](../PRINCIPLES.md), and placement authority remains in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Required lifecycle

Complete these stages in order. Record evidence in the issue, task, or pull
request as work proceeds.

### 1. Goal

State the user-visible outcome in one sentence. For a defect, use the user's
reported behavior, not an inferred implementation task.

### 2. Context

Record the repository root, isolated worktree, branch, base commit SHA, current
commit SHA, `origin/main` SHA, remotes, dirty paths, original issue, and relevant
architecture. Identify the exact user surface and data path.

### 3. Constraints

List scope exclusions, authorization limits, protected product contracts,
permitted files, data-safety requirements, and required commands. One feature or
fix belongs on one branch, worktree, and PR. Unrelated cleanup stays out.

### 4. Done when

Define observable outcomes before editing. Include applicable financial
invariants, exact saved-state behavior, required checks, independent review, and
all acceptance-matrix rows. A deployment cannot be a completion condition.

### 5. Exact reproduction

Reproduce every reported symptom on the base commit through the same visible
inputs and persistence path. Record:

- exact command and commit SHA;
- browser origin and route;
- clean, persisted-current, or persisted-legacy fixture identity;
- exact input/action sequence;
- expected and actual visible financial output;
- error, unavailable state, missing field, and reason code;
- console or browser log evidence.

Do not replace a saved-state report with a clean synthetic fixture. Do not
delete, reseed, normalize, or sanitize the condition before reproducing it.

### 6. Acceptance matrix

Every defect must use this exact table, with one row per reported symptom:

| Reported symptom | Exact reproduction | Pre-fix failure | Production change | Regression assertion | Post-fix proof |
|---|---|---|---|---|---|
| _User-visible symptom_ | _Commit, fixture, steps, and command_ | _Observed output and reason_ | _Responsible production path_ | _Assertion that fails for the same reason_ | _Branch SHA, output, and command_ |

Every cell in every row must contain concrete evidence before “fixed” may be
used. “Same as above,” a screenshot alone, or a control-value assertion is not
concrete proof.

### 7. Minimal implementation

Trace visible input → persisted canonical state → engine/tax/controller path →
rendered output. Change the smallest responsible production path.
A test-only PR may improve coverage but cannot close a product-behavior issue. Explain any
scope expansion and obtain user approval when it is material.

### 8. Fail-before/pass-after regression test

Add the regression assertion before or with the implementation. Prove that it:

1. fails on the recorded base commit for the reported reason;
2. exercises the responsible code path and triggering fixture;
3. passes on the branch after the production change; and
4. would fail again if the production change were reverted.

Record exact commands and actual results. Changing a fixture or expected value
requires a written product-contract reason. Two paths that share the same faulty
dependency are not independent correctness evidence.

### 9. Targeted verification

Run the smallest focused tests that prove the code path and user-visible
outcome. Browser defects require live-browser output assertions after the real
input action. A control's value, label, existence, or maximum does not prove its
dependent financial columns changed. Screenshots are supplemental only.

### 10. Full verification

Run every required command for the change and record the command, commit SHA,
exit code, counts, and first meaningful failure. Required repository gates are:

```text
npm run governance:check
npm test
npm run verify
git diff --check
```

No lint, formatter, or build command currently exists. Do not invent or claim
one. A failing unrelated required check remains a blocker: identify it as
pre-existing or branch-introduced with base and branch evidence, but never hide,
bypass, or downgrade it. Required-check failure prohibits “complete” and
“merge-ready” claims.

### 11. Independent review

Follow [CODE_REVIEW.md](CODE_REVIEW.md). The authoring session may not
self-certify. A separate reviewer must use `/review` against `main` or
`@codex review`, read the original symptoms and matrix, and report findings or
an explicit no-findings result with limitations.

### 12. PR evidence

Use [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md).
Include base and branch SHAs, exact reproduction, root cause, affected production
files, fail-before/pass-after evidence, fixture provenance, invariants, exact
commands and results, known failures, proof gaps, scope exclusions, rollback,
and independent-review status. Copy raw failure text where practical; do not
summarize it as “tests pass.”

### 13. Merge decision

A PR may leave draft only when every acceptance row is complete, required checks
are green, the branch is current under the configured policy, and independent
review is resolved. Availability through GitHub Pages or another deployment is
not behavioral proof. Repository policy does not authorize the contributor or
agent to merge unless the user separately requests it.

### 14. Post-failure retrospective and instruction update

When the same mistake recurs, record what signal was missed, which safeguard
failed, and which instruction/test/check will prevent recurrence. Update the
smallest durable authority (`AGENTS.md`, this workflow, review rules, fixture
standards, or CI) in a separate explained scope. Do not merely add a reminder to
a transient conversation.

## Regression-test standards

### Browser and output proof

- Browser bugs require browser-level outcome assertions through the actual
  visible action and saved-state path.
- Controls, labels, element existence, maxima, and screenshots do not prove a
  dependent financial output.
- Assert the exact visible number, column change, reconciliation, or an
  actionable error containing a reason code, missing field, or next step.
- Do not swallow detailed calculation failures into blank cells, generic dashes,
  invented zeroes, stale values, or an unexplained “Unavailable.”
- Use a deterministic visible state, event, response, or application-ready
  signal. Do not add a fixed sleep as readiness evidence.

### Persistence and migration fixtures

- Clean-state and legacy-state fixtures live separately under
  `test/fixtures/persisted/` and declare `anonymized: true`.
- A persisted-state regression loads household and scenario values exactly as
  stored. Test setup may deserialize bytes but must not repair, normalize,
  remove, or reseed the triggering state before the application sees it.
- A migration regression asserts source bytes, migration receipt, destination
  bytes, and idempotent reload. It must not delete or reseed the state it tests.
- Clean synthetic data is useful for clean behavior only; it cannot substitute
  for a persisted-current or persisted-legacy report.
- Fixtures must contain no client name, address, email, phone, Social Security
  number, employer, account number, secret, or other identifying information.
- Fixture and expected-value changes require a documented product-contract
  reason in the acceptance matrix and PR.

### High-risk cross-surface invariants

For financial engine, tax, RMD, withdrawal, persistence, migration, Goals,
Scenarios, or Cash Flow changes, test every applicable invariant:

1. Household Summary federal tax equals Withdrawal Planner baseline federal tax
   for the same household, tax year, filing status, and saved facts.
2. Goals Essentials plus documented overrides reconcile to Cash Flow Essentials
   for the same scenario and year.
3. Income and expense outputs trace to distinct engine inputs and remain
   distinguishable after year one.
4. Moving a withdrawal lever changes the expected tax or financial column, or
   produces a visible actionable error with its reason.
5. Every unavailable result exposes a reason code, missing field, or actionable
   explanation; the test asserts it.
6. Saved household schemas and scenario versions migrate explicitly without
   deleting or reseeding the triggering state.
7. Spouse ownership and attribution remain separate whenever tax or RMD law
   requires it.
8. UI code contains no substitute tax, RMD, withdrawal, inflation, goal, or
   cash-flow math.

## Preserved protected contracts

These pre-existing repository requirements remain in force:

- Feature-based development uses one feature/fix per verified-current branch,
  isolated worktree, and PR. Prerequisite repairs land separately.
- A Withdrawal Planner control's displayed maximum is the smaller of the
  engine-approved available amount and `$500,000`; zero approved capacity
  disables it. UI code cannot expand an engine limit.
- For `startsAtRetirement: true`, each scenario resolves displayed, edited, and
  comparison start age from that scenario's effective retirement age. Missing
  raw `startAge` never reaches text, inputs, or comparison baselines.
- Changes to either contract need focused Node coverage and observable live-DOM
  financial-output coverage. Attribute-only and fixture-only checks are
  insufficient.
- Manual preview, capture, and browser verification use only
  `http://127.0.0.1:8825/`. Stop a stale preview rather than changing origin.
  Browser storage is origin-scoped; deployed HTTPS never shares local data.
- Preview and browser verification serve only the immutable artifact built from
  the exact clean candidate commit. GitHub Pages deploys that artifact only
  after required quality succeeds and verifies every live byte afterward. See
  [DEPLOYMENT-INTEGRITY.md](DEPLOYMENT-INTEGRITY.md).
- Passing `scripts/verify.mjs` remains required but is not sufficient evidence
  for a touched UI flow. The legacy transition in
  [EXECUTION-PROTOCOL.md](EXECUTION-PROTOCOL.md) section 8 may not expand.

## Existing-rule mapping

No stronger rule was removed. Requirements reorganized from the prior root
instructions map as follows:

| Prior requirement | Current authority |
|---|---|
| Architecture map, anti-monolith rule, engine/tax/UI boundaries | `AGENTS.md` repository map and `docs/ARCHITECTURE.md` |
| Authority, isolation, safe edits, parser/live-DOM, deterministic waits, failure discipline | `AGENTS.md` working rules and unchanged `docs/EXECUTION-PROTOCOL.md` |
| Feature-based branches/worktrees/PRs | `AGENTS.md` working rules and this document's protected contracts |
| Withdrawal `$500,000` display ceiling | This document's protected contracts |
| Scenario-relative retirement goal age | This document's protected contracts |
| Focused Node plus live-DOM evidence | This document's targeted verification and protected contracts |
| Canonical port 8825 and origin-scoped storage | `AGENTS.md` commands and this document's protected contracts |
| Verifier compatibility transition | `AGENTS.md` working rules and `docs/EXECUTION-PROTOCOL.md` section 8 |
| Command and Chrome/localStorage caveats | `AGENTS.md` commands, this document's fixture rules, and `README.md` |

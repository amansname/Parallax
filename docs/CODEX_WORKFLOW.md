# Parallax PR delivery workflow

Codex uses this workflow for Parallax features, fixes, tests, documentation, and
repository governance. Codex chooses the tier automatically; the owner does not
need to invoke a workflow or remember a tier.

```text
1. Scope and route
2. Preflight and build
3. Verify
4. Draft PR and review
5. Merge, deploy, and confirm
```

Risk changes local evidence. It never removes required GitHub checks,
independent review, resolved conversations, or owner merge approval.

## 1. Scope and route

Questions, explanations, plans, audits, and status checks are read-only.
Implementation begins only after the owner approves scope and delivery actions.

Use the lowest tier that covers the highest-risk part of the PR:

| Tier | Use it for | Local evidence |
|---|---|---|
| **Tier 1 - Fast** | Docs, copy, isolated styling, non-behavioral markup, or a test-only correction with no runtime or protected-contract change | Focused check, rendered proof when visible, `npm run governance:check`, `git diff --check` |
| **Tier 2 - Standard** | Ordinary behavior inside one established authority with no financial-policy, saved-data, migration, security, or deployment change | Focused tests, `npm run governance:check`, `npm test`, `npm run verify`, `git diff --check` |
| **Tier 3 - Protected** | Projection Engine, Tax Engine, RMD, withdrawal, allocation, financial results, persistence shape, migration, security, CI/deployment, repository governance, or cross-authority work | Tier 2 evidence plus applicable contract, boundary, compatibility, fixture, benchmark, or migration proof |

Use the highest applicable tier for the whole PR unless independent work is
split. Promote the tier when inspection discovers a higher-risk contract. Do
not lower it merely because the diff is small.

Tier 1 is narrow:

- A test correction cannot weaken coverage or change expected behavior.
- Markup is behavioral when it changes accessibility, semantics, IDs,
  selectors, event wiring, or verifier hooks.
- Financial, tax, legal, privacy, or security copy may require a higher tier.
- A refactor inside a protected authority remains Tier 3.

Use this short scope card:

```text
Risk tier and rationale:
Baseline:
Outcome:
Included:
Done when:
Authority:
Protected boundaries:
Non-goals:
Verification:
```

### Decision 1 - authorize delivery

The owner may approve implementation, focused in-scope corrections,
verification, commits, push, draft PR publication, reviewer requests, and
required-check monitoring in one decision.

Decision 1 never authorizes merge, auto-merge, deployment-setting changes,
manual deployment, destructive Git operations, or material scope expansion.

## 2. Preflight and build

Before editing, record:

- repository root, isolated worktree, branch, base SHA, head SHA, and
  `origin/main` SHA;
- remotes and dirty paths;
- the original request and exact user surface;
- responsible authority and protected contracts;
- allowed actions and required verification; and
- fixture identity when saved state is involved.

Use one feature or fix per clean isolated worktree, branch, and PR. Preserve
existing work and exclude unrelated cleanup.

Define observable completion evidence before editing. For defects, use one row
per reported symptom:

| Reported symptom | Exact reproduction | Pre-fix failure | Production change | Regression assertion | Post-fix proof |
|---|---|---|---|---|---|
| _Visible symptom_ | _Base SHA, fixture, and steps_ | _Observed result_ | _Responsible path_ | _Fail-before assertion_ | _Candidate result_ |

A product-defect regression assertion must fail on the recorded base for the
reported reason, exercise the responsible production path and fixture, pass on
the candidate, and fail again if the production change is reverted.

A test-only PR may improve coverage but cannot close a product-behavior issue.
Do not sanitize
reported state, weaken an assertion, hide an error, or change an expectation
without a documented product-contract reason.

Trace visible input -> saved canonical state -> responsible engine, tax,
controller, or view path -> visible output. Make the smallest responsible
change. Ask before materially expanding scope.

For delegated protected work, keep one writer. A read-only gatekeeper checks
baseline, scope, tests, candidate identity, and drift. The writer applies
accepted corrections.

## 3. Verify

Every tier must ultimately pass all four `Parallax quality` jobs:

- Governance safeguards
- Unit tests
- Build deployable site artifact
- Full browser verification

Tier 1 scales only the additional local campaign. GitHub still runs the full
required suite.

Tier 2 and Tier 3 run and record:

```text
npm run governance:check
npm test
npm run verify
git diff --check
```

Record candidate SHA, command, exit code, counts, and the first meaningful
failure. A failing required gate blocks Merge-ready. Prove whether it is
pre-existing against the base; never hide or bypass it.

Browser proof uses the real visible action and asserts the resulting number,
column, reconciliation, save/reload behavior, or actionable error. Element
existence, control values, and screenshots alone are not behavioral proof.

Persistence and migration work requires anonymized clean, current, and exact
legacy-state evidence; source-byte preservation; repeat migration/reload;
idempotence; malformed-state handling; and fail-closed calculation facts.

Financial, tax, allocation, or withdrawal work requires applicable benchmarks,
boundaries, attribution, tax-year and filing-status edges, zero/negative values,
unaffected-result checks, and cross-surface reconciliation.

Preserve these contracts when applicable:

- Moving a withdrawal lever changes the expected tax or financial column, or
  produces a visible actionable error.
- Goals Essentials plus documented overrides reconcile to Cash Flow Essentials.
- Income and expense outputs trace to distinct engine inputs.
- Withdrawal controls never exceed the smaller of the engine-approved limit and
  `$500,000`; zero capacity disables the control.
- Retirement-linked goal ages resolve from each scenario's retirement age.
- UI code contains no substitute tax, RMD, withdrawal, inflation, goal, or
  cash-flow math.

Preview and browser verification use only `http://127.0.0.1:8825/` and the
immutable artifact from the exact clean candidate. Stop a stale preview; do not
change the canonical origin.

## 4. Draft PR and review

Commit only the reviewed scope, freeze the candidate SHA, push through the
approved Parallax identity, and open or update a draft PR. Record base and
candidate SHAs, scope, evidence, commands, results, failures or gaps, rollback,
and independent-review status.

Request one independent review against current `main`. The authoring session
cannot self-certify.

Use one bounded correction cycle:

```text
review concrete candidate
-> correct branch-caused, in-scope findings
-> rerun affected and required gates
-> create one new candidate
-> re-review the corrections
```

A review finding must identify a concrete contract, reproduction, or realistic
failure path. New governance systems, speculative hardening, and unrelated
cleanup become follow-up work. Repeated findings that reveal a flawed design
require simplification or a new owner scope decision, not endless parser
complexity.

Automation enforces objective facts. Independent review evaluates whether
scope, rationale, and evidence are sufficient. Do not encode every judgment
call in the PR-body parser.

Report lifecycle and hold:

```text
Lifecycle: Scoped / In build / Draft-ready / Merge-ready / Merged / Production-confirmed
Hold: None / Owner decision / Scope / Verification / CI / Review / Deployment / External blocker
```

Merge-ready means the exact candidate passed local evidence, required CI,
independent review, conversation resolution, mergeability, and governance. A
new commit, rebase, amend, or force-push invalidates prior merge authorization.

## 5. Merge, deploy, and confirm

### Decision 2 - authorize the exact merge

Present PR number, candidate SHA, base SHA, files, required checks, review and
conversation status, mergeability, and expected automatic deployment. The
owner must explicitly authorize that exact candidate.

Do not merge, auto-merge, or deploy early. A different or manual deployment
path requires separate approval.

After a squash merge, record:

```text
candidate SHA
-> merge commit on main
-> Pages workflow run and artifact
-> deployed byte receipt
-> relevant live behavior proof
```

Merged does not mean deployed. Production-confirmed requires both the expected
artifact and relevant live behavior or byte check.

## Existing-rule mapping

This five-phase workflow condenses the prior fourteen-stage workflow; it does
not remove stronger rules. Architecture remains in `AGENTS.md` and
`docs/ARCHITECTURE.md`, execution safety in `docs/EXECUTION-PROTOCOL.md`,
review in `docs/CODE_REVIEW.md`, and release identity in
`docs/DEPLOYMENT-INTEGRITY.md`.

Parallax currently has no general linter or formatter command. Adding one is a
separate tooling PR with its own rule selection, baseline, CI cost, and rollout
decision.

# Parallax PR delivery workflow

Codex uses this workflow for Parallax features, fixes, tests, documentation, and
repository governance. Codex chooses the tier automatically; the owner does not
need to invoke a workflow or remember a tier.

On the first response to a Parallax task, give one compact receipt:
`Workflow started | Phase: Scope | Tier: provisional until the authority is traced`.
Do not make the owner ask whether the workflow is active.

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

Keep the original request and every reported symptom in an acceptance ledger
through delivery. Each item must remain marked `Fixed`, `Delivered`, `Deferred`,
or `Separately scoped`. A newly discovered issue may refine or split the work;
it must never silently replace the task that the owner actually assigned.

### Decision 1 - authorize delivery

The owner may approve implementation, focused in-scope corrections,
verification, commits, push, draft PR publication, reviewer requests, and
required-check monitoring in one decision.

Decision 1 never authorizes merge, auto-merge, deployment-setting changes,
manual deployment, destructive Git operations, or material scope expansion.

### Delivery-capability gate

When Decision 1 explicitly authorizes end-to-end delivery through a draft PR,
it is not permission to build an undeliverable local candidate. Before the
first implementation edit, prove that the chosen execution environment can
complete every required step through the draft PR. For a narrower assignment,
prove only the capabilities required to reach its explicitly authorized
terminal state.

The end-to-end gate requires:

- it is attached to the Parallax repository and a clean isolated worktree based
  on current `origin/main`;
- `origin` exists and the approved Parallax bot identity can fetch, push,
  publish a bot-authored draft PR, request the human owner as reviewer, and
  read its checks;
- locked dependencies can be installed and, when the selected tier requires
  `npm run verify`, a supported Chrome/Chromium executable is available; and
- the environment can commit the frozen candidate and request independent
  review.

Use harmless probes before editing. Do not infer these capabilities from a
task label, a Cloud/local badge, a prior session, or the presence of source
files.

If a capability required for the authorized terminal state is missing, do not
implement that assignment in the environment. Route end-to-end delivery to the
saved local Parallax project and create a clean worktree there. Cloud or
projectless work may continue when the owner explicitly narrows the assignment
to an endpoint that the environment can actually complete.

A task or session ID is a reference, not a portable Git artifact. Do not use a
generic **Apply changes** handoff for governed Parallax candidates when the
destination checkout, baseline, cleanliness, or branch is unverified. Prefer a
pushed branch or fetchable commit. If no portable commit exists, reproduce the
accepted behavior narrowly from the original request and evidence in a new
clean worktree; leave any conflicted apply result untouched as recovery
evidence.

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

Define observable completion evidence before editing. Use one row per original
request or reported symptom:

| Original request or reported symptom | Disposition | Base or starting-state proof | Production change | Regression assertion | Candidate proof |
|---|---|---|---|---|---|
| _Requested result_ | _Fixed / Delivered / Deferred / Separately scoped_ | _Base SHA, fixture, steps, and observed state_ | _Responsible path_ | _Exact assertion_ | _Candidate result_ |

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

For a visible UI change, define the exact allowed inventory, its order, and the
rows, controls, labels, and typography that must remain absent or unchanged.
If a change turns static configuration into state-dependent configuration or
makes an existing conditional newly reachable, enumerate the complete output
for the default state and each affected state. Regression tests must compare
the exact ordered result, not merely prove that requested elements are present.

For delegated protected work, keep one writer. A read-only gatekeeper checks
baseline, scope, tests, candidate identity, and drift. The writer applies
accepted corrections.

## 3. Verify

Every tier must ultimately pass all four required GitHub gates:

- Governance safeguards (`Parallax PR evidence`)
- Unit tests
- Build deployable site artifact
- Full browser verification

The reviewer-dependent Governance safeguards gate runs only in the lightweight
PR-evidence workflow. The Unit tests, deployable artifact, and Full browser
verification jobs form the full `Parallax quality` campaign. This separation
prevents the immutable `opened` event from testing a reviewer request that can
only be created after the pull request exists.

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
For visible UI scope, also assert the exact rendered inventory and explicit
absences. Capture governed viewports and compare key computed typography,
spacing, and containment with the named canonical component or design tokens.

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

Before freezing the candidate, install locked dependencies and, when the
selected tier requires `npm run verify`, confirm that port 8825 and the browser
executable are available. Run one authoritative clean-candidate verifier when
required by the selected tier. Classify its first failure before changing
anything: correct only branch-caused, in-scope product or verifier defects;
remove stale local preview/process state for environment failures. After a
pass, do not amend or replace the candidate without either a concrete
branch-caused required-gate failure or a concrete in-scope independent-review
finding.

## 4. Draft PR and review

Commit only the reviewed scope, freeze the candidate SHA, and verify both the
commit author/committer and draft-PR author are
`parallax-pr-author-amans[bot]`. Push through that identity, open or update the
draft PR, and request `amansname` as the human reviewer. Record base and
candidate SHAs, scope, evidence, commands, results, failures or gaps, rollback,
and independent-review status. The human owner must not author the PR they are
required to review.

The lightweight Governance safeguards job inspects every commit in the current
base-to-candidate range and rejects any Git author or committer other than the
Parallax bot. The final PR-facing ref update must be pushed by the bot; a
human-authored or human-committed change is not an acceptable way to bring the
branch current.

When a verified candidate changes `.github/workflows/` and GitHub rejects the
App introducing those files because it lacks the special workflows permission,
use the established two-stage identity bridge instead of changing App,
repository, or account permissions:

1. Push the exact verified bot-authored and bot-committed candidate through the
   established repository credential. This transports the existing commit; it
   must not rewrite its author, committer, tree, or message.
2. Immediately create a tree-identical empty bot-authored identity commit and
   push that final commit through `parallax-pr-author-amans[bot]`. Use an
   exact-SHA refspec and lease protection when replacing an existing remote ref.
3. Only after the bot identity commit is the remote head may the bot create or
   update the draft PR and request the human review.

Verify the bridge SHA, final SHA, tree equality, complete candidate-range
authorship, remote head, PR author, and requested reviewer. The bridge is a
bounded transport exception for workflow files; it never permits human commit
metadata, a human-authored PR, a human final pusher, or a permission workaround.

PR-event governance also rejects a pull request unless its live author is
`parallax-pr-author-amans[bot]` and `amansname` is either still requested
or has submitted a completed review on the exact head SHA. The bot must
request the human owner before the final PR evidence validation can pass.

Prepare the complete truthful PR body before publication. Feature branches do
not need a second full `push` run in addition to the pull-request run. After the
PR is open, use comments for progress and the final readiness receipt; edit the
body only to correct material scope or evidence, because a body edit reruns its
governance validation through the lightweight `Parallax PR evidence` workflow.
It must not rerun unit, artifact, or browser jobs for an unchanged candidate
SHA. The full `Parallax quality` campaign runs only when the PR opens, reopens,
or receives a new candidate commit.

Opening a PR starts the full campaign but does not run reviewer-dependent
governance against the immutable opened-event snapshot.
Requesting `amansname` emits `review_requested` and starts the lightweight
required Governance safeguards gate. That same lightweight gate reruns on a
review-request removal, body edit, candidate synchronization, or reopen so
authorship, exact-head evidence, and the current reviewer state stay coupled
without another browser campaign.

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

When an obsolete configuration leaves equivalent checks for the same SHA,
monitor the pull-request run as authoritative. Do not rerun, amend, or publish
another candidate merely because the duplicate run is still visible. A PR-body
edit may start only the lightweight evidence workflow.

Report lifecycle and hold:

```text
Lifecycle: Scoped / In build / Draft-ready / Merge-ready / Merged / Production-confirmed
Hold: None / Owner decision / Scope / Verification / CI / Review / Deployment / External blocker
```

Merge-ready means the exact candidate passed local evidence, required CI,
independent review, conversation resolution, mergeability, and governance. A
new commit, rebase, amend, or force-push invalidates prior merge authorization.
Lifecycle must use one of the values listed above. Merge-ready requires a
recognized positive completed independent-review result and successful
applicable local commands; negated or mixed failure wording never counts as a
pass. Tier 1 may omit only `npm test` or `npm run verify` locally with its narrow
reason recorded, while the full GitHub suite still must pass. An open PR cannot
claim `Merged` or `Production-confirmed`; those later states require matching
GitHub lifecycle evidence and the same readiness gates.
Before asking for Decision 2, post one current readiness receipt that names all
four required jobs, the independent-review result, conversation resolution,
base and head SHAs, and mergeability. Do not leave `pending` or `draft` language
in the receipt used to request merge approval.

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

## Improve the workflow from failures

Treat a process failure as an input to the next governance iteration. Bind it
to the exact PR and SHA, identify the missed decision or evidence gate, and add
the narrowest durable correction. Objective failures need an executable
regression test; judgment failures need a focused review rule. Forward-test the
repair against the observed failure and one normal lower-risk case. Keep the
workflow repair separate from the product correction, and do not claim the
automatic first-turn behavior is proven until a fresh task demonstrates it.

## Existing-rule mapping

This five-phase workflow condenses the prior fourteen-stage workflow; it does
not remove stronger rules. Architecture remains in `AGENTS.md` and
`docs/ARCHITECTURE.md`, execution safety in `docs/EXECUTION-PROTOCOL.md`,
review in `docs/CODE_REVIEW.md`, and release identity in
`docs/DEPLOYMENT-INTEGRITY.md`.

Parallax currently has no general linter or formatter command. Adding one is a
separate tooling PR with its own rule selection, baseline, CI cost, and rollout
decision.

# Parallax PR delivery workflow

This document is the canonical lifecycle for Parallax feature, defect,
governance, and documentation pull requests. It implements the repository's
operating law together with [the execution protocol](EXECUTION-PROTOCOL.md).
Product doctrine remains in [PRINCIPLES.md](../PRINCIPLES.md), placement
authority remains in [ARCHITECTURE.md](ARCHITECTURE.md), independent review is
defined in [CODE_REVIEW.md](CODE_REVIEW.md), and release identity is defined in
[DEPLOYMENT-INTEGRITY.md](DEPLOYMENT-INTEGRITY.md).

The visible workflow has five phases:

```text
1. Scope
2. Preflight and build
3. Verify
4. PR and review
5. Merge, deploy, and confirm
```

The phases are invariant. Risk changes the additional evidence required, not
the repository's required GitHub gates.

## Automatic routing and risk lanes

Questions, explanations, plans, audits, and status checks remain read-only.
When the user requests a Parallax implementation, fix, or PR, propose a risk
lane and rationale before the first mutation. The user may raise the lane or
narrow the scope. Do not lower a lane when the evidence still meets a higher
trigger.

If any part of a proposed PR meets a higher-risk condition, the entire PR uses
the higher lane unless the work is split into genuinely independent PRs.
Classify by behavior and blast radius, not line count or filename alone.

| Lane | Applies when | Additional local evidence |
|---|---|---|
| **Tier 1 - Fast** | Copy, docs, isolated styling, non-behavioral markup, or a test-only correction that does not change a runtime, accessibility, financial, persistence, migration, security, or deployment contract | Focused check, rendered inspection when user-visible, `npm run governance:check`, and `git diff --check` |
| **Tier 2 - Standard** | Ordinary product behavior within one established authority, with no new financial policy, saved-data shape, migration, or protected calculation change | Focused tests, `npm run governance:check`, `npm test`, `npm run verify`, `git diff --check`, and applicable browser/save-reload proof |
| **Tier 3 - Protected** | Projection Engine, Tax Engine, RMD, withdrawal, allocation, financial results, persistence shape, migrations, security, CI/deployment, repository governance, or cross-authority work | Tier 2 evidence plus applicable contract, compatibility, benchmark, boundary, migration, and independent-review evidence |

Tier 1 is deliberately narrow:

- A test correction is Tier 1 only when it repairs the test without weakening
  coverage or changing an expected product, financial, tax, persistence,
  migration, or runtime result.
- A fixture or golden-value update is not Tier 1 merely because its diff is
  small.
- Markup is behavioral when it changes form semantics, accessibility, IDs,
  selectors, event wiring, or browser-verifier hooks.
- Visual work is not Tier 1 when it changes shared tokens, global layout
  contracts, chart interpretation, financial emphasis, or an authoritative
  rendering seam.
- Financial, tax, legal, privacy, or security copy may require promotion even
  when it changes no runtime code.
- A within-layer refactor remains Tier 3 when that layer owns protected
  calculations or contracts.

Promote the work when inspection discovers a higher trigger. If promotion
materially changes the approved scope, protected boundaries, or delivery
authority, pause and obtain a new scope decision.

## Two owner decision points

### Decision 1 - Scope and delivery authorization

Before mutation, present the scope card and the exact delivery actions being
requested. When the owner approves this full decision, it may authorize:

- implementation in the identified isolated worktree;
- focused corrections that remain within the approved scope;
- verification;
- commits and push;
- draft PR publication and reviewer requests; and
- required-check monitoring.

Authorization must be explicit about those actions. A narrower instruction
such as "edit only," "local only," or "stop before publication" controls.
Decision 1 never authorizes scope expansion, destructive Git operations,
merge, auto-merge, repository-setting changes, deployment-configuration
changes, or manually deploying a different artifact.

### Decision 2 - Exact merge authorization

After the final pre-merge receipt, the owner may authorize the identified PR at
the reported candidate head SHA for merge. Any candidate-file change, commit,
amend, rebase, or force-push invalidates that approval. A material change to PR
claims or evidence requires review of the changed evidence even when the SHA is
unchanged.

Normal automatic Pages deployment is an expected consequence of merging to
`main`; it does not authorize another deployment path, a manual deployment,
auto-merge, or a repository-setting change. Two owner decision points do not
promise only two UI interactions when GitHub itself requires a separate review
action.

## Lifecycle and hold reporting

Report one lifecycle and one hold condition:

```text
Lifecycle: Scoped / In build / Draft-ready / Merge-ready / Merged / Production-confirmed
Hold: None / Owner decision / Scope / Verification / CI / Review / Deployment / External blocker
```

- **Scoped:** The owner approved the scope card; it is not merely drafted.
- **In build:** Implementation or bounded corrections are underway. A
  branch-caused failing gate returns here.
- **Draft-ready:** The included behavior and focused proof are sufficient for a
  draft PR. Every outstanding or failing governed gate is named.
- **Merge-ready:** The exact head candidate has passed every applicable local,
  CI, review, conversation-resolution, mergeability, and governance gate.
- **Merged:** The candidate-to-`main` merge mapping is recorded.
- **Production-confirmed:** The deployment corresponding to the merged commit and the
  relevant live behavior or artifact have both been checked.

## Phase 1 - Scope

Use this scope card:

```md
Risk tier:
Risk rationale:
Baseline or accepted prerequisite:

Outcome:

Included:
- ...

Done when:
- ...

Authority:
[Projection Engine / Tax Engine / household / planning / Scenario / UI / styling]

Protected boundaries:
- ...

Non-goals:
- ...

Verification:
- ...
```

Protected boundaries identify contracts that must not change accidentally.
Non-goals identify related work intentionally excluded. Tier 1 cards may keep
each field to one short line. Tier 3 cards must state the applicable financial,
tax, allocation, migration, security, or failure policy before code begins.
Never invent policy merely to complete an implementation.

### Audit-to-implementation handoff

An audit never acquires edit authority. Bind each finding to the exact audited
SHA, then revalidate it against the accepted implementation baseline:

```text
Read-only audit at SHA A
-> evidence-backed finding
-> recheck against accepted baseline SHA B
-> mark current, changed, already fixed, or no longer applicable
-> owner approves the current finding or bundle
-> new isolated worktree at SHA B
-> appropriate risk lane
```

## Phase 2 - Preflight and build

### Start-of-task receipt

Before the first mutation, follow `docs/EXECUTION-PROTOCOL.md` and record:

- repository root, isolated worktree, branch, base SHA, current SHA, and
  `origin/main` SHA;
- remotes, tracked and untracked dirty paths, and protected worktrees;
- original issue or user request, exact user surface, and authoritative data
  path;
- applicable instructions, protected contracts, allowed actions, and required
  verification; and
- fixture identity and provenance when saved state is involved.

One feature or fix belongs on one verified-current branch, isolated worktree,
and PR. Unrelated cleanup and prerequisite repairs remain separate.

### Reproduction and acceptance evidence

Define observable done-when criteria before editing. Every PR records at least
one acceptance-evidence row:

| Done-when criterion | Baseline or pre-fix evidence | Production change | Verification | Candidate result |
|---|---|---|---|---|
| _Observable result_ | _Starting state or exact failure_ | _Responsible path_ | _Command or live action_ | _Exact result_ |

For a defect, reproduce every reported symptom on the base commit through the
same visible inputs and persistence path. Tier 2 and Tier 3 defect evidence
includes the exact command and SHA, browser origin/route, fixture identity,
input sequence, expected and actual output, and error/reason-code evidence.
Do not replace a saved-state report with clean synthetic data or sanitize the
condition before reproduction.

A fail-before/pass-after regression assertion for a product defect must:

1. fail on the recorded base for the reported reason;
2. exercise the responsible production path and triggering fixture;
3. pass on the candidate after the production change; and
4. fail again if the production change is reverted.

A test-only PR may improve coverage but cannot close a product-behavior issue.
Changing a fixture or expected value requires a written product-contract
reason. Two paths sharing the same faulty dependency are not independent proof.

### Minimal implementation and ownership

Trace visible input -> persisted canonical state -> engine/tax/controller path
-> rendered output. Change the smallest responsible production path. Explain
scope expansion and obtain approval when it is material.

For protected work:

- the implementer is the only writer to candidate files;
- the gatekeeper reviews candidate files read-only and reports bounded findings
  with exact evidence;
- the implementer applies accepted corrections;
- one designated PR manager mutates PR metadata and publication state; and
- the gatekeeper re-reviews the new candidate instead of carrying acceptance
  forward.

Meaningful gatekeeper checkpoints are baseline, protected-slice boundaries,
and candidate freeze. Continuous gatekeeping does not mean competing edits.

## Phase 3 - Verify

### Invariant GitHub gates

Every lane remains subject to every `Parallax quality` job: `Governance
safeguards`, `Unit tests`, `Build deployable site artifact`, and `Full browser
verification`. It also remains subject to configured required checks, required
review, resolved conversations, exact-ref verification, and mergeability
requirements. A lower tier never bypasses them.

Tier 1 scales only the additional local campaign. Run its focused check,
rendered inspection when user-visible, `npm run governance:check`, and
`git diff --check`; normal CI still runs the full required repository suite.

Tier 2 and Tier 3 run and record:

```text
npm run governance:check
npm test
npm run verify
git diff --check
```

Record each command, candidate SHA, exit code, counts, and first meaningful
failure. Parallax has no general lint, formatter, or application bundler; do
not invent one. `npm run site:build` is the immutable release-artifact build,
not a substitute for the required test and browser gates.

A failing required check remains a blocker. Prove whether it is pre-existing
or branch-introduced using base and candidate evidence, but never hide,
bypass, or downgrade it. Required-check failure prohibits `Merge-ready`.

### Browser and output proof

- Browser bugs require browser-level output assertions through the real visible
  action and saved-state path.
- Controls, labels, element existence, maxima, and screenshots alone do not
  prove dependent financial output.
- Assert the exact visible number, column change, reconciliation, or an
  actionable error containing a reason code, missing field, or next step.
- Do not swallow failures into blanks, generic dashes, invented zeroes, stale
  values, or unexplained "Unavailable" output.
- Use deterministic readiness signals, not fixed sleeps.

### Persistence and migration evidence

When applicable, require anonymized clean, current, and legacy fixtures;
missing and partially populated fields; source bytes; migration receipt;
destination bytes; repeated migration/reload behavior; preservation of
explicit values; idempotence; unsupported or malformed records; and fail-closed
behavior for calculation-affecting facts. A migration must not silently
reinterpret financial meaning or delete/reseed the triggering state.

Fixtures must contain no client name, address, email, phone, Social Security
number, employer, account number, secret, or other identifying information.

### High-risk financial evidence

For financial, tax, allocation, or withdrawal work, identify and run the
applicable deterministic contracts, known benchmarks or golden cases, boundary
values, owner/account attribution, tax-year and filing-status boundaries,
zero/negative/unusually large values, unaffected-calculation preservation, and
Historical-versus-Monte-Carlo separation. Prefer exact values to rounded labels.

Test every applicable cross-surface invariant:

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

The scope card identifies which evidence and invariants apply. Tier 3 does not
require irrelevant tests merely for ceremony.

### Independent review

Follow [CODE_REVIEW.md](CODE_REVIEW.md). The authoring session cannot
self-certify. A separate reviewer uses `/review` against `main` or
`@codex review`, reads the original scope and evidence, and reports findings or
an explicit no-findings result with limitations.

## Phase 4 - PR and review

### Candidate and correction cycle

```text
Implement and verify
-> commit candidate
-> freeze that review round
-> gatekeeper review
-> if correction is required:
     unfreeze
     correct
     reverify affected behavior
     create a new candidate SHA
     invalidate superseded evidence
     freeze again
-> final gatekeeper acceptance
-> Merge-ready
```

A freeze means no actor changes that candidate while it is being reviewed. Any
code, test, configuration, fixture, generated artifact, commit, amend, rebase,
or force-push creates a new candidate. Reuse prior evidence only when it is
demonstrably unaffected, and record that decision. A material PR-evidence
change requires evidence review even when candidate files and SHA are unchanged.

Use [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md).
The PR records classification, scope, base and candidate SHAs, acceptance
evidence, production authority, exact verification results, required CI,
independent review, holds/proof gaps, rollback, and deployment impact.

Before `Merge-ready`, independently confirm:

- the correct repository, PR, base, head, and latest candidate SHA;
- intended commits and files only;
- required checks green;
- required review present and conversations resolved;
- clean mergeability and current-base policy; and
- no unreviewed commit or stale approval.

The authoring session and GitHub's ready flag do not replace this evidence.

## Phase 5 - Merge, deploy, and confirm

Present Decision 2 with the exact PR, candidate head SHA, base SHA, required
checks, reviewer/conversation status, mergeability, and expected automatic
deployment consequence. Recheck those facts immediately before the authorized
merge.

For squash merges, record the complete identity chain:

```text
candidate head SHA
-> squash merge commit on main
-> Pages workflow run and artifact ID
-> deployed-site identity and byte receipt
-> relevant live behavior proof
```

`Merged` never means deployed. A successful deployment workflow proves
availability, not behavioral correctness. `Production-confirmed` requires both the
expected merged artifact and the relevant public behavior or artifact check.
Follow [DEPLOYMENT-INTEGRITY.md](DEPLOYMENT-INTEGRITY.md).

The post-merge receipt records the PR, candidate SHA, merge SHA, workflow run,
artifact identity, URL, verification time, verified behavior, and known
limitations. A new deployment path, manual deployment, repository-setting
change, or rollback requires separate authorization.

## Preserved protected contracts

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
  after required quality succeeds and verifies every live byte afterward.
- Passing `scripts/verify.mjs` remains required but is not sufficient evidence
  for a touched UI flow. The legacy transition in
  [EXECUTION-PROTOCOL.md](EXECUTION-PROTOCOL.md) section 8 may not expand.

## Post-failure improvement

When the same mistake recurs, record the missed signal, failed safeguard, and
smallest durable prevention. Update the relevant authority in a separate
explained scope; do not distribute competing copies across global instructions,
repository instructions, workflow skills, and templates.

Authority remains layered:

1. Global `AGENTS.md`: universal authorization and safety only.
2. Repository `AGENTS.md`: mandatory Parallax boundaries and links.
3. This document: full PR lifecycle, lanes, status, and evidence rules.
4. Nested `AGENTS.md`: directory-specific deltas only.
5. Workflow skill: orchestration that reads this document, never competing
   policy.
6. PR template: evidence capture, never procedural authority.

## Existing-rule mapping

No stronger rule was removed.

| Prior requirement | Current authority |
|---|---|
| Architecture map, anti-monolith rule, engine/tax/UI boundaries | `AGENTS.md` and `docs/ARCHITECTURE.md` |
| Authority, isolation, safe edits, parser/live-DOM, deterministic waits, failure discipline | `AGENTS.md` and `docs/EXECUTION-PROTOCOL.md` |
| Goal, context, constraints, done-when, reproduction, implementation, verification, PR, merge, and retrospective stages | The five phases in this document |
| Acceptance matrix and fail-before/pass-after proof | Phase 2 acceptance evidence |
| Risk-scaled local evidence with invariant GitHub gates | Automatic routing and Phase 3 |
| Independent review and correction re-review | `docs/CODE_REVIEW.md` and Phase 4 |
| Withdrawal `$500,000` display ceiling and scenario-relative retirement goal age | Preserved protected contracts |
| Canonical port 8825, immutable artifact, and live-byte proof | `AGENTS.md`, preserved contracts, and `docs/DEPLOYMENT-INTEGRITY.md` |
| Command and Chrome/localStorage caveats | `AGENTS.md`, this document, and `README.md` |

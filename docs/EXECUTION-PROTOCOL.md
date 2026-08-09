# Parallax Execution Protocol

- **Version:** 1.0
- **Status:** Active repository policy
- **Effective:** 2026-08-08
- **Scope:** All repository work performed by people, agents, automation, and
  coordinated task runners.

This document defines how Parallax work is executed safely.
[PRINCIPLES.md](../PRINCIPLES.md) remains the authority for product doctrine,
and [ARCHITECTURE.md](ARCHITECTURE.md) remains the authority for code
placement. Governing platform, security, and legal policy always takes
precedence over repository instructions. This protocol governs authorization,
workspace safety, editing, automation, verification, and handoff evidence.

## 1. Requirement language

- **MUST / MUST NOT:** non-negotiable.
- **SHOULD / SHOULD NOT:** the default; deviation requires a recorded reason.
- **MAY:** optional when useful and within scope.

## 2. Authority and operating state

### Default state

Work begins read-only unless the user request clearly authorizes changes.
Inspection, diagnosis, and planning do not authorize edits, staging, commits,
publishing, cleanup, or destructive actions.

The **task principal** is the authority that approved the bounded work:

- interactive work: the authorized user or repository maintainer who requested
  the task;
- maintainer-initiated work: the repository owner or designated maintainer who
  approved the work item;
- CI or scheduled automation: the maintainer-approved workflow definition,
  limited to its recorded triggers, permissions, and actions;
- delegated workers and coordinators: the initiating principal, whose scope is
  inherited rather than expanded.

A coordinator or lead may relay the principal's instruction, but does not
independently acquire broader authority. Non-interactive workflows cannot
approve their own exceptions or expand their own permissions.

### Instruction precedence

1. Governing platform, security, and legal policy controls.
2. A direct instruction from the task principal controls the active task within
   those policies.
3. A direct pause, stop, or scope restriction supersedes older delegated,
   coordinator, lead-task, and background-agent messages.
4. A delegated instruction is valid only within the principal's existing scope.
   It MUST identify its source and preserve the newer user instruction or other
   verifiable provenance.
5. Conflicting, unproven, or broader delegated instructions MUST NOT silently
   expand authorization.
6. After a direct pause, resume only from a newer direct user instruction or an
   authenticated relay of that instruction. If provenance is uncertain, remain
   paused.

A pause applies to the active task and its descendant workers unless the
principal explicitly gives it broader scope. It does not silently cancel an
unrelated authorized workstream.

An authenticated relay identifies the source task or thread and carries the
newer principal instruction verbatim or through a tool-provided provenance
record. A bare statement that the user resumed is not sufficient.

### Pause procedure

At the next safe boundary:

1. Safely cancel the current operation when possible. If cancellation would
   corrupt state, allow only that non-interruptible atomic operation to finish.
   Do not start another.
2. Interrupt or stop background agents and recurring operations.
3. Preserve the resulting files and external state. Report any unavoidable
   side effect from the operation that had to finish.
4. Do not edit, test, stage, commit, push, merge, clean, or delete.
5. Report the worktree, current changes, last verified result, and actions not
   taken.
6. Wait.

An atomic operation is one already-running tool or filesystem action that
cannot be interrupted safely. It does not include a planned patch series, test
suite, checkpoint, agent turn, or remaining task.

## 3. Start-of-task safety snapshot

Before the first mutation, record:

- repository root;
- active branch and starting commit;
- worktree path;
- relevant remote/base commit when the work depends on it;
- tracked and untracked changes;
- baseline hashes or equivalent before-state evidence for protected and
  concurrently owned files;
- protected files, artifacts, and worktrees;
- authorized file and action scope;
- verification required for the change type.

If the intended checkout is dirty or shared with unrelated work, create or use
an approved isolated worktree. Do not reset, stash, clean, copy over, or absorb
unrelated changes to manufacture a clean state.

## 4. Concurrency and ownership

1. One writer owns a file at a time.
2. Before parallel writes, atomically claim an ownership entry in a shared,
   discoverable coordination ledger or channel visible to every writer. Record
   the worker, exact file scope, baseline commit or hashes, and when ownership
   ends. Private plans are not a shared ownership record.
3. Parallel workers MAY share a worktree only with disjoint declared file
   scopes in that shared ledger. If the environment cannot provide a reliable
   shared claim, use isolated worktrees or keep additional workers read-only.
4. Immediately before mutation, revalidate that the owned file still matches
   its recorded baseline or the writer's last known change.
5. A worker MUST NOT edit a file another worker owns.
6. Acceptance binds to an exact commit or recorded diff/status snapshot. Any
   later authorized change invalidates that acceptance and requires delta
   review; the task principal may authorize a correction without waiting for
   the reviewer to request it.
7. Every correction after review receives a delta receipt and fresh relevant
   verification.
8. Background work MUST stop when the direct user pauses the task.

## 5. Tool capability contract

Before relying on an unfamiliar tool, plugin, browser wrapper, or object:

1. Read its current documentation, skill instructions, or callable schema.
2. Determine whether exposed objects are native library objects or restricted
   wrappers.
3. Perform one harmless capability probe when uncertainty remains.
4. Record or reuse the confirmed capability rather than guessing method names.

An unsupported call is a signal to stop and inspect the interface. Do not
continue by trying plausible method names. Native library documentation does
not prove that a sandbox wrapper exposes the same API.

## 6. Mutation contract

### Prohibited positional edits

Line numbers MAY be used to inspect or discuss source. They MUST NOT be used as
mutation coordinates. Do not insert, delete, or replace source based on fixed
line indexes or line-count loops.

### Approved editing hierarchy

Choose the least disruptive method that preserves structure:

1. A uniquely anchored contextual patch for a small, local source change.
2. A parse-and-serialize operation for structured formats such as JSON.
3. A standards-based DOM/HTML parser for HTML structure.
4. An AST/CST-aware transform for broad or structural code changes.
5. A repository-provided migration or formatting script when it is the
   established authority.

AST/CST transforms are not mandatory for every small edit. A contextual patch
is professional when its anchor is unique, its expected surrounding content is
verified, and its diff is reviewed.

### Mutation preconditions

Before applying a change:

- confirm the target is in the authorized worktree and file scope;
- inspect the current target content;
- confirm the anchor or structured target exists exactly as expected;
- stop if the target is missing, duplicated, or materially different;
- avoid broad replacements whose match count is not known.

After every logical change:

- inspect the focused diff;
- check for accidental neighboring changes;
- parse or syntax-check the touched artifact when applicable;
- keep unrelated formatting churn out of the diff.

## 7. HTML and DOM contract

Regular expressions MUST NOT parse HTML structure, locate DOM nodes, or extract
embedded script elements. Attribute order, whitespace, quoting, comments, and
formatting changes make regex-based parsing unsafe.

Use a standards-based parser or the live browser DOM. Every structural lookup
MUST:

- use semantic selectors or stable test hooks;
- assert the expected number of matches;
- assert required content or attributes;
- fail explicitly on zero or ambiguous matches.

Regex remains acceptable for plain-text searches that do not claim to
understand HTML structure.

## 8. Deterministic browser and UI synchronization

Every automated UI action defines:

1. the action;
2. the observable condition proving completion;
3. a bounded timeout;
4. diagnostics to capture if the condition is not met.

Preferred readiness evidence includes:

- a locator becoming visible, enabled, or attached;
- a field, label, or region reaching an expected value;
- an application state marker or explicit ready event;
- a specific request or response completing;
- a known render generation or save acknowledgement;
- fonts and layout becoming ready for visual capture.

Fixed sleeps, delay loops, and arbitrary timeouts MUST NOT be the evidence that
an operation completed. A short, bounded delay MAY be used after deterministic
readiness for animation settling or screenshot stability. Debounce behavior
SHOULD use a fake clock when available and MUST assert the observable
post-debounce state; elapsed time alone never proves completion.

For screenshot verification, disable nonessential animation when practical and
capture console errors and the relevant DOM state on failure.

### Bounded legacy-verifier transition

At adoption, `scripts/verify.mjs` contains pre-existing static checks that use
regular expressions to infer HTML structure and browser sequences that use
fixed post-action delays. Those checks remain temporarily runnable only as a
legacy compatibility gate. They are not authoritative DOM-parsing or readiness
evidence under sections 7 and 8.

This transition exception:

- is limited to the exact legacy checks present at base commit
  `7634c47b5846d70caccb0e2c0dcbaa6635954592`;
- does not permit a new check, broader match, longer delay, copied pattern, or
  additional flow to use those techniques;
- expires for an affected check when its UI flow or asserted artifact is next
  materially modified, or when that check is migrated, whichever occurs first;
- requires every touched flow to use a standards-based parser or live DOM for
  structure and an observable condition for readiness before completion can be
  claimed; and
- requires the next UI implementation PR after this protocol is adopted to
  create or link a repository-tracked migration item that inventories the
  untouched legacy checks and defines their removal criteria.

Running the legacy verifier remains required during this transition because it
still guards broad compatibility. Its pass does not compensate for missing
deterministic evidence on a touched flow.

## 9. Failure discipline

Classify a failure before changing code or tests:

- product defect;
- test defect;
- fixture or source-of-truth update;
- environment or unavailable capability;
- stale expectation;
- authorization or scope blocker.

MUST NOT:

- weaken an assertion solely to obtain green output;
- replace a deterministic condition with a sleep;
- broaden selectors until an unrelated element matches;
- convert missing values into zero without a contract proving zero;
- hide an unavailable browser or tool as a pass;
- repeatedly guess APIs after a capability failure.

When a source-of-truth change legitimately alters expected values, document the
authority and independently cross-check the new derived expectations.

## 10. Verification contract

Follow the change matrix in [ARCHITECTURE.md](ARCHITECTURE.md):

- engine and tax changes: `npm test`;
- UI, `src/main.js`, or HTML changes: `npm test` plus
  `node scripts/verify.mjs`;
- documentation-only changes: application tests are not required.

For files not classified by that matrix, verify by impact:

- `src/planning/tax/*`: `npm test`;
- `styles/*`, rendered state, household/scenario UI orchestration, or other
  user-visible behavior: `npm test` plus `node scripts/verify.mjs`;
- scripts and configuration: prefer static validation or a documented safe
  dry-run, plus the impacted application suite. Execute a side-effecting,
  deployment, migration, cleanup, or publishing script only when that action is
  separately authorized under Section 12;
- dependency or package changes: perform the approved install/lockfile
  validation, then the impacted test and browser suites;
- uncertain impact: use the stronger applicable verification rather than the
  weaker one.

During the bounded transition in section 8, UI work still runs
`node scripts/verify.mjs`, but a passing legacy verifier is not sufficient by
itself. The completion receipt must identify every touched UI flow and the
parser/live-DOM and observable-readiness evidence that replaced or superseded
its relevant legacy checks.

Documentation-only work still requires:

- a clean focused diff review;
- `git diff --check` for tracked changes;
- an explicit whitespace/content check for every untracked deliverable, because
  ordinary `git diff --check` does not inspect new untracked files;
- inclusion of every untracked deliverable in the focused review;
- validation that referenced repository paths and commands exist;
- before/after baseline evidence confirming protected worktrees remain
  unchanged.

Record exact commands, pass/fail counts, unavailable capabilities, and generated
artifacts. A prior run is evidence only for the exact source state it tested.

## 11. Completion and checkpoint receipt

A completion or review receipt includes:

- repository, worktree, branch, and starting/current commit;
- exact modified and new files;
- staged state;
- focused and full verification commands and results;
- browser evidence for UI work;
- known limitations, supplied-only paths, and deferred scope;
- scope deviations and their approval;
- confirmation of protected work left untouched;
- explicit confirmation of whether staging, commit, push, PR, merge, cleanup,
  and deletion occurred.

An acceptance receipt also identifies the exact commit or diff/status snapshot
that was reviewed. Acceptance does not carry forward across a changed snapshot
without a delta review.

Do not claim completion while required verification is failing, unavailable
without disclosure, or stale relative to the current diff.

## 12. Publishing and destructive actions

Editing authorization does not automatically authorize staging, committing,
publishing, merging, or destructive cleanup.

- Resolve exact targets before a destructive action.
- Prefer recoverable operations.
- Never reset, restore, force-checkout, rebase, stash, overwrite, move, or clean
  active-task or unrelated work merely to manufacture a clean state.
- Reset, restore, force checkout, rebase, stash, history rewriting, forced push,
  recursive move, overwrite, and deletion require target-specific approval plus
  before-state and recovery evidence.
- Stop for explicit approval before staging, commit, push, PR creation, merge,
  permanent deletion, or any broader action not already authorized.

## 13. Exceptions and protocol changes

A protocol exception requires:

- the rule being excepted;
- a concrete reason;
- bounded files and duration;
- compensating safeguards and verification;
- explicit approval recorded before proceeding.

Convenience, speed, or a desire to make a failing check pass is not an
exception.

Only the repository owner or a designated maintainer may approve a
repository-protocol exception or revision. A task requester without that role,
CI, scheduled automation, coordinators, and delegated workers cannot approve
one. Governing platform, security, and legal policy cannot be excepted by this
document. Protocol revisions require independent review before adoption.

This protocol is versioned rather than immutable. Review it after a material
toolchain change, a safety incident, or an external execution audit. Protocol
changes should be isolated, reviewed, and adopted before the next implementation
phase they are intended to govern.

## 14. Compact execution checklist

### Before

- Confirm authority and mutation scope.
- Snapshot repo, branch, commit, worktree, and dirty paths.
- Record protected baselines and assign one writer per file.
- Read architecture, principles, and relevant tool schemas.
- Define required verification and deterministic readiness signals.

### During

- Use structured or uniquely anchored edits.
- Inspect the focused diff after each logical change.
- Parse HTML with the DOM, not regex.
- Wait on observable state, not elapsed time.
- Stop on failed preconditions or unknown capabilities.

### After

- Run the required focused and full verification.
- Inspect the final diff and staging state.
- Record limitations and unavailable checks honestly.
- Produce the checkpoint receipt.
- Do not stage, commit, push, open a PR, publish, merge, clean, overwrite, move,
  or delete without the applicable authorization.

## Workflow classification

- Risk tier: <!-- Tier 1 / Tier 2 / Tier 3 -->
- Risk rationale:
- Work type: <!-- feature / defect / governance / docs / test -->
- Lifecycle: <!-- Draft-ready / Merge-ready -->
- Hold: <!-- None / Owner decision / Scope / Verification / CI / Review / Deployment / External blocker -->

## Outcome and scope

### Outcome

<!-- What can the user or advisor do, see, or trust after this ships? -->

### Included

-

### Done when

-

### Authority

<!-- Projection Engine / Tax Engine / household / planning / Scenario / UI / styling / governance -->

### Protected boundaries

-

### Non-goals

-

## Candidate identity

- Base commit SHA:
- Candidate head SHA:

## Acceptance evidence

| Done-when criterion | Baseline or pre-fix evidence | Production change | Verification | Candidate result |
|---|---|---|---|---|
| | | | | |

## Defect reproduction and root cause

<!-- Required for work type `defect`. Otherwise write `Not applicable - not a defect.` -->

- Exact reproduction:
- Base failure evidence:
- Root cause:
- Fail-before regression evidence:
- Pass-after candidate evidence:

## Implementation and authority

<!-- List production files and why each change belongs in the named authority. Write `None - test/docs/governance-only` when true. -->

## Tests and verification

### Focused evidence

<!-- Exact command or live action, candidate SHA, and actual result. -->

### Required local commands

```text
npm run governance:check  # actual result
npm test                  # actual result, or Tier 1: required CI
npm run verify            # actual result, or Tier 1: required CI
git diff --check          # actual result
```

## Protected policy and compatibility evidence

<!-- Required for Tier 3. State the approved policy and applicable financial, tax, migration, compatibility, security, or deployment evidence. Otherwise write `Not applicable - Tier 1/2.` -->

## Required CI status

- [ ] Governance safeguards
- [ ] Unit tests
- [ ] Build deployable site artifact
- [ ] Full browser verification

## Independent review

- Review method: <!-- separate /review against main or @codex review -->
- Reviewer/result link:
- Findings and re-review status:

## Known failures and proof gaps

<!-- Include every failing gate, unavailable environment, unverified behavior, and hold condition. Write `None.` only when true. -->

## Rollback and deployment

- Rollback considerations:
- Saved-data risk:
- Deployment impact:
- Planned live proof:
<!-- Complete after merge: candidate SHA -> squash merge SHA -> Pages run/artifact -> live proof. -->
- Post-merge identity chain:

## Truthful completion gate

<!-- Check only for Lifecycle: Merge-ready. -->
- [ ] Every scoped behavior meets its done-when evidence on this candidate, and every required check and review is satisfied.

Do not describe this PR as `fixed`, `complete`, or `merge-ready` while this
checkbox cannot be checked or any required gate remains unresolved.

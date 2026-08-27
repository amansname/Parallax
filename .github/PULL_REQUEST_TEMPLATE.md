## Problem and user-visible impact

<!-- Quote or link every reported symptom. Explain the financial or data impact. -->

## Exact reproduction

- Base commit SHA:
- Branch commit SHA:
- Fixture: <!-- clean / persisted-current / persisted-legacy and exact path -->
- Browser origin and route:
- Exact steps and observed output:

## Root cause

<!-- Identify the responsible production path. A failing test is not the root cause. -->

## Acceptance matrix

| Reported symptom | Exact reproduction | Pre-fix failure | Production change | Regression assertion | Post-fix proof |
|---|---|---|---|---|---|
| | | | | | |

## Production code changed

<!-- List production files and why each is required. Write "None — test/governance-only" when true. -->

## Tests added or changed

<!-- List each test/fixture and the product contract it protects. -->

## Fail-before evidence

<!-- Exact base SHA, command, exit/result, and failure for the reported reason. -->

## Pass-after evidence

<!-- Exact branch SHA, command, exit/result, and asserted user-visible output. -->

## Persisted-state and migration impact

<!-- State exact saved fixture, schema/scenario versions, migration behavior, and source-byte preservation. -->

## Financial invariants checked

<!-- List every applicable invariant from docs/CODEX_WORKFLOW.md and its evidence. -->

## Exact commands and results

```text
npm run governance:check  # actual result
npm test                  # actual counts and result
npm run verify            # actual result or exact first failure
git diff --check          # actual result
```

## Required CI status

- [ ] Governance safeguards
- [ ] Unit tests
- [ ] Full browser verification

## Known failures and proof gaps

<!-- Include pre-existing failures, unverified behavior, unavailable environments, and why each remains. -->

## Scope exclusions

<!-- List related defects, refactors, copy changes, deployments, or cleanup not included. -->

## Independent review status

- Review method: <!-- separate /review against main or @codex review -->
- Reviewer/result link:
- Findings and re-review status:

## Rollback considerations

<!-- State rollback steps, saved-data risk, and whether schema or fixture changes are reversible. -->

## Truthful completion gate

- [ ] Every behavior described as fixed was reproduced on the base branch and directly verified on this branch.

Do not describe this PR as “fixed,” “complete,” or “merge-ready” when the
checkbox above cannot truthfully be checked or any required check is failing.

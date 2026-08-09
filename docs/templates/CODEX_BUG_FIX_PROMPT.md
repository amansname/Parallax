# Parallax bug-fix task template

Copy this template into a new task and replace the bracketed text. Plain
observations are enough; do not guess at code or root cause.

## Goal

[What should the user be able to see or do after this change?]

## Exact reported behavior

- Page or tab: [where it happens]
- What I entered or clicked: [exact steps]
- What I expected: [visible result]
- What happened instead: [visible result, blank, error, or unavailable message]
- When it began, if known: [date, release, or PR]

## Relevant saved fixture

- State type: [clean / saved current state / saved legacy state]
- Household/scenario identifier with personal details removed: [fixture name]
- How to reproduce from that state: [steps]
- Personal information removed: [yes/no — do not attach until yes]

## Context

[Links to the issue, screenshots, prior PRs, or notes. Screenshots are
supplemental; describe the numbers or state in text too.]

## Constraints

- Work only on [feature/bug].
- Do not change [out-of-scope behavior].
- Preserve [important contract or saved data].
- Use the canonical local origin `http://127.0.0.1:8825/`.

## Done when

- [Observable outcome 1]
- [Observable outcome 2]
- Every acceptance-matrix row is complete.
- Required checks and independent review are recorded.

## Required financial invariants

[Choose applicable items from `docs/CODEX_WORKFLOW.md`, such as Summary tax =
Withdrawal baseline tax, Goals Essentials = Cash Flow Essentials after documented
overrides, or a withdrawal lever changes the expected financial column.]

## Required commands

```text
npm run governance:check
npm test
npm run verify
git diff --check
```

## Expected evidence

- Base and branch commit SHAs
- Exact reproduction on base
- Completed acceptance matrix
- Failing test on base for the reported reason
- Passing targeted test on the branch
- Exact full-command results and known failures
- Browser output/state assertions; screenshots only as supplements
- Separate `/review` against `main` or `@codex review`

## Explicit exclusions

[List bugs, refactors, copy changes, deployments, or cleanup that must not be
included.]

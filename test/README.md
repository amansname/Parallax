# Test inventory

Run `npm test` from the repository root. The existing four tax pretests run
first; the runner then discovers every `.test.js`, `.test.mjs`, `.test.cjs`,
and corresponding `.spec.*` file outside dependency, generated-output, and
worktree directories. New tests no longer need a package-script edit.

`npm run test:inventory` lists every test file under its execution category.
Governance tests keep their separate `npm run governance:check` command.
Missing or duplicated explicit pretest/governance entries fail discovery.
Symlinks are not traversed. Do not place source tests in an excluded directory.

## Projection Engine contracts

`test/engine/` replaces the former root `engine.test.js`. Each suite describes
one engine contract: simulation, income, expenses/goals, property sales, RMD
lifecycle, account inputs/savings, federal funding, household timeline,
withdrawal limits/cash, current-year RMD reserves, path assessment, owner
allocation, spending migration, and historical account allocation.

Shared fixture factories live in `test/engine/fixtures.js`; helpers used by only
one suite stay beside that suite. Fixture factories return fresh state. All
147 original test cases and their expectations are preserved. If an engine
change breaks these contracts, reconcile the cause before continuing; do not
change expected financial results to obtain a passing run.

Run an individual contract with, for example,
`node --test test/engine/federal-funding.test.js`.

# ESLint

Run from the repository root after installing the locked development dependencies:

```text
npm ci
npm run lint
```

The pinned ESLint version requires Node ^20.19.0, ^22.13.0, or >=24.0.0.
The setup was verified with Node 24.16.0.

## What it checks

`eslint.config.js` applies ESLint's recommended JavaScript rules to `.js`,
`.mjs`, and `.cjs` files, including tests, scripts, and agent hooks. Unused
variables are warnings; other recommended problems retain error severity.
There are no formatting or file-length rules. The command reports findings
without changing source files.

Application modules under `src/` and `ui/` receive browser globals; tests and
Node scripts receive Node globals. The root engine receives only standard
JavaScript globals. Browser automation scripts and the extracted browser
contract modules receive both environments
because they contain callbacks executed in the page. This cannot check which
runtime a callback executes in; browser tests remain necessary.

Dependency folders, worktree copies, caches, generated site artifacts,
verification output, and coverage output are excluded. Source and test
directories remain included, including shared test fixtures. The unit runner
discovers tests automatically; lint is a separate check.
HTML-embedded scripts and CSS are not covered by this JavaScript configuration.

## Initial rollout

This is a local reporting command. It is not wired into the test command,
required CI checks, editor settings, or a scheduled job. Existing lint findings
are a cleanup baseline, not a reason to change application behavior during
tool setup. A nonzero result is retained; there are no baseline suppressions or
exit-code overrides.

Run it while editing and before opening a pull request. An editor ESLint
extension can show the same rules while typing but is optional. Review the
baseline before proposing CI enforcement as a separate change. Weekly checks
are optional; per-change checks provide earlier feedback.

Do not apply `--fix` across the repository without reviewing the proposed
changes. Do not delete tests solely because they contain lint findings. This
tool does not replace unit/browser tests, CodeScene's structural analysis,
Knip's unused-code analysis, or Stryker's mutation testing.

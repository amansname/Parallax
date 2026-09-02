# ESLint

Run from the repository root after installing the locked development dependencies:

```text
npm ci
npm run lint
npm run lint:changed
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

## Pull-request enforcement

`npm run lint` remains the full-repository reporting command. Existing findings
are a cleanup baseline, and its nonzero result is retained without a blanket
suppression or exit-code override.

Every pull request also runs the required `ESLint` job. It invokes
`npm run lint:changed` against the pull request merge-base range and applies the
same configuration to every added, copied, modified, or renamed `.js`, `.mjs`,
or `.cjs` file. A changed file with an ESLint error fails the job; warnings stay
visible without changing their configured severity. A pull request with no
changed JavaScript files passes with an explicit zero-file receipt.

Run the same check locally from a candidate branch after fetching `origin/main`:

```text
npm run lint:changed
```

Use `--base <revision> --head <revision>` only when reviewing a different
explicit range. The script resolves both revisions to full commit SHAs before
constructing the merge-base diff and passes file paths directly to ESLint
without shell interpolation.

Run lint while editing and before opening a pull request. An editor ESLint
extension can show the same rules while typing but is optional. Review the
full baseline before proposing broad cleanup. Weekly full-repository checks are
optional; the required changed-file check provides immediate PR feedback.

Do not apply `--fix` across the repository without reviewing the proposed
changes. Do not delete tests solely because they contain lint findings. This
tool does not replace unit/browser tests, CodeScene's structural analysis,
Knip's unused-code analysis, or Stryker's mutation testing.

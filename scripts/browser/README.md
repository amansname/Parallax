# Browser verification

Run `npm run verify` from the repository root. `scripts/verify.mjs` owns the
ordered campaign, immutable-artifact setup, unit-test invocation, per-contract
timing, and final browser-error check. The required CI browser job may set
`PARALLAX_VERIFY_SKIP_UNIT_TESTS=1` only after its required Unit tests dependency
passes; local `npm run verify` retains the complete unit-plus-browser gate. The
canonical origin remains `http://127.0.0.1:8825/`. No feature module is a
standalone preview server or an alternative gate.

CI uses `verification-plan.mjs` to select browser groups from the full PR
merge-base diff. Entry always runs; known narrow routes select their affected
groups. Shared/unknown paths and all pushes to main run all six groups.
Renames include the old and new paths. Selection failures block the artifact
job and required aggregate. The selected groups appear in the artifact job's
summary and as `Verify <group>` jobs. A newer revision cancels the unfinished
quality run for that PR without cancelling other PRs or main runs.

The campaign is deliberately sequential. Later checks depend on household,
scenario, and browser state created by earlier checks. The wizard runs in its
own browser context, with its existing fixture and restoration assertions; an
exact-byte check also protects the parent context's saved state. Do not
parallelize the steps or reset saved state to make an assertion pass.

- `artifact.mjs`, `artifact-server.mjs`, and `browser-session.mjs` retain artifact
  identity, server boundaries, browser setup, and transport diagnostics.
- `withdrawal-*.mjs`, `goals.mjs`, `scenario-*.mjs`, `funding.mjs`, `design.mjs`,
  and `sequencing.mjs` own their existing feature checks.
- `persistence-*.mjs` retain Joe startup, saved selection, migration, corrupt
  bytes, read-only behavior, and explicit deletion checks.
- `cashflow/campaign.mjs` sequences fixture setup, Typical view, scenario
  selection, historical checks, disclosures, and restoration. Historical
  snapshots, presentation, independent metric expectations, goal edits,
  underfunding, and new-session reload checks have separate modules.
  Cash Flow receives a complete baseline captured after the funded household
  and both spouses are entered, before unrelated campaign edits. Its setup
  clones that baseline; restoration checks the ages declared by that setup.
  The synthetic no-capital matrix receives a separate Node-side plan template,
  because the browser's exported `defaultPlan` is the mutable active household.
- `wizard/` separates wizard actions, exact storage restoration, diagnostics,
  capture, and feature contracts. The public exports remain available from
  `scripts/wizard-browser-contract.mjs`, including the manual capture API.

This extraction preserves the pre-existing browser callbacks and failure
assertions. The legacy static checks and transport retry remain bounded by
`docs/EXECUTION-PROTOCOL.md`; relocation does not expand their exception or
make them authoritative substitutes for visible behavior checks.

# Browser verification

Run `npm run verify` from the repository root. `scripts/verify.mjs` owns the
ordered campaign, immutable-artifact setup, unit-test invocation, and final
browser-error check. The canonical origin remains `http://127.0.0.1:8825/`.
No feature module is a standalone preview server or an alternative gate.

The campaign is deliberately sequential. Later checks depend on household,
scenario, and browser state created by earlier checks. Do not parallelize the
steps or reset saved state to make an assertion pass.

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
- `wizard/` separates wizard actions, exact storage restoration, diagnostics,
  capture, and feature contracts. The public exports remain available from
  `scripts/wizard-browser-contract.mjs`, including the manual capture API.

This extraction preserves the pre-existing browser callbacks and failure
assertions. The legacy static checks and transport retry remain bounded by
`docs/EXECUTION-PROTOCOL.md`; relocation does not expand their exception or
make them authoritative substitutes for visible behavior checks.

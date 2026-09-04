# Browser verification

Run `npm run verify` from the repository root. `scripts/verify.mjs` owns the
ordered campaign, immutable-artifact setup, unit-test invocation, per-contract
timing, and final browser-error check. Required CI browser jobs set
`PARALLAX_VERIFY_SKIP_UNIT_TESTS=1` only after their required Unit tests dependency
passes. Pull requests always select the short `startup` smoke shard and add only
the affected `wizard`, `planning`, or `persistence` shards from the merge-base
diff. Main, scheduled, and manually dispatched runs select all four shards.
The isolated shards run in parallel through `PARALLAX_VERIFY_SHARD`, have a
five-minute ceiling, and feed the single required `Full browser verification`
aggregate. The CI `wizard` shard uses the focused semantic smoke profile; Local
`npm run verify` selects no shard and retains the complete unit-plus-browser gate. The
canonical origin remains `http://127.0.0.1:8825/`. No feature module is a
standalone preview server or an alternative gate.

Checks inside each shard are deliberately sequential because later checks can
depend on state created earlier in that shard. CI may parallelize only the four
documented shards, each of which starts with its own browser and saved state. Do
not parallelize individual steps or reset saved state to make an assertion pass.

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

# Persisted browser-state fixtures

These fixtures preserve localStorage strings exactly as the browser supplies
them. `clean-state.v1.json` represents an empty origin. Files named
`legacy-state*.json` represent pre-current saved state and must remain separate
from clean fixtures.

Browser regression setup must load every `storage` value byte-for-byte before
the application starts. A migration test must not clear, delete, reseed,
normalize, or repair the triggering values first. Assert source bytes,
migration result or reason code, destination bytes, visible behavior, and an
idempotent reload.

All fixtures require `anonymized: true`. Do not add names, addresses, emails,
phone numbers, Social Security numbers, employers, account numbers, secrets, or
other identifying information. Preserve the defective state while removing
identity. A fixture or expected-value change requires a product-contract reason
in the acceptance matrix and PR.

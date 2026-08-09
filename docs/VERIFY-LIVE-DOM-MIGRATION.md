# Legacy verifier migration inventory

This repository-tracked inventory satisfies the transition requirement in
`docs/EXECUTION-PROTOCOL.md` for the legacy checks that existed at protocol
base commit `7634c47b5846d70caccb0e2c0dcbaa6635954592`.

The legacy checks below remain compatibility signals only. They are not
authoritative DOM or readiness evidence. Stable helper and step names identify
each location in `scripts/verify.mjs` without relying on shifting line numbers.

## Migrated in the Withdrawal Planner Brokerage fix

The funded Brokerage missing-basis path in the `Tax Buckets: withdrawal
planner loads with display ceilings and live tax output` step now:

- loads exact persisted current-schema Brokerage data with unknown basis and
  verifies the adapter's module-local 50% principal / 50% gain assumption;
- moves the visible Brokerage range input through its `input` event;
- waits for the exact adapter-derived federal tax, long-term-gain tax,
  Brokerage attribution, and non-zero long-term-gain fill; and
- resets the control and waits for the exact baseline state.

No regex HTML-structure inference or fixed post-action delay is evidence for
that path.

## Untouched static source/markup heuristics

| Stable anchor | Legacy check | Removal criterion |
| --- | --- | --- |
| `verifyTaxBuckets()` stylesheet/order/mount assertions | Stylesheet links, tab order, and Tax Buckets mount inferred from `index.html` text | Replace with a standards-based HTML parser or live-DOM assertions for link presence, ordered navigation, and a unique mount node. |
| Remaining source assertions in `verifyTaxBuckets()` | Module wiring and UI/source ownership inferred from source-text regexes | Replace each architectural assertion with an import-level test, dependency-boundary governance check, or live-DOM behavior assertion; then delete the corresponding regex. |

## Untouched fixed-delay browser sequences

| Stable anchor | Flow | Removal criterion |
| --- | --- | --- |
| `setCashFlow()` | Cash Flow toggle helper | Wait for the requested toggle state and the corresponding rendered view; any later animation settle must occur only after that condition. |
| `goals Horizon: timeline...` and `goals Horizon: add, edit...` | Goals Horizon load and editing flows | Wait for the exact lane/card, saved-state, toast, or mutation result required by each action. |
| `scenarios Compare view...` and `scenarios Focus view...` | Scenarios Compare and Focus controls | Wait for the exact status transition and recomputed visible probability/value for the changed control. |
| `cash-flow view: exact columns...` | Cash Flow run, pill, and tax-path changes | Wait for the requested active pill/path plus the matching engine-backed rows and tax disclosure. |
| `visual contract: flush 56px header rail...` | Header visual contract | Wait for fonts and the final computed layout state before an optional bounded screenshot settle. |
| `theme: product pages...` | Shared-theme visual contract | Wait for the target page and final computed theme styles before an optional bounded screenshot settle. |
| `tax-funded probability is the only probability...` | Tax-funded probability after Run | Wait for the completed Run status and exact tax-funded probability DOM. |
| `persistence: BLOCKED is inert...` | Blocked persistence recovery | Wait for the blocked state and byte-preservation result after each attempted action. |
| `persistence: READ_ONLY disables...` | Read-only persistence recovery | Wait for the read-only state, disabled mutations, navigable target, and byte-preservation result after each action. |

Browser-harness retry delays around reload and detached-frame recovery are not
product-readiness evidence. Keep them bounded and replace them with browser
lifecycle events when the harness is next materially changed.

## Migration rule

When a listed flow or asserted artifact is materially modified, migrate or
remove its corresponding legacy check in the same PR. Completion evidence must
name the new live-DOM or parser assertion and its observable readiness
condition. Delete this inventory when every row has been removed or replaced.

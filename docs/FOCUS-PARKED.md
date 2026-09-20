# Focus mode: parked

Owner decision, September 20, 2026: remove the unused Focus mode from the live
application and preserve a recoverable reference. This precedes the separately
scoped unchanged-scenario calculation optimization.

## Recovery reference

The complete pre-removal application, including Focus and its tests, is preserved
at Git commit `b10d43e806770785b546ae54c245d13921655ea0`:
[browse the preserved source](https://github.com/amansname/Parallax/tree/b10d43e806770785b546ae54c245d13921655ea0).

Key paths at that commit:

- `index.html`: Compare/Focus toolbar.
- `ui/scenarios.js`: Focus renderer, probability hero, range, assumptions, goals,
  scenario rail and historical stress presentation.
- `ui/scenariosController.js`: Focus routing, picker and edit wiring.
- `styles/scenarios.css`: dedicated Focus styles.
- `src/scenarios/createScenarioRunController.js`: lazy stress worker lifecycle.
- `src/scenarios/historicalStress.js`: five historical eras and stress runner.
- `src/planning/runScenarioBatch.js` and `scenarioWorker.js`: stress worker dispatch.
- `scripts/browser/scenario-views.mjs`, `startup-responsiveness.mjs`, and
  `ui/scenarios.test.js`: original Focus acceptance checks.

Inspect with `git show b10d43e806770785b546ae54c245d13921655ea0:ui/scenarios.js`.
Any future revival should start in a separate checkout, review the product need,
and revalidate current engine, UI and data contracts. Do not restore the complete
old app over newer work. No duplicate runtime copy or hidden feature flag is kept.

## Remaining product contract

Scenarios opens in Compare. Its toolbar controls, in order, are Compare, Cash
Flow, and Add. Compare returns from Cash Flow; switching views preserves the
selected scenario and its calculated financial outputs. There is no Focus tab,
Focus renderer API, scenario rail, probability hero, or historical-stress worker.

Sequencing and Cash Flow keep their historical functionality. In particular,
`normalizeHistoricalStrategy` and `retireNowClone` remain in
`src/scenarios/historicalStress.js` because Sequencing still uses them. The
result-to-input snapshots remain necessary for Cash Flow. Financial engines,
1,000-path settings, household/scenario persistence and shared market paths retain
their existing contracts.

Removing Focus is a product and maintenance simplification. It does not claim to
speed up the existing Compare calculation batch or solve first-visit loading.

## Acceptance ledger

| Request | Starting evidence | Candidate requirement |
| --- | --- | --- |
| Remove Focus from the live flow | Base commit exposes Compare and Focus tabs; live Focus opens its hero, assumptions, rail and five historical eras | Exact three-control toolbar, no Focus DOM/API; Compare and Cash Flow navigate normally |
| Park the work for recovery | Complete pre-removal Git commit recorded above | Stable source link and file inventory; no duplicate deployed implementation |
| Disconnect Focus-only work | Controller requests stress; worker dispatches `kind: stress` | Retired job is rejected; ordinary scenario worker and cancellation remain functional |
| Preserve remaining planning behavior | Existing canonical-result, historical continuity, funding, allocation and saved-state suites | Same financial results and inputs; planning-age assertion moves to the visible Cash Flow ledger |
| Make unchanged scenarios faster | Earlier live edit-to-results measurement averaged 13.8 seconds | Separately scoped; no cache or speed claim in this change |
| Reddit first-load/Firefox reports | Reported separately from this retirement | Separately scoped; no bundling or browser-loading changes |

Focus-only display and stress-retry assertions are retired under this explicit
product decision. Shared financial-result, read-only persistence, allocation,
planning-age and navigation assertions remain or are moved to Compare/Cash Flow.

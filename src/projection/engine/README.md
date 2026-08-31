# Projection Engine implementation

`engine.js` at the repository root remains the public interface and logical
calculation authority. UI and planning consumers keep importing it. These
internal modules separate responsibilities without changing the public API.

- `execution.js`: supported dimensions and path validation.
- `householdTimeline.js`: per-person timelines, survival, and income availability.
- `traditionalOwners.js` and `requiredDistributions.js`: ownership, distributions,
  rollover boundaries, and RMD facts.
- `marketAssumptions.js` and `defaultPlan.js`: unchanged market data, profiles,
  assumptions, and the single shared default-plan object.
- `resolveInputs.js` and `withdrawalPlanner.js`: plan resolution, reservations,
  lever approval, and Withdrawal Planner cash contracts.
- `accountFunding.js`, `federalFunding.js`, and `singlePath.js`: funding helpers,
  federal-funding convergence, and ordered annual account transitions.
- `analyzeResults.js`: result aggregation, path diagnostics, and assessment.
- `simulation.js`: the single private seeded random stream, path generation,
  Monte Carlo orchestration, and historical runs.

The existing account ledger and allocation-return modules remain in
`src/projection/`. The Tax Engine remains in `src/tax/`; planning adapters connect
the two authorities. Do not duplicate their calculations here or in the UI.

The initial extraction preserved all 84 original engine declarations. The
cleanup then retired ten verified-unused private helpers, leaving 74 retained
declarations; the public export list remains unchanged. Integration of PR #252
applies its full-balance rollover correction in `traditionalOwners.js`, with
the same function body as main and its regression in `test/engine/`.
Some internal algorithms remain long and complex. This module split establishes
reviewable boundaries; it does not claim that every function is simple or that
a new CodeScene score has been measured.

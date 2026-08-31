# IRA remainder rollover: local repair

## Scope and authority

Tier 3: Projection Engine ownership and Cash Flow failure presentation.
Base: `5a56edc9e3119dc7fb77032be555a9c0f10377e5` (PR #251).
Branch: `codex/ira-rollover-remainder-20260831`.
Owner approved isolated local implementation, tests, and a bot-authored local
commit for immutable browser verification. No push, PR, merge, or deployment.
Authority: AGENTS.md, PRINCIPLES.md, docs/CODEX_WORKFLOW.md,
docs/EXECUTION-PROTOCOL.md, docs/ARCHITECTURE.md, docs/CODE_REVIEW.md.

## Original symptoms and acceptance ledger

| Symptom/request | Disposition | Evidence and remaining acceptance |
|---|---|---|
| Baseline and Aggressive probabilities/medians unavailable at age 92 | Deferred exact-household confirmation | Supplied screenshots show client age 65, spouse 63, both plan-end 90, correctly labeled rollover IRA owners. Their saved allocation/spending/scenario state is unavailable. No claim of exact saved-state replay. |
| Full eligible IRA rollover, including tiny remainders | Fixed locally, subject to final verification | Synthetic death-boundary test fails before production change with HOUSEHOLD_RMD_UNAVAILABLE / TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE at age 92. Both directions, 0/0.009/0.01/0.02/265000 balances, shortcut and converged federal funding are tested afterward. |
| Typical Cash Flow reports a misleading retirement-handoff failure | Fixed locally, subject to final verification | Controller regression fails before change and passes afterward. Preserve projection code/age and distinguish unavailable Baseline from selected scenario. Generic Typical preparation errors no longer claim a handoff failure. |
| Cash Flow claims tax estimates despite no available path | Fixed locally, subject to final verification | Suppress fallback disclosure only when the selected path is unavailable; normal fallback remains unchanged. Browser contract checks actual DOM, exact ordered headers, error code/age/action, and absent summary/fallback claims. |
| Attribute failure to recent PRs | Diagnosed for synthetic defect | Same sub-cent defect reproduced on 85e4986 (before #246), c298118 (#246), and this base. Exact trigger in the owner's run remains unverified. |
| General $20 account closeout rule | Separately scoped | Not implemented; no rounding, discarded funds, or new account closeout policy. |

## Root cause and implementation

The death-boundary helper marked a decedent handled and skipped the rollover
when pre-tax balance was at most one cent. The per-account ledger retained that
owner and balance. A 0.009 remainder growing 20% became 0.0108, triggering the
lifecycle guard the following year. A single unavailable Monte Carlo trial
withholds the whole scenario result.

Remove only the balance-based early exit. Existing living-survivor, attributable
account, and supported-rule checks still gate the transfer. Full balances and
account identities transfer; saved household ownership remains unchanged.
Do not suppress the lifecycle/RMD guard or manufacture a probability.

Cash Flow returns known unavailable projection reasons before attempting path
selection, and uses a Typical-specific fallback for preparation exceptions.
Historical handoff behavior otherwise remains unchanged. No new controls,
styles, tables, or summary metrics; headers remain Year, Age, Income, RMD,
Essential, Goals, Tax, Draw, Return, WD Rate, Ending.

## Verification receipt

Before production edits:
`node --test --test-name-pattern 'spousal rollover transfers|Cash Flow preserves unavailable|Typical Cash Flow fails closed' engine.test.js src/scenarios/createCashFlowController.test.js`
failed 4/4 for the expected lifecycle and misleading-message reasons.

After production edits: focused engine/controller/account-ledger suite passed
164 tests; `npm test` passed 884 main tests plus 24 tax pretests;
`npm run governance:check` passed 63 tests and repository validation.
Final immutable-candidate `npm run verify`, review, and commit identity are
reported in the task completion receipt, not presumed here.

The browser failure fixture is synthetic and exercises the shipped controller
and renderer, not the owner's visible-input/saved-state journey. Existing full
browser flows supply compatibility evidence, not proof that the owner's exact
household is repaired. No persisted schema or saved user data changes.

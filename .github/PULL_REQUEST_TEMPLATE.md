## Scope and risk

- Change type: <!-- Defect / Feature / Test / Documentation / Governance -->
- Risk tier: <!-- Tier 1 - Fast / Tier 2 - Standard / Tier 3 - Protected -->
- Base commit SHA:
- Branch commit SHA:
- Original request:
- Outcome:
- Included:
- Non-goals:
- Authority and protected boundaries:

## Acceptance ledger

<!-- Keep every original request and reported symptom visible until it is fixed,
delivered, deferred, or separately scoped. Do not silently replace the task. -->

| Original request or reported symptom | Disposition | Base or starting-state proof | Production change | Regression assertion | Candidate proof |
|---|---|---|---|---|---|
| | | | | | |

## Defect evidence

<!-- For a defect, provide all four labeled items below. For other work write
"Not a defect —" and identify the starting-state evidence in the ledger. -->

- Exact reproduction:
- Root cause:
- Fail-before:
- Pass-after:

## Changes and tests

- Production files:
- Tests and fixtures:

## Visible UI contract

<!-- If Yes, name the complete allowed result—not only requested elements that
must be present. Assert unrequested rows/controls are absent and compare the
rendered result with canonical typography/layout at governed viewports. -->

- Visible UI changed: <!-- Yes / No -->
- Reason: <!-- Required when No -->
- Exact visible inventory:
- Explicitly absent or unchanged:
- Canonical visual reference and viewports:
- Rendered or browser proof:

## Protected-contract evidence

<!-- Tier 3: record the applicable financial, tax, persistence, migration,
security, deployment, governance, or cross-authority invariants. Lower tiers
may write "Not applicable —" with the reason. -->

## Verification

```text
npm run governance:check  # actual result
npm run lint:changed      # actual result
npm test                  # actual result, or not run locally with Tier 1 reason
npm run verify            # actual result, or not run locally with Tier 1 reason
git diff --check          # actual result
```

## Delivery status

- [ ] Governance safeguards
- [ ] ESLint
- [ ] Unit tests
- [ ] Build deployable site artifact
- [ ] Full browser verification
- Known failures and proof gaps:
- Review method:
- Reviewer/result link:
- Review status:
- Lifecycle: <!-- Draft-ready / Merge-ready -->
- Hold: <!-- CI / Review / Owner decision / another exact hold -->

## Rollback considerations

<!-- State rollback steps, saved-data risk, and reversibility. -->

## Truthful completion gate

- [ ] Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped.
- [ ] The visible UI contract names the exact allowed result and explicitly absent or unchanged behavior.
- [ ] The evidence and status describe the current base and candidate, with no stale completion claim.

Draft-ready may truthfully retain pending CI or review. Merge-ready may not.

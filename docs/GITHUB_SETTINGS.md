# Required GitHub and Codex settings

These settings cannot be enforced by repository files alone. A repository
administrator must configure and verify them on GitHub.
This document does not claim they are currently active.

## Branch protection or ruleset for `main`

Configure a branch protection rule or repository ruleset targeting `main`:

1. Require a pull request before merging.
2. Require these exact status-check names:
   - `Governance safeguards`
   - `Unit tests`
   - `Full browser verification`
3. Require branches to be current before merge when GitHub offers the option
   for the selected required checks.
4. Disable bypassing required pull requests and status checks for ordinary
   merges. Limit emergency bypass to explicitly authorized administrators and
   retain GitHub's audit trail.
5. Do not treat a GitHub Pages, Vercel, or other deployment check as a substitute
   for any required check above.

After the governance workflow first runs, select the check contexts produced by
the `Parallax quality` workflow rather than creating similarly named external
statuses.

## Codex code review

1. Install and authorize the Codex GitHub integration for this repository.
2. Enable Codex Code Review or Automatic reviews for pull requests.
3. Keep the concise Parallax-specific review rules in root `AGENTS.md`; keep
   deterministic mechanical enforcement in CI.
4. Until automatic reviews are observed on a test PR, comment `@codex review`
   on every PR and confirm a separate review result appears.
5. The authoring session must not count its own review as independent.

## Manual verification record

An administrator should record the date, actor, ruleset URL or identifier,
required-check contexts, bypass policy, and one PR demonstrating that a red
required check blocks merge. Record separately whether automatic Codex reviews
were observed or whether `@codex review` remains required.

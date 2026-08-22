# Claude Code UI replacement workflow

This workflow makes Claude the visual author for a total Parallax presentation
replacement without giving it direct write access to the application's mechanics.
Codex remains the trusted integrator and verifier.

The acceptance target is one new presentation system in place of the old one: old
tokens, component styling, layout rules, wrappers, and obsolete selectors are removed,
not hidden under a later theme. Inputs, saved values, controller events, state,
persistence, engine and tax requests, calculations, unavailable and error reasons, and
visible planning outputs remain the same.

## What enforces the boundary

`CLAUDE.md` supplies the working contract but is not a security boundary. The project
also uses:

- exact existing-file Edit permissions in `.claude/settings.json`;
- the independently readable allowlist in `.claude/ui-scope.json`;
- a protected pre-tool hook that rejects out-of-manifest edits, new files, and every
  shell command except exact read-only Git inspection;
- CI coverage for the guard itself through `npm run governance:check`; and
- a clean isolated task checkout based on a recorded GitHub `main` SHA.

Claude can read the repository to understand contracts. Its direct write envelope is
only the exact existing CSS files in the manifest. Every HTML and JavaScript file is
deliberately locked, including files that currently appear presentation-only. Those
files can acquire imports or side effects and may mix presentation with navigation
hooks, controllers, state, persistence, financial-display rules, or product semantics.
A directory-wide `ui/**` permission would therefore recreate the broad-access problem
this workflow is meant to prevent.

## The two-key replacement

Claude still owns the design. For markup needed inside a locked file, Claude returns a
PRESENTATION INTEGRATION REQUEST with the exact target function or DOM fragment,
desired markup and classes, hooks that must survive, states and viewports, and visual
acceptance evidence.

Codex then:

1. rejects any request that changes data, math, state, persistence, controller
   semantics, limits, fallbacks, or engine and tax contracts;
2. applies accepted markup and class changes mechanically;
3. removes the superseded presentation instead of layering around it;
4. does not restyle, reinterpret, simplify, or improve Claude's frozen visual design;
   and
5. runs the repository code and verification only after inspecting the complete diff.

If the current architecture needs a new pure-renderer seam, Codex creates, owns, and
reviews that seam as a separate prerequisite. Renderer, HTML, and JavaScript files
remain permanently outside Claude's direct-write manifest. Claude never widens its own
settings.

## Local checkout versus GitHub

GitHub is the source of truth, but Claude edits a checkout. Running "from GitHub" does
not itself protect calculations or prevent a broad write. The useful GitHub step is to
start from the exact current remote SHA in a clean branch and isolated checkout so a
rejected redesign never contaminates `main` or another dirty worktree.

Native Windows does not currently provide Claude Code's OS-level Bash filesystem
sandbox. This project therefore allows Claude no command that executes repository code:
no Node, npm, tests, preview server, verifier, install, build, or arbitrary shell. The
few allowlisted Git commands are read-only and the hook requires an exact match. Codex
runs all executable checks after the diff review.

For the strongest subprocess boundary, use an updated Claude Code inside WSL2, a
disposable Linux VM, or an outer network-denied container. Enable Claude's sandbox with
`failIfUnavailable: true`, `allowUnsandboxedCommands: false`, no excluded commands, and
deny writes to every protected path. A deny-all sandbox network also requires
`strictAllowlist: true` from managed settings or a CLI `--settings` overlay; project
settings alone cannot activate that strict key. Claude Code 2.1.219 or newer is required
for that documented strict-network setting. Do not weaken the sandbox merely to make it
start in an unsupported container.

A Codespace can supply a disposable Linux clone, but it is not automatically safer:
keep GitHub credentials unable to publish, retain the project permissions and hook, and
verify the sandbox actually starts. Prefer a normal clone there over a linked worktree
whose shared Git directory sits elsewhere.

## 1. Trusted preparation

Run outside the Claude implementation session:

1. Ensure this guardrail package is already present in the exact branch Claude will
   use.
2. Fetch and record current `origin/main`.
3. Create one clean task branch and isolated worktree from that exact SHA.
4. Confirm the new worktree is clean before adding the frozen reference artifact.
5. Record hashes for `engine.js`, `src/state.js`, `src/tax`, `src/planning`,
   `src/household`, `src/scenarios`, mixed UI modules, tests, scripts, packages, and
   governance.
6. Freeze the supplied design package and record its exact names and hashes.
7. Review both Claude allowlists. Keep `creatableFiles` empty. Only a trusted
   prerequisite may add an exact existing CSS file; renderer, HTML, and JavaScript
   files remain Codex-owned.

Example after the guardrails are on current `origin/main`:

```powershell
git fetch origin main
git worktree add -b claude-ui/parallax-redesign C:\\Dev\\Parallax\\.worktrees\\claude-ui-redesign origin/main
```

Do not reset, clean, stash, or fast-forward a dirty checkout to manufacture this state.

## 2. Launch with only project settings

On this Windows installation, call the `.cmd` launcher because the PowerShell wrapper
is blocked by machine execution policy:

```powershell
Set-Location C:\\Dev\\Parallax\\.worktrees\\claude-ui-redesign
& "$env:APPDATA\\npm\\claude.cmd" --setting-sources project --permission-mode dontAsk
```

If frozen design references live outside the worktree, attach the exact files in the
client. Otherwise, have the trusted integrator copy the enumerated references into a
protected, read-only location before the session and record their hashes. Do not use a
generic `--add-dir`: an unenumerated directory can carry additional Claude instructions,
settings, or plugins into the session.

`--setting-sources project` excludes user and `.claude/settings.local.json`
permissions for this launch; managed policy still applies. Do not use bypass,
auto-permission, bare, or unsafe modes. At startup use `/status` and confirm the exact
task worktree, project settings source, and root `CLAUDE.md`. Stop if any is missing.

## 3. Checkpoint loop

Claude begins read-only, traces the affected contracts, and declares its direct files
and anticipated PRESENTATION INTEGRATION REQUESTS. It works one surface or component
family at a time and stops at a VERIFICATION CHECKPOINT with:

- exact changed files and diff summary;
- superseded presentation removed in that scope;
- every locked-file integration request;
- known reference mismatches and unimplemented states;
- safe read-only Git inspection results; and
- protected paths confirmed untouched.

Claude does not run tests or preview mutable files. Codex then reviews the diff before
execution, applies accepted integration requests, and runs:

```text
npm run governance:check
npm test
git diff --check
```

The full browser verifier intentionally serves an immutable clean commit. After review,
the user may separately authorize a local checkpoint commit; Codex can then run
`npm run verify`, compare deterministic screenshots, and exercise the actual visible
input, saved-state, and dependent-output paths. Claude can review those returned
artifacts and refine its direct presentation scope.

## 4. Final trusted review

Before any publication decision, Codex must verify:

1. every Claude-written path matches the exact manifest;
2. all recorded protected hashes and behavior contracts remain unchanged;
3. mixed-file integrations are presentation-only and faithful to Claude's requests;
4. old tokens, selectors, markup, wrappers, and themes were removed rather than hidden;
5. no duplicate page, renderer, theme, fallback, entrypoint, or compatibility layer was
   introduced;
6. governance, unit, browser, observable-state, and diff checks pass on the exact clean
   candidate; and
7. the independent review required by `docs/CODE_REVIEW.md` is complete.

Only then may the user separately decide whether to stage, commit, push, open a pull
request, or merge. Rejecting the redesign leaves `main` untouched.

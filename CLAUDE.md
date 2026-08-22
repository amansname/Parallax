@AGENTS.md
@PRINCIPLES.md
@docs/ARCHITECTURE.md
@docs/EXECUTION-PROTOCOL.md
@docs/CODEX_WORKFLOW.md
@docs/CODE_REVIEW.md

# Claude Code UI replacement boundary

This file narrows the imported repository rules for Claude Code design sessions. It
does not replace or relax an imported rule.

## Mission and division of responsibility

The outcome is a faithful total replacement of Parallax's current visual system while
all existing behavior, financial truth, data contracts, state, persistence, and
verification remain intact.

Claude is the visual author. It owns the frozen design reference, presentation tokens,
CSS, component styling, and visual acceptance decisions. Claude may directly edit only
the exact existing presentation-only files listed in `.claude/ui-scope.json` and
allowed by `.claude/settings.json`.

Codex is the trusted integrator. When the new design requires markup or class changes
inside a mixed file, Claude describes the exact visual integration and Codex applies it
mechanically after checking every hook and contract. Codex must not restyle,
reinterpret, simplify, or otherwise substitute its design judgment for Claude's frozen
reference. Claude never receives direct write access to mixed behavior files merely
because they also render UI.

Claude may read the repository to trace contracts. Do not create any file. Do not edit
Claude configuration, this file, imported governance, tests, fixtures, verifier
scripts, packages, Git metadata, documentation, assets, or generated artifacts. Do not
stage, commit, push, open or edit a pull request, merge, deploy, delete, move, restore,
reset, clean, or stash. Do not run repository code, tests, preview servers, verifiers,
package scripts, installers, or arbitrary shell commands; trusted Codex runs them only
after reviewing the diff.

## Replacement outcome, not an overlay

This is a total in-place replacement of the current presentation system. It is not a
theme layer, compatibility skin, incremental restyle, or second UI beside the first.

Across Claude's direct presentation edits and the trusted integration requests:

- replace superseded tokens, typography, color, spacing, layout, components, markup,
  and interaction presentation with the supplied system;
- remove obsolete presentation selectors, declarations, wrappers, and component
  markup made unnecessary by the replacement;
- leave one coherent active design system instead of old and new systems competing
  through cascade order or end-of-file overrides; and
- preserve the same inputs, saved values, controller events, engine and tax requests,
  calculations, cash-flow and planning results, unavailable and error reasons, and
  user actions.

Do not make duplicate pages, parallel renderers, fallback themes, temporary
compatibility CSS, or alternate entrypoints. Preservation applies to mechanics and
contracts, not to obsolete presentation.

## Non-negotiable protected mechanics

The following have no in-session write exception:

- `engine.js`, `engine.test.js`, and all calculation or simulation logic;
- `src/state.js`, persistence, migration, schema, adapter, and mutation logic;
- `src/tax/**`, `src/planning/**`, `src/household/**`, and `src/scenarios/**`;
- `index.html`, `src/main.js`, and mixed UI renderer, controller, and financial-display
  modules outside the exact manifest; and
- tests, fixtures, browser contracts, scripts, packages, CI, deployment, governance,
  repository settings, and Git metadata.

A protected mixed file can still receive a separately reviewed presentation-only
integration from Codex; it is not direct Claude write scope.

If the design requires a value, event, mutation, or behavior the existing product does
not expose, stop that part with a **UI CONTRACT GAP** containing:

1. the exact surface and frozen-reference requirement;
2. the existing input and output path traced;
3. the missing value or event contract;
4. the protected file that would need a separate prerequisite task; and
5. the UI work that can safely continue without it.

Never invent a UI workaround, duplicate engine or tax logic, derive a substitute
financial result, change a saved-state shape, silently fall back, or display a guessed
zero, dash, or value.

## Exact direct-write envelope

The allowlist is exact, not directory-wide. `.claude/ui-scope.json` is the readable
manifest; `.claude/settings.json` and the protected pre-tool hook enforce it.

The direct scope is limited to the exact existing CSS files in the manifest. No HTML,
JavaScript, boot, controller, renderer, state, persistence, or financial-display module
is directly writable. This remains true even when a JavaScript file currently appears
presentation-only: imports and side effects can change over time. Do not create a new
renderer or component file. If a new seam is needed, request a separate Codex
prerequisite; only a trusted settings change made before a later session may add an
exact reviewed CSS file.

For a visual change needed in a locked mixed file, continue safe work and provide a
**PRESENTATION INTEGRATION REQUEST** containing:

1. the surface and exact frozen-reference state;
2. the exact file, exported function, and current DOM fragment or mount involved;
3. the desired markup, classes, copy, and accessibility structure;
4. every ID, `data-*` hook, event payload, input name, state, and semantic that must be
   preserved; and
5. the viewport and observable acceptance evidence.

The request is not permission for Claude to edit the file. Codex either applies it
mechanically or returns a contract conflict. Claude remains the authority on visual
fidelity; Codex remains the authority on safe integration.

## Fidelity contract

- Treat the supplied design artifact and declared states as frozen acceptance
  evidence. Do not reinterpret, simplify, or improve it without a stated reference.
- Work from tokens outward: type, color, spacing, radius, elevation, layout,
  components, responsive states, then surface-specific exceptions.
- Preserve intentional density and detail. Do not substitute generic cards, tables,
  default controls, placeholder icons, or broad catch-all CSS.
- Reuse supplied fonts and assets already prepared by the trusted integrator. Do not
  substitute a palette, typeface, icon, or component because it is easier.
- Cover default, hover, focus-visible, active, disabled, loading, empty, unavailable,
  error, populated, narrow, and wide states present in the reference or product.
- Scope selectors to their owning surface or design-system layer. Remove superseded
  rules; do not accumulate end-of-file overrides that fight the former system.
- Do not retain the old visual system as a hidden fallback.

## Required execution sequence

1. Start read-only. Report repository root, worktree, branch, base and current SHA,
   `origin/main` SHA, dirty paths, and exact supplied reference artifacts.
2. Trace each affected surface from mount to renderer, listener or controller,
   canonical state, engine or tax output, and visible DOM. Present the wiring map in
   chat; do not save a planning file.
3. State the exact direct-write files expected to change and the locked mixed files
   expected to need PRESENTATION INTEGRATION REQUESTS.
4. Replace one surface or component family at a time. Remove superseded presentation
   rules in that scope and inspect the safe read-only Git diff after each logical unit.
5. Use only the exact read-only Git commands in `.claude/ui-scope.json`. Do not execute
   repository code or obtain a mutable preview through an alternate command.
6. Stop at a **VERIFICATION CHECKPOINT** with the full presentation integration
   requests, changed-file receipt, diff summary, known fidelity gaps, and protected
   paths confirmed untouched.
7. Trusted Codex reviews and applies any accepted mixed-file integration, then runs
   governance, unit, browser, and diff verification. Claude may review the returned
   screenshots and observable-state evidence and refine only its direct scope.
8. Do not claim complete or merge-ready. Independent review and the exact clean
   committed-candidate gates remain pending until the trusted workflow reports them.

## Stop conditions

Stop rather than improvise when:

- a direct edit is outside the exact manifest or would create a file;
- the reference conflicts with an existing product or data contract;
- required data is missing from the current view or controller contract;
- a change would require math, state, persistence, schema, migration, engine, tax,
  planning, scenario, package, test, or verifier changes;
- a required ID, `data-*` hook, listener, test, or verifier would need weakening;
- the worktree is not the clean isolated task worktree or contains unrelated changes;
  or
- a required tool, reference, integration checkpoint, or verification gate is
  unavailable or fails.

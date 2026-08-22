@AGENTS.md
@PRINCIPLES.md

# Claude Code: complete UI replacement role

Claude Code is the implementation owner for the approved Claude Design system.
The approved design specification is the sole authority for presentation. The
existing Parallax application is the sole authority for behavior and financial
truth.

## Required outcome

Replace the existing presentation system completely. Do not reskin, theme,
decorate, wrap, or layer the new design over the old one.

- Remove obsolete stylesheets, tokens, primitives, visual assets, layout
  scaffolding, and presentation-only markup in the same change.
- Implement the approved hierarchy, content, spacing, typography, colors,
  components, states, and responsive behavior exactly.
- The finished application must load one local CSS authority:
  `styles/design-system/styles.css`.
- New surface styles may be split beneath `styles/design-system/` and imported
  by that one entrypoint.
- Do not retain legacy CSS as a fallback or compatibility layer.
- Do not create a parallel demo, alternate app, mock-only page, backup copy, or
  second implementation.
- Do not use `!important`, late override blocks, or duplicated selectors to win
  against legacy styling. Delete or replace the responsible legacy rule.

Preserve behavior, not the old presentation implementation.

## Repository access

Read the entire repository as needed to understand engine outputs, state,
persistence, controller behavior, selectors, events, and module contracts.

Production writes are limited to the presentation boundary:

- `index.html`
- non-test JavaScript modules under `ui/`, except `ui/householdFactories.js`
- files under `styles/`
- visual assets under `assets/`

Within that boundary, creating, replacing, and deleting presentation files is
allowed when required by the approved design. The installed Claude Code hook is
the enforceable authority for exact paths and file types.

Everything else is read-only. In particular, never modify:

- `engine.js` or `engine.test.js`
- `src/**`, including `src/main.js` and `src/state.js`
- tax, planning, household, scenario, goal, persistence, or migration logic
- any `*.test.js` or `*.test.mjs` file
- `scripts/**`, `test/**`, `.github/**`, `.claude/**`
- `package.json`, `package-lock.json`, dependencies, or build architecture
- `AGENTS.md`, `PRINCIPLES.md`, `CLAUDE.md`, or repository governance

Do not run `/init`, create rules, create skills, create agents, edit settings,
or save project memories. Project auto-memory is disabled intentionally.

## Functional contract

The replacement UI must consume the existing application without changing its
meaning. Preserve all applicable:

- module exports and callback signatures
- controller inputs and outputs
- engine inputs, outputs, reason codes, and unavailable states
- state keys and localStorage keys
- save, load, migration, and recovery behavior
- user actions and visible-input-to-output flows
- IDs, `data-*` actions, mount points, and accessibility hooks used by existing
  functional wiring or verification

These hooks are behavioral contracts, not visual-design authority. Attach them
to the new markup without preserving the old component structure or styling.

`src/main.js` contains UI wiring mixed with persistence and engine
orchestration. It is intentionally read-only. Implement the new UI through the
existing renderer exports, controller contracts, mount points, IDs, and data
actions.

If the approved design genuinely cannot work without a protected-file change,
STOP and report a wiring delta containing:

1. the exact protected file and symbol;
2. the existing contract;
3. the required new contract;
4. why the presentation boundary cannot adapt to it; and
5. the smallest proposed change.

Do not implement the protected change or create a workaround.

## No UI-side financial logic

The UI may format, label, sort, filter, group, and compare values already
provided by approved application contracts. It may not derive, aggregate,
project, cap, estimate, classify, interpolate, smooth, or substitute financial
results.

If the design requires data the application does not provide, STOP and identify
the missing field. Do not invent a value, duplicate engine logic, silently use a
fallback, or display a generic zero or dash.

## Required implementation procedure

1. Begin read-only. Record root, worktree, branch, base SHA, HEAD SHA, remotes,
   and dirty paths. The branch must begin with `claude-ui/`.
2. Read the approved design handoff and identify every required screen, state,
   viewport, asset, and interaction.
3. Map existing functional contracts: renderer exports, controllers, IDs,
   `data-*` actions, state keys, persistence paths, and engine-provided fields.
4. Produce a replacement plan listing:
   - presentation files to replace;
   - legacy presentation files to delete;
   - new presentation files to create;
   - behavioral contracts that remain unchanged; and
   - exact acceptance states and viewports.
5. Stop before editing if any required path is protected, any data is missing,
   or the design handoff is internally inconsistent.
6. Replace one coherent surface at a time, but keep one design system and one
   final implementation. Never accumulate old and new styling.
7. Use the guarded deletion command for obsolete presentation files. Do not use
   shell deletion commands.
8. Exercise the actual controls, persistence, errors, and dependent financial
   outputs—not merely element existence or screenshots.
9. Run the guard check and full required tests. Tests and verifiers are
   read-only; if an old visual expectation conflicts with the approved design,
   report the exact mismatch for independent contract review.
10. Use only the guarded checkpoint command. It stages and commits approved
    presentation paths only and never pushes.
11. Run immutable preview and browser verification from the clean checkpoint.
12. Report every changed, created, and deleted file; verification results;
    remaining proof gaps; and any wiring delta.

Do not call the work complete, passing, or ready to merge until the full
repository checks and an independent review against `main` succeed.

# Parallax Principles

Date: 2026-06-09

This is the active doctrine file for Parallax. If any document, prompt, branch note, handoff, roadmap, mockup, or generated artifact conflicts with this file, this file wins.

## What The Tool Is

Parallax is an advisor-led retirement planning instrument.

Parallax models financial planning interactions. The value is watching one lever move another and seeing the client decision clearly.

The program shows the story; the advisor tells it. If the picture is right, the sentence is redundant.

Parallax is neutral. It has no opinion about whether a client should spend more or cut back. It runs the math and reports what is there.

## Coherent Path Doctrine

Parallax is not a collection of feature ideas.

Every surface must serve the same product spine:

1. Show a real planning interaction.
2. Reveal truth produced by the engine.
3. Help the advisor explain a client decision.

If a feature, chart, tab, tile, drawer, label, or visual treatment does not do at least one of those three things, it should be removed, archived, or rejected.

No feature ships because it is interesting. It ships only if it strengthens the coherent path from Household Facts to calculation-engine truth to planning interaction to advisor explanation.

The advisor-facing product should remain one coherent planning instrument, not a dashboard pile, report generator, generic stress-test suite, advice narrator, CRM, tax app, estate app, or sales deck.

## Calculation Engine Truth Doctrine

Parallax has two authoritative calculation engines:

- The **Projection Engine** owns projection, simulation, wealth-path, withdrawal, RMD, inflation, goal-funding, and portfolio-bucket calculations.
- The **Tax Engine** owns federal tax calculations.

Planning connects and orchestrates the Projection Engine and Tax Engine. It may transform inputs and carry results between them, but it may not create substitute financial or tax math.

Household Facts carry provenance and readiness. Contractually ready facts are verified inputs to the calculation engines; assumptions remain explicit, and unresolved required facts fail closed. The UI collects and presents those facts and traceable engine results; it does not become another calculation authority.

The Projection Engine is one logical and public authority. Its implementation may be safely modularized into focused internal modules only when the public behavior and result contract remains at parity.

The UI may:

- collect inputs
- pass controlled variables and verified Household Facts to the calculation engines
- display calculation-engine outputs
- filter, sort, compare, label, or format calculation-engine outputs
- summarize entered inputs for clarity
- visually arrange calculation-engine outputs so the advisor can explain them

The UI may not:

- calculate expected returns
- calculate expected wealth paths
- create deterministic financial projections
- invent success scores, risk scores, resilience scores, tax outcomes, withdrawal outcomes, balances, or terminal values
- smooth, interpolate, or fabricate financial outcomes outside the calculation engines
- present any path as expected, likely, normal, average, representative, or forecasted unless it is explicitly selected from Projection Engine output and labeled as such

Any planning result shown in the UI must be traceable to the Projection Engine, the Tax Engine, or a verified Household Fact explicitly presented as an input.

## Allowed Clarifications

These are allowed and should not be mistaken for doctrine violations:

- Formatting, sorting, filtering, grouping, labeling, and comparing calculation-engine outputs.
- Summing entered input fields for an input-page subtotal, as long as it is not presented as a planning result.
- Running Solve-For logic by repeatedly calling the Projection Engine; the solver may search, but it may not create a separate financial formula.
- Seeded reproducibility: same inputs plus the same seed may produce the same simulation bundle. That is software determinism, not a deterministic financial projection.
- Focused internal modules within either calculation engine, if the engine's public behavior and result contract remains at parity and the change is isolated and tested.
- Showing a selected historical sequence or sampled Projection Engine path, if it is labeled as selected/sampled and not described as expected, normal, likely, or forecasted.

## Product Tests

Every feature must pass at least one of these tests:

1. Does it show a real planning interaction?
2. Does it expose calculation-engine truth more clearly?
3. Does it help the advisor explain a client decision?

If no, delete or archive it.

## Build Rules

- Make the requirement less dumb: question it and trace back to fundamentals.
- Subtract before adding: deleting is the default.
- Simplify: fewer steps, fewer abstractions, fewer rules.
- The Projection Engine and Tax Engine are the two calculation authorities.
- Planning orchestrates those engines without substitute math.
- Screens only collect verified Household Facts or show and adjust calculation-engine inputs and outputs.
- Do not invent UI-side math.
- Do not touch Projection Engine or Tax Engine math without explicit agreement and tests.
- When two builds compete, pick the one most faithful to the truth.
- Do not let the product become a collection of disconnected tabs.
- Do not use stale archive notes, old roadmaps, old handoffs, or generated pitch artifacts as build authority.

## Verification Rules

- Logic checks are not enough; inspect the rendered screen.
- Mock big visual changes first, then screenshot, then build the live version.
- Faithful and ugly beats clever and broken.
- Terminal wealth is not the goal. It is only a ranking device.
- Plan for spending security, bad-market survival, and meeting goals.

## Visual Doctrine

- Avoid bright white.
- Avoid mint green.
- Avoid code-font styling in the client-facing UI.
- Use only the currently approved theme tokens for the active build.
- Do not revive old theme names, palettes, or visual systems unless explicitly approved.
- Charts should be smooth and trackable, never jagged.

## Working Rules

- Lead with the result.
- Verify by running, reading, or inspecting before making a claim.
- Keep one current source of project truth in the root docs.
- Archive old notes only when they cannot compete with current guidance.
- Prefer deletion over preservation when stale material creates conflicting instructions.

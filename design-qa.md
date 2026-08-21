# Scenarios Visual Consistency QA

## Comparison target

- Source visual truth:
  - `verify-out/qa-reference-scenarios-compare.png`
  - `verify-out/qa-reference-scenarios-focus.png`
  - `verify-out/qa-reference-cashflow.png`
- Rendered implementation:
  - `verify-out/qa-implementation-scenarios-compare.png`
  - `verify-out/qa-implementation-scenarios-focus.png`
  - `verify-out/qa-implementation-cashflow.png`
- Viewport: 1535 x 896 CSS pixels, device scale factor 1.
- States: Scenarios Compare, Scenarios Focus with Baseline selected, and Scenarios Cash Flow with Baseline and Typical path selected.

## Full-view comparison evidence

- Compare uses the reference's centered 1320px planning stage, wide label gutter, three equal scenario columns, restrained near-black panel, warm hairlines, and flat delta treatment.
- Focus reproduces the reference's approximately 930px primary panel plus 360px scenario rail, including the subdued selected-card gold fade and distinct green, gold, and rust semantic accents.
- Cash Flow uses the reference's open ledger treatment: no enclosing glass card, quiet horizontal rules, serif financial figures, compact summary statistics, and restrained path controls.
- The mock-only supplemental header-state strip was intentionally excluded. Production header structure, live values, controls, disclosures, and tax columns remain authoritative.

## Focused region comparison evidence

- Success rings: reviewed at hero, comparison-column, rail-card, and Cash Flow summary sizes. Stroke weights were reduced to match the reference's quieter rings without changing the underlying values.
- Focus rail: reviewed selected and unselected cards, border opacity, panel fill, text hierarchy, and stress-result colors. The selected card retains a subtle warm fade rather than a bright gold fill.
- Cash Flow ledger: reviewed header spacing, row rhythm, column alignment, number typography, positive/negative returns, goal gold, and the retirement/RMD markers.

## Findings

- No actionable P0, P1, or P2 visual mismatches remain.
- Production-only content creates expected differences from the mock: current scenario results, the Federal Total / Engine Path comparison, editable controls, and the Probability of Success label remain because the implementation brief explicitly preserves live behavior and copy.
- No raster imagery is part of these three Scenarios views. The existing Parallax brand asset remains unchanged in the production header.

## Required fidelity surfaces

- Fonts and typography: Spectral remains the display and financial-number face; Hanken Grotesk remains the interface face. Weight, tracking, and hierarchy now follow the reference more closely.
- Spacing and layout rhythm: the 1320px stage and 930px/360px Focus split match the source proportions at the comparison viewport. No clipping or overlap was observed.
- Colors and visual tokens: near-black panels, champagne text, muted gold, sage success, and rust downside roles align with the source. Heavy bloom, fog, and elevation were removed.
- Image quality and asset fidelity: no new image assets were required; the production logo was preserved.
- Copy and content: production copy and engine-derived values were preserved intentionally.
- Accessibility and interaction states: focus rings remain present; buttons, tabs, toggles, steppers, scenario selection, Cash Flow paths, and persistence behavior passed the browser verification suite.

## Comparison history

1. Initial implementation comparison found a P2 mismatch: progress rings were visibly heavier than the reference.
2. Fix applied: Compare, Focus, rail, and Cash Flow ring strokes were reduced; the compact Compare and Cash Flow rings were also resized to the reference scale.
3. Post-fix evidence: the 1535 x 896 implementation captures listed above show the quieter ring hierarchy with unchanged values and interactions. No additional P0/P1/P2 issues were found.

## Verification

- `npm test`: 347 tests, 346 passed, 1 skipped, 0 failed.
- Full browser verification passed at both the standard 1920 x 1080 project viewport and the 1535 x 896 comparison viewport.
- Compare, Focus, Cash Flow, Sequencing, Household, Goals, persistence, and header contracts all passed.

Scenarios phase result: passed

---

# Goals Visual Consistency QA

## Comparison target

- Source visual truth: `C:\Users\amans\AppData\Local\Temp\codex-clipboard-645b0fa0-ca5d-48c7-96e6-7b0c6b49b966.png`, used for the shared typography, charcoal surface, champagne line, muted-gold state, and restrained glass language. The user explicitly directed pages without a dedicated screenshot to inherit these shared traits.
- Rendered implementation: `C:\Dev\Parallax\verify-out\02-goals.png`.
- Viewport: 1920 x 1080 CSS pixels at the project verification viewport.
- State: Goals ledger with one active recurring Travel & leisure goal spanning ages 66-81.

## Full-view comparison evidence

- The implementation uses the same centered 1320px content measure as Scenarios, with a restrained near-black surface and one subtle border instead of the previous bright, elevated glass card.
- The Spectral title and financial figures preserve the source's editorial hierarchy; Hanken Grotesk remains the interface face.
- The row, quick-add region, and chapter summary read as one continuous ledger separated by warm hairlines, matching the source's flat, quiet table treatment.
- The production header, live goal controls, copy, data, and interaction structure remain intentionally unchanged.

## Focused region comparison evidence

- Goal row: checked the amount field, steppers, cadence control, age chips, exact-age inputs, and delete affordance for alignment, borders, radii, and active-state color.
- Active controls: checked the directional muted-gold fade against the Scenarios Focus selected-card treatment; controls stay warm without becoming bright or opaque.
- Quick add and chapter footer: checked category-dot color, baseline alignment, number typography, hairline separation, and chapter-total grouping. The lifetime aggregate was removed at the user's direction.
- A separate crop was not required because the 1920 x 1080 browser capture keeps all ledger labels and controls legible at native scale.

## Findings

- No actionable P0, P1, or P2 visual mismatches remain.
- The Goals page has a production-enforced 16px minimum type size. This is intentionally larger than some supplemental labels in the source screenshot, but it preserves the application's readability contract without changing the shared visual language.
- No new imagery or icons were introduced. The existing Parallax brand asset and production header remain unchanged.

## Required fidelity surfaces

- Fonts and typography: Spectral is used for the page title and financial values; Hanken Grotesk is used for controls and labels. All Goals text meets the verified 16px minimum, with tracked uppercase labels and no truncation.
- Spacing and layout rhythm: the 1320px centered stage, 16px panel radius, compact control spacing, and horizontal ledger rules align with the Scenarios reference language. No clipping or overlap was observed.
- Colors and visual tokens: shared root tokens now drive champagne text, warm hairlines, near-black glass, muted gold, and category accents. The previous brighter gradient and deep shadow were replaced.
- Image quality and asset fidelity: the Goals view contains no content imagery; the production logo asset was preserved.
- Copy and content: production goal names, chapter labels, helper copy, and chapter totals were preserved; the lifetime aggregate was intentionally removed.
- Accessibility and interaction states: visible focus treatment remains; add, quick-add, type-through, steppers, cadence, chapter chips, exact-age inputs, delete, persistence, and cross-page scenario updates passed browser verification.

## Comparison history

1. The first compact styling pass created a P2 readability/contract mismatch by reducing supplemental Goals labels below the production 16px floor.
2. Fix applied: all active ledger text was restored to 16px or larger while retaining the new spacing, serif number treatment, subtle borders, and muted selected-state gradients.
3. Post-fix evidence: `C:\Dev\Parallax\verify-out\02-goals.png` shows the corrected hierarchy with no clipping, and the complete browser suite passed the Goals type-floor and interaction contracts.

## Verification

- `npm test`: 347 tests, 346 passed, 1 skipped, 0 failed.
- `node scripts/verify.mjs`: passed all browser checks, including Goals rendering, interactions, type floor, cross-page updates, persistence, shared background, and header contracts.
- Console: no browser-console failure was reported by the verification run.

Goals phase result: passed

---

# Household Visual Consistency QA

## Comparison target

- Source visual truth: `C:\Dev\Parallax\verify-out\qa-reference-household-people.png`.
- Browser-rendered implementation: `C:\Dev\Parallax\verify-out\qa-implementation-household-people.png`.
- Additional rendered states:
  - `C:\Dev\Parallax\verify-out\01-household.png`
  - `C:\Dev\Parallax\verify-out\01b-household-accounts.png`
  - `C:\Dev\Parallax\verify-out\01b-household-tax-details.png`
  - `C:\Dev\Parallax\verify-out\01c-household-income.png`
- Viewports: source 1535 x 932; in-app comparison capture 1493 x 906 after browser-chrome adjustment; project verification states 1920 x 1080.
- States: People & Timeline, Balance Sheet with add-account form and tax details, Cash Flow, and Blueprint.

## Full-view comparison evidence

- Household now uses the same centered 1320px stage and subdued near-black surface as the source instead of the prior narrow, isolated wizard card.
- The progress rail, two-column form rhythm, Spectral heading, muted gold current step, champagne rules, and outline Continue control follow the source hierarchy.
- The Blueprint screen now relies on the single outer Household surface; its competing nested glass sheet and ornamental corner marks were removed.
- Production-only identity controls, account entry, tax details, live values, and persistence affordances remain because the implementation brief keeps production behavior authoritative.

## Focused region comparison evidence

- Stepper: checked current, completed, and future states; connector weight; circle size; gold opacity; label spacing; and keyboard focus treatment.
- People & Timeline: checked paired client columns, role badges, label/value baselines, row rules, meta fields, and lower action alignment.
- Balance Sheet and Cash Flow: checked serif totals, account/income ledger rows, inline forms, section dividers, and muted-gold add actions.
- Blueprint: checked title hierarchy, household facts, financial figures, allocation colors, gauge placement, and removal of nested surface competition.
- No separate asset crop was needed because the only image asset is the unchanged production logo; the important fidelity work is visible in the full forms and focused control regions above.

## Findings

- No actionable P0, P1, or P2 visual mismatches remain.
- The implementation retains the production household identity row and overflow menu above the wizard. These do not appear in the source screenshot but are intentional production controls and were styled to remain quiet.
- The in-app comparison viewport is 42px narrower and 26px shorter than the source because of browser chrome. The centered 1320px content measure and internal geometry remain directly comparable; the 1920 x 1080 verification captures confirm no clipping at the project desktop viewport.
- No new image assets, replacement icons, or visual shortcuts were introduced.

## Required fidelity surfaces

- Fonts and typography: Spectral remains the display and financial-number face; Hanken Grotesk remains the UI face. Headings use lighter optical weight, tracked labels remain restrained, and verified editable values meet the application type floor.
- Spacing and layout rhythm: the stage widened from 1120px to 1320px, column gutters increased, title and step spacing were normalized, and the Blueprint nested card was flattened. Desktop verification shows no overlap or clipped persistent controls.
- Colors and visual tokens: Household now consumes the shared application champagne, muted gold, sage, ink, hairline, and charcoal roles. Pure-black/pure-white local glass values were replaced with the shared warm charcoal contract.
- Image quality and asset fidelity: the production Parallax logo remains unchanged and sharp; Household contains no additional content imagery.
- Copy and content: all production Household labels, values, account types, tax disclosures, and wizard copy remain intact.
- Accessibility and interaction states: semantic step tabs and controls remain keyboard reachable; focus is now a restrained gold outline. People edits, filing/state controls, co-client toggle, account add/remove, tax details, Cash Flow edits, step navigation, persistence, and downstream Scenarios updates passed.

## Comparison history

1. Initial comparison found a P2 visual mismatch: Household was substantially narrower than the source, used a heavier isolated card, retained a competing nested Blueprint sheet, and used filled gold footer CTAs.
2. Fix applied: the stage was widened to 1320px; Household colors were mapped to shared tokens; glass/shadows were softened; footer CTAs became outline controls; step states were muted; Blueprint's nested sheet and corner decoration were removed.
3. Post-fix evidence: the implementation captures listed above show the wider, quieter hierarchy across all four production states. The full browser suite passed without functional regressions or layout-contract failures.

## Verification

- `npm test`: 347 tests, 346 passed, 1 skipped, 0 failed.
- `node scripts/verify.mjs`: passed Household structure, all four wizard steps, type floor, inline edits, account creation, tax details, persistence, downstream Scenarios propagation, shared theme, and header contracts.
- In-app browser console: no errors or warnings.

Household phase result: passed

---

# Sequencing Visual Consistency QA

## Comparison target

- Source visual truth: `C:\Users\amans\AppData\Local\Temp\codex-clipboard-f32e4297-4dcf-44d1-af8f-d6bdd00e2787.png`.
- Browser-rendered implementation:
  - `C:\Dev\Parallax\verify-out\05-sequencing.png`
  - `C:\Dev\Parallax\verify-out\06-sequencing-full.png`
- Source viewport: 1535 x 916. Project verification viewport: 1920 x 1080; the focused Sequencing capture is the browser-rendered 1320 x 444 chart surface at device scale.
- State: all historical eras enabled on Resilience.

## Full-view comparison evidence

- Sequencing uses the source's centered 1320px stage, compact two-row era controls, one quiet Resilience surface, and five equal fingerprint cards at desktop width.
- The source's charcoal foundation, champagne typography, muted-gold selected chips, thin warm rules, sage/blue/gold/rust path accents, and restrained glass treatment carry through without changing production data.
- The production header, engine-derived paths, plan selector, and era controls remain authoritative.
- Playback is intentionally absent from the shipped Sequencing surface and recorded in `BACKLOG.md` for possible later reconsideration.

## Focused region comparison evidence

- Resilience chart: checked the 1320 x 444 proportion, 16px radius, title/subtitle hierarchy, plot padding, grid contrast, age labels, currency labels, line weights, endpoints, and surface depth against the supplied reference.
- Era controls: checked plan selector height, chip spacing, capsule borders, muted-gold fade, colored era dots, active checks, wrapping behavior, and helper-copy spacing.
- Fingerprint cards: checked the five-column desktop grid, title baseline, path swatches, row rules, serif financial values, drawdown indicators, and consistent card heights.

## Findings

- No actionable P0, P1, or P2 visual mismatches remain.
- The implementation chart contains the live production paths and therefore has different line geometry and starting values from the static mock. This is expected and was not restyled into fake data.
- The source screenshot shows only the upper portions of the fingerprint cards, while the production browser verification checks the complete chart and full Sequencing page. No clipping or overlap was observed.
- No new visual assets, icons, or functional controls were introduced. The deferred Playback mount and its controls are not present.

## Required fidelity surfaces

- Fonts and typography: Spectral drives the Resilience title and financial emphasis; Hanken Grotesk drives controls, labels, and helpers. Tracking and optical weight match the reference's editorial hierarchy.
- Spacing and layout rhythm: the chart is fixed to the source-like 444px desktop height inside a 1320px stage; controls wrap above it and five cards align below it. Responsive rules collapse the cards and restore automatic chart height on narrow screens.
- Colors and visual tokens: Sequencing consumes the shared champagne, muted gold, sage, blue, rust, hairline, and charcoal roles. Active chips use the same subtle directional gold fade as Scenarios Focus.
- Glass and line treatment: one low-contrast chart surface and quiet fingerprint cards replace the previous layered generic glass rules.
- Copy and content: production labels, era names, and generated metrics remain unchanged.
- Accessibility and interaction states: focus-visible treatment remains; plan selection, independent era toggles, and all browser contracts passed.

## Comparison history

1. Initial inspection found a P2 consistency issue: Sequencing presentation was split across multiple competing `main.css` passes, producing an oversized chart, heavier generic glass, and inconsistent card geometry.
2. Fix applied: the legacy Sequencing selector blocks were removed from `main.css`; `styles/sequencing.css` became the single presentation owner with the shared 1320px stage, source-like 444px chart, five-column card grid, and subtle selected-chip fades.
3. The first consolidated pass still rendered the chart taller than the source. Its desktop height was corrected to 444px, then the complete test and browser verification suite was rerun.
4. Playback was subsequently deferred at the user's direction. Its mount, renderer, CSS, and positive browser test were removed; the new browser contract fails if Playback reappears unintentionally.
5. Post-fix evidence: the source and final browser-rendered chart capture were reviewed together. The structural proportions, surface hierarchy, typography, line treatment, and color roles align without replacing live Sequencing data.

## Verification

- `node scripts/verify.mjs`: passed.
- Tests: 347 total, 346 passed, 1 skipped, 0 failed.
- Browser checks: Sequencing all-era state, explicit Playback absence, shared theme, header, Household, Goals, Scenarios, persistence, and cross-page behavior all passed.
- Console: no browser-console failure was reported by the verification run.

Sequencing phase result: passed

---

# Goals Horizon Design QA

## Comparison target

- Source visual truth:
  - `C:\Users\amans\.codex\visualizations\2026\07\12\019f5784-d13e-7cc2-8832-0ee5a1cec2a6\goals-horizon-reference.png`
  - `C:\Users\amans\.codex\visualizations\2026\07\12\019f5784-d13e-7cc2-8832-0ee5a1cec2a6\goals-horizon-source-editor-1280.png`
- Browser-rendered implementation:
  - `C:\Users\amans\.codex\visualizations\2026\07\12\019f5784-d13e-7cc2-8832-0ee5a1cec2a6\goals-horizon-implementation-1280-v2.png`
  - `C:\Users\amans\.codex\visualizations\2026\07\12\019f5784-d13e-7cc2-8832-0ee5a1cec2a6\goals-horizon-editor-1280.png`
  - `C:\Dev\Parallax\verify-out\02-goals.png`
- Viewports: 1280 x 720 in the in-app browser for direct source comparison; 1920 x 1080 in project verification.
- States: production demo Horizon, recurring Travel goal editor, add-goal starters, one-time and recurring cadence, drag, duplicate, delete/undo, blank household, saved household reload, and read-only storage.

## Full-view comparison evidence

- The production page matches the source's Spectral title, near-black charcoal field, one restrained glass timeline card, warm hairlines, 62-96 axis, champagne retirement marker, vertical guides, translucent goal bands, pill chips, in-card add action, and quiet instructional footer.
- The live application keeps its established 56px header and 32px centered content gutter. The prototype-only variant links were intentionally excluded as specified.
- Production demo content remains authoritative: one Travel & leisure goal at ages 66-81 replaces the prototype's three sample records. Blank households remain blank.
- The user-requested Lifetime goal spend is absent from every Goals Horizon state.

## Focused region comparison evidence

- Timeline and chips: the source and final implementation captures were reviewed together at native 1280 x 720 scale. Band opacity, 10px height, pill radius, type hierarchy, retirement guide, axis labels, and category color now align closely.
- Edit rail: source and implementation editor captures were reviewed together. The implementation preserves the 396px fixed rail, section order, amount controls, cadence segments, timing presets, age inputs, category icons, delete/duplicate actions, and gold Done control. The rail remains live and does not block timeline updates.
- Icons and assets: all eight category icons are the source SVG assets copied from the handoff, not re-created in CSS or inline markup. The production Parallax logo remains unchanged.
- No separate crop was needed because the 1280 x 720 base and editor captures keep the full title, timeline, chip assets, form labels, and controls legible at native scale.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- The implementation uses the production header height of 56px instead of the prototype rail's 64px offset. This is intentional because the user explicitly directed the current live header to remain authoritative.
- The source editor capture visually dims the panel as part of the handoff prototype's overlay behavior, while the specification says the rail must not block the timeline. The production rail follows the written interaction contract and stays readable without a blocking scrim.
- Responsive behavior is desktop-first like the source. At narrower widths, the timeline preserves its usable axis through horizontal overflow and the 396px editor rail caps at the viewport width.

## Required fidelity surfaces

- Fonts and typography: Spectral carries the title and financial emphasis; Hanken Grotesk carries labels and controls. Weight, scale, tracking, line height, truncation, and number alignment match the source hierarchy without substituting generic fonts.
- Spacing and layout rhythm: the 1560px maximum page, 34px/32px padding contract, 20px card radius, timeline rhythm, 48px lanes, 396px editor rail, and footer rules follow the handoff. No persistent controls overlap or clip.
- Colors and visual tokens: charcoal surfaces, champagne text, muted gold, category sage/blue/violet/rust accents, low-opacity gradients, hairlines, and restrained shadows map to the existing shared production tokens.
- Image quality and asset fidelity: source SVG category assets remain sharp and correctly tinted at chip, starter, editor-header, and category-picker sizes. No emoji, placeholder image, CSS icon, or handcrafted inline SVG replacement is present.
- Copy and content: the title, add action, editor labels, cadence language, timing presets, drag instruction, toast, and blank state are coherent and match the handoff's product language. Prototype navigation artifacts and Lifetime total are absent.
- Accessibility and interactions: semantic buttons and labeled inputs retain focus-visible treatment, reduced-motion support, disabled read-only states, and practical 38-44px control targets. Add, live edit, cadence, ranges, category, drag threshold, duplicate, delete/undo, Save, Scenarios propagation, persistence, and blank-household behavior passed.

## Comparison history

1. Initial full-view comparison found one P2 fidelity issue: the legacy Travel & leisure record rendered with the generic Custom star and gray band because its old `purpose` metadata did not identify a visual category.
2. Fix applied: legacy generic categories now infer a safe display category from the existing goal name while preserving the engine's amount/start/end contract. Travel & leisure now uses the source globe asset and muted-gold band.
3. Post-fix evidence: `goals-horizon-implementation-1280-v2.png` was compared directly with `goals-horizon-reference.png`; the source asset, gold line treatment, typography, spacing, and card hierarchy now align. No additional P0/P1/P2 issue was found.

## Verification

- `npm test`: 355 total, 354 passed, 1 skipped, 0 failed.
- `node scripts/verify.mjs`: passed the complete unit and browser suite, including Goals Horizon rendering, starter add, live edits, monthly cadence conversion, one-time/recurring timing, category changes, duplicate, delete/undo, drag, Scenarios propagation, blank household, saved reload, theme, header, and read-only persistence.
- In-app browser console: no errors or warnings.
- Primary interactions tested in the in-app browser and the project verifier: navigation, goal selection, rail opening, add panel, edits, cadence, timing, category, drag, duplicate, delete/undo, save/reload, cross-page Scenarios flow, and blank/read-only states.

final result: passed

---

# Graphite & Aubergine Refinement — Owner Corrections Design QA

## Comparison target

- Source visual truth:
  - `C:\Users\amans\AppData\Local\Temp\codex-clipboard-8a80a37d-ec2a-4fbb-8d70-750a3eb5000f.png` — Goals editor timing-pill clipping.
  - `C:\Users\amans\AppData\Local\Temp\codex-clipboard-d079b80f-4eba-4d9e-a89a-d7deebd459ef.png` — Net Worth side panel to remove.
  - `C:\Users\amans\AppData\Local\Temp\codex-clipboard-34fb2afb-a29b-4a57-91ff-5c26b8361483.png` — redundant IRMAA filing-status controls.
  - `C:\Users\amans\AppData\Local\Temp\codex-clipboard-44fedb38-96be-4898-846d-8d6851205347.png` — Tax summary and IRMAA layout before stacking.
- Browser-rendered implementation:
  - `C:\Users\amans\AppData\Local\Temp\pr197-goal-editor-760x900.png`.
  - `verify-out/wizard-net-worth-desktop.png`.
  - `verify-out/wizard-tax-desktop.png`.
- Viewports: Goals editor at 760 x 900 CSS pixels; Household captures at 1440 x 900 CSS pixels.
- States: open recurring-goal editor; Net Worth wizard step; Tax wizard step with manual two-year IRMAA lookback.

## Full-view comparison evidence

- The Goals rail preserves the approved fixed editor structure while allowing each timing preset to use its complete text width. At the 760px responsive viewport, all four timing controls are fully visible and the editor remains usable without horizontal clipping.
- Net Worth now uses the full wizard content width. The redundant right-side summary panel is absent; the established Back/Continue footer remains the only step-navigation surface.
- Tax presents five compact stacked rows in this order: Tax year, Filing status, Deduction method, first IRMAA year/MAGI, second IRMAA year/MAGI. The two redundant per-year filing-status bars are absent.
- The shared Graphite & Aubergine field, card, button, selector, chip, modal, rail, and wizard surfaces use restrained 5px, 6px, or 8px radii rather than square corners or oversized capsules.

## Focused region comparison evidence

- Goals timing presets were measured in the live DOM. Each control is 175 x 40 CSS pixels with identical client and scroll dimensions; `All retirement 65–90` has no horizontal or vertical overflow. All four controls use an 8px radius.
- Net Worth browser verification asserts that the removed rail has zero matches and that exactly one wizard footer remains.
- Tax browser verification asserts exactly five summary boxes and zero IRMAA filing-status controls.
- The IRMAA planning adapter is covered by a focused stale-row regression: household filing status remains authoritative even when an older saved lookback row carries a different status. Withdrawal Planner continues to source filing status from the authoritative plan input.

## Findings

- No candidate-caused P0, P1, or P2 visual or functional mismatch remains in the five owner-requested corrections.
- The retirement-handoff warnings supplied separately by the owner are produced by accepted current-main scenario validation for the saved household. This candidate does not modify the engine, scenario controller, retirement-entry contract, state, or Cash Flow calculation path, and it does not hide those warnings.
- A pre-existing always-on Healthcare goal can expose missing age values when opened directly in the editor. The candidate does not alter that data contract; the issue is outside this styling/layout correction and is not concealed by the visual verification.

## Comparison history

1. Owner review found a clipped long timing preset, a redundant Net Worth side panel, repeated IRMAA filing-status controls, a horizontally fragmented Tax summary, and overly square surfaces.
2. The first correction pass implemented the requested DOM and styling changes and added focused authority/layout checks.
3. The first governed browser run passed all 751 unit tests and the new correction checks, then exposed a later Scenarios readiness race because the visual QA step left the Goals rail open.
4. The visual check was corrected to close the rail and wait for its observable absence. The exact replacement candidate then passed the complete governed browser flow.
5. A final live 760px inspection measured the timing controls directly and confirmed no clipped text.

## Verification

- Focused Goal/IRMAA/Wizard tests: 33 passed, 0 failed.
- Focused Withdrawal Planner IRMAA tests: 3 passed, 0 failed.
- `npm run verify`: passed, including 24/24 pretests and 751/751 unit tests plus Household, Tax, Withdrawal Planner, Goals, Scenarios, Cash Flow, Sequencing, persistence, and the new owner-correction browser assertions.
- `git diff --check`: passed.
- Immutable local artifact verification: passed before owner inspection on `http://127.0.0.1:8825/`.

final result: passed

---

# Income & Tax Wizard Phase 7 Design QA

## Comparison target

- Source visual truth:
  - `C:\Dev\Parallax\Claude tax\design_handoff_income_tax_step\README.md`
  - `C:\Dev\Parallax\Claude tax\design_handoff_income_tax_step\Income Tax Step -2a-.dc.html`
- Browser-rendered implementation:
  - `verify-out/phase7-income-tax-1440.png`
  - `verify-out/phase7-income-tax-full-1440.png`
  - `verify-out/phase7-income-add-1440.png`
- Side-by-side inspection used the local design 2a reference captures and the browser-rendered implementation captures above.
- Viewports: 1440 x 900 and 1440 x 1540.

## Fixture coverage

- The visual capture asserts and logs all requested rows before taking a screenshot: two wages, interest, dividends, real long-term and short-term gain inputs, two Social Security rows, two 401(k) entries, HSA, three deductions, and Premium Tax Credit.
- The populated capture uses the production long-term and short-term gain types and a persisted Premium Tax Credit; none of these rows are screenshot-only stand-ins.
- The populated fixture uses supported deductions so the computed ledger remains an honest federal-engine result rather than displaying invented medical/SALT treatment.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- The implementation preserves design 2a's five-step hierarchy, two-column income and adjustment/deduction ledgers, restrained gold/charcoal treatment, computed four-cell foundation, six-cell Tax Position grid, and quiet pinned footer.
- Production inline inputs expose the complete editable timing, growth, taxable, and qualified fields while retaining the source hierarchy. Money fields remain readable and do not wrap their currency prefix.
- The integrated Parallax header and editable annual-savings row are retained production context, not prototype artifacts.
- IRMAA and the age-65 enhancement remain explicitly `Not modeled`; the UI does not fabricate values shown by the static mock.
- The compact Roth-conversion add form fits cleanly at 1440px, hides irrelevant timing fields, and reveals only its taxable-percentage input.
- Deductible IRA contributions and separate real-estate/personal-property taxes persist and display, but their rows and summary clearly disclose that required workplace-plan facts or the federal SALT-cap rule are not yet available.

## Verification

- `npm test`: 381 passed, 0 failed.
- `node scripts/verify.mjs`: passed the complete unit, static-contract, browser, interaction, persistence, calculation, readability, and screenshot suite.
- Phase 7 browser coverage includes all five new current-year income choices, the compact Roth-conversion path, timing-based column placement, working-only 401(k) behavior, deductible IRA and separate property-tax choices, Premium Tax Credit persistence, six tax-position cells, money-input layout, and scrollbar treatment.
- Visual capture console: no errors.

final result: passed

---

# Tax Buckets Phase 7 Design QA

## Comparison target

- Source visual truth:
  - `C:\Dev\Parallax\Claude Tax Buckets\concept-a.html`
  - `C:\Dev\Parallax\Claude Tax Buckets\glass-pod-spec.md`
  - `C:\Dev\Parallax\Claude Tax Buckets\handoff-spec.md`
- Browser-rendered implementation:
  - `C:\Dev\Parallax\.worktrees\tax-buckets-phase-7\verify-out\02-tax-buckets-entry.png`
  - `C:\Dev\Parallax\.worktrees\tax-buckets-phase-7\verify-out\02-tax-buckets.png`
- Direct comparison viewport: 1440 x 900.
- States: entrance, live three-pod view, empty household, incomplete snapshot, and blocked recovery.

## Comparison evidence

- The source and implementation were reviewed together at the same 1440 x 900 viewport, including a focused pod comparison.
- Final desktop frame geometry matches the source: 1240px wide at x=100, with the live view beginning at y=108. Each pod is 396px wide with a 26px gap and 18px radius.
- The implementation uses the locked glass gradient, borders, shadows, fixed ambient glow, and `blur(26px) saturate(1.35)` treatment from the approved specification.
- Typography, title placement, balance hierarchy, labels, rules, and pod spacing match the approved Spectral and Hanken Grotesk treatment.
- The production header is intentionally retained. Its height is compensated inside the entrance and live layouts so the approved content aligns with the source.
- The prototype-only Replay control is intentionally absent. The entrance still plays on the first visit, then reveals the live bucket view.
- Mock balances were intentionally replaced with current Household values. Unknown taxable basis remains visibly unconfirmed rather than fabricating gain data.

## Findings and iteration

- No actionable P0, P1, or P2 mismatch remains.
- The first production comparison placed the content 56px below the source because of the live header. The page offsets were corrected and remeasured.
- Extra text line-height differences were removed after the focused comparison. Final title and pod metrics align with the approved source.
- Empty, incomplete, and blocked states remain quiet and fail closed; none presents invented calculations.

## Required fidelity surfaces

- Fonts and hierarchy: Spectral for display and financial emphasis; Hanken Grotesk for labels and supporting copy.
- Layout: three equal desktop columns, 26px gaps, responsive single-column fallback, and no overlapping controls.
- Surfaces: identical glass treatment across all three pods, subtle warm hairlines, approved radii, restrained shadows, and fixed ambient lighting.
- Content truth: display-only UI backed by the shared current-bucket snapshot; no UI-side financial math and no replay affordance.
- Interaction and accessibility: semantic navigation, reduced-motion support, entrance-to-view transition, honest empty/incomplete/recovery messaging, and clean browser console.

## Verification

- `npm test`: 368 total, 367 passed, 1 skipped, 0 failed.
- `node scripts/verify.mjs`: passed the complete unit and browser suite, including entrance, exactly three live pods, live balances, basis disclosure, identical glass treatment, empty household, blocked recovery, persistence, and cross-page behavior.
- In-app browser console: no errors or warnings.

final result: passed

---

# Withdrawal Planner Design QA

## Comparison target

- Source visual truth: `C:\Users\amans\Downloads\tax wd.png`.
- Browser-rendered implementation:
  - `C:\Dev\Parallax\.worktrees\withdrawal-planner-design\verify-out\design-qa-1536x958.png`
  - `C:\Dev\Parallax\.worktrees\withdrawal-planner-design\verify-out\design-qa-640x900.png`
  - `C:\Dev\Parallax\.worktrees\withdrawal-planner-design\verify-out\design-qa-390x844.png`
- Direct comparison viewport: 1536 x 958 CSS pixels at device scale factor 1.
- Comparison state: blank Demo Household, zero withdrawals, dark theme, Withdrawal Planner active, and canonical Single filing status.

## Full-view comparison evidence

- The source and final implementation were reviewed together at the same 1536 x 958 resolution after the final spacing correction.
- The implementation matches the source's 36px page gutter, 360px control column, 22px main gap, 1082px threshold card, four equal threshold columns, restrained charcoal surfaces, warm hairlines, muted gold accents, and full-height desktop composition.
- The controls retain the source rhythm while applying the final product-owner order: fixed-income heading, read-only source rows, total, five withdrawal sliders, and the effective/marginal rate summary.
- Threshold headlines, bar-edge values, footer limits, Federal tax, effective rate, and marginal rate are rendered only from engine or tax-engine results. The implementation does not reproduce the prototype's tax arithmetic.

## Focused region comparison evidence

- Left controls: checked income-row baselines, inline tax-caused values, slider label/value alignment, 4px tracks, 16px thumbs, 22px row rhythm, bottom divider, and rate summary against the source at native resolution.
- Threshold card: checked header placement, four-column geometry, title tracking, headline hierarchy, bar height, tick placement, edge labels, footer baselines, border opacity, radius, and inner padding.
- Responsive states: at 1024 x 768 the planner uses the desktop split with a two-by-two threshold grid; at 640 x 900 the controls and threshold card stack with a two-by-two threshold grid; at 390 x 844 the threshold columns stack individually. The planner has no horizontal overflow at either mobile viewport.

## Findings

- No actionable P0, P1, or P2 mismatch remains within the Withdrawal Planner page.
- The production header remains intentionally authoritative. It is 56px tall and includes plan status and Run; the static source uses a simpler 66px header. The planner's internal geometry matches once measured from the content edge.
- Source footer dollar limits reflect a different filing-status fixture. The implementation shows the current plan's engine-approved limits instead of copying those static figures.
- The fixed-income heading now sits above its three source rows, with a separate Total row below them. All fixed-income and slider dollar values share the same measured right edge.
- Values unavailable from the engines remain blank, including IRMAA and unavailable effective/Social Security rate details. The UI does not substitute zero or calculate a display value itself.
- The gold pencil visible at the lower-right of browser captures is annotation chrome and is not present in the application DOM.
- At a 390px viewport, the existing global header navigation remains horizontally scrollable. That shell behavior is unchanged by this page-scoped implementation; the Withdrawal Planner content itself does not overflow.

## Comparison history

1. The initial production comparison found P2 mismatches: a page-local tax override toolbar, a separate input card shell, dead lower-page space, rate headlines where the design calls for dollar figures, methodology copy, undersized range controls, and attribution values separated from their withdrawals.
2. Those elements were removed or realigned while keeping all calculations in the engine and tax engine.
3. The first final-size comparison found the slider stack approximately 3px too tight per row. The row gap was corrected to 22px.
4. Narrow-viewport QA then found a page-width overflow caused by the stacked grid retaining its max-content width. The mobile grid was fixed to 100% width and rechecked at 640px and 390px with no planner overflow.
5. The post-fix 1536 x 958 source and implementation were compared together again. No further page-level P0/P1/P2 mismatch was found.
6. Product-owner review moved the Fixed income sources heading above the source rows and requested one separate Total row below them.
7. The review also found the fixed-income and slider dollar columns misaligned. The reserved slider scrollbar gutter was removed; browser measurement now places all nine amount fields on the same right edge.
8. Fresh end-to-end verification found that live comma formatting could prevent a Tax-page money field from committing on blur. The shared Household input boundary now preserves live formatting and commits the formatted value once, so saved wages and account balances reach the planner after navigation and reload.

## Verification

- Focused unit and adapter tests: 76 passed, 0 failed.
- Full unit suite: 662 passed, 0 failed.
- The project verifier passed the Tax-page Wages flow and every Withdrawal Planner check before stopping later on an unrelated Goals blank-household baseline failure.
- A funded live household confirmed that `$80,000` of saved wages survives reload. Moving the IRA slider from `$0` to `$50,000` changed Federal tax and the Income Tax column from `$8,770` to `$19,934`, with Tax caused of `$11,164`.
- Responsive browser checks passed at 1536 x 958, 1024 x 768, 640 x 900, and 390 x 844.
- In-app browser console: no errors or warnings.

final result: passed

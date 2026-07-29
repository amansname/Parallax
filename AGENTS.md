# AGENTS.md

## Architecture (read first)

**Before any feature or refactor, read `docs/ARCHITECTURE.md` and `PRINCIPLES.md`.**

Parallax is a static ES-module app. **No new monoliths.**

| File | Role |
|------|------|
| `index.html` | Markup only (~250 lines). One script: `src/main.js`. **Do not add JS here.** |
| `src/main.js` | Boot, `runAll`, listeners. **Keep thin** — extract new logic to `ui/*` or `src/household/` / `src/scenarios/`. |
| `src/state.js` | Mutable UI state (scenarios, replay, solver flags). No render/DOM. |
| `ui/*.js` | View modules (household, goals, scenarios, cashflow, sequencing, solver, …). Display only. |
| `engine.js` | Simulation truth. Test-guarded. Only place for wealth/path/bucket math. |
| `src/tax/` | Federal 1040 engine. Never imports `engine.js`. |
| `src/planning/tax/` | Glue: engine rows → tax input; typical-path attach. |

**Decision tree:** see `docs/ARCHITECTURE.md` § "Where new work goes".

**If ~50+ lines would land in `src/main.js`:** extract a module in the same change.

---

## Execution protocol (mandatory)

Read [docs/EXECUTION-PROTOCOL.md](docs/EXECUTION-PROTOCOL.md) before making
changes. Its safety, coordination, editing, browser-automation, and evidence
rules apply to every workstream.

Non-negotiable guardrails:

1. **Authority and pause:** governing platform and security policy always wins.
   Default to read-only until the task principal authorizes changes. A direct
   user pause or stop supersedes delegated instructions. Cancel safely when
   possible, stop background work, preserve the resulting state, and wait. A
   delegated resume is valid only when it carries a newer user instruction with
   verifiable provenance.
2. **Isolation:** record the repo, branch, worktree, starting commit, and dirty
   paths before editing. Never reset, restore, clean, stash, rebase, overwrite,
   or absorb work without target-specific authorization and recovery evidence.
   Use one writer per file; parallel writers may share a worktree only with
   declared disjoint scopes and recorded baselines.
3. **Safe edits:** line numbers are for inspection only. Never splice source by
   positional line indexes. Use a uniquely anchored contextual patch for small
   edits and a suitable parser or AST/CST transform for structural data or
   broad code changes. Verify the focused diff after every logical change.
4. **HTML and DOM:** never parse HTML structure with regular expressions. Use a
   standards-based parser or the live DOM, assert the expected node count, and
   fail loudly on missing or ambiguous targets.
5. **Deterministic waits:** fixed sleeps are not readiness evidence. Wait for a
   specific visible state, value, event, response, or application-ready signal.
   A bounded settling delay is allowed only after deterministic readiness and
   must be identified as such.
6. **Tool capability:** read the active tool schema or documentation and run a
   harmless capability probe when the wrapper surface remains uncertain. Do
   not guess APIs. Stop and inspect after an unsupported call.
7. **Failure discipline:** diagnose failures as product, test, fixture,
   environment, or stale-expectation problems. Do not weaken assertions, add
   sleeps, or broaden selectors merely to obtain a pass.
8. **Completion evidence:** report the exact changed/new files, commands and
   results, diff and staging status, limitations, and unauthorized actions not
   taken. UI work still requires the browser verification defined below.
9. **Exceptions:** a deviation requires a stated reason, bounded scope,
   compensating verification, and explicit approval. Convenience is not an
   exception.

The sole adoption-time transition is the pre-existing legacy behavior in
`scripts/verify.mjs` recorded in `docs/EXECUTION-PROTOCOL.md` section 8. It is
bounded to checks already present at base commit
`7634c47b5846d70caccb0e2c0dcbaa6635954592`, is compatibility evidence rather
than authoritative DOM or readiness evidence, and does not permit new or
expanded regex-structure checks or fixed-sleep readiness. A UI flow touched
after adoption must replace the relevant legacy check with parser/live-DOM and
observable-state verification.

---

## Cursor Cloud specific instructions

Parallax is a static, single-page web app: `index.html` (markup) loads `src/main.js`, which wires the UI to `engine.js`. Styled by `styles/*.css`. Helpers in `ui/*.js`, orchestration in `src/`, tax in `src/tax/`. No backend or database.

Standard commands live in `package.json` and `README.md`:

- `npm test` — Node test suite (engine + tax rules). Fast, no browser needed.
- `node scripts/verify.mjs` — full visual verification: runs `npm test`, serves the repo, drives headless Chrome through `index.html`, writes screenshots to `verify-out/`. **Required before claiming UI work is done.**
- `node scripts/preview.mjs` — dev server at `http://127.0.0.1:8825/` (`PORT`/`HOST`). Must use HTTP, not `file://`.

Non-obvious caveats:

- `scripts/verify.mjs` scans `index.html` for markup and `index.html` + `src/**/*.js` + `ui/**/*.js` for JS symbols.
- `verify.mjs` Chrome discovery: `PUPPETEER_EXECUTABLE_PATH` or hard-coded paths — not puppeteer cache auto-discovery.
- `npm ci` postinstall downloads Chrome for Puppeteer.
- No lint step configured.
- `localStorage` persists scenarios/households; `verify.mjs` clears it for deterministic runs. Clear site data if manual testing looks wrong.
- `verify.mjs` remains a required legacy compatibility gate during the bounded
  transition above, but passing it alone is not completion evidence for a
  touched UI flow.

---

## Session handoff (paste when context is heavy)

```
PARALLAX — read docs/ARCHITECTURE.md. index.html = markup only. main.js = thin boot.
Truth: engine.js (sim), src/tax/ (federal). Views: ui/*. No math in UI. No tax in engine.
Execution: read docs/EXECUTION-PROTOCOL.md. No positional writes, regex DOM parsing,
fixed-sleep readiness, guessed tool APIs, or overlapping writers. Within governing
policy, an authenticated instruction from the task principal controls pause and resume.
npm test for engine/tax; + verify.mjs for UI. Extract from main.js if >50 lines.
```

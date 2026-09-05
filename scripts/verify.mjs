import { setCashFlow, waitCashRows, cashFlowSessionSnapshot, waitForCashFlowPath } from './browser/cashflow/actions.mjs';
import { startStaticServer, closeServer } from './browser/artifact-server.mjs';
import { prepareVerifiedArtifact } from './browser/artifact.mjs';
import { verifyTaxBuckets } from './browser/static-contracts.mjs';
import { createBrowserSession } from './browser/browser-session.mjs';
import { createPlannerDiagnostics } from './browser/withdrawal-diagnostics.mjs';
import { verifyStartup } from './browser/startup.mjs';
import { verifyDesign } from './browser/design.mjs';
import { verifySavedWages } from './browser/withdrawal-wages.mjs';
import { enterWithdrawalFixture } from './browser/withdrawal-fixture.mjs';
import { verifyWithdrawalResults } from './browser/withdrawal-results.mjs';
import { verifyRapidApprovals } from './browser/withdrawal-controls.mjs';
import { verifyRmdControls } from './browser/withdrawal-controls.mjs';
import { verifyGoalsTimeline } from './browser/goals.mjs';
import { verifyGoalsEditing } from './browser/goals.mjs';
import { verifyGoalsDrag } from './browser/goals.mjs';
import { verifyScenarioAllocation } from './browser/scenario-allocation.mjs';
import { verifyRetirementRelativeGoals } from './browser/scenario-timing.mjs';
import { verifyStarterGoals } from './browser/goals.mjs';
import { verifyCompareView } from './browser/scenario-views.mjs';
import { verifyFocusView } from './browser/scenario-views.mjs';
import { verifyZeroBaseSavings } from './browser/scenario-views.mjs';
import { verifyPlanningAgeLimits } from './browser/scenario-timing.mjs';
import { verifyCashFlow } from './browser/cashflow/campaign.mjs';
import { verifySequencingChips } from './browser/sequencing.mjs';
import { verifyNoDeferredPlayback } from './browser/sequencing.mjs';
import { verifyHeader } from './browser/design.mjs';
import { verifyPageBackgrounds } from './browser/design.mjs';
import { verifyRetiredAgeLever } from './browser/scenario-timing.mjs';
import { verifyFundingAcrossGoals } from './browser/funding.mjs';
import { verifyTaxFundedProbability } from './browser/funding.mjs';
import { verifyJoeStartupPersistence } from './browser/persistence-startup.mjs';
import { verifySavedHouseholdSelection } from './browser/persistence-startup.mjs';
import { verifyScenarioStorageScope } from './browser/persistence-startup.mjs';
import { verifySchemaMerge } from './browser/persistence-migration.mjs';
import { verifyCorruptStorage } from './browser/persistence-migration.mjs';
import { verifyReadOnlyPersistence } from './browser/persistence-read-only.mjs';
import { verifyHouseholdDeletion } from './browser/persistence-deletion.mjs';
/* Visual verification probe: test, serve the app, drive headless Chromium
   through the real index.html, and write screenshots to ./verify-out/.
   Exit non-zero if anything fails.

   Run: node scripts/verify.mjs */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runPublicUrlBrowserContract } from './public-url-browser-contract.mjs';
import { runGoalsPresentationContract } from './goals-presentation-browser-contract.mjs';
import { runRolloverErrorBrowserContract } from './rollover-error-browser-contract.mjs';
import { runWizardBrowserContract } from './wizard-browser-contract.mjs';
import { formatDuration, shouldRunUnitSuite } from './browser/verification-runtime.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const verificationStartedAt = performance.now();
const OUT = join(ROOT, 'verify-out');
const VERIFIED_ARTIFACT = prepareVerifiedArtifact(ROOT);
const WITHDRAWAL_PLANNER_FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'withdrawal-planner-visible-entry.v1.json'), 'utf8'));
let withdrawalPlannerFixtureHouseholdId = null;
const WITHDRAWAL_PLANNER_ORACLE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'withdrawal-planner-oracle.v1.json'), 'utf8'));
const PORT = 8825;
const requestedPort = Number(process.env.PORT || PORT);
if (requestedPort !== PORT) {
  console.error(`Parallax browser verification is fixed at http://127.0.0.1:${PORT}/.`);
  process.exit(1);
}
const SKIP_SEQUENCING = process.env.PARALLAX_VERIFY_SKIP_SEQUENCING === '1';
const RUN_UNIT_TESTS = shouldRunUnitSuite();
function step(name, fn) {
  const startedAt = performance.now();
  console.log(`  START ${name}`);
  return fn().then(r => {
    console.log(`  OK ${name} (${formatDuration(performance.now() - startedAt)})`);
    return r;
  }, e => {
    console.error(`  FAIL ${name} (${formatDuration(performance.now() - startedAt)})\n${e.stack || e.message || e}`);
    process.exit(1);
  });
}

// Cash Flow is a view inside the ScenariosUI layer, toggled by #scn-cash-toggle
// (state.cashActive). Click the chip only when it isn't already in the wanted
// state, then let the single authoritative sync repaint #scn-view.

// Poll until the Cash Flow view has painted its engine-backed rows. The run is
// async (runAll defers, computes, then ScenariosUI.sync repaints), so a fixed
// sleep is unreliable.

/* Household verification now enters through the semantic four-step wizard.
   The retired Balance-Sheet / Map editor and its numeric step selectors are
   intentionally absent from this verifier. */

rmSync(OUT, {
  recursive: true,
  force: true
});
mkdirSync(OUT, {
  recursive: true
});
if (RUN_UNIT_TESTS) {
  const unitStartedAt = performance.now();
  console.log('full test suite (npm test)');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const test = process.platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/s', '/c', npmCmd, 'test'], {
    cwd: ROOT,
    stdio: 'inherit'
  }) : spawnSync(npmCmd, ['test'], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (test.status !== 0) {
    console.error(`npm test failed (${formatDuration(performance.now() - unitStartedAt)})`);
    process.exit(1);
  }
  console.log(`  OK full test suite (${formatDuration(performance.now() - unitStartedAt)})`);
} else {
  console.log('full test suite skipped (covered by the required CI Unit tests job)');
}
console.log('Tax Buckets contract (static)');
verifyTaxBuckets(ROOT, SKIP_SEQUENCING);
console.log('serve + drive');
const srv = await startStaticServer(VERIFIED_ARTIFACT, PORT);
try {
  const {
    browser,
    page,
    stableClick,
    stableEvaluate,
    stableGoto,
    stableReload,
    errs,
    artifactRequests,
    artifactResponses
  } = await createBrowserSession(PORT);
  const {
    plannerDiagnosticState,
    waitForPlannerState
  } = createPlannerDiagnostics({
    page,
    stableEvaluate,
    errs
  });
  await step('load index.html', () => verifyStartup({
    stableGoto,
    PORT,
    page,
    stableReload,
    VERIFIED_ARTIFACT,
    artifactRequests,
    artifactResponses,
    stableClick
  }));
  await step('public URL stays clean while artifact requests remain versioned', async () => {
    await runPublicUrlBrowserContract(browser, {
      baseUrl: `http://127.0.0.1:${PORT}/`,
      artifactId: VERIFIED_ARTIFACT.manifest.artifactId
    });
  });
  await step('Cash Flow renders the actual projection failure without false tax or handoff claims', async () => {
    await runRolloverErrorBrowserContract(browser, `http://127.0.0.1:${PORT}/`);
  });

  await step('Graphite Aubergine design contracts render at governed viewports', () => verifyDesign({
    VERIFIED_ARTIFACT,
    page,
    stableEvaluate,
    stableClick,
    setCashFlow
  }));
  await step('Tax wizard: saved Wages reach Withdrawal Planner without Continue', () => verifySavedWages({
    page,
    plannerDiagnosticState,
    stableClick,
    waitForPlannerState,
    WITHDRAWAL_PLANNER_FIXTURE
  }));
  withdrawalPlannerFixtureHouseholdId = await step('enter funded Withdrawal Planner household through visible production controls', () => enterWithdrawalFixture({
    stableClick,
    page,
    WITHDRAWAL_PLANNER_FIXTURE,
    stableReload
  }));
  await step('Tax Buckets: production household loads with funded limits and live tax output', () => verifyWithdrawalResults({
    page,
    plannerDiagnosticState,
    stableClick,
    waitForPlannerState,
    withdrawalPlannerFixtureHouseholdId,
    WITHDRAWAL_PLANNER_FIXTURE,
    WITHDRAWAL_PLANNER_ORACLE,
    OUT
  }));
  await step('Tax Buckets: rapid slider approvals preserve both changes', () => verifyRapidApprovals({
    page
  }));
  await step('Tax Buckets: production RMD floor and shared IRA limits reach the controls', () => verifyRmdControls({
    page
  }));
  await step('household wizard: semantic four-step contract', async () => {
    await runWizardBrowserContract(page, {
      outDir: OUT
    });
  });
  await step('goals Horizon: timeline, glass card, lanes, and no lifetime aggregate', () => verifyGoalsTimeline({
    stableClick,
    page,
    OUT
  }));
  await step('goals Horizon: exact monthly labels and persistent category glows', async () => {
    await runGoalsPresentationContract(page, {
      householdId: withdrawalPlannerFixtureHouseholdId,
      outDir: OUT
    });
  });
  await step('goals Horizon: add, edit, cadence, timing, category, duplicate, delete, undo', () => verifyGoalsEditing({
    stableClick,
    page,
    withdrawalPlannerFixtureHouseholdId,
    VERIFIED_ARTIFACT
  }));
  await step('goals Horizon: drag preserves a lane span and reaches Scenarios', () => verifyGoalsDrag({
    stableClick,
    page,
    withdrawalPlannerFixtureHouseholdId
  }));
  await step('scenarios: allocation labels and both spouses ages persist through reload', () => verifyScenarioAllocation({
    page,
    withdrawalPlannerFixtureHouseholdId,
    stableReload,
    stableClick
  }));
  await step('scenarios: retirement-relative goal ages resolve and round-trip', () => verifyRetirementRelativeGoals({
    page,
    stableClick,
    withdrawalPlannerFixtureHouseholdId,
    WITHDRAWAL_PLANNER_FIXTURE
  }));
  await step('goals Horizon: new household shows system goals and derives starter timing from its plan', () => verifyStarterGoals({
    page,
    stableClick,
    withdrawalPlannerFixtureHouseholdId
  }));
  await step('scenarios Compare view: columns, rings, levers, goals', () => verifyCompareView({
    page,
    cashFlowSessionSnapshot,
    OUT
  }));
  await step('scenarios Focus view: hero ring, lever steppers, goals, rail', () => verifyFocusView({
    page,
    OUT
  }));
  await step('scenarios zero-base savings changes a fourth column and survives reload', () => verifyZeroBaseSavings({
    page,
    withdrawalPlannerFixtureHouseholdId,
    cashFlowSessionSnapshot,
    stableReload,
    stableClick,
    OUT
  }));
  await step('entered planning ages cap Goals and Focus results', () => verifyPlanningAgeLimits({
    page,
    withdrawalPlannerFixtureHouseholdId,
    stableReload,
    stableClick
  }));
  await step('cash-flow view: exact columns, rows, summary, path controls, pills', () => verifyCashFlow({
    page,
    withdrawalPlannerFixtureHouseholdId,
    stableReload,
    stableClick,
    errs,
    setCashFlow,
    waitCashRows,
    SKIP_SEQUENCING,
    waitForCashFlowPath,
    OUT,
    cashFlowSessionSnapshot
  }));
  if (!SKIP_SEQUENCING) {
    await step('sequencing renders all chips on', () => verifySequencingChips({
      page,
      errs,
      OUT
    }));
    await step('sequencing excludes deferred Playback', () => verifyNoDeferredPlayback({
      page,
      OUT
    }));
  }

  // Objective theme contract: all primary product pages share the approved graphite
  // surface, while the header uses that same surface with copper interaction accents.
  await step('visual contract: 68px Graphite Aubergine header rail and tabs are correct', () => verifyHeader({
    stableClick,
    page
  }));
  await step('theme: product pages sit on the shared graphite background', () => verifyPageBackgrounds({
    stableEvaluate,
    stableClick,
    page,
    SKIP_SEQUENCING
  }));
  await step('retirement age lever goes inert once the household is already retired', () => verifyRetiredAgeLever({
    stableEvaluate,
    stableClick,
    page
  }));
  await step('funding truth survives visible Goals edits and reaches probability and Cash Flow', () => verifyFundingAcrossGoals({
    page,
    withdrawalPlannerFixtureHouseholdId,
    stableReload,
    stableClick,
    setCashFlow,
    OUT
  }));
  await step('tax-funded probability remains unchanged outside Cash Flow after Run', () => verifyTaxFundedProbability({
    page,
    withdrawalPlannerFixtureHouseholdId,
    stableReload,
    stableClick,
    setCashFlow,
    waitCashRows
  }));

  // ── Multi-household persistence & bootstrapping ────────────────────────────
  // These run LAST (they clear storage and reload) so they can't disturb the
  // earlier contracts above. They prove the state-management contract:
  // startup hydrates Joe, shipped templates remain explicit choices, saved
  // values survive reload, and scenario storage remains household-scoped.
  await step('persistence: first load hydrates Joe with approved shipped options', () => verifyJoeStartupPersistence({
    page,
    stableReload,
    WITHDRAWAL_PLANNER_ORACLE
  }));
  await step('persistence: reload returns to Joe while saved households remain selectable', () => verifySavedHouseholdSelection({
    page,
    stableClick,
    WITHDRAWAL_PLANNER_ORACLE,
    stableReload
  }));
  await step('persistence: scenario localStorage is scoped by householdId', () => verifyScenarioStorageScope({
    page
  }));
  await step('persistence: schema merge preserves custom values and refreshes shipped templates', () => verifySchemaMerge({
    page,
    stableReload,
    stableClick
  }));
  await step('persistence: corrupt origin bytes are preserved while current defaults remain usable', () => verifyCorruptStorage({
    page,
    stableReload,
    stableClick
  }));
  await step('persistence: READ_ONLY disables every mutation but preserves navigation and bytes', () => verifyReadOnlyPersistence({
    page,
    stableReload,
    stableClick
  }));
  await step('persistence: user-created households can be explicitly deleted', () => verifyHouseholdDeletion({
    page,
    stableReload,
    stableClick
  }));
  if (errs.length) {
    console.error('PAGE/CONSOLE ERRORS:');
    errs.forEach(e => console.error('  ' + e));
    throw new Error(`${errs.length} page/console error(s) — verify must fail on application errors`);
  }
  await browser.close();
  console.log(`\nOK verify passed in ${formatDuration(performance.now() - verificationStartedAt)} - screenshots in ${OUT}`);
} finally {
  await closeServer(srv);
}

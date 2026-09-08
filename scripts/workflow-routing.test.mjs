import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { BROWSER_GROUPS } from './browser/verification-runtime.mjs';
import { readChangedPaths, selectBrowserGroups } from './browser/verification-plan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readWorkflow(name){
  const source = readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
  return {
    source,
    config: parseDocument(source, { prettyErrors: true }).toJS(),
  };
}

test('the full quality campaign never validates reviewer evidence from the opened-event snapshot', () => {
  const { source, config } = readWorkflow('test.yml');

  assert.deepEqual(config.on.pull_request.types, ['opened', 'synchronize', 'reopened']);
  assert.deepEqual(config.on.push.branches, ['main']);
  assert.deepEqual(config.concurrency, {
    group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}',
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  assert.deepEqual(Object.keys(config.jobs).sort(), ['artifact', 'browser', 'browser-groups', 'lint', 'unit']);
  assert.equal(config.jobs.lint.name, 'ESLint');
  assert.equal(config.jobs.lint.if, "github.event_name == 'pull_request'");
  assert.equal(config.jobs.lint.env.PARALLAX_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  const lintCheckout = config.jobs.lint.steps.find(step => String(step.uses).startsWith('actions/checkout@'));
  assert.equal(lintCheckout.with['fetch-depth'], 0);
  assert.match(source, /run: npm run lint:changed/);
  assert.doesNotMatch(source, /npm run governance:(?:check|pr)/);
  assert.doesNotMatch(source, /validate-pr-authorship\.mjs/);
});

test('quality jobs explicitly scope read-only repository access', () => {
  const { config } = readWorkflow('test.yml');
  assert.deepEqual(config.permissions, {});
  for(const job of Object.values(config.jobs)){
    assert.deepEqual(job.permissions, { contents: 'read' });
  }
});

test('selected browser groups retain complete shared-change coverage and reuse the candidate artifact and unit proof', () => {
  const { config } = readWorkflow('test.yml');
  const unitRuns = config.jobs.unit.steps
    .map(step => step.run)
    .filter(Boolean);
  const browser = config.jobs['browser-groups'];
  const browserRuns = browser.steps
    .map(step => step.run)
    .filter(Boolean);

  assert.ok(unitRuns.includes('npm test'));
  assert.deepEqual(browser.needs, ['artifact', 'unit']);
  assert.equal(browser['timeout-minutes'], 15);
  assert.equal(browser['runs-on'], 'ubuntu-latest');
  assert.equal(browser.strategy['fail-fast'], false);
  assert.deepEqual(browser.strategy.matrix, { group: '${{ fromJSON(needs.artifact.outputs.browser_groups) }}' });
  assert.equal(browser.name, 'Verify ${{ matrix.group }}');
  const artifact = config.jobs.artifact;
  assert.deepEqual(artifact.outputs, { browser_groups: '${{ steps.coverage.outputs.browser_groups }}' });
  assert.equal(artifact.env.PARALLAX_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(artifact.steps.find(step => step.id === 'coverage').run, 'node scripts/browser/verification-plan.mjs');
  assert.equal(artifact.steps.find(step => String(step.uses).startsWith('actions/checkout@')).with['fetch-depth'], 0);
  assert.deepEqual(BROWSER_GROUPS, ['entry', 'wizard-runtime', 'wizard-forms', 'scenarios', 'cashflow', 'persistence']);
  assert.equal(browser.env.PARALLAX_VERIFY_SKIP_UNIT_TESTS, '1');
  assert.equal(browser.env.PARALLAX_VERIFY_BROWSER_GROUP, '${{ matrix.group }}');
  assert.equal(browser.env.PARALLAX_ARTIFACT_ROOT, '.parallax-artifact');
  assert.equal(browser.if, undefined);
  assert.ok(browserRuns.includes('npm run verify'));
  assert.ok(!browserRuns.includes('npm test'));
  const verify = browser.steps.find(step => step.run === 'npm run verify');
  assert.equal(verify.if, undefined);
  const checkout = browser.steps.find(step => String(step.uses).startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ env.CANDIDATE_SHA }}');
  const download = browser.steps.find(step => String(step.uses).startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, 'parallax-site-${{ env.CANDIDATE_SHA }}');
  assert.equal(download.with.path, '.parallax-artifact');
  const artifactCheckIndex = browser.steps.findIndex(step => step.run === 'npm run site:verify');
  assert.ok(artifactCheckIndex >= 0 && artifactCheckIndex < browser.steps.indexOf(verify));
  const upload = browser.steps.find(step => String(step.uses).startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.name, 'parallax-browser-verification-${{ env.CANDIDATE_SHA }}-${{ matrix.group }}');
  assert.equal(upload.with.path, 'verify-out/');

  const narrowCases = [
    [['ui/cashflow.js'], ['entry', 'cashflow']],
    [['scripts/browser/cashflow/restore-fixture.mjs'], ['entry', 'cashflow']],
    [['ui/goalsHorizon.js'], ['entry', 'scenarios', 'cashflow']],
    [['styles/scenarios.css'], ['entry', 'scenarios', 'cashflow']],
    [['ui/taxAwareWithdrawalColumns.js'], ['entry']],
    [['scripts/browser/withdrawal-fixture.mjs'], ['entry', 'scenarios', 'cashflow']],
    [['scripts/browser/persistence-migration.mjs'], ['entry', 'persistence']],
    [['scripts/browser/persistence-migration.mjs', 'ui/cashflow.js', 'ui/cashflow.js'], ['entry', 'cashflow', 'persistence']],
    [['README.md', 'docs/AUDIT-F02-2026-09-08.md'], ['entry']],
  ];
  for (const [paths, expected] of narrowCases) {
    assert.deepEqual(selectBrowserGroups(paths), expected, paths.join(', '));
    assert.deepEqual(selectBrowserGroups(paths, 'push'), BROWSER_GROUPS, 'main always runs all groups');
  }
  const broadPaths = [
    'engine.js', 'src/projection/engine/savingsContributions.js', 'src/tax/annual1040.js',
    'src/planning/taxBuckets/taxEngineAdapter.js', 'src/household/persistence.js',
    'src/main.js', 'src/state.js', 'ui/householdFactories.js', 'ui/formatters.js',
    'index.html', 'styles/main.css', 'test/fixtures/household.json', 'package-lock.json',
    '.github/workflows/test.yml', 'scripts/verify.mjs', 'scripts/browser/verification-plan.mjs',
    'scripts/browser/cashflow/actions.mjs', 'scripts/browser/wizard/actions.mjs',
    'AGENTS.md', 'docs/CODEX_WORKFLOW.md', 'src/new-unknown-surface.js',
  ];
  for (const path of broadPaths) {
    // Includes deleted paths and both names of a rename from shared code.
    assert.deepEqual(selectBrowserGroups(['ui/cashflow.js', path]), BROWSER_GROUPS, path);
  }
  assert.deepEqual(selectBrowserGroups([]), BROWSER_GROUPS);
  assert.deepEqual(selectBrowserGroups(null), BROWSER_GROUPS);
  assert.deepEqual(selectBrowserGroups([null]), BROWSER_GROUPS);
  assert.deepEqual(selectBrowserGroups(['ui/cashflow.js'], 'unknown'), BROWSER_GROUPS);
  assert.throws(() => readChangedPaths({ GITHUB_EVENT_NAME: 'pull_request' }), /full base and candidate/);
  assert.throws(() => readChangedPaths({
    GITHUB_EVENT_NAME: 'pull_request', PARALLAX_BASE_SHA: '0'.repeat(40), CANDIDATE_SHA: '0'.repeat(40),
  }), /diff failed/);
});

test('the required browser aggregate rejects failures, cancellation, skips, and missing results without rerunning contracts', () => {
  const { source, config } = readWorkflow('test.yml');
  const browser = config.jobs.browser;
  assert.equal(browser.name, 'Full browser verification');
  assert.deepEqual(browser.needs, ['artifact', 'unit', 'browser-groups']);
  assert.equal(browser.if, 'always()');
  assert.equal(browser.steps.length, 1);
  const gate = browser.steps[0];
  assert.equal(gate.env.NEEDS_RESULTS, '${{ toJSON(needs) }}');
  assert.equal(gate.if, undefined);
  assert.doesNotMatch(gate.run, /npm|verify\.mjs/);
  assert.doesNotMatch(source, /continue-on-error|\|\| true|&& true/);
  const script = gate.run.match(/^node <<'NODE'\n([\s\S]+)\nNODE\n?$/)?.[1];
  assert.ok(script, 'aggregate must expose its strict Node result check');
  const success = Object.fromEntries(browser.needs.map(job => [job, { result: 'success' }]));
  function gateStatus(results){
    const execution = spawnSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      env: { ...process.env, NEEDS_RESULTS: JSON.stringify(results) },
      encoding: 'utf8',
    });
    assert.equal(execution.error, undefined);
    return execution.status;
  }
  assert.equal(gateStatus(success), 0);
  for(const job of browser.needs){
    for(const result of ['failure', 'cancelled', 'skipped', 'neutral', '']){
      assert.equal(gateStatus({ ...success, [job]: { result } }), 1, `${job}: ${result} must block`);
    }
    const missing = { ...success };
    delete missing[job];
    assert.equal(gateStatus(missing), 1, `${job}: missing must block`);
  }
});

test('the lightweight reviewer event owns the required governance context without full-suite commands', () => {
  const { source, config } = readWorkflow('pr-evidence.yml');

  assert.deepEqual(
    config.on.pull_request.types,
    ['edited', 'review_requested', 'review_request_removed', 'synchronize', 'reopened'],
  );
  assert.deepEqual(Object.keys(config.jobs), ['governance']);
  assert.equal(config.jobs.governance.name, 'Governance safeguards');
  assert.match(source, /run: npm run governance:check/);
  assert.match(source, /run: npm run governance:pr/);
  assert.match(source, /run: node scripts\/validate-pr-authorship\.mjs/);
  assert.doesNotMatch(source, /npm test|npm run verify|npm run site:(?:build|verify)/);
});

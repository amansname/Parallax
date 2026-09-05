import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { BROWSER_GROUPS } from './browser/verification-runtime.mjs';

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

test('all six browser groups reuse the same candidate artifact and unit proof on independent runners', () => {
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
  assert.deepEqual(browser.strategy.matrix, { group: [...BROWSER_GROUPS] });
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

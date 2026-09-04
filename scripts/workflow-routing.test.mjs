import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

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
  assert.deepEqual(Object.keys(config.jobs).sort(), ['artifact', 'browser', 'browser_plan', 'browser_shard', 'lint', 'unit']);
  assert.equal(config.jobs.lint.name, 'ESLint');
  assert.equal(config.jobs.lint.if, "github.event_name == 'pull_request'");
  assert.equal(config.jobs.lint.env.PARALLAX_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  const lintCheckout = config.jobs.lint.steps.find(step => String(step.uses).startsWith('actions/checkout@'));
  assert.equal(lintCheckout.with['fetch-depth'], 0);
  assert.match(source, /run: npm run lint:changed/);
  assert.doesNotMatch(source, /npm run governance:(?:check|pr)/);
  assert.doesNotMatch(source, /validate-pr-authorship\.mjs/);
});

test('the browser campaign reuses unit proof and runs four bounded shards in parallel', () => {
  const { config } = readWorkflow('test.yml');
  const unitRuns = config.jobs.unit.steps
    .map(step => step.run)
    .filter(Boolean);
  const browserShard = config.jobs.browser_shard;
  const browserRuns = browserShard.steps
    .map(step => step.run)
    .filter(Boolean);
  const browser = config.jobs.browser;
  const browserPlan = config.jobs.browser_plan;

  assert.ok(unitRuns.includes('npm test'));
  assert.equal(browserPlan.name, 'Browser verification plan');
  assert.equal(browserPlan.outputs.shards, '${{ steps.plan.outputs.shards }}');
  assert.ok(browserPlan.steps.some(step => step.run === 'echo "shards=$(node scripts/browser/verification-plan.mjs)" >> "$GITHUB_OUTPUT"'));
  assert.deepEqual(browserShard.needs, ['artifact', 'unit', 'browser_plan']);
  assert.equal(browserShard['timeout-minutes'], 5);
  assert.equal(browserShard.strategy['fail-fast'], false);
  assert.equal(browserShard.strategy.matrix.shard, '${{ fromJSON(needs.browser_plan.outputs.shards) }}');
  assert.equal(browserShard.env.PARALLAX_VERIFY_SKIP_UNIT_TESTS, '1');
  assert.equal(browserShard.env.PARALLAX_VERIFY_SHARD, '${{ matrix.shard }}');
  assert.ok(browserRuns.includes('npm run verify'));
  assert.ok(!browserRuns.includes('npm test'));
  assert.equal(browser.name, 'Full browser verification');
  assert.deepEqual(browser.needs, ['browser_shard']);
  assert.equal(browser.if, 'always()');
  assert.equal(browser['timeout-minutes'], 2);
  assert.ok(browser.steps.some(step => step.run === 'test "$SHARD_RESULT" = "success"'));
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

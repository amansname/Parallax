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
  assert.deepEqual(Object.keys(config.jobs).sort(), ['artifact', 'browser', 'lint', 'unit']);
  assert.equal(config.jobs.lint.name, 'ESLint');
  assert.equal(config.jobs.lint.if, "github.event_name == 'pull_request'");
  assert.equal(config.jobs.lint.env.PARALLAX_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  const lintCheckout = config.jobs.lint.steps.find(step => String(step.uses).startsWith('actions/checkout@'));
  assert.equal(lintCheckout.with['fetch-depth'], 0);
  assert.match(source, /run: npm run lint:changed/);
  assert.doesNotMatch(source, /npm run governance:(?:check|pr)/);
  assert.doesNotMatch(source, /validate-pr-authorship\.mjs/);
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

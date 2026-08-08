import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePullRequestBody, validatePullRequestEvent } from './validate-pr-body.mjs';

const headings = [
  'Problem and user-visible impact',
  'Exact reproduction',
  'Root cause',
  'Acceptance matrix',
  'Production code changed',
  'Tests added or changed',
  'Fail-before evidence',
  'Pass-after evidence',
  'Persisted-state and migration impact',
  'Financial invariants checked',
  'Exact commands and results',
  'Required CI status',
  'Known failures and proof gaps',
  'Scope exclusions',
  'Independent review status',
  'Rollback considerations',
  'Truthful completion gate',
];

function validBody(){
  return headings.map(heading => {
    if(heading === 'Exact reproduction'){
      return `## ${heading}\nBase: 1111111111111111111111111111111111111111\nBranch: 2222222222222222222222222222222222222222`;
    }
    if(heading === 'Acceptance matrix'){
      return `## ${heading}\n| Reported symptom | Exact reproduction | Pre-fix failure | Production change | Regression assertion | Post-fix proof |\n|---|---|---|---|---|---|\n| Governance gap | Base inspection | Missing guard | Validator | Reject missing evidence | Validator accepts full evidence |`;
    }
    if(heading === 'Exact commands and results'){
      return `## ${heading}\nnpm run governance:check — exit 0\nnpm test — 662 passed\nnpm run verify — exact blocker recorded\ngit diff --check — exit 0`;
    }
    if(heading === 'Truthful completion gate'){
      return `## ${heading}\n- [x] Every behavior described as fixed was reproduced on the base branch and directly verified on this branch.`;
    }
    return `## ${heading}\nRecorded evidence`;
  }).join('\n\n');
}

test('accepts a PR body with all required evidence fields', () => {
  assert.deepEqual(validatePullRequestBody(validBody()), []);
});

test('rejects an unchecked gate, placeholder commands, and blank acceptance row', () => {
  const invalid = validBody()
    .replace('- [x] Every behavior', '- [ ] Every behavior')
    .replace('— exit 0', '# actual result')
    .replace('| Governance gap | Base inspection | Missing guard | Validator | Reject missing evidence | Validator accepts full evidence |', '| | | | | | |');
  const failures = validatePullRequestBody(invalid).join('\n');
  assert.match(failures, /completion checkbox/);
  assert.match(failures, /template placeholder/);
  assert.match(failures, /fully populated/);
});

test('skips non-pull-request event payloads', () => {
  assert.deepEqual(validatePullRequestEvent({ ref: 'refs/heads/main' }), {
    skipped: true,
    failures: [],
  });
});

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

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';

function validBody({ baseSha = BASE_SHA, headSha = HEAD_SHA } = {}){
  return headings.map(heading => {
    if(heading === 'Exact reproduction'){
      return `## ${heading}\n- Base commit SHA: ${baseSha}\n- Branch commit SHA: ${headSha}`;
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

function validEvent(body = validBody()){
  return {
    action: 'edited',
    pull_request: {
      body,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    },
  };
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

test('rejects stale evidence that does not name the event base and head SHAs', () => {
  const historicalBody = validBody({
    baseSha: '3333333333333333333333333333333333333333',
    headSha: '4444444444444444444444444444444444444444',
  });
  const failures = validatePullRequestEvent(validEvent(historicalBody)).failures.join('\n');
  assert.match(failures, /current base SHA/);
  assert.match(failures, /current head SHA/);
});

test('rejects required headings hidden in H3, HTML comments, or fenced examples', () => {
  const spoofedBodies = [
    validBody().replace(/^## /gm, '### '),
    `<!--\n${validBody()}\n-->`,
    `\`\`\`markdown\n${validBody()}\n\`\`\``,
  ];

  for(const body of spoofedBodies){
    const failures = validatePullRequestEvent(validEvent(body)).failures.join('\n');
    assert.match(failures, /missing required PR section/);
  }
});

test('rejects a completion gate hidden in an HTML comment or fenced example', () => {
  const checkedGate = '- [x] Every behavior described as fixed was reproduced on the base branch and directly verified on this branch.';
  const uncheckedBody = validBody().replace('- [x] Every behavior', '- [ ] Every behavior');
  const spoofedBodies = [
    `${uncheckedBody}\n\n<!-- ${checkedGate} -->`,
    `${uncheckedBody}\n\n\`\`\`markdown\n${checkedGate}\n\`\`\``,
  ];

  for(const body of spoofedBodies){
    const failures = validatePullRequestEvent(validEvent(body)).failures.join('\n');
    assert.match(failures, /completion checkbox/);
  }
});

test('rejects an acceptance row hidden in a fenced example', () => {
  const acceptanceRow = '| Governance gap | Base inspection | Missing guard | Validator | Reject missing evidence | Validator accepts full evidence |';
  const spoofedBody = validBody().replace(
    acceptanceRow,
    `\`\`\`markdown\n${acceptanceRow}\n\`\`\``,
  );
  const failures = validatePullRequestEvent(validEvent(spoofedBody)).failures.join('\n');
  assert.match(failures, /fully populated/);
});

test('rejects completion and acceptance evidence hidden in indented code', () => {
  const acceptanceRow = '| Governance gap | Base inspection | Missing guard | Validator | Reject missing evidence | Validator accepts full evidence |';
  const checkedGate = '- [x] Every behavior described as fixed was reproduced on the base branch and directly verified on this branch.';
  const spoofedBody = validBody()
    .replace(acceptanceRow, `    ${acceptanceRow}`)
    .replace(checkedGate, `- [ ] Every behavior described as fixed was reproduced on the base branch and directly verified on this branch.\n\n    ${checkedGate}`);
  const failures = validatePullRequestEvent(validEvent(spoofedBody)).failures.join('\n');
  assert.match(failures, /fully populated/);
  assert.match(failures, /completion checkbox/);
});

test('rejects required evidence wrapped in an HTML pre block', () => {
  const failures = validatePullRequestEvent(validEvent(`<pre>\n${validBody()}\n</pre>`)).failures.join('\n');
  assert.match(failures, /raw HTML block/);
});

test('rejects required evidence wrapped in other raw HTML blocks', () => {
  for(const tag of ['textarea', 'script', 'style']){
    const failures = validatePullRequestEvent(validEvent(`<${tag}>\n${validBody()}\n</${tag}>`)).failures.join('\n');
    assert.match(failures, /raw HTML block/);
  }
});

test('rejects the unit-test counts placeholder from the PR template', () => {
  const placeholderBody = validBody().replace(
    'npm test',
    'npm test # actual counts and result\n',
  );
  const failures = validatePullRequestEvent(validEvent(placeholderBody)).failures.join('\n');
  assert.match(failures, /template placeholder/);
});

test('rejects required evidence hidden in a list-contained fenced block', () => {
  const hiddenBody = validBody().split('\n').map(line => `  ${line}`).join('\n');
  const spoofedBody = `- \`\`\`markdown\n${hiddenBody}\n  \`\`\``;
  const failures = validatePullRequestEvent(validEvent(spoofedBody)).failures.join('\n');
  assert.match(failures, /missing required PR section/);
});

test('rejects a pipe-delimited row that is not a rendered GFM table', () => {
  const table = '| Reported symptom | Exact reproduction | Pre-fix failure | Production change | Regression assertion | Post-fix proof |\n|---|---|---|---|---|---|\n| Governance gap | Base inspection | Missing guard | Validator | Reject missing evidence | Validator accepts full evidence |';
  const rowOnly = '| Governance gap | Base inspection | Missing guard | Validator | Reject missing evidence | Validator accepts full evidence |';
  const failures = validatePullRequestEvent(validEvent(validBody().replace(table, rowOnly))).failures.join('\n');
  assert.match(failures, /fully populated/);
});

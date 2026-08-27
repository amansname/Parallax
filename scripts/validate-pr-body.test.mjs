import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validatePullRequestBody, validatePullRequestEvent } from './validate-pr-body.mjs';

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const COMPLETION = 'Every scoped behavior meets its done-when evidence on this candidate, and every required check and review is satisfied.';
const PULL_REQUEST_TEMPLATE = readFileSync(
  new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url),
  'utf8',
);
const EVIDENCE_TABLE = `| Done-when criterion | Baseline or pre-fix evidence | Production change | Verification | Candidate result |
|---|---|---|---|---|
| Governance policy is risk-scaled | Existing workflow has fourteen stages | Canonical workflow and validator | Governance tests | Five phases and three tiers validated |`;

function validBody({
  baseSha = BASE_SHA,
  headSha = HEAD_SHA,
  riskTier = 'Tier 3',
  workType = 'defect',
  lifecycle = 'Merge-ready',
  hold = 'None',
  bareCommands = false,
} = {}){
  const commandResult = command => bareCommands ? command : `${command} — exit 0`;
  const sections = [
    `## Workflow classification
- Risk tier: ${riskTier}
- Risk rationale: Governance and workflow behavior
- Work type: ${workType}
- Lifecycle: ${lifecycle}
- Hold: ${hold}`,
    `## Outcome and scope
The workflow scales evidence while preserving required GitHub gates.`,
    `## Candidate identity
- Base commit SHA: ${baseSha}
- Candidate head SHA: ${headSha}`,
    `## Acceptance evidence
${EVIDENCE_TABLE}`,
  ];

  if(workType === 'defect'){
    sections.push(`## Defect reproduction and root cause
- Exact reproduction: Submit the previous template for a governance-only change.
- Base failure evidence: The base validator rejects that body for defect-only evidence.
- Root cause: The previous template made defect fields unconditional.
- Fail-before regression evidence: The focused test fails against the base implementation.
- Pass-after candidate evidence: The focused test passes on the candidate.`);
  }

  sections.push(
    `## Implementation and authority
Repository governance files implement the approved policy.`,
    `## Tests and verification
Focused governance validation passed.

${commandResult('npm run governance:check')}
${riskTier === 'Tier 1' ? 'npm test — required CI' : commandResult('npm test')}
${riskTier === 'Tier 1' ? 'npm run verify — required CI' : commandResult('npm run verify')}
${commandResult('git diff --check')}`,
  );

  if(riskTier === 'Tier 3'){
    sections.push(`## Protected policy and compatibility evidence
Required GitHub checks remain invariant and the existing deployment director is unchanged.`);
  }

  sections.push(
    `## Required CI status
- [x] Governance safeguards
- [x] Unit tests
- [x] Build deployable site artifact
- [x] Full browser verification`,
    `## Independent review
Separate review against main found no blocking issue.`,
    `## Known failures and proof gaps
None recorded.`,
    `## Rollback and deployment
- Rollback considerations: Revert this governance-only PR.
- Saved-data risk: None - repository governance only.
- Deployment impact: None - automatic Pages remains unchanged.
- Planned live proof: Not applicable - no product behavior changes.
- Post-merge identity chain: Candidate to squash merge to Pages artifact receipt.`,
    `## Truthful completion gate
- [x] ${COMPLETION}`,
  );

  return sections.join('\n\n');
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

test('accepts a Tier 3 defect body with protected and defect evidence', () => {
  assert.deepEqual(validatePullRequestBody(validBody()), []);
});

test('accepts a compact Tier 1 docs body with focused local commands', () => {
  assert.deepEqual(validatePullRequestBody(validBody({
    riskTier: 'Tier 1',
    workType: 'docs',
  })), []);
});

test('accepts Draft-ready with pending CI and an unchecked completion gate', () => {
  const body = validBody({ lifecycle: 'Draft-ready', hold: 'CI' })
    .replace(/- \[x\] (Governance safeguards|Unit tests|Build deployable site artifact|Full browser verification)/g, '- [ ] $1')
    .replace(`- [x] ${COMPLETION}`, `- [ ] ${COMPLETION}`);
  assert.deepEqual(validatePullRequestBody(body), []);
});

test('accepts the actual template completion task and ignores adjacent or trailing guidance comments', () => {
  const templateCompletion = PULL_REQUEST_TEMPLATE.slice(
    PULL_REQUEST_TEMPLATE.indexOf('## Truthful completion gate'),
  ).replace(`- [ ] ${COMPLETION}`, `- [x] ${COMPLETION}`);
  const actualTemplateBody = validBody().replace(
    /## Truthful completion gate[\s\S]*$/,
    templateCompletion,
  );
  assert.deepEqual(validatePullRequestBody(actualTemplateBody), []);

  const trailingCommentBody = validBody().replace(
    `- [x] ${COMPLETION}`,
    `- [x] ${COMPLETION} <!-- Check only for Merge-ready. -->`,
  );
  assert.deepEqual(validatePullRequestBody(trailingCommentBody), []);
});

test('requires Tier 3 for governance work', () => {
  const failures = validatePullRequestBody(validBody({
    riskTier: 'Tier 1',
    workType: 'governance',
  })).join('\n');
  assert.match(failures, /governance requires Risk tier: Tier 3/);
});

test('requires the full local command set for Tier 2 and Tier 3', () => {
  const body = validBody({ riskTier: 'Tier 2', workType: 'feature' })
    .replace('npm run verify — exit 0', 'npm run verify — required CI');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /concrete result for: npm run verify/);
});

test('requires protected evidence for Tier 3', () => {
  const body = validBody().replace(
    /\n\n## Protected policy and compatibility evidence\n[^#]+/,
    '',
  );
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /missing required PR section for Tier 3/);
});

test('requires reproduction and root cause for defects', () => {
  const body = validBody().replace(
    /\n\n## Defect reproduction and root cause\n[^#]+/,
    '',
  );
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /missing required PR section for work type defect/);
});

test('requires explicit fail-before and pass-after defect evidence', () => {
  for(const label of [
    'Exact reproduction',
    'Base failure evidence',
    'Root cause',
    'Fail-before regression evidence',
    'Pass-after candidate evidence',
  ]){
    const body = validBody().replace(
      new RegExp(`- ${label}:.*`),
      `- ${label}: <!-- missing -->`,
    );
    assert.match(
      validatePullRequestBody(body).join('\n'),
      new RegExp(`must provide ${label}`),
    );
  }
});

test('requires substantive rollback and deployment field values', () => {
  for(const label of [
    'Rollback considerations',
    'Saved-data risk',
    'Deployment impact',
    'Planned live proof',
    'Post-merge identity chain',
  ]){
    const body = validBody().replace(
      new RegExp(`- ${label}:.*`),
      `- ${label}: <!-- missing -->`,
    );
    assert.match(
      validatePullRequestBody(body).join('\n'),
      new RegExp(`must provide ${label}`),
    );
  }
});

test('rejects invalid tier, work type, lifecycle, and hold values', () => {
  const body = validBody()
    .replace('Risk tier: Tier 3', 'Risk tier: Tiny')
    .replace('Work type: defect', 'Work type: cleanup')
    .replace('Lifecycle: Merge-ready', 'Lifecycle: Done')
    .replace('Hold: None', 'Hold: Maybe');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /Risk tier/);
  assert.match(failures, /Work type/);
  assert.match(failures, /Lifecycle/);
  assert.match(failures, /Hold/);
});

test('rejects stale evidence that does not name current event SHAs', () => {
  const historicalBody = validBody({
    baseSha: '3333333333333333333333333333333333333333',
    headSha: '4444444444444444444444444444444444444444',
  });
  const failures = validatePullRequestEvent(validEvent(historicalBody)).failures.join('\n');
  assert.match(failures, /current base SHA/);
  assert.match(failures, /current head SHA/);
});

test('requires checked CI and completion evidence for Merge-ready', () => {
  const failures = validatePullRequestBody(
    validBody()
      .replace('- [x] Build deployable site artifact', '- [ ] Build deployable site artifact')
      .replace(`- [x] ${COMPLETION}`, `- [ ] ${COMPLETION}`),
  ).join('\n');
  assert.match(failures, /checked CI status: Build deployable site artifact/);
  assert.match(failures, /completion checkbox must be checked/);
});

test('rejects a checked completion claim for Draft-ready', () => {
  const failures = validatePullRequestBody(validBody({
    lifecycle: 'Draft-ready',
    hold: 'Review',
  })).join('\n');
  assert.match(failures, /must remain unchecked/);
});

test('rejects required commands without concrete results', () => {
  const failures = validatePullRequestBody(validBody({ bareCommands: true })).join('\n');
  for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
    assert.ok(failures.includes(`must record a concrete result for: ${command}`));
  }
});

test('rejects a blank acceptance row', () => {
  const body = validBody().replace(
    '| Governance policy is risk-scaled | Existing workflow has fourteen stages | Canonical workflow and validator | Governance tests | Five phases and three tiers validated |',
    '| | | | | |',
  );
  assert.match(validatePullRequestBody(body).join('\n'), /fully populated five-column/);
});

test('rejects required headings hidden in H3, comments, or fenced examples', () => {
  for(const body of [
    validBody().replace(/^## /gm, '### '),
    `<!--\n${validBody()}\n-->`,
    `\`\`\`markdown\n${validBody()}\n\`\`\``,
  ]){
    assert.match(validatePullRequestBody(body).join('\n'), /missing required PR section/);
  }
});

test('rejects raw HTML evidence wrappers', () => {
  for(const tag of ['pre', 'textarea', 'script', 'style']){
    const failures = validatePullRequestBody(`<${tag}>\n${validBody()}\n</${tag}>`).join('\n');
    assert.match(failures, /raw HTML block/);
  }
});

test('rejects visually blank acceptance evidence', () => {
  const evidenceRow = '| Governance policy is risk-scaled | Existing workflow has fourteen stages | Canonical workflow and validator | Governance tests | Five phases and three tiers validated |';
  for(const invisible of ['&#x200B;', '&#x2800;', '&#x3164;', '&#xFFA0;', '&#x13441;']){
    const row = `| ${invisible} | ${invisible} | ${invisible} | ${invisible} | ${invisible} |`;
    assert.match(validatePullRequestBody(validBody().replace(evidenceRow, row)).join('\n'), /fully populated/);
  }
});

test('rejects image alt text as acceptance or command evidence', () => {
  const image = '![Recorded evidence](https://example.com/transparent.gif)';
  const evidenceRow = '| Governance policy is risk-scaled | Existing workflow has fourteen stages | Canonical workflow and validator | Governance tests | Five phases and three tiers validated |';
  const imageRow = `| ${image} | ${image} | ${image} | ${image} | ${image} |`;
  let body = validBody({ bareCommands: true }).replace(evidenceRow, imageRow);
  for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
    body = body.replace(command, `${command} ${image}`);
  }
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /fully populated/);
  for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
    assert.ok(failures.includes(`must record a concrete result for: ${command}`));
  }
});

test('skips non-pull-request event payloads', () => {
  assert.deepEqual(validatePullRequestEvent({ ref: 'refs/heads/main' }), {
    skipped: true,
    failures: [],
  });
});

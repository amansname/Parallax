import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCandidateCommitRecords } from './validate-pr-authorship.mjs';
import { validatePullRequestBody, validatePullRequestEvent } from './validate-pr-body.mjs';

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';

const acceptanceHeader = '| Original request or reported symptom | Disposition | Base or starting-state proof | Production change | Regression assertion | Candidate proof |';
const acceptanceDivider = '|---|---|---|---|---|---|';
const acceptanceRow = '| Cash Flow omits gross RMD | Fixed | Base renders zero | Read `rmdRequired` | Exact visible RMD, Draw, and Tax | Candidate renders all three |';

function validBody({
  baseSha = BASE_SHA,
  headSha = HEAD_SHA,
  changeType = 'Defect',
  riskTier = 'Tier 3 - Protected',
  uiChanged = 'Yes',
  acceptanceRows = [acceptanceRow],
  bareCommands = false,
} = {}){
  const defectEvidence = changeType === 'Defect'
    ? '- Exact reproduction: Open Cash Flow with the recorded fixture and observe a blank RMD.\n- Root cause: The view maps the additional top-up field.\n- Fail-before: Base assertion expects 30000 and receives 0.\n- Pass-after: Candidate renders 30000 while Draw and Tax remain exact.'
    : 'Not a defect — the starting state and requested outcome are recorded in the acceptance ledger.';
  const visibleUi = uiChanged === 'Yes'
    ? '- Visible UI changed: Yes\n- Exact visible inventory: RMD, Tax, and Draw cells in their existing order.\n- Explicitly absent or unchanged: No new rows, controls, labels, or typography.\n- Canonical visual reference and viewports: Existing Cash Flow row at desktop and mobile governed viewports.\n- Rendered or browser proof: Immutable browser artifact asserts the exact cells and computed presentation.'
    : '- Visible UI changed: No\n- Reason: Governance-only behavior with no rendered product output.';
  const protectedEvidence = riskTier.startsWith('Tier 3')
    ? 'The UI reads the engine-owned RMD field; Projection Engine and Tax Engine outputs remain unchanged.'
    : 'Not applicable — no protected contract changes at this tier.';
  const commands = bareCommands
    ? 'npm run governance:check\nnpm run lint:changed\nnpm test\nnpm run verify\ngit diff --check'
    : 'npm run governance:check — 51 tests passed\nnpm run lint:changed — exit code 0; changed JavaScript passed\nnpm test — 860 tests passed\nnpm run verify — passed\ngit diff --check — exit 0';

  return `## Scope and risk
- Change type: ${changeType}
- Risk tier: ${riskTier}
- Base commit SHA: ${baseSha}
- Branch commit SHA: ${headSha}
- Original request: Display gross required RMD without changing Draw or Tax.
- Outcome: Cash Flow displays the authoritative gross RMD.
- Included: One display mapping and its evidence.
- Non-goals: No engine, tax, persistence, or layout change.
- Authority and protected boundaries: Cash Flow display; engine and tax outputs are protected.

## Acceptance ledger
${acceptanceHeader}
${acceptanceDivider}
${acceptanceRows.join('\n')}

## Defect evidence
${defectEvidence}

## Changes and tests
- Production files: ui/cashflow.js maps the authoritative field.
- Tests and fixtures: Focused unit and immutable browser assertions cover exact output.

## Visible UI contract
${visibleUi}

## Protected-contract evidence
${protectedEvidence}

## Verification
${commands}

## Delivery status
- [x] Governance safeguards
- [x] ESLint
- [x] Unit tests
- [x] Build deployable site artifact
- [x] Full browser verification
- Known failures and proof gaps: None on the frozen candidate.
- Review method: Human review on the exact candidate.
- Reviewer/result link: https://github.com/example/review
- Review status: Approved with no findings.
- Lifecycle: Merge-ready
- Hold: Owner decision

## Rollback considerations
Revert the candidate commit; no saved-data rollback is required.

## Truthful completion gate
- [x] Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped.
- [x] The visible UI contract names the exact allowed result and explicitly absent or unchanged behavior.
- [x] The evidence and status describe the current base and candidate, with no stale completion claim.`;
}

function validEvent(body = validBody()){
  return {
    action: 'edited',
    pull_request: {
      body,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
      user: { login: 'parallax-pr-author-amans[bot]' },
      requested_reviewers: [{ login: 'amansname' }],
      state: 'open',
      merged: false,
    },
  };
}

test('accepts a complete risk-scaled PR receipt', () => {
  assert.deepEqual(validatePullRequestBody(validBody()), []);
});

test('accepts a non-defect, non-visual Tier 1 receipt without forensic filler', () => {
  const body = validBody({
    changeType: 'Documentation',
    riskTier: 'Tier 1 - Fast',
    uiChanged: 'No',
    acceptanceRows: [
      '| Explain the workflow in plain language | Delivered | Existing guide is long | Condense the guide | Governance check preserves required rules | Candidate guide is concise |',
    ],
  });
  assert.deepEqual(validatePullRequestBody(body), []);
});

test('accepts an honest draft receipt while CI and review are pending', () => {
  const body = validBody()
    .replace(/- \[x\] (Governance safeguards|ESLint|Unit tests|Build deployable site artifact|Full browser verification)/g, '- [ ] $1')
    .replace('- Reviewer/result link: https://github.com/example/review', '- Reviewer/result link: Pending publication')
    .replace('- Review status: Approved with no findings.', '- Review status: Pending independent review.')
    .replace('- Lifecycle: Merge-ready', '- Lifecycle: Draft-ready')
    .replace('- Hold: Owner decision', '- Hold: CI and review');
  assert.deepEqual(validatePullRequestBody(body), []);
});

test('rejects a PR 233-style scope shift that leaves an original symptom unaccounted for', () => {
  const body = validBody().replace(
    acceptanceRow,
    '| Cash Flow omits gross RMD | Fixed | Base renders zero | Read `rmdRequired` | Exact visible RMD, Draw, and Tax | Candidate renders all three |\n| Withdrawal Planner Parker failure | Investigating | Original visible failure | None | None | None |',
  );
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /Disposition must be Fixed, Delivered, Deferred, or Separately scoped/);
});

test('rejects a PR 234-style subset proof that omits exact visible inventory and negative scope', () => {
  const body = validBody()
    .replace('- Exact visible inventory: RMD, Tax, and Draw cells in their existing order.\n', '')
    .replace('- Explicitly absent or unchanged: No new rows, controls, labels, or typography.\n', '');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /Exact visible inventory/);
  assert.match(failures, /Explicitly absent or unchanged/);
});

test('rejects a required-CI receipt that omits the deployable artifact job', () => {
  const body = validBody().replace('- [x] Build deployable site artifact\n', '');
  assert.match(validatePullRequestBody(body).join('\n'), /Build deployable site artifact/);
});

test('rejects a required-CI receipt that omits the ESLint job', () => {
  const body = validBody().replace('- [x] ESLint\n', '');
  assert.match(validatePullRequestBody(body).join('\n'), /ESLint/);
});

test('rejects stale identity, unchecked authorship gates, and command placeholders', () => {
  const body = validBody({ bareCommands: true })
    .replace(`- Base commit SHA: ${BASE_SHA}`, '- Base commit SHA: 3333333333333333333333333333333333333333')
    .replace('- [x] Every original request', '- [ ] Every original request');
  const failures = validatePullRequestEvent(validEvent(body)).failures.join('\n');
  assert.match(failures, /current base SHA/);
  assert.match(failures, /concrete result/);
  assert.match(failures, /truthful completion checkbox/);
});

test('accepts the renamed owner on a bot-authored PR', () => {
  assert.deepEqual(validatePullRequestEvent(validEvent()).failures, []);
});

test('rejects the retired username and unrelated accounts as owner review evidence', () => {
  for(const login of ['t66wwpvthy-prog', 'another-reviewer', 'parallax-pr-author-amans[bot]']){
    const event = validEvent();
    event.pull_request.requested_reviewers = [{ login }];
    assert.match(validatePullRequestEvent(event).failures.join('\n'),
      /must request or have a completed exact-head review by amansname/, login);

    event.pull_request.requested_reviewers = [];
    assert.match(validatePullRequestEvent(event, {
      completedReviews: [{ user: { login }, state: 'APPROVED', commit_id: HEAD_SHA }],
    }).failures.join('\n'), /must request or have a completed exact-head review by amansname/, login);
  }
});

test('rejects a human-authored PR so the owner remains the independent reviewer', () => {
  const event = validEvent();
  event.pull_request.user.login = 'amansname';
  assert.match(validatePullRequestEvent(event).failures.join('\n'), /must be authored by parallax-pr-author-amans\[bot\]/);
});

test('rejects a PR without the human owner requested or completed on the exact head', () => {
  const missingReviewer = validEvent();
  missingReviewer.pull_request.requested_reviewers = [];
  assert.match(validatePullRequestEvent(missingReviewer).failures.join('\n'), /must request or have a completed exact-head review by amansname/);

  const wrongReviewer = validEvent();
  wrongReviewer.pull_request.requested_reviewers = [{ login: 'parallax-pr-author-amans[bot]' }];
  assert.match(validatePullRequestEvent(wrongReviewer).failures.join('\n'), /must request or have a completed exact-head review by amansname/);
});

test('accepts only a current, completed owner review after the request clears', () => {
  const event = validEvent();
  event.pull_request.requested_reviewers = [];
  const currentApproval = {
    user: { login: 'amansname' },
    state: 'APPROVED',
    commit_id: HEAD_SHA,
  };
  assert.deepEqual(validatePullRequestEvent(event, { completedReviews: [currentApproval] }).failures, []);
  assert.match(validatePullRequestEvent(event, {
    completedReviews: [{ ...currentApproval, commit_id: BASE_SHA }],
  }).failures.join('\n'), /completed exact-head review/);
  assert.match(validatePullRequestEvent(event, {
    completedReviews: [{ ...currentApproval, state: 'DISMISSED' }],
  }).failures.join('\n'), /completed exact-head review/);
  assert.match(validatePullRequestEvent(event, {
    completedReviews: [{ ...currentApproval, state: 'PENDING' }],
  }).failures.join('\n'), /completed exact-head review/);
});

test('rejects a human-authored or human-committed candidate commit', () => {
  const botRecord = {
    sha: HEAD_SHA,
    authorName: 'parallax-pr-author-amans[bot]',
    authorEmail: '315909848+parallax-pr-author-amans[bot]@users.noreply.github.com',
    committerName: 'parallax-pr-author-amans[bot]',
    committerEmail: '315909848+parallax-pr-author-amans[bot]@users.noreply.github.com',
  };
  assert.deepEqual(validateCandidateCommitRecords([botRecord]), []);
  assert.match(validateCandidateCommitRecords([
    { ...botRecord, authorName: 'amansname', authorEmail: 'human@example.com' },
  ]).join('\n'), /must use the Parallax bot as Git author/);
  assert.match(validateCandidateCommitRecords([
    { ...botRecord, committerName: 'GitHub', committerEmail: 'noreply@github.com' },
  ]).join('\n'), /must use the Parallax bot as Git committer/);
});

test('rejects a Tier 3 receipt without protected-contract evidence', () => {
  const body = validBody().replace(
    'The UI reads the engine-owned RMD field; Projection Engine and Tax Engine outputs remain unchanged.',
    'Not applicable — no protected contract changes at this tier.',
  );
  assert.match(validatePullRequestBody(body).join('\n'), /Tier 3 requires substantive protected-contract evidence/);
});

test('rejects unknown change types and risk tiers', () => {
  const body = validBody()
    .replace('- Change type: Defect', '- Change type: Cleanup')
    .replace('- Risk tier: Tier 3 - Protected', '- Risk tier: Tier 4 - Emergency');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /Change type must be/);
  assert.match(failures, /Risk tier must be/);
});

test('rejects Merge-ready while CI or independent review is pending', () => {
  const body = validBody()
    .replace('- [x] Full browser verification', '- [ ] Full browser verification')
    .replace('- Review status: Approved with no findings.', '- Review status: Pending independent review.');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /Merge-ready requires all five required CI/);
  assert.match(failures, /exact positive completed independent-review status/);
});

test('rejects failed or unrun Tier 2 and Tier 3 local verification for Merge-ready', () => {
  const body = validBody()
    .replace('npm test — 860 tests passed', 'npm test — failed')
    .replace('npm run verify — passed', 'npm run verify — not run');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /successful local verification for: npm test/);
  assert.match(failures, /successful local verification for: npm run verify/);
});

test('rejects negated and mixed-failure verification wording for Merge-ready', () => {
  const body = validBody()
    .replace('npm test — 860 tests passed', 'npm test — 860 tests passed with 1 failure')
    .replace('npm run verify — passed', 'npm run verify — not passed');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /successful local verification for: npm test/);
  assert.match(failures, /successful local verification for: npm run verify/);
});

test('allows narrow Tier 1 local exceptions while required GitHub jobs remain checked', () => {
  const body = validBody({
    changeType: 'Documentation',
    riskTier: 'Tier 1 - Fast',
    uiChanged: 'No',
  })
    .replace('npm test — 860 tests passed', 'npm test — not run locally; Tier 1 docs-only change')
    .replace('npm run verify — passed', 'npm run verify — not run locally; Tier 1 docs-only change');
  assert.deepEqual(validatePullRequestBody(body), []);
});

test('rejects unrecognized lifecycle values and failed independent review', () => {
  const body = validBody()
    .replace('- Lifecycle: Merge-ready', '- Lifecycle: Ready')
    .replace('- Review status: Approved with no findings.', '- Review status: Failed independent review.');
  const failures = validatePullRequestBody(body).join('\n');
  assert.match(failures, /Lifecycle must be Scoped/);

  const failedReview = body.replace('- Lifecycle: Ready', '- Lifecycle: Merge-ready');
  assert.match(validatePullRequestBody(failedReview).join('\n'), /exact positive completed independent-review status/);
});

test('rejects post-merge lifecycle claims on an open pull request', () => {
  const body = validBody()
    .replace('- Lifecycle: Merge-ready', '- Lifecycle: Merged')
    .replace('- [x] Full browser verification', '- [ ] Full browser verification')
    .replace('- Review status: Approved with no findings.', '- Review status: Pending independent review.');
  const bodyFailures = validatePullRequestBody(body).join('\n');
  assert.match(bodyFailures, /Merged requires all five required CI/);
  assert.match(bodyFailures, /exact positive completed independent-review status/);

  const eventFailures = validatePullRequestEvent(validEvent(body)).failures.join('\n');
  assert.match(eventFailures, /open pull request cannot claim Merged or Production-confirmed/);
  assert.match(eventFailures, /Merged lifecycle requires a merged pull request event/);
});

test('rejects negated approval wording for Merge-ready', () => {
  const body = validBody().replace(
    '- Review status: Approved with no findings.',
    '- Review status: Not approved.',
  );
  assert.match(
    validatePullRequestBody(body).join('\n'),
    /exact positive completed independent-review status/,
  );
});

test('rejects every partially populated acceptance row', () => {
  const body = validBody({
    acceptanceRows: [
      acceptanceRow,
      '| Withdrawal Planner still fails for Parker | | | | | |',
    ],
  });
  assert.match(
    validatePullRequestBody(body).join('\n'),
    /Every nonempty Acceptance ledger row must populate all six evidence columns/,
  );
});

test('rejects a non-visual receipt without its reason', () => {
  const body = validBody({
    changeType: 'Governance',
    uiChanged: 'No',
  }).replace('- Reason: Governance-only behavior with no rendered product output.\n', '');
  assert.match(validatePullRequestBody(body).join('\n'), /Reason/);
});

test('rejects defect receipts without exact reproduction, root cause, fail-before, or pass-after evidence', () => {
  for(const label of ['Exact reproduction', 'Root cause', 'Fail-before', 'Pass-after']){
    const body = validBody().replace(new RegExp(`^- ${label}:.*$`, 'm'), '');
    assert.ok(validatePullRequestBody(body).some(failure => failure.includes(label)));
  }
});

test('rejects required headings or completion evidence hidden from rendered Markdown', () => {
  const spoofedBodies = [
    validBody().replace(/^## /gm, '### '),
    `<!--\n${validBody()}\n-->`,
    `\`\`\`markdown\n${validBody()}\n\`\`\``,
  ];
  for(const body of spoofedBodies){
    assert.match(validatePullRequestEvent(validEvent(body)).failures.join('\n'), /missing required PR section/);
  }

  const unchecked = validBody().replace(/- \[x\] Every original request/, '- [ ] Every original request');
  const hidden = `${unchecked}\n\n<!-- - [x] Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped. -->`;
  assert.match(validatePullRequestBody(hidden).join('\n'), /truthful completion checkbox/);
});

test('rejects acceptance and completion evidence hidden in fenced or indented code', () => {
  const fencedLedger = validBody().replace(acceptanceRow, `\`\`\`markdown\n${acceptanceRow}\n\`\`\``);
  assert.match(validatePullRequestBody(fencedLedger).join('\n'), /fully populated/);

  const completion = '- [x] Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped.';
  const indented = validBody()
    .replace(acceptanceRow, `    ${acceptanceRow}`)
    .replace(completion, `- [ ] Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped.\n\n    ${completion}`);
  const failures = validatePullRequestBody(indented).join('\n');
  assert.match(failures, /fully populated/);
  assert.match(failures, /truthful completion checkbox/);
});

test('rejects evidence wrapped in raw HTML blocks', () => {
  for(const tag of ['pre', 'textarea', 'script', 'style']){
    const failures = validatePullRequestBody(`<${tag}>\n${validBody()}\n</${tag}>`).join('\n');
    assert.match(failures, /raw HTML block/);
  }
});

test('rejects a list-contained fenced body and a pipe row that is not a GFM table', () => {
  const hiddenBody = validBody().split('\n').map(line => `  ${line}`).join('\n');
  const fencedBody = `- \`\`\`markdown\n${hiddenBody}\n  \`\`\``;
  assert.match(validatePullRequestBody(fencedBody).join('\n'), /missing required PR section/);

  const table = `${acceptanceHeader}\n${acceptanceDivider}\n${acceptanceRow}`;
  assert.match(validatePullRequestBody(validBody().replace(table, acceptanceRow)).join('\n'), /required six-column header/);
});

test('rejects blank or invisible evidence in the acceptance ledger', () => {
  for(const value of [
    '<!-- omitted -->',
    '&#x200B;',
    '&ZeroWidthSpace;',
    '\u034f',
    '&#x034F;',
    '\u2800',
    '&#x2800;',
    '\u3164',
    '\uffa0',
    '\u{13441}',
    '\u{13442}',
  ]){
    const row = `| ${value} | ${value} | ${value} | ${value} | ${value} | ${value} |`;
    assert.match(validatePullRequestBody(validBody({ acceptanceRows: [row] })).join('\n'), /fully populated/);
  }
});

test('rejects default-ignorable-only section and image-only evidence', () => {
  const invisibleSection = validBody().replace(
    '## Rollback considerations\nRevert the candidate commit; no saved-data rollback is required.',
    '## Rollback considerations\n&#x034F;',
  );
  assert.match(validatePullRequestBody(invisibleSection).join('\n'), /required PR section has no evidence: Rollback considerations/);

  const image = '![Recorded evidence](https://example.com/transparent.gif)';
  const imageRow = `| ${image} | ${image} | ${image} | ${image} | ${image} | ${image} |`;
  let imageBody = validBody({ acceptanceRows: [imageRow], bareCommands: true })
    .replace('- Root cause: The view maps the additional top-up field.', `- Root cause: ${image}`);
  for(const command of ['npm run governance:check', 'npm run lint:changed', 'npm test', 'npm run verify', 'git diff --check']){
    imageBody = imageBody.replace(command, `${command} ${image}`);
  }
  const failures = validatePullRequestBody(imageBody).join('\n');
  assert.match(failures, /fully populated/);
  assert.match(failures, /Root cause/);
  assert.match(failures, /concrete result/);
});

test('rejects every required command when no concrete result is recorded', () => {
  const failures = validatePullRequestBody(validBody({ bareCommands: true })).join('\n');
  for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
    assert.ok(failures.includes(`Verification must record a concrete result for: ${command}`));
  }
});

test('skips non-pull-request event payloads', () => {
  assert.deepEqual(validatePullRequestEvent({ ref: 'refs/heads/main' }), {
    skipped: true,
    failures: [],
  });
});

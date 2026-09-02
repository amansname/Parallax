import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const failures = [];

function read(relativePath){
  const absolutePath = join(ROOT, relativePath);
  if(!existsSync(absolutePath)){
    failures.push(`missing required file: ${relativePath}`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

function requireText(relativePath, snippets){
  const content = read(relativePath);
  for(const snippet of snippets){
    if(!content.includes(snippet)){
      failures.push(`${relativePath} is missing required text: ${snippet}`);
    }
  }
  return content;
}

const agents = requireText('AGENTS.md', [
  '## Repository map and boundaries',
  '## Commands',
  '## Risk and required evidence',
  '## Definition of done and PR evidence',
  '## Code Review Rules',
  'A test-only change improves coverage; it is not a product fix.',
  'Parallax has two authoritative calculation engines.',
  '`src/planning/` connects and orchestrates those engines without creating',
  'ready facts are verified inputs to the engines;',
  'modularization must preserve behavior and result parity at the public boundary.',
  'Legacy composition root',
  'http://127.0.0.1:8825/',
]);
if(agents.split(/\r?\n/).length > 180){
  failures.push('AGENTS.md must remain concise (180 lines or fewer)');
}

requireText('PRINCIPLES.md', [
  '## Calculation Engine Truth Doctrine',
  'The **Projection Engine** owns',
  'The **Tax Engine** owns',
  'Planning connects and orchestrates the Projection Engine and Tax Engine.',
  'Household Facts carry provenance and readiness.',
  'Contractually ready facts are verified inputs',
  'unresolved required facts fail closed.',
  'The Projection Engine is one logical and public authority.',
  'public behavior and result contract remains at parity.',
]);

requireText('docs/ARCHITECTURE.md', [
  '`src/main.js` is a legacy composition root that remains larger than the target architecture; do not grow it, and extract touched logic into focused modules.',
  'Parallax has two authoritative calculation engines.',
  'Planning modules connect and orchestrate the two without',
  'contractually ready facts are verified engine inputs',
  'unresolved required facts fail closed.',
  'The Projection Engine is one logical and public authority.',
  'behavior and result parity are preserved.',
  'Do not add feature logic to `src/main.js`.',
  'Projection Engine may consume and fund authoritative Tax Engine results without implementing federal tax rule math.',
  'Withdrawal Planner',
]);

requireText('README.md', [
  'Two authoritative',
  'Household Facts with explicit provenance/readiness',
  'Ready facts',
  'Projection Engine internals may be modularized safely',
  'do not grow it, and',
  'Withdrawal Planner',
  'legacy composition root',
]);

requireText('docs/CODEX_WORKFLOW.md', [
  '## 1. Scope and route',
  '## 2. Preflight and build',
  '## 3. Verify',
  '## 4. Draft PR and review',
  '## 5. Merge, deploy, and confirm',
  '### Decision 1 - authorize delivery',
  '### Delivery-capability gate',
  '### Decision 2 - authorize the exact merge',
  '**Tier 1 - Fast**',
  '**Tier 2 - Standard**',
  '**Tier 3 - Protected**',
  '| Original request or reported symptom | Disposition | Base or starting-state proof | Production change | Regression assertion | Candidate proof |',
  'it must never silently replace the task that the owner actually assigned.',
  'Regression tests must compare',
  'the exact ordered result, not merely prove that requested elements are present.',
  '## Improve the workflow from failures',
  'A test-only PR may improve coverage but cannot close a product-behavior issue.',
  'prove only the capabilities required to reach its explicitly authorized',
  '**Apply changes** handoff for governed Parallax candidates',
  'Run one authoritative clean-candidate verifier when',
  'parallax-pr-author-amans[bot]',
  'request `amansname` as the human reviewer',
  'branch-caused required-gate failure',
  'monitor the pull-request run as authoritative',
  'The reviewer-dependent Governance safeguards gate runs only in the lightweight',
  'Requesting `amansname` emits `review_requested`',
  'use the established two-stage identity bridge instead of changing App,',
  'tree-identical empty bot-authored identity commit',
  'bounded transport exception for workflow files',
  'Moving a withdrawal lever changes the expected tax or financial column',
  'Goals Essentials plus documented overrides reconcile to Cash Flow Essentials',
  'Income and expense outputs trace to distinct engine inputs',
  '## Existing-rule mapping',
]);

requireText('docs/CODE_REVIEW.md', [
  'Review the complete branch against current `main`',
  'The authoring session cannot self-certify.',
  'parallax-pr-author-amans[bot]',
  'The initial review is read-only.',
  'Inspect important untouched files when their absence is suspicious',
  'Reject subset-only tests',
  'exact ordered DOM inventory and explicit',
  'If no findings are found, say so explicitly',
  'A failed, blocked, or findings-remaining',
]);

requireText('scripts/validate-pr-authorship.mjs', [
  'validateCandidateCommitRecords',
  'PARALLAX_BASE_SHA and PARALLAX_HEAD_SHA must be full commit SHAs',
  'must use the Parallax bot as Git author',
  'must use the Parallax bot as Git committer',
]);

requireText('scripts/validate-pr-body.mjs', [
  "const REQUIRED_PR_AUTHOR = 'parallax-pr-author-amans[bot]';",
  "const REQUIRED_PR_REVIEWER = 'amansname';",
  "const COMPLETED_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);",
  'pull request must request or have a completed exact-head review by ${REQUIRED_PR_REVIEWER}',
  'GitHub reviews API returned ${response.status}',
]);

requireText('docs/GITHUB_SETTINGS.md', [
  '`Governance safeguards`',
  '`ESLint`',
  '`Unit tests`',
  '`Build deployable site artifact`',
  '`Full browser verification`',
  '`@codex review`',
  'This document does not claim they are currently active.',
  'Build and deployment > Source',
  'GitHub Actions',
  'Verify every live byte',
  'Require exactly one approving review',
  'Disable the extra approval for changes not attributed to a user',
  '`amansname` is the',
  'select `Governance safeguards` from',
  '`Parallax PR evidence`',
]);

requireText('docs/DEPLOYMENT-INTEGRITY.md', [
  'one immutable site artifact',
  'refuses a dirty worktree',
  'browser verification downloads that same artifact',
  'GitHub Actions',
  'compares every live',
  'preserved byte-for-byte',
]);

requireText('docs/LINTING.md', [
  '`npm run lint` remains the full-repository reporting command.',
  'Every pull request also runs the required `ESLint` job.',
  '`npm run lint:changed` against the pull request merge-base range',
  'without shell interpolation.',
]);

requireText('scripts/lint-changed.mjs', [
  "'--diff-filter=ACMR'",
  "'-z'",
  "'origin/main'",
  "'node_modules', 'eslint', 'bin', 'eslint.js'",
]);

requireText('docs/templates/CODEX_BUG_FIX_PROMPT.md', [
  '## Goal',
  '## Exact reported behavior',
  '## Relevant saved fixture',
  '## Done when',
  '## Required financial invariants',
  '## Explicit exclusions',
]);

const prTemplate = requireText('.github/PULL_REQUEST_TEMPLATE.md', [
  '## Scope and risk',
  '## Acceptance ledger',
  '## Defect evidence',
  '## Changes and tests',
  '## Visible UI contract',
  '## Protected-contract evidence',
  '## Verification',
  '## Delivery status',
  '## Rollback considerations',
  '## Truthful completion gate',
  '- [ ] ESLint',
  '- [ ] Build deployable site artifact',
  '- [ ] Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped.',
  '- [ ] The visible UI contract names the exact allowed result and explicitly absent or unchanged behavior.',
  '- [ ] The evidence and status describe the current base and candidate, with no stale completion claim.',
]);
for(const completionText of [
  'Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped.',
  'The visible UI contract names the exact allowed result and explicitly absent or unchanged behavior.',
  'The evidence and status describe the current base and candidate, with no stale completion claim.',
]){
  if((prTemplate.match(new RegExp(completionText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1){
    failures.push(`.github/PULL_REQUEST_TEMPLATE.md must contain the completion checkbox exactly once: ${completionText}`);
  }
}

const packageJson = JSON.parse(read('package.json') || '{}');
const expectedScripts = {
  'governance:check': 'node --test .claude/hooks/protect-ui-scope.test.mjs scripts/validate-pr-body.test.mjs scripts/workflow-routing.test.mjs scripts/site-integrity.test.mjs && node scripts/validate-governance.mjs',
  'governance:pr': 'node scripts/validate-pr-body.mjs',
  verify: 'node scripts/verify.mjs',
  preview: 'node scripts/preview.mjs',
  'site:build': 'node scripts/build-site-artifact.mjs',
  'site:verify': 'node scripts/verify-site-artifact.mjs',
  'site:verify-live': 'node scripts/verify-live-site.mjs',
  lint: 'eslint .',
  'lint:changed': 'node scripts/lint-changed.mjs',
};
for(const [name, command] of Object.entries(expectedScripts)){
  if(packageJson.scripts?.[name] !== command){
    failures.push(`package.json script ${name} must equal: ${command}`);
  }
}
if(!packageJson.scripts?.test){
  failures.push('package.json must keep the unit-test command');
}

const workflowsDirectory = join(ROOT, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDirectory)
  .filter(name => ['.yml', '.yaml'].includes(extname(name)));
for(const name of workflowFiles){
  const relativePath = `.github/workflows/${name}`;
  const workflowSource = read(relativePath);
  const document = parseDocument(workflowSource, { prettyErrors: true });
  for(const error of document.errors){
    failures.push(`${relativePath} has invalid YAML: ${error.message}`);
  }
  if(document.contents?.type === 'SEQ'){
    failures.push(`${relativePath} must have a mapping at the document root`);
  }
  for(const match of workflowSource.matchAll(/\buses:\s*[^\s@]+@([^\s#]+)/g)){
    if(!/^[a-f0-9]{40}$/.test(match[1])){
      failures.push(`${relativePath} action must be pinned to a full commit SHA: ${match[0]}`);
    }
  }
}
if(!workflowFiles.length){
  failures.push('at least one GitHub Actions workflow is required');
}

const workflow = requireText('.github/workflows/test.yml', [
  'name: Parallax quality',
  'name: ESLint',
  'name: Unit tests',
  'run: npm run lint:changed',
  'name: Full browser verification',
  'run: npm test',
  'run: npm run verify',
  'name: Build deployable site artifact',
  'run: npm run site:build',
  'run: npm run site:verify',
  'needs: artifact',
  'PARALLAX_ARTIFACT_ROOT: .parallax-artifact',
  'PUPPETEER_EXECUTABLE_PATH: /usr/bin/google-chrome',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
]);
const workflowConfig = parseDocument(workflow).toJS();
const requiredPullRequestTypes = ['opened', 'synchronize', 'reopened'];
const configuredPullRequestTypes = workflowConfig?.on?.pull_request?.types;
if(!Array.isArray(configuredPullRequestTypes)
  || configuredPullRequestTypes.length !== requiredPullRequestTypes.length
  || requiredPullRequestTypes.some(type => !configuredPullRequestTypes.includes(type))){
  failures.push('.github/workflows/test.yml must run the full pull_request campaign only for opened, synchronize, and reopened events');
}
const configuredPushBranches = workflowConfig?.on?.push?.branches;
if(!Array.isArray(configuredPushBranches)
  || configuredPushBranches.length !== 1
  || configuredPushBranches[0] !== 'main'){
  failures.push('.github/workflows/test.yml must run push quality only on main; feature branches use the pull_request run');
}
const qualityJobs = Object.keys(workflowConfig?.jobs || {}).sort();
if(qualityJobs.length !== 4
  || ['artifact', 'browser', 'lint', 'unit'].some(job => !qualityJobs.includes(job))){
  failures.push('.github/workflows/test.yml must contain only lint, unit, artifact, and browser jobs; reviewer governance belongs to PR evidence');
}
const lintJob = workflowConfig?.jobs?.lint;
const lintCheckout = lintJob?.steps?.find(step => String(step?.uses || '').startsWith('actions/checkout@'));
if(lintJob?.name !== 'ESLint'
  || lintJob?.if !== "github.event_name == 'pull_request'"
  || lintJob?.env?.PARALLAX_BASE_SHA !== '${{ github.event.pull_request.base.sha }}'
  || lintCheckout?.with?.['fetch-depth'] !== 0
  || !lintJob?.steps?.some(step => step?.run === 'npm run lint:changed')){
  failures.push('.github/workflows/test.yml ESLint must lint the full PR merge-base range in its own pull-request job');
}
for(const forbidden of ['npm run governance:check', 'npm run governance:pr', 'validate-pr-authorship.mjs']){
  if(workflow.includes(forbidden)){
    failures.push(`the full quality campaign must not run reviewer governance from an opened-event snapshot: ${forbidden}`);
  }
}
for(const forbidden of ['continue-on-error', '|| true', '&& true']){
  if(workflow.includes(forbidden)){
    failures.push(`required workflow must not contain ${forbidden}`);
  }
}

const prEvidenceWorkflow = requireText('.github/workflows/pr-evidence.yml', [
  'name: Parallax PR evidence',
  'types: [edited, review_requested, review_request_removed, synchronize, reopened]',
  "PUPPETEER_SKIP_DOWNLOAD: 'true'",
  'name: Governance safeguards',
  'run: npm run governance:check',
  'run: npm run governance:pr',
  'name: Enforce bot-authored candidate commits',
  'fetch-depth: 0',
  'PARALLAX_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
  'PARALLAX_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
  'run: node scripts/validate-pr-authorship.mjs',
]);
const prEvidenceConfig = parseDocument(prEvidenceWorkflow).toJS();
const evidencePullRequestTypes = prEvidenceConfig?.on?.pull_request?.types;
if(!Array.isArray(evidencePullRequestTypes)
  || evidencePullRequestTypes.length !== 5
  || ['edited', 'review_requested', 'review_request_removed', 'synchronize', 'reopened']
    .some(type => !evidencePullRequestTypes.includes(type))){
  failures.push('.github/workflows/pr-evidence.yml must own edited, review_requested, review_request_removed, synchronize, and reopened governance events');
}
const evidenceJobs = Object.keys(prEvidenceConfig?.jobs || {});
if(evidenceJobs.length !== 1 || evidenceJobs[0] !== 'governance'){
  failures.push('.github/workflows/pr-evidence.yml must contain only the governance job');
}
for(const forbidden of ['npm test', 'npm run verify', 'npm run site:build', 'npm run site:verify']){
  if(prEvidenceWorkflow.includes(forbidden)){
    failures.push(`PR-body edits must not run the full quality command: ${forbidden}`);
  }
}

const pagesWorkflow = requireText('.github/workflows/pages.yml', [
  'name: Deploy verified Pages artifact',
  'workflow_run:',
  'workflows: [Parallax quality]',
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'main'",
  'DEPLOY_SHA: ${{ github.event.workflow_run.head_sha }}',
  'Refuse a stale main deployment',
  'npm run site:build',
  'npm run site:verify',
  'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9',
  'actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128',
  'Verify every live byte',
  'npm run site:verify-live',
]);
if(pagesWorkflow.includes('workflow_dispatch:')){
  failures.push('.github/workflows/pages.yml must not expose an ungated manual deployment path');
}

const artifactIndex = read('index.html');
if((artifactIndex.match(/__PARALLAX_ARTIFACT_ID__/g) || []).length !== 11){
  failures.push('index.html must bind exactly eleven entry assets to the site artifact ID');
}
requireText('scripts/preview.mjs', [
  'assertCleanCandidateWorktree()',
  'buildSiteArtifact({ commit: "HEAD" })',
  'verifyArtifactBundle(artifact.artifactRoot)',
  'Serving verified artifact',
]);

function validateFixture(relativePath, requiredKind){
  let fixture;
  try{
    fixture = JSON.parse(read(relativePath));
  }catch(error){
    failures.push(`${relativePath} is not valid JSON: ${error.message}`);
    return;
  }
  if(fixture.fixtureVersion !== 1) failures.push(`${relativePath} must use fixtureVersion 1`);
  if(requiredKind && fixture.fixtureKind !== requiredKind){
    failures.push(`${relativePath} must declare fixtureKind ${requiredKind}`);
  }
  if(!['clean', 'current', 'legacy'].includes(fixture.fixtureKind)){
    failures.push(`${relativePath} must declare fixtureKind clean, current, or legacy`);
  }
  if(fixture.anonymized !== true) failures.push(`${relativePath} must declare anonymized: true`);
  if(!fixture.storage || Array.isArray(fixture.storage) || typeof fixture.storage !== 'object'){
    failures.push(`${relativePath} must provide a storage object`);
    return;
  }
  for(const [key, value] of Object.entries(fixture.storage)){
    if(typeof value !== 'string') failures.push(`${relativePath} storage value ${key} must be an exact string`);
  }
  const source = JSON.stringify(fixture);
  const identifyingPatterns = [
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, 'email address'],
    [/\b\d{3}-\d{2}-\d{4}\b/, 'Social Security number'],
  ];
  for(const [pattern, label] of identifyingPatterns){
    if(pattern.test(source)) failures.push(`${relativePath} appears to contain a ${label}`);
  }
}

const persistedFiles = readdirSync(join(ROOT, 'test', 'fixtures', 'persisted'))
  .filter(name => extname(name) === '.json');
for(const name of persistedFiles){
  const expectedKind = name === 'clean-state.v1.json'
    ? 'clean'
    : name === 'legacy-state.v1.json' ? 'legacy' : undefined;
  validateFixture(`test/fixtures/persisted/${name}`, expectedKind);
}
if(!persistedFiles.some(name => name.startsWith('clean-state'))){
  failures.push('persisted fixtures must retain a separate clean-state JSON fixture');
}
if(!persistedFiles.some(name => name.startsWith('legacy-state'))){
  failures.push('persisted fixtures must retain a separate legacy-state JSON fixture');
}

const markdownFiles = [
  'AGENTS.md',
  'README.md',
  'docs/CODEX_WORKFLOW.md',
  'docs/CODE_REVIEW.md',
  'docs/GITHUB_SETTINGS.md',
  'docs/DEPLOYMENT-INTEGRITY.md',
  'docs/LINTING.md',
  'docs/templates/CODEX_BUG_FIX_PROMPT.md',
  'test/fixtures/persisted/README.md',
];
const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;
for(const relativePath of markdownFiles){
  const content = read(relativePath);
  for(const match of content.matchAll(markdownLink)){
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if(!rawTarget || rawTarget.startsWith('#') || /^[a-z]+:/i.test(rawTarget)) continue;
    const fileTarget = rawTarget.split('#')[0];
    if(!fileTarget) continue;
    const absoluteTarget = resolve(ROOT, dirname(relativePath), fileTarget);
    if(!existsSync(absoluteTarget)){
      failures.push(`${relativePath} has a broken local link: ${rawTarget}`);
    }
  }
}

if(failures.length){
  console.error('Governance validation failed:');
  for(const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Governance validation passed (${markdownFiles.length} Markdown files, ${workflowFiles.length} workflows, ${persistedFiles.length} persisted fixtures).`);

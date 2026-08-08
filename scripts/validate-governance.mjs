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
  'http://127.0.0.1:8825/',
]);
if(agents.split(/\r?\n/).length > 180){
  failures.push('AGENTS.md must remain concise (180 lines or fewer)');
}

requireText('docs/CODEX_WORKFLOW.md', [
  '### 1. Goal',
  '### 14. Post-failure retrospective and instruction update',
  '| Reported symptom | Exact reproduction | Pre-fix failure | Production change | Regression assertion | Post-fix proof |',
  'A test-only PR may improve coverage but cannot close a product-behavior issue.',
  'Moving a withdrawal lever changes the expected tax or financial column',
  'Goals Essentials plus documented overrides reconcile to Cash Flow Essentials',
  'Income and expense outputs trace to distinct engine inputs',
  '## Existing-rule mapping',
]);

requireText('docs/CODE_REVIEW.md', [
  'Review the complete branch against current `main`',
  'The authoring session cannot self-certify.',
  'The initial review is read-only.',
  'Inspect important untouched files when their absence is suspicious',
  'If no findings are found, say so explicitly',
]);

requireText('docs/GITHUB_SETTINGS.md', [
  '`Governance safeguards`',
  '`Unit tests`',
  '`Full browser verification`',
  '`@codex review`',
  'This document does not claim they are currently active.',
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
  '## Problem and user-visible impact',
  '## Exact reproduction',
  '## Root cause',
  '## Acceptance matrix',
  '## Production code changed',
  '## Tests added or changed',
  '## Fail-before evidence',
  '## Pass-after evidence',
  '## Persisted-state and migration impact',
  '## Financial invariants checked',
  '## Exact commands and results',
  '## Required CI status',
  '## Known failures and proof gaps',
  '## Scope exclusions',
  '## Independent review status',
  '## Rollback considerations',
  '- [ ] Every behavior described as fixed was reproduced on the base branch and directly verified on this branch.',
]);
if((prTemplate.match(/Every behavior described as fixed was reproduced/g) || []).length !== 1){
  failures.push('.github/PULL_REQUEST_TEMPLATE.md must contain the completion checkbox exactly once');
}

const packageJson = JSON.parse(read('package.json') || '{}');
const expectedScripts = {
  'governance:check': 'node --test scripts/validate-pr-body.test.mjs && node scripts/validate-governance.mjs',
  'governance:pr': 'node scripts/validate-pr-body.mjs',
  verify: 'node scripts/verify.mjs',
  preview: 'node scripts/preview.mjs',
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
  const document = parseDocument(read(relativePath), { prettyErrors: true });
  for(const error of document.errors){
    failures.push(`${relativePath} has invalid YAML: ${error.message}`);
  }
  if(document.contents?.type === 'SEQ'){
    failures.push(`${relativePath} must have a mapping at the document root`);
  }
}
if(!workflowFiles.length){
  failures.push('at least one GitHub Actions workflow is required');
}

const workflow = requireText('.github/workflows/test.yml', [
  'name: Parallax quality',
  'name: Governance safeguards',
  'name: Unit tests',
  'name: Full browser verification',
  'run: npm run governance:check',
  'run: npm run governance:pr',
  'run: npm test',
  'run: npm run verify',
  'PUPPETEER_EXECUTABLE_PATH: /usr/bin/google-chrome',
  'actions/upload-artifact@v4',
]);
const workflowConfig = parseDocument(workflow).toJS();
const requiredPullRequestTypes = ['opened', 'synchronize', 'reopened', 'edited'];
const configuredPullRequestTypes = workflowConfig?.on?.pull_request?.types;
if(!Array.isArray(configuredPullRequestTypes)
  || requiredPullRequestTypes.some(type => !configuredPullRequestTypes.includes(type))){
  failures.push('.github/workflows/test.yml must rerun pull_request governance for opened, synchronize, reopened, and edited events');
}
for(const forbidden of ['continue-on-error', '|| true', '&& true']){
  if(workflow.includes(forbidden)){
    failures.push(`required workflow must not contain ${forbidden}`);
  }
}

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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_SECTIONS = [
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

const COMPLETION_SENTENCE = 'Every behavior described as fixed was reproduced on the base branch and directly verified on this branch.';

function visibleText(value){
  return value.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function sectionContent(body, heading){
  const marker = `## ${heading}`;
  const start = body.indexOf(marker);
  if(start < 0) return null;
  const contentStart = start + marker.length;
  const next = body.indexOf('\n## ', contentStart);
  return visibleText(body.slice(contentStart, next < 0 ? body.length : next));
}

function validateAcceptanceMatrix(content){
  if(!content) return false;
  const rows = content.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && line.endsWith('|'))
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()));
  return rows.some(cells => (
    cells.length === 6
    && cells.every(cell => cell.length > 0 && !/^[-:]+$/.test(cell))
    && cells[0] !== 'Reported symptom'
  ));
}

export function validatePullRequestBody(body){
  const failures = [];
  if(typeof body !== 'string' || !body.trim()) return ['pull request body is empty'];

  for(const heading of REQUIRED_SECTIONS){
    const content = sectionContent(body, heading);
    if(content === null) failures.push(`missing required PR section: ${heading}`);
    else if(!content) failures.push(`required PR section has no evidence: ${heading}`);
  }

  const acceptance = sectionContent(body, 'Acceptance matrix');
  if(!validateAcceptanceMatrix(acceptance)){
    failures.push('Acceptance matrix needs at least one fully populated six-column evidence row');
  }

  const shas = [...body.matchAll(/\b[0-9a-f]{40}\b/gi)].map(match => match[0].toLowerCase());
  if(new Set(shas).size < 2){
    failures.push('PR evidence must include distinct full base and branch commit SHAs');
  }

  const commands = sectionContent(body, 'Exact commands and results') || '';
  for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
    if(!commands.includes(command)) failures.push(`Exact commands and results is missing: ${command}`);
  }
  if(/actual result/i.test(commands)){
    failures.push('Exact commands and results still contains a template placeholder');
  }

  const checked = new RegExp(`- \\[x\\] ${COMPLETION_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  if(!checked.test(body)){
    failures.push('truthful completion checkbox must be checked before required PR evidence can pass');
  }

  return failures;
}

export function validatePullRequestEvent(event){
  if(event?.action === undefined || event?.pull_request === undefined){
    return { skipped: true, failures: [] };
  }
  return {
    skipped: false,
    failures: validatePullRequestBody(event.pull_request?.body || ''),
  };
}

function run(){
  if(process.env.GITHUB_EVENT_NAME !== 'pull_request'){
    console.log('PR evidence validation skipped outside a pull_request event.');
    return;
  }
  if(!process.env.GITHUB_EVENT_PATH){
    console.error('PR evidence validation failed: GITHUB_EVENT_PATH is missing.');
    process.exit(1);
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = validatePullRequestEvent(event);
  if(result.failures.length){
    console.error('PR evidence validation failed:');
    for(const failure of result.failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('PR evidence validation passed.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if(invokedPath === fileURLToPath(import.meta.url)) run();

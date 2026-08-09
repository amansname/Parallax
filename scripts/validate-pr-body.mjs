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

function stripHtmlComments(source){
  let cursor = 0;
  let visible = '';
  while(cursor < source.length){
    const start = source.indexOf('<!--', cursor);
    if(start < 0){
      visible += source.slice(cursor);
      break;
    }
    visible += source.slice(cursor, start);
    const end = source.indexOf('-->', start + 4);
    const hiddenEnd = end < 0 ? source.length : end + 3;
    visible += source.slice(start, hiddenEnd).replace(/[^\r\n]/g, '');
    cursor = hiddenEnd;
  }
  return visible;
}

function visibleMarkdownLines(source){
  const visible = [];
  let fence = null;

  for(const line of stripHtmlComments(source).split(/\r?\n/)){
    if(fence){
      const closingFence = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if(closingFence
        && closingFence[1][0] === fence.character
        && closingFence[1].length >= fence.length){
        fence = null;
      }
      continue;
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(openingFence){
      fence = {
        character: openingFence[1][0],
        length: openingFence[1].length,
      };
      continue;
    }

    if(/^(?: {4}| {0,3}\t)/.test(line)) continue;

    visible.push(line);
  }

  return visible;
}

function parseLevelTwoSections(body){
  const sections = new Map();
  let currentLines = null;
  let fence = null;

  for(const line of stripHtmlComments(body).split(/\r?\n/)){
    if(fence){
      if(currentLines) currentLines.push(line);
      const closingFence = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if(closingFence
        && closingFence[1][0] === fence.character
        && closingFence[1].length >= fence.length){
        fence = null;
      }
      continue;
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(openingFence){
      if(currentLines) currentLines.push(line);
      fence = {
        character: openingFence[1][0],
        length: openingFence[1].length,
      };
      continue;
    }

    const headingMatch = line.match(/^ {0,3}##(?!#)[ \t]+(.+?)[ \t]*$/);
    if(headingMatch){
      const heading = headingMatch[1].replace(/[ \t]+#+[ \t]*$/, '').trim();
      currentLines = [];
      const matches = sections.get(heading) || [];
      matches.push(currentLines);
      sections.set(heading, matches);
      continue;
    }

    if(currentLines) currentLines.push(line);
  }

  return sections;
}

function sectionContent(sections, heading){
  const matches = sections.get(heading);
  if(!matches) return null;
  return matches[0].join('\n').trim();
}

function labeledSha(content, label){
  if(!content) return null;
  const match = content.match(new RegExp(`^[ \\t]*-[ \\t]*${label}:[ \\t]*([0-9a-f]{40})[ \\t]*$`, 'im'));
  return match?.[1]?.toLowerCase() || null;
}

function validateAcceptanceMatrix(content){
  if(!content) return false;
  const rows = visibleMarkdownLines(content)
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && line.endsWith('|'))
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()));
  return rows.some(cells => (
    cells.length === 6
    && cells.every(cell => cell.length > 0 && !/^[-:]+$/.test(cell))
    && cells[0] !== 'Reported symptom'
  ));
}

export function validatePullRequestBody(body, expectedShas = {}){
  const failures = [];
  if(typeof body !== 'string' || !body.trim()) return ['pull request body is empty'];
  if(visibleMarkdownLines(body).some(line => line.trimStart().startsWith('<'))){
    failures.push('PR evidence must not be hidden in a raw HTML block');
  }
  const sections = parseLevelTwoSections(body);

  for(const heading of REQUIRED_SECTIONS){
    const matches = sections.get(heading);
    const content = sectionContent(sections, heading);
    if(content === null) failures.push(`missing required PR section: ${heading}`);
    else if(matches.length !== 1) failures.push(`required PR section appears more than once: ${heading}`);
    else if(!content) failures.push(`required PR section has no evidence: ${heading}`);
  }

  const acceptance = sectionContent(sections, 'Acceptance matrix');
  if(!validateAcceptanceMatrix(acceptance)){
    failures.push('Acceptance matrix needs at least one fully populated six-column evidence row');
  }

  const exactReproduction = sectionContent(sections, 'Exact reproduction');
  const documentedBaseSha = labeledSha(exactReproduction, 'Base commit SHA');
  const documentedHeadSha = labeledSha(exactReproduction, 'Branch commit SHA');
  if(!documentedBaseSha) failures.push('Exact reproduction must name the full Base commit SHA');
  if(!documentedHeadSha) failures.push('Exact reproduction must name the full Branch commit SHA');
  if(documentedBaseSha && documentedHeadSha && documentedBaseSha === documentedHeadSha){
    failures.push('PR evidence must include distinct base and branch commit SHAs');
  }
  if(expectedShas.baseSha && documentedBaseSha !== expectedShas.baseSha.toLowerCase()){
    failures.push('Exact reproduction Base commit SHA must equal the current base SHA');
  }
  if(expectedShas.headSha && documentedHeadSha !== expectedShas.headSha.toLowerCase()){
    failures.push('Exact reproduction Branch commit SHA must equal the current head SHA');
  }

  const commands = sectionContent(sections, 'Exact commands and results') || '';
  for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
    if(!commands.includes(command)) failures.push(`Exact commands and results is missing: ${command}`);
  }
  if(/#[ \t]*actual(?:[ \t]+counts[ \t]+and)?[ \t]+result\b/i.test(commands)){
    failures.push('Exact commands and results still contains a template placeholder');
  }

  const completion = sectionContent(sections, 'Truthful completion gate') || '';
  const checked = new RegExp(`^[ \\t]*- \\[x\\] ${COMPLETION_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'i');
  if(!visibleMarkdownLines(completion).some(line => checked.test(line))){
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
    failures: validatePullRequestBody(event.pull_request?.body || '', {
      baseSha: event.pull_request?.base?.sha || '',
      headSha: event.pull_request?.head?.sha || '',
    }),
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

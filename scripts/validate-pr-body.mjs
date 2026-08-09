import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

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
const ACCEPTANCE_HEADERS = [
  'Reported symptom',
  'Exact reproduction',
  'Pre-fix failure',
  'Production change',
  'Regression assertion',
  'Post-fix proof',
];

function visibleTokenText(token){
  if(!token || token.type === 'html' || token.type === 'space') return '';
  if(token.type === 'code') return token.text || '';
  if(token.type === 'table'){
    return [...(token.header || []), ...(token.rows || []).flat()]
      .map(cell => cell.text || '')
      .join(' ');
  }
  if(Array.isArray(token.items)) return token.items.map(visibleTokenText).join(' ');
  if(Array.isArray(token.tokens)) return token.tokens.map(visibleTokenText).join(' ');
  return typeof token.text === 'string' ? token.text : '';
}

function parseLevelTwoSections(tokens){
  const sections = new Map();
  let currentTokens = null;

  for(const token of tokens){
    if(token.type === 'heading' && token.depth === 2){
      const heading = token.text.trim();
      currentTokens = [];
      const matches = sections.get(heading) || [];
      matches.push(currentTokens);
      sections.set(heading, matches);
      continue;
    }
    if(currentTokens) currentTokens.push(token);
  }

  return sections;
}

function sectionTokens(sections, heading){
  const matches = sections.get(heading);
  return matches ? matches[0] : null;
}

function sectionContent(sections, heading){
  const tokens = sectionTokens(sections, heading);
  if(!tokens) return null;
  return tokens.map(visibleTokenText).join('\n').trim();
}

function labeledSha(tokens, label){
  if(!tokens) return null;
  const pattern = new RegExp(`^${label}:[ \\t]*([0-9a-f]{40})[ \\t]*$`, 'i');
  for(const token of tokens){
    if(token.type !== 'list') continue;
    for(const item of token.items || []){
      if((item.tokens || []).some(child => ['blockquote', 'code', 'html', 'list'].includes(child.type))) continue;
      const match = visibleTokenText(item).trim().match(pattern);
      if(match) return match[1].toLowerCase();
    }
  }
  return null;
}

function validateAcceptanceMatrix(tokens){
  if(!tokens) return false;
  return tokens.some(token => (
    token.type === 'table'
    && token.header?.length === ACCEPTANCE_HEADERS.length
    && token.header.every((cell, index) => cell.text.trim() === ACCEPTANCE_HEADERS[index])
    && token.rows?.some(row => (
      row.length === ACCEPTANCE_HEADERS.length
      && row.every(cell => cell.text.trim().length > 0)
    ))
  ));
}

export function validatePullRequestBody(body, expectedShas = {}){
  const failures = [];
  if(typeof body !== 'string' || !body.trim()) return ['pull request body is empty'];
  const tokens = marked.lexer(body, { gfm: true });
  let hasRawHtml = false;
  marked.walkTokens(tokens, token => {
    if(token.type === 'html' && !token.raw.trimStart().startsWith('<!--')) hasRawHtml = true;
  });
  if(hasRawHtml){
    failures.push('PR evidence must not be hidden in a raw HTML block');
  }
  const sections = parseLevelTwoSections(tokens);

  for(const heading of REQUIRED_SECTIONS){
    const matches = sections.get(heading);
    const content = sectionContent(sections, heading);
    if(content === null) failures.push(`missing required PR section: ${heading}`);
    else if(matches.length !== 1) failures.push(`required PR section appears more than once: ${heading}`);
    else if(!content) failures.push(`required PR section has no evidence: ${heading}`);
  }

  const acceptance = sectionTokens(sections, 'Acceptance matrix');
  if(!validateAcceptanceMatrix(acceptance)){
    failures.push('Acceptance matrix needs at least one fully populated six-column evidence row');
  }

  const exactReproduction = sectionTokens(sections, 'Exact reproduction');
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

  const completion = sectionTokens(sections, 'Truthful completion gate') || [];
  const checked = completion.some(token => (
    token.type === 'list'
    && token.items?.some(item => item.task && item.checked === true && item.text.trim() === COMPLETION_SENTENCE)
  ));
  if(!checked){
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

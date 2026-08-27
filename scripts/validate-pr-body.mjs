import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const REQUIRED_SECTIONS = [
  'Workflow classification',
  'Outcome and scope',
  'Candidate identity',
  'Acceptance evidence',
  'Implementation and authority',
  'Tests and verification',
  'Required CI status',
  'Independent review',
  'Known failures and proof gaps',
  'Rollback and deployment',
  'Truthful completion gate',
];

const COMPLETION_SENTENCE = 'Every scoped behavior meets its done-when evidence on this candidate, and every required check and review is satisfied.';
const ACCEPTANCE_HEADERS = [
  'Done-when criterion',
  'Baseline or pre-fix evidence',
  'Production change',
  'Verification',
  'Candidate result',
];
const RISK_TIERS = new Set(['Tier 1', 'Tier 2', 'Tier 3']);
const WORK_TYPES = new Set(['feature', 'defect', 'governance', 'docs', 'test']);
const LIFECYCLES = new Set(['Draft-ready', 'Merge-ready']);
const HOLDS = new Set([
  'None',
  'Owner decision',
  'Scope',
  'Verification',
  'CI',
  'Review',
  'Deployment',
  'External blocker',
]);

const PROTECTED_PATH_PATTERNS = [
  /^engine\.js$/,
  /^src\/tax\//,
  /^src\/planning\//,
  /^src\/projection\//,
  /(?:^|\/)(?:rmd|withdrawal|allocation|persistence|migrat|schema|financial|security)/i,
  /^\.claude\//,
  /^\.github\/workflows\//,
  /^\.github\/PULL_REQUEST_TEMPLATE\.md$/,
  /^(?:AGENTS|PRINCIPLES)\.md$/,
  /^docs\/(?:ARCHITECTURE|CODEX_WORKFLOW|CODE_REVIEW|EXECUTION-PROTOCOL|DEPLOYMENT-INTEGRITY)\.md$/,
  /^scripts\/(?:validate-governance|validate-pr-body|build-site-artifact|verify-site-artifact|verify-live-site)\.(?:mjs|test\.mjs)$/,
  /^package(?:-lock)?\.json$/,
];

function visibleTokenText(token){
  if(!token || token.type === 'html' || token.type === 'space' || token.type === 'image') return '';
  if(token.type === 'code') return token.text || '';
  if(token.type === 'table'){
    return [...(token.header || []), ...(token.rows || []).flat()]
      .map(visibleTokenText)
      .join(' ');
  }
  if(Array.isArray(token.items)) return token.items.map(visibleTokenText).join(' ');
  if(Array.isArray(token.tokens)) return token.tokens.map(visibleTokenText).join(' ');
  return typeof token.text === 'string' ? token.text : '';
}

function visibleEvidenceText(token){
  return visibleTokenText(token)
    .replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi, (reference, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/&[a-z][a-z0-9]+;/gi, '')
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2800\u3164\uffa0\u{13441}\u{13442}]/gu, '');
}

function hasSubstantiveEvidence(text){
  return /[\p{L}\p{N}]/u.test(text);
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
  return tokens.map(visibleEvidenceText).join('\n').trim();
}

function labeledValue(tokens, label){
  if(!tokens) return null;
  const pattern = new RegExp(`^${label}:[ \\t]*(.+?)[ \\t]*$`, 'i');
  for(const token of tokens){
    if(token.type !== 'list') continue;
    for(const item of token.items || []){
      if((item.tokens || []).some(child => ['blockquote', 'code', 'html', 'list'].includes(child.type))) continue;
      const match = visibleTokenText(item).trim().match(pattern);
      if(match && hasSubstantiveEvidence(match[1])) return match[1].trim();
    }
  }
  return null;
}

function labeledSha(tokens, label){
  const value = labeledValue(tokens, label);
  return value?.match(/^([0-9a-f]{40})$/i)?.[1]?.toLowerCase() || null;
}

function validateAcceptanceEvidence(tokens){
  if(!tokens) return false;
  return tokens.some(token => (
    token.type === 'table'
    && token.header?.length === ACCEPTANCE_HEADERS.length
    && token.header.every((cell, index) => visibleTokenText(cell).trim() === ACCEPTANCE_HEADERS[index])
    && token.rows?.some(row => (
      row.length === ACCEPTANCE_HEADERS.length
      && row.every(cell => hasSubstantiveEvidence(visibleEvidenceText(cell)))
    ))
  ));
}

function requireConditionalEvidence(failures, sections, heading, reason){
  const content = sectionContent(sections, heading);
  if(content === null) failures.push(`missing required PR section for ${reason}: ${heading}`);
  else if(!hasSubstantiveEvidence(content)) failures.push(`${heading} has no evidence for ${reason}`);
}

function requireLabeledValues(failures, sections, heading, labels, reason){
  const tokens = sectionTokens(sections, heading);
  if(!tokens) return;
  for(const label of labels){
    if(!labeledValue(tokens, label)) failures.push(`${heading} must provide ${label} for ${reason}`);
  }
}

function protectedChangedFiles(changedFiles = []){
  return changedFiles
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(file)));
}

function changedAuthority(file){
  const normalized = file.replaceAll('\\', '/');
  if(/^engine(?:\.test)?\.js$/.test(normalized) || normalized.startsWith('src/projection/')) return 'Projection Engine';
  if(normalized.startsWith('src/tax/')) return 'Tax Engine';
  if(normalized.startsWith('src/planning/')) return 'planning';
  if(normalized.startsWith('src/household/')) return 'household';
  if(normalized.startsWith('src/scenarios/')) return 'Scenario';
  if(normalized.startsWith('ui/')) return 'UI';
  if(/^src\/(?:state|main)(?:\.test)?\.js$/.test(normalized) || normalized === 'index.html') return 'composition/state';
  return null;
}

function changedAuthorities(changedFiles = []){
  return new Set(changedFiles.map(changedAuthority).filter(Boolean));
}

function concreteCommandResult(commandLines, command){
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linePattern = new RegExp(`^[ \\t]*${escapedCommand}(?:[ \\t]+(.+))?$`, 'i');
  return commandLines
    .map(line => line.match(linePattern)?.[1]?.trim() || '')
    .find(result => /\b(?:exit(?:[ \\t]+code)?[ \\t]+-?\d+|\d+[ \\t]+(?:tests?[ \\t]+)?passed|\d+[ \\t]+failed|passed|failed|blocked|blocker|error|successful(?:ly)?)\b/i.test(result)) || null;
}

function commandResultSucceeded(result){
  if(!result) return false;
  if(/\b(?:failed|blocked|blocker|error)\b/i.test(result)) return false;
  const exitCode = result.match(/\bexit(?:[ \\t]+code)?[ \\t]+(-?\d+)\b/i)?.[1];
  if(exitCode !== undefined && Number(exitCode) !== 0) return false;
  return /\b(?:exit(?:[ \\t]+code)?[ \\t]+0|\d+[ \\t]+(?:tests?[ \\t]+)?passed|passed|successful(?:ly)?)\b/i.test(result);
}

function taskChecked(tokens, label){
  if(!tokens) return null;
  for(const token of tokens){
    if(token.type !== 'list') continue;
    const item = token.items?.find(candidate => (
      candidate.task
      && visibleTokenText(candidate).trim() === label
    ));
    if(item) return item.checked === true;
  }
  return null;
}

export function validatePullRequestBody(body, expectedShas = {}){
  const failures = [];
  if(typeof body !== 'string' || !body.trim()) return ['pull request body is empty'];
  const tokens = marked.lexer(body, { gfm: true });
  let hasRawHtml = false;
  marked.walkTokens(tokens, token => {
    if(token.type === 'html' && !token.raw.trimStart().startsWith('<!--')) hasRawHtml = true;
  });
  if(hasRawHtml) failures.push('PR evidence must not be hidden in a raw HTML block');
  const sections = parseLevelTwoSections(tokens);

  for(const heading of REQUIRED_SECTIONS){
    const matches = sections.get(heading);
    const content = sectionContent(sections, heading);
    if(content === null) failures.push(`missing required PR section: ${heading}`);
    else if(matches.length !== 1) failures.push(`required PR section appears more than once: ${heading}`);
    else if(!hasSubstantiveEvidence(content)) failures.push(`required PR section has no evidence: ${heading}`);
  }

  const classification = sectionTokens(sections, 'Workflow classification');
  const riskTier = labeledValue(classification, 'Risk tier');
  const workType = labeledValue(classification, 'Work type')?.toLowerCase() || null;
  const lifecycle = labeledValue(classification, 'Lifecycle');
  const hold = labeledValue(classification, 'Hold');
  if(!RISK_TIERS.has(riskTier)) failures.push('Workflow classification must name Risk tier: Tier 1, Tier 2, or Tier 3');
  if(!WORK_TYPES.has(workType)) failures.push('Workflow classification must name Work type: feature, defect, governance, docs, or test');
  if(!LIFECYCLES.has(lifecycle)) failures.push('Workflow classification must name Lifecycle: Draft-ready or Merge-ready');
  if(!HOLDS.has(hold)) failures.push('Workflow classification must use a canonical Hold value');
  if(workType === 'governance' && riskTier !== 'Tier 3'){
    failures.push('Work type governance requires Risk tier: Tier 3');
  }
  const protectedFiles = protectedChangedFiles(expectedShas.changedFiles);
  if(protectedFiles.length && riskTier !== 'Tier 3'){
    failures.push(`Protected changes require Risk tier: Tier 3: ${protectedFiles.join(', ')}`);
  }
  const authorities = changedAuthorities(expectedShas.changedFiles);
  if(authorities.size > 1 && riskTier !== 'Tier 3'){
    failures.push(`Cross-authority changes require Risk tier: Tier 3: ${[...authorities].join(', ')}`);
  }

  const acceptance = sectionTokens(sections, 'Acceptance evidence');
  if(!validateAcceptanceEvidence(acceptance)){
    failures.push('Acceptance evidence needs at least one fully populated five-column evidence row');
  }

  if(workType === 'defect'){
    requireConditionalEvidence(failures, sections, 'Defect reproduction and root cause', 'work type defect');
    requireLabeledValues(
      failures,
      sections,
      'Defect reproduction and root cause',
      [
        'Exact reproduction',
        'Base failure evidence',
        'Root cause',
        'Fail-before regression evidence',
        'Pass-after candidate evidence',
      ],
      'work type defect',
    );
  }
  if(riskTier === 'Tier 3'){
    requireConditionalEvidence(failures, sections, 'Protected policy and compatibility evidence', 'Tier 3');
  }

  const identity = sectionTokens(sections, 'Candidate identity');
  const documentedBaseSha = labeledSha(identity, 'Base commit SHA');
  const documentedHeadSha = labeledSha(identity, 'Candidate head SHA');
  if(!documentedBaseSha) failures.push('Candidate identity must name the full Base commit SHA');
  if(!documentedHeadSha) failures.push('Candidate identity must name the full Candidate head SHA');
  if(documentedBaseSha && documentedHeadSha && documentedBaseSha === documentedHeadSha){
    failures.push('PR evidence must include distinct base and candidate head SHAs');
  }
  if(expectedShas.baseSha && documentedBaseSha !== expectedShas.baseSha.toLowerCase()){
    failures.push('Candidate identity Base commit SHA must equal the current base SHA');
  }
  if(expectedShas.headSha && documentedHeadSha !== expectedShas.headSha.toLowerCase()){
    failures.push('Candidate identity Candidate head SHA must equal the current head SHA');
  }

  requireLabeledValues(
    failures,
    sections,
    'Rollback and deployment',
    [
      'Rollback considerations',
      'Saved-data risk',
      'Deployment impact',
      'Planned live proof',
      'Post-merge identity chain',
    ],
    lifecycle || 'the declared lifecycle',
  );
  requireLabeledValues(
    failures,
    sections,
    'Independent review',
    ['Review method', 'Reviewer/result link', 'Findings and re-review status'],
    lifecycle || 'the declared lifecycle',
  );

  const verification = sectionContent(sections, 'Tests and verification') || '';
  const commandLines = verification.split(/\r?\n/);
  const requiredCommands = riskTier === 'Tier 1'
    ? ['npm run governance:check', 'git diff --check']
    : ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check'];
  for(const command of requiredCommands){
    if(!verification.includes(command)) failures.push(`Tests and verification is missing: ${command}`);
    const result = concreteCommandResult(commandLines, command);
    if(!result) failures.push(`Tests and verification must record a concrete result for: ${command}`);
    else if(lifecycle === 'Merge-ready' && !commandResultSucceeded(result)){
      failures.push(`Merge-ready requires a successful local result for: ${command}`);
    }
  }
  if(/#[ \\t]*actual(?:[ \\t]+counts[ \\t]+and)?[ \\t]+result\b/i.test(verification)){
    failures.push('Tests and verification still contains a template placeholder');
  }

  const ci = sectionTokens(sections, 'Required CI status');
  for(const check of ['Governance safeguards', 'Unit tests', 'Build deployable site artifact', 'Full browser verification']){
    const checked = taskChecked(ci, check);
    if(checked === null) failures.push(`Required CI status is missing: ${check}`);
    else if(lifecycle === 'Merge-ready' && !checked) failures.push(`Merge-ready requires checked CI status: ${check}`);
  }

  const completion = sectionTokens(sections, 'Truthful completion gate') || [];
  const checked = taskChecked(completion, COMPLETION_SENTENCE);
  if(lifecycle === 'Merge-ready' && checked !== true){
    failures.push('truthful completion checkbox must be checked for Lifecycle: Merge-ready');
  }
  if(lifecycle === 'Draft-ready' && checked === true){
    failures.push('truthful completion checkbox must remain unchecked for Lifecycle: Draft-ready');
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
      changedFiles: event.changedFiles || [],
    }),
  };
}

function changedFilesForPullRequest(event){
  const baseSha = event.pull_request?.base?.sha || '';
  const headSha = event.pull_request?.head?.sha || '';
  if(!baseSha || !headSha) return [];
  return execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map(file => file.trim())
    .filter(Boolean);
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
  event.changedFiles = changedFilesForPullRequest(event);
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

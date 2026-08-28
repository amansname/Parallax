import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const REQUIRED_SECTIONS = [
  'Scope and risk',
  'Acceptance ledger',
  'Defect evidence',
  'Changes and tests',
  'Visible UI contract',
  'Protected-contract evidence',
  'Verification',
  'Delivery status',
  'Rollback considerations',
  'Truthful completion gate',
];

const ACCEPTANCE_HEADERS = [
  'Original request or reported symptom',
  'Disposition',
  'Base or starting-state proof',
  'Production change',
  'Regression assertion',
  'Candidate proof',
];
const ALLOWED_DISPOSITIONS = new Set(['fixed', 'delivered', 'deferred', 'separately scoped']);
const ALLOWED_CHANGE_TYPES = new Set(['defect', 'feature', 'test', 'documentation', 'governance']);
const ALLOWED_RISK_TIERS = new Set(['Tier 1 - Fast', 'Tier 2 - Standard', 'Tier 3 - Protected']);
const ALLOWED_LIFECYCLES = new Set([
  'Scoped',
  'In build',
  'Draft-ready',
  'Merge-ready',
  'Merged',
  'Production-confirmed',
]);
const ALLOWED_POSITIVE_REVIEW_STATUSES = new Set([
  'approved with no findings',
  'completed with no findings',
  'passed with no findings',
  'findings corrected and re-review passed',
]);
const REQUIRED_CI_JOBS = [
  'Governance safeguards',
  'Unit tests',
  'Build deployable site artifact',
  'Full browser verification',
];
const REQUIRED_PR_AUTHOR = 'parallax-pr-author-amans[bot]';
const COMPLETION_SENTENCES = [
  'Every original request or reported symptom is accounted for as fixed, delivered, deferred, or separately scoped.',
  'The visible UI contract names the exact allowed result and explicitly absent or unchanged behavior.',
  'The evidence and status describe the current base and candidate, with no stale completion claim.',
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

function isSuccessfulVerificationResult(result){
  const normalized = String(result || '').normalize('NFKC').trim();
  const hasNegativeEvidence = /\b(?:not[ \t]+passed|failed|failures?|blocked|errors?|not[ \t]+run|not[ \t]+required)\b/i.test(normalized);
  const hasPositiveEvidence = /^[\s:;=—-]*(?:exit(?:[ \t]+code)?[ \t]+0\b|\d+[ \t]+(?:tests?[ \t]+)?passed\b|passed\b|successful(?:ly)?\b)/i.test(normalized);
  return hasPositiveEvidence && !hasNegativeEvidence;
}

function escapeRegExp(text){
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const pattern = new RegExp(`^${escapeRegExp(label)}:[ \\t]*(.+?)[ \\t]*$`, 'i');
  for(const token of tokens){
    if(token.type !== 'list') continue;
    for(const item of token.items || []){
      if((item.tokens || []).some(child => ['blockquote', 'code', 'html', 'list'].includes(child.type))) continue;
      const match = visibleEvidenceText(item).trim().match(pattern);
      if(match && hasSubstantiveEvidence(match[1])) return match[1].trim();
    }
  }
  return null;
}

function labeledSha(tokens, label){
  const value = labeledValue(tokens, label);
  return value?.match(/^([0-9a-f]{40})$/i)?.[1]?.toLowerCase() || null;
}

function validateAcceptanceLedger(tokens, failures){
  const table = tokens?.find(token => token.type === 'table');
  if(!table
    || table.header?.length !== ACCEPTANCE_HEADERS.length
    || !table.header.every((cell, index) => visibleTokenText(cell).trim() === ACCEPTANCE_HEADERS[index])){
    failures.push('Acceptance ledger must use the required six-column header');
    return;
  }

  const evidenceRows = (table.rows || []).filter(row => (
    row.some(cell => hasSubstantiveEvidence(visibleEvidenceText(cell)))
  ));
  if(!evidenceRows.length){
    failures.push('Acceptance ledger needs at least one fully populated six-column evidence row');
    return;
  }

  for(const row of evidenceRows){
    if(row.length !== ACCEPTANCE_HEADERS.length
      || !row.every(cell => hasSubstantiveEvidence(visibleEvidenceText(cell)))){
      failures.push('Every nonempty Acceptance ledger row must populate all six evidence columns');
      continue;
    }
    const disposition = visibleEvidenceText(row[1]).trim().toLowerCase();
    if(!ALLOWED_DISPOSITIONS.has(disposition)){
      failures.push('Acceptance ledger Disposition must be Fixed, Delivered, Deferred, or Separately scoped');
    }
  }
}

function requireLabels(tokens, labels, failures, sectionName){
  for(const label of labels){
    if(!labeledValue(tokens, label)) failures.push(`${sectionName} must include substantive ${label} evidence`);
  }
}

function taskItems(tokens){
  const items = [];
  for(const token of tokens || []){
    if(token.type !== 'list') continue;
    for(const item of token.items || []){
      if(item.task) items.push({ text: item.text.trim(), checked: item.checked === true });
    }
  }
  return items;
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

  const scope = sectionTokens(sections, 'Scope and risk');
  requireLabels(scope, [
    'Change type',
    'Risk tier',
    'Original request',
    'Outcome',
    'Included',
    'Non-goals',
    'Authority and protected boundaries',
  ], failures, 'Scope and risk');

  const changeType = labeledValue(scope, 'Change type');
  if(changeType && !ALLOWED_CHANGE_TYPES.has(changeType.toLowerCase())){
    failures.push('Change type must be Defect, Feature, Test, Documentation, or Governance');
  }
  const riskTier = labeledValue(scope, 'Risk tier');
  if(riskTier && !ALLOWED_RISK_TIERS.has(riskTier)){
    failures.push('Risk tier must be Tier 1 - Fast, Tier 2 - Standard, or Tier 3 - Protected');
  }

  const documentedBaseSha = labeledSha(scope, 'Base commit SHA');
  const documentedHeadSha = labeledSha(scope, 'Branch commit SHA');
  if(!documentedBaseSha) failures.push('Scope and risk must name the full Base commit SHA');
  if(!documentedHeadSha) failures.push('Scope and risk must name the full Branch commit SHA');
  if(documentedBaseSha && documentedHeadSha && documentedBaseSha === documentedHeadSha){
    failures.push('PR evidence must include distinct base and branch commit SHAs');
  }
  if(expectedShas.baseSha && documentedBaseSha !== expectedShas.baseSha.toLowerCase()){
    failures.push('Scope and risk Base commit SHA must equal the current base SHA');
  }
  if(expectedShas.headSha && documentedHeadSha !== expectedShas.headSha.toLowerCase()){
    failures.push('Scope and risk Branch commit SHA must equal the current head SHA');
  }

  validateAcceptanceLedger(sectionTokens(sections, 'Acceptance ledger'), failures);

  const defectEvidence = sectionTokens(sections, 'Defect evidence');
  if(changeType?.toLowerCase() === 'defect'){
    requireLabels(defectEvidence, ['Exact reproduction', 'Root cause', 'Fail-before', 'Pass-after'], failures, 'Defect evidence');
  }

  const uiContract = sectionTokens(sections, 'Visible UI contract');
  const uiChanged = labeledValue(uiContract, 'Visible UI changed');
  if(!uiChanged || !['yes', 'no'].includes(uiChanged.toLowerCase())){
    failures.push('Visible UI contract must state Visible UI changed: Yes or No');
  }else if(uiChanged.toLowerCase() === 'yes'){
    requireLabels(uiContract, [
      'Exact visible inventory',
      'Explicitly absent or unchanged',
      'Canonical visual reference and viewports',
      'Rendered or browser proof',
    ], failures, 'Visible UI contract');
  }else{
    requireLabels(uiContract, ['Reason'], failures, 'Visible UI contract');
  }

  const protectedEvidence = sectionContent(sections, 'Protected-contract evidence') || '';
  if(riskTier === 'Tier 3 - Protected' && /^not applicable\b/i.test(protectedEvidence)){
    failures.push('Tier 3 requires substantive protected-contract evidence');
  }

  const commands = sectionContent(sections, 'Verification') || '';
  const commandLines = commands.split(/\r?\n/);
  const verificationResults = new Map();
  for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
    if(!commands.includes(command)) failures.push(`Verification is missing: ${command}`);
    const escapedCommand = escapeRegExp(command);
    const linePattern = new RegExp(`^[ \\t]*${escapedCommand}(?:[ \\t]+(.+))?$`, 'i');
    const result = commandLines
      .map(line => line.match(linePattern)?.[1]?.trim() || '')
      .find(value => /\b(?:exit(?:[ \\t]+code)?[ \\t]+-?\d+|\d+[ \\t]+(?:tests?[ \\t]+)?passed|\d+[ \\t]+failed|passed|failed|blocked|error|successful(?:ly)?|not[ \\t]+run|not[ \\t]+required)\b/i.test(value)) || '';
    verificationResults.set(command, result);
    if(!result) failures.push(`Verification must record a concrete result for: ${command}`);
  }

  const delivery = sectionTokens(sections, 'Delivery status');
  const ciItems = taskItems(delivery);
  for(const job of REQUIRED_CI_JOBS){
    const matches = ciItems.filter(item => item.text === job);
    if(matches.length !== 1) failures.push(`Delivery status must include exactly one CI checkbox for: ${job}`);
  }
  requireLabels(delivery, [
    'Known failures and proof gaps',
    'Review method',
    'Reviewer/result link',
    'Review status',
    'Lifecycle',
    'Hold',
  ], failures, 'Delivery status');

  const lifecycle = labeledValue(delivery, 'Lifecycle');
  if(lifecycle && !ALLOWED_LIFECYCLES.has(lifecycle)){
    failures.push('Lifecycle must be Scoped, In build, Draft-ready, Merge-ready, Merged, or Production-confirmed');
  }
  const readinessLifecycle = ['merge-ready', 'merged', 'production-confirmed']
    .includes(lifecycle?.toLowerCase());
  if(expectedShas.pullRequestState === 'open'
    && ['Merged', 'Production-confirmed'].includes(lifecycle)){
    failures.push('An open pull request cannot claim Merged or Production-confirmed lifecycle');
  }
  if(['Merged', 'Production-confirmed'].includes(lifecycle) && expectedShas.merged === false){
    failures.push(`${lifecycle} lifecycle requires a merged pull request event`);
  }
  if(readinessLifecycle){
    const unchecked = REQUIRED_CI_JOBS.filter(job => !ciItems.some(item => item.text === job && item.checked));
    if(unchecked.length) failures.push(`${lifecycle} requires all four required CI checkboxes to be checked`);
    for(const command of ['npm run governance:check', 'npm test', 'npm run verify', 'git diff --check']){
      const result = verificationResults.get(command) || '';
      const isTierOneLocalException = riskTier === 'Tier 1 - Fast'
        && ['npm test', 'npm run verify'].includes(command)
        && /\bnot[ \\t]+run[ \\t]+locally\b/i.test(result)
        && /\bTier[ \\t]+1\b/i.test(result)
        && /\b(?:docs?|copy|styles?|markup|test-only|non-behavioral)\b/i.test(result);
      if(!isSuccessfulVerificationResult(result) && !isTierOneLocalException){
        failures.push(`${lifecycle} requires successful local verification for: ${command}`);
      }
    }
    const reviewStatus = labeledValue(delivery, 'Review status') || '';
    const normalizedReviewStatus = reviewStatus.normalize('NFKC').trim().replace(/[.!]+$/, '').toLowerCase();
    if(!ALLOWED_POSITIVE_REVIEW_STATUSES.has(normalizedReviewStatus)){
      failures.push(`${lifecycle} requires an exact positive completed independent-review status`);
    }
  }

  const completion = sectionTokens(sections, 'Truthful completion gate');
  const completionItems = taskItems(completion);
  for(const sentence of COMPLETION_SENTENCES){
    if(!completionItems.some(item => item.text === sentence && item.checked)){
      failures.push(`truthful completion checkbox must be checked: ${sentence}`);
    }
  }

  return failures;
}

export function validatePullRequestEvent(event){
  if(event?.action === undefined || event?.pull_request === undefined){
    return { skipped: true, failures: [] };
  }
  const failures = validatePullRequestBody(event.pull_request?.body || '', {
      baseSha: event.pull_request?.base?.sha || '',
      headSha: event.pull_request?.head?.sha || '',
      pullRequestState: event.pull_request?.state || '',
      merged: event.pull_request?.merged === true,
    });
  if(event.pull_request?.user?.login !== REQUIRED_PR_AUTHOR){
    failures.push(`pull request must be authored by ${REQUIRED_PR_AUTHOR}; the human owner reviews it`);
  }
  return {
    skipped: false,
    failures,
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

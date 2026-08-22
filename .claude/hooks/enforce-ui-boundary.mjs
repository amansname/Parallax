import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

const UI_PROTECTED = new Set(['ui/householdFactories.js']);
const STYLE_EXTENSIONS = new Set(['.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ico']);
const ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ico']);

export const LEGACY_ROOT_STYLES = Object.freeze([
  'styles/main.css',
  'styles/household.css',
  'styles/scenarios.css',
  'styles/sequencing.css',
  'styles/goals.css',
  'styles/header.css',
  'styles/tax-buckets.css',
  'styles/tax-aware-withdrawal.css',
  'styles/parallax-layout.css',
]);

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function findRepositoryRoot(startDirectory) {
  let current = resolve(startDirectory);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No Git repository found from ${startDirectory}`);
    current = parent;
  }
}

function nearestExistingPath(candidate) {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function resolvedCandidatePath(repositoryRoot, candidate) {
  const existing = nearestExistingPath(candidate);
  if (!existing) return null;
  const realRoot = realpathSync.native(repositoryRoot);
  const realExisting = realpathSync.native(existing);
  const realCandidate = resolve(realExisting, relative(existing, candidate));
  return isWithin(realRoot, realCandidate) ? realCandidate : null;
}

function normalizeRepoPath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isTestPath(path) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.(?:js|mjs)$/.test(path);
}

function hasHiddenSegment(path) {
  return path.split('/').some(segment => segment.startsWith('.'));
}

export function evaluatePresentationPath(path, { deleting = false } = {}) {
  const normalized = normalizeRepoPath(path);
  if (normalized === 'index.html') {
    return deleting
      ? { allowed: false, reason: 'index.html may be replaced but not deleted' }
      : { allowed: true };
  }
  if (hasHiddenSegment(normalized)) {
    return { allowed: false, reason: `hidden presentation paths are disabled: ${normalized}` };
  }
  if (isTestPath(normalized)) {
    return { allowed: false, reason: `tests are read-only: ${normalized}` };
  }
  if (UI_PROTECTED.has(normalized)) {
    return { allowed: false, reason: `functional UI support is protected: ${normalized}` };
  }

  if (normalized.startsWith('ui/')) {
    return extname(normalized).toLowerCase() === '.js'
      ? { allowed: true }
      : { allowed: false, reason: `ui/ accepts JavaScript presentation modules only: ${normalized}` };
  }
  if (normalized.startsWith('styles/')) {
    return STYLE_EXTENSIONS.has(extname(normalized).toLowerCase())
      ? { allowed: true }
      : { allowed: false, reason: `unsupported design-system file type: ${normalized}` };
  }
  if (normalized.startsWith('assets/')) {
    return ASSET_EXTENSIONS.has(extname(normalized).toLowerCase())
      ? { allowed: true }
      : { allowed: false, reason: `assets/ accepts approved visual assets only: ${normalized}` };
  }

  return { allowed: false, reason: `outside the presentation boundary: ${normalized}` };
}

export function evaluateFileWrite({ cwd, toolName, toolInput }) {
  const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
  if (!filePath) return { allowed: false, reason: `${toolName} did not provide a file path` };

  const root = findRepositoryRoot(cwd);
  const candidate = resolve(filePath);
  const resolvedCandidate = resolvedCandidatePath(root, candidate);
  if (!resolvedCandidate) {
    return { allowed: false, reason: `path escapes the repository: ${candidate}` };
  }
  const repoPath = normalizeRepoPath(relative(root, candidate));
  const requestedDecision = evaluatePresentationPath(repoPath);
  if (!requestedDecision.allowed) return requestedDecision;

  const resolvedRepoPath = normalizeRepoPath(relative(realpathSync.native(root), resolvedCandidate));
  const resolvedDecision = evaluatePresentationPath(resolvedRepoPath);
  return resolvedDecision.allowed
    ? requestedDecision
    : { allowed: false, reason: `path resolves to protected target: ${resolvedRepoPath}` };
}

const SAFE_SHELL_COMMANDS = Object.freeze([
  /^git status --short --branch$/,
  /^git rev-parse --show-toplevel$/,
  /^git rev-parse (?:HEAD|main)$/,
  /^git branch --show-current$/,
  /^git remote -v$/,
  /^git worktree list --porcelain$/,
  /^git diff(?: --(?:check|name-only|stat))?(?: main\.\.\.HEAD)?$/,
  /^npm test$/,
  /^npm run governance:check$/,
  /^npm run verify$/,
  /^npm run preview$/,
  /^npm run site:build$/,
  /^npm run site:verify$/,
  /^node --test \.claude\/hooks\/enforce-ui-boundary\.test\.mjs$/,
  /^node \.claude\/hooks\/enforce-ui-boundary\.mjs --check-worktree main$/,
  /^node \.claude\/hooks\/enforce-ui-boundary\.mjs --verify-replacement$/,
  /^node \.claude\/hooks\/create-ui-checkpoint\.mjs$/,
  /^node \.claude\/hooks\/delete-presentation-file\.mjs (?:ui|styles|assets)\/[A-Za-z0-9_./-]+$/,
]);

export function evaluateShellCommand(command) {
  const normalized = String(command ?? '').trim().replaceAll('\\', '/');
  if (!normalized) return { allowed: false, reason: 'empty shell command blocked' };
  if (/[;&|><`\r\n]/.test(normalized) || normalized.includes('$(')) {
    return { allowed: false, reason: 'shell chaining, redirection, pipelines, and command substitution are disabled' };
  }
  return SAFE_SHELL_COMMANDS.some(pattern => pattern.test(normalized))
    ? { allowed: true }
    : { allowed: false, reason: `shell command is not allowlisted: ${normalized}` };
}

function gitLines(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function parseNameStatus(lines) {
  return lines.flatMap(line => {
    const [status, ...paths] = line.split('\t');
    return paths.map(path => ({ status, path: normalizeRepoPath(path) }));
  });
}

function diffNameStatus(root, args) {
  return parseNameStatus(gitLines(root, ['diff', '--no-renames', '--name-status', ...args]));
}

export function evaluateChangedPaths(entries) {
  const violations = [];
  for (const entry of entries) {
    const decision = evaluatePresentationPath(entry.path, { deleting: entry.status.startsWith('D') });
    if (!decision.allowed) violations.push(`${entry.status}\t${entry.path} (${decision.reason})`);
  }
  return violations;
}

export function collectWorktreeChanges(root, base = 'main') {
  const entries = [
    ...diffNameStatus(root, [`${base}...HEAD`]),
    ...diffNameStatus(root, []),
    ...diffNameStatus(root, ['--cached']),
    ...gitLines(root, ['ls-files', '--others', '--exclude-standard'])
      .map(path => ({ status: 'A?', path: normalizeRepoPath(path) })),
  ];
  const unique = new Map();
  for (const entry of entries) unique.set(`${entry.status}\0${entry.path}`, entry);
  return [...unique.values()];
}

export function checkWorktree(root, base = 'main') {
  const branch = gitLines(root, ['branch', '--show-current'])[0] ?? '';
  const violations = branch.startsWith('claude-ui/')
    ? []
    : [`Current branch must start with claude-ui/; found ${branch || '(detached HEAD)'}`];
  return [...violations, ...evaluateChangedPaths(collectWorktreeChanges(root, base))];
}

export function checkRange(root, range) {
  return evaluateChangedPaths(diffNameStatus(root, [range]));
}

export function verifyReplacement(root) {
  const violations = [];
  for (const path of LEGACY_ROOT_STYLES) {
    if (existsSync(join(root, path))) violations.push(`legacy stylesheet still exists: ${path}`);
  }

  const designEntry = join(root, 'styles', 'design-system', 'styles.css');
  if (!existsSync(designEntry)) violations.push('missing sole design-system entrypoint: styles/design-system/styles.css');

  const rootCss = existsSync(join(root, 'styles'))
    ? readdirSync(join(root, 'styles'), { withFileTypes: true })
      .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.css')
      .map(entry => `styles/${entry.name}`)
    : [];
  for (const path of rootCss) violations.push(`root legacy CSS authority is not allowed: ${path}`);

  const index = readFileSync(join(root, 'index.html'), 'utf8');
  const localStyles = [...index.matchAll(/<link\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => /\brel=["'][^"']*\bstylesheet\b[^"']*["']/i.test(tag))
    .map(tag => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
    .filter(Boolean)
    .filter(href => !/^(?:https?:|data:)/i.test(href))
    .map(href => href.split('?')[0]);
  if (localStyles.length !== 1 || localStyles[0] !== 'styles/design-system/styles.css') {
    violations.push(`index.html must load only styles/design-system/styles.css; found ${localStyles.join(', ') || '(none)'}`);
  }
  if (!index.includes('styles/design-system/styles.css?v=__PARALLAX_ARTIFACT_ID__')) {
    violations.push('design-system stylesheet must retain the immutable artifact ID token');
  }
  if (!index.includes('src/main.js?v=__PARALLAX_ARTIFACT_ID__')) {
    violations.push('index.html must retain the existing src/main.js artifact entrypoint');
  }
  return violations;
}

function printResult(label, violations) {
  if (!violations.length) {
    console.log(`${label} passed.`);
    return 0;
  }
  console.error(`${label} failed:`);
  for (const violation of violations) console.error(`- ${violation}`);
  return 1;
}

async function readHookInput() {
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  return JSON.parse(source);
}

async function main() {
  const [mode, value] = process.argv.slice(2);
  const root = mode ? findRepositoryRoot(process.cwd()) : null;
  if (mode === '--check-worktree') {
    process.exitCode = printResult('Claude UI worktree boundary', checkWorktree(root, value ?? 'main'));
    return;
  }
  if (mode === '--check-range') {
    if (!value) throw new Error('--check-range requires a Git range');
    process.exitCode = printResult('Claude UI PR boundary', checkRange(root, value));
    return;
  }
  if (mode === '--verify-replacement') {
    process.exitCode = printResult('Single design-system authority', verifyReplacement(root));
    return;
  }
  if (mode) throw new Error(`Unknown mode: ${mode}`);

  const input = await readHookInput();
  const toolName = input.tool_name;
  const decision = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(toolName)
    ? evaluateFileWrite({ cwd: input.cwd, toolName, toolInput: input.tool_input })
    : ['Bash', 'PowerShell'].includes(toolName)
      ? evaluateShellCommand(input.tool_input?.command)
      : { allowed: false, reason: `unexpected guarded tool: ${toolName}` };
  if (!decision.allowed) {
    console.error(`Claude UI boundary: ${decision.reason}`);
    process.exitCode = 2;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  main().catch(error => {
    console.error(`Claude UI boundary failed closed: ${error.message}`);
    process.exitCode = 2;
  });
}

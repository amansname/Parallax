import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import process from 'node:process';

function deny(message) {
  console.error(`Parallax UI scope blocked this tool call: ${message}`);
  process.exit(2);
}

async function readPayload() {
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  if (!source.trim()) deny('the hook received no tool-call payload');
  try {
    return JSON.parse(source);
  } catch (error) {
    deny(`the hook received invalid JSON (${error.message})`);
  }
}

function insideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function normalizeFile(root, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    deny('the editing tool did not provide a file path');
  }

  let candidate = rawPath.trim();
  if (process.platform === 'win32' && /^\/[A-Za-z0-9_.-]/.test(candidate)) {
    candidate = candidate.slice(1);
  }

  const absolute = isAbsolute(candidate) || win32.isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(root, candidate);
  if (!insideRoot(root, absolute)) deny(`path is outside the project (${rawPath})`);

  const lexicalRelative = relative(root, absolute).split(sep).join('/');
  if (!existsSync(absolute)) {
    return { absolute, relativePath: lexicalRelative, exists: false };
  }

  if (lstatSync(absolute).isSymbolicLink()) {
    deny(`symbolic-link edits are not allowed (${lexicalRelative})`);
  }
  const real = realpathSync(absolute);
  if (!insideRoot(root, real)) deny(`resolved path is outside the project (${rawPath})`);
  return {
    absolute: real,
    relativePath: relative(root, real).split(sep).join('/'),
    exists: true,
  };
}

function gitOutput(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    deny(`repository state could not be verified (${detail})`);
  }
}

function gitPaths(root, args) {
  const output = gitOutput(root, [...args, '-z']);
  return output ? output.split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/')) : [];
}

function verifyEditCheckout(root, scope) {
  const repositoryRoot = realpathSync(gitOutput(root, ['rev-parse', '--show-toplevel']));
  if (repositoryRoot !== root) {
    deny(`project root is not the active Git worktree (${repositoryRoot})`);
  }

  const requiredPrefix = scope.requiredBranchPrefix;
  const branch = gitOutput(root, ['branch', '--show-current']);
  if (typeof requiredPrefix !== 'string' || !requiredPrefix || !branch.startsWith(requiredPrefix)) {
    deny(`branch must start with ${requiredPrefix || 'the configured task prefix'} (found ${branch || 'detached HEAD'})`);
  }

  const baseRef = scope.requiredBaseRef;
  if (typeof baseRef !== 'string' || !baseRef) deny('the required base reference is missing');
  const counts = gitOutput(root, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`])
    .split(/\s+/)
    .map(Number);
  if (counts.length !== 2 || counts.some(count => !Number.isInteger(count))) {
    deny(`could not interpret ancestry against ${baseRef}`);
  }
  if (counts[0] !== 0) deny(`task branch is ${counts[0]} commit(s) behind ${baseRef}`);

  if (scope.requireNoOutOfScopeChanges === true) {
    const dirtyPaths = new Set([
      ...gitPaths(root, ['diff', '--name-only']),
      ...gitPaths(root, ['diff', '--cached', '--name-only']),
      ...gitPaths(root, ['ls-files', '--others', '--exclude-standard']),
    ]);
    const writable = new Set(scope.writableFiles || []);
    const unrelated = [...dirtyPaths].filter(path => !writable.has(path)).sort();
    if (unrelated.length) {
      deny(`unrelated dirty paths are present (${unrelated.join(', ')})`);
    }
  }
}

const payload = await readPayload();
const rootSource = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
if (!existsSync(rootSource)) deny(`project root does not exist (${rootSource})`);
const root = realpathSync(rootSource);
const scopePath = resolve(root, '.claude', 'ui-scope.json');
if (!existsSync(scopePath) || lstatSync(scopePath).isSymbolicLink()) {
  deny('the protected .claude/ui-scope.json manifest is missing or is a symbolic link');
}

let scope;
try {
  scope = JSON.parse(readFileSync(scopePath, 'utf8'));
} catch (error) {
  deny(`the protected scope manifest is invalid (${error.message})`);
}

const toolName = payload.tool_name || payload.toolName;
const toolInput = payload.tool_input || payload.toolInput || {};

if (toolName === 'Bash') {
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
  const allowedCommands = new Set(scope.allowedCommands || []);
  if (!allowedCommands.has(command)) deny(`shell command is not exactly allowlisted (${command || 'missing command'})`);
  process.exit(0);
}

if (!['Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
  deny(`unexpected tool matched the UI guard (${toolName || 'unknown'})`);
}

verifyEditCheckout(root, scope);

const rawPath = toolInput.file_path || toolInput.notebook_path;
const target = normalizeFile(root, rawPath);
const writable = new Set(scope.writableFiles || []);
const creatable = new Set(scope.creatableFiles || []);

if (target.exists && writable.has(target.relativePath)) process.exit(0);
if (!target.exists && scope.allowCreate === true && creatable.has(target.relativePath)) process.exit(0);

if (!target.exists) deny(`new files are not allowed (${target.relativePath})`);
deny(`file is outside the exact UI implementation manifest (${target.relativePath})`);

import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test, { after, before } from 'node:test';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HOOK_DIR, '..', '..');
const HOOK = join(HOOK_DIR, 'protect-ui-scope.mjs');
const SCOPE = JSON.parse(readFileSync(join(ROOT, '.claude', 'ui-scope.json'), 'utf8'));
const SETTINGS = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
let TEST_ROOT;
let TEST_HOOK;

function git(...args) {
  const result = spawnSync('git', args, {
    cwd: TEST_ROOT,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

before(() => {
  TEST_ROOT = mkdtempSync(join(tmpdir(), 'parallax-ui-guard-'));
  TEST_HOOK = join(TEST_ROOT, '.claude', 'hooks', 'protect-ui-scope.mjs');
  const fixtures = new Set([
    ...SCOPE.writableFiles,
    'engine.js',
    'index.html',
    'src/main.js',
    'ui/cashflow.js',
    'ui/householdFactories.js',
  ]);
  for (const relativePath of fixtures) {
    const absolutePath = join(TEST_ROOT, ...relativePath.split('/'));
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `fixture for ${relativePath}\n`);
  }
  mkdirSync(dirname(TEST_HOOK), { recursive: true });
  copyFileSync(HOOK, TEST_HOOK);
  writeFileSync(join(TEST_ROOT, '.claude', 'ui-scope.json'), `${JSON.stringify(SCOPE, null, 2)}\n`);
  writeFileSync(join(TEST_ROOT, '.claude', 'settings.json'), `${JSON.stringify(SETTINGS, null, 2)}\n`);

  git('init');
  git('config', 'user.name', 'Parallax Guard Test');
  git('config', 'user.email', 'guard-test@invalid.example');
  git('checkout', '-b', 'claude-ui/test');
  git('add', '.');
  git('commit', '-m', 'test fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function invoke(tool_name, tool_input) {
  return spawnSync(process.execPath, [TEST_HOOK], {
    cwd: TEST_ROOT,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: TEST_ROOT,
    },
    input: JSON.stringify({ tool_name, tool_input, cwd: TEST_ROOT }),
    encoding: 'utf8',
  });
}

test('manifest and Claude Edit permissions contain the same exact files', () => {
  const editFiles = SETTINGS.permissions.allow
    .filter(rule => rule.startsWith('Edit(/'))
    .map(rule => rule.slice('Edit(/'.length, -1));
  assert.deepEqual(editFiles, SCOPE.writableFiles);
  assert.equal(SCOPE.allowCreate, false);
  assert.deepEqual(SCOPE.creatableFiles, []);
  for (const relativePath of SCOPE.writableFiles) {
    assert.ok(existsSync(join(ROOT, ...relativePath.split('/'))), `missing writable file: ${relativePath}`);
  }
});

test('direct write scope is limited to exact existing CSS files', () => {
  const javascriptFiles = SCOPE.writableFiles.filter(relativePath => relativePath.endsWith('.js'));
  assert.deepEqual(javascriptFiles, []);
  assert.ok(SCOPE.writableFiles.every(relativePath => relativePath.endsWith('.css')));
  for (const mixedFile of [
    'index.html',
    'src/main.js',
    'ui/cashflow.js',
    'ui/chartLayout.js',
    'ui/designSystemPrimitives.js',
    'ui/goalsHorizon.js',
  ]) {
    assert.ok(!SCOPE.writableFiles.includes(mixedFile), `mixed contract file became writable: ${mixedFile}`);
  }
});

test('manifest and Claude Bash permissions contain the same exact commands', () => {
  const commands = SETTINGS.permissions.allow
    .filter(rule => rule.startsWith('Bash('))
    .map(rule => rule.slice('Bash('.length, -1));
  assert.deepEqual(commands, SCOPE.allowedCommands);
});

test('allows an existing exact presentation file', () => {
  const result = invoke('Edit', { file_path: join(TEST_ROOT, 'styles', 'main.css') });
  assert.equal(result.status, 0, result.stderr);
});

test('blocks the mixed boot and integration file', () => {
  const result = invoke('Edit', { file_path: join(TEST_ROOT, 'src', 'main.js') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the exact UI implementation manifest/);
});

test('blocks declarative integration markup', () => {
  const result = invoke('Edit', { file_path: join(TEST_ROOT, 'index.html') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the exact UI implementation manifest/);
});

test('blocks a mixed financial renderer', () => {
  const result = invoke('Edit', { file_path: join(TEST_ROOT, 'ui', 'cashflow.js') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the exact UI implementation manifest/);
});

test('blocks the financial engine', () => {
  const result = invoke('Edit', { file_path: join(TEST_ROOT, 'engine.js') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the exact UI implementation manifest/);
});

test('blocks the protected Claude configuration', () => {
  const result = invoke('Edit', { file_path: join(TEST_ROOT, '.claude', 'ui-scope.json') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the exact UI implementation manifest/);
});

test('blocks a path outside the task worktree', () => {
  const result = invoke('Edit', { file_path: join(TEST_ROOT, '..', 'outside.css') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the project/);
});

test('blocks a protected file even though it sits under ui', () => {
  const result = invoke('Write', { file_path: join(TEST_ROOT, 'ui', 'householdFactories.js') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the exact UI implementation manifest/);
});

test('blocks creation of a new UI file', () => {
  const result = invoke('Write', { file_path: join(TEST_ROOT, 'ui', 'claude-created.js') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /new files are not allowed/);
});

test('allows an exact read-only Git command', () => {
  const result = invoke('Bash', { command: 'git --no-optional-locks status --short --branch' });
  assert.equal(result.status, 0, result.stderr);
});

test('blocks execution of repository code', () => {
  const result = invoke('Bash', { command: 'npm test' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /shell command is not exactly allowlisted/);
});

test('blocks a publishing command despite broad local permissions', () => {
  const result = invoke('Bash', { command: 'git push origin HEAD' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /shell command is not exactly allowlisted/);
});

test('blocks chained shell commands', () => {
  const result = invoke('Bash', { command: 'git diff && git add .' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /shell command is not exactly allowlisted/);
});

test('blocks edits from a branch outside the designated Claude task prefix', () => {
  git('checkout', '-b', 'codex/not-a-claude-task');
  try {
    const result = invoke('Edit', { file_path: join(TEST_ROOT, 'styles', 'main.css') });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /branch must start with claude-ui\//);
  } finally {
    git('checkout', 'claude-ui/test');
  }
});

test('blocks a permitted edit while an unrelated path is dirty', () => {
  const enginePath = join(TEST_ROOT, 'engine.js');
  writeFileSync(enginePath, 'unrelated engine change\n');
  try {
    const result = invoke('Edit', { file_path: join(TEST_ROOT, 'styles', 'main.css') });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unrelated dirty paths are present \(engine\.js\)/);
  } finally {
    writeFileSync(enginePath, 'fixture for engine.js\n');
  }
});

test('project settings disable bypass, subagents, PowerShell, and MCP tools', () => {
  assert.equal(SETTINGS.permissions.defaultMode, 'dontAsk');
  assert.equal(SETTINGS.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(SETTINGS.permissions.disableAutoMode, 'disable');
  for (const rule of ['Write', 'NotebookEdit', 'PowerShell', 'Agent', 'EnterWorktree', 'mcp__*']) {
    assert.ok(SETTINGS.permissions.deny.includes(rule), `missing deny rule: ${rule}`);
  }
});

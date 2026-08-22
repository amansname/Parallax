import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  evaluateChangedPaths,
  evaluateFileWrite,
  evaluatePresentationPath,
  evaluateShellCommand,
  findRepositoryRoot,
  verifyReplacement,
} from './enforce-ui-boundary.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'parallax-claude-ui-'));
  writeFileSync(join(root, '.git'), 'gitdir: fixture');
  mkdirSync(join(root, 'ui'));
  mkdirSync(join(root, 'styles', 'design-system'), { recursive: true });
  mkdirSync(join(root, 'assets'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'ui', 'screen.js'), 'export {};');
  writeFileSync(join(root, 'ui', 'screen.test.js'), '');
  writeFileSync(join(root, 'ui', 'householdFactories.js'), '');
  writeFileSync(join(root, 'styles', 'design-system', 'styles.css'), ':root {}');
  writeFileSync(join(root, 'assets', 'logo.svg'), '<svg/>');
  writeFileSync(join(root, 'engine.js'), 'export {};');
  writeFileSync(join(root, 'index.html'), [
    '<link rel="stylesheet" href="styles/design-system/styles.css?v=__PARALLAX_ARTIFACT_ID__"/>',
    '<script type="module" src="src/main.js?v=__PARALLAX_ARTIFACT_ID__"></script>',
  ].join('\n'));
  return root;
}

test('repository root is found from presentation subdirectories', () => {
  const root = fixture();
  assert.equal(findRepositoryRoot(join(root, 'styles', 'design-system')), root);
});

test('complete presentation replacement paths are writable', () => {
  for (const path of [
    'index.html',
    'ui/newAppShell.js',
    'styles/design-system/tokens/color.json',
    'styles/design-system/components/button.css',
    'assets/new-logo.svg',
  ]) assert.deepEqual(evaluatePresentationPath(path), { allowed: true }, path);
});

test('functional, test, configuration, and unsupported files are blocked', () => {
  for (const path of [
    'src/main.js',
    'engine.js',
    'ui/screen.test.js',
    'ui/householdFactories.js',
    'ui/notes.md',
    'styles/rules.md',
    '.claude/settings.json',
  ]) assert.equal(evaluatePresentationPath(path).allowed, false, path);
});

test('file writes cannot escape through symlinks', () => {
  const root = fixture();
  symlinkSync(join(root, 'engine.js'), join(root, 'ui', 'escape.js'));
  const decision = evaluateFileWrite({
    cwd: root,
    toolName: 'Edit',
    toolInput: { file_path: join(root, 'ui', 'escape.js') },
  });
  assert.equal(decision.allowed, false);
});

test('shell access is limited to inspection, verification, and guarded mutation', () => {
  for (const command of [
    'git status --short --branch',
    'npm test',
    'npm run verify',
    'npm run site:build',
    'npm run site:verify',
    'node .claude/hooks/create-ui-checkpoint.mjs',
    'node .claude/hooks/delete-presentation-file.mjs styles/main.css',
  ]) assert.deepEqual(evaluateShellCommand(command), { allowed: true }, command);

  for (const command of [
    'git push',
    'git commit -am change',
    'rm styles/main.css',
    'node arbitrary.mjs',
    'npm test && git push',
    'Set-Content engine.js nope',
  ]) assert.equal(evaluateShellCommand(command).allowed, false, command);
});

test('PR scope accepts presentation replacement and rejects protected changes', () => {
  assert.deepEqual(evaluateChangedPaths([
    { status: 'M', path: 'index.html' },
    { status: 'M', path: 'ui/scenarios.js' },
    { status: 'A', path: 'ui/newAppShell.js' },
    { status: 'D', path: 'styles/main.css' },
    { status: 'A', path: 'styles/design-system/components/app-shell.css' },
  ]), []);
  assert.deepEqual(evaluateChangedPaths([
    { status: 'M', path: 'src/main.js' },
    { status: 'M', path: 'ui/scenarios.test.js' },
  ]).length, 2);
});

test('replacement verification requires one new CSS authority and existing JS entrypoint', () => {
  const root = fixture();
  assert.deepEqual(verifyReplacement(root), []);
  writeFileSync(join(root, 'styles', 'main.css'), 'legacy');
  writeFileSync(join(root, 'index.html'), [
    '<link rel="stylesheet" href="styles/main.css?v=__PARALLAX_ARTIFACT_ID__"/>',
    '<link rel="stylesheet" href="styles/design-system/styles.css?v=__PARALLAX_ARTIFACT_ID__"/>',
  ].join('\n'));
  const violations = verifyReplacement(root);
  assert.ok(violations.some(value => value.includes('legacy stylesheet still exists')));
  assert.ok(violations.some(value => value.includes('must load only')));
  assert.ok(violations.some(value => value.includes('src/main.js')));
});

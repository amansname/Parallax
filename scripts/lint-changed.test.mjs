import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changedPathArguments,
  parseArguments,
  parseChangedJavaScriptPaths,
} from './lint-changed.mjs';

test('changed-file lint arguments accept explicit revisions and reject malformed input', () => {
  assert.deepEqual(parseArguments(['--base', 'origin/main', '--head', 'HEAD']), {
    base: 'origin/main',
    head: 'HEAD',
  });
  assert.deepEqual(parseArguments([]), {});
  assert.throws(() => parseArguments(['--base']), /Usage/);
  assert.throws(() => parseArguments(['--other', 'HEAD']), /Usage/);
  assert.throws(() => parseArguments(['--base', 'main', '--base', 'other']), /only once/);
});

test('changed-file lint selects only JavaScript paths in deterministic order', () => {
  const input = [
    'ui/view.js',
    'docs/guide.md',
    'scripts/check.mjs',
    'native/addon.cjs',
    'styles/main.css',
  ].join('\0');
  assert.deepEqual(parseChangedJavaScriptPaths(`${input}\0`), [
    'native/addon.cjs',
    'scripts/check.mjs',
    'ui/view.js',
  ]);
});

test('changed-file lint uses a merge-base diff and safe NUL-delimited paths', () => {
  const base = '1'.repeat(40);
  const head = '2'.repeat(40);
  assert.deepEqual(changedPathArguments(base, head), [
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    '-z',
    `${base}...${head}`,
    '--',
  ]);
  assert.throws(() => changedPathArguments('main', head), /base must resolve/);
});

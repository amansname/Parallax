import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { discoverTestInventory } from '../scripts/run-unit-tests.mjs';

function fixture(t, scripts = {}) {
  const temporaryRoot = tmpdir();
  const root = mkdtempSync(join(temporaryRoot, 'parallax-test-discovery-'));
  t.after(() => {
    const child = relative(temporaryRoot, root);
    assert.match(child, /^parallax-test-discovery-[\w-]+$/);
    rmSync(root, { recursive: true, force: true });
  });
  const write = (path, source = '') => {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, source);
  };
  write('package.json', JSON.stringify({ type: 'module', scripts: {
    pretest: 'node --test pre.test.js',
    'governance:check': 'node --test governance.test.mjs && node validate.mjs',
    ...scripts,
  } }));
  write('pre.test.js');
  write('governance.test.mjs');
  write('unit.test.js');
  return { root, write };
}

test('discovery automatically includes new tests and keeps explicit suites separate', t => {
  const { root, write } = fixture(t);
  write('src/new-feature/new.test.js');
  write('test/nested/new.spec.mjs');
  write('scripts/new.test.cjs');
  for (const directory of ['node_modules', '.worktrees', '.claude/worktrees', '.cache', '.parallax-artifact', 'verify-out', 'coverage']) {
    write(`${directory}/should-not-run.test.js`, 'throw new Error("excluded fixture")');
  }
  assert.deepEqual(discoverTestInventory(root), {
    pretest: ['pre.test.js'],
    unit: ['scripts/new.test.cjs', 'src/new-feature/new.test.js', 'test/nested/new.spec.mjs', 'unit.test.js'],
    governance: ['governance.test.mjs'],
  });
});

test('discovery fails on stale, overlapping, or unrecognized explicit test lists', t => {
  for (const [scripts, expected] of [
    [{ pretest: 'node --test missing.test.js' }, /no longer exists/],
    [{ pretest: 'node --test pre.test.js governance.test.mjs' }, /more than once/],
    [{ pretest: 'node custom-test-runner.js' }, /must start/],
    [{ pretest: 'node --test ../outside.test.js' }, /unsupported test path/],
  ]) {
    const { root } = fixture(t, scripts);
    assert.throws(() => discoverTestInventory(root), expected);
  }
});

test('a newly added failing test makes the real runner fail; fixing it restores success', t => {
  const { root, write } = fixture(t);
  write('scripts/placeholder');
  copyFileSync(new URL('../scripts/run-unit-tests.mjs', import.meta.url), join(root, 'scripts/run-unit-tests.mjs'));
  write('src/new-feature/regression.test.js', "import { test } from 'node:test'; test('new regression', () => { throw new Error('discovery regression sentinel'); });");
  // Model a standalone npm invocation, not another worker of this test process.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['scripts/run-unit-tests.mjs'], {
    cwd: root, env, encoding: 'utf8', windowsHide: true,
  });
  const failing = run();
  assert.equal(failing.status, 1);
  assert.match(failing.stdout + failing.stderr, /discovery regression sentinel/);
  write('src/new-feature/regression.test.js', "import { test } from 'node:test'; test('new regression', () => {});");
  assert.equal(run().status, 0);
});

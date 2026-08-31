import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TEST_FILE = /\.(?:test|spec)\.(?:c|m)?js$/;
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.worktrees', 'worktrees', '.cache',
  '.parallax-artifact', 'verify-out', 'coverage',
]);

function findTests(root, directory = '') {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
      return findTests(root, relativePath);
    }
    return entry.isFile() && TEST_FILE.test(entry.name) ? [relativePath] : [];
  });
}

function explicitTests(command, name) {
  // These two suites intentionally have explicit commands and execution order.
  // Reject an unfamiliar command instead of silently omitting its tests.
  const testCommand = command?.split(' && ')[0];
  if (!testCommand?.startsWith('node --test ')) {
    throw new Error(`${name} must start with an explicit node --test file list`);
  }
  const files = testCommand.slice('node --test '.length).trim().split(/\s+/);
  if (files.some(file => !/^[\w./-]+$/.test(file) || file.startsWith('/')
      || file.split('/').some(part => part === '.' || part === '..') || !TEST_FILE.test(file))) {
    throw new Error(`${name} contains an unsupported test path`);
  }
  return files;
}

export function discoverTestInventory(root) {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const all = findTests(root).sort();
  const pretest = explicitTests(scripts?.pretest, 'pretest');
  const governance = explicitTests(scripts?.['governance:check'], 'governance:check');
  const reserved = new Set();
  for (const file of [...pretest, ...governance]) {
    if (!all.includes(file)) throw new Error(`Explicit test no longer exists in the inventory: ${file}`);
    if (reserved.has(file)) throw new Error(`Test is scheduled more than once: ${file}`);
    reserved.add(file);
  }
  const unit = all.filter(file => !reserved.has(file));
  if (!unit.length) throw new Error('No unit tests discovered');
  return { pretest, unit, governance };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--list')) {
    throw new Error('Usage: node scripts/run-unit-tests.mjs [--list]');
  }
  const inventory = discoverTestInventory(root);
  if (args[0] === '--list') {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }
  console.log(`Running ${inventory.unit.length} discovered unit-test files.`);
  const result = spawnSync(process.execPath, ['--test', ...inventory.unit], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Unit test process terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import { execFileSync } from 'node:child_process';
import {
  checkWorktree,
  collectWorktreeChanges,
  findRepositoryRoot,
} from './enforce-ui-boundary.mjs';

const root = findRepositoryRoot(process.cwd());
const violations = checkWorktree(root, 'main');
if (violations.length) {
  console.error('Guarded checkpoint refused:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

const uncommitted = collectWorktreeChanges(root, 'HEAD');
if (!uncommitted.length) {
  console.error('Guarded checkpoint refused: no presentation changes found.');
  process.exit(1);
}

execFileSync('git', ['add', '--all', '--', 'index.html', 'ui', 'styles', 'assets'], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync('git', ['commit', '-m', 'ui(claude): guarded design checkpoint'], {
  cwd: root,
  stdio: 'inherit',
});
console.log('Guarded presentation checkpoint created. Nothing was pushed.');

import { lstatSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  evaluatePresentationPath,
  evaluateFileWrite,
  findRepositoryRoot,
} from './enforce-ui-boundary.mjs';

const requested = process.argv[2];
if (!requested) {
  console.error('Usage: node .claude/hooks/delete-presentation-file.mjs <presentation-path>');
  process.exit(1);
}

const root = findRepositoryRoot(process.cwd());
const candidate = resolve(root, requested);
const repoPath = relative(root, candidate).replaceAll('\\', '/');
if (isAbsolute(repoPath) || repoPath.startsWith('../')) {
  console.error(`Deletion refused outside repository: ${requested}`);
  process.exit(1);
}
const decision = evaluatePresentationPath(repoPath, { deleting: true });
if (!decision.allowed) {
  console.error(`Deletion refused: ${decision.reason}`);
  process.exit(1);
}
const resolvedDecision = evaluateFileWrite({
  cwd: root,
  toolName: 'guarded deletion',
  toolInput: { file_path: candidate },
});
if (!resolvedDecision.allowed) {
  console.error(`Deletion refused: ${resolvedDecision.reason}`);
  process.exit(1);
}
if (lstatSync(candidate).isDirectory()) {
  console.error(`Deletion refused for directory; remove approved files individually: ${repoPath}`);
  process.exit(1);
}

rmSync(join(root, repoPath), { recursive: false, force: false });
console.log(`Deleted approved presentation file: ${repoPath}`);

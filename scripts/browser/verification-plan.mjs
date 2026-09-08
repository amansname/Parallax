import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_GROUPS } from './verification-runtime.mjs';

// Explicit narrow routes only. Unknown paths, shared code/fixtures and CI
// select every group so new surfaces cannot silently lose browser coverage.
const NARROW_ROUTES = [
  [/^ui\/cashflow\.js$/, ['cashflow']],
  [/^scripts\/browser\/cashflow\/(?!actions\.mjs$).+\.mjs$/, ['cashflow']],
  [/^(?:ui\/goalsHorizon\.js|styles\/goals\.css|scripts\/browser\/goals\.mjs)$/, ['scenarios', 'cashflow']],
  [/^(?:ui\/scenarios(?:Controller)?\.js|styles\/scenarios\.css|scripts\/browser\/scenario-[^/]+\.mjs)$/, ['scenarios', 'cashflow']],
  [/^(?:ui\/sequencing\.js|styles\/sequencing\.css|scripts\/browser\/(?:sequencing|funding)\.mjs)$/, ['cashflow']],
  [/^(?:ui\/taxAwareWithdrawal(?:Columns|Dom)?\.js|ui\/taxBuckets\.js|styles\/(?:tax-aware-withdrawal|tax-buckets)\.css|scripts\/browser\/withdrawal-(?:results|controls)\.mjs)$/, ['entry']],
  [/^scripts\/browser\/withdrawal-(?:fixture|wages|diagnostics)\.mjs$/, ['entry', 'scenarios', 'cashflow']],
  [/^scripts\/browser\/persistence-[^/]+\.mjs$/, ['persistence']],
];

const GOVERNING_DOCS = new Set([
  'AGENTS.md', 'PRINCIPLES.md', 'docs/ARCHITECTURE.md',
  'docs/EXECUTION-PROTOCOL.md', 'docs/CODEX_WORKFLOW.md',
  'docs/CODE_REVIEW.md', 'docs/DEPLOYMENT-INTEGRITY.md', 'docs/GITHUB_SETTINGS.md',
]);

export function selectBrowserGroups(paths, eventName = 'pull_request') {
  if (eventName !== 'pull_request' || !Array.isArray(paths) || paths.length === 0) {
    return [...BROWSER_GROUPS];
  }
  const selected = new Set(['entry']);
  for (const path of paths) {
    if (typeof path !== 'string' || GOVERNING_DOCS.has(path)) return [...BROWSER_GROUPS];
    if (/^(?:docs\/.+\.md|README\.md|scripts\/browser\/README\.md)$/.test(path)) continue;
    const route = NARROW_ROUTES.find(([pattern]) => pattern.test(path));
    if (!route) return [...BROWSER_GROUPS];
    for (const group of route[1]) selected.add(group);
  }
  return BROWSER_GROUPS.filter(group => selected.has(group));
}

export function readChangedPaths(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return [];
  const base = env.PARALLAX_BASE_SHA;
  const head = env.CANDIDATE_SHA;
  if (![base, head].every(sha => /^[0-9a-f]{40}$/i.test(sha || ''))) {
    throw new Error('Browser selection requires full base and candidate commit SHAs');
  }
  // Disabling rename detection includes both old and new paths. A move out of
  // shared/protected code must not become a narrow selection at its new path.
  // Use the system installation on our Ubuntu CI and Windows workstations,
  // rather than searching PATH (which may include writable directories).
  const git = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
  const result = spawnSync(git, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Browser selection diff failed: ${result.stderr.trim()}`);
  return result.stdout.split('\0').filter(Boolean);
}

function main() {
  const paths = readChangedPaths();
  const groups = selectBrowserGroups(paths, process.env.GITHUB_EVENT_NAME);
  const output = JSON.stringify(groups);
  console.log(`Browser groups: ${groups.join(', ')} (${paths.length} changed paths)`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `browser_groups=${output}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Browser coverage\n\nSelected groups: ${groups.join(', ')}.\n\nMain, shared, unknown and empty changes use all groups. PR selections always include entry.\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

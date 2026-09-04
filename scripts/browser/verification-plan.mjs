import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ORDERED_BROWSER_SHARDS = Object.freeze(['startup', 'wizard', 'planning', 'persistence']);

const ALL_SHARDS_PATTERNS = [
  /^\.github\/workflows\/test\.yml$/,
  /^scripts\/verify\.mjs$/,
  /^scripts\/browser\/(?:artifact|artifact-server|browser-session|verification-runtime|verification-plan)\.mjs$/,
  /^(?:engine\.js|src\/main\.js)$/
];

const SHARD_PATTERNS = {
  wizard: [
    /^scripts\/(?:wizard-browser-contract|goals-presentation-browser-contract)\.mjs$/,
    /^scripts\/browser\/wizard\//,
    /^(?:src\/household|ui\/household)/,
    /^styles\/(?:household|wizard)/
  ],
  planning: [
    /^scripts\/browser\/(?:cashflow\/|funding|goals|scenario|sequencing)/,
    /^(?:src|ui|styles)\/(?:cashflow|goals|scenario|sequencing)/i
  ],
  persistence: [
    /^scripts\/browser\/persistence/,
    /^src\/household\/(?:deleteHousehold|householdStore|migrate)/
  ],
  startup: [
    /^scripts\/(?:public-url-browser-contract|rollover-error-browser-contract)\.mjs$/,
    /^scripts\/browser\/(?:design|startup|static-contracts|withdrawal)/,
    /^(?:index\.html|styles\/|src\/tax\/|ui\/tax)/
  ]
};

export function planBrowserShards(paths, { full = false } = {}) {
  if (full || paths.some(path => ALL_SHARDS_PATTERNS.some(pattern => pattern.test(path)))) {
    return [...ORDERED_BROWSER_SHARDS];
  }
  const selected = new Set(['startup']);
  for (const path of paths) {
    for (const [shard, patterns] of Object.entries(SHARD_PATTERNS)) {
      if (patterns.some(pattern => pattern.test(path))) selected.add(shard);
    }
  }
  return ORDERED_BROWSER_SHARDS.filter(shard => selected.has(shard));
}

function changedPaths(baseSha) {
  if (!baseSha) throw new Error('PARALLAX_BASE_SHA is required for change-aware browser verification');
  const diff = spawnSync('git', ['diff', '--name-only', '-z', `${baseSha}...HEAD`], {
    encoding: 'utf8'
  });
  if (diff.status !== 0) throw new Error(diff.stderr || `git diff exited ${diff.status}`);
  return diff.stdout.split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/'));
}

export function buildBrowserShardPlan(env = process.env) {
  const full = env.PARALLAX_VERIFY_ALL_SHARDS === '1';
  return planBrowserShards(full ? [] : changedPaths(env.PARALLAX_BASE_SHA), { full });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(buildBrowserShardPlan()));
}

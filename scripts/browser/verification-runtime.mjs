export function shouldRunUnitSuite(env = process.env) {
  return env.PARALLAX_VERIFY_SKIP_UNIT_TESTS !== '1';
}

export const BROWSER_VERIFICATION_SHARDS = Object.freeze(['startup', 'wizard', 'planning', 'persistence']);

export function selectedBrowserShard(env = process.env) {
  return env.PARALLAX_VERIFY_SHARD || 'all';
}

export function shouldRunBrowserShard(selected, ...shards) {
  if (selected !== 'all' && !BROWSER_VERIFICATION_SHARDS.includes(selected)) {
    throw new Error(`Unknown browser verification shard "${selected}". Expected one of: ${BROWSER_VERIFICATION_SHARDS.join(', ')}`);
  }
  return selected === 'all' || shards.includes(selected);
}

export function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

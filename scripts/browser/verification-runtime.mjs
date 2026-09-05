export function shouldRunUnitSuite(env = process.env) {
  return env.PARALLAX_VERIFY_SKIP_UNIT_TESTS !== '1';
}

export function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

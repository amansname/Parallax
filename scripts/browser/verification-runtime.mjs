export const BROWSER_GROUPS = Object.freeze([
  'entry', 'wizard-runtime', 'wizard-forms', 'scenarios', 'cashflow', 'persistence',
]);

export function selectedBrowserGroup(env = process.env) {
  const group = env.PARALLAX_VERIFY_BROWSER_GROUP ?? 'all';
  if(group !== 'all' && !BROWSER_GROUPS.includes(group)){
    throw new Error(`Unknown browser verification group: ${group}`);
  }
  return group;
}

export function shouldRunBrowserGroup(selected, ...groups) {
  return selected === 'all' || groups.includes(selected);
}

export function shouldRunUnitSuite(env = process.env) {
  return env.PARALLAX_VERIFY_SKIP_UNIT_TESTS !== '1';
}

export function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

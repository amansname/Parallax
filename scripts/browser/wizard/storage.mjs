// Wizard browser contract: storage.

export function exactStorageSnapshot(snapshot) {
  return JSON.stringify(Object.fromEntries(Object.entries(snapshot || {}).sort(([left], [right]) => left.localeCompare(right))));
}
export async function snapshotStorage(page) {
  return page.evaluate(() => {
    const snapshot = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      snapshot[key] = localStorage.getItem(key);
    }
    return snapshot;
  });
}
export async function restoreStorage(page, snapshot) {
  await page.evaluate(entries => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) {
      localStorage.setItem(key, value);
    }
  }, snapshot);
}
export function stableStorageSnapshot(snapshot) {
  const runtimeRecordIds = new Set(['demo', 'default-pre-retirement-solo', 'default-pre-retirement-couple', 'now-household', 'future-household']);
  const runtimeScenarioIds = new Set(['now-household', 'future-household']);
  const ownerStorage = Object.fromEntries(Object.entries(snapshot || {}).flatMap(([key, value]) => {
    if (key === 'parallax.activeHouseholdId') return [];
    if (key.startsWith('parallax.scenarios.')) {
      const householdId = key.slice('parallax.scenarios.'.length, -'.v1'.length);
      if (runtimeScenarioIds.has(householdId)) return [];
    }
    if (key !== 'parallax.households.v1') return [[key, value]];
    const database = JSON.parse(value || 'null');
    const savedHouseholds = Object.fromEntries(Object.entries(database || {}).filter(([householdId]) => !runtimeRecordIds.has(householdId)));
    return [[key, JSON.stringify(savedHouseholds)]];
  }));
  return JSON.stringify(Object.fromEntries(Object.entries(ownerStorage).sort(([left], [right]) => left.localeCompare(right))));
}

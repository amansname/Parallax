// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForWizard } from '../wizard-browser-contract.mjs';
export async function verifyStartup({
  stableGoto,
  PORT,
  page,
  stableReload,
  VERIFIED_ARTIFACT,
  artifactRequests,
  artifactResponses,
  stableClick
}) {
  // Deterministic seed: clear browser-local state, prove the shipped Joe
  // startup, then create a blank durable household through the same visible
  // action an advisor uses. Later contracts continue from it.
  await stableGoto(`http://127.0.0.1:${PORT}/index.html`, {
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await page.evaluate(() => {
    localStorage.clear();
  });
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  const firstRun = await page.evaluate(() => ({
    active: localStorage.getItem('parallax.activeHouseholdId'),
    db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    selected: document.querySelector('#hh-switch')?.value || '',
    rootId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
    primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    spouseName: document.querySelector('[data-wizard-field="spouseName"]')?.value || ''
  }));
  const expectedIds = ['future-household', 'joe-household', 'now-household'];
  if (firstRun.active !== null || firstRun.selected !== 'joe-household' || firstRun.rootId !== 'joe-household' || firstRun.primaryName !== 'Joe' || firstRun.spouseName !== 'Jane') {
    throw new Error(`first run did not hydrate Joe Household: ${JSON.stringify(firstRun)}`);
  }
  if (JSON.stringify(Object.keys(firstRun.db || {}).sort()) !== JSON.stringify(expectedIds)) {
    throw new Error(`first-run household templates are wrong: ${JSON.stringify(firstRun.db)}`);
  }
  const expectedId = VERIFIED_ARTIFACT.manifest.artifactId;
  const expectedCommit = VERIFIED_ARTIFACT.attestation.sourceCommit;
  const wrongVersion = artifactRequests.filter(url => new URL(url).searchParams.get('v') !== expectedId);
  const wrongReceipt = artifactResponses.filter(response => response.artifactId !== expectedId || response.sourceCommit !== expectedCommit);
  if (!artifactRequests.some(url => new URL(url).pathname === '/app.html') || !artifactRequests.some(url => new URL(url).pathname === '/src/main.js')) {
    throw new Error(`browser did not load the artifact application entrypoints: ${JSON.stringify(artifactRequests)}`);
  }
  if (wrongVersion.length || wrongReceipt.length) {
    throw new Error(`browser loaded bytes outside the verified artifact: ${JSON.stringify({
      wrongVersion,
      wrongReceipt
    })}`);
  }
  await stableClick('#hh-menu-btn');
  await page.waitForSelector('#hh-menu-pop:not([hidden]) #hh-new', {
    visible: true
  });
  await stableClick('#hh-new');
  await page.waitForFunction(() => {
    const selected = document.querySelector('#hh-switch')?.value || '';
    return selected && localStorage.getItem('parallax.activeHouseholdId') === selected && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
  }, {
    timeout: 10000
  });
  await waitForWizard(page);
}

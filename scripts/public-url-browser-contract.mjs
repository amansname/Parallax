import assert from 'node:assert/strict';

// Use a separate browser context so URL/reload probes never alter planner fixtures.
export async function runPublicUrlBrowserContract(browser, { baseUrl, artifactId }){
  const root = new URL('./', baseUrl).href;
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url())));
  const waitForCleanApp = async () => {
    await page.waitForFunction(() => (
      document.querySelector('[data-hh-wizard-root]')?.dataset.wizardReady === 'true'
    ), { timeout: 15000 });
    assert.equal(page.url(), root, 'Verified application must display the clean site root');
  };
  const assertVersionedModules = () => {
    const modules = requests.filter(url => (
      url.origin === new URL(root).origin && url.pathname.endsWith('.js')
    ));
    assert.ok(modules.some(url => url.pathname.endsWith('/src/main.js')));
    assert.ok(modules.every(url => url.searchParams.get('v') === artifactId),
      'A clean visible URL must not remove version IDs from module requests');
  };
  try{
    await page.goto(root, { waitUntil: 'networkidle0', timeout: 20000 });
    await waitForCleanApp();
    assertVersionedModules();
    const historyLength = await page.evaluate(() => history.length);

    requests.length = 0;
    await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
    await waitForCleanApp();
    assertVersionedModules();
    assert.ok(requests.some(url => url.pathname.endsWith('/app.html')
      && url.searchParams.get('v') === artifactId), 'Refresh must reopen the versioned app');
    assert.equal(await page.evaluate(() => history.length), historyLength,
      'Startup cleanup must not add a browser-history entry');

    requests.length = 0;
    await page.goto(new URL(`app.html?v=${'0'.repeat(64)}`, root).href,
      { waitUntil: 'networkidle0', timeout: 20000 });
    await waitForCleanApp();
    assertVersionedModules();

    // Simulate an app seeing a newer deployment; only the first app metadata
    // response differs. The root must then select the actual current artifact.
    let changedMetadata = false;
    let failMetadata = false;
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url());
      if(failMetadata && url.pathname.endsWith('/parallax-site.json')){
        await request.respond({ status: 503, body: 'Metadata unavailable' });
      }else if(!changedMetadata && url.pathname.endsWith('/parallax-site.json')
        && request.headers().referer?.includes('/app.html')){
        changedMetadata = true;
        await request.respond({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ schemaVersion: 1, artifactId: '0'.repeat(64) }) });
      }else{
        await request.continue();
      }
    });
    requests.length = 0;
    await page.goto(new URL(`app.html?v=${artifactId}`, root).href,
      { waitUntil: 'networkidle0', timeout: 20000 });
    await waitForCleanApp();
    assert.ok(changedMetadata, 'The stale-app metadata guard must be exercised');
    assert.ok(requests.some(url => url.href === root), 'A stale app must return through the root');
    assertVersionedModules();

    failMetadata = true;
    requests.length = 0;
    const unverifiedUrl = new URL(`app.html?v=${artifactId}`, root).href;
    await page.goto(unverifiedUrl, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.waitForFunction(() => document.body.textContent.includes(
      'Parallax could not verify the deployed site. Refresh to retry.'), { timeout: 10000 });
    assert.equal(page.url(), unverifiedUrl, 'Failed verification must not clean the address');
    assert.ok(!requests.some(url => url.pathname.endsWith('/src/main.js')),
      'Failed metadata verification must not start the application');
  }finally{
    await context.close();
  }
}

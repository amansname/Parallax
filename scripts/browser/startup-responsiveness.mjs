import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForWizard } from '../wizard-browser-contract.mjs';

// Exercise real controls and real workers. Canonical parity runs only after
// the responsiveness measurement, so its intentional main-thread oracle is excluded.
export async function verifyStartupResponsiveness({ browser, url, artifactId, outputDir }) {
  mkdirSync(outputDir, { recursive: true });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const evidence = { artifactId };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1536, height: 864, deviceScaleFactor: 1 });
  try {
    await page.evaluateOnNewDocument(() => {
      const tasks = [];
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
      observer.observe({ type: 'longtask', buffered: true });
      window.readLongTasks = () => {
        tasks.push(...observer.takeRecords().map(e => ({ start: e.startTime, duration: e.duration })));
        return tasks;
      };
      window.observedWorkers = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(workerUrl, options) {
          super(workerUrl, options);
          this.record = { url: String(workerUrl), started: performance.now(), terminated: false };
          window.observedWorkers.push(this.record);
        }
        postMessage(message, ...args) {
          this.record.kind = message.batch?.kind || 'scenarios';
          return super.postMessage(message, ...args);
        }
        terminate() {
          this.record.terminated = true;
          this.record.durationMs = performance.now() - this.record.started;
          return super.terminate();
        }
      };
    });
    await page.goto(url, { waitUntil: 'load' });
    await waitForWizard(page, { householdId: 'joe-household' });
    // The original boot schedules its blocking run after the wizard renders.
    // Wait for its completion, or the candidate's explicit idle-ready state.
    await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'ready'
      || (!document.querySelector('#run-btn')?.disabled && document.querySelector('#status')?.textContent.startsWith('Plan updated')),
    { timeout: 30000 });
    evidence.opening = await page.evaluate(() => ({
      readyMs: performance.now(),
      state: document.documentElement.dataset.scenarioRunState || '',
      workers: window.observedWorkers.length,
      longestTaskMs: Math.max(0, ...window.readLongTasks().map(e => e.duration)),
    }));
    assert.ok(evidence.opening.longestTaskMs < 1000, `Opening blocked for ${evidence.opening.longestTaskMs}ms`);
    assert.equal(evidence.opening.state, 'ready');
    assert.equal(evidence.opening.workers, 0);
    await page.click('#hh-menu-btn');
    await page.waitForSelector('#hh-menu-pop:not([hidden])');
    await page.click('#hh-menu-btn');
    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'running');
    assert.deepEqual(await page.$$eval('#scn-calculation button', buttons => buttons.map(b => b.textContent)), ['Cancel']);
    const interactionStart = Date.now();
    await page.click('.htab[data-page="household"]');
    await page.click('#hh-menu-btn');
    await page.waitForSelector('#hh-menu-pop:not([hidden])');
    evidence.menuDuringRunMs = Date.now() - interactionStart;
    assert.ok(evidence.menuDuringRunMs < 1000, 'Household menu blocked during calculation');
    await page.click('#hh-menu-btn');
    await page.click('.htab[data-page="scenarios"]');
    await page.click('#scn-run-action');
    await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'cancelled');
    evidence.cancel = await page.evaluate(async id => {
      const { scenarios } = await import('/src/state.js?v=' + id);
      return {
        terminated: window.observedWorkers[0].terminated,
        noResults: scenarios.every(s => s.res === null),
        message: document.querySelector('#scn-calculation-status').textContent,
        actions: [...document.querySelectorAll('#scn-calculation button')].map(b => b.textContent),
      };
    }, artifactId);
    assert.equal(evidence.cancel.terminated, true);
    assert.equal(evidence.cancel.noResults, true);
    assert.equal(evidence.cancel.message, 'Calculation cancelled · run to update');
    assert.deepEqual(evidence.cancel.actions, ['Run']);
    await page.screenshot({ path: join(outputDir, 'startup-cancel-desktop.png') });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    assert.equal(await page.$eval('#scn-calculation', panel => panel.getBoundingClientRect().right <= innerWidth), true);
    await page.screenshot({ path: join(outputDir, 'startup-cancel-mobile.png') });
    await page.setViewport({ width: 1536, height: 864, deviceScaleFactor: 1 });
    await page.click('#scn-run-action');
    await page.waitForFunction(() => window.observedWorkers.length === 2);
    await page.click('.cmp-step-btn[data-scn-id="1"][data-lever-key="retireAge"][data-dir="1"]');
    await page.waitForFunction(() => window.observedWorkers.length === 3 && window.observedWorkers[1].terminated);
    await page.click('.htab[data-page="household"]');
    await page.click('#hh-menu-btn');
    await page.select('#hh-switch', 'now-household');
    await waitForWizard(page, { householdId: 'now-household' });
    assert.equal(await page.evaluate(() => window.observedWorkers[2].terminated), true);
    if (await page.$eval('#hh-menu-pop', menu => menu.hidden)) await page.click('#hh-menu-btn');
    await page.select('#hh-switch', 'joe-household');
    await waitForWizard(page, { householdId: 'joe-household' });
    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(() => document.documentElement.dataset.scenarioRunState === 'complete', { timeout: 30000 });
    evidence.calculation = await page.evaluate(async id => {
      const state = await import('/src/state.js?v=' + id);
      return {
        paths: state.sharedPaths.length,
        results: state.scenarios.map(s => ({ name: s.name, available: !!s.res && !s.runError, stress: !!s.res?.stress })),
        workers: window.observedWorkers,
        longestTaskMs: Math.max(0, ...window.readLongTasks().map(e => e.duration)),
      };
    }, artifactId);
    assert.equal(evidence.calculation.paths, 1000);
    assert.deepEqual(evidence.calculation.results.map(s => s.name), ['Baseline', 'Scenario B', 'Aggressive']);
    assert.ok(evidence.calculation.results.every(s => s.available && !s.stress));
    assert.ok(evidence.calculation.longestTaskMs < 1000, 'UI blocked during worker calculation');
    assert.ok(evidence.calculation.workers.every(w => w.url.endsWith('?v=' + artifactId) && w.terminated));
    assert.equal(await page.$eval('#scn-calculation', panel => panel.hidden), true);
    evidence.parity = await page.evaluate(async id => {
      const { scenarios, sharedPaths } = await import('/src/state.js?v=' + id);
      const { defaultPlan: plan } = await import('/engine.js?v=' + id);
      const { planForScenario, leversToOverrides } = await import('/src/scenarios/scenarioConfiguration.js?v=' + id);
      const { runFederalFundingSimulation } = await import('/src/planning/tax/runMonteCarloWithFederalFunding.js?v=' + id);
      let baselineIndex;
      return scenarios.map(s => {
        const p = planForScenario(s.lev);
        const expected = runFederalFundingSimulation(p, leversToOverrides(s.lev), sharedPaths, {
          baseTaxYear: Number.isInteger(plan.meta?.planningAsOfYear) ? plan.meta.planningAsOfYear : new Date().getFullYear(),
          scenarioId: s.name, filingStatus: p.meta?.filingStatus,
          accountDiagnosticsSimIndices: !s.base && Number.isInteger(baselineIndex) ? [baselineIndex] : [],
        });
        if (s.base) baselineIndex = expected.paths.p50.simIndex;
        return { name: s.name, identical: JSON.stringify(expected) === JSON.stringify(s.res), typicalIndex: expected.paths.p50.simIndex };
      });
    }, artifactId);
    assert.ok(evidence.parity.every(s => s.identical), 'Worker output differs from canonical 1000-path calculation');
    // A historical-only network failure must leave a visible way to recover.
    await page.setRequestInterception(true);
    let blockStress = true;
    page.on('request', request => {
      if (blockStress && request.url().includes('/planning/scenarioWorker.js')) request.abort();
      else request.continue();
    });
    await page.click('#scn-seg-focus');
    await page.waitForFunction(() => document.querySelector('.stress-rail')?.textContent.includes('could not run'));
    assert.equal(await page.$eval('#scn-calculation', panel => panel.hidden), false);
    assert.deepEqual(await page.$$eval('#scn-calculation button', buttons => buttons.map(b => b.textContent)), ['Run']);
    blockStress = false;
    await page.click('#scn-run-action');
    await page.waitForFunction(() => document.querySelectorAll('.stress-rail__result').length === 5, { timeout: 30000 });
    evidence.historical = await page.$$eval('.stress-rail__row', rows => rows.map(row => row.textContent.trim()));
    assert.deepEqual(await page.$$eval('.stress-rail__year', years => years.map(year => year.textContent)), ['1966', '1973', '2000', '2008', '1970s']);
    assert.equal(await page.evaluate(() => window.observedWorkers.at(-1).kind), 'stress');
    await page.screenshot({ path: join(outputDir, 'startup-focus.png') });
    assert.deepEqual(errors, []);
    evidence.passed = true;
    return evidence;
  } catch (error) {
    evidence.failure = error.message;
    evidence.pageErrors = errors;
    throw error;
  } finally {
    writeFileSync(join(outputDir, 'startup-responsiveness.json'), JSON.stringify(evidence, null, 2) + '\n');
    await context.close();
  }
}

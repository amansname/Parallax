import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPlan } from '../engine.js';
import { createSelectableDefaultHouseholds } from '../ui/householdFactories.js';
import { selectHouseholdVisible, waitForUnselectedWizard } from './wizard-browser-contract.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8825;

function contentType(path){
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
  })[extname(path)] || 'application/octet-stream';
}

function startServer(){
  const server = createServer(async (request, response) => {
    try{
      const rawPath = request.url === '/' ? '/index.html' : request.url.split('?')[0];
      const relativePath = decodeURIComponent(rawPath).replace(/^\/+/, '');
      const path = resolve(ROOT, relativePath);
      if(path !== ROOT && !path.startsWith(`${ROOT}${sep}`)){
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        'content-type': contentType(path),
        'cache-control': 'no-store',
      });
      response.end(body);
    }catch{
      response.writeHead(404).end();
    }
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolveStart(server));
  });
}

async function waitForRun(page){
  await page.waitForFunction(() => {
    const status = document.querySelector('#status')?.textContent.trim() || '';
    const button = document.querySelector('#run-btn');
    return button && !button.disabled && !/Running/i.test(status);
  }, { timeout: 30000 });
  await page.evaluate(() => {
    const status = document.querySelector('#status');
    const button = document.querySelector('#run-btn');
    const tracker = { sawRunning: false, observed: [] };
    const record = () => {
      const value = status?.textContent.trim() || '';
      if(tracker.observed.at(-1) !== value) tracker.observed.push(value);
      if(/Running/i.test(value)) tracker.sawRunning = true;
    };
    const observer = new MutationObserver(record);
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    globalThis.__defensiveProbeRun = { tracker, observer };
    button.click();
    record();
  });
  await page.waitForFunction(() => {
    const run = globalThis.__defensiveProbeRun;
    const status = document.querySelector('#status')?.textContent.trim() || '';
    const button = document.querySelector('#run-btn');
    return run?.tracker?.sawRunning === true
      && button && !button.disabled
      && /Plan updated|Partial run|Check plan/i.test(status);
  }, { timeout: 30000 });
  return page.evaluate(() => {
    const run = globalThis.__defensiveProbeRun;
    run?.observer?.disconnect();
    const diagnostic = {
      status: document.querySelector('#status')?.textContent.trim() || '',
      observedStatuses: run?.tracker?.observed ?? [],
    };
    delete globalThis.__defensiveProbeRun;
    return diagnostic;
  });
}

const household = createSelectableDefaultHouseholds(defaultPlan, 2026)[0];
household.meta.householdId = 'verify-defensive-1929';
household.meta.name = 'Defensive 1929 Verification';
household.meta.isSelectableDefault = false;
household.simulation.iterations = 200;
const householdId = household.meta.householdId;
const browserErrors = [];
let server = null;
let browser = null;

try{
  server = await startServer();
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.on('console', message => {
    if(message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', error => browserErrors.push(error.message));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, {
    waitUntil: 'networkidle2',
    timeout: 20000,
  });
  await page.evaluate(({ id, plan }) => {
    localStorage.clear();
    localStorage.setItem('parallax.households.v1', JSON.stringify({ [id]: plan }));
  }, { id: householdId, plan: household });
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
  await waitForUnselectedWizard(page);
  await page.click('.htab[data-page="household"]');
  await selectHouseholdVisible(page, householdId);

  const baselineRun = await waitForRun(page);
  if(!/^Plan updated/i.test(baselineRun.status)){
    throw new Error(`Baseline failed: ${JSON.stringify(baselineRun)}`);
  }

  await page.click('button[data-page="scenarios"]');
  await page.waitForSelector('#scn-view .compare', { visible: true, timeout: 30000 });
  await page.select(
    '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
    'defensive',
  );
  await page.waitForFunction(() => (
    document.querySelector(
      '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
    )?.value === 'defensive'
  ), { timeout: 10000 });
  const defensiveRun = await waitForRun(page);
  if(!/^Plan updated/i.test(defensiveRun.status)){
    throw new Error(`Defensive failed: ${JSON.stringify(defensiveRun)}`);
  }

  await page.click('#scn-cash-toggle');
  await page.waitForSelector('#scn-view .cf', { visible: true, timeout: 10000 });
  const scenarioB = await page.evaluate(() => (
    [...document.querySelectorAll('#scn-view [data-cash-select] option')]
      .find(option => /Scenario B/.test(option.textContent))?.value || ''
  ));
  if(!scenarioB) throw new Error('Scenario B Cash Flow option is missing');
  await page.select('#scn-view [data-cash-select]', scenarioB);
  await page.waitForSelector('#cashflow-path-mode', { visible: true, timeout: 10000 });
  await page.select('#cashflow-path-mode', 'historical-1929');
  await page.waitForFunction(() => {
    const root = document.querySelector('#scn-view .cf');
    const rows = [...document.querySelectorAll('#scn-view .cf-row')];
    return root?.dataset.cashPathId === 'historical-1929'
      && root?.dataset.cashPathKind === 'historical'
      && rows.length >= 10
      && Number(rows.find(row => row.dataset.phase === 'retirement')?.dataset.sourceYear) === 1929;
  }, { timeout: 30000 });

  const result = await page.evaluate(id => {
    const scenarioStorage = Object.fromEntries(
      Object.keys(localStorage)
        .filter(key => key.startsWith('parallax.scenarios.'))
        .map(key => [key, JSON.parse(localStorage.getItem(key) || 'null')]),
    );
    const saved = scenarioStorage[`parallax.scenarios.${id}.v1`];
    const root = document.querySelector('#scn-view .cf');
    const rows = [...document.querySelectorAll('#scn-view .cf-row')];
    return {
      allocation: saved?.[1]?.lev?.allocationPresetId ?? null,
      scenarioStorage,
      activeScenario: document.querySelector(
        '#scn-view [data-cash-select]',
      )?.selectedOptions?.[0]?.textContent.trim() || '',
      pathId: root?.dataset.cashPathId || '',
      pathKind: root?.dataset.cashPathKind || '',
      rows: rows.length,
      sourceYear: Number(rows.find(row => row.dataset.phase === 'retirement')?.dataset.sourceYear),
      unavailable: /path is unavailable|retirement handoff could not be verified/i.test(
        document.querySelector('#scn-view')?.textContent || '',
      ),
    };
  }, householdId);
  if(result.allocation !== 'defensive'
      || !/Scenario B/.test(result.activeScenario)
      || result.pathId !== 'historical-1929'
      || result.pathKind !== 'historical'
      || result.rows < 10
      || result.sourceYear !== 1929
      || result.unavailable){
    throw new Error(`Defensive 1929 contract failed: ${JSON.stringify(result)}`);
  }
  console.log(`OK Defensive 1929 rendered: ${JSON.stringify(result)}`);
}catch(error){
  console.error(`${error.stack || error.message || error}\nBrowser errors: ${JSON.stringify(browserErrors)}`);
  process.exitCode = 1;
}finally{
  await browser?.close();
  await new Promise(resolveClose => server?.close(resolveClose));
}

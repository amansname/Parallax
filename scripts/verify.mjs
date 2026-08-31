/* Visual verification probe: test, serve the app, drive headless Chromium
   through the real index.html, and write screenshots to ./verify-out/.
   Exit non-zero if anything fails.

   Run: node scripts/verify.mjs */
import puppeteer from 'puppeteer';
import { existsSync, mkdirSync, readFile, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { generateReturnPath, resetSeed, resolveInputs, runSimulation } from '../engine.js';
import { runMonteCarloWithFederalFunding } from '../src/planning/tax/runMonteCarloWithFederalFunding.js';
import { createBlankTaxProfiles } from '../src/household/factEnvelope.js';
import { assertCleanCandidateWorktree, buildSiteArtifact } from './build-site-artifact.mjs';
import { verifyArtifactBundle } from './site-integrity-lib.mjs';
import { runPublicUrlBrowserContract } from './public-url-browser-contract.mjs';
import { runGoalsPresentationContract } from './goals-presentation-browser-contract.mjs';
import {
  goToWizardStep,
  openNetWorthCategory,
  runWizardBrowserContract,
  selectHouseholdVisible,
  waitForUnselectedWizard,
  waitForWizard,
} from './wizard-browser-contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'verify-out');

function currentCommit(){
  const result = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if(result.status !== 0) throw new Error(`could not resolve verifier commit: ${result.stderr?.trim() || 'git failed'}`);
  return result.stdout.trim();
}

function prepareVerifiedArtifact(){
  const configuredRoot = process.env.PARALLAX_ARTIFACT_ROOT;
  if(!configuredRoot){
    assertCleanCandidateWorktree();
    buildSiteArtifact({ commit: 'HEAD' });
  }
  const artifactRoot = configuredRoot
    ? resolve(ROOT, configuredRoot)
    : join(ROOT, '.parallax-artifact');
  const verified = verifyArtifactBundle(artifactRoot);
  const head = currentCommit();
  if(verified.attestation.sourceCommit !== head){
    throw new Error(
      `browser artifact commit ${verified.attestation.sourceCommit} does not match checked-out candidate ${head}`,
    );
  }
  return verified;
}

const VERIFIED_ARTIFACT = prepareVerifiedArtifact();
const WITHDRAWAL_PLANNER_FIXTURE = JSON.parse(readFileSync(
  join(ROOT, 'test', 'fixtures', 'withdrawal-planner-visible-entry.v1.json'),
  'utf8',
));
let withdrawalPlannerFixtureHouseholdId = null;
const WITHDRAWAL_PLANNER_ORACLE = JSON.parse(readFileSync(
  join(ROOT, 'test', 'fixtures', 'withdrawal-planner-oracle.v1.json'),
  'utf8',
));
const PORT = 8825;
const requestedPort = Number(process.env.PORT || PORT);
if (requestedPort !== PORT) {
  console.error(`Parallax browser verification is fixed at http://127.0.0.1:${PORT}/.`);
  process.exit(1);
}
const SKIP_SEQUENCING = process.env.PARALLAX_VERIFY_SKIP_SEQUENCING === '1';

function step(name, fn){
  return fn().then(
    r => { console.log(`  OK ${name}`); return r; },
    e => { console.error(`  FAIL ${name}\n${e.stack || e.message || e}`); process.exit(1); }
  );
}

function contentType(filePath){
  const ext = filePath.split('.').pop();
  return ext === 'html' ? 'text/html'
    : ext === 'js' ? 'text/javascript'
    : ext === 'css' ? 'text/css'
    : ext === 'png' ? 'image/png'
    : ext === 'svg' ? 'image/svg+xml'
    : 'application/octet-stream';
}

function startStaticServer(){
  const serverRoot = resolve(VERIFIED_ARTIFACT.siteRoot);
  const server = createServer((req, res) => {
    const rawPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const relPath = decodeURIComponent(rawPath).replace(/^\/+/, '');
    const filePath = resolve(serverRoot, relPath);

    if (filePath !== serverRoot && !filePath.startsWith(serverRoot + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }

    readFile(filePath, (err, body) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': contentType(filePath),
        'cache-control': 'no-store',
        'x-parallax-artifact-id': VERIFIED_ARTIFACT.manifest.artifactId,
        'x-parallax-source-commit': VERIFIED_ARTIFACT.attestation.sourceCommit,
      });
      res.end(body);
    });
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(PORT, '127.0.0.1', () => ok(server));
  });
}

function closeServer(server){
  return new Promise(resolveClose => server.close(resolveClose));
}

function jsFilesUnder(dir){
  if(!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes:true }).flatMap(entry => {
    const filePath = join(dir, entry.name);
    if(entry.isDirectory()) return jsFilesUnder(filePath);
    return entry.isFile() && entry.name.endsWith('.js') ? [filePath] : [];
  });
}

function appSource(html){
  const rootModules = readdirSync(ROOT, { withFileTypes:true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => join(ROOT, entry.name));
  const moduleFiles = [
    ...rootModules,
    ...jsFilesUnder(join(ROOT, 'ui')),
    ...jsFilesUnder(join(ROOT, 'src')),
  ];
  return [html, ...moduleFiles.map(file => readFileSync(file, 'utf8'))].join('\n');
}

function verifyTaxBuckets(){
  const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const fails = [];
  const ok = (condition, message) => { if(!condition) fails.push(message); };
  const html = read(join(ROOT, 'index.html'));
  const main = read(join(ROOT, 'src', 'main.js'));
  const view = read(join(ROOT, 'ui', 'taxBuckets.js'));
  const columns = read(join(ROOT, 'ui', 'taxAwareWithdrawalColumns.js'));
  const withdrawalDom = read(join(ROOT, 'ui', 'taxAwareWithdrawalDom.js'));
  const css = read(join(ROOT, 'styles', 'tax-buckets.css'));

  ok(html.includes('styles/tax-buckets.css?v=__PARALLAX_ARTIFACT_ID__'), 'Tax Buckets stylesheet is not artifact-bound');
  ok(html.includes('styles/tax-aware-withdrawal.css?v=__PARALLAX_ARTIFACT_ID__'), 'Tax-Aware Withdrawal stylesheet is not artifact-bound');
  ok(
    SKIP_SEQUENCING
      ? /data-page="scenarios"[\s\S]*data-page="tax-buckets"/.test(html)
      : /data-page="scenarios"[\s\S]*data-page="tax-buckets"[\s\S]*data-page="sequencing"/.test(html),
    SKIP_SEQUENCING ? 'Tax Buckets must follow Scenarios' : 'Tax Buckets must sit between Scenarios and Sequencing',
  );
  ok(/<section class="page" data-page="tax-buckets">[\s\S]*id="tax-buckets-view"/.test(html), 'Tax Buckets page mount is missing');
  ok(/getPlan:\(\)=>plan/.test(main), 'Tax Buckets must read household plan without mutating it');
  ok(/createTaxAwareWithdrawalController/.test(view), 'Withdrawal planner controller is not wired');
  ok(/taxEngineAdapter/.test(read(join(ROOT, 'src', 'planning', 'taxBuckets', 'taxEngineAdapter.js'))), 'Tax engine adapter seam is missing');
  ok(/createTaxBucketsController/.test(main), 'Tax Buckets view controller is not wired');
  ok(!/(?:engine\.js|src\/tax\/|annual1040|ordinaryIncomeTax)/.test(view), 'Tax Buckets UI must not own engine or federal-tax math');
  ok(/thresholdTaxDollars/.test(columns), 'Withdrawal Planner columns must display tax-engine dollar outputs');
  ok(!/label:\s*['"](?:15|20|50|85)%['"]/.test(columns), 'Withdrawal Planner UI must not hardcode federal tax-rate labels');
  ok(!/data-taw-(?:year|fs|mfs|law)/.test(withdrawalDom), 'Withdrawal Planner must use canonical household tax facts without page-local overrides');
  ok(!/Shapley|Attribution unavailable|Conversion and QCD held fixed/.test(withdrawalDom), 'Withdrawal Planner must not render calculation methodology copy');
  ok(!/replay/i.test(view), 'production Tax Buckets UI must not ship a replay control');
  ok(/#tax-buckets-view/.test(css), 'Tax Buckets page mount styling is missing');

  if(fails.length){
    console.error('FAIL Tax Buckets contract:');
    fails.forEach(failure => console.error('  - ' + failure));
    process.exit(1);
  }
  console.log('  OK Tax Buckets contract (withdrawal planner tab, adapter seam, page-scoped styles)');
}

// Cash Flow is a view inside the ScenariosUI layer, toggled by #scn-cash-toggle
// (state.cashActive). Click the chip only when it isn't already in the wanted
// state, then let the single authoritative sync repaint #scn-view.
async function setCashFlow(page, open = true){
  await page.evaluate(wantOpen => {
    const chip = document.querySelector('#scn-cash-toggle');
    const isOn = !!chip?.classList.contains('is-on');
    if(isOn !== wantOpen) chip?.click();
  }, open);
  await page.waitForFunction(wantOpen => {
    const chip = document.querySelector('#scn-cash-toggle');
    const isOn = !!chip?.classList.contains('is-on');
    const cashFlowVisible = !!document.querySelector('#scn-view .cf');
    return isOn === wantOpen && cashFlowVisible === wantOpen;
  }, { timeout: 8000 }, open);
}

// Poll until the Cash Flow view has painted its engine-backed rows. The run is
// async (runAll defers, computes, then ScenariosUI.sync repaints), so a fixed
// sleep is unreliable.
async function waitCashRows(page, min = 1, ms = 8000){
  await page.waitForFunction(
    expected => document.querySelectorAll('#scn-view .cf-row').length >= expected,
    { timeout: ms },
    min
  );
  return page.evaluate(() => document.querySelectorAll('#scn-view .cf-row').length);
}

async function cashFlowSessionSnapshot(page, {
  bundleSentinel = null,
  rememberBundle = false,
  includeBundleIdentity = false,
} = {}){
  return page.evaluate(async options => {
    const state = await import('./src/state.js');
    const sentinels = globalThis.__parallaxVerifySharedPathSentinels
      || (globalThis.__parallaxVerifySharedPathSentinels = Object.create(null));
    if(options.bundleSentinel && options.rememberBundle){
      sentinels[options.bundleSentinel] = state.sharedPaths;
    }
    const sameBundleObject = options.bundleSentinel
      ? Object.prototype.hasOwnProperty.call(sentinels, options.bundleSentinel)
        && sentinels[options.bundleSentinel] === state.sharedPaths
      : null;
    const analyses = state.scenarios.map(scenario => {
      const result = scenario?.res;
      if(!result) return null;
      return {
        projectionStatus: result.projectionStatus,
        issue: result.issue,
        successRate: result.successRate,
        terminal: result.terminal,
        envelope: result.envelope,
        selectedPathIndices: Object.fromEntries(
          Object.entries(result.paths || {}).map(([key, path]) => [key, path?.simIndex ?? null])
        ),
        returnSeriesProvenance: result.returnSeriesProvenance,
        assumptions: result.assumptions,
        survived: result.survived,
        total: result.total,
        medianCagr: result.medianCagr,
        horizonYears: result.horizonYears,
        iterations: result.iterations,
        params: result.params,
        medianLifetimeTax: result.medianLifetimeTax,
        metrics: result.metrics,
      };
    });
    let bundleIdentityHash = null;
    if(options.includeBundleIdentity){
      const sourceYearSequences = (state.sharedPaths || []).map(path => (
        path.map(row => Number.isInteger(row?.y) ? row.y : null)
      ));
      const bytes = new TextEncoder().encode(JSON.stringify(sourceYearSequences));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      bundleIdentityHash = [...new Uint8Array(digest)]
        .map(value => value.toString(16).padStart(2, '0'))
        .join('');
    }
    return {
      seed: state.pathReplay.seed,
      sameBundleObject,
      bundleIdentityHash,
      bundleCount: state.sharedPaths?.length ?? 0,
      bundleHorizon: state.sharedPaths?.[0]?.length ?? 0,
      aggregateBytes: JSON.stringify(analyses),
      probabilityRangeEnvelopeBytes: JSON.stringify(analyses.map(analysis => analysis && ({
        successRate: analysis.successRate,
        terminal: analysis.terminal,
        envelope: analysis.envelope,
      }))),
      successRates: state.scenarios.map(scenario => scenario?.res?.successRate ?? null),
      trialCounts: state.scenarios.map(scenario => scenario?.res?.sims?.length ?? 0),
      typicalIndices: state.scenarios.map(scenario => scenario?.res?.paths?.p50?.simIndex ?? null),
    };
  }, { bundleSentinel, rememberBundle, includeBundleIdentity });
}

async function waitForCashFlowPath(page, {
  pathId,
  kind = null,
  sourceYear = null,
  requireHistoricalSummary = false,
  timeout = 20000,
}){
  const expected = { pathId, kind, sourceYear, requireHistoricalSummary };
  try{
    await page.waitForFunction(want => {
      const selectors = document.querySelectorAll('#cashflow-path-mode');
      const roots = document.querySelectorAll('#scn-view .cf');
      if(selectors.length !== 1 || roots.length !== 1) return false;
      const select = selectors[0];
      const root = roots[0];
      const firstRetirement = root.querySelector('.cf-row[data-phase="retirement"]');
      const summary = root.querySelector('[data-cash-path-metrics]');
      return select.value === want.pathId
        && root.dataset.cashPathId === want.pathId
        && (!want.kind || root.dataset.cashPathKind === want.kind)
        && (want.sourceYear === null
          || Number(firstRetirement?.dataset.sourceYear) === want.sourceYear)
        && (!want.requireHistoricalSummary
          || ['underfunded', 'survives'].includes(summary?.dataset.outcome));
    }, { timeout }, expected);
  }catch(error){
    const observed = await page.evaluate(() => {
      const selectors = [...document.querySelectorAll('#cashflow-path-mode')];
      const roots = [...document.querySelectorAll('#scn-view .cf')];
      const select = selectors[0] ?? null;
      const root = roots[0] ?? null;
      return {
        selectorCount: selectors.length,
        optionValues: select ? [...select.options].map(option => option.value) : [],
        optionLabels: select ? [...select.options].map(option => option.textContent.trim()) : [],
        selectedValue: select?.value ?? null,
        rootCount: roots.length,
        rootPathId: root?.dataset.cashPathId ?? null,
        rootPathKind: root?.dataset.cashPathKind ?? null,
        firstRetirementSourceYear: root
          ?.querySelector('.cf-row[data-phase="retirement"]')?.dataset.sourceYear ?? null,
        summaryOutcome: root?.querySelector('[data-cash-path-metrics]')?.dataset.outcome ?? null,
        regenerateCount: document.querySelectorAll('#cashflow-path-regenerate').length,
        status: document.querySelector('#status')?.textContent.trim() ?? null,
      };
    });
    throw new Error(
      `Cash Flow path readiness timed out: ${JSON.stringify({ expected, observed })}; ${error.message || error}`,
    );
  }
}

/* Household verification now enters through the semantic four-step wizard.
   The retired Balance-Sheet / Map editor and its numeric step selectors are
   intentionally absent from this verifier. */

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('full test suite (npm test)');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const test = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', npmCmd, 'test'], { cwd: ROOT, stdio: 'inherit' })
  : spawnSync(npmCmd, ['test'], { cwd: ROOT, stdio: 'inherit' });
if(test.status !== 0){ console.error('npm test failed'); process.exit(1); }

console.log('Tax Buckets contract (static)');
verifyTaxBuckets();

console.log('serve + drive');
const srv = await startStaticServer();

try {
  const launchOpts = { args: ['--no-sandbox'] };
  const chromeCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for(const chromePath of chromeCandidates){
    if(existsSync(chromePath)){
      launchOpts.executablePath = chromePath;
      break;
    }
  }
  if(!launchOpts.executablePath){
    console.error(
      'No Chrome/Chromium executable found for verify.\n' +
      '  Windows: install Google Chrome, or run: npx puppeteer browsers install chrome\n' +
      '  Or set PUPPETEER_EXECUTABLE_PATH to your chrome.exe path'
    );
    process.exit(1);
  }

  const browser = await puppeteer.launch({ ...launchOpts, headless: true });
  const rawPage = await browser.newPage();
  await rawPage.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 3 });
  // Puppeteer can briefly retain a detached main-frame handle while a prior
  // reload settles. Retry only that transport-level condition; all assertion,
  // selector, and application errors still fail immediately.
  const retryDetachedFrame = async (label, action) => {
    let lastError;
    for(let attempt = 0; attempt < 3; attempt++){
      try{
        return await action();
      }catch(error){
        lastError = error;
        if(!/(?:detached.*frame|frame.*detached)/i.test(error?.message || '') || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        try{
          await rawPage.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 });
        }catch(waitError){
          if(!/(?:detached.*frame|frame.*detached|Execution context was destroyed)/i.test(waitError?.message || '')) throw waitError;
        }
      }
    }
    throw new Error(`${label}: ${lastError?.message || lastError}`);
  };
  // Most verifier operations intentionally use Puppeteer's concise page API.
  // Protect those operations at the page boundary so a transient detached frame
  // cannot fail an otherwise-correct assertion hundreds of lines away. Methods
  // that return element handles are retried only while locating the handle; a
  // genuinely stale handle or application error still fails normally.
  const retryablePageMethods = new Set([
    'click', 'evaluate', '$', '$$', '$eval', '$$eval', 'screenshot', 'setViewport',
  ]);
  const page = new Proxy(rawPage, {
    get(target, property){
      const value = Reflect.get(target, property, target);
      if(typeof value !== 'function') return value;
      const bound = value.bind(target);
      if(!retryablePageMethods.has(property)) return bound;
      return (...args) => retryDetachedFrame(`${String(property)} operation`, () => bound(...args));
    },
  });
  const stableClick = selector => retryDetachedFrame(`click ${selector}`, () => rawPage.click(selector));
  const stableEvaluate = (label, fn, ...args) => retryDetachedFrame(label, () => rawPage.evaluate(fn, ...args));
  const stableGoto = (url, options) => retryDetachedFrame(`navigate ${url}`, () => rawPage.goto(url, options));
  const stableReload = options => retryDetachedFrame('reload page', () => rawPage.reload(options));
  const errs = [];
  const artifactRequests = [];
  const artifactResponses = [];
  const isMutableAppAsset = url => {
    const parsed = new URL(url);
    return parsed.origin === `http://127.0.0.1:${PORT}` && (
      parsed.pathname === '/app.html'
      || parsed.pathname === '/engine.js'
      || /^\/(?:assets|src|styles|ui)\//.test(parsed.pathname)
    );
  };
  rawPage.on('request', request => {
    if(isMutableAppAsset(request.url())) artifactRequests.push(request.url());
  });
  rawPage.on('response', response => {
    if(!isMutableAppAsset(response.url())) return;
    artifactResponses.push({
      url: response.url(),
      artifactId: response.headers()['x-parallax-artifact-id'] || null,
      sourceCommit: response.headers()['x-parallax-source-commit'] || null,
    });
  });
  page.on('pageerror', e => errs.push('PAGE: ' + e.message));
  page.on('console', m => {
    if(m.type() !== 'error') return;
    const message = m.text();
    const sourceUrl = m.location()?.url || '';
    const blockedGoogleFont = message === 'Failed to load resource: net::ERR_NETWORK_ACCESS_DENIED'
      && /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(sourceUrl);
    if(blockedGoogleFont) return;
    errs.push('CON: ' + message + (sourceUrl ? ` @ ${sourceUrl}` : ''));
  });

  const plannerDiagnosticState = () => stableEvaluate(
    'read Withdrawal Planner diagnostic state',
    () => {
      const root = document.querySelector('[data-taw-root]');
      const activeHouseholdId = localStorage.getItem('parallax.activeHouseholdId');
      let current1040 = null;
      try{
        const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
        current1040 = db?.[activeHouseholdId]?.incomeTax?.current1040 ?? null;
      }catch{
        current1040 = null;
      }
      const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
      return {
        activePage: document.querySelector('.page.on')?.dataset.page ?? null,
        activeHouseholdId,
        busy: root?.getAttribute('aria-busy') ?? null,
        renderRevision: Number(root?.dataset.tawRenderRevision ?? -1),
        renderedHouseholdId: root?.dataset.tawHouseholdId ?? null,
        resultCode: root?.dataset.tawResultCode || null,
        wages: text('[data-taw-fact-wages]'),
        ordinaryTax: text('[data-taw-col="ord"] .taw-col-edge span'),
        federalTax: text('[data-taw-federal-tax]'),
        incomeSourcesComplete: current1040?.incomeSourcesComplete === true,
      };
    },
  );

  const waitForPlannerState = async ({
    afterRevision,
    wages,
    ordinaryTax,
    federalTax,
    resultCode,
    incomeSourcesComplete,
  }) => {
    const expected = {
      afterRevision,
      wages,
      ordinaryTax,
      federalTax,
      resultCode,
      incomeSourcesComplete,
    };
    try{
      await page.waitForFunction(want => {
        const root = document.querySelector('[data-taw-root]');
        const activeHouseholdId = localStorage.getItem('parallax.activeHouseholdId');
        let current1040 = null;
        try{
          const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
          current1040 = db?.[activeHouseholdId]?.incomeTax?.current1040 ?? null;
        }catch{
          current1040 = null;
        }
        const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
        return root?.getAttribute('aria-busy') === 'false'
          && Number(root.dataset.tawRenderRevision || -1) > want.afterRevision
          && root.dataset.tawHouseholdId === activeHouseholdId
          && (root.dataset.tawResultCode || null) === want.resultCode
          && text('[data-taw-fact-wages]') === want.wages
          && text('[data-taw-col="ord"] .taw-col-edge span') === want.ordinaryTax
          && text('[data-taw-federal-tax]') === want.federalTax
          && (current1040?.incomeSourcesComplete === true) === want.incomeSourcesComplete;
      }, { timeout: 15000 }, expected);
    }catch(error){
      const observed = await plannerDiagnosticState();
      throw new Error(
        `Withdrawal Planner state timeout: ${JSON.stringify({
          expected,
          observed,
          consoleErrors: errs,
        })}; ${error.message || error}`,
      );
    }
    return plannerDiagnosticState();
  };

  await step('load index.html', async () => {
    // Deterministic seed: clear browser-local state, prove the private
    // unselected startup, then create a blank durable household through the
    // same visible action an advisor uses. Later contracts continue from it.
    await stableGoto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    const firstRun = await page.evaluate(() => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    }));
    const expectedIds = ['future-household', 'now-household'];
    if(firstRun.active !== null){
      throw new Error(`first run activated a household (got "${firstRun.active}")`);
    }
    if(JSON.stringify(Object.keys(firstRun.db || {}).sort()) !== JSON.stringify(expectedIds)){
      throw new Error(`first-run household templates are wrong: ${JSON.stringify(firstRun.db)}`);
    }

    const expectedId = VERIFIED_ARTIFACT.manifest.artifactId;
    const expectedCommit = VERIFIED_ARTIFACT.attestation.sourceCommit;
    const wrongVersion = artifactRequests.filter(url => new URL(url).searchParams.get('v') !== expectedId);
    const wrongReceipt = artifactResponses.filter(response => (
      response.artifactId !== expectedId || response.sourceCommit !== expectedCommit
    ));
    if(!artifactRequests.some(url => new URL(url).pathname === '/app.html')
      || !artifactRequests.some(url => new URL(url).pathname === '/src/main.js')){
      throw new Error(`browser did not load the artifact application entrypoints: ${JSON.stringify(artifactRequests)}`);
    }
    if(wrongVersion.length || wrongReceipt.length){
      throw new Error(`browser loaded bytes outside the verified artifact: ${JSON.stringify({ wrongVersion, wrongReceipt })}`);
    }

    await stableClick('#hh-new');
    await page.waitForFunction(() => {
      const selected = document.querySelector('#hh-switch')?.value || '';
      return selected
        && localStorage.getItem('parallax.activeHouseholdId') === selected
        && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
    }, { timeout: 10000 });
    await waitForWizard(page);
  });

  await step('public URL stays clean while artifact requests remain versioned', async () => {
    await runPublicUrlBrowserContract(browser, {
      baseUrl: `http://127.0.0.1:${PORT}/`,
      artifactId: VERIFIED_ARTIFACT.manifest.artifactId,
    });
  });

  await step('Graphite Aubergine design contracts render at governed viewports', async () => {
    const artifactId = VERIFIED_ARTIFACT.manifest.artifactId;

    await page.setViewport({ width:1279, height:1600, deviceScaleFactor:1 });
    await stableEvaluate('disable nonessential design transitions', () => {
      const style = document.createElement('style');
      style.dataset.verifyMotion = 'disabled';
      style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
      document.head.append(style);
    });
    const desktop = await stableEvaluate('read desktop Graphite Aubergine contract', expectedArtifactId => {
      const rootStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      const headerBar = document.querySelector('.app-header .hdr__bar');
      const themeLinks = [...document.querySelectorAll('link[rel="stylesheet"]')]
        .map(link => link.getAttribute('href'))
        .filter(href => href?.startsWith('styles/parallax-layout.css'));
      const navLabels = [...document.querySelectorAll('.app-header .htab')]
        .map(button => button.textContent.trim());
      return {
        bodyBackground: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        bodyFont: bodyStyle.fontFamily,
        rootOverflowY: rootStyle.overflowY,
        bodyOverflowY: bodyStyle.overflowY,
        headerBars: headerBar ? document.querySelectorAll('.app-header .hdr__bar').length : 0,
        navLabels,
        themeLinks,
        expectedThemeLink: `styles/parallax-layout.css?v=${expectedArtifactId}`,
        spectralLoaded: [...document.querySelectorAll('link[rel="stylesheet"]')]
          .some(link => /Spectral/i.test(link.getAttribute('href') || '')),
      };
    }, artifactId);
    if(desktop.bodyBackground !== 'rgb(24, 25, 24)'
      || desktop.bodyColor !== 'rgb(148, 138, 121)'
      || !desktop.bodyFont.includes('Hanken Grotesk')
      || desktop.rootOverflowY === 'hidden'
      || desktop.bodyOverflowY === 'hidden'){
      throw new Error(`Graphite Aubergine tokens are not active: ${JSON.stringify(desktop)}`);
    }
    if(desktop.headerBars !== 1
      || JSON.stringify(desktop.navLabels) !== JSON.stringify([
        'Household', 'Goals', 'Scenarios', 'Withdrawal planner', 'Sequencing',
      ])){
      throw new Error(`Graphite Aubergine header contract drifted: ${JSON.stringify(desktop)}`);
    }
    if(desktop.themeLinks.length !== 1
      || desktop.themeLinks[0] !== desktop.expectedThemeLink
      || desktop.spectralLoaded){
      throw new Error(`Graphite Aubergine font or artifact stylesheet drifted: ${JSON.stringify(desktop)}`);
    }

    await stableClick('.htab[data-page="tax-buckets"]');
    await page.waitForFunction(() => (
      document.querySelector('.page[data-page="tax-buckets"].on [data-taw-root]')
        ?.getAttribute('aria-busy') === 'false'
    ), { timeout:10000 });
    const plannerPresentation = await stableEvaluate('read Withdrawal Planner presentation contract', () => ({
      pageHead: Boolean(document.querySelector('.page[data-page="tax-buckets"].on .taw-page-head')),
      context: Boolean(document.querySelector('.page[data-page="tax-buckets"].on .taw-plan-context')),
      grid: Boolean(document.querySelector('.page[data-page="tax-buckets"].on .taw-grid')),
    }));
    if(plannerPresentation.pageHead || plannerPresentation.context || !plannerPresentation.grid){
      throw new Error(`Withdrawal Planner compact presentation drifted: ${JSON.stringify(plannerPresentation)}`);
    }

    await stableClick('.htab[data-page="scenarios"]');
    await setCashFlow(page, true);
    const cashFlowTheme = await stableEvaluate('read Cash Flow Graphite Aubergine toggle', () => {
      const chip = document.querySelector('#scn-cash-toggle');
      const label = chip?.querySelector('.cash-chip__label');
      const knob = chip?.querySelector('.switch__knob');
      const paths = [...document.querySelectorAll('#cashflow-path-mode option')]
        .map(option => option.value);
      return {
        checked: chip?.getAttribute('aria-checked'),
        labelColor: label ? getComputedStyle(label).color : null,
        labelBackground: label ? getComputedStyle(label).backgroundColor : null,
        knobColor: knob ? getComputedStyle(knob).backgroundColor : null,
        paths,
      };
    });
    if(cashFlowTheme.checked !== 'true'
      || cashFlowTheme.labelColor !== 'rgb(167, 156, 132)'
      || cashFlowTheme.labelBackground !== 'rgba(0, 0, 0, 0)'
      || cashFlowTheme.knobColor !== 'rgb(177, 132, 92)'
      || cashFlowTheme.paths.length !== 10){
      throw new Error(`Cash Flow Graphite Aubergine contract drifted: ${JSON.stringify(cashFlowTheme)}`);
    }

    await stableClick('.htab[data-sub-target="goals"]');
    await page.waitForFunction(() => document.querySelector('.page[data-page="net-worth"].on .gh-page'), { timeout:10000 });
    await stableClick('[data-goal-chip]');
    await page.waitForFunction(() => document.querySelector('.gh-rail .gh-preset'), { timeout:10000 });
    const goalEditor = await stableEvaluate('read Goals editor timing controls', () => {
      const presets = [...document.querySelectorAll('.gh-rail .gh-preset')];
      return {
        count: presets.length,
        clipped: presets.filter(preset => (
          preset.scrollHeight > preset.clientHeight + 1
          || preset.scrollWidth > preset.clientWidth + 1
        ))
          .map(preset => ({
            text: preset.textContent.trim(),
            scrollHeight: preset.scrollHeight,
            clientHeight: preset.clientHeight,
            scrollWidth: preset.scrollWidth,
            clientWidth: preset.clientWidth,
          })),
        radii: presets.map(preset => parseFloat(getComputedStyle(preset).borderRadius)),
      };
    });
    if(goalEditor.count !== 4
      || goalEditor.clipped.length
      || goalEditor.radii.some(radius => !Number.isFinite(radius) || radius < 4)){
      throw new Error(`Goals timing controls are clipped or square: ${JSON.stringify(goalEditor)}`);
    }
    await stableClick('.gh-rail__close');
    await page.waitForFunction(() => !document.querySelector('.gh-rail'), { timeout:10000 });

    await stableClick('.htab[data-page="household"]');
    await goToWizardStep(page, 'net-worth');
    const netWorthLayout = await stableEvaluate('read Net Worth entry layout', () => {
      const rail = document.querySelector('.nw-rail');
      const primary = rail?.querySelector('.nw-primary-button');
      return {
        summaryRails: document.querySelectorAll('.nw-rail').length,
        footers: document.querySelectorAll('.nw-entry-footer').length,
        railRadius: rail ? parseFloat(getComputedStyle(rail).borderRadius) : null,
        primaryRadius: primary ? parseFloat(getComputedStyle(primary).borderRadius) : null,
        gridWidth: document.querySelector('.nw-grid-region')?.getBoundingClientRect().width ?? 0,
        viewWidth: document.querySelector('.nw-entry-view')?.getBoundingClientRect().width ?? 0,
      };
    });
    if(netWorthLayout.summaryRails !== 1
      || netWorthLayout.footers !== 0
      || !Number.isFinite(netWorthLayout.railRadius)
      || netWorthLayout.railRadius < 4
      || !Number.isFinite(netWorthLayout.primaryRadius)
      || netWorthLayout.primaryRadius < 4
      || Math.abs(netWorthLayout.gridWidth - netWorthLayout.viewWidth) > 1){
      throw new Error(`Net Worth summary rail drifted: ${JSON.stringify(netWorthLayout)}`);
    }

    await goToWizardStep(page, 'tax');
    const taxStack = await stableEvaluate('read Tax profile and IRMAA inputs', () => {
      const boxes = [...document.querySelectorAll('[data-hh-wizard-screen="tax"] [data-tax-summary-box]')];
      const rects = boxes.map(box => box.getBoundingClientRect());
      const controls = [...document.querySelectorAll(
        '[data-hh-wizard-screen="tax"] [data-tax-summary-box] :is(select, .hh-tax-amount)',
      )];
      return {
        count: boxes.length,
        keys: boxes.map(box => box.dataset.taxSummaryBox),
        filingControls: document.querySelectorAll(
          '[data-hh-wizard-screen="tax"] [data-tax-field^="irmaa.lookback."][data-tax-field$=".filingStatus"]',
        ).length,
        controlCount: controls.length,
        wrapperRadii: boxes.map(box => parseFloat(getComputedStyle(box).borderRadius)),
        controlRadii: controls.map(control => parseFloat(getComputedStyle(control).borderRadius)),
        topRowAligned: rects.length >= 3
          && rects.slice(0, 3).every(rect => Math.abs(rect.top - rects[0].top) <= 1),
        lookbackAligned: rects.length >= 5
          && Math.abs(rects[3].left - rects[4].left) <= 1
          && Math.abs(rects[3].width - rects[4].width) <= 1,
        lookbackStacked: rects.length >= 5 && rects[4].top >= rects[3].bottom - 1,
        taxableCompanions: document.querySelectorAll(
          '[data-tax-field="income.taxableIra"], [data-tax-field="income.taxablePensions"]',
        ).length,
        socialSecuritySource: [...document.querySelectorAll('.hh-tax-subsection h3')]
          .some(heading => heading.textContent.trim() === 'Social Security source'),
      };
    });
    if(taxStack.count !== 5
      || JSON.stringify(taxStack.keys) !== JSON.stringify([
        'tax-year', 'filing-status', 'deduction-method', 'irmaa-2024', 'irmaa-2025',
      ])
      || taxStack.filingControls !== 0
      || taxStack.controlCount !== 4
      || !taxStack.topRowAligned
      || !taxStack.lookbackAligned
      || !taxStack.lookbackStacked
      || taxStack.taxableCompanions !== 0
      || !taxStack.socialSecuritySource
      || taxStack.wrapperRadii.some(radius => !Number.isFinite(radius) || radius !== 0)
      || taxStack.controlRadii.some(radius => !Number.isFinite(radius) || radius < 4)){
      throw new Error(`Tax profile and IRMAA layout drifted: ${JSON.stringify(taxStack)}`);
    }

    await page.setViewport({ width:760, height:1600, deviceScaleFactor:1 });
    for(const contract of [
      { page:'net-worth', ready:'.gh-page' },
      { page:'tax-buckets', ready:'[data-taw-root][aria-busy="false"]' },
      { page:'sequencing', ready:'#seq-prints' },
      { page:'household', ready:'[data-wizard-ready="true"]' },
    ]){
      await stableClick(`.htab[data-page="${contract.page}"]`);
      await page.waitForFunction(({ pageName, selector }) => (
        !!document.querySelector(`.page[data-page="${pageName}"].on ${selector}`)
      ), { timeout:10000 }, { pageName:contract.page, selector:contract.ready });
      const width = await stableEvaluate(`read ${contract.page} mobile width`, () => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      if(width.scrollWidth > width.clientWidth){
        throw new Error(`${contract.page} overflows the 760px viewport: ${JSON.stringify(width)}`);
      }
    }
  });

  await step('Tax wizard: saved Wages reach Withdrawal Planner without Continue', async () => {
    await page.setViewport({ width:1440, height:900, deviceScaleFactor:1 });
    const blankPlanner = await plannerDiagnosticState();
    await stableClick('.htab[data-page="tax-buckets"]');
    await waitForPlannerState({
      afterRevision: blankPlanner.renderRevision,
      wages: '$0',
      ordinaryTax: '\u2014',
      federalTax: '\u2014',
      resultCode: 'WITHDRAWAL_CURRENT_TAX_BASELINE_UNAVAILABLE',
      incomeSourcesComplete: false,
    });

    await goToWizardStep(page, 'family');
    const familyRevision = await page.$eval(
      '[data-hh-wizard-root]',
      root => Number(root.dataset.renderRevision || -1),
    );
    const [birthYear, birthMonth, birthDay] =
      WITHDRAWAL_PLANNER_FIXTURE.family.birthDate.split('-');
    const birthDateSelector = '[data-birth-date-group="client"] [data-birth-date-display]';
    await stableClick(birthDateSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(`${birthMonth} / ${birthDay} / ${birthYear}`);
    await page.keyboard.press('Tab');
    await waitForWizard(page, {
      step: 'family',
      afterRevision: familyRevision,
    });

    await goToWizardStep(page, 'tax');
    const wageSelector = '[data-hh-wizard-screen="tax"] [data-tax-field="income.wages.client"]';
    const beforeEdit = await page.evaluate(selector => {
      const fields = [...document.querySelectorAll(selector)];
      const root = document.querySelector('[data-hh-wizard-root]');
      return {
        count: fields.length,
        value: fields[0]?.value ?? null,
        disabled: fields[0]?.disabled ?? null,
        revision: Number(root?.dataset.renderRevision || -1),
      };
    }, wageSelector);
    if(beforeEdit.count !== 1 || beforeEdit.value !== '' || beforeEdit.disabled !== false){
      throw new Error(`blank Tax wizard Client wages input is not editable: ${JSON.stringify(beforeEdit)}`);
    }

    await stableClick(wageSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    for(const [index, digit] of [...'50000'].entries()){
      await page.keyboard.press(digit);
      await page.waitForFunction((selector, digitCount) => {
        const value = document.querySelector(selector)?.value ?? '';
        return value.replace(/\D/g, '').length === digitCount;
      }, { timeout: 5000 }, wageSelector, index + 1);
    }
    // Moving focus through Chromium exercises the production input, change, and
    // blur path instead of assigning a value or dispatching a synthetic event.
    await page.keyboard.press('Tab');
    await waitForWizard(page, {
      step: 'tax',
      afterRevision: beforeEdit.revision,
    });
    const committedWages = await page.$eval(wageSelector, input => input.value);
    if(committedWages !== '50,000'){
      throw new Error(`Tax wizard did not commit Wages through change/blur: ${JSON.stringify({ committedWages })}`);
    }

    const beforePlanner = await plannerDiagnosticState();
    await stableClick('.htab[data-page="tax-buckets"]');
    await waitForPlannerState({
      afterRevision: beforePlanner.renderRevision,
      wages: '$50,000',
      ordinaryTax: '$3,820',
      federalTax: '$3,820',
      resultCode: null,
      incomeSourcesComplete: false,
    });
    const planner = await page.evaluate(() => ({
      wages: document.querySelector('[data-taw-fact-wages]')?.textContent.trim() ?? null,
      wageTag: document.querySelector('[data-taw-fact-wages]')?.tagName ?? null,
      legacyWageInputs: document.querySelectorAll(
        '[data-taw-wages], input[data-taw-fact-wages]',
      ).length,
      incomeTax: document.querySelector('[data-taw-col="ord"] .taw-col-edge span')
        ?.textContent.trim() ?? null,
    }));
    if(planner.wages !== '$50,000'
        || planner.wageTag !== 'SPAN'
        || planner.legacyWageInputs !== 0
        || planner.incomeTax !== '$3,820'){
      throw new Error(`Tax wizard Wages did not reach Withdrawal Planner: ${JSON.stringify(planner)}`);
    }
  });

  await step('enter funded Withdrawal Planner household through visible production controls', async () => {
    await stableClick('.htab[data-page="household"]');
    const savedRuntimeEdit = await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      const active = localStorage.getItem('parallax.activeHouseholdId');
      const record = db?.[active];
      const wages = (record?.income?.other || []).filter(row =>
        row?.typeId === 'wages' && row?.owner === 'client');
      return {
        active,
        rootHouseholdId: document.querySelector('[data-hh-wizard-root]')
          ?.dataset.householdId || '',
        runtimeSourceHouseholdId: record?.meta?.runtimeSourceHouseholdId || '',
        wages,
        optionCount: [...document.querySelectorAll('#hh-switch option')]
          .filter(option => option.value === active).length,
      };
    });
    if(!savedRuntimeEdit.active
        || savedRuntimeEdit.rootHouseholdId !== savedRuntimeEdit.active
        || savedRuntimeEdit.runtimeSourceHouseholdId
        || savedRuntimeEdit.wages.length !== 1
        || savedRuntimeEdit.wages[0]?.amount !== 50000
        || savedRuntimeEdit.optionCount !== 1){
      throw new Error(`Blank custom wages did not persist as one durable household: ${JSON.stringify(savedRuntimeEdit)}`);
    }
    await waitForWizard(page, { householdId: savedRuntimeEdit.active });
    await goToWizardStep(page, 'family');
    await stableClick('#hh-menu-btn');
    const priorHouseholdId = await page.$eval('#hh-switch', selector => selector.value);
    await stableClick('#hh-new');
    await page.waitForFunction(previousId => {
      const selected = document.querySelector('#hh-switch')?.value;
      const active = localStorage.getItem('parallax.activeHouseholdId');
      return selected && selected !== previousId
        && active === selected
        && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
    }, { timeout: 10000 }, priorHouseholdId);
    withdrawalPlannerFixtureHouseholdId = await page.evaluate(
      () => localStorage.getItem('parallax.activeHouseholdId'),
    );
    const fixture = {
      ...WITHDRAWAL_PLANNER_FIXTURE,
      householdId: withdrawalPlannerFixtureHouseholdId,
    };
    const currentRevision = () => page.$eval(
      '[data-hh-wizard-root]',
      root => Number(root.dataset.renderRevision || -1),
    );
    const typeAndBlur = async (selector, value, { waitForRender = true } = {}) => {
      const before = await currentRevision();
      await stableClick(selector);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.type(String(value));
      await page.keyboard.press('Tab');
      if(waitForRender){
        await waitForWizard(page, { afterRevision: before });
      }
    };
    const assertFixtureTaxAutosave = async stage => {
      const persisted = await page.evaluate(householdId => {
        const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
        const current = db?.[householdId]?.incomeTax?.current1040;
        const activeHouseholdId = localStorage.getItem('parallax.activeHouseholdId');
        const activeCurrent = db?.[activeHouseholdId]?.incomeTax?.current1040;
        return {
          requestedHouseholdId: householdId,
          activeHouseholdId,
          incomeSourcesComplete: current?.incomeSourcesComplete === true,
          activeIncomeSourcesComplete: activeCurrent?.incomeSourcesComplete === true,
        };
      }, fixture.householdId);
      if(persisted.activeHouseholdId !== persisted.requestedHouseholdId
          || persisted.incomeSourcesComplete
          || persisted.activeIncomeSourcesComplete){
        throw new Error(
          `Funded fixture Tax autosave drifted ${stage}: ${JSON.stringify(persisted)}`,
        );
      }
    };

    await goToWizardStep(page, 'family');
    await typeAndBlur(
      '[data-wizard-field="primaryName"]',
      fixture.family.primaryName,
    );
    await page.waitForFunction(() => {
      const active = localStorage.getItem('parallax.activeHouseholdId');
      return active
        && [...document.querySelectorAll('#hh-switch option')]
          .some(option => option.value === active);
    }, { timeout: 10000 });
    const durableFixtureHousehold = await page.evaluate(() => {
      const active = localStorage.getItem('parallax.activeHouseholdId');
      return {
        active,
        optionCount: [...document.querySelectorAll('#hh-switch option')]
          .filter(option => option.value === active).length,
      };
    });
    if(!durableFixtureHousehold.active
        || durableFixtureHousehold.optionCount !== 1){
      throw new Error(
        `Funded fixture did not resolve to one durable household: ${JSON.stringify(durableFixtureHousehold)}`,
      );
    }
    withdrawalPlannerFixtureHouseholdId = durableFixtureHousehold.active;
    fixture.householdId = durableFixtureHousehold.active;
    await page.select('#hh-switch', durableFixtureHousehold.active);
    await waitForWizard(page, { householdId: durableFixtureHousehold.active });
    const [birthYear, birthMonth, birthDay] = fixture.family.birthDate.split('-');
    await typeAndBlur(
      '[data-birth-date-group="client"] [data-birth-date-display]',
      `${birthMonth} / ${birthDay} / ${birthYear}`,
    );
    await typeAndBlur(
      '[data-wizard-field="client.retirementAge"]',
      fixture.family.retirementAge,
    );
    await typeAndBlur(
      '[data-wizard-field="client.planEndAge"]',
      fixture.family.planEndAge,
    );

    await goToWizardStep(page, 'tax');
    await typeAndBlur(
      '[data-hh-wizard-screen="tax"] [data-tax-field="income.wages.client"]',
      fixture.tax.wages,
    );
    await assertFixtureTaxAutosave('after visible Tax entry');

    await openNetWorthCategory(page, 'investment');
    for(const account of fixture.accounts){
      let before = await currentRevision();
      await stableClick(
        `[data-hh-action="net-worth-pick-type"][data-account-type-id="${account.typeId}"]`,
      );
      await waitForWizard(page, { step: 'net-worth', afterRevision: before });
      await typeAndBlur(
        '[data-net-worth-draft="name"]',
        account.institution,
        { waitForRender: false },
      );
      await stableClick('[data-net-worth-draft="owner"]');
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await typeAndBlur(
        '[data-net-worth-draft="value"]',
        account.balance,
        { waitForRender: false },
      );
      before = await currentRevision();
      await stableClick('[data-hh-action="net-worth-save-entry"]');
      await waitForWizard(page, { step: 'net-worth', afterRevision: before });
    }
    await assertFixtureTaxAutosave('after account entry');
    await stableClick('[data-net-worth-overlay] [data-hh-action="net-worth-close-panel"]');

    await stableClick('.htab[data-sub-target="goals"]');
    await page.waitForSelector('.gh-page', { visible:true, timeout:8000 });
    await stableClick('[data-goal-chip="system:essentials"]');
    await stableClick('.gh-amount-input');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(fixture.goals.essentialsAnnual));
    await page.keyboard.press('Tab');
    await page.waitForFunction(expected => (
      document.querySelector('.gh-amount-input')?.value === expected.toLocaleString('en-US')
    ), { timeout:8000 }, fixture.goals.essentialsAnnual);
    await assertFixtureTaxAutosave('after Goals edit');

    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await page.select('#hh-switch', fixture.householdId);
    await waitForWizard(page, { householdId: fixture.householdId });
    await assertFixtureTaxAutosave('after reload');
  });

  await step('Tax Buckets: production household loads with funded limits and live tax output', async () => {
    await page.setViewport({ width:1440, height:900, deviceScaleFactor:1 });
    const beforePlanner = await plannerDiagnosticState();
    await stableClick('.htab[data-page="tax-buckets"]');
    await waitForPlannerState({
      afterRevision: beforePlanner.renderRevision,
      wages: '$50,000',
      ordinaryTax: '$3,820',
      federalTax: '$3,820',
      resultCode: null,
      incomeSourcesComplete: false,
    });
    const planner = await page.evaluate(() => ({
      active: document.querySelector('.page.on')?.dataset.page || '',
      columns: document.querySelectorAll('[data-taw-col]').length,
      sliders: document.querySelectorAll('.taw-range').length,
      enabledSliders: document.querySelectorAll('.taw-range:not(:disabled)').length,
      sliderCaps: Object.fromEntries(Array.from(
        document.querySelectorAll('.taw-range'),
        input => [input.dataset.tawLever, Number(input.max)],
      )),
      householdId: document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId ?? null,
      realizedGainLabel: document.querySelector(
        '[data-taw-slider="realizedGain"] .taw-slider-label',
      )?.textContent.trim() ?? null,
      ord: !!document.querySelector('[data-taw-col="ord"]'),
    }));
    if(planner.active !== 'tax-buckets') throw new Error(`Tax Buckets tab not active: ${JSON.stringify(planner)}`);
    if(planner.columns !== 4 || !planner.ord) throw new Error(`Withdrawal planner layout incomplete: ${JSON.stringify(planner)}`);
    if(planner.sliders !== 5) throw new Error(`Withdrawal planner expected five sliders: ${planner.sliders}`);
    if(planner.enabledSliders !== 5 || Object.values(planner.sliderCaps).some(cap => !(cap > 0))){
      throw new Error(`funded Withdrawal Planner sliders are not enabled: ${JSON.stringify(planner)}`);
    }
    if(
      planner.sliderCaps.rothConversion !== 500000
      || planner.sliderCaps.deferredWithdrawal !== 500000
      || planner.sliderCaps.realizedGain !== 500000
      || planner.sliderCaps.rothWithdrawal !== 400000
    ) {
      throw new Error(`Withdrawal Planner display ceilings are wrong: ${JSON.stringify(planner.sliderCaps)}`);
    }
    if(
      planner.householdId !== withdrawalPlannerFixtureHouseholdId
      || planner.realizedGainLabel !== 'Realized gain'
    ) {
      throw new Error(`Withdrawal Planner did not load the selected production household: ${JSON.stringify(planner)}`);
    }

    const thresholdProof = await page.evaluate(() => {
      const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
      return {
        ordinary: text('[data-taw-col="ord"] .taw-col-edge span'),
        ltcg: text('[data-taw-col="ltcg"] .taw-col-edge span'),
        irmaa: text('[data-taw-col="irmaa"] .taw-col-edge span'),
        socialSecurity: text('[data-taw-col="ss"] .taw-col-edge span'),
        federalTax: text('[data-taw-federal-tax]'),
        effectiveRate: text('[data-taw-effective-rate]'),
        marginalRate: text('[data-taw-marginal-rate]'),
      };
    });
    const expected = WITHDRAWAL_PLANNER_FIXTURE.plannerOracle.baseline;
    if(
      thresholdProof.ordinary !== expected.ordinary
      || thresholdProof.ltcg !== expected.longTermGainTax
      || thresholdProof.socialSecurity !== expected.socialSecurityTax
      || thresholdProof.irmaa !== expected.irmaaAnnual
      || thresholdProof.federalTax !== expected.federalTax
      || thresholdProof.effectiveRate !== expected.effectiveRate
      || thresholdProof.marginalRate !== expected.marginalRate
    ) {
      throw new Error(`rendered threshold contract differs from literal oracle: ${JSON.stringify({ thresholdProof, expected })}`);
    }

    const plannerControls = await page.evaluate(() => ({
      localTaxOverrides: document.querySelectorAll(
        '[data-taw-year], [data-taw-fs], [data-taw-mfs], [data-taw-law]',
      ).length,
      methodologyCopy: document.querySelectorAll('.taw-att-note').length,
      wageTag: document.querySelector('[data-taw-fact-wages]')?.tagName ?? null,
      fixedIncomeInputs: document.querySelectorAll(
        'input[data-taw-fact-wages], input[data-taw-fact-ss], input[data-taw-fact-other]',
      ).length,
      fixedIncomeOrder: Array.from(
        document.querySelector('.taw-income-list')?.children || [],
        element => element.className,
      ),
      amountRightEdges: [
        '[data-taw-fact-ss]',
        '[data-taw-fact-wages]',
        '[data-taw-fact-other]',
        '[data-taw-baseline-total]',
        '[data-taw-slider-val="rothConversion"]',
        '[data-taw-slider-val="rothWithdrawal"]',
        '[data-taw-slider-val="qcd"]',
        '[data-taw-slider-val="deferredWithdrawal"]',
        '[data-taw-slider-val="realizedGain"]',
      ].map(selector => document.querySelector(selector)?.getBoundingClientRect().right ?? null),
    }));
    const amountEdges = plannerControls.amountRightEdges.filter(Number.isFinite);
    if(
      plannerControls.localTaxOverrides !== 0
      || plannerControls.methodologyCopy !== 0
      || plannerControls.wageTag !== 'SPAN'
      || plannerControls.fixedIncomeInputs !== 0
      || plannerControls.fixedIncomeOrder.join('|') !== [
        'taw-income-heading',
        'taw-income-row',
        'taw-income-row',
        'taw-income-row',
        'taw-income-total',
      ].join('|')
      || amountEdges.length !== 9
      || Math.max(...amountEdges) - Math.min(...amountEdges) > 0.5
    ) {
      throw new Error(`Withdrawal Planner contains non-canonical controls or copy: ${JSON.stringify(plannerControls)}`);
    }

    const plannerSnapshot = () => page.evaluate(() => {
      const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
      const inventory = Array.from(document.querySelectorAll('[data-taw-col]'), column => [
        column.dataset.tawCol, column.querySelector('.taw-col-name')?.textContent.trim(),
      ]);
      const expectedInventory = [
        ['ord', 'Income Tax'], ['ltcg', 'Long-term gains'],
        ['irmaa', 'Medicare IRMAA'], ['ss', 'Social Security'],
      ];
      if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
        throw new Error(`Withdrawal column inventory drifted: ${JSON.stringify(inventory)}`);
      }
      const columns = Object.fromEntries(['ord', 'ltcg', 'irmaa', 'ss'].map(id => {
        const column = document.querySelector(`[data-taw-col="${id}"]`);
        const base = column?.querySelector('.taw-col-base');
        const fill = column?.querySelector('.taw-col-fill');
        const gap = column?.querySelector('.taw-col-gap');
        const edge = column?.querySelector('.taw-col-edge');
        const paint = {};
        for (const [region, element, extent] of [
          ['base', base, base?.style.height],
          ['fill', fill, fill?.style.height],
          ['edge', edge, edge?.style.bottom],
        ]) {
          if (!element) throw new Error(`Missing ${id} ${region}`);
          const style = getComputedStyle(element);
          paint[region] = { image: style.backgroundImage, color: style.backgroundColor };
          if (parseFloat(extent) > 0 && style.backgroundImage === 'none'
            && ['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor)) {
            throw new Error(`Funded threshold paint is transparent: ${id} ${region}`);
          }
        }
        return [id, {
          paint,
          value: text(`[data-taw-col="${id}"] .taw-col-edge span`),
          baseStyle: base?.style.height ?? null,
          fillStyle: fill?.style.height ?? null,
          gapStyle: gap?.style.height ?? null,
          basePixels: base?.getBoundingClientRect().height ?? null,
          fillPixels: fill?.getBoundingClientRect().height ?? null,
          gapPixels: gap?.getBoundingClientRect().height ?? null,
        }];
      }));
      return {
        revision: Number(document.querySelector('[data-taw-root]')?.dataset.tawRenderRevision || -1),
        federalTax: text('[data-taw-federal-tax]'),
        effectiveRate: text('[data-taw-effective-rate]'),
        marginalRate: text('[data-taw-marginal-rate]'),
        taxCaused: {
          roth: text('[data-taw-caused="roth"] [data-taw-caused-val]'),
          traditional: text('[data-taw-caused="traditional"] [data-taw-caused-val]'),
          taxable: text('[data-taw-caused="taxable"] [data-taw-caused-val]'),
        },
        columns,
      };
    });
    const exerciseLever = async key => {
      const effect = WITHDRAWAL_PLANNER_ORACLE.leverEffects[key];
      if(!effect) throw new Error(`literal lever-effect oracle is missing: ${key}`);
      const selector = `[data-taw-lever="${key}"]`;
      const before = await plannerSnapshot();
      const control = await page.$eval(selector, input => ({
        disabled: input.disabled,
        min: Number(input.min),
        max: Number(input.max),
      }));
      if(control.disabled || !(control.max > control.min)){
        throw new Error(`funded Planner lever is unavailable: ${JSON.stringify({ key, control })}`);
      }
      await stableClick(selector);
      await page.keyboard.press('End');
      await page.waitForFunction(({ leverKey, previousRevision }) => {
        const root = document.querySelector('[data-taw-root]');
        const input = document.querySelector(`[data-taw-lever="${leverKey}"]`);
        return root?.getAttribute('aria-busy') === 'false'
          && Number(root.dataset.tawRenderRevision || -1) > previousRevision
          && input?.value === input?.max;
      }, { timeout: 15000 }, { leverKey: key, previousRevision: before.revision });
      const causedBucket = {
        rothWithdrawal: 'roth',
        deferredWithdrawal: 'traditional',
        realizedGain: 'taxable',
      }[key];
      if(causedBucket){
        await page.waitForFunction(bucket => (
          document.querySelector(`[data-taw-caused="${bucket}"] [data-taw-caused-val]`)
            ?.textContent.trim() !== '\u2014'
        ), { timeout: 15000 }, causedBucket);
      }
      const after = await plannerSnapshot();
      const allowedZeroTaxEffectiveRate = before.effectiveRate === '\u2014'
        && after.effectiveRate === '\u2014'
        && effect.financial === 'unchanged';
      if(
        after.federalTax === '\u2014'
        || (after.effectiveRate === '\u2014' && !allowedZeroTaxEffectiveRate)
        || after.marginalRate === '\u2014'
        || after.columns.ord.value === '\u2014'
        || after.columns.ltcg.value === '\u2014'
        || after.columns.ss.value === '\u2014'
        || Object.values(after.columns).some(column => (
          !Number.isFinite(column.basePixels)
            || !Number.isFinite(column.fillPixels)
            || !Number.isFinite(column.gapPixels)
        ))
      ){
        throw new Error(`Planner lever blanked visible outputs or fill geometry: ${JSON.stringify({ key, before, after })}`);
      }
      const financialView = snapshot => ({
        federalTax: snapshot.federalTax,
        effectiveRate: snapshot.effectiveRate,
        marginalRate: snapshot.marginalRate,
        columns: Object.fromEntries(
          Object.entries(snapshot.columns).map(([id, column]) => [id, column.value]),
        ),
      });
      const geometryView = snapshot => Object.fromEntries(
        Object.entries(snapshot.columns).map(([id, column]) => [id, {
          baseStyle: column.baseStyle,
          fillStyle: column.fillStyle,
          gapStyle: column.gapStyle,
        }]),
      );
      const financialChanged = JSON.stringify(financialView(after))
        !== JSON.stringify(financialView(before));
      const geometryChanged = JSON.stringify(geometryView(after))
        !== JSON.stringify(geometryView(before));
      if(financialChanged !== (effect.financial === 'changes')){
        throw new Error(`Planner lever financial-output contract failed: ${JSON.stringify({ key, effect, before, after })}`);
      }
      if(geometryChanged !== (effect.geometry === 'changes')){
        throw new Error(`Planner lever fill-geometry contract failed: ${JSON.stringify({ key, effect, before, after })}`);
      }
      if(effect.taxCaused !== undefined){
        if(!causedBucket || after.taxCaused[causedBucket] !== effect.taxCaused){
          throw new Error(`Planner lever tax-caused contract failed: ${JSON.stringify({ key, effect, after })}`);
        }
      }
      await stableClick(selector);
      await page.keyboard.press('Home');
      await page.waitForFunction(({ leverKey, previousRevision }) => {
        const root = document.querySelector('[data-taw-root]');
        const input = document.querySelector(`[data-taw-lever="${leverKey}"]`);
        return root?.getAttribute('aria-busy') === 'false'
          && Number(root.dataset.tawRenderRevision || -1) > previousRevision
          && input?.value === input?.min;
      }, { timeout: 15000 }, { leverKey: key, previousRevision: after.revision });
      const reset = await plannerSnapshot();
      const comparable = snapshot => ({
        federalTax: snapshot.federalTax,
        effectiveRate: snapshot.effectiveRate,
        marginalRate: snapshot.marginalRate,
        columns: Object.fromEntries(Object.entries(snapshot.columns).map(([id, column]) => [id, {
          value: column.value,
          baseStyle: column.baseStyle,
          fillStyle: column.fillStyle,
          gapStyle: column.gapStyle,
        }])),
      });
      if(JSON.stringify(comparable(reset)) !== JSON.stringify(comparable(before))){
        throw new Error(`Planner lever did not restore its visible baseline: ${JSON.stringify({ key, before, after, reset })}`);
      }
      return { key, control, before, after };
    };

    const leverProof = [];
    for(const key of [
      'rothConversion',
      'rothWithdrawal',
      'qcd',
      'deferredWithdrawal',
      'realizedGain',
    ]){
      leverProof.push(await exerciseLever(key));
    }
    const realized = leverProof.find(candidate => candidate.key === 'realizedGain');
    const realizedOracle = WITHDRAWAL_PLANNER_FIXTURE.plannerOracle.realizedGainAtDisplayCeiling;
    const realizedVisible = {
      slider: `$${realized.control.max.toLocaleString('en-US')}`,
      federalTax: realized.after.federalTax,
      ordinary: realized.after.columns.ord.value,
      longTermGainTax: realized.after.columns.ltcg.value,
      irmaaAnnual: realized.after.columns.irmaa.value,
      effectiveRate: realized.after.effectiveRate,
      taxCaused: realized.after.taxCaused.taxable,
    };
    if(Object.entries(realizedVisible).some(([key, value]) => value !== realizedOracle[key])){
      throw new Error(`Realized Gain differs from the independent literal oracle: ${JSON.stringify({ realizedVisible, realizedOracle })}`);
    }
    if(!(parseFloat(realized.after.columns.ltcg.fillStyle || '0') > 0)){
      throw new Error(`Realized Gain did not produce visible long-term-gain fill: ${JSON.stringify(realized)}`);
    }

    const defaultIds = Object.keys(WITHDRAWAL_PLANNER_ORACLE.households);
    const selectableIds = await page.$$eval(
      '#hh-switch option',
      options => options.map(option => option.value),
    );
    if(
      selectableIds[0] !== ''
      || defaultIds.some(id => !selectableIds.includes(id))
      || !selectableIds.includes(withdrawalPlannerFixtureHouseholdId)
      || [
        'demo',
        'default-pre-retirement-solo',
        'default-pre-retirement-couple',
      ].some(id => selectableIds.includes(id))
    ){
      throw new Error(`production household selector is incomplete: ${JSON.stringify({ selectableIds, defaultIds })}`);
    }
    const productionDefaultProof = {};
    for(const householdId of defaultIds){
      await page.select('#hh-switch', householdId);
      try{
        await page.waitForFunction(expectedHouseholdId => {
          const root = document.querySelector('[data-taw-root]');
          return root?.dataset.tawHouseholdId === expectedHouseholdId
            && root?.getAttribute('aria-busy') === 'false'
            && document.querySelectorAll('.taw-range:not(:disabled)').length === 5
            && document.querySelector('[data-taw-federal-tax]')?.textContent.trim() !== '\u2014';
        }, { timeout: 30000 }, householdId);
      }catch(error){
        const observed = await page.evaluate(() => ({
          selectedHouseholdId: document.querySelector('#hh-switch')?.value ?? null,
          wizardHouseholdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId ?? null,
          householdName: document.querySelector('#hh-rail-name')?.textContent.trim() ?? null,
          plannerHouseholdId: document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId ?? null,
          busy: document.querySelector('[data-taw-root]')?.getAttribute('aria-busy') ?? null,
          federalTax: document.querySelector('[data-taw-federal-tax]')?.textContent.trim() ?? null,
          controls: Array.from(document.querySelectorAll('.taw-range'), input => ({
            lever: input.dataset.tawLever ?? null,
            value: input.value,
            max: input.max,
            disabled: input.disabled,
          })),
        }));
        throw new Error(
          `production default did not reach ready funded Planner state: ${JSON.stringify({ householdId, observed })}`,
          { cause:error },
        );
      }
      const baseline = await plannerSnapshot();
      const oracle = WITHDRAWAL_PLANNER_ORACLE.households[householdId];
      if(
        baseline.federalTax !== oracle.baseline.federalTax
        || baseline.columns.ord.value !== oracle.baseline.ordinary
        || baseline.columns.ltcg.value !== oracle.baseline.longTermGainTax
      ){
        throw new Error(`production default baseline differs from literal oracle: ${JSON.stringify({ householdId, baseline, oracle })}`);
      }
      const proofs = [];
      for(const key of [
        'rothConversion',
        'rothWithdrawal',
        'qcd',
        'deferredWithdrawal',
        'realizedGain',
      ]){
        proofs.push(await exerciseLever(key));
      }
      const realizedProof = proofs.find(candidate => candidate.key === 'realizedGain');
      const realizedExpected = oracle.realizedGainAtDisplayCeiling;
      const realizedActual = {
        slider: `$${realizedProof.control.max.toLocaleString('en-US')}`,
        federalTax: realizedProof.after.federalTax,
        ordinary: realizedProof.after.columns.ord.value,
        longTermGainTax: realizedProof.after.columns.ltcg.value,
        effectiveRate: realizedProof.after.effectiveRate,
        taxCaused: realizedProof.after.taxCaused.taxable,
      };
      if(Object.entries(realizedActual).some(([key, value]) => value !== realizedExpected[key])){
        throw new Error(`production default Realized Gain differs from literal oracle: ${JSON.stringify({ householdId, realizedActual, realizedExpected })}`);
      }
      productionDefaultProof[householdId] = proofs;
    }
    if(Object.values(productionDefaultProof).some(proofs => proofs.length !== 5)){
      throw new Error(`not every funded lever was exercised for every production default: ${JSON.stringify(productionDefaultProof)}`);
    }
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await page.waitForFunction(expectedHouseholdId => (
      document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === expectedHouseholdId
      && document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId === expectedHouseholdId
      && document.querySelector('[data-taw-root]')?.getAttribute('aria-busy') === 'false'
    ), { timeout:30000 }, withdrawalPlannerFixtureHouseholdId);
    await page.screenshot({ path:join(OUT, '02-tax-buckets.png') });
    await page.setViewport({ width:1920, height:1080, deviceScaleFactor:3 });
  });

  await step('Tax Buckets: rapid slider approvals preserve both changes', async () => {
    const proof = await page.evaluate(async () => {
      const { createTaxAwareWithdrawalController } = await import('/ui/taxAwareWithdrawal.js?verify=lever-queue');
      const host = document.createElement('div');
      const plan = { meta: { householdId: 'lever-queue-fixture', filingStatus: 'single' } };
      const calls = [];
      let releaseFirst;
      const firstGate = new Promise(resolveGate => { releaseFirst = resolveGate; });
      let nextApprovalGate = firstGate;
      let nextRefreshGate = null;
      let refreshStateCalls = 0;
      let approvalReturns = 0;
      const waitFor = async (predicate, label) => {
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
          if (predicate()) return;
          await new Promise(resolveWait => setTimeout(resolveWait, 0));
        }
        throw new Error(`timed out waiting for ${label}`);
      };
      const accountState = levers => {
        const remainingTraditional = Math.max(
          0,
          100000 - levers.rothConversion - levers.qcd - levers.deferredWithdrawal,
        );
        return {
          valid: true,
          limits: {
            rothConversion: { max: levers.rothConversion + remainingTraditional },
            rothWithdrawal: { max: 50000 },
            qcd: { max: levers.qcd + remainingTraditional },
            deferredWithdrawal: { max: levers.deferredWithdrawal + remainingTraditional },
            realizedGain: { max: 50000 },
          },
        };
      };
      const adapter = {
        withdrawalAccountState: async (_plan, levers) => {
          const gate = nextRefreshGate;
          if (gate) {
            nextRefreshGate = null;
            refreshStateCalls++;
            await gate;
          }
          return accountState(levers);
        },
        householdIncome: async () => ({
          available: false,
          filingStatus: 'single',
          socialSecurityBenefits: 12000,
          otherIncome: null,
          wages: 25000,
        }),
        evaluateYear: async () => ({ code: 'VERIFY_ONLY' }),
        attributeSleeves: async () => null,
        approveWithdrawalPlannerLeverChange: async (_plan, currentLevers, key, value) => {
          calls.push({ currentLevers: { ...currentLevers }, key, value });
          const gate = nextApprovalGate;
          nextApprovalGate = null;
          if (gate) await gate;
          const nextLevers = { ...currentLevers, [key]: value };
          approvalReturns++;
          return { approved: true, levers: nextLevers, state: accountState(nextLevers) };
        },
      };
      const controller = createTaxAwareWithdrawalController({ getPlan: () => plan, adapter });
      controller.bind(host);
      const conversion = host.querySelector('[data-taw-lever="rothConversion"]');
      const distribution = host.querySelector('[data-taw-lever="deferredWithdrawal"]');
      const wages = host.querySelector('[data-taw-fact-wages]');
      await waitFor(
        () => conversion.max === '100000' && wages.textContent === '$25,000',
        'initial engine limits and available income fields',
      );

      conversion.value = '60000';
      conversion.dispatchEvent(new Event('input', { bubbles: true }));
      distribution.value = '40000';
      distribution.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => calls.length === 1, 'first approval');
      const callsBeforeRelease = calls.length;
      releaseFirst();
      await waitFor(() => calls.length === 2, 'second approval');
      await waitFor(
        () => conversion.value === '60000' && distribution.value === '40000',
        'both approved slider values',
      );

      let releaseStaleApproval;
      nextApprovalGate = new Promise(resolveGate => { releaseStaleApproval = resolveGate; });
      conversion.value = '30000';
      conversion.dispatchEvent(new Event('input', { bubbles: true }));
      const conversionImmediatelyAfterInput = conversion.value;
      await waitFor(() => calls.length === 3, 'approval pending before refresh');
      let releaseRefresh;
      nextRefreshGate = new Promise(resolveGate => { releaseRefresh = resolveGate; });
      controller.sync();
      await waitFor(
        () => refreshStateCalls === 1 && conversion.value === '60000',
        'refresh invalidation of pending approval',
      );
      releaseStaleApproval();
      await waitFor(() => approvalReturns === 3, 'stale approval return');
      await new Promise(resolveWait => setTimeout(resolveWait, 0));
      const conversionAfterStaleReturn = conversion.value;
      const realizedGain = host.querySelector('[data-taw-lever="realizedGain"]');
      realizedGain.value = '10000';
      realizedGain.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolveWait => setTimeout(resolveWait, 0));
      const callsWhileRefreshPending = calls.length;
      releaseRefresh();
      await waitFor(() => calls.length === 4, 'approval queued after refresh');
      await waitFor(() => realizedGain.value === '10000', 'post-refresh approved slider value');

      return {
        callsBeforeRelease,
        calls,
        finalConversion: conversion.value,
        finalDistribution: distribution.value,
        finalDistributionMax: distribution.max,
        partialIncome: {
          socialSecurity: host.querySelector('[data-taw-fact-ss]').textContent,
          otherIncome: host.querySelector('[data-taw-fact-other]').textContent,
          wages: wages.textContent,
        },
        refreshRace: {
          conversionImmediatelyAfterInput,
          conversionAfterStaleReturn,
          callsWhileRefreshPending,
          postRefreshCall: calls[3],
          finalRealizedGain: realizedGain.value,
        },
      };
    });
    if (proof.callsBeforeRelease !== 1) {
      throw new Error(`approvals ran concurrently: ${JSON.stringify(proof)}`);
    }
    if (proof.calls[1]?.currentLevers?.rothConversion !== 60000) {
      throw new Error(`second approval missed the first accepted change: ${JSON.stringify(proof)}`);
    }
    if (
      proof.finalConversion !== '60000'
      || proof.finalDistribution !== '40000'
      || proof.finalDistributionMax !== '40000'
    ) {
      throw new Error(`approved shared-balance controls are inconsistent: ${JSON.stringify(proof)}`);
    }
    if (
      proof.partialIncome.socialSecurity !== '$12,000'
      || proof.partialIncome.otherIncome !== '—'
      || proof.partialIncome.wages !== '$25,000'
    ) {
      throw new Error(`available income fields were erased by a partial result: ${JSON.stringify(proof)}`);
    }
    if (
      proof.refreshRace.conversionImmediatelyAfterInput !== '30000'
      || proof.refreshRace.conversionAfterStaleReturn !== '60000'
      || proof.refreshRace.callsWhileRefreshPending !== 3
      || proof.refreshRace.postRefreshCall?.currentLevers?.rothConversion !== 60000
      || proof.refreshRace.finalRealizedGain !== '10000'
    ) {
      throw new Error(`refresh and approval ordering is unsafe: ${JSON.stringify(proof)}`);
    }
  });

  await step('Tax Buckets: production RMD floor and shared IRA limits reach the controls', async () => {
    const proof = await page.evaluate(async () => {
      const [engineModule, accountModule, factModule, controllerModule, adapter] = await Promise.all([
        import('/engine.js'),
        import('/src/household/createAccount.js'),
        import('/src/household/factEnvelope.js'),
        import('/ui/taxAwareWithdrawal.js?verify=production-rmd'),
        import('/src/planning/taxBuckets/taxEngineAdapter.js'),
      ]);
      const plan = structuredClone(engineModule.defaultPlan);
      plan.meta = {
        ...plan.meta,
        householdId: 'production-rmd-fixture',
        filingStatus: 'single',
        planningAsOfYear: 2026,
      };
      plan.household.primary = {
        currentAge: 73,
        retirementAge: 73,
        planEndAge: 75,
        birthYear: 1953,
      };
      plan.household.spouse = null;
      plan.taxProfiles.client.birthDate = factModule.createFact(
        '1953-01-15',
        'confirmed',
        'household-entry',
        '2026-01-15T12:00:00Z',
      );
      plan.income.socialSecurity = {
        primary: { pia: 0, claimAge: 70 },
        spouse: null,
      };
      plan.income.other = [];
      plan.savings.annual = 0;
      plan.portfolio.accounts.taxable.balance = 0;
      plan.portfolio.accounts.taxable.basisPct = 1;
      plan.portfolio.accounts.traditional.balance = 0;
      plan.portfolio.accounts.roth.balance = 0;
      plan.portfolio.extraAccounts = [
        accountModule.createAccount('traditional_ira', {
          owner: 'client',
          balance: 265000,
          valuationDate: '2025-12-31',
        }),
      ];
      const host = document.createElement('div');
      host.style.position = 'fixed';
      host.style.left = '-10000px';
      document.body.appendChild(host);
      const controller = controllerModule.createTaxAwareWithdrawalController({
        getPlan: () => plan,
        adapter,
      });
      controller.bind(host);
      const waitFor = async (predicate, label) => {
        const deadline = performance.now() + 10000;
        while(performance.now() < deadline){
          if(predicate()) return;
          await new Promise(resolveWait => setTimeout(resolveWait, 10));
        }
        throw new Error(`timed out waiting for ${label}`);
      };
      const conversion = host.querySelector('[data-taw-lever="rothConversion"]');
      const distribution = host.querySelector('[data-taw-lever="deferredWithdrawal"]');
      try{
        await waitFor(
          () => distribution.min === '10000'
            && distribution.max === '265000'
            && distribution.value === '10000'
            && conversion.max === '255000',
          'initial RMD-backed limits',
        );
      }catch(error){
        const debugFacts = await adapter.householdIncome(plan, 2026);
        const debugState = await adapter.withdrawalAccountState(plan, {}, debugFacts);
        throw new Error(`${error.message}: ${JSON.stringify({
          distributionMin:distribution.min,
          distributionMax:distribution.max,
          distributionValue:distribution.value,
          conversionMax:conversion.max,
          busy:host.querySelector('[data-taw-root]')?.getAttribute('aria-busy') ?? null,
          revision:host.querySelector('[data-taw-root]')?.dataset.tawRenderRevision ?? null,
          facts:debugFacts,
          state:debugState,
        })}`);
      }
      const initial = {
        distributionMin: distribution.min,
        distributionMax: distribution.max,
        distributionValue: distribution.value,
        conversionMax: conversion.max,
      };
      conversion.value = '160000';
      conversion.dispatchEvent(new Event('input', { bubbles: true }));
      distribution.value = '160000';
      distribution.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(
        () => conversion.value === '160000'
          && distribution.value === '105000'
          && conversion.max === '160000'
          && distribution.max === '105000',
        'serialized shared-IRA approvals',
      );
      const final = {
        distributionMin: distribution.min,
        distributionMax: distribution.max,
        distributionValue: distribution.value,
        conversionMax: conversion.max,
        conversionValue: conversion.value,
      };
      host.remove();
      return { initial, final };
    });
    if(
      proof.initial.distributionMin !== '10000'
      || proof.initial.distributionMax !== '265000'
      || proof.initial.distributionValue !== '10000'
      || proof.initial.conversionMax !== '255000'
      || proof.final.distributionMin !== '10000'
      || proof.final.distributionMax !== '105000'
      || proof.final.distributionValue !== '105000'
      || proof.final.conversionMax !== '160000'
      || proof.final.conversionValue !== '160000'
    ) {
      throw new Error(`rendered RMD/shared-IRA limits are wrong: ${JSON.stringify(proof)}`);
    }
  });

  await step('household wizard: semantic four-step contract', async () => {
    await runWizardBrowserContract(page, { outDir: OUT });
  });

  await step('goals Horizon: timeline, glass card, lanes, and no lifetime aggregate', async () => {
    await stableClick('.htab[data-sub-target="goals"]');
    await page.waitForFunction(() => (
      document.querySelector('.gh-page .gh-card')
      && document.querySelector('.gh-page .gh-lane')
      && document.querySelector('.gh-page .gh-add-toggle')
    ), { timeout: 10000 });
    const m = await page.evaluate(() => {
      const pageRoot = document.querySelector('.gh-page');
      const text = (pageRoot?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        page: !!pageRoot,
        card: !!document.querySelector('.gh-card'),
        redundantTitle: !!document.querySelector('.gh-title'),
        lanes: document.querySelectorAll('.gh-lane').length,
        chips: document.querySelectorAll('.gh-chip').length,
        marks: document.querySelectorAll('.gh-band, .gh-diamond').length,
        ticks: document.querySelectorAll('.gh-tick').length,
        add: !!document.querySelector('.gh-add-toggle'),
        lifetime: /Lifetime goal spend|Lifetime total|Lifetime/i.test(text),
        legacy: !!document.querySelector('#gl-ledger, .glx-row, .glc-card, .ga-board'),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    if(!m.page || !m.card) throw new Error('Goals Horizon page/card did not render');
    if(m.redundantTitle) throw new Error('Goals Horizon rendered a redundant standalone title');
    if(m.lanes < 1 || m.chips !== m.lanes || m.marks !== m.lanes)
      throw new Error(`Goals Horizon lanes incomplete (${JSON.stringify(m)})`);
    if(m.ticks < 5 || !m.add) throw new Error(`Goals Horizon axis/add control incomplete (${JSON.stringify(m)})`);
    if(m.lifetime) throw new Error('Goals Horizon must not render Lifetime goal spend');
    if(m.legacy) throw new Error('retired Goals implementation still renders');
    if(m.overflow > 2) throw new Error(`Goals Horizon caused ${m.overflow}px document overflow`);
    await page.screenshot({ path: join(OUT, '02-goals.png'), fullPage: true });
  });

  await step('goals Horizon: exact monthly labels and persistent category glows', async () => {
    await runGoalsPresentationContract(page, { householdId:withdrawalPlannerFixtureHouseholdId, outDir:OUT });
  });

  await step('goals Horizon: add, edit, cadence, timing, category, duplicate, delete, undo', async () => {
    await stableClick('.htab[data-page="household"]');
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
    await page.click('.htab[data-sub-target="goals"]');
    await page.waitForSelector('.gh-lane', { visible:true });
    const before = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
    await page.click('.gh-add-toggle');
    await page.waitForSelector('.gh-starter', { visible:true });
    const starters = await page.evaluate(() => document.querySelectorAll('.gh-starter').length);
    if(starters !== 8) throw new Error(`expected 8 goal starters, got ${starters}`);
    await page.click('.gh-starter[data-add-category="travel"]');
    await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count,
      { timeout:10000 }, before + 1);
    let m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      rail: !!document.querySelector('.gh-rail'),
      name: document.querySelector('.gh-name-input')?.value || '',
      amount: document.querySelector('.gh-amount-input')?.value || '',
      status: document.querySelector('#status')?.textContent || '',
    }));
    if(m.lanes !== before + 1 || !m.rail || m.name !== 'Travel' || m.amount !== '10,000')
      throw new Error(`Travel starter did not create the expected editable lane (${JSON.stringify(m)})`);
    if(!/Saved automatically/.test(m.status)) throw new Error(`goal add did not confirm automatic save: "${m.status}"`);

    await page.click('.gh-name-input');
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.keyboard.type('European summers');
    await page.click('.gh-amount-input');
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
    await page.keyboard.type('24000');
    await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '24,000');
    m = await page.evaluate(() => ({
      railName: document.querySelector('.gh-name-input')?.value,
      chipName: [...document.querySelectorAll('.gh-chip__name')].some(el => el.textContent === 'European summers'),
      amount: document.querySelector('.gh-amount-input')?.value,
      chipAmount: [...document.querySelectorAll('.gh-chip__amount')].find(el => el.closest('.gh-chip')?.querySelector('.gh-chip__name')?.textContent === 'European summers')?.textContent,
    }));
    if(m.railName !== 'European summers' || !m.chipName || m.amount !== '24,000' || !/24k/.test(m.chipAmount || ''))
      throw new Error(`live goal editing failed (${JSON.stringify(m)})`);

    await page.click('[data-action="per-month"]');
    await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '2,000');
    m = await page.evaluate(() => ({
      amount: document.querySelector('.gh-amount-input')?.value,
      monthly: document.querySelector('[data-action="per-month"]')?.classList.contains('is-selected'),
    }));
    if(m.amount !== '2,000' || !m.monthly) throw new Error(`monthly cadence conversion failed (${JSON.stringify(m)})`);
    await page.click('[data-action="kind-once"]');
    await page.waitForSelector('[data-field="once-age"]', { visible:true });
    if(!await page.evaluate(() => !!document.querySelector('[data-field="once-age"]')))
      throw new Error('one-time cadence did not expose a single age control');
    await page.click('[data-action="kind-rec"]');
    await page.waitForSelector('[data-field="start-age"]', { visible:true });
    if(!await page.evaluate(() => !!document.querySelector('[data-field="start-age"]') && !!document.querySelector('[data-field="end-age"]')))
      throw new Error('recurring cadence did not restore a range');
    await page.click('[data-action="preset"][data-preset="later"]');
    await page.waitForFunction(() => document.querySelector('[data-action="preset"][data-preset="later"]')?.classList.contains('is-selected'));
    m = await page.evaluate(() => ({
      start: document.querySelector('[data-field="start-age"]')?.value,
      end: document.querySelector('[data-field="end-age"]')?.value,
    }));
    if(!m.start || !m.end || +m.start >= +m.end) throw new Error(`later preset produced an invalid range (${JSON.stringify(m)})`);
    await page.click('[data-action="category"][data-category="home"]');
    await page.waitForFunction(artifactId => {
      const icon = document.querySelector('.gh-rail__icon img');
      const src = icon?.getAttribute('src');
      if(!src) return false;
      const iconUrl = new URL(src, location.href);
      return iconUrl.pathname.endsWith('/assets/goals-horizon/home.svg')
        && iconUrl.searchParams.get('v') === artifactId
        && icon.complete && icon.naturalWidth > 0;
    }, { timeout: 8000 }, VERIFIED_ARTIFACT.manifest.artifactId);

    const beforeDuplicate = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
    await page.click('[data-action="duplicate"]');
    await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count,
      { timeout:10000 }, beforeDuplicate + 1);
    m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      name: document.querySelector('.gh-name-input')?.value || '',
    }));
    if(m.lanes !== beforeDuplicate + 1 || !m.name.endsWith(' copy'))
      throw new Error(`duplicate failed (${JSON.stringify(m)})`);
    await page.click('[data-action="delete"]');
    await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count && document.querySelector('.gh-toast'),
      { timeout:10000 }, beforeDuplicate);
    m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      toast: document.querySelector('.gh-toast')?.textContent || '',
    }));
    if(m.lanes !== beforeDuplicate || !/Undo/.test(m.toast)) throw new Error(`delete/toast failed (${JSON.stringify(m)})`);
    await page.click('[data-action="undo"]');
    await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count,
      { timeout:10000 }, beforeDuplicate + 1);
    const restoredLaneCount = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
    if(restoredLaneCount !== beforeDuplicate + 1)
      throw new Error('undo did not restore the deleted goal');
    await page.waitForFunction(expected => {
      const id = localStorage.getItem('parallax.activeHouseholdId');
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return Array.isArray(db?.[id]?.goals) && db[id].goals.length === expected;
    }, { timeout: 10000 }, restoredLaneCount);
  });

  await step('goals Horizon: drag preserves a lane span and reaches Scenarios', async () => {
    await stableClick('.htab[data-page="household"]');
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
    await goToWizardStep(page, 'family');
    const commitFamilyValue = async (selector, value) => {
      const before = await page.$eval(
        '[data-hh-wizard-root]',
        root => Number(root.dataset.renderRevision || -1),
      );
      const count = await page.$$eval(selector, elements => elements.length);
      if(count !== 1){
        throw new Error(`Family fixture control must resolve once (${selector}: ${count})`);
      }
      await page.evaluate(({ selector, value }) => {
        const control = document.querySelector(selector);
        control.value = String(value);
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }, { selector, value });
      await waitForWizard(page, { step: 'family', afterRevision: before });
    };
    const readFixtureTiming = () => page.evaluate(householdId => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      const household = db?.[householdId]?.household;
      return {
        active: localStorage.getItem('parallax.activeHouseholdId'),
        primary: household?.primary
          ? {
              currentAge: household.primary.currentAge,
              retirementAge: household.primary.retirementAge,
              planEndAge: household.primary.planEndAge,
            }
          : null,
        spouse: household?.spouse
          ? {
              currentAge: household.spouse.currentAge,
              retirementAge: household.spouse.retirementAge,
              planEndAge: household.spouse.planEndAge,
            }
          : null,
      };
    }, withdrawalPlannerFixtureHouseholdId);
    const assertFixtureTiming = async stage => {
      const timing = await readFixtureTiming();
      if(timing.active !== withdrawalPlannerFixtureHouseholdId
          || timing.primary?.currentAge !== 64
          || timing.primary?.retirementAge !== 70
          || timing.primary?.planEndAge !== 96
          || timing.spouse?.currentAge !== 63
          || timing.spouse?.retirementAge !== 68
          || timing.spouse?.planEndAge !== 96){
        throw new Error(`retirement-relative fixture timing drifted ${stage}: ${JSON.stringify(timing)}`);
      }
    };
    // This contract exercises retirement-relative scenario goals, so keep the
    // fixture decisively pre-retirement. The semantic wizard contract already
    // covers physical typing; this Scenarios setup uses the same delegated
    // production change path without relying on keyboard focus behavior.
    await commitFamilyValue('[data-wizard-field="filingStatus"]', 'marriedFilingJointly');
    await commitFamilyValue('[data-wizard-field="client.retirementAge"]', 70);
    await commitFamilyValue('[data-wizard-field="client.planEndAge"]', 96);
    await commitFamilyValue(
      '[data-birth-date-group="spouse"] [data-birth-date-value]',
      '1963-01-15',
    );
    await commitFamilyValue('[data-wizard-field="spouse.retirementAge"]', 68);
    await commitFamilyValue('[data-wizard-field="spouse.planEndAge"]', 96);
    await assertFixtureTiming('after visible Family edits');

    await page.click('.htab[data-sub-target="goals"]');
    await page.waitForSelector('.gh-page', { visible: true, timeout: 8000 });
    const target = await page.evaluate(() => {
      const chip = [...document.querySelectorAll('.gh-chip')]
        .find(el => el.querySelector('.gh-chip__name')?.textContent.includes('European summers'));
      if(!chip) return null;
      const rect = chip.getBoundingClientRect();
      return { x:rect.left + rect.width/2, y:rect.top + rect.height/2, title:chip.title };
    });
    if(!target) throw new Error('drag target missing');
    await page.mouse.move(target.x,target.y);
    await page.mouse.down();
    await page.mouse.move(target.x-100,target.y,{steps:8});
    await page.mouse.up();
    await page.waitForFunction(previousTitle => {
      const chip = [...document.querySelectorAll('.gh-chip')]
        .find(el => el.querySelector('.gh-chip__name')?.textContent.includes('European summers'));
      return chip?.title && chip.title !== previousTitle;
    }, { timeout: 8000 }, target.title);
    const after = await page.evaluate(() => [...document.querySelectorAll('.gh-chip')]
      .find(el => el.querySelector('.gh-chip__name')?.textContent.includes('European summers'))?.title || '');
    if(after === target.title || !/Every year, ages/.test(after))
      throw new Error(`goal drag did not shift the recurring range ("${target.title}" -> "${after}")`);
    await assertFixtureTiming('after Goals drag');

    const laneCount = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
    await stableClick('button[data-page="scenarios"]');
    await page.waitForSelector('#scn-view', { visible: true, timeout: 15000 });
    await page.click('#scn-seg-compare');
    let scenarioColumnCount = await page.evaluate(
      () => document.querySelectorAll('#scn-view .scol__name').length,
    );
    while(scenarioColumnCount < 3){
      await stableClick('#scn-add');
      scenarioColumnCount += 1;
      await page.waitForFunction(expected => (
        document.querySelectorAll('#scn-view .scol__name').length >= expected
      ), { timeout: 15000 }, scenarioColumnCount);
    }
    try{
      await page.waitForFunction(expected => {
        const toggle = document.querySelector('#scn-view [data-goals-toggle]');
        const names = document.querySelectorAll('#scn-view .goal-detail__name');
        const inputs = document.querySelectorAll('#scn-view .cmp-goal-in');
        const runButton = document.querySelector('#run-btn');
        const status = document.querySelector('#status')?.textContent || '';
        const medians = [...document.querySelectorAll('#scn-view .scol__median b')]
          .map(element => element.textContent.trim());
        return runButton && !runButton.disabled
          && /Plan updated|Partial run/i.test(status)
          && toggle?.getAttribute('aria-expanded') === 'true'
          && names.length === expected
          && inputs.length >= expected
          && medians.length > 0
          && medians.every(value => /^\$[\d,.]+[KMB]?$/.test(value));
      }, { timeout: 10000 }, laneCount);
    }catch(error){
      const observed = await page.evaluate(() => ({
        householdId:document.querySelector('[data-hh-wizard-root]')?.dataset.householdId ?? null,
        expanded:document.querySelector('#scn-view [data-goals-toggle]')?.getAttribute('aria-expanded') ?? null,
        names:[...document.querySelectorAll('#scn-view .goal-detail__name')].map(element => element.textContent.trim()),
        inputs:document.querySelectorAll('#scn-view .cmp-goal-in').length,
        medians:[...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim()),
        status:document.querySelector('#status')?.textContent.trim() ?? null,
      }));
      throw new Error(`Goals did not reach ready Scenarios view: ${JSON.stringify({ laneCount, observed })}`, { cause:error });
    }
    const scenarioGoals = await page.evaluate(() => {
      const text = document.querySelector('#scn-view .goal-pill, #scn-view .goal-note')?.textContent || '';
      return {
        active: +(text.match(/(\d+)\s*active/)?.[1] || -1),
        expanded: document.querySelector('#scn-view [data-goals-toggle]')?.getAttribute('aria-expanded'),
        details: [...document.querySelectorAll('#scn-view .goal-detail__name')]
          .map(element => element.textContent.trim()),
        medians: [...document.querySelectorAll('#scn-view .scol__median b')]
          .map(element => element.textContent.trim()),
      };
    });
    if(scenarioGoals.active !== laneCount
        || scenarioGoals.details.length !== laneCount
        || scenarioGoals.medians.some(value => !/^\$[\d,.]+[KMB]?$/.test(value))){
      throw new Error(`Goals Horizon details did not reach Scenarios (${laneCount} lanes / ${JSON.stringify(scenarioGoals)})`);
    }
  });

  await step('scenarios: allocation labels and both spouses ages persist through reload', async () => {
    const legacySeed = await page.evaluate(householdId => {
      const readAge = key => Number(document.querySelector(
        `#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`,
      )?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim());
      const retainedLevers = {
        retireAge: readAge('retireAge'),
        spouseRetireAge: readAge('spouseRetireAge'),
        ssAge: readAge('ssAge'),
        spouseSsAge: readAge('spouseSsAge'),
        allocationPresetId: document.querySelector(
          '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
        )?.value || 'current',
      };
      const key = `parallax.scenarios.${householdId}.v1`;
      const raw = JSON.stringify([
        { name:'Baseline', base:true, lev:{ ...retainedLevers } },
        { name:'Legacy twin', base:false, lev:{ ...retainedLevers } },
        { name:'Legacy sale bytes', base:false, lev:{ ...retainedLevers, sellAge:70 } },
      ]);
      localStorage.setItem(key, raw);
      return { key, raw, retainedLevers };
    }, withdrawalPlannerFixtureHouseholdId);

    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await page.evaluate(({ key }) => {
      const originalSetItem = Storage.prototype.setItem;
      window.__legacyScenarioOriginalSetItem = originalSetItem;
      window.__legacyScenarioAttemptedBytes = null;
      Storage.prototype.setItem = function(storageKey, value){
        if(this === localStorage && storageKey === key){
          window.__legacyScenarioAttemptedBytes = value;
          return;
        }
        return originalSetItem.call(this, storageKey, value);
      };
    }, legacySeed);
    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    await stableClick('button[data-page="scenarios"]');
    await page.waitForSelector('#scn-view .compare', { visible: true, timeout: 30000 });
    await page.waitForFunction(() => {
      const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')]
        .map(element => element.textContent.trim());
      return probabilities.length === 3 && probabilities.every(value => value && value !== '—%');
    }, { timeout: 30000 });
    const legacyRead = await page.evaluate(({ key, raw }) => {
      const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')]
        .map(element => element.textContent.trim());
      const medians = [...document.querySelectorAll('#scn-view .scol__median b')]
        .map(element => element.textContent.trim());
      return {
        sourceBytesUnchanged: localStorage.getItem(key) === raw,
        attemptedBytes: window.__legacyScenarioAttemptedBytes,
        scenarioCount: document.querySelectorAll('#scn-view .scol__name').length,
        removedDecisionControlCount: document.querySelectorAll(
          '#scn-view [data-lever-key="sellAge"], #scn-view [data-key="sellAge"]',
        ).length,
        removedDecisionLabelCount: [...document.querySelectorAll('#scn-view .lever__name')]
          .filter(element => /^Sell\s/i.test(element.textContent.trim())).length,
        probabilities,
        medians,
      };
    }, legacySeed);
    const attemptedLegacyLevers = JSON.parse(legacyRead.attemptedBytes || 'null')?.[2]?.lev;
    if(!legacyRead.sourceBytesUnchanged
        || !legacyRead.attemptedBytes
        || Object.prototype.hasOwnProperty.call(attemptedLegacyLevers || {}, 'sellAge')
        || legacyRead.scenarioCount !== 3
        || legacyRead.removedDecisionControlCount !== 0
        || legacyRead.removedDecisionLabelCount !== 0
        || legacyRead.probabilities[1] !== legacyRead.probabilities[2]
        || legacyRead.medians[1] !== legacyRead.medians[2]){
      throw new Error(`legacy sellAge bytes still affect Scenarios: ${JSON.stringify(legacyRead)}`);
    }
    await page.evaluate(() => {
      Storage.prototype.setItem = window.__legacyScenarioOriginalSetItem;
      delete window.__legacyScenarioOriginalSetItem;
      delete window.__legacyScenarioAttemptedBytes;
    });

    const before = await page.evaluate(householdId => {
      const scenarioCount = document.querySelectorAll('#scn-view .scol__name').length;
      const leverNames = [...document.querySelectorAll('#scn-view .lever__name')]
        .map(element => element.textContent.trim());
      const select = document.querySelector(
        '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
      );
      const bodyFontSize = getComputedStyle(document.documentElement)
        .getPropertyValue('--fs-body').trim();
      const bodyFontWeight = getComputedStyle(document.documentElement)
        .getPropertyValue('--fw-body').trim();
      const bodyLineHeight = getComputedStyle(document.documentElement)
        .getPropertyValue('--lh-body').trim();
      const bodyLetterSpacing = getComputedStyle(document.documentElement)
        .getPropertyValue('--ls-body').trim();
      const editorTypography = [...document.querySelectorAll(
        '#scn-view .cmp-lev-val, #scn-view .cmp-lev-in, #scn-view .cmp-lev-select, #scn-view .cmp-goal-in',
      )].map(element => {
        const style = getComputedStyle(element);
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
        };
      });
      const ageValues = {};
      for(const key of ['retireAge', 'spouseRetireAge', 'ssAge', 'spouseSsAge']){
        const value = document.querySelector(
          `#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`,
        )?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
        ageValues[key] = Number(value);
      }
      return {
        active: localStorage.getItem('parallax.activeHouseholdId'),
        householdId,
        scenarioCount,
        leverNames,
        allocationValue: select?.value ?? null,
        allocationLabels: [...(select?.options || [])].map(option => option.textContent.trim()),
        allocationCount: document.querySelectorAll(
          '#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]',
        ).length,
        removedDecisionControlCount: document.querySelectorAll(
          '#scn-view [data-lever-key="sellAge"], #scn-view [data-key="sellAge"]',
        ).length,
        bodyFontSize,
        bodyFontWeight,
        bodyLineHeight,
        bodyLetterSpacing,
        editorTypography,
        ageValues,
        ageControlCounts: Object.fromEntries(
          ['retireAge', 'spouseRetireAge', 'ssAge', 'spouseSsAge'].map(key => [
            key,
            document.querySelectorAll(
              `#scn-view .cmp-step-btn[data-lever-key="${key}"][data-scn-id]`,
            ).length,
          ]),
        ),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, withdrawalPlannerFixtureHouseholdId);
    const expectedAllocationLabels = [
      'Current mix', 'Defensive', 'Conservative', 'Balanced', 'Growth', 'Aggressive', 'All Equity',
    ];
    const expectedLeverNames = [
      'Client 1 Retirement', 'Client 2 Retirement', 'Client 1 SS Age', 'Client 2 SS Age', 'Allocation',
    ];
    if(before.active !== withdrawalPlannerFixtureHouseholdId
        || before.scenarioCount < 2
        || before.allocationCount !== before.scenarioCount
        || JSON.stringify(before.allocationLabels) !== JSON.stringify(expectedAllocationLabels)
        || expectedLeverNames.some(name => !before.leverNames.includes(name))
        || before.leverNames.some(name => /^Sell\s/i.test(name))
        || before.removedDecisionControlCount !== 0
        || before.editorTypography.length === 0
        || before.editorTypography.some(role => (
          role.fontSize !== before.bodyFontSize
          || role.fontWeight !== before.bodyFontWeight
          || role.lineHeight !== `${Number.parseFloat(before.bodyFontSize) * Number.parseFloat(before.bodyLineHeight)}px`
          || (Number.parseFloat(before.bodyLetterSpacing) === 0
            ? !['normal', '0px'].includes(role.letterSpacing)
            : role.letterSpacing !== before.bodyLetterSpacing)
        ))
        || Object.values(before.ageValues).some(value => !Number.isInteger(value))
        || Object.values(before.ageControlCounts).some(count => count !== before.scenarioCount * 2)
        || before.overflow > 2){
      throw new Error(`scenario person/allocation controls are incomplete: ${JSON.stringify(before)}`);
    }

    const targetAllocation = before.allocationValue === 'aggressive' ? 'defensive' : 'aggressive';
    await page.select(
      '#scn-view .cmp-lev-select[data-scn-id="2"][data-lever-key="allocationPresetId"]',
      targetAllocation,
    );
    await page.waitForFunction(target => (
      document.querySelector(
        '#scn-view .cmp-lev-select[data-scn-id="2"][data-lever-key="allocationPresetId"]',
      )?.value === target
      && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || '')
    ), { timeout: 30000 }, targetAllocation);

    const rewrittenLegacy = await page.evaluate(({ key, retainedLevers }) => {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      const levers = saved?.[2]?.lev;
      return {
        sellAgePresent: Object.prototype.hasOwnProperty.call(levers || {}, 'sellAge'),
        retained: Object.fromEntries(Object.keys(retainedLevers).map(key => [key, levers?.[key]])),
      };
    }, legacySeed);
    if(rewrittenLegacy.sellAgePresent
        || Object.entries(legacySeed.retainedLevers)
          .some(([key, value]) => key !== 'allocationPresetId' && rewrittenLegacy.retained[key] !== value)
        || rewrittenLegacy.retained.allocationPresetId !== targetAllocation){
      throw new Error(`ordinary scenario edit did not safely rewrite legacy bytes: ${JSON.stringify(rewrittenLegacy)}`);
    }

    await page.select(
      '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
      targetAllocation,
    );
    await page.waitForFunction(target => (
      document.querySelector(
        '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
      )?.value === target
      && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || '')
    ), { timeout: 30000 }, targetAllocation);

    const editedAges = {};
    for(const [key, max] of [
      ['retireAge', 72],
      ['spouseRetireAge', 72],
      ['ssAge', 70],
      ['spouseSsAge', 70],
    ]){
      const original = before.ageValues[key];
      const dir = original < max ? 1 : -1;
      editedAges[key] = original + dir;
      await page.click(
        `#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"][data-dir="${dir}"]`,
      );
      await page.waitForFunction(({ key, expected }) => {
        const value = document.querySelector(
          `#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`,
        )?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
        return Number(value) === expected
          && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || '');
      }, { timeout: 30000 }, { key, expected: editedAges[key] });
    }

    await page.waitForFunction(({ householdId, allocation, ages }) => {
      const raw = localStorage.getItem(`parallax.scenarios.${householdId}.v1`);
      const saved = raw ? JSON.parse(raw) : null;
      const levers = saved?.[1]?.lev;
      return levers?.allocationPresetId === allocation
        && !Object.prototype.hasOwnProperty.call(levers || {}, 'sellAge')
        && Object.entries(ages).every(([key, value]) => levers?.[key] === value);
    }, { timeout: 10000 }, {
      householdId: withdrawalPlannerFixtureHouseholdId,
      allocation: targetAllocation,
      ages: editedAges,
    });

    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    await stableClick('button[data-page="scenarios"]');
    await page.waitForSelector('#scn-view .compare', { visible: true, timeout: 30000 });
    const restored = await page.evaluate(() => {
      const allocation = document.querySelector(
        '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
      )?.value;
      const ages = {};
      for(const key of ['retireAge', 'spouseRetireAge', 'ssAge', 'spouseSsAge']){
        const value = document.querySelector(
          `#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`,
        )?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
        ages[key] = Number(value);
      }
      return { allocation, ages };
    });
    if(restored.allocation !== targetAllocation
        || Object.entries(editedAges).some(([key, value]) => restored.ages[key] !== value)){
      throw new Error(`scenario controls did not survive reload: ${JSON.stringify({ editedAges, restored })}`);
    }

    await page.select(
      '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
      before.allocationValue,
    );
    await page.waitForFunction(value => (
      document.querySelector(
        '#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]',
      )?.value === value
      && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || '')
    ), { timeout: 30000 }, before.allocationValue);
    for(const [key, original] of Object.entries(before.ageValues)){
      const dir = editedAges[key] > original ? -1 : 1;
      await page.evaluate(({ key, dir }) => {
        const button = document.querySelector(
          `#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"][data-dir="${dir}"]`,
        );
        if(!button) throw new Error(`scenario cleanup control is missing: ${key}/${dir}`);
        button.click();
      }, { key, dir });
      await page.waitForFunction(({ householdId, key, original }) => {
        const value = document.querySelector(
          `#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`,
        )?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
        const saved = JSON.parse(
          localStorage.getItem(`parallax.scenarios.${householdId}.v1`) || 'null',
        );
        return Number(value) === original && saved?.[1]?.lev?.[key] === original;
      }, { timeout: 30000 }, {
        householdId: withdrawalPlannerFixtureHouseholdId,
        key,
        original,
      });
    }
    const goalsToggle = await page.$('#scn-view [data-goals-toggle]');
    if(goalsToggle
        && await page.$eval('#scn-view [data-goals-toggle]', element => element.getAttribute('aria-expanded')) !== 'true'){
      await goalsToggle.click();
      await page.waitForFunction(() => (
        document.querySelector('#scn-view [data-goals-toggle]')?.getAttribute('aria-expanded') === 'true'
      ), { timeout: 10000 });
    }
    await page.click('#scn-seg-focus');
    await page.waitForSelector('#scn-view .focus', { visible: true, timeout: 10000 });
    const focusContract = await page.evaluate(() => {
      const bodyFontSize = getComputedStyle(document.documentElement)
        .getPropertyValue('--fs-body').trim();
      const bodyFontWeight = getComputedStyle(document.documentElement)
        .getPropertyValue('--fw-body').trim();
      const bodyLineHeight = getComputedStyle(document.documentElement)
        .getPropertyValue('--lh-body').trim();
      const bodyLetterSpacing = getComputedStyle(document.documentElement)
        .getPropertyValue('--ls-body').trim();
      const editorTypography = [...document.querySelectorAll(
        '#scn-view .assum__value, #scn-view .assum__select',
      )].map(element => {
        const style = getComputedStyle(element);
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
        };
      });
      return {
        bodyFontSize,
        bodyFontWeight,
        bodyLineHeight,
        bodyLetterSpacing,
        editorTypography,
        removedDecisionControlCount: document.querySelectorAll(
          '#scn-view [data-lever-key="sellAge"], #scn-view [data-key="sellAge"]',
        ).length,
        removedDecisionLabelCount: [...document.querySelectorAll('#scn-view .assum__label')]
          .filter(element => /^Sell\s/i.test(element.textContent.trim())).length,
      };
    });
    if(focusContract.removedDecisionControlCount !== 0
        || focusContract.removedDecisionLabelCount !== 0
        || focusContract.editorTypography.length === 0
        || focusContract.editorTypography.some(role => (
          role.fontSize !== focusContract.bodyFontSize
          || role.fontWeight !== focusContract.bodyFontWeight
          || role.lineHeight !== `${Number.parseFloat(focusContract.bodyFontSize) * Number.parseFloat(focusContract.bodyLineHeight)}px`
          || (Number.parseFloat(focusContract.bodyLetterSpacing) === 0
            ? !['normal', '0px'].includes(role.letterSpacing)
            : role.letterSpacing !== focusContract.bodyLetterSpacing)
        ))){
      throw new Error(`scenario Focus controls violate the removed-decision/type contract: ${JSON.stringify(focusContract)}`);
    }
    await page.click('#scn-seg-compare');
    await page.waitForSelector('#scn-view .compare', { visible: true, timeout: 10000 });
  });

  await step('scenarios: retirement-relative goal ages resolve and round-trip', async () => {
    const contract = await page.evaluate(() => {
      const retirementAges = {};
      document.querySelectorAll(
        '#scn-view .cmp-step-btn[data-lever-key="retireAge"][data-dir="1"][data-scn-id]',
      ).forEach(button => {
        const text = button.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent || '';
        retirementAges[button.dataset.scnId] = Number(text.match(/\d+/)?.[0]);
      });
      const scenarioCount = Object.keys(retirementAges).length;
      const rows = [...document.querySelectorAll('#scn-view .goal-detail__name')]
        .filter(element => ['Essentials', 'Healthcare'].includes(element.textContent.trim()))
        .map(nameElement => {
          const gutter = nameElement.closest('.goal-detail');
          const cells = [];
          let cell = gutter?.nextElementSibling;
          while(cell?.classList.contains('cell--goal-detail') && cells.length < scenarioCount){
            const input = cell.querySelector('[data-goal-field="startAge"]');
            cells.push({
              scnId: input?.dataset.scnId ?? null,
              goalIdx: input?.dataset.goalIdx ?? null,
              value: input?.value ?? null,
              overridden: cell.classList.contains('is-overridden'),
            });
            cell = cell.nextElementSibling;
          }
          return {
            name: nameElement.textContent.trim(),
            baseMeta: gutter?.querySelector('.goal-detail__meta')?.textContent.trim() ?? null,
            cells,
          };
        });
      const inputsContainUndefined = [...document.querySelectorAll('#scn-view input')]
        .some(input => input.value === 'undefined');
      return {
        retirementAges,
        rows,
        containsUndefined: document.querySelector('#scn-view')?.textContent.includes('undefined')
          || inputsContainUndefined,
      };
    });
    const scenarioCount = Object.keys(contract.retirementAges).length;
    if(contract.containsUndefined || scenarioCount < 2 || contract.rows.length !== 2){
      const diagnostic = await page.evaluate(() => {
        const active = localStorage.getItem('parallax.activeHouseholdId');
        const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
        return {
          active,
          household: db?.[active]?.household ?? null,
          leverNames: [...document.querySelectorAll('#scn-view .lever__name')]
            .map(element => element.textContent.trim()),
          stepButtons: [...document.querySelectorAll('#scn-view .cmp-step-btn')]
            .map(button => ({
              key: button.dataset.leverKey ?? null,
              scenarioId: button.dataset.scnId ?? null,
              dir: button.dataset.dir ?? null,
            })),
        };
      });
      throw new Error(`retirement-relative goal contract is incomplete: ${JSON.stringify({ contract, diagnostic })}`);
    }
    contract.rows.forEach(row => {
      if(row.cells.length !== scenarioCount
          || !row.baseMeta?.includes(`age ${row.cells[0].value}`)
          || row.cells.some(cell => Number(cell.value) !== contract.retirementAges[cell.scnId])){
        throw new Error(`retirement-relative goal ages are unresolved: ${JSON.stringify(contract)}`);
      }
    });

    const targetRow = contract.rows.find(row => row.name === 'Healthcare') || contract.rows[0];
    const target = targetRow.cells.find((cell, index) => index > 0 && !cell.overridden);
    if(!target) throw new Error(`retirement-relative edit target is missing: ${JSON.stringify(contract)}`);
    const originalAge = Number(target.value);
    const editedAge = originalAge + 1;
    const selector = `#scn-view .cmp-goal-in[data-scn-id="${target.scnId}"][data-goal-idx="${target.goalIdx}"][data-goal-field="startAge"]`;

    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(editedAge));
    await page.keyboard.press('Tab');
    try{
      await page.waitForFunction(({ selector, editedAge }) => {
        const input = document.querySelector(selector);
        return input?.value === String(editedAge)
          && input.closest('.cell--goal-detail')?.classList.contains('is-overridden');
      }, { timeout: 15000 }, { selector, editedAge });
    }catch(error){
      const observed = await page.evaluate(({ selector, scenarioId }) => {
        const input = document.querySelector(selector);
        const active = localStorage.getItem('parallax.activeHouseholdId');
        return {
          active,
          rootHouseholdId: document.querySelector('[data-hh-wizard-root]')
            ?.dataset.householdId || '',
          status: document.querySelector('#status')?.textContent.trim() || '',
          activePage: document.querySelector('.page.on')?.dataset.page || '',
          value: input?.value ?? null,
          focused: document.activeElement === input,
          overridden: input?.closest('.cell--goal-detail')
            ?.classList.contains('is-overridden') || false,
          editedMarkerCount: input?.closest('.cell--goal-detail')
            ?.querySelectorAll('.cmp-goal-edited').length ?? null,
          scenarioStorage: localStorage.getItem(
            `parallax.scenarios.${active}.v1`,
          ),
          targetScenarioId: scenarioId,
        };
      }, { selector, scenarioId: target.scnId });
      throw new Error(`retirement-relative goal edit did not commit: ${JSON.stringify(observed)}; ${error.message}`);
    }

    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(originalAge));
    await page.keyboard.press('Tab');
    await page.waitForFunction(({ selector, originalAge }) => {
      const input = document.querySelector(selector);
      const cell = input?.closest('.cell--goal-detail');
      return input?.value === String(originalAge)
        && !cell?.classList.contains('is-overridden')
        && !cell?.querySelector('.cmp-goal-edited');
    }, { timeout: 10000 }, { selector, originalAge });

    await stableClick('.htab[data-page="household"]');
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
    await goToWizardStep(page, 'family');
    const restoreRetirementRevision = await page.$eval(
      '[data-hh-wizard-root]',
      root => Number(root.dataset.renderRevision || -1),
    );
    await stableClick('[data-wizard-field="client.retirementAge"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(WITHDRAWAL_PLANNER_FIXTURE.family.retirementAge));
    await page.keyboard.press('Tab');
    await waitForWizard(page, { step: 'family', afterRevision: restoreRetirementRevision });
    const cleanupRevision = await page.$eval(
      '[data-hh-wizard-root]',
      root => Number(root.dataset.renderRevision || -1),
    );
    page.once('dialog', dialog => dialog.accept());
    await stableClick('[data-hh-action="remove-spouse"]');
    await waitForWizard(page, { step: 'family', afterRevision: cleanupRevision });
    const restoredSingle = await page.evaluate(() => ({
      filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value ?? null,
      spouseCards: document.querySelectorAll('[data-person-owner="spouse"]').length,
    }));
    if(restoredSingle.filingStatus !== 'single' || restoredSingle.spouseCards !== 0){
      throw new Error(`dual-client retirement fixture did not restore: ${JSON.stringify(restoredSingle)}`);
    }
  });

  await step('goals Horizon: new household shows system goals and derives starter timing from its plan', async () => {
    await goToWizardStep(page, 'family');
    const beforeNew = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await stableClick('#hh-menu-btn');
    await stableClick('#hh-new');
    await waitForWizard(page, { afterRevision: beforeNew });
    await page.waitForFunction(() => {
      const id = localStorage.getItem('parallax.activeHouseholdId');
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return id && Boolean(db?.[id]);
    }, { timeout: 10000 });
    await page.click('.htab[data-sub-target="goals"]');
    await page.waitForSelector('.gh-page', { visible: true, timeout: 8000 });
    let m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      names: [...document.querySelectorAll('.gh-chip__name')]
        .map(element => element.textContent.trim()),
      amounts: [...document.querySelectorAll('.gh-chip__amount')]
        .map(element => element.textContent.trim()),
      lifetime: /Lifetime/i.test(document.querySelector('.gh-page')?.textContent || ''),
    }));
    if(m.lanes !== 2
        || JSON.stringify(m.names) !== JSON.stringify(['Essentials', 'Healthcare'])
        || JSON.stringify(m.amounts) !== JSON.stringify(['$0 / yr', '$5.5k / yr'])
        || m.lifetime){
      throw new Error(`new-household Goals Horizon system goals are wrong (${JSON.stringify(m)})`);
    }
    await page.click('.gh-add-toggle');
    await page.click('.gh-starter[data-add-category="home"]');
    await page.waitForSelector('.gh-lane', { visible: true, timeout: 8000 });
    m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      name: document.querySelector('.gh-name-input')?.value,
      age: document.querySelector('[data-field="once-age"]')?.value,
    }));
    if(m.lanes !== 3 || m.name !== 'Home improvements' || m.age !== '68')
      throw new Error(`new-household starter did not derive from its 65 retirement age (${JSON.stringify(m)})`);

    await goToWizardStep(page, 'family');
    await stableClick('#hh-menu-btn');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    await page.click('.htab[data-sub-target="goals"]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.gh-chip__name')]
        .some(element => element.textContent.includes('European summers')),
      { timeout: 8000 },
    );
    const restored = await page.evaluate(() => [...document.querySelectorAll('.gh-chip__name')].map(el => el.textContent));
    if(!restored.includes('European summers') || !restored.some(name => name.endsWith(' copy')))
      throw new Error(`saved custom Goals Horizon inventory did not persist (${JSON.stringify(restored)})`);
  });

  await step('scenarios Compare view: columns, rings, levers, goals', async () => {
    await page.click('button[data-page="scenarios"]');
    await page.waitForFunction(() => {
      const scenariosPage = document.querySelector('.page[data-page="scenarios"]');
      const runButton = document.querySelector('#run-btn');
      const status = document.querySelector('#status')?.textContent || '';
      return scenariosPage?.classList.contains('on')
        && runButton
        && !runButton.disabled
        && /Plan updated|Partial run/i.test(status);
    }, { timeout: 30000 });
    await page.click('#scn-seg-compare');
    await page.waitForFunction(() => {
      const view = document.querySelector('#scn-view');
      const columns = [...(view?.querySelectorAll('.scol') || [])];
      const probabilities = columns.map(column => (
        column.querySelector('.scol__prob')?.textContent.trim() || ''
      ));
      return document.querySelector('#scn-seg-compare')?.classList.contains('is-active')
        && !!view?.querySelector('.compare')
        && columns.length > 0
        && probabilities.every(value => /\d/.test(value));
    }, { timeout: 30000 });
    const m = await page.evaluate(() => {
      const v = document.querySelector('#scn-view');
      return {
        compare: !!v?.querySelector('.compare'),
        cols: v?.querySelectorAll('.scol').length || 0,
        rings: v?.querySelectorAll('.ring__arc').length || 0,
        probs: [...(v?.querySelectorAll('.scol__prob') || [])].map(e => e.textContent.trim()),
        names: [...(v?.querySelectorAll('.scol__name') || [])].map(e => e.textContent.trim()),
        leverNames: [...(v?.querySelectorAll('.lever__name') || [])].map(e => e.textContent.trim()),
        goalCells: v?.querySelectorAll('.cell--goal').length || 0,
        goalPill: v?.querySelector('.goal-pill, .goal-note')?.textContent || '',
        reference: !!v?.querySelector('.tag-ref'),
        solveBtn: !!document.querySelector('#scn-solve'),
        addBtn: !!document.querySelector('#scn-add'),
        suggestBtn: !!document.querySelector('#scn-suggest'),   // removed control — must stay gone
        status: document.querySelector('#status')?.textContent || '',
        segActive: document.querySelector('#scn-seg-compare')?.classList.contains('is-active') || false,
      };
    });
    if(!m.compare) throw new Error(`Compare view did not render (status="${m.status}")`);
    if(m.cols < 1) throw new Error(`no scenario columns rendered (cols=${m.cols}, status="${m.status}")`);
    if(m.rings < m.cols) throw new Error(`success rings missing (rings=${m.rings}, cols=${m.cols})`);
    if(!m.probs.some(p => /\d/.test(p))) throw new Error(`scenario probabilities not populated: ${JSON.stringify(m.probs)}`);
    if(!m.leverNames.includes('Plan Levers')) throw new Error(`Plan Levers header missing: ${JSON.stringify(m.leverNames)}`);
    if(m.goalCells < m.cols) throw new Error(`goals row not mirrored across columns (cells=${m.goalCells}, cols=${m.cols})`);
    if(!/active/.test(m.goalPill)) throw new Error(`goals summary cell missing an active count: "${m.goalPill}"`);
    if(!m.reference) throw new Error('baseline Reference tag missing from Compare');
    if(m.solveBtn) throw new Error('removed Solve control is still present in Scenarios');
    if(!m.addBtn) throw new Error('Add toolbar action missing from Scenarios');
    if(m.suggestBtn) throw new Error('removed Suggest button is still present in the Scenarios toolbar');
    if(!m.segActive) throw new Error('Compare segment did not mark itself active');
    if(m.names.some(n => /sell\s*home/i.test(n))) throw new Error(`stale sale scenario visible: ${JSON.stringify(m.names)}`);

    // Compare is editable: discrete levers (ages, allocation) now show always-visible
    // .cmp-step-btn[data-scn-id] buttons; dollar levers show .cmp-lev-in type-in inputs.
    // Both carry data-scn-id. Step up then back so the baseline is left as found.
    const cmpStepBtns = await page.evaluate(() => document.querySelectorAll('#scn-view .compare .cmp-step-btn[data-scn-id]').length);
    const cmpInputs   = await page.evaluate(() => document.querySelectorAll('#scn-view .compare .cmp-lev-in[data-scn-id]').length);
    if(cmpStepBtns < 2 && cmpInputs < 1) throw new Error(`Compare lever controls missing (stepBtns=${cmpStepBtns}, inputs=${cmpInputs})`);
    const compareEditSessionBefore = await cashFlowSessionSnapshot(page, {
      bundleSentinel: 'compare-scenario-edit',
      rememberBundle: true,
    });
    const cmpStep = await page.evaluate(() => {
      const button = document.querySelector(
        '#scn-view .compare .cmp-step-btn[data-dir="1"][data-scn-id]',
      );
      return {
        scenarioId: button?.dataset.scnId || '',
        leverKey: button?.dataset.leverKey || '',
        value: button?.closest('.cmp-lev-row')
          ?.querySelector('.cmp-lev-val')?.textContent.trim() || '',
      };
    });
    await page.evaluate(({ scenarioId, leverKey }) => {
      [...document.querySelectorAll(
        '#scn-view .compare .cmp-step-btn[data-dir="1"][data-scn-id]',
      )].find(button => button.dataset.scnId === scenarioId
        && button.dataset.leverKey === leverKey)?.click();
    }, cmpStep);
    await page.waitForFunction(({ scenarioId, leverKey, value }) => {
      const button = [...document.querySelectorAll(
        '#scn-view .compare .cmp-step-btn[data-dir="1"][data-scn-id]',
      )].find(candidate => candidate.dataset.scnId === scenarioId
        && candidate.dataset.leverKey === leverKey);
      const current = button?.closest('.cmp-lev-row')
        ?.querySelector('.cmp-lev-val')?.textContent.trim() || '';
      return current !== value
        && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
    }, { timeout: 30000 }, cmpStep);
    await page.evaluate(({ scenarioId, leverKey }) => {
      [...document.querySelectorAll(
        '#scn-view .compare .cmp-step-btn[data-dir="-1"][data-scn-id]',
      )].find(button => button.dataset.scnId === scenarioId
        && button.dataset.leverKey === leverKey)?.click();
    }, cmpStep);
    await page.waitForFunction(({ scenarioId, leverKey, value }) => {
      const button = [...document.querySelectorAll(
        '#scn-view .compare .cmp-step-btn[data-dir="-1"][data-scn-id]',
      )].find(candidate => candidate.dataset.scnId === scenarioId
        && candidate.dataset.leverKey === leverKey);
      const current = button?.closest('.cmp-lev-row')
        ?.querySelector('.cmp-lev-val')?.textContent.trim() || '';
      return current === value
        && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
    }, { timeout: 30000 }, cmpStep);
    const compareEditSessionAfter = await cashFlowSessionSnapshot(page, {
      bundleSentinel: 'compare-scenario-edit',
    });
    if(JSON.stringify(compareEditSessionAfter) !== JSON.stringify(compareEditSessionBefore)){
      throw new Error(`Scenario edit rebuilt or mutated the household-session Monte Carlo bundle: ${JSON.stringify({
        before: compareEditSessionBefore,
        after: compareEditSessionAfter,
      })}`);
    }

    await page.screenshot({ path: join(OUT, '03-scenarios.png'), fullPage: true });
  });

  await step('scenarios Focus view: hero ring, lever steppers, goals, rail', async () => {
    await page.click('#scn-seg-focus');
    await new Promise(r => setTimeout(r, 400));
    const m = await page.evaluate(() => {
      const v = document.querySelector('#scn-view');
      return {
        focus: !!v?.querySelector('.focus'),
        heroRing: !!v?.querySelector('.hero .ring__arc'),
        heroNumeral: v?.querySelector('.hero__numeral')?.textContent || '',
        steppers: v?.querySelectorAll('.assum__stepper .stepper-btn[data-lever-key]').length || 0,
        goalRows: v?.querySelectorAll('.goal-row').length || 0,
        railCards: v?.querySelectorAll('.rail-card[data-pick]').length || 0,
        railFocus: !!v?.querySelector('.rail-card__tag--focus'),
        segActive: document.querySelector('#scn-seg-focus')?.classList.contains('is-active') || false,
      };
    });
    if(!m.focus) throw new Error('Focus view did not render');
    if(!m.heroRing) throw new Error('Focus hero ring missing');
    if(!/\d/.test(m.heroNumeral)) throw new Error(`Focus hero probability not populated: "${m.heroNumeral}"`);
    if(m.steppers < 2) throw new Error(`Focus lever steppers missing (${m.steppers})`);
    if(m.goalRows < 1) throw new Error(`Focus goals list rendered no rows (${m.goalRows})`);
    if(m.railCards < 1) throw new Error(`Focus scenario rail rendered no cards (${m.railCards})`);
    if(!m.railFocus) throw new Error('Focus rail did not mark the in-focus scenario');
    if(!m.segActive) throw new Error('Focus segment did not mark itself active');

    // A lever stepper saves and runs automatically. Step up then back down so
    // the scenario's levers and results are left exactly as found.
    const focusedLeverBefore = await page.$eval(
      '#scn-view .assum__stepper',
      element => element.textContent.replace(/\s+/g, ' ').trim(),
    );
    await page.evaluate(() => document.querySelector('#scn-view .assum__stepper .stepper-btn[data-dir="1"]')?.click());
    await page.waitForFunction(before => {
      const current = document.querySelector('#scn-view .assum__stepper')
        ?.textContent.replace(/\s+/g, ' ').trim() || '';
      return current !== before
        && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
    }, { timeout: 30000 }, focusedLeverBefore);
    await page.evaluate(() => document.querySelector('#scn-view .assum__stepper .stepper-btn[data-dir="-1"]')?.click());
    await page.waitForFunction(before => {
      const current = document.querySelector('#scn-view .assum__stepper')
        ?.textContent.replace(/\s+/g, ' ').trim() || '';
      return current === before
        && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
    }, { timeout: 30000 }, focusedLeverBefore);
    await page.screenshot({ path: join(OUT, '03b-scenarios-focus.png'), fullPage: true });
  });

  await step('scenarios zero-base savings changes a fourth column and survives reload', async () => {
    await page.click('#scn-seg-compare');
    await page.click('#scn-add');
    await page.waitForFunction(() => {
      const columns = [...document.querySelectorAll('#scn-view .scol')];
      const probabilities = columns.map(column => column.querySelector('.scol__prob')?.textContent.trim() || '');
      return columns.length === 4
        && probabilities.every(value => /\d/.test(value))
        && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
    }, { timeout: 30000 });

    const savingsInputs = await page.$$('#scn-view .cmp-lev-in[data-key="savings"]');
    const savingsInput = savingsInputs.at(-1);
    if(!savingsInput) throw new Error('fourth scenario savings input was not available');
    await savingsInput.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type('45000');
    await page.keyboard.press('Tab');
    await page.waitForFunction((householdId) => {
      const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')]
        .map(element => element.textContent.trim());
      const savings = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')]
        .map(input => input.value.replace(/[^0-9.]/g, ''));
      const saved = JSON.parse(localStorage.getItem(`parallax.scenarios.${householdId}.v1`) || '[]');
      return probabilities.length === 4
        && probabilities.every(value => /\d/.test(value))
        && savings[3] === '45000'
        && saved.find(scenario => scenario.name === 'Scenario D')?.lev?.savings === 45000
        && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
    }, { timeout: 30000 }, withdrawalPlannerFixtureHouseholdId);

    const beforeReload = await page.evaluate((householdId) => {
      const medians = [...document.querySelectorAll('#scn-view .scol__median b')]
        .map(element => element.textContent.trim());
      const savings = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')]
        .map(input => input.value.replace(/[^0-9.]/g, ''));
      const spending = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="spend"]')]
        .map(input => input.value.replace(/[^0-9.]/g, ''));
      const saved = JSON.parse(localStorage.getItem(`parallax.scenarios.${householdId}.v1`) || '[]');
      return {
        medians,
        savings,
        spending,
        savedSavings: saved.find(scenario => scenario.name === 'Scenario D')?.lev?.savings,
      };
    }, withdrawalPlannerFixtureHouseholdId);
    const zeroBaseSessionBeforeReload = await cashFlowSessionSnapshot(page, {
      includeBundleIdentity: true,
    });
    const exactMedians = JSON.parse(zeroBaseSessionBeforeReload.probabilityRangeEnvelopeBytes)
      .map(analysis => analysis?.envelope?.at(-1)?.p50 ?? null);
    if(beforeReload.medians.length !== 4
        || beforeReload.medians.some(value => !/^\$[\d,.]+[KMB]?$/.test(value))
        || exactMedians.length !== 4
        || exactMedians.some(value => !Number.isFinite(value))
        || exactMedians[3] === exactMedians[0]
        || beforeReload.savings[3] !== '45000'
        || beforeReload.spending[3] !== beforeReload.spending[0]
        || beforeReload.savedSavings !== 45000){
      throw new Error(`zero-base savings did not reach the fourth scenario: ${JSON.stringify({
        ...beforeReload,
        exactMedians,
      })}`);
    }

    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    await stableClick('button[data-page="scenarios"]');
    await page.waitForFunction(() => {
      const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')]
        .map(element => element.textContent.trim());
      const savings = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')]
        .map(input => input.value.replace(/[^0-9.]/g, ''));
      return probabilities.length === 4
        && probabilities.every(value => /\d/.test(value))
        && savings[3] === '45000';
    }, { timeout: 30000 });
    const zeroBaseSessionAfterReload = await cashFlowSessionSnapshot(page, {
      includeBundleIdentity: true,
    });
    const afterReload = await page.evaluate(() => ({
        medians: [...document.querySelectorAll('#scn-view .scol__median b')]
          .map(element => element.textContent.trim()),
        spending: [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="spend"]')]
          .map(input => input.value.replace(/[^0-9.]/g, '')),
        errors: [...document.querySelectorAll('#scn-view .scol__prob')]
          .filter(element => !/\d/.test(element.textContent || '')).length,
      }));
    if(afterReload.errors !== 0
        || afterReload.medians.length !== beforeReload.medians.length
        || afterReload.medians.some(value => !/^\$[\d,.]+[KMB]?$/.test(value))
        || JSON.stringify(afterReload.spending) !== JSON.stringify(beforeReload.spending)){
      throw new Error(`saved scenarios changed or blanked after reload: ${JSON.stringify({ beforeReload, afterReload })}`);
    }
    if(zeroBaseSessionAfterReload.seed === zeroBaseSessionBeforeReload.seed
        || zeroBaseSessionAfterReload.bundleIdentityHash === zeroBaseSessionBeforeReload.bundleIdentityHash){
      throw new Error(`saved Scenario reload reused the previous Monte Carlo session: ${JSON.stringify({
        before: zeroBaseSessionBeforeReload,
        after: zeroBaseSessionAfterReload,
      })}`);
    }
    await page.screenshot({ path: join(OUT, '03c-scenarios-savings-reloaded.png'), fullPage: true });
  });

  await step('entered planning ages cap Goals and Focus results', async () => {
    await page.evaluate((householdId) => {
      const key = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(key) || '{}');
      const household = db[householdId];
      if(!household) return;
      household.meta.filingStatus = 'marriedFilingJointly';
      household.household.primary = {
        currentAge: 64,
        retirementAge: 66,
        planEndAge: 80,
        birthYear: 1962,
      };
      household.household.spouse = {
        currentAge: 60,
        retirementAge: 65,
        planEndAge: 100,
        birthYear: 1966,
      };
      household.income.socialSecurity.spouse = { pia: null, claimAge: 67 };
      household.portfolio.accounts = {
        taxable: {
          ...household.portfolio.accounts.taxable,
          balance: 50000000,
          basisPct: 1,
        },
        traditional: {
          ...household.portfolio.accounts.traditional,
          balance: 0,
        },
        roth: {
          ...household.portfolio.accounts.roth,
          balance: 0,
        },
      };
      household.portfolio.extraAccounts = [];
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
      localStorage.removeItem('parallax.cashFlowPath.v1');
    }, withdrawalPlannerFixtureHouseholdId);
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    await page.click('.htab[data-sub-target="goals"]');
    await page.waitForSelector('.gh-page', { visible: true, timeout: 8000 });
    const horizon = await page.evaluate(() => ({
      terminalTick: [...document.querySelectorAll('.gh-tick')].at(-1)?.textContent.trim() || '',
      axisMax: document.querySelector('.gh-lanes')?.getAttribute('data-axis-max') || '',
    }));
    if(horizon.terminalTick !== '100' || horizon.axisMax !== '101'){
      throw new Error(`entered planning age did not cap the Goals horizon: ${JSON.stringify(horizon)}`);
    }
    await page.$eval('#run-btn', button => button.click());
    await page.waitForFunction(
      () => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''),
      { timeout: 30000 },
    );
    await page.click('button[data-page="scenarios"]');
    await page.waitForSelector('#scn-view', { visible: true, timeout: 8000 });
    await page.click('#scn-seg-focus');
    await page.waitForFunction(
      () => !!document.querySelector('#scn-view .focus .viability__text'),
      { timeout: 8000 },
    );
    const viability = await page.$eval(
      '#scn-view .focus .viability__text',
      element => element.textContent.trim(),
    );
    if(viability !== 'Funds last to age 100'){
      throw new Error(`entered planning age did not cap the Focus result: "${viability}"`);
    }
  });

  await step('cash-flow view: exact columns, rows, summary, path controls, pills', async () => {
    // Re-anchor the saved plan + scenario levers after earlier household edits.
    await page.evaluate((householdId) => {
      const key = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(key) || '{}');
      const household = db[householdId];
      if(!household) return;
      household.meta.primaryName = 'Test Client';
      household.meta.spouseName = 'Test Co-Client';
      household.meta.filingStatus = 'marriedFilingJointly';
      household.household.primary = { currentAge: 64, retirementAge: 66, planEndAge: 96, birthYear: 1962 };
      household.household.spouse = { currentAge: 63, retirementAge: 65, planEndAge: 95, birthYear: 1963 };
      household.portfolio.accounts = {
        taxable: { balance:0, basisPct:1 },
        traditional: { balance:0 },
        roth: { balance:0 },
      };
      household.portfolio.extraAccounts = [
        { type:'Traditional IRA', bucket:'traditional', owner:'client', balance:1600000 },
        { type:'Brokerage (taxable)', bucket:'taxable', owner:'spouse', balance:800000 },
        { type:'Roth IRA', bucket:'roth', owner:'spouse', balance:400000 },
      ];
      delete household.meta.accountSchemaVersion;
      delete household.meta.householdRecordSchemaVersion;
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
    }, withdrawalPlannerFixtureHouseholdId);
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    try{
      await page.waitForFunction(() => {
        const buttons = document.querySelectorAll('#run-btn');
        const status = document.querySelector('#status')?.textContent.trim() || '';
        return buttons.length === 1
          && !buttons[0].disabled
          && !/Running/i.test(status)
          && /Plan updated|Partial run/i.test(status);
      }, { timeout: 30000 });
    }catch(error){
      const observed = await page.evaluate(() => ({
        runButtonCount: document.querySelectorAll('#run-btn').length,
        runButtonDisabled: document.querySelector('#run-btn')?.disabled ?? null,
        status: document.querySelector('#status')?.textContent.trim() ?? null,
      }));
      throw new Error(
        `Cash Flow Run baseline did not settle: ${JSON.stringify({ observed, consoleErrors: errs })}; ${error.message || error}`,
      );
    }
    await page.$eval('#run-btn', button => {
      const status = document.querySelector('#status');
      const baselineStatus = status?.textContent.trim() || '';
      if(button.disabled || /Running/i.test(baselineStatus)){
        throw new Error(`Run action baseline is not settled: ${JSON.stringify({
          baselineStatus,
          buttonDisabled: button.disabled,
        })}`);
      }
      const tracker = {
        baselineStatus,
        observed: [],
        sawRunning: false,
        sawDisabled: false,
        observer: null,
      };
      const record = () => {
        const value = status?.textContent.trim() || '';
        if(tracker.observed.at(-1) !== value) tracker.observed.push(value);
        if(/Running/i.test(value)) tracker.sawRunning = true;
        if(button.disabled) tracker.sawDisabled = true;
      };
      tracker.observer = new MutationObserver(record);
      if(status){
        tracker.observer.observe(status, { childList: true, characterData: true, subtree: true });
      }
      tracker.observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
      globalThis.__parallaxVerifyCashFlowRunTracker = tracker;
      button.click();
      record();
      tracker.postClickStatus = status?.textContent.trim() || '';
      tracker.postClickDisabled = button.disabled;
      if(tracker.postClickStatus !== 'Running…' || tracker.postClickDisabled !== true){
        tracker.observer.disconnect();
        delete globalThis.__parallaxVerifyCashFlowRunTracker;
        throw new Error(`Run action did not synchronously enter Running: ${JSON.stringify({
          baselineStatus,
          postClickStatus: tracker.postClickStatus,
          postClickDisabled: tracker.postClickDisabled,
        })}`);
      }
    });
    let cashFlowRunError = null;
    try{
      await page.waitForFunction(() => {
        const tracker = globalThis.__parallaxVerifyCashFlowRunTracker;
        const status = document.querySelector('#status')?.textContent.trim() || '';
        const button = document.querySelector('#run-btn');
        return tracker?.sawRunning === true
          && tracker.sawDisabled === true
          && button
          && !button.disabled
          && /Plan updated|Partial run/i.test(status);
      }, { timeout: 30000 });
    }catch(error){
      cashFlowRunError = error;
    }
    const cashFlowRunDiagnostic = await page.evaluate(() => {
      const tracker = globalThis.__parallaxVerifyCashFlowRunTracker;
      tracker?.observer?.disconnect();
      const diagnostic = {
        baselineStatus: tracker?.baselineStatus ?? null,
        postClickStatus: tracker?.postClickStatus ?? null,
        postClickDisabled: tracker?.postClickDisabled ?? null,
        sawRunning: tracker?.sawRunning === true,
        sawDisabled: tracker?.sawDisabled === true,
        observedStatuses: tracker?.observed ?? [],
        finalStatus: document.querySelector('#status')?.textContent.trim() ?? null,
        runButtonCount: document.querySelectorAll('#run-btn').length,
        runButtonDisabled: document.querySelector('#run-btn')?.disabled ?? null,
      };
      delete globalThis.__parallaxVerifyCashFlowRunTracker;
      return diagnostic;
    });
    if(cashFlowRunError){
      throw new Error(
        `Cash Flow Run did not reach its observable completion state: ${JSON.stringify({
          observed: cashFlowRunDiagnostic,
          consoleErrors: errs,
        })}; ${cashFlowRunError.message || cashFlowRunError}`,
      );
    }

    await page.click('button[data-page="scenarios"]');
    await setCashFlow(page, true);
    await waitCashRows(page, 10);
    const EXPECT = ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'];
    const m = await page.evaluate(() => {
      const v = document.querySelector('#scn-view');
      return {
        cf: !!v?.querySelector('.cf'),
        rows: v?.querySelectorAll('.cf-row').length || 0,
        cols: [...(v?.querySelectorAll('.cf-table__head .cf-th') || [])].map(th => th.textContent.trim()),
        scenarioOptions: [...(v?.querySelectorAll('[data-cash-select] option') || [])].map(option => ({
          value: option.value,
          label: option.textContent.trim(),
        })),
        activeScenario: v?.querySelector('[data-cash-select]')?.selectedOptions?.[0]?.textContent.trim() || '',
        stats: [...(v?.querySelectorAll('.cf-stat__label') || [])].map(s => s.textContent.trim()),
        summaryMetrics: [...(v?.querySelectorAll('[data-cash-header-metric]') || [])].map(metric => ({
          id: metric.dataset.cashHeaderMetric || '',
          label: metric.querySelector('.cf-stat__label')?.textContent.trim() || '',
          value: metric.querySelector('.cf-stat__value')?.textContent.trim() || '',
          support: metric.querySelector('.cf-stat__support')?.textContent.trim() || '',
        })),
        pathControls: !!v?.querySelector('#scn-cf-path-controls #cashflow-path-mode'),
        mode: v?.querySelector('#scn-cf-path-controls #cashflow-path-mode')?.value || '',
        taxHeader: (() => {
          const th = v?.querySelector('.cf-table__head .cf-th[data-tax-source]');
          return th ? {
            label: th.textContent.trim(),
            source: th.dataset.taxSource || '',
            scope: th.dataset.taxScope || '',
            title: th.getAttribute('title') || '',
          } : null;
        })(),
        taxCompare: (() => {
          const el = v?.querySelector('[data-tax-compare]');
          return el ? {
            federalTotal: Number(el.dataset.federalTotal),
            enginePathTotal: Number(el.dataset.enginePathTotal),
            delta: Number(el.dataset.delta),
            labels: [...el.querySelectorAll('.cf-stat__label')].map(label => label.textContent.trim()),
            values: [...el.querySelectorAll('.cf-stat__value')].map(value => value.textContent.trim()),
          } : null;
        })(),
        federalTotal: (() => {
          const el = v?.querySelector('.cf-stat--federal[data-federal-total]');
          return el ? {
            amount: Number(el.dataset.federalTotal),
            label: el.querySelector('.cf-stat__label')?.textContent.trim() || '',
            value: el.querySelector('.cf-stat__value')?.textContent.trim() || '',
          } : null;
        })(),
        taxDisclosure: (() => {
          const el = v?.querySelector('[data-tax-disclosure]');
          return el ? {
            state: el.dataset.taxState || '',
            fallback: el.querySelector('[data-tax-fallback]')?.textContent.trim() || '',
            warnings: [...el.querySelectorAll('[data-tax-warnings] li')].map(item => item.textContent.trim()),
          } : null;
        })(),
        accumTax: (() => {
          const row = [...(v?.querySelectorAll('.cf-row') || [])].find(el =>
            el.querySelector('.cf-cell--age')?.textContent.trim() === '64'
          );
          return row?.querySelector('.cf-cell--tax')?.textContent.trim() || '';
        })(),
        hasCaption: !!v?.querySelector('.cf__caption'),
        hasCfEyebrow: !!v?.querySelector('.cf__head .eyebrow'),
        hasSummaryName: !!v?.querySelector('.cf-summary__name'),
        hasProbability: /Probability of success/i.test(v?.querySelector('.cf-summary')?.textContent || ''),
        hasRemovedHelperCopy: /All figures in today's dollars|One historical sequence, not a probability/i.test(v?.textContent || ''),
      };
    });
    if(!m.cf) throw new Error('cash-flow view did not render');
    if(m.rows < 10) throw new Error(`cash-flow rows = ${m.rows} (expected >=10)`);
    if(JSON.stringify(m.cols) !== JSON.stringify(EXPECT)) throw new Error(`cash-flow columns are not the exact contract: ${JSON.stringify(m.cols)}`);
    if(m.cols.filter(c => /tax/i.test(c)).length !== 1) throw new Error(`cash flow must have exactly one scoped tax column: ${JSON.stringify(m.cols)}`);
    if(m.taxHeader?.source !== 'federal-converged-row' || m.taxHeader?.scope !== 'MODELED_FEDERAL_LINE_24') throw new Error(`typical path converged tax scope missing: ${JSON.stringify(m.taxHeader)}`);
    if(!/retirement rows funded and converged; working years reporting-only/i.test(m.taxHeader?.title || '')) throw new Error(`typical path tax tooltip missing phase scope: ${JSON.stringify(m.taxHeader)}`);
    if(m.taxCompare) throw new Error(`obsolete federal-vs-engine comparison is still shown: ${JSON.stringify(m.taxCompare)}`);
    if(m.taxDisclosure) throw new Error(`normal Cash Flow should not show federal scope or status copy: ${JSON.stringify(m.taxDisclosure)}`);
    if(!/^\$[\d,]+/.test(m.accumTax)) throw new Error(`accumulation-year Tax cell is not populated: "${m.accumTax}"`);
    if(m.cols.some(c => ['Withdraw', 'One-time', 'Return $', 'Starting value', 'Inflows', 'Outflows', 'Annual return', 'Ending value'].includes(c))) throw new Error(`old cash-flow columns still present: ${JSON.stringify(m.cols)}`);
    if(m.scenarioOptions.length < 2) throw new Error(`Cash Flow scenario selector options missing: ${JSON.stringify(m.scenarioOptions)}`);
    if(!/Baseline/.test(m.activeScenario)) throw new Error(`Cash Flow scenario selector did not start on Baseline: ${JSON.stringify(m)}`);
    if(!SKIP_SEQUENCING && !m.pathControls) throw new Error('Cash Flow path controls not relocated into #scn-cf-path-controls');
    if(!SKIP_SEQUENCING && m.mode !== 'typical') throw new Error(`Cash Flow default path not Typical (${m.mode})`);
    for(const label of ['Funded through', 'Ending position']){
      if(!m.stats.includes(label)) throw new Error(`cash-flow summary stat missing: ${label} (${JSON.stringify(m.stats)})`);
    }
    if(JSON.stringify(m.summaryMetrics.map(metric => metric.id)) !== JSON.stringify(['funded-through', 'ending-position'])) throw new Error(`Typical Cash Flow metric contract drifted: ${JSON.stringify(m.summaryMetrics)}`);
    if(m.summaryMetrics[0]?.support !== 'Plan end' || m.summaryMetrics[1]?.support !== 'Median path') throw new Error(`Typical Cash Flow metric support drifted: ${JSON.stringify(m.summaryMetrics)}`);
    if(m.hasProbability || m.stats.some(label => ['Probability of success', 'Median Ending', 'Federal total'].includes(label)) || m.federalTotal) throw new Error(`removed Cash Flow summary content returned: ${JSON.stringify(m)}`);
    if(m.hasRemovedHelperCopy) throw new Error('removed Cash Flow helper copy returned');
    // Lifetime Draw / Funds Last were removed from the summary strip — stay gone.
    if(m.stats.some(s => /lifetime draw|funds last/i.test(s))) throw new Error(`removed summary stat still present: ${JSON.stringify(m.stats)}`);
    if(m.hasCaption) throw new Error('cash-flow caption should be removed');
    if(m.hasCfEyebrow) throw new Error('redundant Cash Flow eyebrow still in cf header');
    if(m.hasSummaryName) throw new Error('redundant scenario name still in summary strip');
    if(await page.evaluate(() => !!document.querySelector('#scn-view .cf-phase__name'))) throw new Error('phase header labels should be removed');

    // Retirement start = filled dot on the year column of the first non-accum row.
    const retirementStartAge = () => page.evaluate(() => {
      const row = document.querySelector('#scn-view .cf-row__mark-dot--ret')?.closest('.cf-row');
      return row ? (row.querySelector('.cf-cell--age')?.textContent.trim() || '') : '';
    });
    const retireAge = await retirementStartAge();
    if(retireAge !== '66') throw new Error(`baseline retirement start not at age 66 (got "${retireAge}")`);
    const rmdBoundary = await page.evaluate(async () => {
      const { scenarios } = await import('./src/state.js');
      const baselines = scenarios.filter(scenario => scenario.base);
      const views = document.querySelectorAll('#scn-view .cf');
      if(baselines.length !== 1 || views.length !== 1){
        throw new Error('RMD boundary proof requires one Baseline and one Cash Flow view');
      }
      const view = views[0];
      const simulation = baselines[0].res?.paths?.p50;
      if(!Array.isArray(simulation?.rows)
          || view.dataset.simIndex !== String(simulation.simIndex)){
        throw new Error('RMD boundary proof must use the displayed Baseline Typical simulation');
      }
      const visibleRows = [...view.querySelectorAll('.cf-row')];
      const visibleAges = new Set(visibleRows.map(row => row.dataset.age));
      const engineRows = simulation.rows.filter(row => visibleAges.has(String(row.age)));
      const firstRequired = engineRows.find(row => row.rmdRequired > 0);
      if(!firstRequired) throw new Error('RMD boundary fixture must contain an engine-required RMD');
      const firstRetirement = engineRows.find(row => row.phase !== 'accum');
      return {
        engineAge: String(firstRequired.age),
        displayedAge: visibleRows.find(row => row.children[3].textContent.trim())?.dataset.age ?? null,
        markerAges: [...view.querySelectorAll('.cf-row__mark-dot--rmd')]
          .map(marker => marker.closest('.cf-row').dataset.age),
        expectedMarkerAges: firstRequired.age === firstRetirement?.age ? [] : [String(firstRequired.age)],
      };
    });
    if(rmdBoundary.displayedAge !== rmdBoundary.engineAge
        || JSON.stringify(rmdBoundary.markerAges) !== JSON.stringify(rmdBoundary.expectedMarkerAges)){
      throw new Error(`RMD column and marker must follow the first engine-required RMD: ${JSON.stringify(rmdBoundary)}`);
    }

    // The scenario selector switches which plan's cash flow is shown, and each plan's
    // cash flow reflects ITS OWN retire age. The scenario initializer seeds Baseline at the
    // household retire age (66 here, asserted just above) and Scenario B at
    // +2 years (68), so selecting Scenario B must move the first
    // retirement-spending row from 66 to 68.
    const scenarioBValue = await page.evaluate(() => {
      const option = [...document.querySelectorAll('#scn-view [data-cash-select] option')]
        .find(item => /Scenario B/.test(item.textContent));
      return option?.value || '';
    });
    if(!scenarioBValue) throw new Error(`Scenario B option not found among ${JSON.stringify(m.scenarioOptions)}`);
    await page.select('#scn-view [data-cash-select]', scenarioBValue);
    await page.waitForFunction(() => {
      const active = document.querySelector('#scn-view [data-cash-select]')?.selectedOptions?.[0]?.textContent || '';
      const marker = document.querySelector('#scn-view .cf-row__mark-dot--ret')?.closest('.cf-row');
      return /Scenario B/.test(active) && marker?.dataset.age === '68';
    }, { timeout: 10000 });
    const bActive = await page.evaluate(() => document.querySelector('#scn-view [data-cash-select]')?.selectedOptions?.[0]?.textContent.trim() || '');
    if(!/Scenario B/.test(bActive)) throw new Error(`Cash Flow selector did not switch to Scenario B (got "${bActive}")`);
    const bMarker = await retirementStartAge();
    if(bMarker !== '68') throw new Error(`Scenario B retirement start not at age 68 (got "${bMarker}")`);
    // Restore Baseline for the historical-path checks below.
    const baselineValue = await page.evaluate(() => {
      const option = [...document.querySelectorAll('#scn-view [data-cash-select] option')]
        .find(item => /Baseline/.test(item.textContent));
      return option?.value || '';
    });
    if(!baselineValue) throw new Error('Baseline option missing from Cash Flow scenario selector');
    await page.select('#scn-view [data-cash-select]', baselineValue);
    await page.waitForFunction(() => {
      const active = document.querySelector('#scn-view [data-cash-select]')?.selectedOptions?.[0]?.textContent || '';
      const marker = document.querySelector('#scn-view .cf-row__mark-dot--ret')?.closest('.cf-row');
      return /Baseline/.test(active) && marker?.dataset.age === '66';
    }, { timeout: 10000 });

    const retirementOnly = await page.evaluate(() => (
      document.querySelector('#scn-view [data-cash-retstart]')?.getAttribute('aria-pressed') === 'true'
    ));
    if(retirementOnly) throw new Error('historical metric plan-year proof requires visible accumulation rows');

    const typicalRowsByPlanYear = await page.evaluate(() => (
      [...document.querySelectorAll('#scn-view .cf-row')].map((row, index) => ({
        planYear: index + 1,
        age: Number(row.dataset.age),
        year: Number(row.querySelector('.cf-row__year')?.textContent.trim()),
        phase: row.dataset.phase || '',
        sourceYear: row.dataset.sourceYear === '' ? null : Number(row.dataset.sourceYear),
        startBalance: Number(row.dataset.startBalance),
        endingBalance: Number(row.dataset.endingBalance),
        withdrawal: Number(row.dataset.withdrawal),
        wdRate: Number(row.dataset.wdRate),
        shortfall: Number(row.dataset.fundingShortfall),
      }))
    ));

    if(!SKIP_SEQUENCING){
      const pathReplayBefore = await page.evaluate(() => localStorage.getItem('parallax.pathReplay.v1'));
      const selectorContract = await page.evaluate(() => {
        const selectors = [...document.querySelectorAll('#cashflow-path-mode')];
        const select = selectors[0] ?? null;
        return {
          selectorCount: selectors.length,
          options: select ? [...select.options].map(option => ({
            value: option.value,
            label: option.textContent.trim().replace(/^[✓!]\s+/, ''),
          })) : [],
          oldSelectorCount: document.querySelectorAll('#path-mode').length,
          indexInputCount: document.querySelectorAll('#path-index').length,
          seedInputCount: document.querySelectorAll('#path-seed').length,
          regenerateCount: document.querySelectorAll('#cashflow-path-regenerate').length,
          persistedSeed: (() => {
            try{
              const value = JSON.parse(localStorage.getItem('parallax.pathReplay.v1') || '{}');
              return Object.prototype.hasOwnProperty.call(value, 'seed');
            }catch{
              return true;
            }
          })(),
        };
      });
      const expectedPathOptions = [
        { value: 'typical', label: 'Typical path' },
        { value: 'historical-1929', label: '1929 · Great Depression' },
        { value: 'historical-1937', label: '1937 · Double-Dip Recession' },
        { value: 'historical-1966', label: '1966 · Lost Decade' },
        { value: 'historical-1973', label: '1973 · Stagflation' },
        { value: 'historical-1995', label: '1995 · 90s Boom' },
        { value: 'historical-2000', label: '2000 · Dot-com Crash' },
        { value: 'historical-2008', label: '2008 · Financial Crisis' },
        { value: 'historical-2009', label: '2009 · Recovery Bull' },
        { value: 'historical-2022', label: '2022 · Inflation & Rate Shock' },
      ];
      if(selectorContract.selectorCount !== 1
          || JSON.stringify(selectorContract.options) !== JSON.stringify(expectedPathOptions)){
        throw new Error(`Cash Flow path registry mismatch: ${JSON.stringify({
          expected: expectedPathOptions,
          observed: selectorContract,
        })}`);
      }
      if(selectorContract.oldSelectorCount || selectorContract.indexInputCount || selectorContract.seedInputCount) throw new Error(`Cash Flow still exposes old replay controls: ${JSON.stringify(selectorContract)}`);
      if(selectorContract.persistedSeed) throw new Error('the session Monte Carlo seed is still persisted');
      if(selectorContract.regenerateCount !== 0) throw new Error(`Cash Flow still exposes a Regenerate control: ${JSON.stringify(selectorContract)}`);

      let reloadExpected = null;
      const observedHistoricalOutcomes = new Set();
      for(const [mode, startYear, periodName, expectedOutcome] of [
        ['historical-1973', 1973, 'Stagflation', 'survives'],
        ['historical-1995', 1995, '90s Boom', 'survives'],
      ]){
        await page.select('#cashflow-path-mode', mode);
        await waitForCashFlowPath(page, {
          pathId: mode,
          kind: 'historical',
          sourceYear: startYear,
          requireHistoricalSummary: true,
          timeout: 20000,
        });
        const historicalPath = await page.evaluate(() => {
          const th = document.querySelector('#scn-view .cf-table__head .cf-th[data-tax-source]');
          const disclosure = document.querySelector('#scn-view [data-tax-disclosure]');
          const root = document.querySelector('#scn-view .cf');
          const summary = document.querySelector('#scn-view [data-cash-path-metrics]');
          const rows = [...document.querySelectorAll('#scn-view .cf-row')].map((row, index) => ({
            planYear: index + 1,
            age: Number(row.dataset.age),
            year: Number(row.querySelector('.cf-row__year')?.textContent.trim()),
            phase: row.dataset.phase || '',
            sourceYear: row.dataset.sourceYear === '' ? null : Number(row.dataset.sourceYear),
            startBalance: Number(row.dataset.startBalance),
            endingBalance: Number(row.dataset.endingBalance),
            withdrawal: Number(row.dataset.withdrawal),
            wdRate: Number(row.dataset.wdRate),
            shortfall: Number(row.dataset.fundingShortfall),
            endingText: row.querySelector('.cf-cell--ending')?.textContent.trim() || '',
          }));
          const retirementRows = rows.filter(row => row.phase === 'retirement');
          const status = document.querySelector('#cashflow-path-status');
          const summaryOutcome = summary?.dataset.outcome || '';
          const tokenColor = token => {
            const probe = document.createElement('span');
            probe.style.color = `var(${token})`;
            document.body.appendChild(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          };
          const normalizedStyle = (property, value) => {
            const probe = document.createElement('span');
            probe.style[property] = value;
            document.body.appendChild(probe);
            const normalized = getComputedStyle(probe)[property];
            probe.remove();
            return normalized;
          };
          const expectedStatusColor = tokenColor(summaryOutcome === 'survives' ? '--pos' : '--neg');
          const expectedAccentColor = tokenColor('--acc');
          const expectedNegativeColor = tokenColor('--neg');
          const expectedMutedColor = tokenColor('--muted');
          const expectedBodyColor = tokenColor('--body');
          const expectedInkColor = tokenColor('--ink');
          const expectedTitleTextShadow = normalizedStyle(
            'textShadow',
            '0 0 10px rgba(177, 132, 92, .35)'
          );
          const expectedSelectedBackgroundImage = normalizedStyle(
            'backgroundImage',
            'radial-gradient(130% 70% at 50% 0%, rgba(177, 132, 92, .055), rgba(177, 132, 92, 0) 72%)'
          );
          const expectedSelectedBoxShadow = normalizedStyle(
            'boxShadow',
            '0 0 22px rgba(177, 132, 92, .05), inset 0 0 0 1px rgba(177, 132, 92, .07)'
          );
          const rail = summary;
          const panelBody = document.querySelector('#scn-view .cf-panel__body');
          const reference = rail?.querySelector('[data-cash-path-reference]');
          const referenceTitle = rail?.querySelector('.cf-path-rail__reference-title');
          const referenceLabel = rail?.querySelector('.cf-path-rail__reference-label');
          const referenceValue = rail?.querySelector('.cf-path-rail__reference-value');
          const selectedGroup = rail?.querySelector('[data-cash-path-selected]');
          const selectedPeriod = rail?.querySelector('[data-cash-path-selected-period]');
          const selectedPeriodYear = selectedPeriod?.querySelector('.cf-path-rail__selected-period-year');
          const selectedPeriodName = selectedPeriod?.querySelector('.cf-path-rail__selected-period-name');
          const selectedMetric = rail?.querySelector('.cf-path-rail__metric');
          const metricName = selectedMetric?.querySelector('.cf-path-rail__metric-name');
          const figure = selectedMetric?.querySelector('.cf-path-rail__figure');
          const delta = selectedMetric?.querySelector('.cf-path-rail__delta');
          const firstColumnLabel = document.querySelector('#scn-view .cf-table__head .cf-th');
          const styles = element => element ? getComputedStyle(element) : null;
          const railStyle = styles(rail);
          const referenceStyle = styles(reference);
          const titleStyle = styles(referenceTitle);
          const referenceLabelStyle = styles(referenceLabel);
          const referenceValueStyle = styles(referenceValue);
          const selectedGroupStyle = styles(selectedGroup);
          const selectedPeriodStyle = styles(selectedPeriod);
          const selectedPeriodYearStyle = styles(selectedPeriodYear);
          const selectedPeriodNameStyle = styles(selectedPeriodName);
          const selectedMetricStyle = styles(selectedMetric);
          const metricNameStyle = styles(metricName);
          const figureStyle = styles(figure);
          const deltaStyle = styles(delta);
          return {
            mode: document.querySelector('#cashflow-path-mode')?.value || '',
            rootMode: root?.dataset.cashPathId || '',
            kind: root?.dataset.cashPathKind || '',
            header: th ? {
              label: th.textContent.trim(),
              source: th.dataset.taxSource || '',
              scope: th.dataset.taxScope || '',
            } : null,
            compare: !!document.querySelector('#scn-view [data-tax-compare]'),
            disclosure: disclosure ? {
              state: disclosure.dataset.taxState || '',
            } : null,
            stats: [...document.querySelectorAll('#scn-view .cf-stat__label')].map(label => label.textContent.trim()),
            reference: [...document.querySelectorAll('#scn-view [data-path-reference-metric]')].map(metric => ({
              id: metric.dataset.pathReferenceMetric || '',
              label: metric.querySelector('.cf-path-rail__reference-label')?.textContent.trim() || '',
              value: metric.querySelector('.cf-path-rail__reference-value')?.textContent.trim() || '',
            })),
            metrics: [...document.querySelectorAll('#scn-view [data-historical-metric]')].map(metric => ({
              id: metric.dataset.historicalMetric || '',
              label: metric.querySelector('.cf-path-rail__metric-name')?.textContent.trim() || '',
              figure: metric.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
              deltaText: metric.querySelector('.cf-path-rail__delta')?.textContent.trim() || '',
              deltaTone: metric.dataset.deltaTone || '',
              deltaColor: getComputedStyle(metric.querySelector('.cf-path-rail__delta')).color,
              thisPath: metric.dataset.thisPath === '' ? null : Number(metric.dataset.thisPath),
              typicalPath: metric.dataset.typicalPath === '' ? null : Number(metric.dataset.typicalPath),
              delta: metric.dataset.delta === '' ? null : Number(metric.dataset.delta),
              format: metric.dataset.format || '',
              thisPathAge: metric.dataset.thisPathAge === undefined ? null : Number(metric.dataset.thisPathAge),
              typicalPathAge: metric.dataset.typicalPathAge === undefined ? null : Number(metric.dataset.typicalPathAge),
              thisPathRecoveryStatus: metric.dataset.thisPathRecoveryStatus || '',
              typicalPathRecoveryStatus: metric.dataset.typicalPathRecoveryStatus || '',
              thisPathMargin: metric.dataset.thisPathMargin === undefined ? null : Number(metric.dataset.thisPathMargin),
              typicalPathMargin: metric.dataset.typicalPathMargin === undefined ? null : Number(metric.dataset.typicalPathMargin),
              marginDelta: metric.dataset.marginDelta === undefined ? null : Number(metric.dataset.marginDelta),
              thisPathMarginKind: metric.dataset.thisPathMarginKind || '',
              typicalPathMarginKind: metric.dataset.typicalPathMarginKind || '',
              planEndAge: metric.dataset.planEndAge === undefined ? null : Number(metric.dataset.planEndAge),
              planYear: metric.dataset.planYear === '' || metric.dataset.planYear === undefined
                ? null
                : Number(metric.dataset.planYear),
            })),
            railLayout: rail && panelBody ? {
              gridDisplay: getComputedStyle(panelBody).display,
              gridTemplateColumns: getComputedStyle(panelBody).gridTemplateColumns,
              railWidth: rail.getBoundingClientRect().width,
              railDisplay: railStyle.display,
              railDirection: railStyle.flexDirection,
              railAlignItems: railStyle.alignItems,
              railGap: railStyle.gap,
              railPadding: railStyle.padding,
              railBorderLeftWidth: railStyle.borderLeftWidth,
              railBorderLeftStyle: railStyle.borderLeftStyle,
              railBackground: railStyle.backgroundColor,
              railRadius: railStyle.borderRadius,
              baselineDelta: referenceTitle && firstColumnLabel
                ? Math.abs(referenceTitle.getBoundingClientRect().top - firstColumnLabel.getBoundingClientRect().top)
                : null,
              reference: {
                display: referenceStyle?.display || '',
                direction: referenceStyle?.flexDirection || '',
                alignItems: referenceStyle?.alignItems || '',
                gap: referenceStyle?.gap || '',
                width: reference?.getBoundingClientRect().width ?? null,
                padding: referenceStyle?.padding || '',
                borderBottomWidth: referenceStyle?.borderBottomWidth || '',
                borderBottomStyle: referenceStyle?.borderBottomStyle || '',
                background: referenceStyle?.backgroundColor || '',
                radius: referenceStyle?.borderRadius || '',
              },
              title: {
                text: referenceTitle?.textContent.trim() || '',
                fontSize: titleStyle?.fontSize || '',
                fontWeight: titleStyle?.fontWeight || '',
                letterSpacing: titleStyle?.letterSpacing || '',
                color: titleStyle?.color || '',
                textShadow: titleStyle?.textShadow || '',
                textTransform: titleStyle?.textTransform || '',
                marginBottom: titleStyle?.marginBottom || '',
                expectedTextShadow: expectedTitleTextShadow,
              },
              referenceLabel: {
                fontSize: referenceLabelStyle?.fontSize || '',
                lineHeight: referenceLabelStyle?.lineHeight || '',
                color: referenceLabelStyle?.color || '',
              },
              referenceValue: {
                fontSize: referenceValueStyle?.fontSize || '',
                color: referenceValueStyle?.color || '',
                whiteSpace: referenceValueStyle?.whiteSpace || '',
              },
              selected: {
                count: rail.querySelectorAll('[data-cash-path-selected]').length,
                display: selectedGroupStyle?.display || '',
                direction: selectedGroupStyle?.flexDirection || '',
                alignItems: selectedGroupStyle?.alignItems || '',
                gap: selectedGroupStyle?.gap || '',
                padding: selectedGroupStyle?.padding || '',
                radius: selectedGroupStyle?.borderRadius || '',
                backgroundImage: selectedGroupStyle?.backgroundImage || '',
                backgroundColor: selectedGroupStyle?.backgroundColor || '',
                boxShadow: selectedGroupStyle?.boxShadow || '',
                width: selectedGroup?.getBoundingClientRect().width ?? null,
              expectedBackgroundImage: expectedSelectedBackgroundImage,
              expectedBoxShadow: expectedSelectedBoxShadow,
            },
            selectedPeriod: {
              count: rail.querySelectorAll('[data-cash-path-selected-period]').length,
              id: selectedPeriod?.dataset.cashPathSelectedPeriod || '',
              text: selectedPeriod?.textContent.trim() || '',
              year: selectedPeriodYear?.textContent.trim() || '',
              name: selectedPeriodName?.textContent.trim() || '',
              childIndex: selectedGroup && selectedPeriod
                ? [...selectedGroup.children].indexOf(selectedPeriod)
                : -1,
              padding: selectedPeriodStyle?.padding || '',
              borderBottomWidth: selectedPeriodStyle?.borderBottomWidth || '',
              borderBottomStyle: selectedPeriodStyle?.borderBottomStyle || '',
              background: selectedPeriodStyle?.backgroundColor || '',
              radius: selectedPeriodStyle?.borderRadius || '',
              fontSize: selectedPeriodStyle?.fontSize || '',
              fontWeight: selectedPeriodStyle?.fontWeight || '',
              lineHeight: selectedPeriodStyle?.lineHeight || '',
              letterSpacing: selectedPeriodStyle?.letterSpacing || '',
              textAlign: selectedPeriodStyle?.textAlign || '',
              fontVariantNumeric: selectedPeriodStyle?.fontVariantNumeric || '',
              yearColor: selectedPeriodYearStyle?.color || '',
              nameColor: selectedPeriodNameStyle?.color || '',
            },
            metric: {
                display: selectedMetricStyle?.display || '',
                direction: selectedMetricStyle?.flexDirection || '',
                alignItems: selectedMetricStyle?.alignItems || '',
                textAlign: selectedMetricStyle?.textAlign || '',
                width: selectedMetric?.getBoundingClientRect().width ?? null,
                gap: selectedMetricStyle?.gap || '',
                nameFontSize: metricNameStyle?.fontSize || '',
                nameLineHeight: metricNameStyle?.lineHeight || '',
                nameColor: metricNameStyle?.color || '',
                figureFontSize: figureStyle?.fontSize || '',
                figureFontWeight: figureStyle?.fontWeight || '',
                figureColor: figureStyle?.color || '',
                figureWhiteSpace: figureStyle?.whiteSpace || '',
                deltaFontSize: deltaStyle?.fontSize || '',
              },
              dividerMetrics: [...rail.querySelectorAll('.cf-path-rail__metric')].slice(1).map(metric => {
                const style = getComputedStyle(metric);
                return {
                  paddingTop: style.paddingTop,
                  borderTopWidth: style.borderTopWidth,
                  borderTopStyle: style.borderTopStyle,
                };
              }),
              directChildBackgrounds: [...rail.children].map(child => getComputedStyle(child).backgroundColor),
              directChildRadii: [...rail.children].map(child => getComputedStyle(child).borderRadius),
              accentColor: expectedAccentColor,
              negativeColor: expectedNegativeColor,
              mutedColor: expectedMutedColor,
              bodyColor: expectedBodyColor,
              inkColor: expectedInkColor,
              figureColors: [...rail.querySelectorAll('.cf-path-rail__figure')].map(item => getComputedStyle(item).color),
              deltaColors: [...rail.querySelectorAll('.cf-path-rail__delta')].map(item => getComputedStyle(item).color),
              sentenceDeltaCopy: /(?:Dips|Recovers|less|more|Lasts just|Comparison unavailable)/i.test(rail.textContent || ''),
              oldSummaryCount: document.querySelectorAll('#scn-view .cf-summary--historical, #scn-view .cf-comparison').length,
              extraHeadingCount: rail.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
              extraQualifierCopy: /(?:·\s*age|no trough|WD rate|margin)/i.test(rail.textContent || ''),
              deltaPillCount: rail.querySelectorAll('[class*="pill"], [data-computed-delta]').length,
            } : null,
            probability: /Probability of success/i.test(summary?.textContent || ''),
            removedCopy: /All figures in today's dollars|One historical sequence, not a probability/i.test(root?.textContent || ''),
            statusGlyph: document.querySelector('#cashflow-path-status')?.textContent.trim() || '',
            statusClass: document.querySelector('#cashflow-path-status')?.className || '',
            statusColor: status ? getComputedStyle(status).color : '',
            expectedStatusColor,
            visibleShortfall: /Short\s+\$/i.test(root?.textContent || '')
              || !!root?.querySelector('.cf-row__shortfall'),
            rows,
            retirementRows,
            summary: summary ? { outcome: summary.dataset.outcome || '' } : null,
            persisted: JSON.parse(localStorage.getItem('parallax.cashFlowPath.v1') || '{}'),
            pathReplay: localStorage.getItem('parallax.pathReplay.v1'),
          };
        });
        if(historicalPath.mode !== mode || historicalPath.rootMode !== mode || historicalPath.kind !== 'historical') throw new Error(`${mode} did not stay selected: ${JSON.stringify(historicalPath)}`);
        if(historicalPath.summary?.outcome !== expectedOutcome) throw new Error(`${mode} did not produce the required ${expectedOutcome} matrix: ${JSON.stringify(historicalPath.summary)}`);
        observedHistoricalOutcomes.add(historicalPath.summary.outcome);
        if(historicalPath.persisted?.id !== mode) throw new Error(`${mode} selection did not persist independently: ${JSON.stringify(historicalPath.persisted)}`);
        if(historicalPath.pathReplay !== pathReplayBefore) throw new Error(`${mode} mutated Monte Carlo pathReplay`);
        if(historicalPath.header?.label !== 'Tax' || historicalPath.header?.source !== 'federal-converged-row' || historicalPath.header?.scope !== 'MODELED_FEDERAL_LINE_24') throw new Error(`${mode} tax scope is not converged federal: ${JSON.stringify(historicalPath)}`);
        if(historicalPath.compare) throw new Error(`${mode} still shows an obsolete sidecar comparison`);
        if(historicalPath.disclosure) throw new Error(`${mode} should not show federal scope or status copy: ${JSON.stringify(historicalPath.disclosure)}`);
        if(historicalPath.probability || historicalPath.removedCopy || historicalPath.stats.length) throw new Error(`${mode} still shows removed summary content: ${JSON.stringify(historicalPath)}`);
        if(!historicalPath.retirementRows.length || historicalPath.retirementRows.some(row => row.sourceYear === null)) throw new Error(`${mode} contains post-depletion filler rows: ${JSON.stringify(historicalPath.retirementRows)}`);
        if(historicalPath.visibleShortfall) throw new Error(`${mode} visibly reports a dollar shortfall`);
        for(let index = 1; index < historicalPath.rows.length; index++){
          if(historicalPath.rows[index].age !== historicalPath.rows[index - 1].age + 1
            || historicalPath.rows[index].year !== historicalPath.rows[index - 1].year + 1){
            throw new Error(`${mode} has a missing or duplicate age/year: ${JSON.stringify(historicalPath.rows)}`);
          }
        }
        const lastAccumulation = [...historicalPath.rows].reverse().find(row => row.phase === 'accum');
        const firstRetirement = historicalPath.retirementRows[0];
        if(lastAccumulation && Math.abs(lastAccumulation.endingBalance - firstRetirement.startBalance) > 0.01) throw new Error(`${mode} has a retirement balance jump: ${JSON.stringify({ lastAccumulation, firstRetirement })}`);
        const shortfallRows = historicalPath.retirementRows.filter(row => row.shortfall > 0.01);
        const lastRetirement = historicalPath.retirementRows.at(-1);
        if(!['underfunded', 'survives'].includes(historicalPath.summary?.outcome)){
          throw new Error(`${mode} has an unknown historical outcome: ${JSON.stringify(historicalPath.summary)}`);
        }
        const expectedMetricIds = [
          'max-real-drawdown',
          'recovery-period',
          'balance-at-age-80',
          'funded-through-margin',
        ];
        const expectedMetricLabels = [
          'Max Drawdown',
          'Recovery period',
          'Savings left at age 80',
          'Money lasts through',
        ];
        if(JSON.stringify(historicalPath.metrics.map(metric => metric.id)) !== JSON.stringify(expectedMetricIds)
            || JSON.stringify(historicalPath.reference.map(metric => metric.id)) !== JSON.stringify(expectedMetricIds)
            || JSON.stringify(historicalPath.metrics.map(metric => metric.label)) !== JSON.stringify(expectedMetricLabels)
            || JSON.stringify(historicalPath.reference.map(metric => metric.label)) !== JSON.stringify(expectedMetricLabels)
            || historicalPath.metrics.some(metric => /Median withdrawal|Ending portfolio|Early withdrawal|First underfunded/i.test(metric.label))){
          throw new Error(`${mode} historical metric inventory drifted: ${JSON.stringify(historicalPath.metrics)}`);
        }
        const layout = historicalPath.railLayout;
        if(!layout
            || layout.gridDisplay !== 'grid'
            || !layout.gridTemplateColumns.endsWith(' 280px')
            || Math.abs(layout.railWidth - 280) > 0.01
            || layout.railDisplay !== 'flex'
            || layout.railDirection !== 'column'
            || layout.railAlignItems !== 'center'
            || layout.railGap !== '16px'
            || layout.railPadding !== '20px 24px 24px'
            || layout.railBorderLeftWidth !== '1px'
            || layout.railBorderLeftStyle !== 'solid'
            || layout.railBackground !== 'rgba(0, 0, 0, 0)'
            || layout.railRadius !== '0px'
            || !(layout.baselineDelta <= 1)
            || layout.reference.display !== 'flex'
            || layout.reference.direction !== 'column'
            || layout.reference.alignItems !== 'center'
            || layout.reference.gap !== '6px'
            || layout.reference.padding !== '0px 0px 4px'
            || layout.reference.borderBottomWidth !== '0px'
            || layout.reference.borderBottomStyle !== 'none'
            || layout.reference.background !== 'rgba(0, 0, 0, 0)'
            || layout.reference.radius !== '0px'
            || layout.title.text !== 'Typical path'
            || layout.title.fontSize !== '12px'
            || layout.title.fontWeight !== '600'
            || layout.title.letterSpacing !== '0.48px'
            || layout.title.color !== layout.accentColor
            || layout.title.textShadow !== layout.title.expectedTextShadow
            || layout.title.textTransform !== 'none'
            || layout.title.marginBottom !== '2px'
            || layout.referenceLabel.fontSize !== '13px'
            || layout.referenceLabel.color !== layout.bodyColor
            || layout.referenceValue.fontSize !== '15px'
            || layout.referenceValue.color !== layout.bodyColor
            || layout.referenceValue.whiteSpace !== 'nowrap'
            || layout.selected.count !== 1
            || layout.selected.display !== 'flex'
            || layout.selected.direction !== 'column'
            || layout.selected.alignItems !== 'center'
            || layout.selected.gap !== '16px'
            || layout.selected.padding !== '14px 12px'
            || layout.selected.radius !== '10px'
            || layout.selected.backgroundColor !== 'rgba(0, 0, 0, 0)'
            || layout.selected.backgroundImage !== layout.selected.expectedBackgroundImage
            || layout.selected.boxShadow !== layout.selected.expectedBoxShadow
            || Math.abs(layout.reference.width - layout.selected.width) > 1
            || layout.selectedPeriod.count !== 1
            || layout.selectedPeriod.id !== mode
            || layout.selectedPeriod.text !== `${startYear} · ${periodName}`
            || layout.selectedPeriod.year !== String(startYear)
            || layout.selectedPeriod.name !== periodName
            || layout.selectedPeriod.childIndex !== 0
            || layout.selectedPeriod.padding !== '0px 0px 12px'
            || layout.selectedPeriod.borderBottomWidth !== '1px'
            || layout.selectedPeriod.borderBottomStyle !== 'solid'
            || layout.selectedPeriod.background !== 'rgba(0, 0, 0, 0)'
            || layout.selectedPeriod.radius !== '0px'
            || layout.selectedPeriod.fontSize !== '13px'
            || layout.selectedPeriod.fontWeight !== '600'
            || layout.selectedPeriod.lineHeight !== '17.55px'
            || layout.selectedPeriod.letterSpacing !== '0.13px'
            || layout.selectedPeriod.textAlign !== 'center'
            || layout.selectedPeriod.fontVariantNumeric !== 'tabular-nums'
            || layout.selectedPeriod.yearColor !== layout.mutedColor
            || layout.selectedPeriod.nameColor !== layout.accentColor
            || layout.metric.display !== 'flex'
            || layout.metric.direction !== 'column'
            || layout.metric.alignItems !== 'center'
            || layout.metric.textAlign !== 'center'
            || layout.metric.gap !== '5px'
            || layout.metric.nameFontSize !== '12px'
            || layout.metric.nameColor !== layout.bodyColor
            || layout.metric.figureFontSize !== '24px'
            || layout.metric.figureFontWeight !== '300'
            || layout.metric.figureColor !== layout.inkColor
            || layout.metric.figureWhiteSpace !== 'nowrap'
            || layout.metric.deltaFontSize !== '12px'
            || layout.dividerMetrics.length !== 3
            || layout.dividerMetrics.some(metric => (
              metric.paddingTop !== '16px'
              || metric.borderTopWidth !== '1px'
              || metric.borderTopStyle !== 'solid'
            ))
            || layout.directChildBackgrounds.some(color => color !== 'rgba(0, 0, 0, 0)')
            || JSON.stringify(layout.directChildRadii) !== JSON.stringify(['0px', '10px'])
            || layout.figureColors.some(color => color === layout.accentColor)
            || layout.deltaColors.some(color => ![layout.negativeColor, layout.mutedColor].includes(color))
            || layout.sentenceDeltaCopy
            || layout.oldSummaryCount !== 0
            || layout.extraHeadingCount !== 0
            || layout.extraQualifierCopy
            || layout.deltaPillCount !== 0){
          throw new Error(`${mode} path-metrics rail visual contract drifted: ${JSON.stringify(layout)}`);
        }
        if(historicalPath.metrics.some(metric => (
          metric.deltaTone === 'negative'
            ? metric.deltaColor !== layout.negativeColor
            : metric.deltaTone === 'muted'
              ? metric.deltaColor !== layout.mutedColor
              : true
        ))){
          throw new Error(`${mode} path-metrics delta tones drifted: ${JSON.stringify(historicalPath.metrics)}`);
        }
        const portfolioFacts = rows => {
          const retirement = rows.filter(row => row.phase === 'retirement' && row.sourceYear !== null);
          const startingBalance = retirement[0]?.startBalance;
          let peak = startingBalance;
          let maxDrawdown = 0;
          let troughAge = null;
          let underwater = 0;
          let underwaterMax = 0;
          let longestClosedUnderwater = 0;
          let dippedBelowStart = false;
          for(const row of retirement){
            if(row.endingBalance > peak) peak = row.endingBalance;
            const drawdown = peak > 0 ? ((peak - row.endingBalance) / peak) * 100 : 0;
            if(drawdown > maxDrawdown){
              maxDrawdown = drawdown;
              troughAge = row.age;
            }
            if(row.endingBalance < startingBalance - 0.01){
              dippedBelowStart = true;
              underwater += 1;
              underwaterMax = Math.max(underwaterMax, underwater);
            }else{
              longestClosedUnderwater = Math.max(longestClosedUnderwater, underwater);
              underwater = 0;
            }
          }
          const recoveryStatus = !dippedBelowStart
            ? 'no-dip'
            : underwater > 0
              ? 'never'
              : 'recovered';
          const recoveryYears = recoveryStatus === 'no-dip'
            ? 0
            : recoveryStatus === 'recovered'
              ? longestClosedUnderwater
              : null;
          const age80 = rows.filter(row => row.sourceYear !== null && row.age === 80);
          return {
            retirement,
            maxDrawdown,
            troughAge,
            yearsAboveSix: retirement.filter(row => row.wdRate > 6).length,
            underwaterMax,
            recoveryStatus,
            recoveryYears,
            age80Balance: age80.length === 1 ? age80[0].endingBalance : null,
          };
        };
        const fundingFacts = (facts, planEndAge) => {
          const firstUnderfunded = facts.retirement.find(row => row.shortfall > 0.01) || null;
          if(firstUnderfunded){
            const before = facts.retirement.slice(0, facts.retirement.indexOf(firstUnderfunded));
            const lastFunded = [...before].reverse().find(row => row.shortfall <= 0.01) || null;
            const fundedThroughAge = lastFunded?.age ?? firstUnderfunded.age - 1;
            return {
              fundedThroughAge,
              margin: fundedThroughAge - planEndAge,
              kind: 'years-short',
            };
          }
          const ending = facts.retirement.at(-1);
          return ending?.withdrawal > 0
            ? {
                fundedThroughAge: ending.age,
                margin: ending.endingBalance / ending.withdrawal,
                kind: 'zero-return-runway',
              }
            : {
                fundedThroughAge: ending?.age ?? null,
                margin: null,
                kind: 'no-portfolio-draw',
              };
        };
        const close = (actual, expected) => Number.isFinite(actual)
          && Number.isFinite(expected)
          && Math.abs(actual - expected) <= 0.01;
        const sameOptional = (actual, expected) => actual === null && expected === null
          || close(actual, expected);
        const historicalFacts = portfolioFacts(historicalPath.rows);
        const typicalFacts = portfolioFacts(typicalRowsByPlanYear);
        const drawdownMetric = historicalPath.metrics[0];
        const recoveryMetric = historicalPath.metrics[1];
        const age80Metric = historicalPath.metrics[2];
        const fundingMetric = historicalPath.metrics[3];
        const historicalFunding = fundingFacts(historicalFacts, fundingMetric.planEndAge);
        const typicalFunding = fundingFacts(typicalFacts, fundingMetric.planEndAge);
        if(!close(drawdownMetric.thisPath, historicalFacts.maxDrawdown)
            || !close(drawdownMetric.typicalPath, typicalFacts.maxDrawdown)
            || !close(drawdownMetric.delta, typicalFacts.maxDrawdown - historicalFacts.maxDrawdown)
            || drawdownMetric.thisPathAge !== historicalFacts.troughAge
            || drawdownMetric.typicalPathAge !== typicalFacts.troughAge
            || recoveryMetric.thisPath !== historicalFacts.recoveryYears
            || recoveryMetric.typicalPath !== typicalFacts.recoveryYears
            || recoveryMetric.thisPathRecoveryStatus !== historicalFacts.recoveryStatus
            || recoveryMetric.typicalPathRecoveryStatus !== typicalFacts.recoveryStatus
            || !sameOptional(
              recoveryMetric.delta,
              Number.isFinite(historicalFacts.recoveryYears) && Number.isFinite(typicalFacts.recoveryYears)
                ? historicalFacts.recoveryYears - typicalFacts.recoveryYears
                : historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus === 'never'
                  ? 0
                  : null
            )
            || !sameOptional(age80Metric.thisPath, historicalFacts.age80Balance)
            || !sameOptional(age80Metric.typicalPath, typicalFacts.age80Balance)
            || !sameOptional(
              age80Metric.delta,
              historicalFacts.age80Balance !== null && typicalFacts.age80Balance !== null
                ? historicalFacts.age80Balance - typicalFacts.age80Balance
                : null
            )
            || fundingMetric.thisPath !== historicalFunding.fundedThroughAge
            || fundingMetric.typicalPath !== typicalFunding.fundedThroughAge
            || !sameOptional(fundingMetric.thisPathMargin, historicalFunding.margin)
            || !sameOptional(fundingMetric.typicalPathMargin, typicalFunding.margin)
            || fundingMetric.thisPathMarginKind !== historicalFunding.kind
            || fundingMetric.typicalPathMarginKind !== typicalFunding.kind
            || fundingMetric.delta !== historicalFunding.fundedThroughAge - typicalFunding.fundedThroughAge
            || !sameOptional(
              fundingMetric.marginDelta,
              historicalFunding.margin !== null && typicalFunding.margin !== null
                ? historicalFunding.margin - typicalFunding.margin
                : null
            )){
          throw new Error(`${mode} historical metrics do not reconcile to visible engine rows: ${JSON.stringify({
            historicalPath,
            historicalFacts,
            typicalFacts,
            historicalFunding,
            typicalFunding,
          })}`);
        }
        const visibleMoney = (value, unavailable = 'Not modeled') => {
          if(!Number.isFinite(value)) return unavailable;
          const absolute = Math.abs(value);
          if(absolute >= 1_000_000){
            return '$' + (absolute / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
          }
          if(absolute >= 1_000){
            return '$' + Math.min(999, Math.round(absolute / 1_000)) + 'K';
          }
          return '$' + Math.round(absolute).toLocaleString('en-US');
        };
        const visibleYears = value => {
          const absolute = Math.abs(value);
          const amount = Number.isInteger(absolute) ? String(absolute) : absolute.toFixed(1);
          return amount + (absolute === 1 ? ' yr' : ' yrs');
        };
        const visibleSignedYears = value => value === 0
          ? 'Same'
          : (value < 0 ? '\u2212' : '+') + visibleYears(value);
        const visibleRecovery = facts => facts.recoveryStatus === 'never'
          ? 'Never'
          : visibleYears(facts.recoveryYears);
        const displayedDrawdownDelta = Number((
          Number(typicalFacts.maxDrawdown.toFixed(1))
          - Number(historicalFacts.maxDrawdown.toFixed(1))
        ).toFixed(1));
        const balanceDelta = historicalFacts.age80Balance !== null && typicalFacts.age80Balance !== null
          ? historicalFacts.age80Balance - typicalFacts.age80Balance
          : null;
        const displayedBalanceDelta = Number.isFinite(balanceDelta)
          ? visibleMoney(Math.abs(balanceDelta))
          : null;
        const recoveryDelta = Number.isFinite(historicalFacts.recoveryYears)
            && Number.isFinite(typicalFacts.recoveryYears)
          ? historicalFacts.recoveryYears - typicalFacts.recoveryYears
          : null;
        const fundingDelta = historicalFunding.fundedThroughAge - typicalFunding.fundedThroughAge;
        const expectedReferenceValues = [
          '\u2212' + Math.abs(typicalFacts.maxDrawdown).toFixed(1) + '%',
          visibleRecovery(typicalFacts),
          visibleMoney(
            typicalFacts.age80Balance,
            typicalFunding.kind === 'years-short' && typicalFunding.fundedThroughAge < 80
              ? 'Underfunded before 80'
              : 'Not modeled'
          ),
          'Age ' + typicalFunding.fundedThroughAge,
        ];
        const expectedSelectedValues = [
          '\u2212' + Math.abs(historicalFacts.maxDrawdown).toFixed(1) + '%',
          visibleRecovery(historicalFacts),
          visibleMoney(
            historicalFacts.age80Balance,
            historicalFunding.kind === 'years-short' && historicalFunding.fundedThroughAge < 80
              ? 'Underfunded before 80'
              : 'Not modeled'
          ),
          'Age ' + historicalFunding.fundedThroughAge,
        ];
        const expectedDeltas = [
          displayedDrawdownDelta === 0
            ? 'Same'
            : (displayedDrawdownDelta < 0 ? '\u2212' : '+')
              + Math.abs(displayedDrawdownDelta).toFixed(1) + ' pts',
          historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus === 'never'
            ? 'Same'
            : historicalFacts.recoveryStatus === 'never' || typicalFacts.recoveryStatus === 'never'
              ? ''
              : visibleSignedYears(recoveryDelta),
          displayedBalanceDelta === null
            ? ''
            : displayedBalanceDelta === '$0'
              ? 'Same'
              : (balanceDelta < 0 ? '\u2212' : '+') + displayedBalanceDelta,
          visibleSignedYears(fundingDelta),
        ];
        const expectedDeltaTones = [
          displayedDrawdownDelta < 0 ? 'negative' : 'muted',
          historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus !== 'never'
            ? 'negative'
            : recoveryDelta > 0 ? 'negative' : 'muted',
          balanceDelta < 0 ? 'negative' : 'muted',
          fundingDelta < 0 ? 'negative' : 'muted',
        ];
        if(JSON.stringify(historicalPath.reference.map(metric => metric.value)) !== JSON.stringify(expectedReferenceValues)
            || JSON.stringify(historicalPath.metrics.map(metric => metric.figure)) !== JSON.stringify(expectedSelectedValues)
            || JSON.stringify(historicalPath.metrics.map(metric => metric.deltaText)) !== JSON.stringify(expectedDeltas)
            || JSON.stringify(historicalPath.metrics.map(metric => metric.deltaTone)) !== JSON.stringify(expectedDeltaTones)){
          throw new Error(`${mode} visible path-metrics inventory does not reconcile to authoritative rows: ${JSON.stringify({
            actualReferenceValues: historicalPath.reference.map(metric => metric.value),
            expectedReferenceValues,
            actualSelectedValues: historicalPath.metrics.map(metric => metric.figure),
            expectedSelectedValues,
            actualDeltas: historicalPath.metrics.map(metric => metric.deltaText),
            expectedDeltas,
            actualDeltaTones: historicalPath.metrics.map(metric => metric.deltaTone),
            expectedDeltaTones,
          })}`);
        }
        if(historicalPath.summary.outcome === 'underfunded'){
          if(shortfallRows.length !== 1
              || shortfallRows[0] !== lastRetirement
              || historicalPath.statusGlyph !== '!'
              || !/is-underfunded/.test(historicalPath.statusClass)
              || historicalPath.statusColor !== historicalPath.expectedStatusColor
              || !/Underfunded/i.test(lastRetirement.endingText)){
            throw new Error(`${mode} underfunded outcome boundary is incomplete: ${JSON.stringify(historicalPath)}`);
          }
        }else if(shortfallRows.length !== 0
            || historicalPath.statusGlyph !== '✓'
            || !/is-success/.test(historicalPath.statusClass)
            || historicalPath.statusColor !== historicalPath.expectedStatusColor){
          throw new Error(`${mode} surviving outcome boundary is incomplete: ${JSON.stringify(historicalPath)}`);
        }
        await page.screenshot({ path: join(OUT, `04-cashflow-${mode}.png`), fullPage: true });
      }

      const historicalBeforeGoalEdit = await page.evaluate(() => {
        const cashFlow = document.querySelector('#scn-view .cf');
        if(!cashFlow) return '';
        const stableHistorical = cashFlow.cloneNode(true);
        stableHistorical.querySelector('#scn-cf-path-controls')?.remove();
        return stableHistorical.outerHTML;
      });
      const sessionBeforeGoalEdit = await cashFlowSessionSnapshot(page, {
        bundleSentinel: 'cash-flow-goal-edit',
        rememberBundle: true,
      });
      const stableSessionAnalysis = snapshot => ({
        seed: snapshot.seed,
        bundleCount: snapshot.bundleCount,
        bundleHorizon: snapshot.bundleHorizon,
        aggregateBytes: snapshot.aggregateBytes,
        probabilityRangeEnvelopeBytes: snapshot.probabilityRangeEnvelopeBytes,
        successRates: snapshot.successRates,
        trialCounts: snapshot.trialCounts,
        typicalIndices: snapshot.typicalIndices,
      });
      if(!(sessionBeforeGoalEdit.bundleCount > 0)
          || sessionBeforeGoalEdit.trialCounts.some(count => count !== sessionBeforeGoalEdit.bundleCount)){
        throw new Error(`Cash Flow session bundle is incomplete before the Goals edit: ${JSON.stringify(sessionBeforeGoalEdit)}`);
      }

      const householdGoalEditBefore = await page.evaluate(householdId => {
        const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
        const goal = (db[householdId]?.goals || [])
          .find(item => item?.system && item?.name === 'Essentials');
        return goal ? { id: goal.id, amount: goal.amount } : null;
      }, withdrawalPlannerFixtureHouseholdId);
      if(!householdGoalEditBefore?.id || !Number.isFinite(householdGoalEditBefore.amount)){
        throw new Error(`same-household Goals edit target is unavailable: ${JSON.stringify(householdGoalEditBefore)}`);
      }

      await stableClick('.htab[data-page="household"]');
      await stableClick('.htab[data-sub-target="goals"]');
      await page.waitForFunction(goalId => (
        [...document.querySelectorAll('[data-goal-chip]')]
          .filter(chip => chip.dataset.goalChip === goalId).length === 1
      ), { timeout: 8000 }, householdGoalEditBefore.id);
      await stableClick(`[data-goal-chip="${householdGoalEditBefore.id}"]`);
      await page.waitForFunction(() => (
        document.querySelectorAll('.gh-rail .gh-amount-input').length === 1
        && document.querySelectorAll('.gh-rail [data-action="amount-plus"]').length === 1
      ), { timeout: 8000 });
      const householdGoalDisplayBefore = await page.$eval('.gh-rail .gh-amount-input', input => input.value);
      await stableClick('.gh-rail [data-action="amount-plus"]');
      await page.waitForFunction(({ householdId, goalId, priorAmount, priorDisplay }) => {
        const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
        const goal = (db[householdId]?.goals || []).find(item => item?.id === goalId);
        return goal?.amount !== priorAmount
          && document.querySelector('.gh-rail .gh-amount-input')?.value !== priorDisplay
          && /Saved automatically/i.test(document.querySelector('#status')?.textContent || '');
      }, { timeout: 8000 }, {
        householdId: withdrawalPlannerFixtureHouseholdId,
        goalId: householdGoalEditBefore.id,
        priorAmount: householdGoalEditBefore.amount,
        priorDisplay: householdGoalDisplayBefore,
      });

      await stableClick('button[data-page="scenarios"]');
      await page.waitForFunction(() => (
        document.querySelector('.page[data-page="scenarios"]')?.classList.contains('on')
        && !document.querySelector('#run-btn')?.disabled
        && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || '')
      ), { timeout: 30000 });
      await setCashFlow(page, true);
      await waitForCashFlowPath(page, {
        pathId: 'historical-1995',
        kind: 'historical',
        sourceYear: 1995,
        requireHistoricalSummary: true,
        timeout: 20000,
      });
      const householdGoalEditSession = await cashFlowSessionSnapshot(page, {
        bundleSentinel: 'cash-flow-goal-edit',
      });
      if(householdGoalEditSession.seed !== sessionBeforeGoalEdit.seed
          || !householdGoalEditSession.sameBundleObject
          || householdGoalEditSession.bundleCount !== sessionBeforeGoalEdit.bundleCount
          || householdGoalEditSession.bundleHorizon !== sessionBeforeGoalEdit.bundleHorizon
          || householdGoalEditSession.aggregateBytes === sessionBeforeGoalEdit.aggregateBytes
          || householdGoalEditSession.probabilityRangeEnvelopeBytes
            === sessionBeforeGoalEdit.probabilityRangeEnvelopeBytes){
        throw new Error(`same-household Goals edit did not reuse the session bundle while updating analysis: ${JSON.stringify({
          seedBefore: sessionBeforeGoalEdit.seed,
          seedAfter: householdGoalEditSession.seed,
          sameBundleObject: householdGoalEditSession.sameBundleObject,
          aggregateChanged: householdGoalEditSession.aggregateBytes !== sessionBeforeGoalEdit.aggregateBytes,
          probabilityRangeEnvelopeChanged: householdGoalEditSession.probabilityRangeEnvelopeBytes
            !== sessionBeforeGoalEdit.probabilityRangeEnvelopeBytes,
        })}`);
      }

      await stableClick('.htab[data-page="household"]');
      await stableClick('.htab[data-sub-target="goals"]');
      await page.waitForFunction(goalId => (
        [...document.querySelectorAll('[data-goal-chip]')]
          .filter(chip => chip.dataset.goalChip === goalId).length === 1
      ), { timeout: 8000 }, householdGoalEditBefore.id);
      await stableClick(`[data-goal-chip="${householdGoalEditBefore.id}"]`);
      await page.waitForFunction(previousDisplay => (
        document.querySelector('.gh-rail .gh-amount-input')?.value !== previousDisplay
        && document.querySelectorAll('.gh-rail [data-action="amount-minus"]').length === 1
      ), { timeout: 8000 }, householdGoalDisplayBefore);
      await stableClick('.gh-rail [data-action="amount-minus"]');
      await page.waitForFunction(({ householdId, goalId, amount, display }) => {
        const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
        const goal = (db[householdId]?.goals || []).find(item => item?.id === goalId);
        return goal?.amount === amount
          && document.querySelector('.gh-rail .gh-amount-input')?.value === display
          && /Saved automatically/i.test(document.querySelector('#status')?.textContent || '');
      }, { timeout: 8000 }, {
        householdId: withdrawalPlannerFixtureHouseholdId,
        goalId: householdGoalEditBefore.id,
        amount: householdGoalEditBefore.amount,
        display: householdGoalDisplayBefore,
      });

      await stableClick('button[data-page="scenarios"]');
      await page.waitForFunction(() => (
        document.querySelector('.page[data-page="scenarios"]')?.classList.contains('on')
        && !document.querySelector('#run-btn')?.disabled
        && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || '')
      ), { timeout: 30000 });
      await setCashFlow(page, true);
      await waitForCashFlowPath(page, {
        pathId: 'historical-1995',
        kind: 'historical',
        sourceYear: 1995,
        requireHistoricalSummary: true,
        timeout: 20000,
      });
      const restoredGoalSession = await cashFlowSessionSnapshot(page, {
        bundleSentinel: 'cash-flow-goal-edit',
      });
      if(!restoredGoalSession.sameBundleObject
          || JSON.stringify(stableSessionAnalysis(restoredGoalSession))
            !== JSON.stringify(stableSessionAnalysis(sessionBeforeGoalEdit))){
        throw new Error(`reversing the same-household Goals edit did not exactly restore probability/range/envelope analysis: ${JSON.stringify({
          sameBundleObject: restoredGoalSession.sameBundleObject,
          successRatesBefore: sessionBeforeGoalEdit.successRates,
          successRatesAfter: restoredGoalSession.successRates,
          probabilityRangeEnvelopeRestored: restoredGoalSession.probabilityRangeEnvelopeBytes
            === sessionBeforeGoalEdit.probabilityRangeEnvelopeBytes,
          aggregateRestored: restoredGoalSession.aggregateBytes === sessionBeforeGoalEdit.aggregateBytes,
        })}`);
      }
      const historicalAfterGoalEdit = await page.evaluate(() => {
        const cashFlow = document.querySelector('#scn-view .cf');
        if(!cashFlow) return '';
        const stableHistorical = cashFlow.cloneNode(true);
        stableHistorical.querySelector('#scn-cf-path-controls')?.remove();
        return stableHistorical.outerHTML;
      });
      if(historicalAfterGoalEdit !== historicalBeforeGoalEdit){
        throw new Error('reversing the same-household Goals edit did not restore Historical Cash Flow bytes');
      }
      if(await page.evaluate(() => localStorage.getItem('parallax.pathReplay.v1')) !== pathReplayBefore){
        throw new Error('same-household Goals edit changed Monte Carlo replay persistence');
      }

      const grossRmdDisplayProof = await page.evaluate(async () => {
        const { buildSimulationRows, renderCashflow } = await import('./ui/cashflow.js');
        const rows = buildSimulationRows({ rows: [{
          age: 73,
          phase: 'ret',
          withdrawal: 80000,
          accountBreakdown: { traditional: 80000 },
          rmdRequired: 30000,
          rmd: 0,
          taxes: 15000,
          balance: 620000,
          fundingShortfall: 0,
        }] }, {
          plan: { household: { primary: { currentAge: 73 } }, goals: [] },
          currentYear: 2026,
        });
        const scenario = {
          id: 'browser-gross-rmd-proof',
          name: 'Browser gross RMD proof',
          tone: '#c6a662',
          raw: { res: {} },
        };
        const host = document.createElement('div');
        document.body.appendChild(host);
        try{
          host.innerHTML = renderCashflow(scenario, [scenario], {
            cashFlowResult: () => ({
              kind: 'typical',
              pathId: 'typical',
              rows,
              summary: {},
              taxScope: 'MODELED_FEDERAL_LINE_24',
            }),
            pathRows: () => [],
            cashSummary: () => ({}),
            cashFromRetirement: false,
            isTypicalPath: () => true,
            typicalPathFederalTax: () => null,
            pathFederalTax: () => null,
            wdColor: () => 'inherit',
            num: value => String(value),
            esc: value => String(value),
            fmtMoney: value => '$' + Math.round(value).toLocaleString('en-US'),
            cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
          });
          const cells = [...host.querySelectorAll('.cf-row .cf-cell')]
            .map(cell => cell.textContent.trim());
          return {
            rmd: cells[2] ?? '',
            tax: cells[5] ?? '',
            draw: cells[6] ?? '',
          };
        }finally{
          host.remove();
        }
      });
      if(grossRmdDisplayProof.rmd !== '$30,000'
          || grossRmdDisplayProof.tax !== '$15,000'
          || grossRmdDisplayProof.draw !== '($80,000)'){
        throw new Error(`Cash Flow gross RMD display or unaffected Tax/Draw drifted: ${JSON.stringify(grossRmdDisplayProof)}`);
      }

      // This funded browser household correctly survives both live Historical paths above.
      // Exercise the underfunded matrix through the same production controller,
      // renderer and stylesheet without mutating the persisted household.
      const underfundedMatrixProof = await page.evaluate(async () => {
        const [{ createCashFlowController }, { renderCashflow }] = await Promise.all([
          import('./src/scenarios/createCashFlowController.js'),
          import('./ui/cashflow.js'),
        ]);
        const typicalSimulation = {
          simIndex: 7,
          rows: [{
            year: 1, age: 65, phase: 'ret', source: 1995, startBalance: 700000,
            balance: 650000, withdrawal: 28000, fundingShortfall: 0, failed: false, wdRate: 4, taxes: 0,
          }, {
            year: 2, age: 66, phase: 'ret', source: 1996, startBalance: 650000,
            balance: 700000, withdrawal: 32500, fundingShortfall: 0, failed: false, wdRate: 5, taxes: 0,
          }],
        };
        const historicalRows = [{
          year: 1, age: 65, phase: 'ret', source: 1973, startBalance: 90000,
          balance: 50000, fundingShortfall: 0, failed: false, wdRate: 6, taxes: 0,
        }, {
          year: 2, age: 66, phase: 'ret', source: 1974, startBalance: 50000,
          balance: 0, fundingShortfall: 20000, failed: true, wdRate: 100, taxes: 0,
          people: { client: { age: 66, alive: true }, spouse: null },
        }];
        const scenario = {
          base: true,
          name: 'Browser underfunded proof',
          res: { sims: [typicalSimulation], paths: { p50: { simIndex: 7 } } },
        };
        const plan = {
          meta: { planningAsOfYear: 2026 },
          household: { primary: { currentAge: 65 } },
          goals: [],
        };
        const historical = {
          kind: 'historical',
          pathId: 'historical-1973',
          simulation: { rows: historicalRows },
          summary: { outcome: 'underfunded' },
          digest: {
            maxRealDrawdownPct: 100,
            maxRealDrawdownTroughAge: 66,
            yearsAboveSixPctWdRate: 1,
            portfolioUnderwaterYearsMax: 2,
            portfolioRecoveryPeriodStatus: 'never',
            portfolioRecoveryPeriodYears: null,
            realBalanceAtAge80: null,
            fundedThroughAge: 65,
            planEndAge: 66,
            fundingMarginYears: -1,
            fundingMarginKind: 'years-short',
          },
          taxScope: 'MODELED_FEDERAL_LINE_24',
        };
        const buildRows = simulation => simulation.rows.map(row => ({
          year: 2025 + row.year,
          age: row.age,
          sourceYear: row.source,
          accum: row.phase === 'accum',
          ret: 0,
          income: 0,
          rmd: 0,
          essential: 20000,
          goals: 0,
          tax: row.taxes,
          draw: 20000,
          wdRate: row.wdRate,
          ending: row.balance,
          fundingShortfall: row.fundingShortfall,
          shortfall: row.fundingShortfall > 0.01,
          startPort: row.startBalance,
          goalTag: null,
        }));
        const selection = { id: 'historical-1973' };
        const controller = createCashFlowController({
          getScenarios: () => [scenario],
          scenarioInputsByResult: new WeakMap([[scenario.res, { plan, overrides: {} }]]),
          selection,
          historicalCache: {
            get: () => historical,
            peek: args => args.analysis === scenario.res && args.periodId === selection.id
              ? historical
              : null,
          },
          buildRows,
          digest: () => ({
            maxRealDrawdownPct: 7.142857142857143,
            maxRealDrawdownTroughAge: 65,
            yearsAboveSixPctWdRate: 0,
            portfolioUnderwaterYearsMax: 1,
            portfolioRecoveryPeriodStatus: 'recovered',
            portfolioRecoveryPeriodYears: 1,
            realBalanceAtAge80: null,
            fundedThroughAge: 66,
            planEndAge: 66,
            fundingMarginYears: 18.46153846153846,
            fundingMarginKind: 'zero-return-runway',
          }),
        });

        const liveStatus = document.querySelector('#cashflow-path-status');
        const scenarioPage = document.querySelector('.page[data-page="scenarios"]');
        if(!liveStatus || !scenarioPage) throw new Error('Cash Flow status host is unavailable');
        liveStatus.id = 'cashflow-path-status-live';
        const status = document.createElement('span');
        status.id = 'cashflow-path-status';
        status.className = 'cashflow-path-status';
        status.hidden = true;
        const select = document.createElement('select');
        const host = document.createElement('div');
        scenarioPage.append(status, select, host);
        try{
          controller.syncSelect(select, scenario);
          const selected = controller.resultForScenario(scenario);
          const display = {
            raw: scenario,
            id: 'browser-underfunded-proof',
            name: scenario.name,
            tone: '#c6a662',
            prob: 0,
            probStr: '0',
            median: '$0',
          };
          const renderSelected = result => {
            host.innerHTML = renderCashflow(display, [display], {
              cashFlowResult: () => result,
              pathRows: () => [],
              cashSummary: () => ({}),
              cashFromRetirement: false,
              isTypicalPath: () => false,
              typicalPathFederalTax: () => null,
              pathFederalTax: () => null,
              wdColor: () => 'inherit',
              num: value => String(value),
              esc: value => String(value),
              fmtMoney: value => '$' + Math.round(value).toLocaleString('en-US'),
              cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
            });
          };
          const readRecovery = () => {
            const recovery = host.querySelector('[data-historical-metric="recovery-period"]');
            const recoveryReference = host.querySelector('[data-path-reference-metric="recovery-period"]');
            const delta = recovery?.querySelector('.cf-path-rail__delta');
            return {
              reference: recoveryReference?.querySelector('.cf-path-rail__reference-value')?.textContent.trim() || '',
              figure: recovery?.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
              delta: delta?.textContent.trim() || '',
              tone: recovery?.dataset.deltaTone || '',
              referenceFontSize: recoveryReference
                ? getComputedStyle(recoveryReference.querySelector('.cf-path-rail__reference-value')).fontSize
                : '',
              figureFontSize: recovery
                ? getComputedStyle(recovery.querySelector('.cf-path-rail__figure')).fontSize
                : '',
              deltaMinHeight: delta ? getComputedStyle(delta).minHeight : '',
              deltaHeight: delta?.getBoundingClientRect().height ?? 0,
            };
          };
          renderSelected(selected);
          const summary = host.querySelector('[data-cash-path-metrics]');
          const probe = document.createElement('span');
          probe.style.color = 'var(--neg)';
          scenarioPage.appendChild(probe);
          const expectedColor = getComputedStyle(probe).color;
          probe.remove();
          const recovery = readRecovery();
          renderSelected({
            ...selected,
            headerMetrics: {
              ...selected.headerMetrics,
              rows: selected.headerMetrics.rows.map(metric => metric.id === 'recovery-period'
                ? {
                    ...metric,
                    thisPath: 0,
                    typicalPath: null,
                    delta: null,
                    thisPathRecoveryStatus: 'no-dip',
                    typicalPathRecoveryStatus: 'never',
                  }
                : metric),
            },
          });
          const reverseRecovery = readRecovery();
          return {
            outcome: summary?.dataset.outcome || '',
            metrics: [...host.querySelectorAll('[data-historical-metric]')]
              .map(metric => metric.dataset.historicalMetric),
            glyph: status.textContent.trim(),
            statusClass: status.className,
            statusColor: getComputedStyle(status).color,
            expectedColor,
            recovery,
            reverseRecovery,
          };
        }finally{
          host.remove();
          select.remove();
          status.remove();
          liveStatus.id = 'cashflow-path-status';
        }
      });
      if(underfundedMatrixProof.outcome !== 'underfunded'
          || JSON.stringify(underfundedMatrixProof.metrics) !== JSON.stringify([
            'max-real-drawdown', 'recovery-period',
            'balance-at-age-80', 'funded-through-margin',
          ])
          || underfundedMatrixProof.recovery.reference !== '1 yr'
          || underfundedMatrixProof.recovery.figure !== 'Never'
          || underfundedMatrixProof.recovery.delta !== ''
          || underfundedMatrixProof.recovery.tone !== 'negative'
          || underfundedMatrixProof.recovery.referenceFontSize !== '15px'
          || underfundedMatrixProof.recovery.figureFontSize !== '24px'
          || underfundedMatrixProof.recovery.deltaMinHeight !== '12px'
          || underfundedMatrixProof.recovery.deltaHeight < 12
          || underfundedMatrixProof.reverseRecovery.reference !== 'Never'
          || underfundedMatrixProof.reverseRecovery.figure !== '0 yrs'
          || underfundedMatrixProof.reverseRecovery.delta !== ''
          || underfundedMatrixProof.reverseRecovery.tone !== 'muted'
          || underfundedMatrixProof.reverseRecovery.referenceFontSize !== '15px'
          || underfundedMatrixProof.reverseRecovery.figureFontSize !== '24px'
          || underfundedMatrixProof.reverseRecovery.deltaMinHeight !== '12px'
          || underfundedMatrixProof.reverseRecovery.deltaHeight < 12
          || underfundedMatrixProof.glyph !== '!'
          || !/is-underfunded/.test(underfundedMatrixProof.statusClass)
          || underfundedMatrixProof.statusColor !== underfundedMatrixProof.expectedColor){
        throw new Error(`controlled underfunded Historical matrix is incomplete: ${JSON.stringify(underfundedMatrixProof)}`);
      }
      observedHistoricalOutcomes.add(underfundedMatrixProof.outcome);
      if(JSON.stringify([...observedHistoricalOutcomes].sort()) !== JSON.stringify(['survives', 'underfunded'])){
        throw new Error(`Cash Flow verifier did not observe both locked Historical outcomes: ${JSON.stringify([...observedHistoricalOutcomes])}`);
      }

      // Historical-only financial bytes must survive a genuinely new session.
      // Use the shipped retirement-now household so those rows have no Typical
      // accumulation handoff; Typical-dependent comparison fields may change,
      // while the Historical ledger itself must remain exact.
      const historicalReloadHouseholdId = 'future-household';
      await stableClick('.htab[data-page="household"]');
      await selectHouseholdVisible(page, historicalReloadHouseholdId);
      await page.waitForFunction(
        () => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''),
        { timeout: 30000 }
      );
      await stableClick('button[data-page="scenarios"]');
      await setCashFlow(page, true);
      await waitForCashFlowPath(page, {
        pathId: 'historical-1995',
        kind: 'historical',
        sourceYear: 1995,
        requireHistoricalSummary: true,
        timeout: 30000,
      });
      const historicalReloadSessionBefore = await cashFlowSessionSnapshot(page, {
        includeBundleIdentity: true,
      });
      reloadExpected = await page.evaluate(() => {
        const root = document.querySelector('#scn-view .cf');
        const summary = document.querySelector('#scn-view [data-cash-path-metrics]');
        const rows = [...document.querySelectorAll('#scn-view .cf-row')].map((row, index) => ({
          planYear: index + 1,
          age: Number(row.dataset.age),
          phase: row.dataset.phase || '',
          sourceYear: row.dataset.sourceYear === '' ? null : Number(row.dataset.sourceYear),
          startBalance: Number(row.dataset.startBalance),
          endingBalance: Number(row.dataset.endingBalance),
          wdRate: Number(row.dataset.wdRate),
          shortfall: Number(row.dataset.fundingShortfall),
        }));
        const retirementRows = rows.filter(row => row.phase === 'retirement');
        return {
          mode: document.querySelector('#cashflow-path-mode')?.value || '',
          rootMode: root?.dataset.cashPathId || '',
          sourceYear: retirementRows[0]?.sourceYear ?? null,
          rows: retirementRows,
          metrics: [...document.querySelectorAll('#scn-view [data-historical-metric]')].map(metric => ({
            id: metric.dataset.historicalMetric || '',
            label: metric.querySelector('.cf-path-rail__metric-name')?.textContent.trim() || '',
            figure: metric.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
            deltaText: metric.querySelector('.cf-path-rail__delta')?.textContent.trim() || '',
            thisPath: metric.dataset.thisPath === '' ? null : Number(metric.dataset.thisPath),
            typicalPath: metric.dataset.typicalPath === '' ? null : Number(metric.dataset.typicalPath),
            delta: metric.dataset.delta === '' ? null : Number(metric.dataset.delta),
            planYear: metric.dataset.planYear === '' || metric.dataset.planYear === undefined
              ? null
              : Number(metric.dataset.planYear),
          })),
          summary: summary ? { outcome: summary.dataset.outcome || '' } : null,
          retirementAges: retirementRows.map(row => row.age),
        };
      });
      if(!reloadExpected) throw new Error('historical reload checkpoint was not captured');

      await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
      await waitForUnselectedWizard(page);
      await stableClick('.htab[data-page="household"]');
      await selectHouseholdVisible(page, historicalReloadHouseholdId);
      await page.waitForFunction(
        () => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''),
        { timeout: 30000 }
      );
      await page.click('button[data-page="scenarios"]');
      await setCashFlow(page, true);
      await waitForCashFlowPath(page, {
        pathId: reloadExpected.mode,
        kind: 'historical',
        sourceYear: reloadExpected.sourceYear,
        requireHistoricalSummary: true,
        timeout: 30000,
      });
      const sessionAfterReload = await cashFlowSessionSnapshot(page, {
        includeBundleIdentity: true,
      });
      const reloadedHistorical = await page.evaluate(() => {
        const root = document.querySelector('#scn-view .cf');
        const summary = document.querySelector('#scn-view [data-cash-path-metrics]');
        const rows = [...document.querySelectorAll('#scn-view .cf-row')].map((row, index) => ({
          planYear: index + 1,
          age: Number(row.dataset.age),
          phase: row.dataset.phase || '',
          sourceYear: row.dataset.sourceYear === '' ? null : Number(row.dataset.sourceYear),
          startBalance: Number(row.dataset.startBalance),
          endingBalance: Number(row.dataset.endingBalance),
          wdRate: Number(row.dataset.wdRate),
          shortfall: Number(row.dataset.fundingShortfall),
        }));
        const retirementRows = rows.filter(row => row.phase === 'retirement');
        return {
          snapshot: {
            mode: document.querySelector('#cashflow-path-mode')?.value || '',
            rootMode: root?.dataset.cashPathId || '',
            sourceYear: retirementRows[0]?.sourceYear ?? null,
            metrics: [...document.querySelectorAll('#scn-view [data-historical-metric]')].map(metric => ({
              id: metric.dataset.historicalMetric || '',
              label: metric.querySelector('.cf-path-rail__metric-name')?.textContent.trim() || '',
              figure: metric.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
              deltaText: metric.querySelector('.cf-path-rail__delta')?.textContent.trim() || '',
              thisPath: metric.dataset.thisPath === '' ? null : Number(metric.dataset.thisPath),
              typicalPath: metric.dataset.typicalPath === '' ? null : Number(metric.dataset.typicalPath),
              delta: metric.dataset.delta === '' ? null : Number(metric.dataset.delta),
              planYear: metric.dataset.planYear === '' || metric.dataset.planYear === undefined
                ? null
                : Number(metric.dataset.planYear),
            })),
            rows: retirementRows,
            summary: summary ? { outcome: summary.dataset.outcome || '' } : null,
            retirementAges: retirementRows.map(row => row.age),
          },
          persisted: JSON.parse(localStorage.getItem('parallax.cashFlowPath.v1') || '{}'),
          pathReplay: localStorage.getItem('parallax.pathReplay.v1'),
          regenerateCount: document.querySelectorAll('#cashflow-path-regenerate').length,
        };
      });
      const historicalContract = snapshot => ({
        mode: snapshot.mode,
        rootMode: snapshot.rootMode,
        sourceYear: snapshot.sourceYear,
        metrics: snapshot.metrics.map(metric => ({
          id: metric.id,
          label: metric.label,
          planYear: metric.planYear,
          thisPath: metric.thisPath,
        })),
        rows: snapshot.rows.map(row => ({
          planYear: row.planYear,
          age: row.age,
          sourceYear: row.sourceYear,
          startBalance: row.startBalance,
          endingBalance: row.endingBalance,
          wdRate: row.wdRate,
          shortfall: row.shortfall,
        })),
        summary: snapshot.summary,
        retirementAges: snapshot.retirementAges,
      });
      if(JSON.stringify(historicalContract(reloadedHistorical.snapshot)) !== JSON.stringify(historicalContract(reloadExpected))
          || reloadedHistorical.persisted?.id !== reloadExpected.mode
          || reloadedHistorical.pathReplay !== pathReplayBefore
          || reloadedHistorical.regenerateCount !== 0){
        throw new Error(`Historical selection/generation contract changed across reload: ${JSON.stringify({ reloadExpected, reloadedHistorical })}`);
      }
      if(sessionAfterReload.seed === historicalReloadSessionBefore.seed
          || sessionAfterReload.bundleIdentityHash === historicalReloadSessionBefore.bundleIdentityHash){
        throw new Error(`household reload reused the previous session seed or Monte Carlo bundle: ${JSON.stringify({
          before: historicalReloadSessionBefore,
          after: sessionAfterReload,
        })}`);
      }

      await page.select('#cashflow-path-mode', 'typical');
      await waitForCashFlowPath(page, {
        pathId: 'typical',
        kind: 'typical',
        timeout: 20000,
      });
      const restoredTypical = await page.evaluate(() => {
        const th = document.querySelector('#scn-view .cf-table__head .cf-th[data-tax-source]');
        return {
          header: th ? { label: th.textContent.trim(), source: th.dataset.taxSource || '' } : null,
          stats: [...document.querySelectorAll('#scn-view .cf-stat__label')].map(label => label.textContent.trim()),
          statusGlyph: document.querySelector('#cashflow-path-status')?.textContent.trim() || '',
          persisted: JSON.parse(localStorage.getItem('parallax.cashFlowPath.v1') || '{}'),
          pathReplay: localStorage.getItem('parallax.pathReplay.v1'),
        };
      });
      if(restoredTypical.header?.label !== 'Tax' || restoredTypical.header?.source !== 'federal-converged-row') throw new Error(`Typical tax scope did not restore: ${JSON.stringify(restoredTypical)}`);
      if(JSON.stringify(restoredTypical.stats) !== JSON.stringify(['Funded through', 'Ending position'])
          || restoredTypical.statusGlyph
          || restoredTypical.stats.some(label => /Probability|Federal total|Median Ending/i.test(label))) throw new Error(`Typical baseline summary did not restore: ${JSON.stringify(restoredTypical)}`);
      if(restoredTypical.persisted?.id !== 'typical' || restoredTypical.pathReplay !== pathReplayBefore) throw new Error(`Typical persistence disturbed replay state: ${JSON.stringify(restoredTypical)}`);
      if(await page.evaluate(() => !!document.querySelector('#scn-view [data-tax-compare]'))) throw new Error('obsolete federal-vs-engine summary restored on Typical');
      if(await page.evaluate(() => !!document.querySelector('#scn-view [data-tax-scope-disclosure], #scn-view [data-tax-disclosure]'))) throw new Error('removed federal scope/status copy restored on Typical');
    }

    // Exercise warning and attach-failure states directly through the production
    // Cash Flow renderer. This avoids changing real scenario or Household state.
    const disclosureStates = await page.evaluate(async () => {
      const { renderCashflow } = await import('./ui/cashflow.js');
      const row = { year: 2026, age: 66, accum: false, income: 50000, rmd: 0, essential: 40000, goals: 0, tax: 5000, draw: 0, ret: 0.04, wdRate: 4, ending: 900000, shortfall: false, startPort: 1000000, goalTag: null };
      const raw = { res: { typicalPathFederalTax: {
        years: [{ year: 2026, age: 66, federalTaxLiability: 4500 }],
        totals: { federalTaxLiability: 4500, enginePathTax: 5000, deltaVsEnginePath: -500 },
        scope: 'INCOME_TAX_ONLY',
        warnings: [{ code: 'VERIFY_WARNING', message: 'A supplied tax fact needs review.' }],
      } } };
      const scn = { raw, id: '0', name: 'Baseline', tone: '#c6a662', prob: 80, probStr: '80', median: '$900K' };
      const deps = {
        pathRows: () => [row], cashSummary: () => ({}), cashFromRetirement: false,
        isTypicalPath: () => true, typicalPathFederalTax: (s) => s.res.typicalPathFederalTax,
        toneGlow: () => 'transparent', ring: () => '', wdColor: () => 'inherit', num: (n) => String(n),
        esc: (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
        fmtMoney: (n) => '$' + Math.round(n).toLocaleString('en-US'),
        cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
      };
      const inspect = () => {
        const host = document.createElement('div');
        host.innerHTML = renderCashflow(scn, [scn], deps);
        return {
          state: host.querySelector('[data-tax-disclosure]')?.dataset.taxState || '',
          warning: host.querySelector('[data-tax-warnings] li')?.textContent.trim() || '',
          fallback: host.querySelector('[data-tax-fallback]')?.textContent.trim() || '',
          source: host.querySelector('.cf-th[data-tax-source]')?.dataset.taxSource || '',
        };
      };
      const warned = inspect();
      raw.res.typicalPathFederalTax = null;
      const failed = inspect();
      return { warned, failed };
    });
    if(disclosureStates.warned.state !== 'federal-sidecar' || disclosureStates.warned.warning !== 'A supplied tax fact needs review.') throw new Error(`sidecar warnings were not surfaced: ${JSON.stringify(disclosureStates)}`);
    if(disclosureStates.failed.state !== 'engine-fallback' || disclosureStates.failed.source !== 'engine' || !/tax column uses engine estimates/i.test(disclosureStates.failed.fallback)) throw new Error(`sidecar attach-failure fallback is unclear: ${JSON.stringify(disclosureStates)}`);
    await page.screenshot({ path: join(OUT, '04-cashflow.png'), fullPage: true });

    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    await page.waitForFunction(householdId => {
      const status = document.querySelector('#status')?.textContent || '';
      const runButton = document.querySelector('#run-btn');
      return localStorage.getItem('parallax.activeHouseholdId') === householdId
        && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === householdId
        && document.querySelector('#hh-switch')?.value === householdId
        && runButton
        && !runButton.disabled
        && /Plan updated|Partial run/i.test(status);
    }, { timeout: 30000 }, withdrawalPlannerFixtureHouseholdId);
    const restoredWithdrawalPlannerFixture = await page.evaluate(householdId => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      const household = db[householdId]?.household || {};
      return {
        activeHouseholdId: localStorage.getItem('parallax.activeHouseholdId'),
        rootHouseholdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
        selectedHouseholdId: document.querySelector('#hh-switch')?.value || '',
        primary: household.primary
          ? {
              currentAge: household.primary.currentAge,
              retirementAge: household.primary.retirementAge,
            }
          : null,
        spouse: household.spouse
          ? {
              currentAge: household.spouse.currentAge,
              retirementAge: household.spouse.retirementAge,
            }
          : null,
      };
    }, withdrawalPlannerFixtureHouseholdId);
    if(restoredWithdrawalPlannerFixture.activeHouseholdId !== withdrawalPlannerFixtureHouseholdId
        || restoredWithdrawalPlannerFixture.rootHouseholdId !== withdrawalPlannerFixtureHouseholdId
        || restoredWithdrawalPlannerFixture.selectedHouseholdId !== withdrawalPlannerFixtureHouseholdId
        || restoredWithdrawalPlannerFixture.primary?.currentAge !== 64
        || restoredWithdrawalPlannerFixture.primary?.retirementAge !== 66
        || restoredWithdrawalPlannerFixture.spouse?.currentAge !== 63
        || restoredWithdrawalPlannerFixture.spouse?.retirementAge !== 65){
      throw new Error(`Withdrawal Planner fixture was not restored after Historical reload: ${JSON.stringify(restoredWithdrawalPlannerFixture)}`);
    }
  });

  if(!SKIP_SEQUENCING){
    await step('sequencing renders all chips on', async () => {
      await page.click('button[data-page="sequencing"]');
      await page.waitForFunction(
        () => document.querySelector('.page.on')?.dataset.page === 'sequencing',
        { timeout: 8000 },
      );
      await page.evaluate(() => document.querySelectorAll('.seq-chip').forEach(c => { if(!c.classList.contains('on')) c.click(); }));
      try{
        await page.waitForFunction(
          () => document.querySelectorAll('#seq-svg path').length > 4,
          { timeout: 15000 },
        );
      }catch(error){
        const state = await page.evaluate(() => ({
          paths: document.querySelectorAll('#seq-svg path').length,
          chips: document.querySelectorAll('.seq-chip').length,
          activeChips: document.querySelectorAll('.seq-chip.on').length,
          prints: document.querySelectorAll('.seq-print').length,
        }));
        throw new Error(`${error.message}; state=${JSON.stringify(state)}; browser=${JSON.stringify(errs.slice(-5))}`);
      }
      const el = await page.$('.seq-chart');
      const chartContract = await page.evaluate(() => {
        const svg = document.querySelector('#seq-svg');
        const ageLabels = [...svg.querySelectorAll('text')]
          .filter(label => label.textContent.startsWith('Age '));
        const valueLabels = [...svg.querySelectorAll('text')]
          .filter(label => label.textContent.startsWith('$'));
        return {
          viewBox: svg.getAttribute('viewBox'),
          width: svg.getBoundingClientRect().width,
          height: svg.getBoundingClientRect().height,
          ages: ageLabels.map(label => label.textContent.trim()),
          ageY: ageLabels.map(label => Number(label.getAttribute('y'))),
          ageSize: ageLabels.map(label => Number(label.getAttribute('font-size'))),
          fills: [...ageLabels, ...valueLabels].map(label => label.getAttribute('fill')),
          valueX: valueLabels.map(label => Number(label.getAttribute('x'))),
          valueSize: valueLabels.map(label => Number(label.getAttribute('font-size'))),
        };
      });
      if(chartContract.viewBox !== '0 0 1480 398'
        || Math.abs(chartContract.width - 1470) > 1
        || Math.abs(chartContract.height - 398) > 1
        || !chartContract.ages.includes('Age 80')
        || chartContract.ages.includes('Age 81')
        || chartContract.ageY.some(value => value !== 386)
        || chartContract.ageSize.some(value => value !== 13)
        || chartContract.valueX.some(value => value !== 76)
        || chartContract.valueSize.some(value => value !== 13)
        || chartContract.fills.some(value => value !== 'rgba(127,119,114,.72)')){
        throw new Error(`Sequencing reference geometry drifted: ${JSON.stringify(chartContract)}`);
      }
      await el.screenshot({ path: join(OUT, '05-sequencing.png') });
    });

    await step('sequencing excludes deferred Playback', async () => {
      const playbackSelectors = await page.evaluate(() => ({
        panel: Boolean(document.querySelector('#playback-panel')),
        verdict: Boolean(document.querySelector('#pb-verdict')),
        yearPicker: Boolean(document.querySelector('[data-pb-year]')),
        detail: Boolean(document.querySelector('#pb-detail-btn')),
      }));
      if(Object.values(playbackSelectors).some(Boolean)){
        throw new Error(`deferred Playback rendered unexpectedly: ${JSON.stringify(playbackSelectors)}`);
      }
      await page.screenshot({ path: join(OUT, '06-sequencing-full.png'), fullPage: true });
    });
  }

  // Objective theme contract: all primary product pages share the approved graphite
  // surface, while the header uses that same surface with copper interaction accents.
  await step('visual contract: 68px Graphite Aubergine header rail and tabs are correct', async () => {
    await stableClick('button[data-page="scenarios"]');
    await page.waitForFunction(() => document.querySelector('.page[data-page="scenarios"].on'), { timeout:8000 });
    const hdr = await page.evaluate(() => {
      const el = document.querySelector('.hdr');
      if(!el) return null;
      const cs = getComputedStyle(el);
      const logo = document.querySelector('.hdr__logo img, .brand-logo');
      const tab = document.querySelector('.htab.on');
      const tabAfter = tab ? getComputedStyle(tab, '::after') : null;
      return {
        height: cs.height,
        bg: cs.backgroundColor,
        headerBorderBottom: getComputedStyle(document.querySelector('.hdr__bar')).borderBottomWidth,
        logo: logo?.getAttribute('src') || '',
        logoH: logo ? getComputedStyle(logo).height : '',
        clusterHidden: document.querySelector('.cluster')?.hidden === true,
        tabAfterBg: tabAfter?.backgroundColor || '',
      };
    });
    if(!hdr) throw new Error('Header element missing');
    if(hdr.height !== '68px') throw new Error(`Header height must be 68px, got ${hdr.height}`);
    if(hdr.headerBorderBottom !== '1px') throw new Error(`Header must have 1px bottom hairline, got ${hdr.headerBorderBottom}`);
    if(!hdr.logo.includes('parallax-logo.png')) throw new Error(`Header logo must use parallax-logo.png, got ${hdr.logo}`);
    if(hdr.logoH !== '58px') throw new Error(`Logo must be 58px tall, got ${hdr.logoH}`);
    if(hdr.bg !== 'rgb(24, 25, 24)') throw new Error(`Header must use the graphite page surface, got ${hdr.bg}`);
    if(!hdr.clusterHidden) throw new Error('Header status and Run controls must remain hidden from the product UI');
    if(hdr.tabAfterBg !== 'rgb(177, 132, 92)') throw new Error(`Active tab underline must use the copper accent: ${hdr.tabAfterBg}`);
  });
  await step('theme: product pages sit on the shared graphite background', async () => {
    const GRAPHITE = 'rgb(24, 25, 24)';
    const bgOf = selector => stableEvaluate(`read ${selector} background`, s => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).backgroundColor : '(no element)';
    }, selector);

    await stableClick('button[data-page="scenarios"]');
    await page.waitForFunction(() => document.querySelector('.page[data-page="scenarios"].on'), { timeout:8000 });
    const scnBg = await bgOf('.page[data-page="scenarios"]');

    await stableClick('.htab[data-sub-target="goals"]');
    await page.waitForFunction(() => (
      document.querySelector('.page[data-page="net-worth"].on')
      && document.querySelector('#np-content .gh-card')
    ), { timeout:8000 });
    const goalsBg = await bgOf('.page[data-page="net-worth"]');

    let seqBg = null;
    if(!SKIP_SEQUENCING){
      await stableClick('button[data-page="sequencing"]');
      await page.waitForFunction(() => document.querySelector('.page[data-page="sequencing"].on'), { timeout:8000 });
      seqBg = await bgOf('.page[data-page="sequencing"]');
    }

    await stableClick('.htab[data-page="household"]');
    await page.waitForFunction(() => (
      document.querySelector('.page[data-page="household"].on')
      && document.querySelector('[data-hh-wizard-root]')
    ), { timeout:8000 });
    const hhBg = await bgOf('.page[data-page="household"]');

    const surfaces = [['scenarios', scnBg], ['goals', goalsBg], ['household', hhBg]];
    if(seqBg !== null) surfaces.splice(2, 0, ['sequencing', seqBg]);
    for(const [name, bg] of surfaces){
      if(bg !== GRAPHITE) throw new Error(`${name} page lost the shared graphite background: ${bg}`);
    }
  });

  await step('retirement age lever goes inert once the household is already retired', async () => {
    const leverNames = () => stableEvaluate('read scenario lever names', () =>
      [...document.querySelectorAll('#scn-view .lever__name')].map(e => e.textContent.trim()));

    // Pre-retirement fixture (Client 1 64/retire 66, Client 2 63/retire 65):
    // both per-person retirement ages are active Scenarios levers.
    await stableClick('button[data-page="scenarios"]');
    await stableClick('#scn-seg-compare');
    await page.waitForSelector('#scn-view .lever__name', { timeout: 10000 });
    const beforeNames = await leverNames();
    const expectedRetirementLevers = ['Client 1 Retirement', 'Client 2 Retirement'];
    const missingRetirementLevers = expectedRetirementLevers.filter(name => !beforeNames.includes(name));
    if(missingRetirementLevers.length)
      throw new Error(`Per-person retirement levers should be present while pre-retirement: ${JSON.stringify({ missingRetirementLevers, beforeNames })}`);

    // Make BOTH principals already retired (retire age below current age).
    const setFamilyField = async (field, value) => {
      const beforeRevision = await page.$eval(
        '[data-hh-wizard-root]',
        element => Number(element.dataset.renderRevision),
      );
      await stableEvaluate(`set Family field ${field}`, ({ field, value }) => {
        const control = document.querySelector(
          `[data-hh-wizard-screen="family"] [data-hh-field="${field}"]`,
        );
        if(!control) throw new Error(`missing Family field: ${field}`);
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }, { field, value });
      await waitForWizard(page, {
        step: 'family',
        afterRevision: beforeRevision,
      });
    };
    await goToWizardStep(page, 'family');
    await setFamilyField('client.retirementAge', '60');
    await setFamilyField('spouse.retirementAge', '60');

    // Now both retirement-age levers must DROP OUT of the Scenarios levers (they
    // are no longer decisions to pull), while the other levers remain.
    await stableClick('button[data-page="scenarios"]');
    await stableClick('#scn-seg-compare');
    try{
      await page.waitForFunction(() => {
        const names = [...document.querySelectorAll('#scn-view .lever__name')]
          .map(element => element.textContent.trim());
        return names.includes('Allocation')
          && !names.includes('Client 1 Retirement')
          && !names.includes('Client 2 Retirement');
      }, { timeout: 10000 });
    }catch(error){
      const observed = await page.evaluate(() => {
        const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
        const active = localStorage.getItem('parallax.activeHouseholdId');
        const household = db?.[active]?.household || {};
        return {
          names: [...document.querySelectorAll('#scn-view .lever__name')]
            .map(element => element.textContent.trim()),
          primary: household.primary
            ? {
                currentAge: household.primary.currentAge,
                retirementAge: household.primary.retirementAge,
              }
            : null,
          spouse: household.spouse
            ? {
                currentAge: household.spouse.currentAge,
                retirementAge: household.spouse.retirementAge,
              }
            : null,
        };
      });
      throw new Error(`Retired-household lever state did not settle: ${JSON.stringify(observed)}. ${error.message}`);
    }
    const afterNames = await leverNames();
    const remainingRetirementLevers = expectedRetirementLevers.filter(name => afterNames.includes(name));
    if(remainingRetirementLevers.length)
      throw new Error(`Per-person retirement levers must disappear once already retired: ${JSON.stringify({ remainingRetirementLevers, afterNames })}`);
    if(!afterNames.includes('Allocation'))
      throw new Error(`other levers (Allocation) must remain when retired: ${JSON.stringify(afterNames)}`);

    // Restore the edited fields explicitly; saved data is never reset implicitly.
    await goToWizardStep(page, 'family');
    await setFamilyField('client.retirementAge', '66');
    await setFamilyField('spouse.retirementAge', '65');
  });

  await step('funding truth survives visible Goals edits and reaches probability and Cash Flow', async () => {
    const goalName = 'Funding truth goal';
    await page.evaluate(({ householdId, goalName }) => {
      const storageKey = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(storageKey) || '{}');
      const plan = db[householdId];
      if(!plan) throw new Error('saved household is unavailable for the funding-truth fixture');

      const currentYear = new Date().getFullYear();
      plan.meta = {
        ...(plan.meta || {}),
        primaryName: 'Funding Truth Fixture',
        spouseName: '',
        filingStatus: 'single',
        spendingSchemaVersion: 1,
      };
      plan.household = {
        primary: { currentAge: 64, retirementAge: 67, planEndAge: 67, birthYear: currentYear - 64 },
        spouse: null,
        children: [],
      };
      plan.portfolio = {
        ...(plan.portfolio || {}),
        riskProfile: 3,
        withdrawalStrategy: 'taxable-first',
        accounts: {
          taxable: {
            ...plan.portfolio.accounts.taxable,
            balance: 50000,
            basisPct: 1,
          },
          traditional: {
            ...plan.portfolio.accounts.traditional,
            balance: 0,
          },
          roth: {
            ...plan.portfolio.accounts.roth,
            balance: 0,
          },
        },
        extraAccounts: [],
      };
      plan.savings = { ...(plan.savings || {}), annual: 10000 };
      plan.income = {
        socialSecurity: { primary: { pia: 0, claimAge: 70 }, spouse: null },
        pension: { benefitByAge: {}, base: 0, startAge: 99, colaPct: 0 },
        other: [],
      };
      plan.expenses = {
        living: 0,
        housing: 0,
        debt: 0,
        healthcare: 0,
        healthcareRealGrowth: 0,
        extra: [],
      };
      plan.liabilities = [];
      plan.properties = [];
      plan.goals = [{
        id: 'verify_funding_truth_goal',
        name: goalName,
        cat: 'education',
        area: 'education',
        amount: 10000,
        per: 'yr',
        startAge: 64,
        endAge: 65,
        realGrowth: 0,
        fundFromPortfolioBeforeRetirement: false,
      }];
      plan.ltc = { amount: 0, onsetAge: 99 };
      plan.taxes = { ordinary: 0, capitalGains: 0 };
      plan.simulation = { ...(plan.simulation || {}), iterations: 40 };

      db[householdId] = plan;
      localStorage.setItem(storageKey, JSON.stringify(db));
      localStorage.setItem('parallax.activeHouseholdId', householdId);
      localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
      localStorage.removeItem('parallax.pathReplay.v1');
    }, { householdId: withdrawalPlannerFixtureHouseholdId, goalName });

    await stableReload({ waitUntil: 'networkidle0' });
    await waitForUnselectedWizard(page);
    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);

    const openFundingGoal = async ({ keyboard = false } = {}) => {
      await stableClick('.htab[data-page="household"]');
      await stableClick('.htab[data-sub-target="goals"]');
      await page.waitForFunction(({ id, name }) => {
        const chips = [...document.querySelectorAll(`[data-goal-chip="${id}"]`)];
        const names = [...document.querySelectorAll('.gh-chip__name')]
          .filter(element => element.textContent.trim() === name);
        return chips.length === 1 && names.length === 1;
      }, { timeout: 8000 }, { id: 'verify_funding_truth_goal', name: goalName });
      if(keyboard){
        await page.focus('[data-goal-chip="verify_funding_truth_goal"]');
        await page.keyboard.press('Enter');
      }else{
        await stableClick('[data-goal-chip="verify_funding_truth_goal"]');
      }
      await page.waitForFunction(() => (
        document.querySelectorAll('.gh-rail').length === 1
        && document.querySelectorAll('.gh-rail [data-action="fund-portfolio"]').length === 1
      ), { timeout: 8000 });
    };

    const runAndReadBaselineProbability = async () => {
      await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });
      await page.$eval('#run-btn', button => button.click());
      await page.waitForFunction(
        () => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''),
        { timeout: 30000 },
      );
      await stableClick('button[data-page="scenarios"]');
      await stableClick('#scn-seg-compare');
      await page.waitForFunction(() => {
        const baselines = [...document.querySelectorAll('#scn-view .scol')]
          .filter(column => column.querySelector('.scol__name')?.textContent.trim() === 'Baseline');
        return baselines.length === 1
          && baselines[0].querySelectorAll('.scol__prob').length === 1
          && /\d/.test(baselines[0].querySelector('.scol__prob').textContent || '');
      }, { timeout: 15000 });
      return page.evaluate(() => {
        const baselines = [...document.querySelectorAll('#scn-view .scol')]
          .filter(column => column.querySelector('.scol__name')?.textContent.trim() === 'Baseline');
        if(baselines.length !== 1 || baselines[0].querySelectorAll('.scol__prob').length !== 1){
          throw new Error(`expected one Baseline probability, found ${baselines.length}`);
        }
        return Number.parseFloat(baselines[0].querySelector('.scol__prob').textContent || '');
      });
    };

    await openFundingGoal({ keyboard: true });
    const initialFundingChoice = await page.evaluate(() => ({
      groups: document.querySelectorAll('.gh-funding-seg[role="group"][aria-label="Before retirement funding source"]').length,
      amountInputs: document.querySelectorAll('.gh-amount-input').length,
      amount: document.querySelector('.gh-amount-input')?.value || '',
      outsideSelected: document.querySelector('[data-action="fund-outside"]')?.classList.contains('is-selected') || false,
      portfolioSelected: document.querySelector('[data-action="fund-portfolio"]')?.classList.contains('is-selected') || false,
      outsidePressed: document.querySelector('[data-action="fund-outside"]')?.getAttribute('aria-pressed'),
      portfolioPressed: document.querySelector('[data-action="fund-portfolio"]')?.getAttribute('aria-pressed'),
    }));
    if(initialFundingChoice.groups !== 1
        || initialFundingChoice.amountInputs !== 1
        || initialFundingChoice.amount !== '10,000'
        || !initialFundingChoice.outsideSelected
        || initialFundingChoice.portfolioSelected
        || initialFundingChoice.outsidePressed !== 'true'
        || initialFundingChoice.portfolioPressed !== 'false'){
      throw new Error(`pre-retirement funding choice is not explicit: ${JSON.stringify(initialFundingChoice)}`);
    }

    await stableClick('[data-action="fund-portfolio"]');
    await page.waitForFunction(({ householdId, goalName }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      const goal = db[householdId]?.goals?.find(item => item.name === goalName);
      return goal?.fundFromPortfolioBeforeRetirement === true
        && document.querySelectorAll('[data-action="fund-portfolio"]').length === 1
        && document.querySelector('[data-action="fund-portfolio"]')?.classList.contains('is-selected')
        && document.querySelector('[data-action="fund-portfolio"]')?.getAttribute('aria-pressed') === 'true'
        && document.querySelector('[data-action="fund-outside"]')?.getAttribute('aria-pressed') === 'false';
    }, { timeout: 8000 }, { householdId: withdrawalPlannerFixtureHouseholdId, goalName });
    await stableClick('[data-action="done"]');
    const beforeCadenceProbability = await runAndReadBaselineProbability();
    if(beforeCadenceProbability !== 100){
      throw new Error(`funded $10,000 goal should be 100%, got ${beforeCadenceProbability}`);
    }

    await openFundingGoal();
    await stableClick('[data-action="per-month"]');
    await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '833', { timeout: 8000 });
    const monthlyState = await page.evaluate(({ householdId, goalName }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      const goal = db[householdId]?.goals?.find(item => item.name === goalName);
      return { amount: goal?.amount, per: goal?.per };
    }, { householdId: withdrawalPlannerFixtureHouseholdId, goalName });
    if(monthlyState.amount !== 10000 || monthlyState.per !== 'mo'){
      throw new Error(`monthly display changed canonical annual funding: ${JSON.stringify(monthlyState)}`);
    }
    await stableClick('[data-action="per-year"]');
    await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '10,000', { timeout: 8000 });
    const annualState = await page.evaluate(({ householdId, goalName }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      const goal = db[householdId]?.goals?.find(item => item.name === goalName);
      return { amount: goal?.amount, per: goal?.per };
    }, { householdId: withdrawalPlannerFixtureHouseholdId, goalName });
    if(annualState.amount !== 10000 || annualState.per !== 'yr'){
      throw new Error(`annual round-trip changed canonical funding: ${JSON.stringify(annualState)}`);
    }
    await stableClick('[data-action="done"]');
    const afterCadenceProbability = await runAndReadBaselineProbability();
    if(afterCadenceProbability !== beforeCadenceProbability){
      throw new Error(`cadence-only edit changed probability (${beforeCadenceProbability} to ${afterCadenceProbability})`);
    }

    await openFundingGoal();
    const amountInput = await page.$('.gh-amount-input');
    await amountInput.click({ clickCount: 3 });
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type('100000');
    await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '100,000', { timeout: 8000 });
    // Re-selecting the visible annual cadence commits the typed plan value.
    await stableClick('[data-action="per-year"]');
    await page.waitForFunction(({ householdId, goalName }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      return db[householdId]?.goals?.find(item => item.name === goalName)?.amount === 100000;
    }, { timeout: 8000 }, { householdId: withdrawalPlannerFixtureHouseholdId, goalName });
    await stableClick('[data-action="done"]');

    const underfundedProbability = await runAndReadBaselineProbability();
    if(underfundedProbability !== 0){
      throw new Error(`underfunded pre-retirement goal still reports ${underfundedProbability}% instead of 0%`);
    }

    const compareFunding = await page.evaluate(name => {
      const names = [...document.querySelectorAll('#scn-view .goal-detail__name')]
        .filter(element => element.textContent.trim() === name);
      const columns = document.querySelectorAll('#scn-view .scol').length;
      const disclosures = [...document.querySelectorAll('#scn-view .goal-detail__meta')]
        .filter(element => /portfolio funded before retirement/i.test(element.textContent || ''));
      return { goalNames: names.length, columns, disclosures: disclosures.length };
    }, goalName);
    if(compareFunding.goalNames !== 1
        || compareFunding.columns !== 3
        || compareFunding.disclosures !== compareFunding.columns + 1){
      throw new Error(`Compare does not disclose goal funding truth exactly once per plan: ${JSON.stringify(compareFunding)}`);
    }

    await stableClick('#scn-seg-focus');
    await page.waitForSelector('#scn-view .focus', { visible: true, timeout: 8000 });
    const focusFunding = await page.evaluate(name => {
      const rows = [...document.querySelectorAll('#scn-view .goal-row')]
        .filter(row => row.querySelector('.goal-row__name')?.textContent.trim() === name);
      const row = rows[0];
      return {
        rows: rows.length,
        metas: row?.querySelectorAll('.goal-row__meta').length || 0,
        states: row?.querySelectorAll('.goal-state').length || 0,
        meta: row?.querySelector('.goal-row__meta')?.textContent || '',
        state: row?.querySelector('.goal-state')?.textContent.trim() || '',
        inertSwitches: document.querySelectorAll('#scn-view .goal-toggle,[role="switch"].goal-toggle').length,
      };
    }, goalName);
    if(focusFunding.rows !== 1
        || focusFunding.metas !== 1
        || focusFunding.states !== 1
        || !/portfolio funded before retirement/i.test(focusFunding.meta)
        || focusFunding.state !== 'Active'
        || focusFunding.inertSwitches !== 0){
      throw new Error(`Focus does not disclose read-only goal funding truth: ${JSON.stringify(focusFunding)}`);
    }

    await setCashFlow(page, true);
    await page.evaluate(() => {
      const toggle = document.querySelector('#scn-view .cf-ret-toggle');
      if(toggle?.classList.contains('is-on')) toggle.click();
    });
    await page.waitForFunction(() => (
      document.querySelectorAll('#scn-view .cf').length === 1
      && document.querySelectorAll('#scn-view .cf-row[data-age="64"]').length === 1
    ), { timeout: 8000 });
    const cashFlowTruth = await page.evaluate(() => {
      const rows = document.querySelectorAll('#scn-view .cf-row[data-age="64"]');
      const row = rows[0];
      const parseMoney = value => {
        const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
        if(!match) return Number.NaN;
        const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] || 1;
        return Number(match[1]) * multiplier;
      };
      const goalCells = row?.querySelectorAll('.cf-row__goals-wrap > .cf-cell') || [];
      const drawCells = row?.querySelectorAll('.cf-cell--draw') || [];
      const endingCells = row?.querySelectorAll('.cf-cell--ending > span:first-child') || [];
      const shortfallCells = row?.querySelectorAll('.cf-row__shortfall') || [];
      const probabilityCells = document.querySelectorAll('#scn-view .cf-summary__id .cf-stat__value--probability');
      return {
        rows: rows.length,
        probabilityCells: probabilityCells.length,
        goalCells: goalCells.length,
        drawCells: drawCells.length,
        endingCells: endingCells.length,
        shortfallCells: shortfallCells.length,
        goal: parseMoney(goalCells[0]?.textContent),
        draw: parseMoney(drawCells[0]?.textContent),
        ending: endingCells[0]?.textContent.trim() || '',
        shortfall: shortfallCells[0]?.textContent.trim() || '',
        shortfallVisible: parseMoney(shortfallCells[0]?.textContent),
        shortfallAmount: Number(row?.dataset.fundingShortfall || 0),
      };
    });
    if(cashFlowTruth.rows !== 1
        || cashFlowTruth.probabilityCells !== 0
        || cashFlowTruth.goalCells !== 1
        || cashFlowTruth.drawCells !== 1
        || cashFlowTruth.endingCells !== 1
        || cashFlowTruth.shortfallCells !== 1
        || cashFlowTruth.goal !== 100000
        || !(cashFlowTruth.draw > 0)
        || cashFlowTruth.ending !== '$0'
        || !/^Short \$/i.test(cashFlowTruth.shortfall)
        || !(cashFlowTruth.shortfallAmount > 0)
        || Math.abs(cashFlowTruth.shortfallVisible - cashFlowTruth.shortfallAmount) > 500
        || Math.abs(cashFlowTruth.goal
          - cashFlowTruth.draw
          - cashFlowTruth.shortfallVisible) > 1){
      throw new Error(`Cash Flow hid the underfunded required cash flow: ${JSON.stringify(cashFlowTruth)}`);
    }
    await page.screenshot({ path: join(OUT, '04a-funding-truth.png'), fullPage: true });
    await setCashFlow(page, false);
  });

  await step('tax-funded probability remains unchanged outside Cash Flow after Run', async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const controlledPlan = await page.evaluate((householdId) => {
      const storageKey = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(storageKey) || '{}');
      const plan = db[householdId];
      if(!plan) throw new Error('saved household is unavailable for the probability fixture');

      const currentYear = new Date().getFullYear();
      plan.meta = { ...(plan.meta || {}), primaryName: 'Probability Fixture', spouseName: '', filingStatus: 'single' };
      plan.household = {
        primary: { currentAge: 65, retirementAge: 65, planEndAge: 65, birthYear: currentYear - 65 },
        spouse: null,
        children: [],
      };
      plan.portfolio = {
        ...(plan.portfolio || {}),
        riskProfile: 3,
        withdrawalStrategy: 'taxable-first',
        accounts: {
          taxable: {
            ...plan.portfolio.accounts.taxable,
            balance: 0,
            basisPct: 1,
          },
          traditional: {
            ...plan.portfolio.accounts.traditional,
            balance: 400000,
          },
          roth: {
            ...plan.portfolio.accounts.roth,
            balance: 0,
          },
        },
        extraAccounts: [],
      };
      plan.savings = { ...(plan.savings || {}), annual: 0 };
      plan.income = {
        socialSecurity: { primary: { pia: 0, claimAge: 67 }, spouse: null },
        pension: { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 },
        other: [],
      };
      plan.expenses = {
        living: 0,
        housing: 0,
        debt: 0,
        healthcare: 0,
        healthcareRealGrowth: 0,
        extra: [],
      };
      plan.liabilities = [];
      plan.properties = [];
      plan.goals = [{
        id: 'system:essentials',
        system: 'essentials',
        name: 'Essentials',
        amount: 300000,
        startsAtRetirement: true,
        endAge: 999,
        realGrowth: 0,
        flexesWithSpending: true,
      }];
      plan.ltc = { amount: 0, onsetAge: 85 };
      plan.taxes = { ordinary: 22, capitalGains: 15 };
      plan.simulation = { ...(plan.simulation || {}), iterations: 40 };

      db[householdId] = plan;
      localStorage.setItem(storageKey, JSON.stringify(db));
      localStorage.setItem('parallax.activeHouseholdId', householdId);
      localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
      localStorage.removeItem('parallax.pathReplay.v1');
      return plan;
    }, withdrawalPlannerFixtureHouseholdId);

    resetSeed(20260609);
    const horizonYears = resolveInputs(controlledPlan, {}).horizonYears;
    const returnPaths = Array.from({ length: 40 }, () => generateReturnPath(horizonYears));
    const shortcut = runSimulation(controlledPlan, {}, returnPaths);
    const funded = runMonteCarloWithFederalFunding(shortcut, controlledPlan, {}, {
      filingStatus: 'single',
      baseTaxYear: new Date().getFullYear(),
      scenarioId: 'verify_t9_probability',
    });
    if(shortcut.successRate === funded.federalSuccessRate)
      throw new Error(`probability fixture did not diverge (${shortcut.successRate})`);

    await stableReload({ waitUntil: 'networkidle0' });
    await waitForUnselectedWizard(page);
    await stableClick('.htab[data-page="household"]');
    await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
    await sleep(1200);
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });
    await page.$eval('#run-btn', button => button.click());
    await page.waitForFunction(() => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), { timeout: 30000 });
    await page.click('button[data-page="scenarios"]');
    await sleep(600);
    await page.click('#scn-seg-compare');
    await sleep(400);

    const expected = Number(funded.federalSuccessRate.toFixed(1));
    const oldShortcut = Number(shortcut.successRate.toFixed(1));
    const compareProb = await page.evaluate(() => {
      const baseline = [...document.querySelectorAll('#scn-view .scol')]
        .find(column => /Baseline/i.test(column.querySelector('.scol__name')?.textContent || ''));
      return Number.parseFloat(baseline?.querySelector('.scol__prob')?.textContent || '');
    });
    if(compareProb !== expected) throw new Error(`Compare probability ${compareProb} does not match tax-funded ${expected}`);
    if(compareProb === oldShortcut) throw new Error(`Compare still shows shortcut-only probability ${oldShortcut}`);

    await page.click('#scn-seg-focus');
    await sleep(400);
    const focus = await page.evaluate(() => ({
      hero: Number.parseFloat(document.querySelector('#scn-view .hero__numeral')?.textContent || ''),
      rail: Number.parseFloat([...document.querySelectorAll('#scn-view .rail-card')]
        .find(card => /Baseline/i.test(card.textContent || ''))?.querySelector('.rail-card__prob')?.textContent || ''),
    }));
    if(focus.hero !== expected || focus.rail !== expected)
      throw new Error(`Focus probabilities do not match tax-funded ${expected}: ${JSON.stringify(focus)}`);

    await setCashFlow(page, true);
    await waitCashRows(page, 1);
    const cashFlowProbability = await page.evaluate(() => ({
      cell: !!document.querySelector('#scn-view .cf-summary__id .cf-stat__value--probability'),
      copy: /Probability of success/i.test(document.querySelector('#scn-view .cf-summary')?.textContent || ''),
    }));
    if(cashFlowProbability.cell || cashFlowProbability.copy) throw new Error(`Cash Flow still presents plan-level probability: ${JSON.stringify(cashFlowProbability)}`);
    await setCashFlow(page, false);
    await sleep(300);

  });

  // ── Multi-household persistence & bootstrapping ────────────────────────────
  // These run LAST (they clear storage and reload) so they can't disturb the
  // earlier contracts above. They prove the state-management contract:
  // startup remains unselected, shipped templates are explicit choices, saved
  // values survive reload, and scenario storage remains household-scoped.
  await step('persistence: first load is blank with only approved shipped options', async () => {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    const s = await page.evaluate(() => ({
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
      active: localStorage.getItem('parallax.activeHouseholdId'),
      selected: document.querySelector('#hh-switch')?.value || '',
      railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
      options: [...document.querySelectorAll('#hh-switch option')].map(option => ({
        value: option.value,
        label: option.textContent.trim(),
        disabled: option.disabled,
      })),
      menuHidden: document.querySelector('#hh-menu-pop')?.hidden,
      newBtn: Boolean(document.querySelector('#hh-menu-pop #hh-new')),
      deleteDisabled: Boolean(document.querySelector('#hh-menu-pop #hh-delete')?.disabled),
      loadDemoBtn: Boolean(document.querySelector('#hh-load-demo')),
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
    }));
    if(!s.db || typeof s.db !== 'object') throw new Error('households store not created on first load');
    const expectedFirstLoadIds = Object.keys(WITHDRAWAL_PLANNER_ORACLE.households).sort();
    const actualFirstLoadIds = Object.keys(s.db).sort();
    if(JSON.stringify(actualFirstLoadIds) !== JSON.stringify(expectedFirstLoadIds)){
      throw new Error(`first-load household set is wrong: ${JSON.stringify({ actualFirstLoadIds, expectedFirstLoadIds })}`);
    }
    // Selection and New household are visible directly while no record is active.
    const visibleOptions = s.options.slice(1).map(({ value, label }) => ({ value, label }));
    if(s.active !== null
        || s.selected
        || s.railName
        || s.options[0]?.value !== ''
        || s.options[0]?.disabled !== true
        || JSON.stringify(visibleOptions) !== JSON.stringify([
          { value:'now-household', label:'Now Household' },
          { value:'future-household', label:'Future Household' },
        ])
        || s.menuHidden !== false
        || !s.newBtn
        || !s.deleteDisabled
        || s.loadDemoBtn
        || s.screenCount !== 0){
      throw new Error(`first-load blank selector contract failed: ${JSON.stringify(s)}`);
    }
  });

  await step('persistence: reload starts blank while saved households remain selectable', async () => {
    const setFamilyField = async (field, value) => {
      const beforeRevision = await page.$eval(
        '[data-hh-wizard-root]',
        element => Number(element.dataset.renderRevision),
      );
      await page.evaluate(({ field, value }) => {
        const control = document.querySelector(
          `[data-hh-wizard-screen="family"] [data-wizard-field="${field}"]`,
        );
        if(!control) throw new Error(`missing Family field: ${field}`);
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }, { field, value });
      await waitForWizard(page, {
        step: 'family',
        afterRevision: beforeRevision,
      });
    };
    const runtimeBaseline = await page.evaluate(() => {
      const dbBytes = localStorage.getItem('parallax.households.v1');
      const db = JSON.parse(dbBytes || 'null');
      return {
        dbBytes,
        dbIds: Object.keys(db || {}).sort(),
        sourceBytes: JSON.stringify(db?.['now-household'] || null),
        scenarioBytes: JSON.stringify(
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('parallax.scenarios.'))
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
      };
    });
    await page.select('#hh-switch', 'now-household');
    await waitForWizard(page, { householdId: 'now-household' });
    await stableClick('.htab[data-sub-target="goals"]');
    const sourceGoal = await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      const goal = (db?.['now-household']?.goals || [])
        .find(item => item?.system && item?.name === 'Essentials');
      return goal ? { id: goal.id, amount: goal.amount } : null;
    });
    if(!sourceGoal?.id) throw new Error('runtime Now Essentials goal is unavailable');
    await stableClick(`[data-goal-chip="${sourceGoal.id}"]`);
    const goalAmountBefore = await page.$eval('.gh-amount-input', input => input.value);
    await stableClick('.gh-rail [data-action="amount-plus"]');
    await page.waitForFunction(previousAmount => (
      document.querySelector('.gh-amount-input')?.value !== previousAmount
    ), { timeout: 10000 }, goalAmountBefore);
    const runtimeGoalEdit = await page.evaluate(({ expectedDb, expectedSource, expectedScenarios }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return {
        active: localStorage.getItem('parallax.activeHouseholdId'),
        rootId: document.querySelector('[data-gh-root]')?.dataset.householdId
          || document.querySelector('[data-hh-wizard-root]')?.dataset.householdId
          || '',
        visibleAmount: document.querySelector('.gh-amount-input')?.value || '',
        dbUnchanged: localStorage.getItem('parallax.households.v1') === expectedDb,
        sourceUnchanged: JSON.stringify(db?.['now-household'] || null) === expectedSource,
        ids: Object.keys(db || {}).sort(),
        derivedIds: Object.entries(db || {})
          .filter(([, household]) => ['now-household', 'future-household'].includes(
            household?.meta?.runtimeSourceHouseholdId,
          ))
          .map(([id]) => id),
        scenarioBytesUnchanged: JSON.stringify(
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('parallax.scenarios.'))
            .sort(([left], [right]) => left.localeCompare(right)),
        ) === expectedScenarios,
        runtimeScenarioKeys: ['now-household', 'future-household'].filter(id => (
          localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null
        )),
      };
    }, {
      expectedDb: runtimeBaseline.dbBytes,
      expectedSource: runtimeBaseline.sourceBytes,
      expectedScenarios: runtimeBaseline.scenarioBytes,
    });
    if(runtimeGoalEdit.active !== null
        || runtimeGoalEdit.rootId !== 'now-household'
        || runtimeGoalEdit.visibleAmount === goalAmountBefore
        || !runtimeGoalEdit.dbUnchanged
        || !runtimeGoalEdit.sourceUnchanged
        || JSON.stringify(runtimeGoalEdit.ids) !== JSON.stringify(runtimeBaseline.dbIds)
        || runtimeGoalEdit.derivedIds.length !== 0
        || !runtimeGoalEdit.scenarioBytesUnchanged
        || runtimeGoalEdit.runtimeScenarioKeys.length !== 0){
      throw new Error(`runtime Now Goal edit escaped session state: ${JSON.stringify(runtimeGoalEdit)}`);
    }
    await stableClick('.htab[data-page="household"]');
    await waitForWizard(page, { householdId: 'now-household' });
    await goToWizardStep(page, 'family');
    await setFamilyField('primaryName', 'Transient Now Edit');
    const runtimeFamilyEdit = await page.evaluate(({ expectedDb, expectedSource, expectedScenarios }) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return {
        active: localStorage.getItem('parallax.activeHouseholdId'),
        rootId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
        selected: document.querySelector('#hh-switch')?.value || '',
        visibleName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
        status: document.querySelector('#status')?.textContent.trim() || '',
        dbUnchanged: localStorage.getItem('parallax.households.v1') === expectedDb,
        sourceUnchanged: JSON.stringify(db?.['now-household'] || null) === expectedSource,
        ids: Object.keys(db || {}).sort(),
        derivedIds: Object.entries(db || {})
          .filter(([, household]) => ['now-household', 'future-household'].includes(
            household?.meta?.runtimeSourceHouseholdId,
          ))
          .map(([id]) => id),
        scenarioBytesUnchanged: JSON.stringify(
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('parallax.scenarios.'))
            .sort(([left], [right]) => left.localeCompare(right)),
        ) === expectedScenarios,
        runtimeScenarioKeys: ['now-household', 'future-household'].filter(id => (
          localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null
        )),
      };
    }, {
      expectedDb: runtimeBaseline.dbBytes,
      expectedSource: runtimeBaseline.sourceBytes,
      expectedScenarios: runtimeBaseline.scenarioBytes,
    });
    if(runtimeFamilyEdit.active !== null
        || runtimeFamilyEdit.rootId !== 'now-household'
        || runtimeFamilyEdit.selected !== 'now-household'
        || runtimeFamilyEdit.visibleName !== 'Transient Now Edit'
        || runtimeFamilyEdit.status !== 'Demo changes are temporary · use New Household to save a plan'
        || !runtimeFamilyEdit.dbUnchanged
        || !runtimeFamilyEdit.sourceUnchanged
        || JSON.stringify(runtimeFamilyEdit.ids) !== JSON.stringify(runtimeBaseline.dbIds)
        || runtimeFamilyEdit.derivedIds.length !== 0
        || !runtimeFamilyEdit.scenarioBytesUnchanged
        || runtimeFamilyEdit.runtimeScenarioKeys.length !== 0){
      throw new Error(`runtime Now Family edit escaped session state: ${JSON.stringify(runtimeFamilyEdit)}`);
    }
    const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
    if(menuHidden) await stableClick('#hh-menu-btn');
    await stableClick('#hh-new');
    await page.waitForFunction(() => {
      const id = document.querySelector('#hh-switch')?.value;
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      const status = document.querySelector('#status')?.textContent || '';
      return id
        && localStorage.getItem('parallax.activeHouseholdId') === id
        && Boolean(db?.[id])
        && !document.querySelector('#run-btn')?.disabled
        && /Plan updated|Partial run/i.test(status);
    }, { timeout: 15000 });
    const pendingCustomId = await page.$eval('#hh-switch', element => element.value);
    if(!pendingCustomId){
      throw new Error(`New Household did not become the working record (id="${pendingCustomId}")`);
    }
    const created = await page.evaluate(() => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    }));
    if(!created.active) throw new Error(`New Household did not become active (active="${created.active}")`);
    const customId = created.active;
    await setFamilyField('primaryName', 'Saved Client');
    await setFamilyField('client.socialSecurityAge', '70');
    await page.waitForFunction(id => {
      const record = JSON.parse(
        localStorage.getItem('parallax.households.v1') || 'null',
      )?.[id];
      return record?.meta?.primaryName === 'Saved Client'
        && record?.income?.socialSecurity?.primary?.claimAge === 70;
    }, { timeout: 10000 }, customId);
    const savedCustomBytes = await page.evaluate(id => JSON.stringify(
      JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id],
    ), customId);
    const expectedCreatedIds = [
      ...Object.keys(WITHDRAWAL_PLANNER_ORACLE.households),
      customId,
    ].sort();
    const actualCreatedIds = Object.keys(created.db).sort();
    if(JSON.stringify(actualCreatedIds) !== JSON.stringify(expectedCreatedIds)){
      throw new Error(`household set after New is wrong: ${JSON.stringify({ actualCreatedIds, expectedCreatedIds })}`);
    }
    if(!created.db[customId] || created.db[customId].meta.isDemo !== false) throw new Error('new household record is not marked isDemo=false');
    if(created.db[customId].income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`new household primary claim age must default to 67: ${JSON.stringify(created.db[customId].income.socialSecurity)}`);
    const removedGlobalControls = await page.evaluate(() => ({
      save: Boolean(document.querySelector('#save-btn')),
      sticky: Boolean(document.querySelector('.sn-btn, .sn-note, .sn-overlay')),
    }));
    if(removedGlobalControls.save || removedGlobalControls.sticky){
      throw new Error(`removed global controls still rendered: ${JSON.stringify(removedGlobalControls)}`);
    }

    // Reload must always return to the current-build blank state. The saved
    // household remains available only through an explicit selector action.
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    const afterReload = await page.evaluate(() => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
      selected: document.querySelector('#hh-switch')?.value || '',
      railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
      runtimeScenarioKeys: ['now-household', 'future-household'].filter(id => (
        localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null
      )),
    }));
    if(afterReload.active !== null || afterReload.selected || afterReload.railName){
      throw new Error(`reload did not return to the private blank state: ${JSON.stringify(afterReload)}`);
    }
    if(afterReload.db[customId].meta.isDemo !== false) throw new Error('custom record overwritten on reload');
    if(JSON.stringify(afterReload.db[customId]) !== savedCustomBytes)
      throw new Error('saved custom household bytes changed during blank startup');
    if(JSON.stringify(afterReload.db['now-household']) !== runtimeBaseline.sourceBytes)
      throw new Error('shipped Now household bytes changed during blank startup');
    if(Object.values(afterReload.db).some(household => (
      ['now-household', 'future-household'].includes(household?.meta?.runtimeSourceHouseholdId)
    ))) throw new Error('runtime-derived household survived blank startup');
    if(afterReload.runtimeScenarioKeys.length !== 0){
      throw new Error('runtime template scenarios entered persistent storage');
    }
    const visibleSwitcher = await page.$eval('#hh-switch', selector => {
      const menu = selector.closest('#hh-menu-pop');
      return menu?.hidden === false;
    });
    if(!visibleSwitcher) throw new Error('household switcher was not visible for saved-record selection');
    await page.select('#hh-switch', customId);
    await waitForWizard(page, { step: 'family', householdId: customId });
    const selectedCustom = await page.evaluate(() => ({
      selected: document.querySelector('#hh-switch')?.value,
      primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value,
    }));
    if(selectedCustom.selected !== customId || selectedCustom.primaryName !== 'Saved Client'){
      throw new Error(`saved household was not restored by explicit selection: ${JSON.stringify(selectedCustom)}`);
    }
  });

  await step('persistence: scenario localStorage is scoped by householdId', async () => {
    const customId = await page.evaluate(() => localStorage.getItem('parallax.activeHouseholdId'));
    const keys = await page.evaluate(() => Object.keys(localStorage));
    const nowKey = 'parallax.scenarios.now-household.v1';
    const futureKey = 'parallax.scenarios.future-household.v1';
    const customKey = `parallax.scenarios.${customId}.v1`;
    if(keys.includes(nowKey) || keys.includes(futureKey)){
      throw new Error(`runtime template scenarios entered persistent storage: ${JSON.stringify(keys)}`);
    }
    if(!keys.includes(customKey)) throw new Error(`custom scenarios not scoped by id (missing ${customKey}): ${JSON.stringify(keys)}`);
    if(keys.includes('parallax.scenarios.v2')) throw new Error('legacy global scenario key parallax.scenarios.v2 must not be written');
  });

  await step('persistence: schema merge preserves custom values and refreshes shipped templates', async () => {
    const customId = await page.evaluate(() => localStorage.getItem('parallax.activeHouseholdId'));
    await page.evaluate((id) => {
      const key = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(key));
      db[id].meta.primaryName = 'Custom Saved';
      db[id].income.socialSecurity.primary.pia = 7777;
      delete db[id].income.socialSecurity.primary.claimAge;
      db['now-household'].meta.primaryName = 'Stale template';
      delete db['future-household'];
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.setItem('parallax.activeHouseholdId', id);
    }, customId);
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    const merged = await page.evaluate((id) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return { active: localStorage.getItem('parallax.activeHouseholdId'), db, record: db?.[id] };
    }, customId);
    if(merged.active !== null
        || merged.record?.meta?.primaryName !== 'Custom Saved'
        || merged.record?.income?.socialSecurity?.primary?.pia !== 7777)
      throw new Error(`schema merge overwrote saved custom values: ${JSON.stringify(merged)}`);
    if(merged.record.income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`schema merge did not add missing claimAge=67: ${JSON.stringify(merged.record.income.socialSecurity)}`);
    if(merged.db['now-household']?.meta?.primaryName !== 'Aboysname'
        || merged.db['future-household']?.meta?.primaryName !== 'amansname'){
      throw new Error(`bootstrap did not refresh both shipped templates: ${JSON.stringify(merged.db)}`);
    }

    await page.select('#hh-switch', customId);
    await waitForWizard(page, { householdId: customId });
    if(await page.$eval('#hh-menu-pop', menu => menu.hidden)){
      await stableClick('#hh-menu-btn');
    }
    await page.select('#hh-switch', 'now-household');
    await waitForWizard(page, { householdId: 'now-household' });
    await goToWizardStep(page, 'family');
    const after = await page.evaluate((id) => ({
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
      selected: document.querySelector('#hh-switch')?.value,
      primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value,
      customId: id,
    }), customId);
    if(after.selected !== 'now-household' || after.primaryName !== 'Aboysname'){
      throw new Error(`Now Household did not render current shipped facts: ${JSON.stringify(after)}`);
    }
    if(after.db[customId]?.meta?.primaryName !== 'Custom Saved' || after.db[customId]?.income?.socialSecurity?.primary?.pia !== 7777)
      throw new Error(`shipped selection altered the saved custom household: ${JSON.stringify(after.db[customId])}`);
  });

  await step('persistence: corrupt origin bytes are preserved while current defaults remain usable', async () => {
    const readOnly = 'Household storage could not be upgraded. Viewing a read-only copy; reload after storage is available.';
    const corrupt = '{not-json';
    const seededScenarios = JSON.stringify([
      { name:'Baseline', base:true, lev:{} },
      { name:'Scenario B', base:false, lev:{} },
    ]);
    await page.evaluate(({ raw, scenarios }) => {
      localStorage.clear();
      localStorage.setItem('parallax.households.v1', raw);
      localStorage.setItem('parallax.activeHouseholdId', 'demo');
      localStorage.setItem('parallax.scenarios.demo.v1', scenarios);
    }, { raw: corrupt, scenarios: seededScenarios });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await page.waitForFunction(expected => (
      document.querySelector('#status')?.textContent.trim() === expected
    ), { timeout: 10000 }, readOnly);

    const readRecoveryBytes = () => page.evaluate(() => {
      const scenarios = {};
      const scenarioKeys = [];
      for(let i = 0; i < localStorage.length; i++){
        const key = localStorage.key(i);
        if(key?.startsWith('parallax.scenarios.')) scenarioKeys.push(key);
      }
      for(const key of scenarioKeys.sort()) scenarios[key] = localStorage.getItem(key);
      return {
        db: localStorage.getItem('parallax.households.v1'),
        active: localStorage.getItem('parallax.activeHouseholdId'),
        scenarios,
      };
    });
    const beforeBytes = await readRecoveryBytes();
    if(beforeBytes.db !== corrupt) throw new Error('read-only bootstrap replaced corrupt household bytes');
    if(beforeBytes.active !== 'demo') throw new Error(`read-only bootstrap changed the active pointer to "${beforeBytes.active}"`);
    if(beforeBytes.scenarios['parallax.scenarios.demo.v1'] !== seededScenarios) throw new Error('read-only bootstrap changed scenario bytes');

    const startup = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent.trim() || '',
      selected: document.querySelector('#hh-switch')?.value || '',
      options: Array.from(document.querySelector('#hh-switch')?.options || [], option => ({
        value: option.value,
        label: option.textContent.trim(),
      })),
      switchDisabled: Boolean(document.querySelector('#hh-switch')?.disabled),
      loadDemoExists: Boolean(document.querySelector('#hh-load-demo')),
      newDisabled: Boolean(document.querySelector('#hh-new')?.disabled),
      enabledFields: document.querySelectorAll('#hh-view input:not(:disabled), #hh-view select:not(:disabled), #hh-view textarea:not(:disabled)').length,
    }));
    for(const expected of [
      ['now-household', 'Now Household'],
      ['future-household', 'Future Household'],
    ]){
      if(!startup.options.some(option => option.value === expected[0] && option.label === expected[1])){
        throw new Error(`corrupt-origin recovery omitted current default ${expected[0]}: ${JSON.stringify(startup)}`);
      }
    }
    if(startup.status !== readOnly || startup.selected
      || startup.switchDisabled || startup.loadDemoExists || !startup.newDisabled
      || startup.enabledFields){
      throw new Error(`corrupt-origin runtime state is not safely usable: ${JSON.stringify(startup)}`);
    }

    await page.select('#hh-switch', 'now-household');
    await waitForWizard(page, { householdId: 'now-household' });
    await stableClick('.htab[data-page="tax-buckets"]');
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-taw-root]');
      return root?.dataset.tawHouseholdId === 'now-household'
        && root.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('.taw-range:not(:disabled)').length === 5
        && document.querySelector('[data-taw-federal-tax]')?.textContent.trim() !== '\u2014';
    }, { timeout: 15000 });
    const beforeSlider = await page.evaluate(() => ({
      revision: Number(document.querySelector('[data-taw-root]')?.dataset.tawRenderRevision || -1),
      geometry: Array.from(document.querySelectorAll('[data-taw-col]'), column => (
        column.querySelector('.taw-col-fill')?.style.height || ''
      )),
    }));
    await stableClick('[data-taw-lever="realizedGain"]');
    await page.keyboard.press('End');
    await page.waitForFunction(previousRevision => {
      const root = document.querySelector('[data-taw-root]');
      const input = document.querySelector('[data-taw-lever="realizedGain"]');
      return root?.getAttribute('aria-busy') === 'false'
        && Number(root.dataset.tawRenderRevision || -1) > previousRevision
        && input?.value === input?.max;
    }, { timeout: 15000 }, beforeSlider.revision);
    const afterSlider = await page.evaluate(() => ({
      geometry: Array.from(document.querySelectorAll('[data-taw-col]'), column => (
        column.querySelector('.taw-col-fill')?.style.height || ''
      )),
      federalTax: document.querySelector('[data-taw-federal-tax]')?.textContent.trim() || '',
    }));
    if(JSON.stringify(afterSlider.geometry) === JSON.stringify(beforeSlider.geometry)
      || afterSlider.federalTax === '\u2014'){
      throw new Error(`default-household Withdrawal Planner did not update column fill: ${JSON.stringify({ beforeSlider, afterSlider })}`);
    }

    const afterBytes = await readRecoveryBytes();
    if(JSON.stringify(afterBytes) !== JSON.stringify(beforeBytes)){
      throw new Error(`read-only default use changed recovery bytes: ${JSON.stringify({ beforeBytes, afterBytes })}`);
    }
  });

  await step('persistence: READ_ONLY disables every mutation but preserves navigation and bytes', async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const readOnly = 'Household storage could not be upgraded. Viewing a read-only copy; reload after storage is available.';
    const readOnlyStorageHook = await page.evaluateOnNewDocument(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value){
        if(key === 'parallax.households.v1') throw new Error('QuotaExceededError');
        return orig.call(this, key, value);
      };
    });
    await page.evaluate(() => {
      localStorage.clear();
      const base = (id, name, spouse) => ({
        meta: { householdId:id, name, isDemo:id === 'demo', primaryName:name, spouseName:spouse ? 'Co-Client' : '', filingStatus:spouse ? 'marriedFilingJointly' : 'single', state:'VA', accountSchemaVersion:0 },
        household: { primary:{ currentAge:60, retirementAge:65, planEndAge:90, birthYear:1966 }, spouse:spouse ? { currentAge:59, retirementAge:65, birthYear:1967 } : null, children:[] },
        portfolio: {
          riskProfile: 3,
          accounts: { taxable:{ balance:0, basisPct:1 }, traditional:{ balance:0 }, roth:{ balance:0 } },
          extraAccounts: spouse
            ? [
                { type:'Brokerage (taxable)', bucket:'taxable', owner:'client', balance:1000 },
                { type:'Roth IRA', bucket:'roth', owner:'spouse', balance:2000 },
              ]
            : [{ type:'Traditional IRA', bucket:'traditional', owner:'client', balance:3000 }],
        },
        expenses: {
          living:spouse ? 24000 : 12000,
          healthcare:0,
          healthcareRealGrowth:0.02,
          extra:[{ label:'Travel', amount:1200, startAge:65, endAge:80 }],
        },
        income: {
          socialSecurity:{ primary:{ pia:0, claimAge:67 }, spouse:spouse ? { pia:0, claimAge:67 } : null },
          pension:{ benefitByAge:{}, base:0, startAge:65, colaPct:0 },
          other:[{ label:'Consulting', amount:2400, startAge:60, endAge:64, realGrowth:0, taxablePct:1 }],
          workingIncome:0,
        },
        savings: { annual:0 }, goals:[], simulation:{ iterations:1000 },
      });
      const db = { demo:base('demo', 'Read Only Demo', true), other:base('other', 'Read Only Other', false) };
      localStorage.setItem('parallax.households.v1', JSON.stringify(db));
      localStorage.setItem('parallax.activeHouseholdId', 'demo');
      localStorage.setItem('parallax.scenarios.demo.v1', JSON.stringify([
        { name:'Baseline', base:true, lev:{} }, { name:'Scenario B', base:false, lev:{} },
      ]));
      localStorage.setItem('parallax.scenarios.other.v1', JSON.stringify([
        { name:'Baseline', base:true, lev:{} }, { name:'Other B', base:false, lev:{} },
      ]));
    });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    const readOnlyBlank = await page.evaluate(() => ({
      selected: document.querySelector('#hh-switch')?.value || '',
      railName: document.querySelector('#hh-rail-name')?.textContent.trim() || '',
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
      options: [...document.querySelectorAll('#hh-switch option')].map(option => option.value),
    }));
    if(readOnlyBlank.selected
        || readOnlyBlank.railName
        || readOnlyBlank.screenCount
        || !readOnlyBlank.options.includes('now-household')
        || !readOnlyBlank.options.includes('future-household')
        || !readOnlyBlank.options.includes('other')
        || readOnlyBlank.options.includes('demo')){
      throw new Error(`read-only startup did not render the private blank selector: ${JSON.stringify(readOnlyBlank)}`);
    }
    const beforeSaved = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.select('#hh-switch', 'other');
    await waitForWizard(page, {
      afterRevision: beforeSaved,
      householdId: 'other',
    });

    const readRecoveryBytes = () => page.evaluate(() => {
      const scenarios = {};
      const scenarioKeys = [];
      for(let i = 0; i < localStorage.length; i++){
        const key = localStorage.key(i);
        if(key?.startsWith('parallax.scenarios.')) scenarioKeys.push(key);
      }
      for(const key of scenarioKeys.sort()) scenarios[key] = localStorage.getItem(key);
      return {
        db: localStorage.getItem('parallax.households.v1'),
        active: localStorage.getItem('parallax.activeHouseholdId'),
        scenarios,
      };
    });
    const beforeBytes = await readRecoveryBytes();
    const assertPinned = async label => {
      const status = await page.$eval('#status', el => el.textContent.trim());
      if(status !== readOnly) throw new Error(`${label}: read-only status was not pinned (got "${status}")`);
    };
    const assertBytesUnchanged = async label => {
      const current = await readRecoveryBytes();
      if(JSON.stringify(current) !== JSON.stringify(beforeBytes)){
        throw new Error(`${label}: read-only interaction changed DB/pointer/scenario bytes`);
      }
    };
    await assertPinned('initial load');

    const globalControls = await page.evaluate(() => ({
      saveExists: Boolean(document.querySelector('#save-btn')),
      newHousehold: document.querySelector('#hh-new')?.disabled,
      switchDisabled: document.querySelector('#hh-switch')?.disabled,
      loadDemoExists: Boolean(document.querySelector('#hh-load-demo')),
      householdStepCount: document.querySelectorAll('.hh-step').length,
      householdStepsDisabled: [...document.querySelectorAll('.hh-step')].some(el => el.disabled),
    }));
    if(globalControls.saveExists || !globalControls.newHousehold) throw new Error(`read-only must omit Save and disable New: ${JSON.stringify(globalControls)}`);
    if(!globalControls.householdStepCount || globalControls.switchDisabled || globalControls.loadDemoExists || globalControls.householdStepsDisabled){
      throw new Error(`read-only navigation must stay enabled: ${JSON.stringify(globalControls)}`);
    }

    // The Goals surface shares the same read-only orchestration boundary. Its
    // inputs and action controls must expose a disabled state, while the top
    // navigation that reaches the surface remains usable.
    await stableClick('.htab[data-sub-target="goals"]');
    await sleep(500);
    const goalsControls = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('#np-content input, #np-content select, #np-content textarea, #np-content button, #np-content [role="button"], #np-content [data-add], #np-content [data-act]')];
      const locked = el => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      return {
        count:controls.length,
        enabled:controls.filter(el => !locked(el)).map(el => el.id || el.dataset.path || el.dataset.act || el.textContent.trim()).slice(0, 8),
      };
    });
    if(!goalsControls.count || goalsControls.enabled.length){
      throw new Error(`read-only Goals controls must all be disabled: ${JSON.stringify(goalsControls)}`);
    }
    await assertPinned('goals controls');
    await assertBytesUnchanged('goals controls');

    // Family fields remain visible for recovery context, but every mutation is
    // disabled and the guarded command boundary rejects synthetic events.
    await goToWizardStep(page, 'family');
    const familyBefore = await page.evaluate(() => {
      const controls = [...document.querySelectorAll(
        '[data-hh-wizard-screen="family"] [data-wizard-field]',
      )];
      return {
        count: controls.length,
        enabled: controls.filter(element => !element.disabled)
          .map(element => element.dataset.wizardField),
        primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
        filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
        people: document.querySelectorAll('[data-person-owner]').length,
      };
    });
    if(!familyBefore.count || familyBefore.enabled.length){
      throw new Error(`read-only Family fields must all be disabled: ${JSON.stringify(familyBefore)}`);
    }
    await page.evaluate(() => {
      const name = document.querySelector('[data-wizard-field="primaryName"]');
      name.value = 'Changed despite read-only';
      name.dispatchEvent(new Event('change', { bubbles: true }));
      const filing = document.querySelector('[data-wizard-field="filingStatus"]');
      filing.value = 'single';
      filing.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await goToWizardStep(page, 'net-worth');
    await goToWizardStep(page, 'family');
    const familyAfter = await page.evaluate(() => ({
      primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
      filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
      people: document.querySelectorAll('[data-person-owner]').length,
    }));
    if(JSON.stringify(familyAfter) !== JSON.stringify({
      primaryName: familyBefore.primaryName,
      filingStatus: familyBefore.filingStatus,
      people: familyBefore.people,
    })){
      throw new Error(`read-only Family edit changed immediate state: ${JSON.stringify({ familyBefore, familyAfter })}`);
    }
    await assertPinned('Family fields');
    await assertBytesUnchanged('Family fields');

    // Net Worth category navigation remains available, while every mutation
    // stays inert even when a synthetic event targets a disabled control.
    await openNetWorthCategory(page, 'investment');
    const accountBefore = await page.evaluate(() => {
      const remove = [...document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
      )];
      const picks = [...document.querySelectorAll(
        '[data-hh-action="net-worth-pick-type"]',
      )];
      return {
        ids: remove.map(button => button.dataset.accountId),
        values: remove.map(button => button.closest('.nw-saved-row')
          ?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''),
        removeCount: remove.length,
        removeEnabled: remove.filter(element => !element.disabled).length,
        pickCount: picks.length,
        pickEnabled: picks.filter(element => !element.disabled).length,
        draftCount: document.querySelectorAll('[data-net-worth-draft]').length,
      };
    });
    if(!accountBefore.ids.length
      || !accountBefore.removeCount || accountBefore.removeEnabled
      || !accountBefore.pickCount || accountBefore.pickEnabled
      || accountBefore.draftCount){
      throw new Error(`read-only Net Worth controls are not disabled: ${JSON.stringify(accountBefore)}`);
    }
    await page.evaluate(() => {
      document.querySelector(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
      )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('[data-hh-action="net-worth-pick-type"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await goToWizardStep(page, 'family');
    await openNetWorthCategory(page, 'investment');
    const accountAfter = await page.evaluate(() => ({
      ids: [...document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
      )].map(button => button.dataset.accountId),
      values: [...document.querySelectorAll(
        '[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]',
      )].map(button => button.closest('.nw-saved-row')
        ?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''),
      draftCount: document.querySelectorAll('[data-net-worth-draft]').length,
    }));
    if(JSON.stringify(accountAfter.ids) !== JSON.stringify(accountBefore.ids)
      || JSON.stringify(accountAfter.values) !== JSON.stringify(accountBefore.values)
      || accountAfter.draftCount){
      throw new Error(`read-only Net Worth edit changed immediate state: ${JSON.stringify({ accountBefore, accountAfter })}`);
    }
    await assertPinned('Net Worth add/remove');
    await assertBytesUnchanged('Net Worth add/remove');

    // Tax fields and completion are guarded mutations. View controls may remain
    // navigable, while source-override and remove-item actions must be disabled.
    await goToWizardStep(page, 'tax');
    const taxBefore = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('[data-tax-field]')];
      const mutations = [...document.querySelectorAll(
        '[data-hh-action="override-income-group"],'
        + ' [data-hh-action="revert-income-group"],'
        + ' [data-hh-action="remove-tax-item"]',
      )];
      return {
        fieldCount: fields.length,
        enabledFields: fields.filter(element => !element.disabled)
          .map(element => element.dataset.taxField),
        taxYear: document.querySelector('[data-tax-field="taxYear"]')?.value || '',
        mutationCount: mutations.length,
        enabledMutations: mutations.filter(element => !element.disabled)
          .map(element => element.dataset.hhAction),
      };
    });
    if(!taxBefore.fieldCount || taxBefore.enabledFields.length
      || taxBefore.enabledMutations.length){
      throw new Error(`read-only Tax controls are not disabled: ${JSON.stringify(taxBefore)}`);
    }
    await page.evaluate(() => {
      const taxYear = document.querySelector('[data-tax-field="taxYear"]');
      taxYear.value = taxYear.value === '2026' ? '2025' : '2026';
      taxYear.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector(
        '[data-hh-action="override-income-group"], [data-hh-action="revert-income-group"]',
      )?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await goToWizardStep(page, 'family');
    await goToWizardStep(page, 'tax');
    const taxAfter = await page.evaluate(() => ({
      taxYear: document.querySelector('[data-tax-field="taxYear"]')?.value || '',
    }));
    if(taxAfter.taxYear !== taxBefore.taxYear){
      throw new Error(`read-only Tax edit changed immediate state: ${JSON.stringify({ taxBefore, taxAfter })}`);
    }
    await assertPinned('Tax fields and completion');
    await assertBytesUnchanged('Tax fields and completion');

    // New Household is a mutation and must remain inert.
    const optionCountBefore = await page.$$eval('#hh-switch option', els => els.length);
    await page.evaluate(() => document.querySelector('#hh-new')?.dispatchEvent(new MouseEvent('click', { bubbles:true })));
    const optionCountAfter = await page.$$eval('#hh-switch option', els => els.length);
    if(optionCountAfter !== optionCountBefore) throw new Error('read-only New Household changed the in-memory household list');
    await assertPinned('new household');
    await assertBytesUnchanged('new household');

    // Scenarios: every mutation control is disabled; forced events cannot add,
    // open rename/delete UI, or alter a lever or scenario bytes.
    await stableClick('button[data-page="scenarios"]');
    await sleep(900);
    await stableClick('#scn-seg-compare');
    await sleep(300);
    const scenarioBefore = await page.evaluate(() => ({
      names:[...document.querySelectorAll('#scn-view .scol__name')].map(el => el.textContent.trim()),
      addDisabled:document.querySelector('#scn-add')?.disabled,
      solvePresent:!!document.querySelector('#scn-solve, #solve-panel'),
      menuCount:document.querySelectorAll('#scn-view .scol__menu').length,
      menuDisabled:[...document.querySelectorAll('#scn-view .scol__menu')].every(el => el.disabled),
      stepCount:document.querySelectorAll('#scn-view .cmp-step-btn').length,
      stepsDisabled:[...document.querySelectorAll('#scn-view .cmp-step-btn')].every(el => el.disabled),
      inputCount:document.querySelectorAll('#scn-view .cmp-lev-in, #scn-view .cmp-goal-in').length,
      inputsDisabled:[...document.querySelectorAll('#scn-view .cmp-lev-in, #scn-view .cmp-goal-in')].every(el => el.disabled),
      firstLever:document.querySelector('#scn-view .cmp-lev-in')?.value || '',
    }));
    if(!scenarioBefore.names.length || !scenarioBefore.addDisabled || scenarioBefore.solvePresent ||
       !scenarioBefore.menuCount || !scenarioBefore.menuDisabled || !scenarioBefore.stepCount ||
       !scenarioBefore.stepsDisabled || !scenarioBefore.inputCount || !scenarioBefore.inputsDisabled){
      throw new Error(`read-only scenario mutation controls are not disabled: ${JSON.stringify(scenarioBefore)}`);
    }
    await page.evaluate(() => {
      document.querySelector('#scn-add')?.dispatchEvent(new MouseEvent('click', { bubbles:true }));
      document.querySelector('#scn-view .scol__menu')?.dispatchEvent(new MouseEvent('click', { bubbles:true }));
      document.querySelector('#scn-view .cmp-step-btn')?.dispatchEvent(new MouseEvent('click', { bubbles:true }));
      document.querySelectorAll('#scn-reset, [data-scn-reset], [data-action="reset-scenarios"]')
        .forEach(el => el.dispatchEvent(new MouseEvent('click', { bubbles:true })));
      const input = document.querySelector('#scn-view .cmp-lev-in');
      if(input){ input.value = '999999'; input.dispatchEvent(new Event('change', { bubbles:true })); }
    });
    await sleep(400);
    // The direct value assignment above can change a disabled DOM input even
    // when the application correctly rejects the event. Re-render from model
    // state before asserting that no in-memory scenario value changed.
    await stableClick('#scn-seg-focus');
    await sleep(200);
    await stableClick('#scn-seg-compare');
    await sleep(300);
    const scenarioAfter = await page.evaluate(() => ({
      names:[...document.querySelectorAll('#scn-view .scol__name')].map(el => el.textContent.trim()),
      menu:!!document.querySelector('#scn-view .scol__pop, #scn-view .scol__rename'),
      firstLever:document.querySelector('#scn-view .cmp-lev-in')?.value || '',
      enabledReset:[...document.querySelectorAll('#scn-reset, [data-scn-reset], [data-action="reset-scenarios"]')].some(el => !el.disabled),
    }));
    if(JSON.stringify(scenarioAfter.names) !== JSON.stringify(scenarioBefore.names) || scenarioAfter.menu || scenarioAfter.enabledReset){
      throw new Error(`read-only scenario add/delete/rename/reset changed immediate state: ${JSON.stringify({ scenarioBefore, scenarioAfter })}`);
    }
    if(scenarioAfter.firstLever !== scenarioBefore.firstLever){
      throw new Error(`read-only scenario lever changed immediate UI state (${scenarioBefore.firstLever} -> ${scenarioAfter.firstLever})`);
    }
    await assertPinned('scenario mutations');
    await assertBytesUnchanged('scenario mutations');

    // Switching is navigation in read-only mode. It must expose current shipped
    // templates and saved custom records while durable bytes remain untouched.
    await goToWizardStep(page, 'family');
    const switchState = await page.evaluate(() => ({
      disabled:document.querySelector('#hh-switch')?.disabled,
      values:[...document.querySelectorAll('#hh-switch option')].map(el => el.value),
    }));
    if(switchState.disabled
        || !switchState.values.includes('now-household')
        || !switchState.values.includes('future-household')
        || !switchState.values.includes('other')
        || switchState.values.includes('demo')){
      throw new Error(`read-only household switch is unavailable: ${JSON.stringify(switchState)}`);
    }
    const beforeNow = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => {
      const sel = document.querySelector('#hh-switch');
      sel.value = 'now-household';
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    });
    await waitForWizard(page, {
      afterRevision: beforeNow,
      householdId: 'now-household',
    });
    const nowState = await page.evaluate(() => ({
      selected:document.querySelector('#hh-switch')?.value || '',
      primaryName:document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    }));
    if(nowState.selected !== 'now-household' || nowState.primaryName !== 'Aboysname'){
      throw new Error(`read-only Now navigation did not render current facts: ${JSON.stringify(nowState)}`);
    }
    await assertPinned('switch to Now');
    await assertBytesUnchanged('switch to Now');

    const beforeOther = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.select('#hh-switch', 'other');
    await waitForWizard(page, {
      afterRevision: beforeOther,
      householdId: 'other',
    });
    const otherState = await page.evaluate(() => ({
      selected:document.querySelector('#hh-switch')?.value || '',
      rail:document.querySelector('#hh-rail-name')?.textContent.trim() || '',
    }));
    if(otherState.selected !== 'other' || !/Read Only Other/.test(otherState.rail)){
      throw new Error(`read-only switch did not navigate the transient household: ${JSON.stringify(otherState)}`);
    }
    await assertPinned('switch to other');
    await assertBytesUnchanged('switch to other');

    await goToWizardStep(page, 'family');
    const otherFamilyBefore = await page.evaluate(() => ({
      filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
      filingDisabled: Boolean(document.querySelector('[data-wizard-field="filingStatus"]')?.disabled),
      people: document.querySelectorAll('[data-person-owner]').length,
    }));
    if(otherFamilyBefore.filingStatus !== 'single'
      || !otherFamilyBefore.filingDisabled
      || otherFamilyBefore.people !== 1){
      throw new Error(`read-only single household Family state is wrong: ${JSON.stringify(otherFamilyBefore)}`);
    }
    await page.evaluate(() => {
      const filing = document.querySelector('[data-wizard-field="filingStatus"]');
      filing.value = 'marriedFilingJointly';
      filing.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await goToWizardStep(page, 'net-worth');
    await goToWizardStep(page, 'family');
    const otherFamilyAfter = await page.evaluate(() => ({
      filingStatus: document.querySelector('[data-wizard-field="filingStatus"]')?.value || '',
      people: document.querySelectorAll('[data-person-owner]').length,
    }));
    if(otherFamilyAfter.filingStatus !== 'single' || otherFamilyAfter.people !== 1){
      throw new Error(`read-only filing-status edit added a co-client: ${JSON.stringify(otherFamilyAfter)}`);
    }
    await assertPinned('co-client filing status');
    await assertBytesUnchanged('co-client filing status');

    const beforeFuture = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => {
      const sel = document.querySelector('#hh-switch');
      sel.value = 'future-household';
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    });
    await waitForWizard(page, {
      afterRevision: beforeFuture,
      householdId: 'future-household',
    });
    await assertPinned('switch to Future');
    await assertBytesUnchanged('switch to Future');

    await stableReload({ waitUntil:'networkidle2', timeout:20000 });
    await waitForUnselectedWizard(page);
    await assertPinned('read-only reload');
    await assertBytesUnchanged('read-only reload');
    await page.removeScriptToEvaluateOnNewDocument(readOnlyStorageHook.identifier);
  });

  await step('persistence: user-created households can be explicitly deleted', async () => {
    await page.evaluate(() => localStorage.clear());
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);

    await page.select('#hh-switch', 'now-household');
    await waitForWizard(page, { householdId: 'now-household' });
    if(await page.$eval('#hh-menu-pop', menu => menu.hidden)) await stableClick('#hh-menu-btn');
    const shippedDelete = await page.evaluate(() => ({
      disabled: Boolean(document.querySelector('#hh-delete')?.disabled),
      ariaDisabled: document.querySelector('#hh-delete')?.getAttribute('aria-disabled'),
    }));
    if(!shippedDelete.disabled || shippedDelete.ariaDisabled !== 'true'){
      throw new Error(`shipped household delete action is not protected: ${JSON.stringify(shippedDelete)}`);
    }

    await stableClick('#hh-new');
    await page.waitForFunction(() => {
      const id = localStorage.getItem('parallax.activeHouseholdId');
      return id
        && Boolean(JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id])
        && localStorage.getItem(`parallax.scenarios.${id}.v1`) !== null;
    }, { timeout: 15000 });
    const before = await page.evaluate(() => {
      const id = localStorage.getItem('parallax.activeHouseholdId');
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return {
        id,
        shippedBytes: JSON.stringify(db?.['now-household']),
        scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`),
      };
    });
    if(!before.id || !before.scenarioBytes) throw new Error(`custom household delete fixture was not persisted: ${JSON.stringify(before)}`);

    if(await page.$eval('#hh-menu-pop', menu => menu.hidden)) await stableClick('#hh-menu-btn');
    const customDelete = await page.evaluate(() => ({
      disabled: Boolean(document.querySelector('#hh-delete')?.disabled),
      ariaDisabled: document.querySelector('#hh-delete')?.getAttribute('aria-disabled'),
    }));
    if(customDelete.disabled || customDelete.ariaDisabled !== 'false'){
      throw new Error(`custom household delete action is unavailable: ${JSON.stringify(customDelete)}`);
    }

    await page.evaluate(() => {
      const originalSetItem = Storage.prototype.setItem;
      let databaseCommitFailed = false;
      window.__deleteHouseholdWriteCalls = 0;
      Storage.prototype.setItem = function(key, value){
        window.__deleteHouseholdWriteCalls += 1;
        if(key === 'parallax.households.v1' && !databaseCommitFailed){
          databaseCommitFailed = true;
          throw new Error('forced delete database commit failure');
        }
        if(key === 'parallax.activeHouseholdId' && databaseCommitFailed){
          throw new Error('forced delete rollback failure');
        }
        return originalSetItem.call(this, key, value);
      };
    });
    page.once('dialog', dialog => dialog.accept());
    await stableClick('#hh-delete');
    const blockedAfterRollback = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent.trim() || '',
      newDisabled: Boolean(document.querySelector('#hh-new')?.disabled),
      deleteDisabled: Boolean(document.querySelector('#hh-delete')?.disabled),
      runDisabled: Boolean(document.querySelector('#run-btn')?.disabled),
      enabledFields: document.querySelectorAll(
        '#hh-view input:not(:disabled), #hh-view select:not(:disabled), #hh-view textarea:not(:disabled)',
      ).length,
      writes: window.__deleteHouseholdWriteCalls,
    }));
    await page.evaluate(() => {
      document.querySelector('#hh-new')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('[data-wizard-field="primaryName"]')
        ?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const writesAfterBlockedActions = await page.evaluate(() => window.__deleteHouseholdWriteCalls);
    if(blockedAfterRollback.status !== 'Household could not be deleted and related data could not be restored · reload before continuing'
        || !blockedAfterRollback.newDisabled
        || !blockedAfterRollback.deleteDisabled
        || !blockedAfterRollback.runDisabled
        || blockedAfterRollback.enabledFields
        || writesAfterBlockedActions !== blockedAfterRollback.writes){
      throw new Error(`failed deletion rollback did not block later writes: ${JSON.stringify({ blockedAfterRollback, writesAfterBlockedActions })}`);
    }

    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForUnselectedWizard(page);
    await page.select('#hh-switch', before.id);
    await waitForWizard(page, { householdId: before.id });
    if(await page.$eval('#hh-menu-pop', menu => menu.hidden)) await stableClick('#hh-menu-btn');

    page.once('dialog', dialog => dialog.dismiss());
    await stableClick('#hh-delete');
    const afterCancel = await page.evaluate(id => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      exists: Boolean(JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.[id]),
      scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`),
    }), before.id);
    if(afterCancel.active !== before.id || !afterCancel.exists || afterCancel.scenarioBytes !== before.scenarioBytes){
      throw new Error(`cancelled delete changed persisted state: ${JSON.stringify(afterCancel)}`);
    }

    page.once('dialog', dialog => dialog.accept());
    await stableClick('#hh-delete');
    await waitForUnselectedWizard(page);
    const afterDelete = await page.evaluate(id => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return {
        deletedExists: Boolean(db?.[id]),
        active: localStorage.getItem('parallax.activeHouseholdId'),
        scenario: localStorage.getItem(`parallax.scenarios.${id}.v1`),
        selected: document.querySelector('#hh-switch')?.value || '',
        householdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId || '',
        screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
        shippedBytes: JSON.stringify(db?.['now-household']),
        status: document.querySelector('#status')?.textContent.trim() || '',
      };
    }, before.id);
    if(afterDelete.deletedExists
        || afterDelete.active !== null
        || afterDelete.scenario !== null
        || afterDelete.selected
        || afterDelete.householdId
        || afterDelete.screenCount !== 0
        || afterDelete.shippedBytes !== before.shippedBytes
        || afterDelete.status !== 'Household deleted'){
      throw new Error(`household deletion contract failed: ${JSON.stringify(afterDelete)}`);
    }
  });

  if(errs.length){
    console.error('PAGE/CONSOLE ERRORS:');
    errs.forEach(e => console.error('  ' + e));
    throw new Error(`${errs.length} page/console error(s) — verify must fail on application errors`);
  }

  await browser.close();
  console.log(`\nOK verify passed - screenshots in ${OUT}`);
} finally {
  await closeServer(srv);
}

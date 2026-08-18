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
import {
  goToWizardStep,
  openNetWorthCategory,
  runWizardBrowserContract,
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
  const deadline = Date.now() + ms;
  while(Date.now() < deadline){
    const n = await page.evaluate(() => document.querySelectorAll('#scn-view .cf-row').length);
    if(n >= min) return n;
    await new Promise(r => setTimeout(r, 250));
  }
  return page.evaluate(() => document.querySelectorAll('#scn-view .cf-row').length);
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

  await step('load index.html', async () => {
    // Deterministic seed: households + scenarios persist to localStorage, so a
    // stale browser store would silently replace the demo seed (Baseline 66 /
    // Scenario B 68 / Aggressive risk 5) and make the per-scenario assertions
    // flaky. Clear ALL storage and reload so every run boots a fresh Demo
    // Household via bootstrapHouseholds() → demoScenarios().
    await stableGoto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
    const firstRun = await page.evaluate(() => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    }));
    const blank = firstRun.db?.demo;
    if(firstRun.active !== 'demo' || !blank) throw new Error('first run did not create the blank demo slot');
    if(blank.meta?.name !== 'Demo Household' || blank.meta?.isDemo !== true) throw new Error('blank demo metadata is wrong');
    if(blank.meta?.primaryName || blank.household?.spouse || blank.income?.socialSecurity?.primary?.pia !== null || blank.income?.socialSecurity?.primary?.claimAge !== 67)
      throw new Error(`first-run demo contains fictional values: ${JSON.stringify(blank)}`);

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
  });

  await step('Tax wizard: Wages flow through to Withdrawal Planner tax dollars', async () => {
    await page.setViewport({ width:1440, height:900, deviceScaleFactor:1 });
    await stableClick('.htab[data-page="tax-buckets"]');
    await page.waitForFunction(() => {
      const wages = document.querySelector('[data-taw-fact-wages]')?.textContent.trim();
      const incomeTax = document.querySelector('[data-taw-col="ord"] .taw-col-edge span')
        ?.textContent.trim();
      return wages === '$0' && incomeTax === '$0';
    }, { timeout: 15000 });

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
    await page.keyboard.type('50000');
    // Moving focus through Chromium exercises the production input, change, and
    // blur path instead of assigning a value or dispatching a synthetic event.
    await page.keyboard.press('Tab');
    await waitForWizard(page, {
      step: 'tax',
      afterRevision: beforeEdit.revision,
    });
    const committedWages = await page.$eval(wageSelector, input => input.value);
    if(committedWages !== '50000'){
      throw new Error(`Tax wizard did not commit Wages through change/blur: ${JSON.stringify({ committedWages })}`);
    }

    await stableClick('.htab[data-page="tax-buckets"]');
    await page.waitForFunction(() => {
      const wages = document.querySelector('[data-taw-fact-wages]')?.textContent.trim();
      const incomeTax = document.querySelector('[data-taw-col="ord"] .taw-col-edge span')
        ?.textContent.trim();
      return wages === '$50,000' && incomeTax === '$3,820';
    }, { timeout: 15000 });
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
      const demoWages = (db?.demo?.income?.other || []).filter(row =>
        row?.typeId === 'wages' && row?.owner === 'client');
      return {
        active,
        rootHouseholdId: document.querySelector('[data-hh-wizard-root]')
          ?.dataset.householdId || '',
        runtimeSourceHouseholdId: record?.meta?.runtimeSourceHouseholdId || '',
        wages,
        demoWageCount: demoWages.length,
        optionCount: [...document.querySelectorAll('#hh-switch option')]
          .filter(option => option.value === active).length,
      };
    });
    if(!savedRuntimeEdit.active
        || savedRuntimeEdit.active === 'demo'
        || savedRuntimeEdit.rootHouseholdId !== savedRuntimeEdit.active
        || savedRuntimeEdit.runtimeSourceHouseholdId !== 'demo'
        || savedRuntimeEdit.wages.length !== 1
        || savedRuntimeEdit.wages[0]?.amount !== 50000
        || savedRuntimeEdit.demoWageCount !== 0
        || savedRuntimeEdit.optionCount !== 1){
      throw new Error(`Runtime-template wages did not persist as one durable household: ${JSON.stringify(savedRuntimeEdit)}`);
    }
    await waitForWizard(page, { householdId: savedRuntimeEdit.active });
    await goToWizardStep(page, 'family');
    await stableClick('#hh-menu-btn');
    await stableClick('#hh-new');
    await page.waitForFunction(() => {
      const selected = document.querySelector('#hh-switch')?.value;
      return selected && selected !== 'demo'
        && document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === selected;
    }, { timeout: 10000 });
    withdrawalPlannerFixtureHouseholdId = await page.$eval('#hh-switch', selector => selector.value);
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

    await goToWizardStep(page, 'family');
    await typeAndBlur(
      '[data-wizard-field="primaryName"]',
      fixture.family.primaryName,
    );
    const [birthYear, birthMonth, birthDay] = fixture.family.birthDate.split('-');
    await typeAndBlur(
      '[data-birth-date-group="client"] [data-birth-part="month"]',
      Number(birthMonth),
      { waitForRender: false },
    );
    await typeAndBlur(
      '[data-birth-date-group="client"] [data-birth-part="day"]',
      Number(birthDay),
      { waitForRender: false },
    );
    await typeAndBlur(
      '[data-birth-date-group="client"] [data-birth-part="year"]',
      Number(birthYear),
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

    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
    await page.select('#hh-switch', fixture.householdId);
    await waitForWizard(page, { householdId: fixture.householdId });
  });

  await step('Tax Buckets: production household loads with funded limits and live tax output', async () => {
    await page.setViewport({ width:1440, height:900, deviceScaleFactor:1 });
    await stableClick('.htab[data-page="tax-buckets"]');
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-taw-root]');
      const cols = document.querySelectorAll('.taw-col');
      return !!root && cols.length === 4;
    }, { timeout: 15000 });
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

    await page.waitForFunction(
      () => document.querySelector('[data-taw-federal-tax]')?.textContent.trim() !== '\u2014',
      { timeout: 15000 },
    );
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
      const columns = Object.fromEntries(['ord', 'ltcg', 'irmaa', 'ss'].map(id => {
        const column = document.querySelector(`[data-taw-col="${id}"]`);
        const base = column?.querySelector('.taw-col-base');
        const fill = column?.querySelector('.taw-col-fill');
        const gap = column?.querySelector('.taw-col-gap');
        return [id, {
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
      if(
        after.federalTax === '\u2014'
        || after.effectiveRate === '\u2014'
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
      selectableIds[0] !== 'demo'
      || defaultIds.some(id => !selectableIds.includes(id))
      || !selectableIds.includes(withdrawalPlannerFixtureHouseholdId)
    ){
      throw new Error(`production default household selector is incomplete: ${JSON.stringify({ selectableIds, defaultIds })}`);
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
        }, { timeout: 15000 }, householdId);
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
    ), { timeout:15000 }, withdrawalPlannerFixtureHouseholdId);
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
      plan.portfolio.accounts = {
        taxable: { balance: 0, basisPct: 1 },
        traditional: { balance: 0 },
        roth: { balance: 0 },
      };
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
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await page.click('.htab[data-sub-target="goals"]');
    await sleep(450);
    const m = await page.evaluate(() => {
      const pageRoot = document.querySelector('.gh-page');
      const text = (pageRoot?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        page: !!pageRoot,
        card: !!document.querySelector('.gh-card'),
        title: document.querySelector('.gh-title')?.textContent.trim() || '',
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
    if(m.title !== 'Retirement Lifestyle') throw new Error(`Goals Horizon title wrong: "${m.title}"`);
    if(m.lanes < 1 || m.chips !== m.lanes || m.marks !== m.lanes)
      throw new Error(`Goals Horizon lanes incomplete (${JSON.stringify(m)})`);
    if(m.ticks < 5 || !m.add) throw new Error(`Goals Horizon axis/add control incomplete (${JSON.stringify(m)})`);
    if(m.lifetime) throw new Error('Goals Horizon must not render Lifetime goal spend');
    if(m.legacy) throw new Error('retired Goals implementation still renders');
    if(m.overflow > 2) throw new Error(`Goals Horizon caused ${m.overflow}px document overflow`);
    await page.screenshot({ path: join(OUT, '02-goals.png'), fullPage: true });
  });

  await step('goals Horizon: add, edit, cadence, timing, category, duplicate, delete, undo', async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await stableClick('.htab[data-page="household"]');
    await waitForWizard(page, { householdId: 'demo' });
    await stableClick('#hh-menu-btn');
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
    await page.click('.htab[data-sub-target="goals"]');
    await sleep(300);
    const before = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
    await page.click('.gh-add-toggle');
    await sleep(150);
    const starters = await page.evaluate(() => document.querySelectorAll('.gh-starter').length);
    if(starters !== 8) throw new Error(`expected 8 goal starters, got ${starters}`);
    await page.click('.gh-starter[data-add-category="travel"]');
    await sleep(450);
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
    await page.evaluate(() => {
      const el = document.querySelector('.gh-amount-input');
      el.value = '24000';
      el.dispatchEvent(new Event('input', { bubbles:true }));
    });
    await sleep(150);
    m = await page.evaluate(() => ({
      railName: document.querySelector('.gh-name-input')?.value,
      chipName: [...document.querySelectorAll('.gh-chip__name')].some(el => el.textContent === 'European summers'),
      amount: document.querySelector('.gh-amount-input')?.value,
      chipAmount: [...document.querySelectorAll('.gh-chip__amount')].find(el => el.closest('.gh-chip')?.querySelector('.gh-chip__name')?.textContent === 'European summers')?.textContent,
    }));
    if(m.railName !== 'European summers' || !m.chipName || m.amount !== '24,000' || !/24k/.test(m.chipAmount || ''))
      throw new Error(`live goal editing failed (${JSON.stringify(m)})`);

    await page.click('[data-action="per-month"]'); await sleep(250);
    m = await page.evaluate(() => ({
      amount: document.querySelector('.gh-amount-input')?.value,
      monthly: document.querySelector('[data-action="per-month"]')?.classList.contains('is-selected'),
    }));
    if(m.amount !== '2,000' || !m.monthly) throw new Error(`monthly cadence conversion failed (${JSON.stringify(m)})`);
    await page.click('[data-action="kind-once"]'); await sleep(250);
    if(!await page.evaluate(() => !!document.querySelector('[data-field="once-age"]')))
      throw new Error('one-time cadence did not expose a single age control');
    await page.click('[data-action="kind-rec"]'); await sleep(250);
    if(!await page.evaluate(() => !!document.querySelector('[data-field="start-age"]') && !!document.querySelector('[data-field="end-age"]')))
      throw new Error('recurring cadence did not restore a range');
    await page.click('[data-action="preset"][data-preset="later"]'); await sleep(250);
    m = await page.evaluate(() => ({
      start: document.querySelector('[data-field="start-age"]')?.value,
      end: document.querySelector('[data-field="end-age"]')?.value,
    }));
    if(!m.start || !m.end || +m.start >= +m.end) throw new Error(`later preset produced an invalid range (${JSON.stringify(m)})`);
    await page.click('[data-action="category"][data-category="home"]'); await sleep(250);
    if(!await page.evaluate(() => {
      const src = document.querySelector('.gh-rail__icon img')?.getAttribute('src');
      if(!src) return false;
      const iconUrl = new URL(src, location.href);
      const artifactId = new URL(location.href).searchParams.get('v');
      return iconUrl.pathname.endsWith('/assets/goals-horizon/home.svg')
        && iconUrl.searchParams.get('v') === artifactId;
    }))
      throw new Error('category change did not update the source icon');

    const beforeDuplicate = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
    await page.click('[data-action="duplicate"]'); await sleep(350);
    m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      name: document.querySelector('.gh-name-input')?.value || '',
    }));
    if(m.lanes !== beforeDuplicate + 1 || !m.name.endsWith(' copy'))
      throw new Error(`duplicate failed (${JSON.stringify(m)})`);
    await page.click('[data-action="delete"]'); await sleep(350);
    m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      toast: document.querySelector('.gh-toast')?.textContent || '',
    }));
    if(m.lanes !== beforeDuplicate || !/Undo/.test(m.toast)) throw new Error(`delete/toast failed (${JSON.stringify(m)})`);
    await page.click('[data-action="undo"]'); await sleep(350);
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
    let revision = await page.$eval(
      '[data-hh-wizard-root]',
      root => Number(root.dataset.renderRevision || -1),
    );
    await stableClick('[data-wizard-field="filingStatus"]');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await waitForWizard(page, { step: 'family', afterRevision: revision });

    const typeFamilyValue = async (selector, value, { waitForRender = true } = {}) => {
      const before = await page.$eval(
        '[data-hh-wizard-root]',
        root => Number(root.dataset.renderRevision || -1),
      );
      await stableClick(selector);
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.type(String(value));
      await page.keyboard.press('Tab');
      if(waitForRender){
        await waitForWizard(page, { step: 'family', afterRevision: before });
      }
    };
    await typeFamilyValue(
      '[data-birth-date-group="spouse"] [data-birth-part="month"]',
      1,
      { waitForRender: false },
    );
    await typeFamilyValue(
      '[data-birth-date-group="spouse"] [data-birth-part="day"]',
      15,
      { waitForRender: false },
    );
    await typeFamilyValue(
      '[data-birth-date-group="spouse"] [data-birth-part="year"]',
      1963,
    );
    await typeFamilyValue('[data-wizard-field="spouse.retirementAge"]', 68);

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

    const laneCount = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
    await stableClick('button[data-page="scenarios"]');
    await page.waitForSelector('#scn-view', { visible: true, timeout: 15000 });
    await page.click('#scn-seg-compare');
    try{
      await page.waitForFunction(expected => {
        const toggle = document.querySelector('#scn-view [data-goals-toggle]');
        const names = document.querySelectorAll('#scn-view .goal-detail__name');
        const inputs = document.querySelectorAll('#scn-view .cmp-goal-in');
        const medians = [...document.querySelectorAll('#scn-view .scol__median b')]
          .map(element => element.textContent.trim());
        return toggle?.getAttribute('aria-expanded') === 'true'
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
      throw new Error(`retirement-relative goal contract is incomplete: ${JSON.stringify(contract)}`);
    }
    contract.rows.forEach(row => {
      if(row.cells.length !== scenarioCount
          || !row.baseMeta?.includes(`age ${row.cells[0].value}`)
          || row.cells.some(cell => Number(cell.value) !== contract.retirementAges[cell.scnId] + 3)){
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
      }, { timeout: 10000 }, { selector, editedAge });
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
      return id && id !== 'demo' && Boolean(db?.[id]);
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
        || JSON.stringify(m.amounts) !== JSON.stringify(['$0 / yr', '$6k / yr'])
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
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await waitForWizard(page, {
      householdId: withdrawalPlannerFixtureHouseholdId,
    });
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
    await new Promise(r => setTimeout(r, 900));
    await page.click('#scn-seg-compare');
    await new Promise(r => setTimeout(r, 400));
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
    if(!m.solveBtn || !m.addBtn) throw new Error('Solve / Add toolbar actions missing from Scenarios');
    if(m.suggestBtn) throw new Error('removed Suggest button is still present in the Scenarios toolbar');
    if(!m.segActive) throw new Error('Compare segment did not mark itself active');
    if(m.names.some(n => /sell\s*home/i.test(n))) throw new Error(`stale sale scenario visible: ${JSON.stringify(m.names)}`);

    // Compare is editable: discrete levers (ages, allocation) now show always-visible
    // .cmp-step-btn[data-scn-id] buttons; dollar levers show .cmp-lev-in type-in inputs.
    // Both carry data-scn-id. Step up then back so the baseline is left as found.
    const cmpStepBtns = await page.evaluate(() => document.querySelectorAll('#scn-view .compare .cmp-step-btn[data-scn-id]').length);
    const cmpInputs   = await page.evaluate(() => document.querySelectorAll('#scn-view .compare .cmp-lev-in[data-scn-id]').length);
    if(cmpStepBtns < 2 && cmpInputs < 1) throw new Error(`Compare lever controls missing (stepBtns=${cmpStepBtns}, inputs=${cmpInputs})`);
    await page.evaluate(() => document.querySelector('#scn-view .compare .cmp-step-btn[data-dir="1"][data-scn-id]')?.click());
    await new Promise(r => setTimeout(r, 250));
    const cmpStatus = await page.evaluate(() => document.querySelector('#status')?.textContent || '');
    if(!/Run to update/i.test(cmpStatus)) throw new Error(`Compare step button did not request a manual Run: "${cmpStatus}"`);
    await page.evaluate(() => document.querySelector('#scn-view .compare .cmp-step-btn[data-dir="-1"][data-scn-id]')?.click());
    await new Promise(r => setTimeout(r, 250));

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

    // A lever stepper mutates the focused scenario and asks for a manual Run
    // (existing production flow — no auto-run). Step up then back down so the
    // scenario's levers are left exactly as found (no Run fires, so s.res and the
    // baseline retirement marker the Cash Flow step checks stay consistent).
    await page.evaluate(() => document.querySelector('#scn-view .assum__stepper .stepper-btn[data-dir="1"]')?.click());
    await new Promise(r => setTimeout(r, 250));
    const status = await page.evaluate(() => document.querySelector('#status')?.textContent || '');
    if(!/Run to update/i.test(status)) throw new Error(`lever stepper did not request a manual Run: "${status}"`);
    await page.evaluate(() => document.querySelector('#scn-view .assum__stepper .stepper-btn[data-dir="-1"]')?.click());
    await new Promise(r => setTimeout(r, 250));
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

    const edited = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')];
      const input = inputs.at(-1);
      if(!input) return false;
      input.value = '45,000';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    if(!edited) throw new Error('fourth scenario savings input was not available');
    await page.waitForFunction(
      () => /Run to update/i.test(document.querySelector('#status')?.textContent || ''),
      { timeout: 8000 },
    );
    await page.click('#run-btn');
    await page.waitForFunction(() => {
      const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')]
        .map(element => element.textContent.trim());
      return probabilities.length === 4
        && probabilities.every(value => /\d/.test(value))
        && /Plan updated/i.test(document.querySelector('#status')?.textContent || '');
    }, { timeout: 30000 });

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
    if(beforeReload.medians.length !== 4
        || beforeReload.medians.some(value => !/^\$[\d,.]+[KMB]?$/.test(value))
        || beforeReload.medians[3] === beforeReload.medians[0]
        || beforeReload.savings[3] !== '45000'
        || beforeReload.spending[3] !== beforeReload.spending[0]
        || beforeReload.savedSavings !== 45000){
      throw new Error(`zero-base savings did not reach the fourth scenario: ${JSON.stringify(beforeReload)}`);
    }

    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
    await stableClick('.htab[data-page="household"]');
    await stableClick('#hh-menu-btn');
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
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
    const afterReload = await page.evaluate(() => ({
        medians: [...document.querySelectorAll('#scn-view .scol__median b')]
          .map(element => element.textContent.trim()),
        spending: [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="spend"]')]
          .map(input => input.value.replace(/[^0-9.]/g, '')),
        errors: [...document.querySelectorAll('#scn-view .scol__prob')]
          .filter(element => !/\d/.test(element.textContent || '')).length,
      }));
    if(afterReload.errors !== 0
        || JSON.stringify(afterReload.medians) !== JSON.stringify(beforeReload.medians)
        || JSON.stringify(afterReload.spending) !== JSON.stringify(beforeReload.spending)){
      throw new Error(`saved scenarios changed or blanked after reload: ${JSON.stringify({ beforeReload, afterReload })}`);
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
      household.portfolio.accounts = {
        taxable: { balance: 50000000, basisPct: 1 },
        traditional: { balance: 0 },
        roth: { balance: 0 },
      };
      household.portfolio.extraAccounts = [];
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.removeItem(`parallax.scenarios.${householdId}.v1`);
    }, withdrawalPlannerFixtureHouseholdId);
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
    await stableClick('.htab[data-page="household"]');
    await stableClick('#hh-menu-btn');
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
    await page.click('.htab[data-sub-target="goals"]');
    await page.waitForSelector('.gh-page', { visible: true, timeout: 8000 });
    const horizon = await page.evaluate(() => ({
      terminalTick: [...document.querySelectorAll('.gh-tick')].at(-1)?.textContent.trim() || '',
      axisMax: document.querySelector('.gh-lanes')?.getAttribute('data-axis-max') || '',
    }));
    if(horizon.terminalTick !== '100' || horizon.axisMax !== '101'){
      throw new Error(`entered planning age did not cap the Goals horizon: ${JSON.stringify(horizon)}`);
    }
    await page.click('#run-btn');
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
    await waitForWizard(page, { householdId: 'demo' });
    await stableClick('.htab[data-page="household"]');
    await stableClick('#hh-menu-btn');
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
    await page.click('#run-btn');
    for(let i = 0; i < 60; i++){
      await new Promise(r => setTimeout(r, 500));
      const status = await page.evaluate(() => document.querySelector('#status')?.textContent || '');
      if(/Plan updated|Partial run/i.test(status)) break;
    }

    await page.click('button[data-page="scenarios"]');
    await new Promise(r => setTimeout(r, 600));
    await setCashFlow(page, true);
    await waitCashRows(page, 10);
    const EXPECT = ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'];
    const m = await page.evaluate(() => {
      const v = document.querySelector('#scn-view');
      return {
        cf: !!v?.querySelector('.cf'),
        rows: v?.querySelectorAll('.cf-row').length || 0,
        cols: [...(v?.querySelectorAll('.cf-table__head .cf-th') || [])].map(th => th.textContent.trim()),
        pills: [...(v?.querySelectorAll('.cf-pill') || [])].map(p => p.textContent.trim()),
        activePill: v?.querySelector('.cf-pill.is-active')?.textContent.trim() || '',
        stats: [...(v?.querySelectorAll('.cf-stat__label') || [])].map(s => s.textContent.trim()),
        pathControls: !!v?.querySelector('#scn-cf-path-controls #path-mode'),
        mode: v?.querySelector('#scn-cf-path-controls #path-mode')?.value || '',
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
        taxDisclosure: (() => {
          const el = v?.querySelector('[data-tax-disclosure]');
          return el ? {
            state: el.dataset.taxState || '',
            scope: el.querySelector('[data-tax-scope-disclosure]')?.textContent.trim() || '',
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
      };
    });
    if(!m.cf) throw new Error('cash-flow view did not render');
    if(m.rows < 10) throw new Error(`cash-flow rows = ${m.rows} (expected >=10)`);
    if(JSON.stringify(m.cols) !== JSON.stringify(EXPECT)) throw new Error(`cash-flow columns are not the exact contract: ${JSON.stringify(m.cols)}`);
    if(m.cols.filter(c => /tax/i.test(c)).length !== 1) throw new Error(`cash flow must have exactly one scoped tax column: ${JSON.stringify(m.cols)}`);
    if(m.taxHeader?.source !== 'federal-converged-row' || m.taxHeader?.scope !== 'MODELED_FEDERAL_LINE_24') throw new Error(`typical path converged tax scope missing: ${JSON.stringify(m.taxHeader)}`);
    if(!/retirement rows funded and converged; working years reporting-only/i.test(m.taxHeader?.title || '')) throw new Error(`typical path tax tooltip missing phase scope: ${JSON.stringify(m.taxHeader)}`);
    if(m.taxCompare) throw new Error(`obsolete federal-vs-engine comparison is still shown: ${JSON.stringify(m.taxCompare)}`);
    if(m.taxDisclosure?.state !== 'federal-converged-row' || !/retirement rows funded and converged, working years reporting-only/i.test(m.taxDisclosure?.scope || '')) throw new Error(`typical path converged federal scope disclosure missing: ${JSON.stringify(m.taxDisclosure)}`);
    if(m.taxDisclosure?.fallback) throw new Error(`typical path unexpectedly uses engine fallback: ${JSON.stringify(m.taxDisclosure)}`);
    if(!/^\$[\d,]+/.test(m.accumTax)) throw new Error(`accumulation-year Tax cell is not populated: "${m.accumTax}"`);
    if(m.cols.some(c => ['Withdraw', 'One-time', 'Return $', 'Starting value', 'Inflows', 'Outflows', 'Annual return', 'Ending value'].includes(c))) throw new Error(`old cash-flow columns still present: ${JSON.stringify(m.cols)}`);
    if(m.pills.length < 2) throw new Error(`scenario pills missing: ${JSON.stringify(m.pills)}`);
    if(!SKIP_SEQUENCING && !m.pathControls) throw new Error('path-replay controls not relocated into #scn-cf-path-controls');
    if(!SKIP_SEQUENCING && m.mode !== 'typical') throw new Error(`path replay default mode not typical (${m.mode})`);
    for(const label of ['Median Ending', 'Peak Withdrawal']){
      if(!m.stats.includes(label)) throw new Error(`cash-flow summary stat missing: ${label} (${JSON.stringify(m.stats)})`);
    }
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
    const rmdAge = await page.evaluate(() => {
      const row = document.querySelector('#scn-view .cf-row__mark-dot--rmd')?.closest('.cf-row');
      return row ? (row.querySelector('.cf-cell--age')?.textContent.trim() || '') : '';
    });
    if(rmdAge !== '73') throw new Error(`RMD start marker not at age 73 (got "${rmdAge}")`);

    // The scenario pills switch which plan's cash flow is shown, and each plan's
    // cash flow reflects ITS OWN retire age. demoScenarios seeds Baseline at the
    // household retire age (66 here, asserted just above) and Scenario B at
    // +2 years (68), so selecting the Scenario B pill must move the first
    // retirement-spending row from 66 to 68.
    const pickedB = await page.evaluate(() => {
      const pill = [...document.querySelectorAll('#scn-view .cf-pill')].find(p => /Scenario B/.test(p.textContent));
      if(!pill) return false;
      pill.click();
      return true;
    });
    if(!pickedB) throw new Error(`Scenario B pill not found among ${JSON.stringify(m.pills)}`);
    await new Promise(r => setTimeout(r, 450));
    await waitCashRows(page, 10);
    const bActive = await page.evaluate(() => document.querySelector('#scn-view .cf-pill.is-active')?.textContent.trim() || '');
    if(!/Scenario B/.test(bActive)) throw new Error(`cash-flow pill did not switch to Scenario B (got "${bActive}")`);
    const bMarker = await retirementStartAge();
    if(bMarker !== '68') throw new Error(`Scenario B retirement start not at age 68 (got "${bMarker}")`);
    // Restore Baseline for the path-replay checks below.
    await page.evaluate(() => [...document.querySelectorAll('#scn-view .cf-pill')].find(p => /Baseline/.test(p.textContent))?.click());
    await new Promise(r => setTimeout(r, 350));
    await waitCashRows(page, 10);

    if(!SKIP_SEQUENCING){
      // Path replay: named modes only. The advanced Path # / Seed inputs were
      // removed from the header — assert they stay gone. (#path-mode is the
      // production node relocated into the Cash Flow header — same element, same
      // bindings.)
      const advanced = await page.evaluate(() => ({
        chooseOpt: [...document.querySelectorAll('#path-mode option')].some(o => o.value === 'choose'),
        indexInput: !!document.querySelector('#path-index'),
        seedInput: !!document.querySelector('#path-seed'),
      }));
      if(advanced.chooseOpt || advanced.indexInput || advanced.seedInput) throw new Error(`removed path #/seed controls still present: ${JSON.stringify(advanced)}`);
      const availableModes = await page.evaluate(() => [...document.querySelectorAll('#path-mode option')].map(o => o.value));
      for(const mode of ['stressed', 'favorable']){
        if(!availableModes.includes(mode)) throw new Error(`${mode} option missing from path-mode select`);
        await page.select('#path-mode', mode);
        await new Promise(r => setTimeout(r, 400));
        if(await waitCashRows(page, 10) < 10) throw new Error(`${mode} path emptied the cash-flow table`);
        const federalPath = await page.evaluate(() => {
          const th = document.querySelector('#scn-view .cf-table__head .cf-th[data-tax-source]');
          const compare = document.querySelector('#scn-view [data-tax-compare]');
          const disclosure = document.querySelector('#scn-view [data-tax-disclosure]');
          return {
            mode: document.querySelector('#path-mode')?.value || '',
            header: th ? {
              label: th.textContent.trim(),
              source: th.dataset.taxSource || '',
              scope: th.dataset.taxScope || '',
            } : null,
            compare: compare ? {
              path: compare.dataset.taxPath || '',
              federalTotal: Number(compare.dataset.federalTotal),
              enginePathTotal: Number(compare.dataset.enginePathTotal),
              delta: Number(compare.dataset.delta),
            } : null,
            disclosure: disclosure ? {
              state: disclosure.dataset.taxState || '',
              scope: disclosure.querySelector('[data-tax-scope-disclosure]')?.textContent.trim() || '',
            } : null,
          };
        });
        if(federalPath.mode !== mode) throw new Error(`${mode} path mode did not stay selected: ${JSON.stringify(federalPath)}`);
        if(federalPath.header?.label !== 'Tax' || federalPath.header?.source !== 'federal-converged-row' || federalPath.header?.scope !== 'MODELED_FEDERAL_LINE_24') throw new Error(`${mode} path tax scope is not converged federal: ${JSON.stringify(federalPath)}`);
        if(federalPath.compare) throw new Error(`${mode} path still shows an obsolete sidecar comparison: ${JSON.stringify(federalPath)}`);
        if(federalPath.disclosure?.state !== 'federal-converged-row' || !/retirement rows funded and converged, working years reporting-only/i.test(federalPath.disclosure?.scope || '')) throw new Error(`${mode} converged federal scope disclosure missing: ${JSON.stringify(federalPath)}`);
        await new Promise(r => setTimeout(r, 700));
        await page.screenshot({ path: join(OUT, `04-cashflow-${mode}.png`), fullPage: true });
      }
      await page.select('#path-mode', 'typical');
      await new Promise(r => setTimeout(r, 300));
      const restoredTaxHeader = await page.evaluate(() => {
        const th = document.querySelector('#scn-view .cf-table__head .cf-th[data-tax-source]');
        return th ? { label: th.textContent.trim(), source: th.dataset.taxSource || '' } : null;
      });
      if(restoredTaxHeader?.label !== 'Tax' || restoredTaxHeader?.source !== 'federal-converged-row') throw new Error(`typical path tax scope did not restore: ${JSON.stringify(restoredTaxHeader)}`);
      if(await page.evaluate(() => !!document.querySelector('#scn-view [data-tax-compare]'))) throw new Error('obsolete federal-vs-engine summary restored on typical path');
      if(!await page.evaluate(() => /retirement rows funded and converged, working years reporting-only/i.test(document.querySelector('#scn-view [data-tax-scope-disclosure]')?.textContent || ''))) throw new Error('readable phase-scoped federal disclosure did not restore on typical path');
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

  // Objective theme contract: the page BACKGROUND (not just foreground tokens) must be
  // the shared charcoal/champagne --page-bg on Scenarios, Goals, Sequencing, AND the
  // Household console — the whole app now reads as one charcoal surface (floor #0b0d11)
  // with a champagne accent. The retired Household warm bronze AND the old navy
  // (#111E31 = 17,30,49) must BOTH be gone everywhere. Computed-style assertions so a
  // navy/bronze regression fails loudly instead of relying on a human reading a screenshot.
  await step('visual contract: flush 56px header rail and tabs are correct', async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await page.click('button[data-page="scenarios"]'); await sleep(400);
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
        borderBottom: cs.borderBottomWidth,
        logo: logo?.getAttribute('src') || '',
        logoH: logo ? getComputedStyle(logo).height : '',
        runBg: getComputedStyle(document.querySelector('.run-btn')).backgroundColor,
        runColor: getComputedStyle(document.querySelector('.run-btn')).color,
        tabAfterBg: tabAfter?.backgroundColor || '',
      };
    });
    if(!hdr) throw new Error('Header element missing');
    if(hdr.height !== '56px') throw new Error(`Header height must be 56px, got ${hdr.height}`);
    if(hdr.borderBottom !== '1px') throw new Error(`Header must have 1px bottom hairline, got ${hdr.borderBottom}`);
    if(!hdr.logo.includes('parallax-logo.png')) throw new Error(`Header logo must use parallax-logo.png, got ${hdr.logo}`);
    if(hdr.logoH !== '48px') throw new Error(`Logo must be 48px tall, got ${hdr.logoH}`);
    if(hdr.bg !== 'rgba(0, 0, 0, 0)' && hdr.bg !== 'transparent')
      throw new Error(`Header must be flush/transparent, got ${hdr.bg}`);
    if(hdr.runBg !== 'rgba(0, 0, 0, 0)' && hdr.runBg !== 'transparent')
      throw new Error(`Run button must be unboxed (transparent bg), got ${hdr.runBg}`);
    const [r,g,b] = (hdr.runColor.match(/\d+/g)||[]).map(Number);
    if(!(r > 180 && g > 130 && b < 140)) throw new Error(`Run button text must be champagne: ${hdr.runColor}`);
    const [ar,ag,ab] = (hdr.tabAfterBg.match(/\d+/g)||[]).map(Number);
    if(!(ar > 180 && ag > 130 && ab < 140)) throw new Error(`Active tab underline must be champagne: ${hdr.tabAfterBg}`);
  });
  await step('theme: product pages sit on the shared charcoal background', async () => {
    const CHARCOAL = '11, 13, 17';  // #0b0d11 — shared --page-bg gradient floor (scenarios + household)
    const NAVY = '17, 30, 49';      // #111E31 — retired Scenarios navy base, must be gone
    const BRONZE = '154, 102, 56';  // the retired Household warm background — must be gone
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const bgOf = sel => page.evaluate(s => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).backgroundImage : '(no element)';
    }, sel);

    await page.click('button[data-page="scenarios"]'); await sleep(500);
    const scnBg = await bgOf('.page[data-page="scenarios"]');
    if(!scnBg.includes(CHARCOAL)) throw new Error(`Scenarios page lost its charcoal --page-bg: ${scnBg}`);
    if(scnBg.includes(NAVY)) throw new Error(`Scenarios page still shows retired navy: ${scnBg}`);

    await page.click('.htab[data-sub-target="goals"]'); await sleep(600);
    // Goals mounts the Horizon card, with the retired ledger/chapters absent.
    if(!await page.evaluate(() => !!document.querySelector('#np-content .gh-card'))) throw new Error('Goals view did not mount .gh-card');
    const goalsBg = await bgOf('.page[data-page="net-worth"]');

    let seqBg = null;
    if(!SKIP_SEQUENCING){
      await page.click('button[data-page="sequencing"]'); await sleep(450);
      seqBg = await bgOf('.page[data-page="sequencing"]');
    }

    await page.click('.htab[data-page="household"]'); await sleep(500);
    const hhBg = await bgOf('.page[data-page="household"]');

    const surfaces = [['goals', goalsBg], ['household', hhBg]];
    if(seqBg !== null) surfaces.splice(1, 0, ['sequencing', seqBg]);
    for(const [name, bg] of surfaces){
      if(!bg.includes(CHARCOAL)) throw new Error(`${name} page is NOT on the shared charcoal background: ${bg}`);
      if(bg.includes(NAVY)) throw new Error(`${name} page still shows the retired navy background: ${bg}`);
      if(bg.includes(BRONZE)) throw new Error(`${name} page still shows the retired Household bronze background: ${bg}`);
    }
  });

  await step('retirement age lever goes inert once the household is already retired', async () => {
    const leverNames = () => stableEvaluate('read scenario lever names', () =>
      [...document.querySelectorAll('#scn-view .lever__name')].map(e => e.textContent.trim()));

    // Pre-retirement demo (Client 1 64/retire 66, Client 2 63/retire 65):
    // "Retirement Age" IS an active Scenarios lever.
    await stableClick('button[data-page="scenarios"]');
    await stableClick('#scn-seg-compare');
    await page.waitForSelector('#scn-view .lever__name', { timeout: 10000 });
    const beforeNames = await leverNames();
    if(!beforeNames.includes('Retirement Age'))
      throw new Error(`Retirement Age lever should be present while pre-retirement: ${JSON.stringify(beforeNames)}`);

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

    // Now "Retirement Age" must DROP OUT of the Scenarios levers (it is no longer
    // a decision to pull), while the other levers remain.
    await stableClick('button[data-page="scenarios"]');
    await stableClick('#scn-seg-compare');
    try{
      await page.waitForFunction(() => {
        const names = [...document.querySelectorAll('#scn-view .lever__name')]
          .map(element => element.textContent.trim());
        return names.includes('Allocation') && !names.includes('Retirement Age');
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
    if(afterNames.includes('Retirement Age'))
      throw new Error(`Retirement Age lever must disappear once already retired: ${JSON.stringify(afterNames)}`);
    if(!afterNames.includes('Allocation'))
      throw new Error(`other levers (Allocation) must remain when retired: ${JSON.stringify(afterNames)}`);

    // Restore the edited fields explicitly; Load Demo never resets saved data.
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
          taxable: { balance: 50000, basisPct: 1 },
          traditional: { balance: 0 },
          roth: { balance: 0 },
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
    await waitForWizard(page, { householdId: 'demo' });
    await stableClick('.htab[data-page="household"]');
    await stableClick('#hh-menu-btn');
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });

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
      await page.click('#run-btn');
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
      const probabilityCells = document.querySelectorAll('#scn-view .cf-summary__id .numeral');
      return {
        rows: rows.length,
        probabilityCells: probabilityCells.length,
        goalCells: goalCells.length,
        drawCells: drawCells.length,
        endingCells: endingCells.length,
        shortfallCells: shortfallCells.length,
        probability: Number.parseFloat(probabilityCells[0]?.textContent || ''),
        goal: parseMoney(goalCells[0]?.textContent),
        draw: parseMoney(drawCells[0]?.textContent),
        ending: endingCells[0]?.textContent.trim() || '',
        shortfall: shortfallCells[0]?.textContent.trim() || '',
        shortfallVisible: parseMoney(shortfallCells[0]?.textContent),
        shortfallAmount: Number(row?.dataset.fundingShortfall || 0),
      };
    });
    if(cashFlowTruth.rows !== 1
        || cashFlowTruth.probabilityCells !== 1
        || cashFlowTruth.goalCells !== 1
        || cashFlowTruth.drawCells !== 1
        || cashFlowTruth.endingCells !== 1
        || cashFlowTruth.shortfallCells !== 1
        || cashFlowTruth.probability !== 0
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

  await step('tax-funded probability is the only probability shown after Run', async () => {
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
          taxable: { balance: 0, basisPct: 1 },
          traditional: { balance: 400000 },
          roth: { balance: 0 },
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
    await waitForWizard(page, { householdId: 'demo' });
    await stableClick('.htab[data-page="household"]');
    await stableClick('#hh-menu-btn');
    await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
    await waitForWizard(page, { householdId: withdrawalPlannerFixtureHouseholdId });
    await sleep(1200);
    await page.waitForSelector('#run-btn:not([disabled])', { timeout: 10000 });
    await page.click('#run-btn');
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
    const cashFlowProb = await page.evaluate(() =>
      Number.parseFloat(document.querySelector('#scn-view .cf-summary__id .numeral')?.textContent || ''));
    if(cashFlowProb !== expected) throw new Error(`Cash Flow probability ${cashFlowProb} does not match tax-funded ${expected}`);
    await setCashFlow(page, false);
    await sleep(300);

    await page.click('#scn-solve');
    await page.waitForSelector('#sf-pct', { visible: true });
    const solverScope = await page.$eval('.solve-scope', el => el.textContent.trim());
    if(!/simplified tax estimate/i.test(solverScope) || !/recalculated with modeled federal tax/i.test(solverScope))
      throw new Error(`Solver tax scope disclosure missing: ${solverScope}`);
    const solverTarget = await page.$eval('#sf-pct', input => Number(input.value));
    const expectedTarget = Math.min(95, Math.ceil((expected + 1) / 5) * 5);
    const shortcutTarget = Math.min(95, Math.ceil((oldShortcut + 1) / 5) * 5);
    if(solverTarget !== expectedTarget)
      throw new Error(`Solver target ${solverTarget} does not derive from tax-funded ${expected} (expected ${expectedTarget})`);
    if(solverTarget === shortcutTarget)
      throw new Error(`Solver target still derives from shortcut-only probability ${oldShortcut}`);
  });

  // ── Multi-household persistence & bootstrapping ────────────────────────────
  // These run LAST (they clear storage and reload) so they can't disturb the
  // demo-coupled steps above. They prove the state-management contract:
  // first-load seeds a blank demo plus the shipped selectable defaults, saved
  // values survive reload, scenario storage is scoped by householdId, and Load
  // Demo can recreate a missing demo slot.
  await step('persistence: first load seeds blank Demo + shipped selectable defaults', async () => {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
    const s = await page.evaluate(() => ({
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
      active: localStorage.getItem('parallax.activeHouseholdId'),
    }));
    if(!s.db || typeof s.db !== 'object') throw new Error('households store not created on first load');
    if(!s.db.demo) throw new Error('first load did not seed a "demo" household record');
    const expectedFirstLoadIds = ['demo', ...Object.keys(WITHDRAWAL_PLANNER_ORACLE.households)].sort();
    const actualFirstLoadIds = Object.keys(s.db).sort();
    if(JSON.stringify(actualFirstLoadIds) !== JSON.stringify(expectedFirstLoadIds)){
      throw new Error(`first-load household set is wrong: ${JSON.stringify({ actualFirstLoadIds, expectedFirstLoadIds })}`);
    }
    if(s.active !== 'demo') throw new Error(`active household not "demo" on first load (got "${s.active}")`);
    if(!s.db.demo.meta || s.db.demo.meta.isDemo !== true) throw new Error('seeded demo record missing meta.isDemo=true');
    if(s.db.demo.meta.name !== 'Demo Household') throw new Error(`seeded demo meta.name wrong: "${s.db.demo.meta?.name}"`);
    if(s.db.demo.meta.primaryName || s.db.demo.household.spouse || s.db.demo.income.socialSecurity.primary.pia !== null || s.db.demo.income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`first-run demo is not blank: ${JSON.stringify(s.db.demo)}`);
    if((s.db.demo.portfolio.extraAccounts || []).length || (s.db.demo.income.other || []).length)
      throw new Error('first-run demo contains hardcoded accounts or income');
    // Controls present on the Household page (inside the tucked ⋯ menu).
    await goToWizardStep(page, 'family');
    const ctl = await page.evaluate(() => ({
      switcher: !!document.querySelector('#hh-menu-pop #hh-switch'),
      options: [...document.querySelectorAll('#hh-switch option')].map(option => option.value),
      newBtn: !!document.querySelector('#hh-menu-pop #hh-new'),
      loadDemoBtn: !!document.querySelector('#hh-menu-pop #hh-load-demo'),
      retired: !!document.querySelector('#hh-act-demo, #hh-act-clear, .hh-menu__row'),
    }));
    if(!ctl.switcher) throw new Error('household switcher (#hh-switch) not rendered in the menu');
    if(JSON.stringify([...ctl.options].sort()) !== JSON.stringify(expectedFirstLoadIds)){
      throw new Error(`household switcher options are wrong: ${JSON.stringify(ctl.options)}`);
    }
    if(!ctl.newBtn) throw new Error('New Household button (#hh-new) not rendered in the menu');
    if(!ctl.loadDemoBtn || ctl.retired) throw new Error(`minimal Load Demo menu contract failed: ${JSON.stringify(ctl)}`);
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
    await goToWizardStep(page, 'family');
    await setFamilyField('primaryName', 'Transient Demo Edit');
    const runtimeCopy = await page.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      const active = localStorage.getItem('parallax.activeHouseholdId');
      return {
        active,
        demo: db?.demo,
        copy: db?.[active],
        optionCount: [...document.querySelectorAll('#hh-switch option')]
          .filter(option => option.value === active).length,
      };
    });
    if(!runtimeCopy.active
        || runtimeCopy.active === 'demo'
        || runtimeCopy.demo?.meta?.primaryName
        || runtimeCopy.copy?.meta?.primaryName !== 'Transient Demo Edit'
        || runtimeCopy.copy?.meta?.runtimeSourceHouseholdId !== 'demo'
        || runtimeCopy.optionCount !== 1){
      throw new Error(`runtime Demo edit did not create one durable copy: ${JSON.stringify(runtimeCopy)}`);
    }
    const demoCopyId = runtimeCopy.active;
    const savedDemoCopyBytes = JSON.stringify(runtimeCopy.copy);
    const menuHidden = await page.$eval('#hh-menu-pop', menu => menu.hidden);
    if(menuHidden) await stableClick('#hh-menu-btn');
    await stableClick('#hh-new');
    await page.waitForFunction(() => {
      const id = document.querySelector('#hh-switch')?.value;
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return /New household created/.test(document.querySelector('#status')?.textContent || '')
        && id && id !== 'demo'
        && localStorage.getItem('parallax.activeHouseholdId') === id
        && Boolean(db?.[id]);
    }, { timeout: 10000 });
    const pendingCustomId = await page.$eval('#hh-switch', element => element.value);
    if(!pendingCustomId || pendingCustomId === 'demo'){
      throw new Error(`New Household did not become the working record (id="${pendingCustomId}")`);
    }
    const created = await page.evaluate(() => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    }));
    if(!created.active || created.active === 'demo') throw new Error(`New Household did not become active (active="${created.active}")`);
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
      'demo',
      ...Object.keys(WITHDRAWAL_PLANNER_ORACLE.households),
      demoCopyId,
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
    await waitForWizard(page, { step: 'family', householdId: 'demo' });
    const afterReload = await page.evaluate(() => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    }));
    if(afterReload.active !== 'demo') throw new Error(`reload did not return to blank Demo (active="${afterReload.active}")`);
    if(!afterReload.db.demo) throw new Error('demo record vanished after reload');
    if(afterReload.db.demo.meta.primaryName || afterReload.db.demo.income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`reload Demo is not current-build blank state: ${JSON.stringify(afterReload.db.demo)}`);
    if(afterReload.db[customId].meta.isDemo !== false) throw new Error('custom record overwritten by demo values on reload');
    if(JSON.stringify(afterReload.db[customId]) !== savedCustomBytes)
      throw new Error('saved custom household bytes changed during blank startup');
    if(JSON.stringify(afterReload.db[demoCopyId]) !== savedDemoCopyBytes)
      throw new Error('durable Demo copy bytes changed during blank startup');
    await stableClick('#hh-menu-btn');
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
    const demoKey   = 'parallax.scenarios.demo.v1';
    const customKey = `parallax.scenarios.${customId}.v1`;
    if(keys.includes(demoKey)) throw new Error(`runtime Demo scenarios entered persistent storage (${demoKey}): ${JSON.stringify(keys)}`);
    if(!keys.includes(customKey)) throw new Error(`custom scenarios not scoped by id (missing ${customKey}): ${JSON.stringify(keys)}`);
    if(keys.includes('parallax.scenarios.v2')) throw new Error('legacy global scenario key parallax.scenarios.v2 must not be written');
  });

  await step('persistence: schema merge preserves saved values while boot recreates blank Demo', async () => {
    const customId = await page.evaluate(() => localStorage.getItem('parallax.activeHouseholdId'));
    await page.evaluate((id) => {
      const key = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(key));
      db[id].meta.primaryName = 'Custom Saved';
      db[id].income.socialSecurity.primary.pia = 7777;
      delete db[id].income.socialSecurity.primary.claimAge;
      delete db.demo;
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.setItem('parallax.activeHouseholdId', id);
    }, customId);
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
    const merged = await page.evaluate((id) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return { active: localStorage.getItem('parallax.activeHouseholdId'), db, record: db?.[id] };
    }, customId);
    if(merged.active !== 'demo' || merged.record?.meta?.primaryName !== 'Custom Saved' || merged.record?.income?.socialSecurity?.primary?.pia !== 7777)
      throw new Error(`schema merge overwrote saved custom values: ${JSON.stringify(merged)}`);
    if(merged.record.income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`schema merge did not add missing claimAge=67: ${JSON.stringify(merged.record.income.socialSecurity)}`);
    if(!merged.db.demo || merged.db.demo.meta.primaryName){
      throw new Error(`bootstrap did not recreate the current-build blank Demo: ${JSON.stringify(merged.db.demo)}`);
    }

    if(await page.$eval('#hh-menu-pop', menu => menu.hidden)){
      await stableClick('#hh-menu-btn');
    }
    await page.select('#hh-switch', customId);
    await waitForWizard(page, { householdId: customId });
    await goToWizardStep(page, 'family');
    const beforeDemo = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    if(await page.$eval('#hh-menu-pop', menu => menu.hidden)){
      await stableClick('#hh-menu-btn');
    }
    await stableClick('#hh-load-demo');
    await waitForWizard(page, {
      afterRevision: beforeDemo,
      householdId: 'demo',
    });
    const after = await page.evaluate((id) => ({
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
      selected: document.querySelector('#hh-switch')?.value,
      primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value,
      customId: id,
    }), customId);
    if(after.selected !== 'demo' || after.primaryName || !after.db.demo || after.db.demo.meta.isDemo !== true)
      throw new Error(`Load Demo did not render the fresh blank Demo: ${JSON.stringify({ selected: after.selected, primaryName: after.primaryName })}`);
    if(after.db.demo.meta.primaryName || after.db.demo.household.spouse || after.db.demo.income.socialSecurity.primary.pia !== null || after.db.demo.income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`Load Demo recreated fictional values: ${JSON.stringify(after.db.demo)}`);
    if(after.db[customId]?.meta?.primaryName !== 'Custom Saved' || after.db[customId]?.income?.socialSecurity?.primary?.pia !== 7777)
      throw new Error(`Load Demo altered the saved custom household: ${JSON.stringify(after.db[customId])}`);
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
    await waitForWizard(page, { householdId: 'demo' });
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
      loadDemoDisabled: Boolean(document.querySelector('#hh-load-demo')?.disabled),
      newDisabled: Boolean(document.querySelector('#hh-new')?.disabled),
      enabledFields: document.querySelectorAll('#hh-view input:not(:disabled), #hh-view select:not(:disabled), #hh-view textarea:not(:disabled)').length,
    }));
    for(const expected of [
      ['demo', 'Demo Household'],
      ['default-pre-retirement-solo', 'Pre-Retirement Solo'],
      ['default-pre-retirement-couple', 'Pre-Retirement Couple'],
    ]){
      if(!startup.options.some(option => option.value === expected[0] && option.label === expected[1])){
        throw new Error(`corrupt-origin recovery omitted current default ${expected[0]}: ${JSON.stringify(startup)}`);
      }
    }
    if(startup.status !== readOnly || startup.selected !== 'demo'
      || startup.switchDisabled || startup.loadDemoDisabled || !startup.newDisabled
      || startup.enabledFields){
      throw new Error(`corrupt-origin runtime state is not safely usable: ${JSON.stringify(startup)}`);
    }

    await page.select('#hh-switch', 'default-pre-retirement-solo');
    await waitForWizard(page, { householdId: 'default-pre-retirement-solo' });
    await stableClick('.htab[data-page="tax-buckets"]');
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-taw-root]');
      return root?.dataset.tawHouseholdId === 'default-pre-retirement-solo'
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
    await page.evaluateOnNewDocument(() => {
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
    await waitForWizard(page, { householdId: 'demo' });
    const readOnlyBlank = await page.evaluate(() => ({
      selected: document.querySelector('#hh-switch')?.value,
      primaryName: document.querySelector('[data-wizard-field="primaryName"]')?.value,
    }));
    if(readOnlyBlank.selected !== 'demo' || readOnlyBlank.primaryName){
      throw new Error(`read-only startup did not render a fresh blank Demo: ${JSON.stringify(readOnlyBlank)}`);
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
      loadDemoDisabled: document.querySelector('#hh-load-demo')?.disabled,
      householdStepCount: document.querySelectorAll('.hh-step').length,
      householdStepsDisabled: [...document.querySelectorAll('.hh-step')].some(el => el.disabled),
    }));
    if(globalControls.saveExists || !globalControls.newHousehold) throw new Error(`read-only must omit Save and disable New: ${JSON.stringify(globalControls)}`);
    if(!globalControls.householdStepCount || globalControls.switchDisabled || globalControls.loadDemoDisabled || globalControls.householdStepsDisabled){
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
    // open solver/rename/delete UI, or alter a lever or scenario bytes.
    await stableClick('button[data-page="scenarios"]');
    await sleep(900);
    await stableClick('#scn-seg-compare');
    await sleep(300);
    const scenarioBefore = await page.evaluate(() => ({
      names:[...document.querySelectorAll('#scn-view .scol__name')].map(el => el.textContent.trim()),
      addDisabled:document.querySelector('#scn-add')?.disabled,
      solveDisabled:document.querySelector('#scn-solve')?.disabled,
      menuCount:document.querySelectorAll('#scn-view .scol__menu').length,
      menuDisabled:[...document.querySelectorAll('#scn-view .scol__menu')].every(el => el.disabled),
      stepCount:document.querySelectorAll('#scn-view .cmp-step-btn').length,
      stepsDisabled:[...document.querySelectorAll('#scn-view .cmp-step-btn')].every(el => el.disabled),
      inputCount:document.querySelectorAll('#scn-view .cmp-lev-in, #scn-view .cmp-goal-in').length,
      inputsDisabled:[...document.querySelectorAll('#scn-view .cmp-lev-in, #scn-view .cmp-goal-in')].every(el => el.disabled),
      firstLever:document.querySelector('#scn-view .cmp-lev-in')?.value || '',
    }));
    if(!scenarioBefore.names.length || !scenarioBefore.addDisabled || !scenarioBefore.solveDisabled ||
       !scenarioBefore.menuCount || !scenarioBefore.menuDisabled || !scenarioBefore.stepCount ||
       !scenarioBefore.stepsDisabled || !scenarioBefore.inputCount || !scenarioBefore.inputsDisabled){
      throw new Error(`read-only scenario mutation controls are not disabled: ${JSON.stringify(scenarioBefore)}`);
    }
    await page.evaluate(() => {
      document.querySelector('#scn-add')?.dispatchEvent(new MouseEvent('click', { bubbles:true }));
      document.querySelector('#scn-solve')?.dispatchEvent(new MouseEvent('click', { bubbles:true }));
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
      solver:!!document.querySelector('#solver-form, #solve-panel .solve-searching'),
      menu:!!document.querySelector('#scn-view .scol__pop, #scn-view .scol__rename'),
      firstLever:document.querySelector('#scn-view .cmp-lev-in')?.value || '',
      enabledReset:[...document.querySelectorAll('#scn-reset, [data-scn-reset], [data-action="reset-scenarios"]')].some(el => !el.disabled),
    }));
    if(JSON.stringify(scenarioAfter.names) !== JSON.stringify(scenarioBefore.names) || scenarioAfter.solver || scenarioAfter.menu || scenarioAfter.enabledReset){
      throw new Error(`read-only scenario add/solve/delete/rename/reset changed immediate state: ${JSON.stringify({ scenarioBefore, scenarioAfter })}`);
    }
    if(scenarioAfter.firstLever !== scenarioBefore.firstLever){
      throw new Error(`read-only scenario lever changed immediate UI state (${scenarioBefore.firstLever} -> ${scenarioAfter.firstLever})`);
    }
    await assertPinned('scenario mutations');
    await assertBytesUnchanged('scenario mutations');

    // Switching is navigation in read-only mode. It must expose the fresh
    // current-build Demo and restore the saved household only after explicit
    // selection, while durable bytes remain untouched.
    await goToWizardStep(page, 'family');
    const switchState = await page.evaluate(() => ({
      disabled:document.querySelector('#hh-switch')?.disabled,
      values:[...document.querySelectorAll('#hh-switch option')].map(el => el.value),
    }));
    if(switchState.disabled || !switchState.values.includes('demo') || !switchState.values.includes('other')){
      throw new Error(`read-only household switch is unavailable: ${JSON.stringify(switchState)}`);
    }
    const beforeBlankDemo = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => {
      const sel = document.querySelector('#hh-switch');
      sel.value = 'demo';
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    });
    await waitForWizard(page, {
      afterRevision: beforeBlankDemo,
      householdId: 'demo',
    });
    const demoState = await page.evaluate(() => ({
      selected:document.querySelector('#hh-switch')?.value || '',
      primaryName:document.querySelector('[data-wizard-field="primaryName"]')?.value || '',
    }));
    if(demoState.selected !== 'demo' || demoState.primaryName){
      throw new Error(`read-only Demo navigation did not render a fresh blank: ${JSON.stringify(demoState)}`);
    }
    await assertPinned('switch to fresh Demo');
    await assertBytesUnchanged('switch to fresh Demo');

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

    const beforeDemo = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => {
      const sel = document.querySelector('#hh-switch');
      sel.value = 'demo';
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    });
    await waitForWizard(page, {
      afterRevision: beforeDemo,
      householdId: 'demo',
    });
    await assertPinned('switch back to demo');
    await assertBytesUnchanged('switch back to demo');

    await stableReload({ waitUntil:'networkidle2', timeout:20000 });
    await waitForWizard(page, { householdId: 'demo' });
    await assertPinned('read-only reload');
    await assertBytesUnchanged('read-only reload');
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

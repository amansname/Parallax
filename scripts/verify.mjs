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
import {
  goToWizardStep,
  runWizardBrowserContract,
  waitForWizard,
} from './wizard-browser-contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'verify-out');
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
    e => { console.error(`  FAIL ${name}\n${e.message || e}`); process.exit(1); }
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
  const serverRoot = resolve(ROOT);
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
      res.writeHead(200, { 'content-type': contentType(filePath) });
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

  ok(/styles\/tax-buckets\.css\?v=1/.test(html), 'Tax Buckets stylesheet is not linked');
  ok(/styles\/tax-aware-withdrawal\.css\?v=1/.test(html), 'Tax-Aware Withdrawal stylesheet is not linked');
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
  await new Promise(r => setTimeout(r, 400));
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

  await step('seed filled demo fixture', async () => {
    await page.evaluate(() => {
      const key = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(key));
      const demo = db.demo;
      demo.meta.primaryName = 'Test Client';
      demo.meta.spouseName = 'Test Co-Client';
      demo.meta.filingStatus = 'marriedFilingJointly';
      demo.household.primary = { currentAge: 64, retirementAge: 66, planEndAge: 96, birthYear: 1962 };
      demo.household.spouse = { currentAge: 63, retirementAge: 65, planEndAge: 95, birthYear: 1963 };
      demo.portfolio.extraAccounts = [
        { type:'Traditional IRA', bucket:'traditional', owner:'client', balance:1600000 },
        { type:'Brokerage (taxable)', bucket:'taxable', owner:'spouse', balance:800000 },
        { type:'Roth IRA', bucket:'roth', owner:'spouse', balance:400000 },
      ];
      demo.expenses.living = 38000;
      demo.expenses.healthcare = 18000;
      demo.expenses.extra = [
        { label:'Housing', amount:34000, startAge:64, endAge:95 },
        { label:'Vacation budget', amount:0, startAge:66, endAge:80 },
      ];
      demo.income.socialSecurity.primary = { pia:34000, claimAge:67 };
      demo.income.socialSecurity.spouse = { pia:28000, claimAge:67 };
      demo.income.other = [
        { typeId:'wages', owner:'client', label:'Client wages', amount:120000, startAge:64, endAge:65, realGrowth:0, taxablePct:1 },
        { typeId:'wages', owner:'spouse', label:'Co-client wages', amount:60000, startAge:63, endAge:64, realGrowth:0, taxablePct:1 },
      ];
      demo.meta.spendingSchemaVersion = 1;
      demo.goals = [
        { id:'system:essentials', system:'essentials', name:'Essentials', amount:38000,
          startsAtRetirement:true, endAge:999, realGrowth:0, flexesWithSpending:true },
        { id:'system:healthcare', system:'healthcare', name:'Healthcare', amount:18000,
          startsAtRetirement:true, endAge:999, realGrowth:0.02 },
        { name:'Travel & leisure', amount:30000, startAge:66, endAge:81 },
      ];
      // Filled demo uses legacy-shaped accounts and ID-less wizard rows; strip
      // both schema stamps so their one-time migrations run together.
      delete demo.meta.accountSchemaVersion;
      delete demo.meta.householdRecordSchemaVersion;
      localStorage.setItem(key, JSON.stringify(db));
    });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
  });

  await step('Tax Buckets: withdrawal planner loads with display ceilings and live tax output', async () => {
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
      || planner.sliderCaps.taxableWithdrawal !== 500000
      || planner.sliderCaps.rothWithdrawal !== 400000
    ) {
      throw new Error(`Withdrawal Planner display ceilings are wrong: ${JSON.stringify(planner.sliderCaps)}`);
    }

    await page.waitForFunction(
      () => document.querySelector('[data-taw-federal-tax]')?.textContent.trim() !== '\u2014',
      { timeout: 15000 },
    );
    const thresholdProof = await page.evaluate(async () => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      const plan = db.demo;
      const adapter = await import('/src/planning/taxBuckets/taxEngineAdapter.js');
      const facts = await adapter.householdIncome(plan, 2026);
      const result = await adapter.evaluateYear({
        plan,
        taxYear: 2026,
        facts,
        levers: {
          taxableWithdrawal: 0,
          deferredWithdrawal: 0,
          rothConversion: 0,
          rothWithdrawal: 0,
          qcd: 0,
        },
      });
      const money = value => typeof value === 'number' && Number.isFinite(value)
        ? (value < 0 ? '-$' : '$') + Math.abs(Math.round(value)).toLocaleString('en-US')
        : '\u2014';
      const pct = value => {
        if(typeof value !== 'number' || !Number.isFinite(value)) return '\u2014';
        const n = Math.abs(value) <= 1 ? value * 100 : value;
        return `${Math.round(n * 10) / 10}%`;
      };
      const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
      return {
        resultCode: result?.code ?? result?.error ?? null,
        expected: {
          ordinary: money(result?.thresholdTaxDollars?.ordinaryIncomeTax),
          ltcg: money(result?.thresholdTaxDollars?.preferentialIncomeTax),
          socialSecurity: money(result?.thresholdTaxDollars?.socialSecurityIncrementalModeledFederalIncomeTax),
          federalTax: money(result?.totals?.federalTax),
          effectiveRate: pct(result?.totals?.effectiveRate),
          marginalRate: pct(result?.totals?.marginalRate ?? result?.ordinary?.rate),
          ltcgMiddleRate: pct(result?.ladders?.ltcg?.rates?.middle),
          socialSecurityLowerRate: pct(result?.ladders?.socialSecurity?.rates?.lowerTier),
        },
        actual: {
          ordinaryHeadline: text('[data-taw-col="ord"] .taw-col-rate'),
          ltcgHeadline: text('[data-taw-col="ltcg"] .taw-col-rate'),
          socialSecurityHeadline: text('[data-taw-col="ss"] .taw-col-rate'),
          ordinary: text('[data-taw-col="ord"] .taw-col-edge span'),
          ltcg: text('[data-taw-col="ltcg"] .taw-col-edge span'),
          irmaa: text('[data-taw-col="irmaa"] .taw-col-edge span'),
          socialSecurity: text('[data-taw-col="ss"] .taw-col-edge span'),
          federalTax: text('[data-taw-federal-tax]'),
          effectiveRate: text('[data-taw-effective-rate]'),
          marginalRate: text('[data-taw-marginal-rate]'),
          ltcgMiddleRate: text('[data-taw-mark="ltcg:0"] .taw-mark-chip'),
          socialSecurityLowerRate: text('[data-taw-mark="ss:0"] .taw-mark-chip'),
        },
      };
    });
    if(thresholdProof.resultCode) throw new Error(`live tax-engine result unavailable: ${JSON.stringify(thresholdProof)}`);
    if(
      thresholdProof.actual.ordinaryHeadline !== thresholdProof.expected.ordinary
      || thresholdProof.actual.ltcgHeadline !== thresholdProof.expected.ltcg
      || thresholdProof.actual.socialSecurityHeadline !== thresholdProof.expected.socialSecurity
      || thresholdProof.actual.ordinary !== thresholdProof.expected.ordinary
      || thresholdProof.actual.ltcg !== thresholdProof.expected.ltcg
      || thresholdProof.actual.socialSecurity !== thresholdProof.expected.socialSecurity
      || thresholdProof.actual.irmaa !== '\u2014'
      || thresholdProof.actual.federalTax !== thresholdProof.expected.federalTax
      || thresholdProof.actual.effectiveRate !== thresholdProof.expected.effectiveRate
      || thresholdProof.actual.marginalRate !== thresholdProof.expected.marginalRate
      || thresholdProof.actual.ltcgMiddleRate !== thresholdProof.expected.ltcgMiddleRate
      || thresholdProof.actual.socialSecurityLowerRate !== thresholdProof.expected.socialSecurityLowerRate
    ) {
      throw new Error(`rendered threshold contract differs from tax engine: ${JSON.stringify(thresholdProof)}`);
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
        '[data-taw-slider-val="taxableWithdrawal"]',
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

    const baselinePlannerTax = await page.$eval(
      '[data-taw-federal-tax]',
      element => element.textContent.trim(),
    );
    await page.$eval('[data-taw-lever="rothConversion"]', input => {
      input.value = input.max;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-taw-slider-val="rothConversion"]')?.textContent.trim() === '$500,000'
      && document.querySelector('[data-taw-lever="rothConversion"]')?.value === '500000'
    ), { timeout: 15000 });
    await page.$eval('[data-taw-lever="rothConversion"]', input => {
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(baseline => (
      document.querySelector('[data-taw-slider-val="rothConversion"]')?.textContent.trim() === '$0'
      && document.querySelector('[data-taw-federal-tax]')?.textContent.trim() === baseline
    ), { timeout: 15000 }, baselinePlannerTax);
    await page.$eval('[data-taw-lever="deferredWithdrawal"]', input => {
      input.value = '50000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(baseline => (
      document.querySelector('[data-taw-slider-val="deferredWithdrawal"]')?.textContent.trim() === '$50,000'
      && document.querySelector('[data-taw-federal-tax]')?.textContent.trim() !== baseline
    ), { timeout: 15000 }, baselinePlannerTax);
    await page.$eval('[data-taw-lever="deferredWithdrawal"]', input => {
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(baseline => (
      document.querySelector('[data-taw-slider-val="deferredWithdrawal"]')?.textContent.trim() === '$0'
      && document.querySelector('[data-taw-federal-tax]')?.textContent.trim() === baseline
    ), { timeout: 15000 }, baselinePlannerTax);
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
            taxableWithdrawal: { max: 50000 },
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
      const taxable = host.querySelector('[data-taw-lever="taxableWithdrawal"]');
      taxable.value = '10000';
      taxable.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolveWait => setTimeout(resolveWait, 0));
      const callsWhileRefreshPending = calls.length;
      releaseRefresh();
      await waitFor(() => calls.length === 4, 'approval queued after refresh');
      await waitFor(() => taxable.value === '10000', 'post-refresh approved slider value');

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
          finalTaxable: taxable.value,
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
      || proof.refreshRace.finalTaxable !== '10000'
    ) {
      throw new Error(`refresh and approval ordering is unsafe: ${JSON.stringify(proof)}`);
    }
  });

  await step('Tax Buckets: production RMD floor and shared IRA limits reach the controls', async () => {
    const proof = await page.evaluate(async () => {
      const [engineModule, accountModule, controllerModule, adapter] = await Promise.all([
        import('/engine.js'),
        import('/src/household/createAccount.js'),
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
      await waitFor(
        () => distribution.min === '10000'
          && distribution.max === '265000'
          && distribution.value === '10000'
          && conversion.max === '255000',
        'initial RMD-backed limits',
      );
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
    if(!await page.evaluate(() => document.querySelector('.gh-rail__icon img')?.getAttribute('src')?.endsWith('/home.svg')))
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
    await page.waitForFunction(({ selector, editedAge }) => {
      const input = document.querySelector(selector);
      return input?.value === String(editedAge)
        && input.closest('.cell--goal-detail')?.classList.contains('is-overridden');
    }, { timeout: 10000 }, { selector, editedAge });

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
  });

  await step('goals Horizon: blank household stays blank and derives starter timing from its plan', async () => {
    await goToWizardStep(page, 'family');
    const beforeNew = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => document.querySelector('#hh-new').click());
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
      empty: document.querySelector('.gh-empty')?.textContent || '',
      lifetime: /Lifetime/i.test(document.querySelector('.gh-page')?.textContent || ''),
    }));
    if(m.lanes !== 0 || !/Nothing on the horizon yet/.test(m.empty) || m.lifetime)
      throw new Error(`blank Goals Horizon state wrong (${JSON.stringify(m)})`);
    await page.click('.gh-add-toggle');
    await page.click('.gh-starter[data-add-category="home"]');
    await page.waitForSelector('.gh-lane', { visible: true, timeout: 8000 });
    m = await page.evaluate(() => ({
      lanes: document.querySelectorAll('.gh-lane').length,
      name: document.querySelector('.gh-name-input')?.value,
      age: document.querySelector('[data-field="once-age"]')?.value,
    }));
    if(m.lanes !== 1 || m.name !== 'Home improvements' || m.age !== '68')
      throw new Error(`blank-household starter did not derive from its 65 retirement age (${JSON.stringify(m)})`);

    await goToWizardStep(page, 'family');
    const beforeDemo = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => document.querySelector('#hh-load-demo').click());
    await waitForWizard(page, {
      afterRevision: beforeDemo,
      householdId: 'demo',
    });
    await page.click('.htab[data-sub-target="goals"]');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.gh-chip__name')]
        .some(element => element.textContent.includes('European summers')),
      { timeout: 8000 },
    );
    const restored = await page.evaluate(() => [...document.querySelectorAll('.gh-chip__name')].map(el => el.textContent));
    if(!restored.includes('European summers') || !restored.some(name => name.endsWith(' copy')))
      throw new Error(`saved demo Goals Horizon inventory did not persist (${JSON.stringify(restored)})`);
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

    const beforeReload = await page.evaluate(() => {
      const medians = [...document.querySelectorAll('#scn-view .scol__median b')]
        .map(element => element.textContent.trim());
      const savings = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="savings"]')]
        .map(input => input.value.replace(/[^0-9.]/g, ''));
      const spending = [...document.querySelectorAll('#scn-view .cmp-lev-in[data-key="spend"]')]
        .map(input => input.value.replace(/[^0-9.]/g, ''));
      const saved = JSON.parse(localStorage.getItem('parallax.scenarios.demo.v1') || '[]');
      return {
        medians,
        savings,
        spending,
        savedSavings: saved.find(scenario => scenario.name === 'Scenario D')?.lev?.savings,
      };
    });
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
    await page.click('button[data-page="scenarios"]');
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
    await page.evaluate(() => {
      const key = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(key) || '{}');
      const demo = db.demo;
      if(!demo) return;
      demo.meta.filingStatus = 'marriedFilingJointly';
      demo.household.primary = {
        currentAge: 64,
        retirementAge: 66,
        planEndAge: 80,
        birthYear: 1962,
      };
      demo.household.spouse = {
        currentAge: 60,
        retirementAge: 65,
        planEndAge: 100,
        birthYear: 1966,
      };
      demo.portfolio.accounts = {
        taxable: { balance: 50000000, basisPct: 1 },
        traditional: { balance: 0 },
        roth: { balance: 0 },
      };
      demo.portfolio.extraAccounts = [];
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.removeItem('parallax.scenarios.demo.v1');
    });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
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
    // Re-anchor the demo plan + scenario levers after earlier household edits.
    await page.evaluate(() => {
      const key = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(key) || '{}');
      const demo = db.demo;
      if(!demo) return;
      demo.meta.primaryName = 'Test Client';
      demo.meta.spouseName = 'Test Co-Client';
      demo.meta.filingStatus = 'marriedFilingJointly';
      demo.household.primary = { currentAge: 64, retirementAge: 66, planEndAge: 96, birthYear: 1962 };
      demo.household.spouse = { currentAge: 63, retirementAge: 65, planEndAge: 95, birthYear: 1963 };
      demo.portfolio.accounts = {
        taxable: { balance:0, basisPct:1 },
        traditional: { balance:0 },
        roth: { balance:0 },
      };
      demo.portfolio.extraAccounts = [
        { type:'Traditional IRA', bucket:'traditional', owner:'client', balance:1600000 },
        { type:'Brokerage (taxable)', bucket:'taxable', owner:'spouse', balance:800000 },
        { type:'Roth IRA', bucket:'roth', owner:'spouse', balance:400000 },
      ];
      delete demo.meta.accountSchemaVersion;
      delete demo.meta.householdRecordSchemaVersion;
      localStorage.setItem(key, JSON.stringify(db));
      localStorage.removeItem('parallax.scenarios.demo.v1');
    });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
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
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('#scn-view .lever__name')]
        .map(element => element.textContent.trim());
      return names.includes('Allocation') && !names.includes('Retirement Age');
    }, { timeout: 10000 });
    await stableClick('#scn-seg-compare');
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

  await step('tax-funded probability is the only probability shown after Run', async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const controlledPlan = await page.evaluate(() => {
      const storageKey = 'parallax.households.v1';
      const db = JSON.parse(localStorage.getItem(storageKey) || '{}');
      const plan = db.demo;
      if(!plan) throw new Error('demo household is unavailable for the probability fixture');

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
        living: 300000,
        housing: 0,
        debt: 0,
        healthcare: 0,
        healthcareRealGrowth: 0,
        extra: [],
      };
      plan.liabilities = [];
      plan.properties = [];
      plan.goals = [];
      plan.ltc = { amount: 0, onsetAge: 85 };
      plan.taxes = { ordinary: 22, capitalGains: 15 };
      plan.simulation = { ...(plan.simulation || {}), iterations: 40 };

      db.demo = plan;
      localStorage.setItem(storageKey, JSON.stringify(db));
      localStorage.setItem('parallax.activeHouseholdId', 'demo');
      localStorage.removeItem('parallax.scenarios.demo.v1');
      localStorage.removeItem('parallax.pathReplay.v1');
      return plan;
    });

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
  // first-load seeds a blank demo, saved values survive reload, scenario storage
  // is scoped by householdId, and Load Demo can recreate a missing demo slot.
  await step('persistence: first load seeds one blank Demo Household + exposes minimal controls', async () => {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'demo' });
    const s = await page.evaluate(() => ({
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
      active: localStorage.getItem('parallax.activeHouseholdId'),
    }));
    if(!s.db || typeof s.db !== 'object') throw new Error('households store not created on first load');
    if(!s.db.demo) throw new Error('first load did not seed a "demo" household record');
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
      opts: document.querySelectorAll('#hh-switch option').length,
      newBtn: !!document.querySelector('#hh-menu-pop #hh-new'),
      loadDemoBtn: !!document.querySelector('#hh-menu-pop #hh-load-demo'),
      retired: !!document.querySelector('#hh-act-demo, #hh-act-clear, .hh-menu__row'),
    }));
    if(!ctl.switcher) throw new Error('household switcher (#hh-switch) not rendered in the menu');
    if(ctl.opts < 1) throw new Error('household switcher has no options');
    if(!ctl.newBtn) throw new Error('New Household button (#hh-new) not rendered in the menu');
    if(!ctl.loadDemoBtn || ctl.retired) throw new Error(`minimal Load Demo menu contract failed: ${JSON.stringify(ctl)}`);
  });

  await step('persistence: auto-saved demo values and New Household survive reload', async () => {
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
    await setFamilyField('primaryName', 'Saved Client');
    await setFamilyField('client.socialSecurityAge', '70');
    // The storage wait below is the automatic-save assertion. No explicit save
    // action is available before reload or household switching.
    await page.waitForFunction(() => {
      const demo = JSON.parse(
        localStorage.getItem('parallax.households.v1') || 'null',
      )?.demo;
      return demo?.meta?.primaryName === 'Saved Client'
        && demo?.income?.socialSecurity?.primary?.claimAge === 70;
    }, { timeout: 10000 });
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { step: 'family' });
    const savedDemo = await page.evaluate(() => JSON.parse(localStorage.getItem('parallax.households.v1') || 'null')?.demo);
    if(savedDemo?.meta?.primaryName !== 'Saved Client' || savedDemo?.income?.socialSecurity?.primary?.claimAge !== 70)
      throw new Error(`saved demo values were overwritten on reload: ${JSON.stringify(savedDemo)}`);
    await page.evaluate(() => document.querySelector('#hh-new').click());
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
    if(Object.keys(created.db).length !== 2) throw new Error(`expected 2 households after New (got ${Object.keys(created.db).length})`);
    const customId = created.active;
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

    // Reload: the custom household must remain active (demo must NOT overwrite it).
    await stableReload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { step: 'family' });
    const afterReload = await page.evaluate(() => ({
      active: localStorage.getItem('parallax.activeHouseholdId'),
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
    }));
    if(afterReload.active !== customId) throw new Error(`custom household did not survive reload (active="${afterReload.active}", want "${customId}")`);
    if(!afterReload.db.demo) throw new Error('demo record vanished after reload');
    if(afterReload.db.demo.meta.primaryName !== 'Saved Client' || afterReload.db.demo.income.socialSecurity.primary.claimAge !== 70)
      throw new Error(`saved demo was reset during custom-household reload: ${JSON.stringify(afterReload.db.demo)}`);
    if(afterReload.db[customId].meta.isDemo !== false) throw new Error('custom record overwritten by demo values on reload');
    if(afterReload.db[customId].meta.name !== 'New Household') throw new Error(`custom household name changed on reload: "${afterReload.db[customId].meta.name}"`);
  });

  await step('persistence: scenario localStorage is scoped by householdId', async () => {
    const customId = await page.evaluate(() => localStorage.getItem('parallax.activeHouseholdId'));
    const keys = await page.evaluate(() => Object.keys(localStorage));
    const demoKey   = 'parallax.scenarios.demo.v1';
    const customKey = `parallax.scenarios.${customId}.v1`;
    if(!keys.includes(demoKey)) throw new Error(`demo scenarios not scoped by id (missing ${demoKey}): ${JSON.stringify(keys)}`);
    if(!keys.includes(customKey)) throw new Error(`custom scenarios not scoped by id (missing ${customKey}): ${JSON.stringify(keys)}`);
    if(keys.includes('parallax.scenarios.v2')) throw new Error('legacy global scenario key parallax.scenarios.v2 must not be written');
  });

  await step('persistence: schema merge preserves values; Load Demo recreates a missing blank slot', async () => {
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
    await waitForWizard(page, { householdId: customId });
    const merged = await page.evaluate((id) => {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      return { active: localStorage.getItem('parallax.activeHouseholdId'), db, record: db?.[id] };
    }, customId);
    if(merged.active !== customId || merged.record?.meta?.primaryName !== 'Custom Saved' || merged.record?.income?.socialSecurity?.primary?.pia !== 7777)
      throw new Error(`schema merge overwrote saved custom values: ${JSON.stringify(merged)}`);
    if(merged.record.income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`schema merge did not add missing claimAge=67: ${JSON.stringify(merged.record.income.socialSecurity)}`);
    if(merged.db.demo) throw new Error('bootstrap recreated demo before Load Demo was requested');

    await goToWizardStep(page, 'family');
    const beforeDemo = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => document.querySelector('#hh-load-demo').click());
    await waitForWizard(page, {
      afterRevision: beforeDemo,
      householdId: 'demo',
    });
    const after = await page.evaluate((id) => ({
      db: JSON.parse(localStorage.getItem('parallax.households.v1') || 'null'),
      active: localStorage.getItem('parallax.activeHouseholdId'),
      customId: id,
    }), customId);
    if(after.active !== 'demo' || !after.db.demo || after.db.demo.meta.isDemo !== true)
      throw new Error(`Load Demo did not recreate and activate demo: ${JSON.stringify(after)}`);
    if(after.db.demo.meta.primaryName || after.db.demo.household.spouse || after.db.demo.income.socialSecurity.primary.pia !== null || after.db.demo.income.socialSecurity.primary.claimAge !== 67)
      throw new Error(`Load Demo recreated fictional values: ${JSON.stringify(after.db.demo)}`);
    if(after.db[customId]?.meta?.primaryName !== 'Custom Saved' || after.db[customId]?.income?.socialSecurity?.primary?.pia !== 7777)
      throw new Error(`Load Demo altered the saved custom household: ${JSON.stringify(after.db[customId])}`);
  });

  await step('persistence: BLOCKED is inert, truthful, and preserves every recovery byte', async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const blocked = 'Household data could not be safely upgraded. No saved data was changed.';
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
    await page.waitForFunction(expected => {
      const status = document.querySelector('#status')?.textContent.trim() || '';
      const root = document.querySelector('[data-hh-wizard-root]');
      const editor = document.querySelector(
        '#hh-view [data-hh-wizard-screen],'
          + ' #hh-view [data-wizard-field],'
          + ' #hh-view [data-account-field],'
          + ' #hh-view [data-tax-field],'
          + ' #hh-view [data-tax-confirmation]',
      );
      return status === expected
        && (!root || root.dataset.wizardReady !== 'true')
        && !editor;
    }, { timeout: 10000 }, blocked);

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
    if(beforeBytes.db !== corrupt) throw new Error('blocked bootstrap replaced corrupt household bytes');
    if(beforeBytes.active !== 'demo') throw new Error(`blocked bootstrap changed the active pointer to "${beforeBytes.active}"`);
    if(beforeBytes.scenarios['parallax.scenarios.demo.v1'] !== seededScenarios) throw new Error('blocked bootstrap changed scenario bytes');

    const assertPinned = async label => {
      const status = await page.$eval('#status', el => el.textContent.trim());
      if(status !== blocked) throw new Error(`${label}: blocked status was not pinned (got "${status}")`);
    };
    await assertPinned('initial load');
    const blockedWizardEditor = await page.$(
      '#hh-view [data-hh-wizard-screen],'
      + ' #hh-view [data-wizard-field],'
      + ' #hh-view [data-account-field],'
      + ' #hh-view [data-tax-field],'
      + ' #hh-view [data-tax-confirmation]',
    );
    if(blockedWizardEditor) throw new Error('blocked Household surface exposed wizard inputs');

    const blockedControls = await page.evaluate(includeSequencing => {
      const disabled = selector => {
        const el = document.querySelector(selector);
        return { selector, exists: !!el, disabled: !!el?.disabled };
      };
      const controls = [
        disabled('#run-btn'), disabled('#hh-menu-btn'), disabled('#hh-switch'),
        disabled('#hh-new'), disabled('#hh-load-demo'), disabled('#scn-add'), disabled('#scn-solve'),
      ];
      if(includeSequencing) controls.push(disabled('#path-mode'), disabled('#seq-select'));
      return controls;
    }, !SKIP_SEQUENCING);
    const missingBlockedControls = blockedControls.filter(x => !x.exists || !x.disabled);
    if(missingBlockedControls.length) throw new Error(`blocked mutation controls must exist and be disabled: ${JSON.stringify(missingBlockedControls)}`);

    // Every product surface may still be navigated for recovery context, but no
    // default-plan input or prior financial result may leak into a blocked view.
    const recoverySurfaces = [
      '.htab[data-page="household"]',
      '.htab[data-sub-target="goals"]',
      '.htab[data-page="scenarios"]',
      '.htab[data-page="tax-buckets"]',
    ];
    if(!SKIP_SEQUENCING) recoverySurfaces.push('.htab[data-page="sequencing"]');
    for(const selector of recoverySurfaces){
      await stableClick(selector);
      await sleep(400);
      const exposed = await page.evaluate(() => {
        const active = document.querySelector('.page.on');
        if(!active) return { missingPage:true, controls:[], financialText:'' };
        const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        const controls = [...active.querySelectorAll(
          '[data-wizard-field], [data-account-field], [data-tax-field],'
          + ' [data-tax-confirmation], input[type="number"], input[inputmode="numeric"]',
        )]
          .filter(visible)
          .map(el => ({
            tag:el.tagName,
            field:el.dataset.wizardField
              || el.dataset.accountField
              || el.dataset.taxField
              || '',
            value:el.value || '',
          }));
        const textOnly = active.cloneNode(true);
        textOnly.querySelectorAll('.hh-progress').forEach(element => element.remove());
        const financialText = (textOnly.textContent || '').match(/\$\s*[\d,]+|\b\d+(?:\.\d+)?\s*%/g) || [];
        return { missingPage:false, controls, financialText };
      });
      if(exposed.missingPage) throw new Error(`${selector}: active page did not render`);
      if(exposed.controls.length) throw new Error(`${selector}: blocked mode exposed fake financial inputs: ${JSON.stringify(exposed.controls.slice(0, 5))}`);
      if(exposed.financialText.length) throw new Error(`${selector}: blocked mode exposed fake financial results: ${JSON.stringify(exposed.financialText.slice(0, 8))}`);
      await assertPinned(selector);
    }

    await stableClick('.htab[data-page="scenarios"]');
    await sleep(300);
    await page.evaluate(() => {
      document.querySelector('#run-btn')?.click();
      document.querySelector('#scn-add')?.click();
      document.querySelector('#scn-solve')?.click();
    });
    await sleep(500);
    const blockedEngine = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent.trim() || '',
      probs: [...document.querySelectorAll('#scn-view .scol__prob')].map(el => el.textContent.trim()),
      medians: [...document.querySelectorAll('#scn-view .scol__median b')].map(el => el.textContent.trim()),
      solverStarted: !!document.querySelector('#solver-form, #solve-panel .solve-searching'),
      scenarioColumns: document.querySelectorAll('#scn-view .scol').length,
    }));
    if(blockedEngine.status !== blocked) throw new Error(`blocked engine attempt replaced pinned status with "${blockedEngine.status}"`);
    if(blockedEngine.solverStarted) throw new Error('blocked recovery allowed solver startup');
    if(blockedEngine.scenarioColumns) throw new Error('blocked recovery rendered scenario columns from fake/default state');
    if(blockedEngine.probs.some(p => /\d/.test(p))) throw new Error(`blocked recovery showed probabilities: ${JSON.stringify(blockedEngine.probs)}`);
    if(blockedEngine.medians.some(m => /\$[\d,]/.test(m))) throw new Error(`blocked recovery showed medians: ${JSON.stringify(blockedEngine.medians)}`);

    const afterBytes = await readRecoveryBytes();
    if(JSON.stringify(afterBytes) !== JSON.stringify(beforeBytes)){
      throw new Error(`blocked interactions changed recovery bytes: ${JSON.stringify({ beforeBytes, afterBytes })}`);
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

    // Net Worth uses stable account IDs. Add/remove and field edits stay inert
    // even when a synthetic event bypasses the disabled browser control.
    await goToWizardStep(page, 'net-worth');
    const accountBefore = await page.evaluate(() => {
      const fields = [...document.querySelectorAll(
        '[data-hh-wizard-screen="net-worth"] [data-account-field]',
      )];
      const rows = [...document.querySelectorAll('.hh-account-row[data-account-id]')];
      const remove = [...document.querySelectorAll('[data-hh-action="remove-account"]')];
      const add = [...document.querySelectorAll('[data-hh-action="add-account"]')];
      return {
        ids: rows.map(row => row.dataset.accountId),
        fields: fields.length,
        enabledFields: fields.filter(element => !element.disabled)
          .map(element => `${element.dataset.accountId}:${element.dataset.accountField}`),
        removeCount: remove.length,
        removeEnabled: remove.filter(element => !element.disabled).length,
        addCount: add.length,
        addEnabled: add.filter(element => !element.disabled).length,
        firstBalance: document.querySelector('[data-account-field="balance"]')?.value || '',
      };
    });
    if(!accountBefore.ids.length || !accountBefore.fields || accountBefore.enabledFields.length
      || !accountBefore.removeCount || accountBefore.removeEnabled
      || !accountBefore.addCount || accountBefore.addEnabled){
      throw new Error(`read-only account controls are not disabled: ${JSON.stringify(accountBefore)}`);
    }
    await page.evaluate(() => {
      document.querySelector('[data-hh-action="remove-account"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('[data-hh-action="add-account"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const balance = document.querySelector('[data-account-field="balance"]');
      if(balance){
        balance.value = '999';
        balance.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await goToWizardStep(page, 'family');
    await goToWizardStep(page, 'net-worth');
    const accountAfter = await page.evaluate(() => ({
      ids: [...document.querySelectorAll('.hh-account-row[data-account-id]')]
        .map(row => row.dataset.accountId),
      form: Boolean(document.querySelector('[data-hh-account-add-form]')),
      firstBalance: document.querySelector('[data-account-field="balance"]')?.value || '',
    }));
    if(JSON.stringify(accountAfter.ids) !== JSON.stringify(accountBefore.ids)
      || accountAfter.form
      || accountAfter.firstBalance !== accountBefore.firstBalance){
      throw new Error(`read-only account edit changed immediate state: ${JSON.stringify({ accountBefore, accountAfter })}`);
    }
    await assertPinned('account add/remove and fields');
    await assertBytesUnchanged('account add/remove and fields');

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

    // Switching is navigation in read-only mode. It must update the transient
    // household while leaving the durable DB, active pointer, and all scenario
    // records byte-for-byte unchanged.
    await goToWizardStep(page, 'family');
    const switchState = await page.evaluate(() => ({
      disabled:document.querySelector('#hh-switch')?.disabled,
      values:[...document.querySelectorAll('#hh-switch option')].map(el => el.value),
    }));
    if(switchState.disabled || !switchState.values.includes('other')) throw new Error(`read-only household switch is unavailable: ${JSON.stringify(switchState)}`);
    const beforeOther = await page.$eval(
      '[data-hh-wizard-root]',
      element => Number(element.dataset.renderRevision),
    );
    await page.evaluate(() => {
      const sel = document.querySelector('#hh-switch');
      sel.value = 'other';
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    });
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

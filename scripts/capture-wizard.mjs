import puppeteer from 'puppeteer';
import {
  mkdirSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachBrowserDiagnostics,
  captureWizardScreens,
  waitForWizard,
} from './wizard-browser-contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.env.VERIFY_OUT || join(ROOT, 'verify-out');
const PORT = 8825;
const requestedPort = Number(process.env.PORT || PORT);
if (requestedPort !== PORT) {
  console.error(`Parallax browser capture is fixed at http://127.0.0.1:${PORT}/.`);
  process.exit(1);
}

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const launchOpts = { headless: true, args: ['--no-sandbox'] };
const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
for (const chromePath of chromeCandidates) {
  if (existsSync(chromePath)) {
    launchOpts.executablePath = chromePath;
    break;
  }
}
if (!launchOpts.executablePath) {
  console.error('No Chrome executable found. Set PUPPETEER_EXECUTABLE_PATH.');
  process.exit(1);
}

async function captureContactSheet(browser, artifacts){
  const core = artifacts.filter(artifact =>
    ['family', 'net-worth', 'tax', 'summary'].includes(artifact.step)
      && ['desktop', 'mobile'].includes(artifact.viewport)
      && !/detailed|add account/.test(artifact.label));
  const cards = core.map(artifact => {
    const image = readFileSync(artifact.path).toString('base64');
    return `
      <figure class="${artifact.viewport}">
        <figcaption>${artifact.label}</figcaption>
        <img alt="${artifact.label}" src="data:image/png;base64,${image}">
      </figure>
    `;
  }).join('');
  const sheet = await browser.newPage();
  try{
    await sheet.setViewport({
      width: 1800,
      height: 1200,
      deviceScaleFactor: 1,
    });
    await sheet.setContent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              padding: 28px;
              background: #0d1118;
              color: #eef1f5;
              font: 14px/1.3 Arial, sans-serif;
            }
            main {
              display: grid;
              grid-template-columns: repeat(4, minmax(0, 1fr));
              gap: 18px;
              align-items: start;
            }
            figure {
              margin: 0;
              padding: 14px;
              border: 1px solid #2f3947;
              background: #151b24;
            }
            figcaption {
              margin-bottom: 10px;
              color: #d8bd7d;
              font-weight: 700;
              text-transform: capitalize;
            }
            img {
              display: block;
              width: 100%;
              object-fit: cover;
              object-position: top;
            }
            figure.desktop img {
              height: 260px;
            }
            figure.mobile img {
              height: 720px;
            }
          </style>
        </head>
        <body><main>${cards}</main></body>
      </html>
    `, { waitUntil: 'load' });
    await sheet.waitForFunction(() =>
      [...document.images].length === 8
        && [...document.images].every(image =>
          image.complete && image.naturalWidth > 0),
    { timeout: 10000 });
    const path = join(OUT, 'wizard-contact-sheet.png');
    await sheet.screenshot({ path, fullPage: true });
    return path;
  } finally {
    await sheet.close();
  }
}

let browser;
let diagnostics;
let failure = null;
try{
  browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  diagnostics = attachBrowserDiagnostics(page);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await waitForWizard(page);
  const artifacts = await captureWizardScreens(page, {
    outDir: OUT,
    prefix: 'wizard-final',
  });
  const contactSheet = await captureContactSheet(browser, artifacts);
  console.log('Screenshots saved to', OUT);
  console.log('Contact sheet:', contactSheet);
}catch(error){
  failure = error;
} finally {
  try{
    diagnostics?.assertClean();
  }catch(error){
    failure = failure
      ? new AggregateError(
          [failure, error],
          'Wizard capture and browser diagnostics both failed',
        )
      : error;
  } finally {
    diagnostics?.dispose();
    if(browser) await browser.close();
  }
}
if(failure) throw failure;

import puppeteer from 'puppeteer';
import { existsSync } from 'node:fs';
export async function createBrowserSession(PORT) {
  const launchOpts = {
    args: ['--no-sandbox']
  };
  const chromeCandidates = [process.env.PUPPETEER_EXECUTABLE_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const chromePath of chromeCandidates) {
    if (existsSync(chromePath)) {
      launchOpts.executablePath = chromePath;
      break;
    }
  }
  if (!launchOpts.executablePath) {
    console.error('No Chrome/Chromium executable found for verify.\n' + '  Windows: install Google Chrome, or run: npx puppeteer browsers install chrome\n' + '  Or set PUPPETEER_EXECUTABLE_PATH to your chrome.exe path');
    process.exit(1);
  }
  const browser = await puppeteer.launch({
    ...launchOpts,
    headless: true
  });
  const rawPage = await browser.newPage();
  await rawPage.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: 3
  });
  // Puppeteer can briefly retain a detached main-frame handle while a prior
  // reload settles. Retry only that transport-level condition; all assertion,
  // selector, and application errors still fail immediately.
  const retryDetachedFrame = async (label, action) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await action();
      } catch (error) {
        lastError = error;
        if (!/(?:detached.*frame|frame.*detached)/i.test(error?.message || '') || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        try {
          await rawPage.waitForFunction(() => document.readyState === 'complete', {
            timeout: 5000
          });
        } catch (waitError) {
          if (!/(?:detached.*frame|frame.*detached|Execution context was destroyed)/i.test(waitError?.message || '')) throw waitError;
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
  const retryablePageMethods = new Set(['click', 'evaluate', '$', '$$', '$eval', '$$eval', 'screenshot', 'setViewport']);
  const page = new Proxy(rawPage, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      if (!retryablePageMethods.has(property)) return bound;
      return (...args) => retryDetachedFrame(`${String(property)} operation`, () => bound(...args));
    }
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
    return parsed.origin === `http://127.0.0.1:${PORT}` && (parsed.pathname === '/app.html' || parsed.pathname === '/engine.js' || /^\/(?:assets|src|styles|ui)\//.test(parsed.pathname));
  };
  rawPage.on('request', request => {
    if (isMutableAppAsset(request.url())) artifactRequests.push(request.url());
  });
  rawPage.on('response', response => {
    if (!isMutableAppAsset(response.url())) return;
    artifactResponses.push({
      url: response.url(),
      artifactId: response.headers()['x-parallax-artifact-id'] || null,
      sourceCommit: response.headers()['x-parallax-source-commit'] || null
    });
  });
  page.on('pageerror', e => errs.push('PAGE: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const message = m.text();
    const sourceUrl = m.location()?.url || '';
    const blockedGoogleFont = message === 'Failed to load resource: net::ERR_NETWORK_ACCESS_DENIED' && /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(sourceUrl);
    if (blockedGoogleFont) return;
    errs.push('CON: ' + message + (sourceUrl ? ` @ ${sourceUrl}` : ''));
  });
  return {
    browser,
    page,
    stableClick,
    stableEvaluate,
    stableGoto,
    stableReload,
    errs,
    artifactRequests,
    artifactResponses
  };
}

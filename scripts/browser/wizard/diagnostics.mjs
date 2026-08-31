// Wizard browser contract: diagnostics.
import { requireCondition } from './assertions.mjs';
const APP_ORIGIN_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//;
function diagnosticText(entry) {
  if (entry instanceof Error) return entry.message;
  return String(entry || '');
}
function ignoredExternalFontFailure(text, url = '') {
  return /fonts\.(?:googleapis|gstatic)\.com/.test(`${text} ${url}`);
}
export function attachBrowserDiagnostics(page) {
  const failures = [];
  const onPageError = error => failures.push(`PAGE: ${diagnosticText(error)}`);
  const onConsole = message => {
    if (!['error', 'warning', 'warn'].includes(message.type())) return;
    const text = message.text();
    const url = message.location()?.url || '';
    if (ignoredExternalFontFailure(text, url)) return;
    failures.push(`CONSOLE ${message.type()}: ${text}${url ? ` @ ${url}` : ''}`);
  };
  const onRequestFailed = request => {
    const url = request.url();
    const text = request.failure()?.errorText || 'request failed';
    if (ignoredExternalFontFailure(text, url)) return;
    if (APP_ORIGIN_PATTERN.test(url)) {
      failures.push(`REQUEST: ${text} @ ${url}`);
    }
  };
  const onResponse = response => {
    const url = response.url();
    if (APP_ORIGIN_PATTERN.test(url) && response.status() >= 400) {
      failures.push(`HTTP ${response.status()}: ${url}`);
    }
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  return {
    failures,
    assertClean() {
      requireCondition(failures.length === 0, `Wizard browser diagnostics failed:\n${failures.join('\n')}`);
    },
    dispose() {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    }
  };
}

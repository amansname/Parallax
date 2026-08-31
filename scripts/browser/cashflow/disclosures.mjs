import { join } from 'node:path';
export async function verifyCashFlowDisclosures({
  page,
  OUT
}) {
  const disclosureStates = await page.evaluate(async () => {
    const {
      renderCashflow
    } = await import('./ui/cashflow.js');
    const row = {
      year: 2026,
      age: 66,
      accum: false,
      income: 50000,
      rmd: 0,
      essential: 40000,
      goals: 0,
      tax: 5000,
      draw: 0,
      ret: 0.04,
      wdRate: 4,
      ending: 900000,
      shortfall: false,
      startPort: 1000000,
      goalTag: null
    };
    const raw = {
      res: {
        typicalPathFederalTax: {
          years: [{
            year: 2026,
            age: 66,
            federalTaxLiability: 4500
          }],
          totals: {
            federalTaxLiability: 4500,
            enginePathTax: 5000,
            deltaVsEnginePath: -500
          },
          scope: 'INCOME_TAX_ONLY',
          warnings: [{
            code: 'VERIFY_WARNING',
            message: 'A supplied tax fact needs review.'
          }]
        }
      }
    };
    const scn = {
      raw,
      id: '0',
      name: 'Baseline',
      tone: '#c6a662',
      prob: 80,
      probStr: '80',
      median: '$900K'
    };
    const deps = {
      pathRows: () => [row],
      cashSummary: () => ({}),
      cashFromRetirement: false,
      isTypicalPath: () => true,
      typicalPathFederalTax: s => s.res.typicalPathFederalTax,
      toneGlow: () => 'transparent',
      ring: () => '',
      wdColor: () => 'inherit',
      num: n => String(n),
      esc: value => String(value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]),
      fmtMoney: n => '$' + Math.round(n).toLocaleString('en-US'),
      cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending']
    };
    const inspect = () => {
      const host = document.createElement('div');
      host.innerHTML = renderCashflow(scn, [scn], deps);
      return {
        state: host.querySelector('[data-tax-disclosure]')?.dataset.taxState || '',
        warning: host.querySelector('[data-tax-warnings] li')?.textContent.trim() || '',
        fallback: host.querySelector('[data-tax-fallback]')?.textContent.trim() || '',
        source: host.querySelector('.cf-th[data-tax-source]')?.dataset.taxSource || ''
      };
    };
    const warned = inspect();
    raw.res.typicalPathFederalTax = null;
    const failed = inspect();
    return {
      warned,
      failed
    };
  });
  if (disclosureStates.warned.state !== 'federal-sidecar' || disclosureStates.warned.warning !== 'A supplied tax fact needs review.') throw new Error(`sidecar warnings were not surfaced: ${JSON.stringify(disclosureStates)}`);
  if (disclosureStates.failed.state !== 'engine-fallback' || disclosureStates.failed.source !== 'engine' || !/tax column uses engine estimates/i.test(disclosureStates.failed.fallback)) throw new Error(`sidecar attach-failure fallback is unclear: ${JSON.stringify(disclosureStates)}`);
  await page.screenshot({
    path: join(OUT, '04-cashflow.png'),
    fullPage: true
  });
}

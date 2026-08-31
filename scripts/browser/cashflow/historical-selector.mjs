export async function verifyHistoricalSelector({
  page
}) {
  const pathReplayBefore = await page.evaluate(() => localStorage.getItem('parallax.pathReplay.v1'));
  const selectorContract = await page.evaluate(() => {
    const selectors = [...document.querySelectorAll('#cashflow-path-mode')];
    const select = selectors[0] ?? null;
    return {
      selectorCount: selectors.length,
      options: select ? [...select.options].map(option => ({
        value: option.value,
        label: option.textContent.trim().replace(/^[✓!]\s+/, '')
      })) : [],
      oldSelectorCount: document.querySelectorAll('#path-mode').length,
      indexInputCount: document.querySelectorAll('#path-index').length,
      seedInputCount: document.querySelectorAll('#path-seed').length,
      regenerateCount: document.querySelectorAll('#cashflow-path-regenerate').length,
      persistedSeed: (() => {
        try {
          const value = JSON.parse(localStorage.getItem('parallax.pathReplay.v1') || '{}');
          return Object.prototype.hasOwnProperty.call(value, 'seed');
        } catch {
          return true;
        }
      })()
    };
  });
  const expectedPathOptions = [{
    value: 'typical',
    label: 'Typical path'
  }, {
    value: 'historical-1929',
    label: '1929 · Great Depression'
  }, {
    value: 'historical-1937',
    label: '1937 · Double-Dip Recession'
  }, {
    value: 'historical-1966',
    label: '1966 · Lost Decade'
  }, {
    value: 'historical-1973',
    label: '1973 · Stagflation'
  }, {
    value: 'historical-1995',
    label: '1995 · 90s Boom'
  }, {
    value: 'historical-2000',
    label: '2000 · Dot-com Crash'
  }, {
    value: 'historical-2008',
    label: '2008 · Financial Crisis'
  }, {
    value: 'historical-2009',
    label: '2009 · Recovery Bull'
  }, {
    value: 'historical-2022',
    label: '2022 · Inflation & Rate Shock'
  }];
  if (selectorContract.selectorCount !== 1 || JSON.stringify(selectorContract.options) !== JSON.stringify(expectedPathOptions)) {
    throw new Error(`Cash Flow path registry mismatch: ${JSON.stringify({
      expected: expectedPathOptions,
      observed: selectorContract
    })}`);
  }
  if (selectorContract.oldSelectorCount || selectorContract.indexInputCount || selectorContract.seedInputCount) throw new Error(`Cash Flow still exposes old replay controls: ${JSON.stringify(selectorContract)}`);
  if (selectorContract.persistedSeed) throw new Error('the session Monte Carlo seed is still persisted');
  if (selectorContract.regenerateCount !== 0) throw new Error(`Cash Flow still exposes a Regenerate control: ${JSON.stringify(selectorContract)}`);
  return {
    pathReplayBefore
  };
}

export async function setCashFlow(page, open = true) {
  await page.evaluate(wantOpen => {
    const chip = document.querySelector('#scn-cash-toggle');
    const isOn = !!chip?.classList.contains('is-on');
    if (isOn !== wantOpen) chip?.click();
  }, open);
  await page.waitForFunction(wantOpen => {
    const chip = document.querySelector('#scn-cash-toggle');
    const isOn = !!chip?.classList.contains('is-on');
    const cashFlowVisible = !!document.querySelector('#scn-view .cf');
    return isOn === wantOpen && cashFlowVisible === wantOpen;
  }, {
    timeout: 8000
  }, open);
}
export async function waitCashRows(page, min = 1, ms = 8000) {
  await page.waitForFunction(expected => document.querySelectorAll('#scn-view .cf-row').length >= expected, {
    timeout: ms
  }, min);
  return page.evaluate(() => document.querySelectorAll('#scn-view .cf-row').length);
}
export async function cashFlowSessionSnapshot(page, {
  bundleSentinel = null,
  rememberBundle = false,
  includeBundleIdentity = false
} = {}) {
  return page.evaluate(async options => {
    const state = await import('./src/state.js');
    const sentinels = globalThis.__parallaxVerifySharedPathSentinels || (globalThis.__parallaxVerifySharedPathSentinels = Object.create(null));
    if (options.bundleSentinel && options.rememberBundle) {
      sentinels[options.bundleSentinel] = state.sharedPaths;
    }
    const sameBundleObject = options.bundleSentinel ? Object.prototype.hasOwnProperty.call(sentinels, options.bundleSentinel) && sentinels[options.bundleSentinel] === state.sharedPaths : null;
    const analyses = state.scenarios.map(scenario => {
      const result = scenario?.res;
      if (!result) return null;
      return {
        projectionStatus: result.projectionStatus,
        issue: result.issue,
        successRate: result.successRate,
        terminal: result.terminal,
        envelope: result.envelope,
        selectedPathIndices: Object.fromEntries(Object.entries(result.paths || {}).map(([key, path]) => [key, path?.simIndex ?? null])),
        returnSeriesProvenance: result.returnSeriesProvenance,
        assumptions: result.assumptions,
        survived: result.survived,
        total: result.total,
        medianCagr: result.medianCagr,
        horizonYears: result.horizonYears,
        iterations: result.iterations,
        params: result.params,
        medianLifetimeTax: result.medianLifetimeTax,
        metrics: result.metrics
      };
    });
    let bundleIdentityHash = null;
    if (options.includeBundleIdentity) {
      const sourceYearSequences = (state.sharedPaths || []).map(path => path.map(row => Number.isInteger(row?.y) ? row.y : null));
      const bytes = new TextEncoder().encode(JSON.stringify(sourceYearSequences));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      bundleIdentityHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    return {
      seed: state.pathReplay.seed,
      sameBundleObject,
      bundleIdentityHash,
      bundleCount: state.sharedPaths?.length ?? 0,
      bundleHorizon: state.sharedPaths?.[0]?.length ?? 0,
      aggregateBytes: JSON.stringify(analyses),
      probabilityRangeEnvelopeBytes: JSON.stringify(analyses.map(analysis => analysis && {
        successRate: analysis.successRate,
        terminal: analysis.terminal,
        envelope: analysis.envelope
      })),
      successRates: state.scenarios.map(scenario => scenario?.res?.successRate ?? null),
      trialCounts: state.scenarios.map(scenario => scenario?.res?.sims?.length ?? 0),
      typicalIndices: state.scenarios.map(scenario => scenario?.res?.paths?.p50?.simIndex ?? null)
    };
  }, {
    bundleSentinel,
    rememberBundle,
    includeBundleIdentity
  });
}
export async function waitForCashFlowPath(page, {
  pathId,
  kind = null,
  sourceYear = null,
  requireHistoricalSummary = false,
  timeout = 20000
}) {
  const expected = {
    pathId,
    kind,
    sourceYear,
    requireHistoricalSummary
  };
  try {
    await page.waitForFunction(want => {
      const selectors = document.querySelectorAll('#cashflow-path-mode');
      const roots = document.querySelectorAll('#scn-view .cf');
      if (selectors.length !== 1 || roots.length !== 1) return false;
      const select = selectors[0];
      const root = roots[0];
      const firstRetirement = root.querySelector('.cf-row[data-phase="retirement"]');
      const summary = root.querySelector('[data-cash-path-metrics]');
      return select.value === want.pathId && root.dataset.cashPathId === want.pathId && (!want.kind || root.dataset.cashPathKind === want.kind) && (want.sourceYear === null || Number(firstRetirement?.dataset.sourceYear) === want.sourceYear) && (!want.requireHistoricalSummary || ['underfunded', 'survives'].includes(summary?.dataset.outcome));
    }, {
      timeout
    }, expected);
  } catch (error) {
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
        firstRetirementSourceYear: root?.querySelector('.cf-row[data-phase="retirement"]')?.dataset.sourceYear ?? null,
        summaryOutcome: root?.querySelector('[data-cash-path-metrics]')?.dataset.outcome ?? null,
        regenerateCount: document.querySelectorAll('#cashflow-path-regenerate').length,
        status: document.querySelector('#status')?.textContent.trim() ?? null
      };
    });
    throw new Error(`Cash Flow path readiness timed out: ${JSON.stringify({
      expected,
      observed
    })}; ${error.message || error}`, { cause: error });
  }
}

import { selectHouseholdVisible } from '../../wizard-browser-contract.mjs';
import { waitForUnselectedWizard } from '../../wizard-browser-contract.mjs';
export async function verifyHistoricalReload({
  stableClick,
  page,
  setCashFlow,
  waitForCashFlowPath,
  cashFlowSessionSnapshot,
  reloadExpected,
  stableReload,
  pathReplayBefore
}) {
  const historicalReloadHouseholdId = 'future-household';
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, historicalReloadHouseholdId);
  await page.waitForFunction(() => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  });
  await stableClick('button[data-page="scenarios"]');
  await setCashFlow(page, true);
  await waitForCashFlowPath(page, {
    pathId: 'historical-1995',
    kind: 'historical',
    sourceYear: 1995,
    requireHistoricalSummary: true,
    timeout: 30000
  });
  const historicalReloadSessionBefore = await cashFlowSessionSnapshot(page, {
    includeBundleIdentity: true
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
      shortfall: Number(row.dataset.fundingShortfall)
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
        planYear: metric.dataset.planYear === '' || metric.dataset.planYear === undefined ? null : Number(metric.dataset.planYear)
      })),
      summary: summary ? {
        outcome: summary.dataset.outcome || ''
      } : null,
      retirementAges: retirementRows.map(row => row.age)
    };
  });
  if (!reloadExpected) throw new Error('historical reload checkpoint was not captured');
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForUnselectedWizard(page);
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, historicalReloadHouseholdId);
  await page.waitForFunction(() => /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  });
  await page.click('button[data-page="scenarios"]');
  await setCashFlow(page, true);
  await waitForCashFlowPath(page, {
    pathId: reloadExpected.mode,
    kind: 'historical',
    sourceYear: reloadExpected.sourceYear,
    requireHistoricalSummary: true,
    timeout: 30000
  });
  const sessionAfterReload = await cashFlowSessionSnapshot(page, {
    includeBundleIdentity: true
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
      shortfall: Number(row.dataset.fundingShortfall)
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
          planYear: metric.dataset.planYear === '' || metric.dataset.planYear === undefined ? null : Number(metric.dataset.planYear)
        })),
        rows: retirementRows,
        summary: summary ? {
          outcome: summary.dataset.outcome || ''
        } : null,
        retirementAges: retirementRows.map(row => row.age)
      },
      persisted: JSON.parse(localStorage.getItem('parallax.cashFlowPath.v1') || '{}'),
      pathReplay: localStorage.getItem('parallax.pathReplay.v1'),
      regenerateCount: document.querySelectorAll('#cashflow-path-regenerate').length
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
      thisPath: metric.thisPath
    })),
    rows: snapshot.rows.map(row => ({
      planYear: row.planYear,
      age: row.age,
      sourceYear: row.sourceYear,
      startBalance: row.startBalance,
      endingBalance: row.endingBalance,
      wdRate: row.wdRate,
      shortfall: row.shortfall
    })),
    summary: snapshot.summary,
    retirementAges: snapshot.retirementAges
  });
  if (JSON.stringify(historicalContract(reloadedHistorical.snapshot)) !== JSON.stringify(historicalContract(reloadExpected)) || reloadedHistorical.persisted?.id !== reloadExpected.mode || reloadedHistorical.pathReplay !== pathReplayBefore || reloadedHistorical.regenerateCount !== 0) {
    throw new Error(`Historical selection/generation contract changed across reload: ${JSON.stringify({
      reloadExpected,
      reloadedHistorical
    })}`);
  }
  if (sessionAfterReload.seed === historicalReloadSessionBefore.seed || sessionAfterReload.bundleIdentityHash === historicalReloadSessionBefore.bundleIdentityHash) {
    throw new Error(`household reload reused the previous session seed or Monte Carlo bundle: ${JSON.stringify({
      before: historicalReloadSessionBefore,
      after: sessionAfterReload
    })}`);
  }
  await page.select('#cashflow-path-mode', 'typical');
  await waitForCashFlowPath(page, {
    pathId: 'typical',
    kind: 'typical',
    timeout: 20000
  });
  const restoredTypical = await page.evaluate(() => {
    const th = document.querySelector('#scn-view .cf-table__head .cf-th[data-tax-source]');
    return {
      header: th ? {
        label: th.textContent.trim(),
        source: th.dataset.taxSource || ''
      } : null,
      stats: [...document.querySelectorAll('#scn-view .cf-stat__label')].map(label => label.textContent.trim()),
      statusGlyph: document.querySelector('#cashflow-path-status')?.textContent.trim() || '',
      persisted: JSON.parse(localStorage.getItem('parallax.cashFlowPath.v1') || '{}'),
      pathReplay: localStorage.getItem('parallax.pathReplay.v1')
    };
  });
  if (restoredTypical.header?.label !== 'Tax' || restoredTypical.header?.source !== 'federal-converged-row') throw new Error(`Typical tax scope did not restore: ${JSON.stringify(restoredTypical)}`);
  if (JSON.stringify(restoredTypical.stats) !== JSON.stringify(['Funded through', 'Ending position']) || restoredTypical.statusGlyph || restoredTypical.stats.some(label => /Probability|Federal total|Median Ending/i.test(label))) throw new Error(`Typical baseline summary did not restore: ${JSON.stringify(restoredTypical)}`);
  if (restoredTypical.persisted?.id !== 'typical' || restoredTypical.pathReplay !== pathReplayBefore) throw new Error(`Typical persistence disturbed replay state: ${JSON.stringify(restoredTypical)}`);
  if (await page.evaluate(() => !!document.querySelector('#scn-view [data-tax-compare]'))) throw new Error('obsolete federal-vs-engine summary restored on Typical');
  if (await page.evaluate(() => !!document.querySelector('#scn-view [data-tax-scope-disclosure], #scn-view [data-tax-disclosure]'))) throw new Error('removed federal scope/status copy restored on Typical');
}

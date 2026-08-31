import { readHistoricalPeriod } from './historical-snapshot.mjs';
import { verifyHistoricalPresentation } from './historical-presentation.mjs';
import { verifyHistoricalMetrics } from './historical-metrics.mjs';
import { join } from 'node:path';
export async function verifyHistoricalPeriods({
  page,
  waitForCashFlowPath,
  pathReplayBefore,
  typicalRowsByPlanYear,
  OUT
}) {
  const observedHistoricalOutcomes = new Set();
  for (const [mode, startYear, periodName, expectedOutcome] of [['historical-1973', 1973, 'Stagflation', 'survives'], ['historical-1995', 1995, '90s Boom', 'survives']]) {
    const {
      historicalPath
    } = await readHistoricalPeriod({
      page,
      mode,
      waitForCashFlowPath,
      startYear
    });
    const {
      shortfallRows,
      lastRetirement
    } = verifyHistoricalPresentation({
      historicalPath,
      mode,
      expectedOutcome,
      observedHistoricalOutcomes,
      pathReplayBefore,
      startYear,
      periodName
    });
    verifyHistoricalMetrics({
      historicalPath,
      typicalRowsByPlanYear,
      mode
    });
    if (historicalPath.summary.outcome === 'underfunded') {
      if (shortfallRows.length !== 1 || shortfallRows[0] !== lastRetirement || historicalPath.statusGlyph !== '!' || !/is-underfunded/.test(historicalPath.statusClass) || historicalPath.statusColor !== historicalPath.expectedStatusColor || !/Underfunded/i.test(lastRetirement.endingText)) {
        throw new Error(`${mode} underfunded outcome boundary is incomplete: ${JSON.stringify(historicalPath)}`);
      }
    } else if (shortfallRows.length !== 0 || historicalPath.statusGlyph !== '✓' || !/is-success/.test(historicalPath.statusClass) || historicalPath.statusColor !== historicalPath.expectedStatusColor) {
      throw new Error(`${mode} surviving outcome boundary is incomplete: ${JSON.stringify(historicalPath)}`);
    }
    await page.screenshot({
      path: join(OUT, `04-cashflow-${mode}.png`),
      fullPage: true
    });
  }
  return {
    observedHistoricalOutcomes
  };
}

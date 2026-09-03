export async function verifyCashFlowScenarioSelection({
  page,
  m,
  retirementStartAge
}) {
  const scenarioBValue = await page.evaluate(() => {
    const option = [...document.querySelectorAll('#scn-view [data-cash-select] option')].find(item => /Scenario B/.test(item.textContent));
    return option?.value || '';
  });
  if (!scenarioBValue) throw new Error(`Scenario B option not found among ${JSON.stringify(m.scenarioOptions)}`);
  await page.select('#scn-view [data-cash-select]', scenarioBValue);
  await page.waitForFunction(() => {
    const active = document.querySelector('#scn-view [data-cash-select]')?.selectedOptions?.[0]?.textContent || '';
    const marker = document.querySelector('#scn-view .cf-row__mark-dot--ret')?.closest('.cf-row');
    return /Scenario B/.test(active) && marker?.dataset.age === '68';
  }, {
    timeout: 10000
  });
  const bActive = await page.evaluate(() => document.querySelector('#scn-view [data-cash-select]')?.selectedOptions?.[0]?.textContent.trim() || '');
  if (!/Scenario B/.test(bActive)) throw new Error(`Cash Flow selector did not switch to Scenario B (got "${bActive}")`);
  const bMarker = await retirementStartAge();
  if (bMarker !== '68') throw new Error(`Scenario B retirement start not at age 68 (got "${bMarker}")`);
  // Restore Baseline for the historical-path checks below.
  const baselineValue = await page.evaluate(() => {
    const option = [...document.querySelectorAll('#scn-view [data-cash-select] option')].find(item => /Baseline/.test(item.textContent));
    return option?.value || '';
  });
  if (!baselineValue) throw new Error('Baseline option missing from Cash Flow scenario selector');
  await page.select('#scn-view [data-cash-select]', baselineValue);
  await page.waitForFunction(() => {
    const active = document.querySelector('#scn-view [data-cash-select]')?.selectedOptions?.[0]?.textContent || '';
    const marker = document.querySelector('#scn-view .cf-row__mark-dot--ret')?.closest('.cf-row');
    return /Baseline/.test(active) && marker?.dataset.age === '66';
  }, {
    timeout: 10000
  });
  const retirementOnly = await page.evaluate(() => document.querySelector('#scn-view [data-cash-retstart]')?.getAttribute('aria-pressed') === 'true');
  if (retirementOnly) throw new Error('historical metric plan-year proof requires visible accumulation rows');
  const typicalRowsByPlanYear = await page.evaluate(() => [...document.querySelectorAll('#scn-view .cf-row')].map((row, index) => ({
    planYear: index + 1,
    age: Number(row.dataset.age),
    livingAge: row.dataset.livingAge === '' ? null : Number(row.dataset.livingAge),
    year: Number(row.querySelector('.cf-row__year')?.textContent.trim()),
    phase: row.dataset.phase || '',
    sourceYear: row.dataset.sourceYear === '' ? null : Number(row.dataset.sourceYear),
    startBalance: Number(row.dataset.startBalance),
    endingBalance: Number(row.dataset.endingBalance),
    withdrawal: Number(row.dataset.withdrawal),
    wdRate: Number(row.dataset.wdRate),
    effectiveWdRate: Number(row.dataset.effectiveWdRate),
    returnRate: Number(row.dataset.returnRate),
    shortfall: Number(row.dataset.fundingShortfall)
  })));
  return {
    typicalRowsByPlanYear
  };
}

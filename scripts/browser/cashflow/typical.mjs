export async function verifyTypicalCashFlow({
  page,
  SKIP_SEQUENCING
}) {
  const EXPECT = ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'];
  const m = await page.evaluate(() => {
    const v = document.querySelector('#scn-view');
    return {
      cf: !!v?.querySelector('.cf'),
      rows: v?.querySelectorAll('.cf-row').length || 0,
      cols: [...(v?.querySelectorAll('.cf-table__head .cf-th') || [])].map(th => th.textContent.trim()),
      scenarioOptions: [...(v?.querySelectorAll('[data-cash-select] option') || [])].map(option => ({
        value: option.value,
        label: option.textContent.trim()
      })),
      activeScenario: v?.querySelector('[data-cash-select]')?.selectedOptions?.[0]?.textContent.trim() || '',
      stats: [...(v?.querySelectorAll('.cf-stat__label') || [])].map(s => s.textContent.trim()),
      summaryMetrics: [...(v?.querySelectorAll('[data-cash-header-metric]') || [])].map(metric => ({
        id: metric.dataset.cashHeaderMetric || '',
        label: metric.querySelector('.cf-stat__label')?.textContent.trim() || '',
        value: metric.querySelector('.cf-stat__value')?.textContent.trim() || '',
        support: metric.querySelector('.cf-stat__support')?.textContent.trim() || ''
      })),
      pathControls: !!v?.querySelector('#scn-cf-path-controls #cashflow-path-mode'),
      mode: v?.querySelector('#scn-cf-path-controls #cashflow-path-mode')?.value || '',
      taxHeader: (() => {
        const th = v?.querySelector('.cf-table__head .cf-th[data-tax-source]');
        return th ? {
          label: th.textContent.trim(),
          source: th.dataset.taxSource || '',
          scope: th.dataset.taxScope || '',
          title: th.getAttribute('title') || ''
        } : null;
      })(),
      taxCompare: (() => {
        const el = v?.querySelector('[data-tax-compare]');
        return el ? {
          federalTotal: Number(el.dataset.federalTotal),
          enginePathTotal: Number(el.dataset.enginePathTotal),
          delta: Number(el.dataset.delta),
          labels: [...el.querySelectorAll('.cf-stat__label')].map(label => label.textContent.trim()),
          values: [...el.querySelectorAll('.cf-stat__value')].map(value => value.textContent.trim())
        } : null;
      })(),
      federalTotal: (() => {
        const el = v?.querySelector('.cf-stat--federal[data-federal-total]');
        return el ? {
          amount: Number(el.dataset.federalTotal),
          label: el.querySelector('.cf-stat__label')?.textContent.trim() || '',
          value: el.querySelector('.cf-stat__value')?.textContent.trim() || ''
        } : null;
      })(),
      taxDisclosure: (() => {
        const el = v?.querySelector('[data-tax-disclosure]');
        return el ? {
          state: el.dataset.taxState || '',
          fallback: el.querySelector('[data-tax-fallback]')?.textContent.trim() || '',
          warnings: [...el.querySelectorAll('[data-tax-warnings] li')].map(item => item.textContent.trim())
        } : null;
      })(),
      accumTax: (() => {
        const row = [...(v?.querySelectorAll('.cf-row') || [])].find(el => el.querySelector('.cf-cell--age')?.textContent.trim() === '64');
        return row?.querySelector('.cf-cell--tax')?.textContent.trim() || '';
      })(),
      ledgerTypography: (() => {
        const head = v?.querySelector('.cf-table__head');
        const heading = head?.querySelector('.cf-th');
        const row = v?.querySelector('.cf-row');
        const cell = row?.querySelector('.cf-cell:not(.cf-cell--age):not(.cf-cell--zero)');
        if (!head || !heading || !row || !cell) return null;
        const headStyle = getComputedStyle(head);
        const headingStyle = getComputedStyle(heading);
        const rowStyle = getComputedStyle(row);
        const cellStyle = getComputedStyle(cell);
        const tokenColor = token => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          document.body.appendChild(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return {
          headerFontSize: headingStyle.fontSize,
          headerLineHeight: headingStyle.lineHeight,
          headerLetterSpacing: headingStyle.letterSpacing,
          headerColor: headingStyle.color,
          headPadding: headStyle.padding,
          rowFontSize: rowStyle.fontSize,
          rowLineHeight: rowStyle.lineHeight,
          rowPadding: rowStyle.padding,
          rowHeight: row.getBoundingClientRect().height,
          rowBorderColor: rowStyle.borderTopColor,
          columnGap: rowStyle.columnGap,
          cellColor: cellStyle.color,
          expectedInkColor: tokenColor('--ink'),
          expectedRuleColor: tokenColor('--rule')
        };
      })(),
      hasCaption: !!v?.querySelector('.cf__caption'),
      hasCfEyebrow: !!v?.querySelector('.cf__head .eyebrow'),
      hasSummaryName: !!v?.querySelector('.cf-summary__name'),
      hasProbability: /Probability of success/i.test(v?.querySelector('.cf-summary')?.textContent || ''),
      hasRemovedHelperCopy: /All figures in today's dollars|One historical sequence, not a probability/i.test(v?.textContent || '')
    };
  });
  if (!m.cf) throw new Error('cash-flow view did not render');
  if (m.rows < 10) throw new Error(`cash-flow rows = ${m.rows} (expected >=10)`);
  if (JSON.stringify(m.cols) !== JSON.stringify(EXPECT)) throw new Error(`cash-flow columns are not the exact contract: ${JSON.stringify(m.cols)}`);
  const ledgerTypography = m.ledgerTypography;
  if (!ledgerTypography || ledgerTypography.headerFontSize !== '12px' || ledgerTypography.headerLineHeight !== '15.6px' || ledgerTypography.headerLetterSpacing !== '0.72px' || ledgerTypography.headerColor !== ledgerTypography.expectedInkColor || ledgerTypography.headPadding !== '20px 24px 10px' || ledgerTypography.rowFontSize !== '14px' || ledgerTypography.rowLineHeight !== '20px' || ledgerTypography.rowPadding !== '7px 24px' || ledgerTypography.rowHeight > 36 || ledgerTypography.rowBorderColor !== ledgerTypography.expectedRuleColor || ledgerTypography.columnGap !== '8px' || ledgerTypography.cellColor !== ledgerTypography.expectedInkColor) {
    throw new Error(`Cash Flow ledger readability contract drifted: ${JSON.stringify(ledgerTypography)}`);
  }
  if (m.cols.filter(c => /tax/i.test(c)).length !== 1) throw new Error(`cash flow must have exactly one scoped tax column: ${JSON.stringify(m.cols)}`);
  if (m.taxHeader?.source !== 'federal-converged-row' || m.taxHeader?.scope !== 'MODELED_FEDERAL_LINE_24') throw new Error(`typical path converged tax scope missing: ${JSON.stringify(m.taxHeader)}`);
  if (!/retirement rows funded and converged; working years reporting-only/i.test(m.taxHeader?.title || '')) throw new Error(`typical path tax tooltip missing phase scope: ${JSON.stringify(m.taxHeader)}`);
  if (m.taxCompare) throw new Error(`obsolete federal-vs-engine comparison is still shown: ${JSON.stringify(m.taxCompare)}`);
  if (m.taxDisclosure) throw new Error(`normal Cash Flow should not show federal scope or status copy: ${JSON.stringify(m.taxDisclosure)}`);
  if (!/^\$[\d,]+/.test(m.accumTax)) throw new Error(`accumulation-year Tax cell is not populated: "${m.accumTax}"`);
  if (m.cols.some(c => ['Withdraw', 'One-time', 'Return $', 'Starting value', 'Inflows', 'Outflows', 'Annual return', 'Ending value'].includes(c))) throw new Error(`old cash-flow columns still present: ${JSON.stringify(m.cols)}`);
  if (m.scenarioOptions.length < 2) throw new Error(`Cash Flow scenario selector options missing: ${JSON.stringify(m.scenarioOptions)}`);
  if (!/Baseline/.test(m.activeScenario)) throw new Error(`Cash Flow scenario selector did not start on Baseline: ${JSON.stringify(m)}`);
  if (!SKIP_SEQUENCING && !m.pathControls) throw new Error('Cash Flow path controls not relocated into #scn-cf-path-controls');
  if (!SKIP_SEQUENCING && m.mode !== 'typical') throw new Error(`Cash Flow default path not Typical (${m.mode})`);
  for (const label of ['Funded through', 'Ending position']) {
    if (!m.stats.includes(label)) throw new Error(`cash-flow summary stat missing: ${label} (${JSON.stringify(m.stats)})`);
  }
  if (JSON.stringify(m.summaryMetrics.map(metric => metric.id)) !== JSON.stringify(['funded-through', 'ending-position'])) throw new Error(`Typical Cash Flow metric contract drifted: ${JSON.stringify(m.summaryMetrics)}`);
  if (m.summaryMetrics[0]?.support !== 'Plan end' || m.summaryMetrics[1]?.support !== 'Median path') throw new Error(`Typical Cash Flow metric support drifted: ${JSON.stringify(m.summaryMetrics)}`);
  if (m.hasProbability || m.stats.some(label => ['Probability of success', 'Median Ending', 'Federal total'].includes(label)) || m.federalTotal) throw new Error(`removed Cash Flow summary content returned: ${JSON.stringify(m)}`);
  if (m.hasRemovedHelperCopy) throw new Error('removed Cash Flow helper copy returned');
  // Lifetime Draw / Funds Last were removed from the summary strip — stay gone.
  if (m.stats.some(s => /lifetime draw|funds last/i.test(s))) throw new Error(`removed summary stat still present: ${JSON.stringify(m.stats)}`);
  if (m.hasCaption) throw new Error('cash-flow caption should be removed');
  if (m.hasCfEyebrow) throw new Error('redundant Cash Flow eyebrow still in cf header');
  if (m.hasSummaryName) throw new Error('redundant scenario name still in summary strip');
  if (await page.evaluate(() => !!document.querySelector('#scn-view .cf-phase__name'))) throw new Error('phase header labels should be removed');

  // Retirement start = filled dot on the year column of the first non-accum row.
  const retirementStartAge = () => page.evaluate(() => {
    const row = document.querySelector('#scn-view .cf-row__mark-dot--ret')?.closest('.cf-row');
    return row ? row.querySelector('.cf-cell--age')?.textContent.trim() || '' : '';
  });
  const retireAge = await retirementStartAge();
  if (retireAge !== '66') throw new Error(`baseline retirement start not at age 66 (got "${retireAge}")`);
  const rmdBoundary = await page.evaluate(async () => {
    const {
      scenarios
    } = await import('./src/state.js');
    const baselines = scenarios.filter(scenario => scenario.base);
    const views = document.querySelectorAll('#scn-view .cf');
    if (baselines.length !== 1 || views.length !== 1) {
      throw new Error('RMD boundary proof requires one Baseline and one Cash Flow view');
    }
    const view = views[0];
    const simulation = baselines[0].res?.paths?.p50;
    if (!Array.isArray(simulation?.rows) || view.dataset.simIndex !== String(simulation.simIndex)) {
      throw new Error('RMD boundary proof must use the displayed Baseline Typical simulation');
    }
    const visibleRows = [...view.querySelectorAll('.cf-row')];
    const visibleAges = new Set(visibleRows.map(row => row.dataset.age));
    const engineRows = simulation.rows.filter(row => visibleAges.has(String(row.age)));
    const firstRequired = engineRows.find(row => row.rmdRequired > 0);
    if (!firstRequired) throw new Error('RMD boundary fixture must contain an engine-required RMD');
    const firstRetirement = engineRows.find(row => row.phase !== 'accum');
    return {
      engineAge: String(firstRequired.age),
      displayedAge: visibleRows.find(row => row.children[3].textContent.trim())?.dataset.age ?? null,
      markerAges: [...view.querySelectorAll('.cf-row__mark-dot--rmd')].map(marker => marker.closest('.cf-row').dataset.age),
      expectedMarkerAges: firstRequired.age === firstRetirement?.age ? [] : [String(firstRequired.age)]
    };
  });
  if (rmdBoundary.displayedAge !== rmdBoundary.engineAge || JSON.stringify(rmdBoundary.markerAges) !== JSON.stringify(rmdBoundary.expectedMarkerAges)) {
    throw new Error(`RMD column and marker must follow the first engine-required RMD: ${JSON.stringify(rmdBoundary)}`);
  }
  return {
    m,
    retirementStartAge
  };
}

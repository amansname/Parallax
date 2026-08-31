export async function readHistoricalPeriod({
  page,
  mode,
  waitForCashFlowPath,
  startYear
}) {
  await page.select('#cashflow-path-mode', mode);
  await waitForCashFlowPath(page, {
    pathId: mode,
    kind: 'historical',
    sourceYear: startYear,
    requireHistoricalSummary: true,
    timeout: 20000
  });
  const historicalPath = await page.evaluate(() => {
    const th = document.querySelector('#scn-view .cf-table__head .cf-th[data-tax-source]');
    const disclosure = document.querySelector('#scn-view [data-tax-disclosure]');
    const root = document.querySelector('#scn-view .cf');
    const summary = document.querySelector('#scn-view [data-cash-path-metrics]');
    const rows = [...document.querySelectorAll('#scn-view .cf-row')].map((row, index) => ({
      planYear: index + 1,
      age: Number(row.dataset.age),
      year: Number(row.querySelector('.cf-row__year')?.textContent.trim()),
      phase: row.dataset.phase || '',
      sourceYear: row.dataset.sourceYear === '' ? null : Number(row.dataset.sourceYear),
      startBalance: Number(row.dataset.startBalance),
      endingBalance: Number(row.dataset.endingBalance),
      withdrawal: Number(row.dataset.withdrawal),
      wdRate: Number(row.dataset.wdRate),
      shortfall: Number(row.dataset.fundingShortfall),
      endingText: row.querySelector('.cf-cell--ending')?.textContent.trim() || ''
    }));
    const retirementRows = rows.filter(row => row.phase === 'retirement');
    const status = document.querySelector('#cashflow-path-status');
    const summaryOutcome = summary?.dataset.outcome || '';
    const tokenColor = token => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const normalizedStyle = (property, value) => {
      const probe = document.createElement('span');
      probe.style[property] = value;
      document.body.appendChild(probe);
      const normalized = getComputedStyle(probe)[property];
      probe.remove();
      return normalized;
    };
    const expectedStatusColor = tokenColor(summaryOutcome === 'survives' ? '--pos' : '--neg');
    const expectedAccentColor = tokenColor('--acc');
    const expectedNegativeColor = tokenColor('--neg');
    const expectedMutedColor = tokenColor('--muted');
    const expectedBodyColor = tokenColor('--body');
    const expectedInkColor = tokenColor('--ink');
    const expectedTitleTextShadow = normalizedStyle('textShadow', '0 0 10px rgba(177, 132, 92, .35)');
    const expectedSelectedBackgroundImage = normalizedStyle('backgroundImage', 'radial-gradient(130% 70% at 50% 0%, rgba(177, 132, 92, .055), rgba(177, 132, 92, 0) 72%)');
    const expectedSelectedBoxShadow = normalizedStyle('boxShadow', '0 0 22px rgba(177, 132, 92, .05), inset 0 0 0 1px rgba(177, 132, 92, .07)');
    const rail = summary;
    const panelBody = document.querySelector('#scn-view .cf-panel__body');
    const reference = rail?.querySelector('[data-cash-path-reference]');
    const referenceTitle = rail?.querySelector('.cf-path-rail__reference-title');
    const referenceLabel = rail?.querySelector('.cf-path-rail__reference-label');
    const referenceValue = rail?.querySelector('.cf-path-rail__reference-value');
    const selectedGroup = rail?.querySelector('[data-cash-path-selected]');
    const selectedPeriod = rail?.querySelector('[data-cash-path-selected-period]');
    const selectedPeriodYear = selectedPeriod?.querySelector('.cf-path-rail__selected-period-year');
    const selectedPeriodName = selectedPeriod?.querySelector('.cf-path-rail__selected-period-name');
    const selectedMetric = rail?.querySelector('.cf-path-rail__metric');
    const metricName = selectedMetric?.querySelector('.cf-path-rail__metric-name');
    const figure = selectedMetric?.querySelector('.cf-path-rail__figure');
    const delta = selectedMetric?.querySelector('.cf-path-rail__delta');
    const firstColumnLabel = document.querySelector('#scn-view .cf-table__head .cf-th');
    const styles = element => element ? getComputedStyle(element) : null;
    const railStyle = styles(rail);
    const referenceStyle = styles(reference);
    const titleStyle = styles(referenceTitle);
    const referenceLabelStyle = styles(referenceLabel);
    const referenceValueStyle = styles(referenceValue);
    const selectedGroupStyle = styles(selectedGroup);
    const selectedPeriodStyle = styles(selectedPeriod);
    const selectedPeriodYearStyle = styles(selectedPeriodYear);
    const selectedPeriodNameStyle = styles(selectedPeriodName);
    const selectedMetricStyle = styles(selectedMetric);
    const metricNameStyle = styles(metricName);
    const figureStyle = styles(figure);
    const deltaStyle = styles(delta);
    return {
      mode: document.querySelector('#cashflow-path-mode')?.value || '',
      rootMode: root?.dataset.cashPathId || '',
      kind: root?.dataset.cashPathKind || '',
      header: th ? {
        label: th.textContent.trim(),
        source: th.dataset.taxSource || '',
        scope: th.dataset.taxScope || ''
      } : null,
      compare: !!document.querySelector('#scn-view [data-tax-compare]'),
      disclosure: disclosure ? {
        state: disclosure.dataset.taxState || ''
      } : null,
      stats: [...document.querySelectorAll('#scn-view .cf-stat__label')].map(label => label.textContent.trim()),
      reference: [...document.querySelectorAll('#scn-view [data-path-reference-metric]')].map(metric => ({
        id: metric.dataset.pathReferenceMetric || '',
        label: metric.querySelector('.cf-path-rail__reference-label')?.textContent.trim() || '',
        value: metric.querySelector('.cf-path-rail__reference-value')?.textContent.trim() || ''
      })),
      metrics: [...document.querySelectorAll('#scn-view [data-historical-metric]')].map(metric => ({
        id: metric.dataset.historicalMetric || '',
        label: metric.querySelector('.cf-path-rail__metric-name')?.textContent.trim() || '',
        figure: metric.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
        deltaText: metric.querySelector('.cf-path-rail__delta')?.textContent.trim() || '',
        deltaTone: metric.dataset.deltaTone || '',
        deltaColor: getComputedStyle(metric.querySelector('.cf-path-rail__delta')).color,
        thisPath: metric.dataset.thisPath === '' ? null : Number(metric.dataset.thisPath),
        typicalPath: metric.dataset.typicalPath === '' ? null : Number(metric.dataset.typicalPath),
        delta: metric.dataset.delta === '' ? null : Number(metric.dataset.delta),
        format: metric.dataset.format || '',
        thisPathAge: metric.dataset.thisPathAge === undefined ? null : Number(metric.dataset.thisPathAge),
        typicalPathAge: metric.dataset.typicalPathAge === undefined ? null : Number(metric.dataset.typicalPathAge),
        thisPathRecoveryStatus: metric.dataset.thisPathRecoveryStatus || '',
        typicalPathRecoveryStatus: metric.dataset.typicalPathRecoveryStatus || '',
        thisPathMargin: metric.dataset.thisPathMargin === undefined ? null : Number(metric.dataset.thisPathMargin),
        typicalPathMargin: metric.dataset.typicalPathMargin === undefined ? null : Number(metric.dataset.typicalPathMargin),
        marginDelta: metric.dataset.marginDelta === undefined ? null : Number(metric.dataset.marginDelta),
        thisPathMarginKind: metric.dataset.thisPathMarginKind || '',
        typicalPathMarginKind: metric.dataset.typicalPathMarginKind || '',
        planEndAge: metric.dataset.planEndAge === undefined ? null : Number(metric.dataset.planEndAge),
        planYear: metric.dataset.planYear === '' || metric.dataset.planYear === undefined ? null : Number(metric.dataset.planYear)
      })),
      railLayout: rail && panelBody ? {
        gridDisplay: getComputedStyle(panelBody).display,
        gridTemplateColumns: getComputedStyle(panelBody).gridTemplateColumns,
        railWidth: rail.getBoundingClientRect().width,
        railDisplay: railStyle.display,
        railDirection: railStyle.flexDirection,
        railAlignItems: railStyle.alignItems,
        railGap: railStyle.gap,
        railPadding: railStyle.padding,
        railBorderLeftWidth: railStyle.borderLeftWidth,
        railBorderLeftStyle: railStyle.borderLeftStyle,
        railBackground: railStyle.backgroundColor,
        railRadius: railStyle.borderRadius,
        baselineDelta: referenceTitle && firstColumnLabel ? Math.abs(referenceTitle.getBoundingClientRect().top - firstColumnLabel.getBoundingClientRect().top) : null,
        reference: {
          display: referenceStyle?.display || '',
          direction: referenceStyle?.flexDirection || '',
          alignItems: referenceStyle?.alignItems || '',
          gap: referenceStyle?.gap || '',
          width: reference?.getBoundingClientRect().width ?? null,
          padding: referenceStyle?.padding || '',
          borderBottomWidth: referenceStyle?.borderBottomWidth || '',
          borderBottomStyle: referenceStyle?.borderBottomStyle || '',
          background: referenceStyle?.backgroundColor || '',
          radius: referenceStyle?.borderRadius || ''
        },
        title: {
          text: referenceTitle?.textContent.trim() || '',
          fontSize: titleStyle?.fontSize || '',
          fontWeight: titleStyle?.fontWeight || '',
          letterSpacing: titleStyle?.letterSpacing || '',
          color: titleStyle?.color || '',
          textShadow: titleStyle?.textShadow || '',
          textTransform: titleStyle?.textTransform || '',
          marginBottom: titleStyle?.marginBottom || '',
          expectedTextShadow: expectedTitleTextShadow
        },
        referenceLabel: {
          fontSize: referenceLabelStyle?.fontSize || '',
          lineHeight: referenceLabelStyle?.lineHeight || '',
          color: referenceLabelStyle?.color || ''
        },
        referenceValue: {
          fontSize: referenceValueStyle?.fontSize || '',
          color: referenceValueStyle?.color || '',
          whiteSpace: referenceValueStyle?.whiteSpace || ''
        },
        selected: {
          count: rail.querySelectorAll('[data-cash-path-selected]').length,
          display: selectedGroupStyle?.display || '',
          direction: selectedGroupStyle?.flexDirection || '',
          alignItems: selectedGroupStyle?.alignItems || '',
          gap: selectedGroupStyle?.gap || '',
          padding: selectedGroupStyle?.padding || '',
          radius: selectedGroupStyle?.borderRadius || '',
          backgroundImage: selectedGroupStyle?.backgroundImage || '',
          backgroundColor: selectedGroupStyle?.backgroundColor || '',
          boxShadow: selectedGroupStyle?.boxShadow || '',
          width: selectedGroup?.getBoundingClientRect().width ?? null,
          expectedBackgroundImage: expectedSelectedBackgroundImage,
          expectedBoxShadow: expectedSelectedBoxShadow
        },
        selectedPeriod: {
          count: rail.querySelectorAll('[data-cash-path-selected-period]').length,
          id: selectedPeriod?.dataset.cashPathSelectedPeriod || '',
          text: selectedPeriod?.textContent.trim() || '',
          year: selectedPeriodYear?.textContent.trim() || '',
          name: selectedPeriodName?.textContent.trim() || '',
          childIndex: selectedGroup && selectedPeriod ? [...selectedGroup.children].indexOf(selectedPeriod) : -1,
          padding: selectedPeriodStyle?.padding || '',
          borderBottomWidth: selectedPeriodStyle?.borderBottomWidth || '',
          borderBottomStyle: selectedPeriodStyle?.borderBottomStyle || '',
          background: selectedPeriodStyle?.backgroundColor || '',
          radius: selectedPeriodStyle?.borderRadius || '',
          fontSize: selectedPeriodStyle?.fontSize || '',
          fontWeight: selectedPeriodStyle?.fontWeight || '',
          lineHeight: selectedPeriodStyle?.lineHeight || '',
          letterSpacing: selectedPeriodStyle?.letterSpacing || '',
          textAlign: selectedPeriodStyle?.textAlign || '',
          fontVariantNumeric: selectedPeriodStyle?.fontVariantNumeric || '',
          yearColor: selectedPeriodYearStyle?.color || '',
          nameColor: selectedPeriodNameStyle?.color || ''
        },
        metric: {
          display: selectedMetricStyle?.display || '',
          direction: selectedMetricStyle?.flexDirection || '',
          alignItems: selectedMetricStyle?.alignItems || '',
          textAlign: selectedMetricStyle?.textAlign || '',
          width: selectedMetric?.getBoundingClientRect().width ?? null,
          gap: selectedMetricStyle?.gap || '',
          nameFontSize: metricNameStyle?.fontSize || '',
          nameLineHeight: metricNameStyle?.lineHeight || '',
          nameColor: metricNameStyle?.color || '',
          figureFontSize: figureStyle?.fontSize || '',
          figureFontWeight: figureStyle?.fontWeight || '',
          figureColor: figureStyle?.color || '',
          figureWhiteSpace: figureStyle?.whiteSpace || '',
          deltaFontSize: deltaStyle?.fontSize || ''
        },
        dividerMetrics: [...rail.querySelectorAll('.cf-path-rail__metric')].slice(1).map(metric => {
          const style = getComputedStyle(metric);
          return {
            paddingTop: style.paddingTop,
            borderTopWidth: style.borderTopWidth,
            borderTopStyle: style.borderTopStyle
          };
        }),
        directChildBackgrounds: [...rail.children].map(child => getComputedStyle(child).backgroundColor),
        directChildRadii: [...rail.children].map(child => getComputedStyle(child).borderRadius),
        accentColor: expectedAccentColor,
        negativeColor: expectedNegativeColor,
        mutedColor: expectedMutedColor,
        bodyColor: expectedBodyColor,
        inkColor: expectedInkColor,
        figureColors: [...rail.querySelectorAll('.cf-path-rail__figure')].map(item => getComputedStyle(item).color),
        deltaColors: [...rail.querySelectorAll('.cf-path-rail__delta')].map(item => getComputedStyle(item).color),
        sentenceDeltaCopy: /(?:Dips|Recovers|less|more|Lasts just|Comparison unavailable)/i.test(rail.textContent || ''),
        oldSummaryCount: document.querySelectorAll('#scn-view .cf-summary--historical, #scn-view .cf-comparison').length,
        extraHeadingCount: rail.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        extraQualifierCopy: /(?:·\s*age|no trough|WD rate|margin)/i.test(rail.textContent || ''),
        deltaPillCount: rail.querySelectorAll('[class*="pill"], [data-computed-delta]').length
      } : null,
      probability: /Probability of success/i.test(summary?.textContent || ''),
      removedCopy: /All figures in today's dollars|One historical sequence, not a probability/i.test(root?.textContent || ''),
      statusGlyph: document.querySelector('#cashflow-path-status')?.textContent.trim() || '',
      statusClass: document.querySelector('#cashflow-path-status')?.className || '',
      statusColor: status ? getComputedStyle(status).color : '',
      expectedStatusColor,
      visibleShortfall: /Short\s+\$/i.test(root?.textContent || '') || !!root?.querySelector('.cf-row__shortfall'),
      rows,
      retirementRows,
      summary: summary ? {
        outcome: summary.dataset.outcome || ''
      } : null,
      persisted: JSON.parse(localStorage.getItem('parallax.cashFlowPath.v1') || '{}'),
      pathReplay: localStorage.getItem('parallax.pathReplay.v1')
    };
  });
  return {
    historicalPath
  };
}

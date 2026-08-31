export function verifyHistoricalPresentation({
  historicalPath,
  mode,
  expectedOutcome,
  observedHistoricalOutcomes,
  pathReplayBefore,
  startYear,
  periodName
}) {
  if (historicalPath.mode !== mode || historicalPath.rootMode !== mode || historicalPath.kind !== 'historical') throw new Error(`${mode} did not stay selected: ${JSON.stringify(historicalPath)}`);
  if (historicalPath.summary?.outcome !== expectedOutcome) throw new Error(`${mode} did not produce the required ${expectedOutcome} matrix: ${JSON.stringify(historicalPath.summary)}`);
  observedHistoricalOutcomes.add(historicalPath.summary.outcome);
  if (historicalPath.persisted?.id !== mode) throw new Error(`${mode} selection did not persist independently: ${JSON.stringify(historicalPath.persisted)}`);
  if (historicalPath.pathReplay !== pathReplayBefore) throw new Error(`${mode} mutated Monte Carlo pathReplay`);
  if (historicalPath.header?.label !== 'Tax' || historicalPath.header?.source !== 'federal-converged-row' || historicalPath.header?.scope !== 'MODELED_FEDERAL_LINE_24') throw new Error(`${mode} tax scope is not converged federal: ${JSON.stringify(historicalPath)}`);
  if (historicalPath.compare) throw new Error(`${mode} still shows an obsolete sidecar comparison`);
  if (historicalPath.disclosure) throw new Error(`${mode} should not show federal scope or status copy: ${JSON.stringify(historicalPath.disclosure)}`);
  if (historicalPath.probability || historicalPath.removedCopy || historicalPath.stats.length) throw new Error(`${mode} still shows removed summary content: ${JSON.stringify(historicalPath)}`);
  if (!historicalPath.retirementRows.length || historicalPath.retirementRows.some(row => row.sourceYear === null)) throw new Error(`${mode} contains post-depletion filler rows: ${JSON.stringify(historicalPath.retirementRows)}`);
  if (historicalPath.visibleShortfall) throw new Error(`${mode} visibly reports a dollar shortfall`);
  for (let index = 1; index < historicalPath.rows.length; index++) {
    if (historicalPath.rows[index].age !== historicalPath.rows[index - 1].age + 1 || historicalPath.rows[index].year !== historicalPath.rows[index - 1].year + 1) {
      throw new Error(`${mode} has a missing or duplicate age/year: ${JSON.stringify(historicalPath.rows)}`);
    }
  }
  const lastAccumulation = [...historicalPath.rows].reverse().find(row => row.phase === 'accum');
  const firstRetirement = historicalPath.retirementRows[0];
  if (lastAccumulation && Math.abs(lastAccumulation.endingBalance - firstRetirement.startBalance) > 0.01) throw new Error(`${mode} has a retirement balance jump: ${JSON.stringify({
    lastAccumulation,
    firstRetirement
  })}`);
  const shortfallRows = historicalPath.retirementRows.filter(row => row.shortfall > 0.01);
  const lastRetirement = historicalPath.retirementRows.at(-1);
  if (!['underfunded', 'survives'].includes(historicalPath.summary?.outcome)) {
    throw new Error(`${mode} has an unknown historical outcome: ${JSON.stringify(historicalPath.summary)}`);
  }
  const expectedMetricIds = ['max-real-drawdown', 'recovery-period', 'balance-at-age-80', 'funded-through-margin'];
  const expectedMetricLabels = ['Max Drawdown', 'Recovery period', 'Savings left at age 80', 'Money lasts through'];
  if (JSON.stringify(historicalPath.metrics.map(metric => metric.id)) !== JSON.stringify(expectedMetricIds) || JSON.stringify(historicalPath.reference.map(metric => metric.id)) !== JSON.stringify(expectedMetricIds) || JSON.stringify(historicalPath.metrics.map(metric => metric.label)) !== JSON.stringify(expectedMetricLabels) || JSON.stringify(historicalPath.reference.map(metric => metric.label)) !== JSON.stringify(expectedMetricLabels) || historicalPath.metrics.some(metric => /Median withdrawal|Ending portfolio|Early withdrawal|First underfunded/i.test(metric.label))) {
    throw new Error(`${mode} historical metric inventory drifted: ${JSON.stringify(historicalPath.metrics)}`);
  }
  const layout = historicalPath.railLayout;
  if (!layout || layout.gridDisplay !== 'grid' || !layout.gridTemplateColumns.endsWith(' 280px') || Math.abs(layout.railWidth - 280) > 0.01 || layout.railDisplay !== 'flex' || layout.railDirection !== 'column' || layout.railAlignItems !== 'center' || layout.railGap !== '16px' || layout.railPadding !== '20px 24px 24px' || layout.railBorderLeftWidth !== '1px' || layout.railBorderLeftStyle !== 'solid' || layout.railBackground !== 'rgba(0, 0, 0, 0)' || layout.railRadius !== '0px' || !(layout.baselineDelta <= 1) || layout.reference.display !== 'flex' || layout.reference.direction !== 'column' || layout.reference.alignItems !== 'center' || layout.reference.gap !== '6px' || layout.reference.padding !== '0px 0px 4px' || layout.reference.borderBottomWidth !== '0px' || layout.reference.borderBottomStyle !== 'none' || layout.reference.background !== 'rgba(0, 0, 0, 0)' || layout.reference.radius !== '0px' || layout.title.text !== 'Typical path' || layout.title.fontSize !== '12px' || layout.title.fontWeight !== '600' || layout.title.letterSpacing !== '0.48px' || layout.title.color !== layout.accentColor || layout.title.textShadow !== layout.title.expectedTextShadow || layout.title.textTransform !== 'none' || layout.title.marginBottom !== '2px' || layout.referenceLabel.fontSize !== '13px' || layout.referenceLabel.color !== layout.bodyColor || layout.referenceValue.fontSize !== '15px' || layout.referenceValue.color !== layout.bodyColor || layout.referenceValue.whiteSpace !== 'nowrap' || layout.selected.count !== 1 || layout.selected.display !== 'flex' || layout.selected.direction !== 'column' || layout.selected.alignItems !== 'center' || layout.selected.gap !== '16px' || layout.selected.padding !== '14px 12px' || layout.selected.radius !== '10px' || layout.selected.backgroundColor !== 'rgba(0, 0, 0, 0)' || layout.selected.backgroundImage !== layout.selected.expectedBackgroundImage || layout.selected.boxShadow !== layout.selected.expectedBoxShadow || Math.abs(layout.reference.width - layout.selected.width) > 1 || layout.selectedPeriod.count !== 1 || layout.selectedPeriod.id !== mode || layout.selectedPeriod.text !== `${startYear} · ${periodName}` || layout.selectedPeriod.year !== String(startYear) || layout.selectedPeriod.name !== periodName || layout.selectedPeriod.childIndex !== 0 || layout.selectedPeriod.padding !== '0px 0px 12px' || layout.selectedPeriod.borderBottomWidth !== '1px' || layout.selectedPeriod.borderBottomStyle !== 'solid' || layout.selectedPeriod.background !== 'rgba(0, 0, 0, 0)' || layout.selectedPeriod.radius !== '0px' || layout.selectedPeriod.fontSize !== '13px' || layout.selectedPeriod.fontWeight !== '600' || layout.selectedPeriod.lineHeight !== '17.55px' || layout.selectedPeriod.letterSpacing !== '0.13px' || layout.selectedPeriod.textAlign !== 'center' || layout.selectedPeriod.fontVariantNumeric !== 'tabular-nums' || layout.selectedPeriod.yearColor !== layout.mutedColor || layout.selectedPeriod.nameColor !== layout.accentColor || layout.metric.display !== 'flex' || layout.metric.direction !== 'column' || layout.metric.alignItems !== 'center' || layout.metric.textAlign !== 'center' || layout.metric.gap !== '5px' || layout.metric.nameFontSize !== '12px' || layout.metric.nameColor !== layout.bodyColor || layout.metric.figureFontSize !== '24px' || layout.metric.figureFontWeight !== '300' || layout.metric.figureColor !== layout.inkColor || layout.metric.figureWhiteSpace !== 'nowrap' || layout.metric.deltaFontSize !== '12px' || layout.dividerMetrics.length !== 3 || layout.dividerMetrics.some(metric => metric.paddingTop !== '16px' || metric.borderTopWidth !== '1px' || metric.borderTopStyle !== 'solid') || layout.directChildBackgrounds.some(color => color !== 'rgba(0, 0, 0, 0)') || JSON.stringify(layout.directChildRadii) !== JSON.stringify(['0px', '10px']) || layout.figureColors.some(color => color === layout.accentColor) || layout.deltaColors.some(color => ![layout.negativeColor, layout.mutedColor].includes(color)) || layout.sentenceDeltaCopy || layout.oldSummaryCount !== 0 || layout.extraHeadingCount !== 0 || layout.extraQualifierCopy || layout.deltaPillCount !== 0) {
    throw new Error(`${mode} path-metrics rail visual contract drifted: ${JSON.stringify(layout)}`);
  }
  if (historicalPath.metrics.some(metric => metric.deltaTone === 'negative' ? metric.deltaColor !== layout.negativeColor : metric.deltaTone === 'muted' ? metric.deltaColor !== layout.mutedColor : true)) {
    throw new Error(`${mode} path-metrics delta tones drifted: ${JSON.stringify(historicalPath.metrics)}`);
  }
  return {
    shortfallRows,
    lastRetirement
  };
}

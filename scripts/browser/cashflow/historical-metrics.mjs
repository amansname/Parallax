export function verifyHistoricalMetrics({
  historicalPath,
  typicalRowsByPlanYear,
  mode
}) {
  const portfolioFacts = rows => {
    const retirement = rows.filter(row => row.phase === 'retirement' && row.sourceYear !== null);
    const startingBalance = retirement[0]?.startBalance;
    let peak = startingBalance;
    let maxDrawdown = 0;
    let troughAge = null;
    let underwater = 0;
    let underwaterMax = 0;
    let longestClosedUnderwater = 0;
    let dippedBelowStart = false;
    for (const row of retirement) {
      if (row.endingBalance > peak) peak = row.endingBalance;
      const drawdown = peak > 0 ? (peak - row.endingBalance) / peak * 100 : 0;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        troughAge = row.age;
      }
      if (row.endingBalance < startingBalance - 0.01) {
        dippedBelowStart = true;
        underwater += 1;
        underwaterMax = Math.max(underwaterMax, underwater);
      } else {
        longestClosedUnderwater = Math.max(longestClosedUnderwater, underwater);
        underwater = 0;
      }
    }
    const recoveryStatus = !dippedBelowStart ? 'no-dip' : underwater > 0 ? 'never' : 'recovered';
    const recoveryYears = recoveryStatus === 'no-dip' ? 0 : recoveryStatus === 'recovered' ? longestClosedUnderwater : null;
    const age80 = rows.filter(row => row.sourceYear !== null && row.age === 80);
    return {
      retirement,
      maxDrawdown,
      troughAge,
      yearsAboveSix: retirement.filter(row => row.wdRate > 6).length,
      underwaterMax,
      recoveryStatus,
      recoveryYears,
      age80Balance: age80.length === 1 ? age80[0].endingBalance : null
    };
  };
  const fundingFacts = (facts, planEndAge) => {
    const firstUnderfunded = facts.retirement.find(row => row.shortfall > 0.01) || null;
    if (firstUnderfunded) {
      const before = facts.retirement.slice(0, facts.retirement.indexOf(firstUnderfunded));
      const lastFunded = [...before].reverse().find(row => row.shortfall <= 0.01) || null;
      const fundedThroughAge = lastFunded?.age ?? firstUnderfunded.age - 1;
      return {
        fundedThroughAge,
        margin: fundedThroughAge - planEndAge,
        kind: 'years-short'
      };
    }
    const ending = facts.retirement.at(-1);
    return ending?.withdrawal > 0 ? {
      fundedThroughAge: ending.age,
      margin: ending.endingBalance / ending.withdrawal,
      kind: 'zero-return-runway'
    } : {
      fundedThroughAge: ending?.age ?? null,
      margin: null,
      kind: 'no-portfolio-draw'
    };
  };
  const close = (actual, expected) => Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 0.01;
  const sameOptional = (actual, expected) => actual === null && expected === null || close(actual, expected);
  const historicalFacts = portfolioFacts(historicalPath.rows);
  const typicalFacts = portfolioFacts(typicalRowsByPlanYear);
  const drawdownMetric = historicalPath.metrics[0];
  const recoveryMetric = historicalPath.metrics[1];
  const age80Metric = historicalPath.metrics[2];
  const fundingMetric = historicalPath.metrics[3];
  const historicalFunding = fundingFacts(historicalFacts, fundingMetric.planEndAge);
  const typicalFunding = fundingFacts(typicalFacts, fundingMetric.planEndAge);
  if (!close(drawdownMetric.thisPath, historicalFacts.maxDrawdown) || !close(drawdownMetric.typicalPath, typicalFacts.maxDrawdown) || !close(drawdownMetric.delta, typicalFacts.maxDrawdown - historicalFacts.maxDrawdown) || drawdownMetric.thisPathAge !== historicalFacts.troughAge || drawdownMetric.typicalPathAge !== typicalFacts.troughAge || recoveryMetric.thisPath !== historicalFacts.recoveryYears || recoveryMetric.typicalPath !== typicalFacts.recoveryYears || recoveryMetric.thisPathRecoveryStatus !== historicalFacts.recoveryStatus || recoveryMetric.typicalPathRecoveryStatus !== typicalFacts.recoveryStatus || !sameOptional(recoveryMetric.delta, Number.isFinite(historicalFacts.recoveryYears) && Number.isFinite(typicalFacts.recoveryYears) ? historicalFacts.recoveryYears - typicalFacts.recoveryYears : historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus === 'never' ? 0 : null) || !sameOptional(age80Metric.thisPath, historicalFacts.age80Balance) || !sameOptional(age80Metric.typicalPath, typicalFacts.age80Balance) || !sameOptional(age80Metric.delta, historicalFacts.age80Balance !== null && typicalFacts.age80Balance !== null ? historicalFacts.age80Balance - typicalFacts.age80Balance : null) || fundingMetric.thisPath !== historicalFunding.fundedThroughAge || fundingMetric.typicalPath !== typicalFunding.fundedThroughAge || !sameOptional(fundingMetric.thisPathMargin, historicalFunding.margin) || !sameOptional(fundingMetric.typicalPathMargin, typicalFunding.margin) || fundingMetric.thisPathMarginKind !== historicalFunding.kind || fundingMetric.typicalPathMarginKind !== typicalFunding.kind || fundingMetric.delta !== historicalFunding.fundedThroughAge - typicalFunding.fundedThroughAge || !sameOptional(fundingMetric.marginDelta, historicalFunding.margin !== null && typicalFunding.margin !== null ? historicalFunding.margin - typicalFunding.margin : null)) {
    throw new Error(`${mode} historical metrics do not reconcile to visible engine rows: ${JSON.stringify({
      historicalPath,
      historicalFacts,
      typicalFacts,
      historicalFunding,
      typicalFunding
    })}`);
  }
  const visibleMoney = (value, unavailable = 'Not modeled') => {
    if (!Number.isFinite(value)) return unavailable;
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000) {
      return '$' + (absolute / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    }
    if (absolute >= 1_000) {
      return '$' + Math.min(999, Math.round(absolute / 1_000)) + 'K';
    }
    return '$' + Math.round(absolute).toLocaleString('en-US');
  };
  const visibleYears = value => {
    const absolute = Math.abs(value);
    const amount = Number.isInteger(absolute) ? String(absolute) : absolute.toFixed(1);
    return amount + (absolute === 1 ? ' yr' : ' yrs');
  };
  const visibleSignedYears = value => value === 0 ? 'Same' : (value < 0 ? '\u2212' : '+') + visibleYears(value);
  const visibleRecovery = facts => facts.recoveryStatus === 'never' ? 'Never' : visibleYears(facts.recoveryYears);
  const displayedDrawdownDelta = Number((Number(typicalFacts.maxDrawdown.toFixed(1)) - Number(historicalFacts.maxDrawdown.toFixed(1))).toFixed(1));
  const balanceDelta = historicalFacts.age80Balance !== null && typicalFacts.age80Balance !== null ? historicalFacts.age80Balance - typicalFacts.age80Balance : null;
  const displayedBalanceDelta = Number.isFinite(balanceDelta) ? visibleMoney(Math.abs(balanceDelta)) : null;
  const recoveryDelta = Number.isFinite(historicalFacts.recoveryYears) && Number.isFinite(typicalFacts.recoveryYears) ? historicalFacts.recoveryYears - typicalFacts.recoveryYears : null;
  const fundingDelta = historicalFunding.fundedThroughAge - typicalFunding.fundedThroughAge;
  const expectedReferenceValues = ['\u2212' + Math.abs(typicalFacts.maxDrawdown).toFixed(1) + '%', visibleRecovery(typicalFacts), visibleMoney(typicalFacts.age80Balance, typicalFunding.kind === 'years-short' && typicalFunding.fundedThroughAge < 80 ? 'Underfunded before 80' : 'Not modeled'), 'Age ' + typicalFunding.fundedThroughAge];
  const expectedSelectedValues = ['\u2212' + Math.abs(historicalFacts.maxDrawdown).toFixed(1) + '%', visibleRecovery(historicalFacts), visibleMoney(historicalFacts.age80Balance, historicalFunding.kind === 'years-short' && historicalFunding.fundedThroughAge < 80 ? 'Underfunded before 80' : 'Not modeled'), 'Age ' + historicalFunding.fundedThroughAge];
  const expectedDeltas = [displayedDrawdownDelta === 0 ? 'Same' : (displayedDrawdownDelta < 0 ? '\u2212' : '+') + Math.abs(displayedDrawdownDelta).toFixed(1) + ' pts', historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus === 'never' ? 'Same' : historicalFacts.recoveryStatus === 'never' || typicalFacts.recoveryStatus === 'never' ? '' : visibleSignedYears(recoveryDelta), displayedBalanceDelta === null ? '' : displayedBalanceDelta === '$0' ? 'Same' : (balanceDelta < 0 ? '\u2212' : '+') + displayedBalanceDelta, visibleSignedYears(fundingDelta)];
  const expectedDeltaTones = [displayedDrawdownDelta < 0 ? 'negative' : 'muted', historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus !== 'never' ? 'negative' : recoveryDelta > 0 ? 'negative' : 'muted', balanceDelta < 0 ? 'negative' : 'muted', fundingDelta < 0 ? 'negative' : 'muted'];
  if (JSON.stringify(historicalPath.reference.map(metric => metric.value)) !== JSON.stringify(expectedReferenceValues) || JSON.stringify(historicalPath.metrics.map(metric => metric.figure)) !== JSON.stringify(expectedSelectedValues) || JSON.stringify(historicalPath.metrics.map(metric => metric.deltaText)) !== JSON.stringify(expectedDeltas) || JSON.stringify(historicalPath.metrics.map(metric => metric.deltaTone)) !== JSON.stringify(expectedDeltaTones)) {
    throw new Error(`${mode} visible path-metrics inventory does not reconcile to authoritative rows: ${JSON.stringify({
      actualReferenceValues: historicalPath.reference.map(metric => metric.value),
      expectedReferenceValues,
      actualSelectedValues: historicalPath.metrics.map(metric => metric.figure),
      expectedSelectedValues,
      actualDeltas: historicalPath.metrics.map(metric => metric.deltaText),
      expectedDeltas,
      actualDeltaTones: historicalPath.metrics.map(metric => metric.deltaTone),
      expectedDeltaTones
    })}`);
  }
}

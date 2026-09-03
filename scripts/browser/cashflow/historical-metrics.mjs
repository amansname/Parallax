export function verifyHistoricalMetrics({
  historicalPath,
  typicalRowsByPlanYear,
  mode
}) {
  const portfolioFacts = rows => {
    const retirement = rows.filter(row => row.phase === 'retirement' && row.sourceYear !== null);
    const firstUnderfunded = retirement.find(row => row.shortfall > 0.01) || null;
    const early = retirement.slice(0, 10);
    const lowestEarly = early.reduce((lowest, row) => (
      lowest === null || row.endingBalance < lowest.endingBalance ? row : lowest
    ), null);
    let returnIndex = 1;
    let recoveryStarted = false;
    let recoveryYears = 0;
    let recoveryStatus = null;
    let recoveryAge = null;
    for (const row of retirement) {
      returnIndex *= 1 + row.returnRate;
      if (returnIndex < 1 - 1e-12) {
        if (!recoveryStarted) {
          recoveryStarted = true;
          recoveryYears = 1;
        } else if (recoveryStatus !== 'recovered') {
          recoveryYears += 1;
        }
      } else if (recoveryStarted && recoveryStatus !== 'recovered') {
        recoveryStatus = 'recovered';
        recoveryAge = row.age;
      }
    }
    if (recoveryStatus !== 'recovered' && firstUnderfunded) {
      recoveryStatus = 'not-observed';
      recoveryYears = null;
      recoveryAge = null;
    } else if (!recoveryStarted) {
      recoveryStatus = 'no-dip';
      recoveryYears = 0;
    } else if (recoveryStatus !== 'recovered') {
      recoveryStatus = 'never';
      recoveryYears = null;
    }
    let recoveryLivingAge = null;
    if (Number.isFinite(recoveryAge)) {
      const recoveryRows = retirement.filter(row => row.age === recoveryAge);
      if (recoveryRows.length !== 1 || !Number.isFinite(recoveryRows[0].livingAge)) {
        throw new Error('Recovery row living age is unavailable');
      }
      recoveryLivingAge = recoveryRows[0].livingAge;
    }
    const age80 = rows.filter(row => row.sourceYear !== null && row.age === 80);
    return {
      retirement,
      lowestEarlyBalance: lowestEarly?.endingBalance ?? null,
      lowestEarlyAge: lowestEarly?.age ?? null,
      earlyWindowYears: early.length,
      yearsAboveFiveEarly: early.filter(row => row.effectiveWdRate > 5).length,
      recoveryStatus,
      recoveryYears,
      recoveryAge,
      recoveryLivingAge,
      age80Balance: age80.length === 1 ? age80[0].endingBalance : null
    };
  };
  const fundingFacts = (facts, planEndTimelineAge = null) => {
    const firstUnderfunded = facts.retirement.find(row => row.shortfall > 0.01) || null;
    if (firstUnderfunded) {
      const before = facts.retirement.slice(0, facts.retirement.indexOf(firstUnderfunded));
      const lastFunded = [...before].reverse().find(row => row.shortfall <= 0.01) || null;
      return {
        timelineFundedThroughAge: lastFunded?.age ?? firstUnderfunded.age - 1,
        margin: Number.isFinite(planEndTimelineAge)
          ? (lastFunded?.age ?? firstUnderfunded.age - 1) - planEndTimelineAge
          : null,
        kind: 'years-short'
      };
    }
    const ending = facts.retirement.at(-1);
    return ending?.withdrawal > 0 ? {
      timelineFundedThroughAge: ending.age,
      margin: ending.endingBalance / ending.withdrawal,
      kind: 'zero-return-runway'
    } : {
      timelineFundedThroughAge: ending?.age ?? null,
      margin: null,
      kind: 'no-portfolio-draw'
    };
  };
  const close = (actual, expected) => Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 0.01;
  const sameOptional = (actual, expected) => actual === null && expected === null || close(actual, expected);
  const historicalFacts = portfolioFacts(historicalPath.rows);
  const typicalFacts = portfolioFacts(typicalRowsByPlanYear);
  const lowMetric = historicalPath.metrics[0];
  const pressureMetric = historicalPath.metrics[1];
  const recoveryMetric = historicalPath.metrics[2];
  const age80Metric = historicalPath.metrics[3];
  const fundingMetric = historicalPath.metrics[4];
  const typicalFunding = fundingFacts(typicalFacts);
  const historicalFunding = fundingFacts(historicalFacts, typicalFunding.timelineFundedThroughAge);
  const displayAgeOffset = fundingMetric.planEndAge - typicalFunding.timelineFundedThroughAge;
  const displayAge = age => Number.isFinite(age) ? age + displayAgeOffset : null;
  const expectedRecoveryDelta = Number.isFinite(historicalFacts.recoveryYears) && Number.isFinite(typicalFacts.recoveryYears)
    ? historicalFacts.recoveryYears - typicalFacts.recoveryYears
    : historicalFacts.recoveryStatus === typicalFacts.recoveryStatus
        && ['never', 'not-observed'].includes(historicalFacts.recoveryStatus) ? 0 : null;
  const fundingAgesAgree = fundingMetric.thisPath === displayAge(historicalFunding.timelineFundedThroughAge)
    && fundingMetric.typicalPath === displayAge(typicalFunding.timelineFundedThroughAge);
  if (!sameOptional(lowMetric.thisPath, historicalFacts.lowestEarlyBalance) || !sameOptional(lowMetric.typicalPath, typicalFacts.lowestEarlyBalance) || !sameOptional(lowMetric.delta, historicalFacts.lowestEarlyBalance - typicalFacts.lowestEarlyBalance) || lowMetric.thisPathAge !== historicalFacts.lowestEarlyAge || lowMetric.typicalPathAge !== typicalFacts.lowestEarlyAge || pressureMetric.thisPath !== historicalFacts.yearsAboveFiveEarly || pressureMetric.typicalPath !== typicalFacts.yearsAboveFiveEarly || pressureMetric.thisPathWindowYears !== historicalFacts.earlyWindowYears || pressureMetric.typicalPathWindowYears !== typicalFacts.earlyWindowYears || pressureMetric.delta !== historicalFacts.yearsAboveFiveEarly - typicalFacts.yearsAboveFiveEarly || recoveryMetric.thisPath !== historicalFacts.recoveryYears || recoveryMetric.typicalPath !== typicalFacts.recoveryYears || recoveryMetric.thisPathRecoveryStatus !== historicalFacts.recoveryStatus || recoveryMetric.typicalPathRecoveryStatus !== typicalFacts.recoveryStatus || recoveryMetric.thisPathRecoveryAge !== historicalFacts.recoveryLivingAge || recoveryMetric.typicalPathRecoveryAge !== typicalFacts.recoveryLivingAge || !sameOptional(recoveryMetric.delta, expectedRecoveryDelta) || !sameOptional(age80Metric.thisPath, historicalFacts.age80Balance) || !sameOptional(age80Metric.typicalPath, typicalFacts.age80Balance) || !sameOptional(age80Metric.delta, historicalFacts.age80Balance !== null && typicalFacts.age80Balance !== null ? historicalFacts.age80Balance - typicalFacts.age80Balance : null) || !fundingAgesAgree || !sameOptional(fundingMetric.thisPathMargin, historicalFunding.margin) || !sameOptional(fundingMetric.typicalPathMargin, typicalFunding.margin) || fundingMetric.thisPathMarginKind !== historicalFunding.kind || fundingMetric.typicalPathMarginKind !== typicalFunding.kind || fundingMetric.delta !== fundingMetric.thisPath - fundingMetric.typicalPath || !sameOptional(fundingMetric.marginDelta, historicalFunding.margin !== null && typicalFunding.margin !== null ? historicalFunding.margin - typicalFunding.margin : null)) {
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
  const visibleRecovery = facts => facts.recoveryStatus === 'never'
    ? 'Never'
    : facts.recoveryStatus === 'not-observed'
      ? 'Not observed'
      : visibleYears(facts.recoveryYears) + (Number.isFinite(facts.recoveryLivingAge) ? ' · age ' + facts.recoveryLivingAge : '');
  const visiblePressure = facts => facts.yearsAboveFiveEarly + ' / ' + facts.earlyWindowYears;
  const lowDelta = historicalFacts.lowestEarlyBalance - typicalFacts.lowestEarlyBalance;
  const balanceDelta = historicalFacts.age80Balance !== null && typicalFacts.age80Balance !== null ? historicalFacts.age80Balance - typicalFacts.age80Balance : null;
  const displayedLowDelta = Number.isFinite(lowDelta) ? visibleMoney(Math.abs(lowDelta)) : null;
  const displayedBalanceDelta = Number.isFinite(balanceDelta) ? visibleMoney(Math.abs(balanceDelta)) : null;
  const recoveryDelta = Number.isFinite(historicalFacts.recoveryYears) && Number.isFinite(typicalFacts.recoveryYears) ? historicalFacts.recoveryYears - typicalFacts.recoveryYears : null;
  const pressureDelta = historicalFacts.yearsAboveFiveEarly - typicalFacts.yearsAboveFiveEarly;
  const fundingDelta = fundingMetric.thisPath - fundingMetric.typicalPath;
  const expectedReferenceValues = [visibleMoney(typicalFacts.lowestEarlyBalance), visiblePressure(typicalFacts), visibleRecovery(typicalFacts), visibleMoney(typicalFacts.age80Balance, typicalFunding.kind === 'years-short' && typicalFunding.timelineFundedThroughAge < 80 ? 'Underfunded before 80' : 'Not modeled'), 'Age ' + fundingMetric.typicalPath];
  const expectedSelectedValues = [visibleMoney(historicalFacts.lowestEarlyBalance), visiblePressure(historicalFacts), visibleRecovery(historicalFacts), visibleMoney(historicalFacts.age80Balance, historicalFunding.kind === 'years-short' && historicalFunding.timelineFundedThroughAge < 80 ? 'Underfunded before 80' : 'Not modeled'), 'Age ' + fundingMetric.thisPath];
  const recoveryNotObserved = historicalFacts.recoveryStatus === 'not-observed'
    || typicalFacts.recoveryStatus === 'not-observed';
  const expectedDeltas = [displayedLowDelta === '$0' ? 'Same' : (lowDelta < 0 ? '\u2212' : '+') + displayedLowDelta, visibleSignedYears(pressureDelta), recoveryNotObserved ? '' : historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus === 'never' ? 'Same' : historicalFacts.recoveryStatus === 'never' || typicalFacts.recoveryStatus === 'never' ? '' : visibleSignedYears(recoveryDelta), displayedBalanceDelta === null ? '' : displayedBalanceDelta === '$0' ? 'Same' : (balanceDelta < 0 ? '\u2212' : '+') + displayedBalanceDelta, visibleSignedYears(fundingDelta)];
  const expectedDeltaTones = [lowDelta < 0 ? 'negative' : 'muted', pressureDelta > 0 ? 'negative' : 'muted', recoveryNotObserved ? 'muted' : historicalFacts.recoveryStatus === 'never' && typicalFacts.recoveryStatus !== 'never' ? 'negative' : recoveryDelta > 0 ? 'negative' : 'muted', balanceDelta < 0 ? 'negative' : 'muted', fundingDelta < 0 ? 'negative' : 'muted'];
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

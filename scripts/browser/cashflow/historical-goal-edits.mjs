export async function verifyHistoricalGoalEdits({
  page,
  cashFlowSessionSnapshot,
  withdrawalPlannerFixtureHouseholdId,
  stableClick,
  setCashFlow,
  waitForCashFlowPath,
  pathReplayBefore
}) {
  const historicalBeforeGoalEdit = await page.evaluate(() => {
    const cashFlow = document.querySelector('#scn-view .cf');
    if (!cashFlow) return '';
    const stableHistorical = cashFlow.cloneNode(true);
    stableHistorical.querySelector('#scn-cf-path-controls')?.remove();
    return stableHistorical.outerHTML;
  });
  const sessionBeforeGoalEdit = await cashFlowSessionSnapshot(page, {
    bundleSentinel: 'cash-flow-goal-edit',
    rememberBundle: true
  });
  const stableSessionAnalysis = snapshot => ({
    seed: snapshot.seed,
    bundleCount: snapshot.bundleCount,
    bundleHorizon: snapshot.bundleHorizon,
    aggregateBytes: snapshot.aggregateBytes,
    probabilityRangeEnvelopeBytes: snapshot.probabilityRangeEnvelopeBytes,
    successRates: snapshot.successRates,
    trialCounts: snapshot.trialCounts,
    typicalIndices: snapshot.typicalIndices
  });
  if (!(sessionBeforeGoalEdit.bundleCount > 0) || sessionBeforeGoalEdit.trialCounts.some(count => count !== sessionBeforeGoalEdit.bundleCount)) {
    throw new Error(`Cash Flow session bundle is incomplete before the Goals edit: ${JSON.stringify(sessionBeforeGoalEdit)}`);
  }
  const householdGoalEditBefore = await page.evaluate(householdId => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    const goal = (db[householdId]?.goals || []).find(item => item?.system && item?.name === 'Essentials');
    return goal ? {
      id: goal.id,
      amount: goal.amount
    } : null;
  }, withdrawalPlannerFixtureHouseholdId);
  if (!householdGoalEditBefore?.id || !Number.isFinite(householdGoalEditBefore.amount)) {
    throw new Error(`same-household Goals edit target is unavailable: ${JSON.stringify(householdGoalEditBefore)}`);
  }
  await stableClick('.htab[data-page="household"]');
  await stableClick('.htab[data-sub-target="goals"]');
  await page.waitForFunction(goalId => [...document.querySelectorAll('[data-goal-chip]')].filter(chip => chip.dataset.goalChip === goalId).length === 1, {
    timeout: 8000
  }, householdGoalEditBefore.id);
  await stableClick(`[data-goal-chip="${householdGoalEditBefore.id}"]`);
  await page.waitForFunction(() => document.querySelectorAll('.gh-rail .gh-amount-input').length === 1 && document.querySelectorAll('.gh-rail [data-action="amount-plus"]').length === 1, {
    timeout: 8000
  });
  const householdGoalDisplayBefore = await page.$eval('.gh-rail .gh-amount-input', input => input.value);
  await stableClick('.gh-rail [data-action="amount-plus"]');
  await page.waitForFunction(({
    householdId,
    goalId,
    priorAmount,
    priorDisplay
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    const goal = (db[householdId]?.goals || []).find(item => item?.id === goalId);
    return goal?.amount !== priorAmount && document.querySelector('.gh-rail .gh-amount-input')?.value !== priorDisplay && /Saved automatically/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 8000
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    goalId: householdGoalEditBefore.id,
    priorAmount: householdGoalEditBefore.amount,
    priorDisplay: householdGoalDisplayBefore
  });
  await stableClick('button[data-page="scenarios"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="scenarios"]')?.classList.contains('on') && !document.querySelector('#run-btn')?.disabled && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  });
  await setCashFlow(page, true);
  await waitForCashFlowPath(page, {
    pathId: 'historical-1995',
    kind: 'historical',
    sourceYear: 1995,
    requireHistoricalSummary: true,
    timeout: 20000
  });
  const householdGoalEditSession = await cashFlowSessionSnapshot(page, {
    bundleSentinel: 'cash-flow-goal-edit'
  });
  if (householdGoalEditSession.seed !== sessionBeforeGoalEdit.seed || !householdGoalEditSession.sameBundleObject || householdGoalEditSession.bundleCount !== sessionBeforeGoalEdit.bundleCount || householdGoalEditSession.bundleHorizon !== sessionBeforeGoalEdit.bundleHorizon || householdGoalEditSession.aggregateBytes === sessionBeforeGoalEdit.aggregateBytes || householdGoalEditSession.probabilityRangeEnvelopeBytes === sessionBeforeGoalEdit.probabilityRangeEnvelopeBytes) {
    throw new Error(`same-household Goals edit did not reuse the session bundle while updating analysis: ${JSON.stringify({
      seedBefore: sessionBeforeGoalEdit.seed,
      seedAfter: householdGoalEditSession.seed,
      sameBundleObject: householdGoalEditSession.sameBundleObject,
      aggregateChanged: householdGoalEditSession.aggregateBytes !== sessionBeforeGoalEdit.aggregateBytes,
      probabilityRangeEnvelopeChanged: householdGoalEditSession.probabilityRangeEnvelopeBytes !== sessionBeforeGoalEdit.probabilityRangeEnvelopeBytes
    })}`);
  }
  await stableClick('.htab[data-page="household"]');
  await stableClick('.htab[data-sub-target="goals"]');
  await page.waitForFunction(goalId => [...document.querySelectorAll('[data-goal-chip]')].filter(chip => chip.dataset.goalChip === goalId).length === 1, {
    timeout: 8000
  }, householdGoalEditBefore.id);
  await stableClick(`[data-goal-chip="${householdGoalEditBefore.id}"]`);
  await page.waitForFunction(previousDisplay => document.querySelector('.gh-rail .gh-amount-input')?.value !== previousDisplay && document.querySelectorAll('.gh-rail [data-action="amount-minus"]').length === 1, {
    timeout: 8000
  }, householdGoalDisplayBefore);
  await stableClick('.gh-rail [data-action="amount-minus"]');
  await page.waitForFunction(({
    householdId,
    goalId,
    amount,
    display
  }) => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
    const goal = (db[householdId]?.goals || []).find(item => item?.id === goalId);
    return goal?.amount === amount && document.querySelector('.gh-rail .gh-amount-input')?.value === display && /Saved automatically/i.test(document.querySelector('#status')?.textContent || '');
  }, {
    timeout: 8000
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    goalId: householdGoalEditBefore.id,
    amount: householdGoalEditBefore.amount,
    display: householdGoalDisplayBefore
  });
  await stableClick('button[data-page="scenarios"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="scenarios"]')?.classList.contains('on') && !document.querySelector('#run-btn')?.disabled && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  });
  await setCashFlow(page, true);
  await waitForCashFlowPath(page, {
    pathId: 'historical-1995',
    kind: 'historical',
    sourceYear: 1995,
    requireHistoricalSummary: true,
    timeout: 20000
  });
  const restoredGoalSession = await cashFlowSessionSnapshot(page, {
    bundleSentinel: 'cash-flow-goal-edit'
  });
  if (!restoredGoalSession.sameBundleObject || JSON.stringify(stableSessionAnalysis(restoredGoalSession)) !== JSON.stringify(stableSessionAnalysis(sessionBeforeGoalEdit))) {
    throw new Error(`reversing the same-household Goals edit did not exactly restore probability/range/envelope analysis: ${JSON.stringify({
      sameBundleObject: restoredGoalSession.sameBundleObject,
      successRatesBefore: sessionBeforeGoalEdit.successRates,
      successRatesAfter: restoredGoalSession.successRates,
      probabilityRangeEnvelopeRestored: restoredGoalSession.probabilityRangeEnvelopeBytes === sessionBeforeGoalEdit.probabilityRangeEnvelopeBytes,
      aggregateRestored: restoredGoalSession.aggregateBytes === sessionBeforeGoalEdit.aggregateBytes
    })}`);
  }
  const historicalAfterGoalEdit = await page.evaluate(() => {
    const cashFlow = document.querySelector('#scn-view .cf');
    if (!cashFlow) return '';
    const stableHistorical = cashFlow.cloneNode(true);
    stableHistorical.querySelector('#scn-cf-path-controls')?.remove();
    return stableHistorical.outerHTML;
  });
  if (historicalAfterGoalEdit !== historicalBeforeGoalEdit) {
    throw new Error('reversing the same-household Goals edit did not restore Historical Cash Flow bytes');
  }
  if ((await page.evaluate(() => localStorage.getItem('parallax.pathReplay.v1'))) !== pathReplayBefore) {
    throw new Error('same-household Goals edit changed Monte Carlo replay persistence');
  }
}
